import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { resolveWithinRoot } from "../core/paths";
import { type CommandResult, type ReadReceipt, success, failure } from "../core/output";
import { readState } from "../core/state-store";
import { extractSummary } from "../core/summary";
import { hashContent } from "../core/hash";
import { structuredLog } from "../core/log";
import { runRepoRelevant, repoFreshnessSummary } from "./repo";

// Anchor: REQ-RU-061
// Anchor: REQ-RU-095
// Anchor: REQ-RU-063

/**
 * `th context estimate` — approximate the context/token cost of the plugin's
 * prompt surface (Phase 3; the Goose/Windsurf "no token visibility" gap, and
 * the lever for audit F7). Heuristic only: ~4 chars per token. Flags prompt
 * files that exceed Claude Code's guidance (SKILL/agent bodies < ~500 lines;
 * invoked skills are re-attached keeping only the first ~5,000 tokens after
 * compaction, so a body past that can lose its tail on long runs).
 *
 * Read-only; resolves files relative to the plugin root, not the user's project.
 */

const TOKENS_PER_CHAR = 1 / 4;
const LINE_WARN = 500;
const TOKEN_WARN = 5000;

interface FileEstimate {
  file: string;
  lines: number;
  tokens: number;
  flag: boolean;
}

/** Plugin root from the compiled location (dist/commands → root). */
function pluginRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function listMd(dir: string): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function estimate(root: string, abs: string): FileEstimate {
  const content = fs.readFileSync(abs, "utf8");
  const lines = content.split(/\r?\n/).length;
  const tokens = Math.round(content.length * TOKENS_PER_CHAR);
  return {
    file: path.relative(root, abs).split(path.sep).join("/"),
    lines,
    tokens,
    flag: lines > LINE_WARN || tokens > TOKEN_WARN,
  };
}

/**
 * `th context estimate` — report per-file and total approximate token cost of
 * the orchestration prompt surface (skill + reference files + agents + commands).
 */
export function runContextEstimate(): CommandResult {
  const root = pluginRoot();
  const files = [
    ...listMd(path.join(root, "skills")),
    ...listMd(path.join(root, "agents")),
    ...listMd(path.join(root, "commands")),
  ]
    .map((abs) => estimate(root, abs))
    .sort((a, b) => b.tokens - a.tokens);

  const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
  const flagged = files.filter((f) => f.flag);

  const rows = files.map(
    (f) => `${f.flag ? "!" : " "} ${String(f.tokens).padStart(6)} tok  ${String(f.lines).padStart(4)} ln  ${f.file}`,
  );
  const human = [
    "Approximate prompt-surface context cost (~4 chars/token):",
    ...rows,
    "",
    `Total: ~${totalTokens} tokens across ${files.length} prompt files.`,
    flagged.length
      ? `${flagged.length} file(s) exceed the guidance (>${LINE_WARN} lines or >${TOKEN_WARN} tokens): ${flagged.map((f) => f.file).join(", ")}`
      : `All prompt files are within the ${LINE_WARN}-line / ${TOKEN_WARN}-token guidance.`,
  ].join("\n");

  return success({
    data: { files, totalTokens, flagged: flagged.map((f) => f.file), lineWarn: LINE_WARN, tokenWarn: TOKEN_WARN },
    human,
  });
}

/* ------------------------------------------------------------------ *
 * `th context pack` — assemble a slice/agent handoff bundle (spec §9). *
 * ------------------------------------------------------------------ */

export interface ContextPackOptions {
  /** Limit/annotate the pack for a specific slice (SLICE-ID). */
  slice?: string;
  /** P4-7 — frame the repo-relevant layer for a specific REQ-ID. */
  req?: string;
  /** P4-7 — frame the repo-relevant layer for a specific file path. */
  file?: string;
  /**
   * P4-6 — token budget for the assembled pack. When set (>0), the pack ranks its
   * artifact Summary blocks and DROPS the lowest-value ones until the total fits,
   * reporting which were omitted and why. ≤0 / undefined ⇒ no budget (current
   * behavior). The number is RAW tokens (not thousands).
   */
  maxTokens?: number;
}

interface PackedArtifact {
  file: string;
  version: number;
  summary: string | null;
  /** The text actually included (Summary block, head fallback, or directory note). */
  text: string;
  tokens: number;
  exists: boolean;
  isDir: boolean;
}

/**
 * `th context pack [--slice <SLICE-ID>]` — mechanically assemble the §9 handoff
 * bundle: the Summary block of every approved artifact (the handoff currency),
 * plus, when `--slice` is given, that slice's record, its components, and the
 * other slices that share those components (conflict awareness for §16).
 *
 * It COMPUTES a candidate bundle from durable state + artifact summaries; it does
 * NOT decide what to route — the Orchestrator still owns that call. Read-only.
 */
export function runContextPack(paths: ProjectPaths, opts: ContextPackOptions = {}): CommandResult {
  const r = readState(paths);
  if (!r.exists) return failure({ human: "No state.json found. Run `th init` first.", data: { error: "not_initialized" } });
  if (!r.state) return failure({ human: "state.json is invalid.", data: { error: "invalid_state", issues: r.issues } });
  const s = r.state;

  const packed: PackedArtifact[] = s.approved_artifacts.map((a) => {
    const abs = path.resolve(paths.root, a.file);
    let exists = false;
    let isDir = false;
    let content = "";
    if (fs.existsSync(abs)) {
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        exists = true;
        content = fs.readFileSync(abs, "utf8");
      } else if (stat.isDirectory()) {
        // Directory artifacts (e.g. docs/05-adrs/) have no single Summary block.
        exists = true;
        isDir = true;
      }
    }
    const { summary, head } = extractSummary(content);
    const text = isDir ? `(directory artifact — read ${a.file}/ on demand)` : summary ?? head;
    return { file: a.file, version: a.version, summary, text, tokens: Math.round(text.length / 4), exists, isDir };
  });

  // Slice-specific framing.
  let sliceBlock: { id: string; status: string; components: string[]; sharesWith: Array<{ id: string; shared: string[] }> } | undefined;
  if (opts.slice) {
    const target = s.slices.find((sl) => sl.id === opts.slice);
    if (!target) {
      return failure({
        human: `Unknown slice: ${opts.slice}. Known: ${s.slices.map((sl) => sl.id).join(", ") || "(none)"}`,
        data: { error: "unknown_slice", slice: opts.slice },
      });
    }
    const components = new Set(target.components);
    const sharesWith = s.slices
      .filter((sl) => sl.id !== target.id)
      .map((sl) => ({ id: sl.id, shared: sl.components.filter((c) => components.has(c)) }))
      .filter((x) => x.shared.length > 0);
    sliceBlock = { id: target.id, status: target.status, components: target.components, sharesWith };
  }

  // REQ-RU-061 / REQ-RU-095: when --slice is given, augment the bundle with
  // repo-relevant files/tests sourced from the persisted repo-map (READ-ONLY —
  // no re-scan; uses runRepoRelevant which reads .twinharness/repo-map.json).
  // If the map is missing or malformed, we include an informational note but do
  // NOT fail the overall pack (the §9 bundle is still usable).
  let repoRelevantFiles: Array<{ path: string; why: string; kind: "readFirst" | "related" | "tests" }> = [];
  let repoRelevantNote: string | null = null;

  // P4-7 — the repo-relevant layer accepts a slice, REQ, or file selector (mirrors
  // `runRepoRelevant`'s selectors). The pack frames whichever ONE is given.
  const relSelector: { slice?: string; req?: string; file?: string } | null =
    opts.slice && sliceBlock
      ? { slice: opts.slice }
      : opts.req
        ? { req: opts.req }
        : opts.file
          ? { file: opts.file }
          : null;

  if (relSelector) {
    const relResult = runRepoRelevant(paths, relSelector);
    if (relResult.ok && relResult.data) {
      const d = relResult.data as {
        readFirst?: Array<{ path: string; why: string }>;
        related?: Array<{ path: string; why: string }>;
        tests?: Array<{ path: string; why: string }>;
      };
      for (const item of d.readFirst ?? []) repoRelevantFiles.push({ ...item, kind: "readFirst" });
      for (const item of d.related ?? []) repoRelevantFiles.push({ ...item, kind: "related" });
      for (const item of d.tests ?? []) repoRelevantFiles.push({ ...item, kind: "tests" });
    } else if (!relResult.ok) {
      // Map missing / not initialized: surface as a note, do NOT fail the pack.
      repoRelevantNote = `(repo-relevant layer unavailable: ${(relResult.data as Record<string, unknown>)?.error ?? "unknown error"} — run \`th repo map\` first)`;
    }
  }

  // P4-1/P4-4 — freshness + partial-scan status of the persisted repo-map. The pack
  // injects repo intelligence from that map, so a STALE or INCOMPLETE map must be
  // labelled inline (the agents consuming this pack — librarian/orchestrator — act on
  // `repoMapFresh`). Read-only; uses the cached freshness check (P4-10). When NO repo
  // intelligence layer was requested (no selector) we still report the map's status so
  // the consumer knows the substrate it would draw on.
  const freshness = repoFreshnessSummary(paths);
  const repoMapFresh = freshness.fresh && !freshness.partial;

  // P4-6 — token budget. When `maxTokens > 0`, rank the artifact Summary blocks
  // (registered order is the proxy for priority — earliest-approved artifacts are the
  // load-bearing spec/req docs) and DROP the lowest-priority blocks until the kept set
  // fits the budget. Dropped blocks are reported ("omitted N items, why"). The
  // `truncated` flag (P4-6: surface the dropped state) is true iff anything was omitted.
  // ≤0 / undefined ⇒ keep everything (current behavior).
  const budget = typeof opts.maxTokens === "number" && opts.maxTokens > 0 ? opts.maxTokens : null;
  let kept = packed;
  const omitted: Array<{ file: string; version: number; tokens: number; reason: string }> = [];
  if (budget !== null) {
    kept = [];
    let running = 0;
    for (const p of packed) {
      if (running + p.tokens <= budget) {
        kept.push(p);
        running += p.tokens;
      } else {
        omitted.push({
          file: p.file,
          version: p.version,
          tokens: p.tokens,
          reason: `would exceed --max-tokens budget (${budget}); ${running}+${p.tokens} > ${budget}`,
        });
      }
    }
  }
  const truncated = omitted.length > 0;

  const totalTokens = kept.reduce((sum, p) => sum + p.tokens, 0);
  structuredLog({
    cmd: "context pack",
    slice: opts.slice ?? null,
    artifacts: kept.length,
    tokens: totalTokens,
    repoRelevantFiles: repoRelevantFiles.length,
    repoMapFresh,
    truncated,
    omitted: omitted.length,
  });

  // P4-1/P4-4 — STALE / PARTIAL labels prepended so a consumer cannot miss them.
  const staleLabel = !repoMapFresh
    ? freshness.partial
      ? `⚠ PARTIAL repo-map — the scan hit cap "${freshness.capHit}"; the repo-relevant layer below is INCOMPLETE. Raise the scan caps and re-run \`th repo map\`.`
      : `⚠ STALE repo-map — ${freshness.mapPresent ? `the working tree drifted from the map (${freshness.shape})` : "no repo-map.json on disk"}; the repo-relevant layer below may be wrong. Run \`th repo map\` to refresh.`
    : null;

  const selectorLabel = opts.slice ?? (opts.req ? opts.req : opts.file ? opts.file : null);
  const header = selectorLabel
    ? `Context pack for ${selectorLabel} — ${kept.length} artifact summary block(s), ~${totalTokens} tokens${truncated ? ` (${omitted.length} omitted for budget)` : ""}`
    : `Context pack — ${kept.length} artifact summary block(s), ~${totalTokens} tokens${truncated ? ` (${omitted.length} omitted for budget)` : ""}`;

  const sliceLines = sliceBlock
    ? [
        "",
        `Slice ${sliceBlock.id} [${sliceBlock.status}] — components: ${sliceBlock.components.join(", ") || "(none)"}`,
        sliceBlock.sharesWith.length
          ? `  Shares components with (serialize per §16): ${sliceBlock.sharesWith.map((x) => `${x.id} (${x.shared.join(", ")})`).join("; ")}`
          : "  No component overlap with other slices (safe to parallelize).",
      ]
    : [];

  // REQ-RU-061: repo-relevant section in human text.
  const repoRelevantLines: string[] = [];
  if (relSelector) {
    repoRelevantLines.push("");
    if (repoRelevantNote) {
      repoRelevantLines.push(`Repo-relevant files: ${repoRelevantNote}`);
    } else if (repoRelevantFiles.length === 0) {
      repoRelevantLines.push("Repo-relevant files: (none matched — repo-map may be empty for this selector)");
    } else {
      repoRelevantLines.push(`Repo-relevant files (${repoRelevantFiles.length} from repo-understanding layer):`);
      for (const f of repoRelevantFiles) {
        repoRelevantLines.push(`  [${f.kind}] ${f.path}  — ${f.why}`);
      }
    }
  }

  const artifactLines =
    kept.length === 0
      ? ["", omitted.length > 0 ? "(all artifacts omitted for budget — see omissions below)" : "(no approved artifacts yet — nothing to pack)"]
      : kept.flatMap((p) => [
          "",
          `### ${p.file} (v${p.version})${p.exists ? "" : " — MISSING ON DISK"}${p.summary === null && p.exists && !p.isDir ? " — no Summary block (head shown)" : ""}`,
          p.text || "(empty)",
        ]);

  // P4-6 — omission report: "omitted N items, why".
  const omissionLines: string[] =
    omitted.length > 0
      ? ["", `Omitted ${omitted.length} item(s) to fit --max-tokens=${budget}:`, ...omitted.map((o) => `  - ${o.file} (v${o.version}, ~${o.tokens} tok): ${o.reason}`)]
      : [];

  const human = [
    ...(staleLabel ? [staleLabel, ""] : []),
    header,
    ...sliceLines,
    ...repoRelevantLines,
    ...artifactLines,
    ...omissionLines,
  ].join("\n");

  return success({
    data: {
      slice: sliceBlock ?? null,
      artifacts: kept,
      totalTokens,
      // P4-1/P4-4 — freshness + partial status of the repo-map this pack draws on.
      repoMapFresh,
      repoMapFreshness: freshness,
      partial: freshness.partial,
      scanIncomplete: freshness.scanIncomplete,
      // P4-6 — budget + omission report (additive; omit-when-absent is not needed —
      // these are always present so the contract test can pin them).
      maxTokens: budget,
      truncated,
      omitted,
      // REQ-RU-061: repo-relevant data included in structured response.
      repoRelevantFiles,
      repoRelevantNote: repoRelevantNote ?? null,
    },
    human,
  });
}

/* ------------------------------------------------------------------ *
 * `th context read` (SG3 P1-B / C-11) — batch read under one budget.  *
 * ------------------------------------------------------------------ */

/** Estimator shared with `th context pack` / `th artifact section` (~4 chars/token). */
function estimateTokens(text: string): number {
  return Math.round(text.length * TOKENS_PER_CHAR);
}

export interface ContextReadOptions {
  /** Files to read (root-relative or absolute within root). */
  files?: string[];
  /** Single token budget shared across ALL files (>0; ≤0/absent ⇒ no budget). */
  maxTokens?: number;
}

interface ReadFileResult {
  file: string;
  exists: boolean;
  /** The text actually included (may be a deterministic line-prefix when truncated). */
  text: string;
  tokens: number;
  truncated: boolean;
  /** Omitted entirely because the budget was exhausted before this file. */
  omitted: boolean;
}

/**
 * `th context read --files <list> --max-tokens N` (C-11) — batch-read a set of files
 * under ONE shared token budget, with deterministic truncation and a per-file
 * `{file, hash, tokensConsumed}` RECEIPT. This is the governed batch-read primitive: an
 * agent hands a file list and a budget and gets back exactly what fits, in order, with
 * a verifiable hash of each file it actually read — instead of N unbounded raw reads.
 *
 * Determinism: files are processed in the GIVEN order. Each file's full content is read
 * and a receipt minted (hash of the FULL content + the tokens actually charged). While
 * budget remains, the file is included whole; the file that would OVERFLOW the budget is
 * truncated to a deterministic line-prefix; every file after the budget is exhausted is
 * marked `omitted` (still receipted with `tokensConsumed:0` so the audit trail shows it
 * was requested). A missing/escaping file is reported (`exists:false`) and skipped, not
 * fatal. Read-only.
 *
 * Follows Critical Pattern 1: named `runContextRead`, `paths` first, typed opts second;
 * returns `success()`/`failure()` (never throws / exits); one structuredLog before return.
 */
export function runContextRead(paths: ProjectPaths, opts: ContextReadOptions = {}): CommandResult {
  const files = (opts.files ?? []).map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) {
    structuredLog({ cmd: "context read", error: "no_files" });
    return failure({ human: "Provide at least one file: --files <comma-separated list>.", data: { error: "no_files" } });
  }

  const budget = typeof opts.maxTokens === "number" && opts.maxTokens > 0 ? opts.maxTokens : null;
  const results: ReadFileResult[] = [];
  const receipts: ReadReceipt[] = [];
  let running = 0;
  let budgetExhausted = false;

  for (const f of files) {
    const relKey = path.relative(paths.root, path.resolve(paths.root, f)).split(path.sep).join("/");
    const abs = resolveWithinRoot(paths.root, f);
    if (abs === null || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      results.push({ file: relKey, exists: false, text: "", tokens: 0, truncated: false, omitted: false });
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      results.push({ file: relKey, exists: false, text: "", tokens: 0, truncated: false, omitted: false });
      continue;
    }

    const fullHash = hashContent(content);

    // Budget already exhausted by an earlier file → omit (but still receipt the request).
    if (budgetExhausted) {
      results.push({ file: relKey, exists: true, text: "", tokens: 0, truncated: false, omitted: true });
      receipts.push({ file: relKey, hash: fullHash, tokensConsumed: 0 });
      continue;
    }

    const fullTokens = estimateTokens(content);
    let text = content;
    let tokens = fullTokens;
    let truncated = false;

    if (budget !== null && running + fullTokens > budget) {
      // Truncate THIS file to the remaining budget by keeping a deterministic line prefix.
      const remaining = budget - running;
      const lines = content.split("\n");
      const kept: string[] = [];
      let used = 0;
      for (const line of lines) {
        const cost = estimateTokens(line + "\n");
        if (used + cost > remaining) break;
        kept.push(line);
        used += cost;
      }
      text = kept.join("\n");
      tokens = estimateTokens(text);
      truncated = true;
      budgetExhausted = true; // anything after this is omitted.
    }

    running += tokens;
    results.push({ file: relKey, exists: true, text, tokens, truncated, omitted: false });
    receipts.push({ file: relKey, hash: fullHash, tokensConsumed: tokens });
    if (budget !== null && running >= budget) budgetExhausted = true;
  }

  const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
  const missing = results.filter((r) => !r.exists).map((r) => r.file);
  const omittedFiles = results.filter((r) => r.omitted).map((r) => r.file);
  const anyTruncated = results.some((r) => r.truncated);

  structuredLog({
    cmd: "context read",
    files: files.length,
    read: results.filter((r) => r.exists && !r.omitted).length,
    missing: missing.length,
    omitted: omittedFiles.length,
    tokens: totalTokens,
    truncated: anyTruncated,
  });

  const human = [
    `Read ${results.filter((r) => r.exists && !r.omitted).length}/${files.length} file(s), ~${totalTokens} tokens${budget !== null ? ` (budget ${budget})` : ""}.`,
    ...(missing.length ? [`Missing/outside-root (skipped): ${missing.join(", ")}`] : []),
    ...(omittedFiles.length ? [`Omitted for budget: ${omittedFiles.join(", ")}`] : []),
    ...results
      .filter((r) => r.exists && !r.omitted)
      .flatMap((r) => [
        "",
        `### ${r.file} (~${r.tokens} tok${r.truncated ? ", TRUNCATED" : ""})`,
        r.text || "(empty)",
      ]),
  ].join("\n");

  return success({
    receipts,
    data: { files: results, totalTokens, maxTokens: budget, truncated: anyTruncated, missing, omitted: omittedFiles, receipts },
    human,
  });
}
