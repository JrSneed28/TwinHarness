/**
 * `th repo map` — scan the governed project and write the dual artifacts
 * `.twinharness/repo-map.json` (machine, IF-004) + `docs/00-repo-map.md`
 * (human, IF-005), or, with `--no-write`, build the map in memory only.
 *
 * This handler follows Critical Pattern 1 EXACTLY (REQ-NFR-003):
 *  - named `runRepoMap`, `paths` first, typed opts second defaulting `{}`;
 *  - returns `success()`/`failure()` — NEVER throws, NEVER `process.exit`;
 *  - calls `structuredLog()` exactly once before return.
 *
 * Trust boundary (REQ-RU-040, RULE-004): the scan records discovered commands as
 * inert strings and never executes anything — there is no `child_process` import
 * anywhere in this layer.
 *
 * Determinism (REQ-NFR-001): the serializer is the single normalization point; a
 * second write-mode run on an unchanged repo is byte-identical.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { resolveWithinRoot } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { structuredLog } from "../core/log";
import { requireState } from "../core/guards";
import { scanRepo, type ScanOptions } from "../core/repo-map/scanner";
import { serializeRepoMap, renderRepoMapMarkdown, parseRepoMap, type RepoMap } from "../core/repo-map/schema";
import { hashFileBytes } from "../core/hash";
import { atomicWriteFile } from "../core/atomic-io";
import { computeRelevance, computeImpact, type Selector, type ImpactSelector } from "../core/repo-map/query";
import { computeFreshness, diffHashes } from "../core/repo-map/freshness";
import { REPO_STALE_EXIT, REPO_NO_MAP_EXIT } from "../core/repo-map/freshness-codes";
import { cachedFreshness } from "../core/repo-map/freshness-cache";

/** `--format` text-rendering values (distinct from the global `--json` envelope). */
const FORMATS = ["summary", "json", "md"] as const;
export type RepoMapFormat = (typeof FORMATS)[number];

export interface RepoMapOptions {
  /**
   * Write the two artifacts (default true — D-CONTRACTS-001: bare `th repo map`
   * WRITES). `false` = dry/preview mode (REQ-RU-017 / MCP `write:false`).
   */
  write?: boolean;
  /** Text rendering: summary (default) | json | md. */
  format?: string;
  /**
   * Optional scan caps passthrough (file-count / total-bytes). Defaults to the
   * scanner's bounded-cost envelope (REQ-NFR-007); lowering a cap forces a partial
   * scan, which the summary view then flags with a prominent banner (P0-2).
   */
  scanOptions?: ScanOptions;
}

/** Relative artifact paths (POSIX) reported in `data.artifacts`. */
const REPO_MAP_JSON_REL = ".twinharness/repo-map.json";
const REPO_MAP_MD_REL = "docs/00-repo-map.md";

/** Atomic write: delegates to the shared atomic-io helper (C-2 / S-C). */
function atomicWrite(absFile: string, content: string): void {
  atomicWriteFile(absFile, content);
}

/**
 * `th repo map [--write|--no-write] [--format <summary|json|md>]` — scan, build
 * the deterministic map, and (in write mode) persist the two artifacts.
 *
 * Anchor: REQ-RU-001 — the `th repo map` command, canonical runRepoMap(paths, opts): CommandResult shape.
 * Anchor: REQ-NFR-002 — zero new runtime deps; this module imports only node builtins + core (no MCP SDK).
 * Anchor: REQ-NFR-005 — dist-sync: this compiled output is committed; `npm run verify` enforces it.
 */
export function runRepoMap(paths: ProjectPaths, opts: RepoMapOptions = {}): CommandResult {
  const write = opts.write !== false; // default: write (D-CONTRACTS-001).
  const format: RepoMapFormat = (opts.format ?? "summary") as RepoMapFormat;

  // Validate --format up front (ERR-008 / REQ-RU-016).
  if (!(FORMATS as readonly string[]).includes(format)) {
    structuredLog({ cmd: "repo map", error: "bad_format", format: opts.format });
    return failure({
      human: `invalid --format "${opts.format}". Expected one of: ${FORMATS.join(", ")}.`,
      data: { error: "bad_format", format: opts.format },
    });
  }

  // Scan (best-effort; never throws on repo content — REQ-RU-090).
  const map: RepoMap = scanRepo(paths.root, opts.scanOptions ?? {});

  // DS-002 / P2-4 — Populate fileHashes: content-hash every tracked file within
  // scope from its RAW bytes (`hashFileBytes`). Read-only; NEVER execute scanned
  // content (REQ-NFR-003). Unreadable files are silently skipped (best-effort;
  // REQ-RU-090).
  //
  // P2-4 (#6): we hash the raw Buffer (no utf8 decode, no CRLF normalize) so two
  // DISTINCT binaries cannot collapse to the same digest via U+FFFD/CRLF lossiness
  // (which would silently miss a real edit). This is the all-or-nothing pair with
  // `runRepoCheck` — BOTH paths use `hashFileBytes`, so a text file's stored hash
  // and re-check hash still agree byte-for-byte.
  // Anchor: REQ-202 — per-file hashes enable modified-file detection.
  // Anchor: REQ-NFR-002 — deterministic: byte-exact SHA-256 via hashFileBytes.
  // Anchor: REQ-NFR-003 — read-only; no subprocess; no require/eval.
  // Anchor: REQ-NFR-004 — field populated here; absent on old maps (backward-compat preserved by serializer).
  {
    const hashes: Record<string, string> = {};
    for (const f of map.files) {
      const abs = path.join(paths.root, f.path);
      try {
        hashes[f.path] = hashFileBytes(abs);
      } catch {
        // Unreadable file — skip silently (REQ-RU-090, REQ-NFR-003).
      }
    }
    if (Object.keys(hashes).length > 0) {
      map.fileHashes = hashes;
    }
  }

  const json = serializeRepoMap(map);
  const md = renderRepoMapMarkdown(map);

  // Compact summary (NEVER the full map — REQ-NFR-004).
  const counts = {
    languages: map.languages.length,
    packageManagers: map.package_managers.length,
    sourceRoots: map.source_roots.length,
    testRoots: map.test_roots.length,
    docsRoots: map.docs_roots.length,
    components: map.components.length,
    entrypoints: map.entrypoints.length,
    files: map.files.length,
    reqAnchors: map.req_anchors.length,
    candidateCommands: map.candidate_commands.length,
    generatedPaths: map.generated_paths.length,
    blastRadiusSignals: map.blast_radius_signals.length,
  };
  const blastRadiusFlags = [...new Set(map.blast_radius_signals.map((s) => s.flag))].sort();

  let artifacts: string[] = [];
  if (write) {
    const jsonAbs = path.join(paths.stateDir, "repo-map.json");
    const mdAbs = path.join(paths.docsDir, "00-repo-map.md");
    try {
      atomicWrite(jsonAbs, json);
    } catch {
      structuredLog({ cmd: "repo map", error: "write_failed", file: REPO_MAP_JSON_REL });
      return failure({ human: `failed to write ${REPO_MAP_JSON_REL}`, data: { error: "write_failed", file: REPO_MAP_JSON_REL } });
    }
    try {
      atomicWrite(mdAbs, md);
    } catch {
      structuredLog({ cmd: "repo map", error: "write_failed", file: REPO_MAP_MD_REL });
      return failure({ human: `failed to write ${REPO_MAP_MD_REL}`, data: { error: "write_failed", file: REPO_MAP_MD_REL } });
    }
    artifacts = [REPO_MAP_JSON_REL, REPO_MAP_MD_REL];
  }

  const data = {
    schemaVersion: map.schema_version,
    wrote: write,
    artifacts,
    counts,
    blastRadiusFlags,
    scanReport: map.scanReport,
  };

  // Text rendering per --format. All views are compact by default (REQ-NFR-004);
  // `md` yields the markdown body; `json` yields the structured data as text.
  let human: string;
  if (format === "md") {
    human = md;
  } else if (format === "json") {
    human = JSON.stringify(data, null, 2);
  } else {
    // P0-2 — surface a PARTIAL scan prominently at scan time, not as a buried
    // status line. A cap hit means the map is INCOMPLETE; every downstream
    // consumer (relevance/impact/context pack) inherits that incompleteness, so
    // the operator must see it the moment the map is produced.
    const partial = map.scanReport.capHit !== null;
    const banner = partial
      ? `⚠ PARTIAL SCAN — cap hit: ${map.scanReport.capHit}. The repo map is INCOMPLETE (scanned ${map.scanReport.filesScanned} file(s)); relevance/impact/context results will be partial. Raise the scan caps and re-run \`th repo map\`.`
      : null;
    // P3-6 — surface a likely-missed layout so a structure miss is never silent.
    const lowConfWarn = map.scanReport.lowConfidenceStructure
      ? `⚠ LOW-CONFIDENCE STRUCTURE — ${map.scanReport.filesScanned} file(s) scanned but no source roots/components were derived. The layout may be unconventional; check \`th repo map --format json\` and consider configuring source roots.`
      : null;
    // P3-5 — summarize exclusion reasons (why dirs were pruned).
    const exclusions = map.scanReport.exclusions ?? [];
    const exclusionLine =
      exclusions.length > 0
        ? `  excluded: ${[...new Set(exclusions.map((e) => e.reason))]
            .sort()
            .map((reason) => `${reason} (${exclusions.filter((e) => e.reason === reason).length})`)
            .join(", ")}`
        : null;
    const capLine = partial
      ? `cap hit: ${map.scanReport.capHit} (scanned ${map.scanReport.filesScanned})`
      : `scanned ${map.scanReport.filesScanned} file(s), skipped ${map.scanReport.filesSkipped}`;
    human = [
      ...(banner ? [banner, ""] : []),
      ...(lowConfWarn ? [lowConfWarn, ""] : []),
      "Repo map:",
      `  languages: ${counts.languages}  package managers: ${counts.packageManagers}`,
      `  roots — source: ${counts.sourceRoots}  test: ${counts.testRoots}  docs: ${counts.docsRoots}`,
      `  components: ${counts.components}  entrypoints: ${counts.entrypoints}  files: ${counts.files}`,
      `  REQ anchors: ${counts.reqAnchors}  candidate commands: ${counts.candidateCommands}  generated dirs: ${counts.generatedPaths}`,
      `  blast-radius flags: ${blastRadiusFlags.length ? blastRadiusFlags.join(", ") : "(none)"}`,
      ...(exclusionLine ? [exclusionLine] : []),
      `  ${capLine}`,
      write ? `wrote ${artifacts.length} artifact(s): ${artifacts.join(", ")}` : "(dry-run — nothing written)",
    ].join("\n");
  }

  structuredLog({
    cmd: "repo map",
    wrote: write,
    files: counts.files,
    capHit: map.scanReport.capHit,
    blastRadiusFlags: blastRadiusFlags.length,
  });

  return success({ data, human });
}

// ---------------------------------------------------------------------------
// `th repo relevant` (IF-002 / REQ-RU-020..027 / REQ-RU-042 / REQ-RU-043)
// ---------------------------------------------------------------------------

/** Persisted repo-map path (relative to stateDir). */
const REPO_MAP_REL = "repo-map.json";

type LoadPersistedMapResult =
  | { map: RepoMap; result?: undefined }
  | { map?: undefined; result: CommandResult };

/**
 * Load + parse the persisted `<stateDir>/repo-map.json` (CQ-007 dedup — the same
 * read/parse/error ladder previously inlined in `runRepoRelevant` and
 * `runRepoImpact`). A missing file maps to `map_missing`; a present-but-invalid
 * file carries the parser's tagged error code. On failure it logs
 * `structuredLog({ cmd, error })` and returns the canonical `failure()`; on
 * success it returns the parsed map. Behavior (error codes, human wording, the
 * single structured-log line, the `failure()` payload) is identical to the prior
 * inline code — `cmd` is threaded through so each caller's log keeps its label.
 */
function loadPersistedMap(paths: ProjectPaths, cmd: string): LoadPersistedMapResult {
  const mapJsonPath = path.join(paths.stateDir, REPO_MAP_REL);
  let rawMap: string | null = null;
  try {
    rawMap = fs.readFileSync(mapJsonPath, "utf8");
  } catch {
    // Missing file → map_missing.
    rawMap = null;
  }
  const parsed = parseRepoMap(rawMap);
  if (!parsed.ok || !parsed.map) {
    const errorCode = rawMap === null ? "map_missing" : (parsed.error ?? "map_missing");
    const human =
      errorCode === "map_missing"
        ? "No repo-map.json found. Run `th repo map` first."
        : `repo-map.json is invalid: ${errorCode}. Run \`th repo map\` to regenerate.`;
    structuredLog({ cmd, error: errorCode });
    return { result: failure({ human, data: { error: errorCode } }) };
  }
  return { map: parsed.map };
}

/** Valid `--format` values for `th repo relevant`. */
const RELEVANT_FORMATS = ["slice", "req", "file", "json"] as const;

export interface RepoRelevantOptions {
  /** Selector: exactly one of slice / req / file / query. */
  slice?: string;
  req?: string;
  file?: string;
  query?: string;
  /** Cap on combined emitted items (default 20; ≤0 → default). REQ-RU-023. */
  maxResults?: number;
  /** Text rendering format. */
  format?: string;
}

/**
 * `th repo relevant` — read the persisted map, run `computeRelevance`, return
 * a compact `RelevanceResult`. Follows Critical Pattern 1 EXACTLY (REQ-NFR-003):
 * - named `runRepoRelevant`, `paths` first, typed opts second defaulting `{}`;
 * - returns `success()`/`failure()` — NEVER throws, NEVER `process.exit`;
 * - calls `structuredLog()` exactly once before return.
 *
 * Handler order (RULE-005/006):
 *   1. path-escape guard FIRST (before ANY read) — REQ-RU-024/042
 *   2. load + parse persisted map (missing/malformed → clean failure) — REQ-RU-025/043
 *   3. selector validation (exactly one) — REQ-RU-020
 *   4. for --slice, read state.slices READ-ONLY — REQ-RU-027
 *   5. computeRelevance — REQ-RU-021/022/023
 *   6. shape result, structuredLog once, return — Critical Pattern 1
 *
 * Read-only with respect to state.json and repo-map.json — no withStateLock,
 * no write (REQ-RU-026).
 *
 * Anchor: REQ-RU-020
 * Anchor: REQ-RU-024
 * Anchor: REQ-RU-025
 * Anchor: REQ-RU-026
 * Anchor: REQ-RU-027
 * Anchor: REQ-RU-042
 * Anchor: REQ-RU-043
 * Anchor: REQ-RU-092
 * Anchor: REQ-RU-093
 */
export function runRepoRelevant(paths: ProjectPaths, opts: RepoRelevantOptions = {}): CommandResult {
  // ---- Step 1: path-escape guard FIRST (REQ-RU-024/042) ----
  // Guard runs before ANY filesystem read. If --file escapes root, return
  // immediately with no further I/O.
  if (opts.file !== undefined) {
    const resolved = resolveWithinRoot(paths.root, opts.file);
    if (resolved === null) {
      structuredLog({ cmd: "repo relevant", error: "path_outside_root", file: opts.file });
      return failure({
        human: `--file "${opts.file}" is outside the project root.`,
        data: { error: "path_outside_root", file: opts.file },
      });
    }
  }

  // ---- Step 2: load + parse persisted map (REQ-RU-025 / REQ-RU-043) ----
  const loaded = loadPersistedMap(paths, "repo relevant");
  if (loaded.result) return loaded.result;
  const map = loaded.map;

  // ---- Step 3: selector validation — exactly one required (REQ-RU-020) ----
  const selectors: Array<{ kind: "slice" | "req" | "file" | "query"; value: string }> = [];
  if (opts.slice !== undefined) selectors.push({ kind: "slice", value: opts.slice });
  if (opts.req !== undefined) selectors.push({ kind: "req", value: opts.req });
  if (opts.file !== undefined) selectors.push({ kind: "file", value: opts.file });
  if (opts.query !== undefined) selectors.push({ kind: "query", value: opts.query });

  if (selectors.length === 0) {
    structuredLog({ cmd: "repo relevant", error: "no_selector" });
    return failure({
      human: "Provide exactly one selector: --slice, --req, --file, or --query.\n\nRun `th help` for usage.",
      data: { error: "no_selector" },
    });
  }
  if (selectors.length > 1) {
    const given = selectors.map((s) => `--${s.kind}`);
    structuredLog({ cmd: "repo relevant", error: "multiple_selectors", given });
    return failure({
      human: `Only one selector is allowed. Got: ${given.join(", ")}.`,
      data: { error: "multiple_selectors", given },
    });
  }

  const selectorEntry = selectors[0]!;

  // ---- Step 4: for --slice, resolve components from state READ-ONLY (REQ-RU-027) ----
  // No withStateLock, no write — pure read of state.slices.
  const selector: Selector = {
    kind: selectorEntry.kind,
    value: selectorEntry.value,
  };

  if (selectorEntry.kind === "slice") {
    const stateResult = requireState(paths);
    if (stateResult.result) {
      // State missing or invalid — can't resolve slice components.
      structuredLog({ cmd: "repo relevant", error: "not_initialized" });
      return stateResult.result;
    }
    const state = stateResult.state!;
    const sliceEntry = state.slices.find((s) => s.id === selectorEntry.value);
    if (!sliceEntry) {
      const known = state.slices.map((s) => s.id);
      structuredLog({ cmd: "repo relevant", error: "unknown_slice", slice: selectorEntry.value });
      return failure({
        human: `Unknown slice: ${selectorEntry.value}. Known: ${known.join(", ") || "(none)"}`,
        data: { error: "unknown_slice", slice: selectorEntry.value, known },
      });
    }
    selector.sliceComponents = sliceEntry.components;
  }

  // ---- Step 5: computeRelevance (pure scorer, zero FS access) ----
  const result = computeRelevance(map, selector, { maxResults: opts.maxResults });

  // ---- Step 6: shape result, structuredLog once, return ----
  const data: Record<string, unknown> = { ...result };

  const human = formatRelevanceHuman(result, opts.format);

  structuredLog({
    cmd: "repo relevant",
    selectorKind: result.selectorKind,
    selectorValue: result.selectorValue,
    readFirst: result.readFirst.length,
    related: result.related.length,
    tests: result.tests.length,
    truncated: result.truncated,
  });

  return success({ data, human });
}

/**
 * Format the RelevanceResult for human output (compact, no score in text).
 * IF-010: score appears ONLY in structured data, never in human text.
 * REQ-NFR-004: compact by default.
 */
function formatRelevanceHuman(
  result: import("../core/repo-map/query").RelevanceResult,
  format?: string,
): string {
  // `json` format: the structured payload as text.
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const lines: string[] = [];
  lines.push(`Relevant context for ${result.selectorKind}: ${result.selectorValue}`);

  if (result.readFirst.length > 0) {
    lines.push("\nRead first:");
    for (const item of result.readFirst) {
      // REQ-RU-022: WHY on every item; score NOT in human text (IF-010).
      lines.push(`  ${item.path}  [${item.why}]`);
    }
  }

  if (result.related.length > 0) {
    lines.push("\nRelated:");
    for (const item of result.related) {
      lines.push(`  ${item.path}  [${item.why}]`);
    }
  }

  if (result.tests.length > 0) {
    lines.push("\nLikely tests:");
    for (const item of result.tests) {
      lines.push(`  ${item.path}  [${item.why}]`);
    }
  }

  if (result.owningComponents.length > 0) {
    lines.push(`\nOwning components: ${result.owningComponents.join(", ")}`);
  }

  if (result.doNotTouch.length > 0) {
    lines.push(`\nDo not touch (generated): ${result.doNotTouch.join(", ")}`);
  }

  if (result.risks.length > 0) {
    lines.push("\nRisks:");
    for (const sig of result.risks) {
      lines.push(`  ${sig.flag}: ${sig.matchingPaths.length} match(es)`);
    }
  }

  if (result.verifyCandidates.length > 0) {
    lines.push("\nVerify candidates (suggestions only — never executed):");
    for (const cmd of result.verifyCandidates) {
      lines.push(`  [${cmd.kind}] ${cmd.label}: ${cmd.raw}`);
    }
  }

  if (result.truncated) {
    lines.push("\n(Results truncated by maxResults — use --maxResults to see more.)");
  }

  if (
    result.readFirst.length === 0 &&
    result.related.length === 0 &&
    result.tests.length === 0
  ) {
    lines.push("\n(No matching files found — selector matches nothing. This is not an error.)");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// `th repo impact` (IF-003 / REQ-RU-030..034 / REQ-RU-042 / REQ-RU-092)
// ---------------------------------------------------------------------------

/** Valid `--format` values for `th repo impact`. */
const IMPACT_FORMATS = ["file", "json"] as const;

export interface RepoImpactOptions {
  /** Selector: exactly one of file / component. */
  file?: string;
  component?: string;
  /** Text rendering format. */
  format?: string;
}

/**
 * `th repo impact` — read the persisted map, run `computeImpact`, return an
 * `ImpactResult`. Follows Critical Pattern 1 EXACTLY (REQ-NFR-003):
 * - named `runRepoImpact`, `paths` first, typed opts second defaulting `{}`;
 * - returns `success()`/`failure()` — NEVER throws, NEVER `process.exit`;
 * - calls `structuredLog()` exactly once before return.
 *
 * Handler order (RULE-005/006):
 *   1. path-escape guard FIRST (before ANY read) — REQ-RU-032/042
 *   2. load + parse persisted map (missing/malformed → clean failure) — REQ-RU-034
 *   3. selector validation (exactly one of --file/--component) — REQ-RU-030
 *   4. computeImpact — REQ-RU-031/022
 *   5. shape result, structuredLog once, return — Critical Pattern 1
 *
 * Read-only with respect to state.json — th repo impact reads NO state at all
 * (REQ-RU-033). Simpler than runRepoRelevant: no requireState call.
 *
 * Anchor: REQ-RU-030
 * Anchor: REQ-RU-031
 * Anchor: REQ-RU-032
 * Anchor: REQ-RU-033
 * Anchor: REQ-RU-034
 * Anchor: REQ-RU-042
 * Anchor: REQ-RU-092
 */
export function runRepoImpact(paths: ProjectPaths, opts: RepoImpactOptions = {}): CommandResult {
  // ---- Step 1: path-escape guard FIRST (REQ-RU-032/042) ----
  // Guard runs before ANY filesystem read. If --file escapes root, return
  // immediately with no further I/O.
  if (opts.file !== undefined) {
    const resolved = resolveWithinRoot(paths.root, opts.file);
    if (resolved === null) {
      structuredLog({ cmd: "repo impact", error: "path_outside_root", file: opts.file });
      return failure({
        human: `--file "${opts.file}" is outside the project root.`,
        data: { error: "path_outside_root", file: opts.file },
      });
    }
  }

  // Guard also applies to --component when it looks like a path (contains a slash).
  if (opts.component !== undefined && (opts.component.includes("/") || opts.component.includes("\\"))) {
    const resolved = resolveWithinRoot(paths.root, opts.component);
    if (resolved === null) {
      structuredLog({ cmd: "repo impact", error: "path_outside_root", component: opts.component });
      return failure({
        human: `--component "${opts.component}" is outside the project root.`,
        data: { error: "path_outside_root", component: opts.component },
      });
    }
  }

  // ---- Step 2: load + parse persisted map (REQ-RU-034) ----
  const loaded = loadPersistedMap(paths, "repo impact");
  if (loaded.result) return loaded.result;
  const map = loaded.map;

  // ---- Step 3: selector validation — exactly one required (REQ-RU-030) ----
  const selectors: Array<{ kind: "file" | "component"; value: string }> = [];
  if (opts.file !== undefined) selectors.push({ kind: "file", value: opts.file });
  if (opts.component !== undefined) selectors.push({ kind: "component", value: opts.component });

  if (selectors.length === 0) {
    structuredLog({ cmd: "repo impact", error: "no_selector" });
    return failure({
      human: "Provide exactly one selector: --file or --component.\n\nRun `th help` for usage.",
      data: { error: "no_selector" },
    });
  }
  if (selectors.length > 1) {
    const given = selectors.map((s) => `--${s.kind}`);
    structuredLog({ cmd: "repo impact", error: "multiple_selectors", given });
    return failure({
      human: `Only one selector is allowed. Got: ${given.join(", ")}.`,
      data: { error: "multiple_selectors", given },
    });
  }

  const selectorEntry = selectors[0]!;
  const selector: ImpactSelector = {
    kind: selectorEntry.kind,
    value: selectorEntry.value,
  };

  // ---- Step 4: computeImpact (pure scorer, zero FS access) ----
  const result = computeImpact(map, selector);

  // ---- Step 5: shape result, structuredLog once, return ----
  const data: Record<string, unknown> = { ...result };

  const human = formatImpactHuman(result, opts.format);

  structuredLog({
    cmd: "repo impact",
    selectorKind: result.selectorKind,
    selectorValue: result.selectorValue,
    impactedComponents: result.impactedComponents.length,
    relatedTests: result.relatedTests.length,
    riskFlags: result.riskFlags.length,
  });

  return success({ data, human });
}

/**
 * Format the ImpactResult for human output (compact).
 */
function formatImpactHuman(
  result: import("../core/repo-map/query").ImpactResult,
  format?: string,
): string {
  // `json` format: the structured payload as text.
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const lines: string[] = [];
  lines.push(`Impact analysis for ${result.selectorKind}: ${result.selectorValue}`);

  if (result.impactedComponents.length > 0) {
    lines.push("\nImpacted components:");
    for (const item of result.impactedComponents) {
      // REQ-RU-022: WHY on every item.
      lines.push(`  ${item.name}  [${item.why}]`);
    }
  }

  if (result.relatedTests.length > 0) {
    lines.push("\nRelated tests:");
    for (const item of result.relatedTests) {
      lines.push(`  ${item.name}  [${item.why}]`);
    }
  }

  if (result.downstreamFeatures.length > 0) {
    lines.push("\nDownstream features:");
    for (const item of result.downstreamFeatures) {
      lines.push(`  ${item.name}  [${item.why}]`);
    }
  }

  if (result.reqAnchors.length > 0) {
    lines.push(`\nREQ anchors in scope: ${result.reqAnchors.join(", ")}`);
  }

  if (result.artifactStageImplications.length > 0) {
    lines.push("\nArtifact/stage implications:");
    for (const impl of result.artifactStageImplications) {
      lines.push(`  - ${impl}`);
    }
  }

  if (result.riskFlags.length > 0) {
    lines.push("\nRisk flags (blast radius):");
    for (const sig of result.riskFlags) {
      lines.push(`  ${sig.flag}: ${sig.matchingPaths.length} match(es)`);
    }
  }

  if (result.verifyCandidates.length > 0) {
    lines.push("\nVerify candidates (suggestions only — never executed):");
    for (const cmd of result.verifyCandidates) {
      lines.push(`  [${cmd.kind}] ${cmd.label}: ${cmd.raw}`);
    }
  }

  if (
    result.impactedComponents.length === 0 &&
    result.relatedTests.length === 0 &&
    result.downstreamFeatures.length === 0
  ) {
    lines.push("\n(Selector matches nothing in the map — no impact found. This is not an error.)");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// `th repo check` (IF-001 / REQ-201..205, REQ-NFR-002/003/004)
// ---------------------------------------------------------------------------

/**
 * Exit codes for `th repo check` (IF-001).
 * Anchor: REQ-203 — three-way exit: 0 fresh / 4 stale / 5 no-map / 1 parse-fail.
 *
 * Re-exported from the pure core module (ARCH-002) so the command layer and the
 * pure freshness computation share ONE definition while existing importers
 * (`./next`, the repo-check tests) keep their `from "./repo"` import unchanged.
 * (Imported at the top of this file; re-exported here under the same names.)
 */
export { REPO_STALE_EXIT, REPO_NO_MAP_EXIT };

export interface RepoCheckOptions {
  /**
   * P4-8 — scan-cap overrides matching `th repo map`. When a large-repo map was built
   * with raised caps, the freshness re-scan MUST use the same caps so it covers the
   * same scope (otherwise files beyond the default cap would phantom as added/removed).
   * Absent ⇒ scanner defaults (the common case).
   */
  scanOptions?: ScanOptions;
}

/**
 * `th repo check [--json]` — load the persisted map, rescan the working tree within
 * scope, diff `fileHashes`, and return a three-way Staleness Outcome.
 *
 * Follows Critical Pattern 1 EXACTLY (REQ-NFR-003):
 *  - named `runRepoCheck`, `paths` first, typed opts second defaulting `{}`;
 *  - returns `success()`/`failure()` — NEVER throws, NEVER `process.exit`;
 *  - calls `structuredLog()` exactly once before return.
 *
 * Exit codes (IF-001):
 *   0  fresh           — tree matches map within scope
 *   4  stale           — files added/removed/modified, or map lacks fileHashes (no_hashes)
 *   5  no-map          — .twinharness/repo-map.json is absent
 *   1  parse-failure   — map_invalid-json | map_version | map_schema
 *
 * Side-effect-free: never writes repo-map.json.
 *
 * Anchor: REQ-201 — th repo check subcommand implemented here.
 * Anchor: REQ-202 — detects added/removed/modified within scanner scope.
 * Anchor: REQ-203 — three-way exit (0/4/5/1).
 * Anchor: REQ-204 — { fresh, added[], removed[], modified[] } report; no_hashes graceful.
 * Anchor: REQ-205 — deterministic strategy; never executes content.
 * Anchor: REQ-NFR-002 — hash-compare only; no mtime; deterministic.
 * Anchor: REQ-NFR-003 — read-only; no subprocess; no path escape.
 * Anchor: REQ-NFR-004 — absent fileHashes → no_hashes stale (not crash, not fresh).
 */
export function runRepoCheck(paths: ProjectPaths, opts: RepoCheckOptions = {}): CommandResult {
  const REPO_MAP_JSON = path.join(paths.stateDir, "repo-map.json");

  // This handler is now PURE I/O + delegation (ARCH-002): it reads the map, scans
  // and hashes the working tree, then hands the loaded inputs to the pure
  // `computeFreshness` taxonomy. The exit code, `--json` data shape, human text,
  // and structuredLog record are all owned by the pure module — byte-identical to
  // the previous in-command logic.
  const emit = (outcome: ReturnType<typeof computeFreshness>): CommandResult => {
    structuredLog(outcome.log);
    return { ok: outcome.ok, exitCode: outcome.exitCode, data: outcome.data, human: outcome.human };
  };

  // ---- Step 1: Load the persisted map ----------------------------------------
  let rawMap: string | null = null;
  try {
    rawMap = fs.readFileSync(REPO_MAP_JSON, "utf8");
  } catch {
    // File absent → no-map (exit 5).
    return emit(computeFreshness({ kind: "no-map" }));
  }

  // ---- Step 2: Parse the map (tagged failure, never throws) ------------------
  const parsed = parseRepoMap(rawMap);
  if (!parsed.ok || !parsed.map) {
    const errorCode = parsed.error ?? "map_invalid-json";
    return emit(computeFreshness({ kind: "parse-fail", error: errorCode }));
  }
  const map = parsed.map;

  // ---- Step 3: Graceful degradation — no fileHashes in map (REQ-NFR-004) ----
  // Anchor: REQ-NFR-004 — valid map without fileHashes → no_hashes stale (exit 4, not crash/fresh).
  if (!map.fileHashes || Object.keys(map.fileHashes).length === 0) {
    return emit(computeFreshness({ kind: "no-hashes" }));
  }

  // ---- Step 4: Rescan the working tree (same scope as runRepoMap) -------------
  // Reuse scanRepo defaults (GENERATED_DIRS, FILE_COUNT_CAP) for scope coherence
  // (REQ-202). Read-only; never executes content (REQ-NFR-003).
  // P4-8 — honor cap overrides so the re-scan scope matches a large-repo `th repo map`.
  const currentMap = scanRepo(paths.root, opts.scanOptions ?? {});

  // ---- Step 5: Hash current files within the rescan scope --------------------
  // Anchor: REQ-NFR-003 — content read via readFileSync; no execution; no path escape.
  // Unreadable files: omitted from the current hash set (conservative: they will
  // appear as "removed" if previously tracked, or simply absent — REQ-NFR-003).
  const currentHashes: Record<string, string> = {};
  for (const f of currentMap.files) {
    const abs = path.join(paths.root, f.path);
    // Scope containment: relPosix ensures the path is within root by construction
    // (scanner.ts relPosix strips abs prefix — no escape possible). Defense-in-depth:
    // resolve and verify before reading.
    // P2-4: byte-exact `hashFileBytes` — the SAME function the store path uses, so
    // a text file matches and binaries no longer collide (no missed staleness).
    // Anchor: REQ-NFR-003 — no path escape: only files emitted by scanRepo (within root).
    try {
      currentHashes[f.path] = hashFileBytes(abs);
    } catch {
      // Unreadable file → skip (REQ-NFR-003, REQ-RU-090). This file will appear
      // as "removed" only if it was previously tracked in map.fileHashes.
    }
  }

  // ---- Step 6: Diff the two hash maps, then delegate the taxonomy -------------
  // Anchor: REQ-202 — detect added/removed/modified within scanner scope.
  // Anchor: REQ-NFR-002 — hash-compare only; no mtime; deterministic.
  const { added, removed, modified } = diffHashes(map.fileHashes, currentHashes);
  return emit(computeFreshness({ kind: "diff", added, removed, modified }));
}

// ---------------------------------------------------------------------------
// P4-10 — bounded-cost freshness wrapper + P4-1/2/3/4 freshness summary.
// ---------------------------------------------------------------------------

/**
 * P4-10 — `runRepoCheck` behind the cheap-signal cache. Identical return shape;
 * a cache hit (the working-tree stat signature is unchanged since the last full
 * check) skips the full `scanRepo` + re-hash. This is the SINGLE entry point used
 * by BOTH freshness consumers added in Phase 4 — the MCP repo tools (P4-3) and the
 * brownfield `checkRepoMap` gate (P4-5) — so per-call full-tree hashing is never
 * shipped on a hot path. `th repo check` itself stays uncached (an explicit,
 * authoritative re-check). `structuredLog` is emitted by the underlying
 * `runRepoCheck` on a miss; a hit replays the same cached outcome.
 */
export function runRepoCheckCached(paths: ProjectPaths, opts: RepoCheckOptions = {}): CommandResult {
  return cachedFreshness(paths, (p) => runRepoCheck(p, opts));
}

/**
 * P4-1/2/3/4 — the freshness/partial summary every downstream consumer (context
 * pack, doctor, MCP repo tools, relevance/impact) reads to decide whether the
 * persisted map can still be trusted. Derived at QUERY time (never persisted), so
 * determinism (REQ-NFR-001) is untouched.
 *
 *  - `fresh`           — true iff `th repo check` returns exit 0.
 *  - `stale`           — the negation (added/removed/modified/no-hashes/absent/parse-fail).
 *  - `mapPresent`      — false only on no-map (exit 5).
 *  - `shape`           — the freshness outcome shape (fresh|stale|no-map|parse-fail label).
 *  - `added/removed/modified` — counts (0 when not applicable) for doctor's drift line.
 *  - `partial`/`scanIncomplete` — the PERSISTED partial-scan marker (capHit≠null), read
 *    from the map; a partial map is INCOMPLETE even when "fresh", so consumers must
 *    surface it too (P4-4).
 */
export interface RepoFreshnessSummary {
  fresh: boolean;
  stale: boolean;
  mapPresent: boolean;
  shape: string;
  added: number;
  removed: number;
  modified: number;
  /** P4-4 — persisted partial-scan marker (capHit≠null on disk). */
  partial: boolean;
  scanIncomplete: boolean;
  /** Which cap was hit (null when complete), echoed for messaging. */
  capHit: null | "file-count" | "total-bytes";
}

/**
 * P4-5 helper — read JUST the persisted partial-scan marker (capHit) without a full
 * freshness re-scan. Cheap: parses the on-disk map and returns its deterministic
 * `capHit` (null when the map is absent/invalid or the scan was complete). Used by the
 * brownfield gate so it can block a partial map BEFORE paying for a freshness scan.
 */
export function repoMapPartialMarker(paths: ProjectPaths): { partial: boolean; capHit: RepoFreshnessSummary["capHit"] } {
  const loaded = loadPersistedMap(paths, "repo partial");
  if (loaded.result || !loaded.map) return { partial: false, capHit: null };
  const capHit = loaded.map.scanReport.capHit;
  return { partial: capHit !== null, capHit };
}

/**
 * Compute the {@link RepoFreshnessSummary} for the persisted map (P4-1/2/3/4).
 * Read-only; uses the cached freshness check (P4-10) so it is cheap to call on hot
 * paths. The partial marker is read independently of freshness so a partial-but-
 * unchanged map is still flagged as incomplete.
 */
export function repoFreshnessSummary(paths: ProjectPaths): RepoFreshnessSummary {
  const check = runRepoCheckCached(paths);
  const data = (check.data ?? {}) as {
    shape?: string;
    added?: string[];
    removed?: string[];
    modified?: string[];
  };
  const mapPresent = check.exitCode !== REPO_NO_MAP_EXIT;
  const shape = data.shape ?? (check.ok ? "fresh" : "stale");

  // P4-4 — read the persisted partial marker. Independent of freshness: a complete-
  // but-unchanged scan is fresh AND not partial; a capped scan is partial even if
  // unchanged. Missing/invalid map ⇒ not partial (the freshness layer already flags it).
  let partial = false;
  let capHit: RepoFreshnessSummary["capHit"] = null;
  const loaded = loadPersistedMap(paths, "repo freshness");
  if (!loaded.result && loaded.map) {
    capHit = loaded.map.scanReport.capHit;
    partial = capHit !== null;
  }

  return {
    fresh: check.ok,
    stale: !check.ok,
    mapPresent,
    shape,
    added: (data.added ?? []).length,
    removed: (data.removed ?? []).length,
    modified: (data.modified ?? []).length,
    partial,
    scanIncomplete: partial,
    capHit,
  };
}
