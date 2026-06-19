/**
 * `repo-map.json` schema, the single deterministic serializer, the strict
 * defensive parser, and the compact markdown renderer for the `th repo` layer.
 *
 * Shape and rules are taken verbatim from the spec contracts (IF-004 / IF-005).
 * This file MIRRORS `src/core/state-schema.ts` (REQ-NFR-003): `serializeRepoMap`
 * ≈ `serializeState` (key-ordered copy), `parseRepoMap` ≈ `validateState`
 * (defensive, returns a tagged failure, NEVER throws). `REPO_MAP_SCHEMA_VERSION`
 * mirrors `CURRENT_SCHEMA_VERSION`.
 *
 * Determinism (REQ-RU-015, REQ-NFR-001, REQ-NFR-006): `serializeRepoMap` is the
 * SINGLE enforcement point — all sorting + POSIX-path normalization happens here,
 * never in the scanner (ADR-003). The in-memory `RepoMap` carries `repoRoot` +
 * `scanReport`; the serializer STRIPS both — they never appear on disk. NO
 * timestamp, absolute path, PID, or nonce is ever emitted. The reserved
 * `extensions` slot is NEVER written (RULE-012, REQ-RU-064).
 */

import { REQ_ID_PATTERN } from "../anchors";
import { BLAST_RADIUS_FLAGS, type BlastRadiusFlag } from "../state-schema";

/**
 * Current repo-map schema version (REQ-RU-064). Emitted FIRST in the JSON.
 * Mirrors `CURRENT_SCHEMA_VERSION` (`src/core/state-schema.ts:15`). Bump on any
 * breaking shape change; consumers reject an unrecognized value cleanly
 * (`map_version`).
 *
 * v1 → v2 (P1-1/P1-4, INVESTIGATION-FIXES-PLAN Phase 1): adds the deterministic
 * partial-scan marker (`capHit` + `partial`) and the per-fact `Provenance`
 * (basis + confidence) model. The repo-map is a DERIVED artifact — there is no
 * in-place migration: a version mismatch is detected by `parseRepoMap`
 * (`map_version`) and consumers REGENERATE via `th repo map` (RULE-006). Old (v1)
 * maps therefore fail CLOSED rather than being silently read as stale.
 *
 * v2 → v3 (DEFERRED-ITEMS-PLAN pre-work + #1 + #2): adds the `"alias"` edge basis
 * (tsconfig/jsconfig paths+baseUrl and workspace bare-package resolution) and the
 * optional `coverage` field (lcov-derived file→test association). `EDGE_BASES` is a
 * parser-enforced CLOSED union, so adding a value is forward-incompatible. Same
 * no-migration contract: a v2 map fails CLOSED (`map_version`) and is regenerated.
 */
export const REPO_MAP_SCHEMA_VERSION = 3;

/** Source of a language detection. */
export type LanguageSource = "extension" | "manifest" | "both";

/**
 * Provenance (P1-3) — the BASIS + CONFIDENCE of an inferred fact. Generalises the
 * lone `public_api.confidence` so every derived signal (component, entrypoint,
 * ownership hint, blast-radius signal, public-API surface) carries an HONEST
 * record of HOW it was inferred and HOW MUCH to trust it.
 *
 *   basis — the kind of evidence:
 *     "exact"      a direct, unambiguous fact (e.g. a file that literally exists)
 *     "manifest"   declared in a package/build manifest (package.json, etc.)
 *     "parsed"     extracted by parsing source (import/symbol — Phase 2)
 *     "path-token" inferred from a directory/path token (a heuristic)
 *     "name"       inferred from a file/dir name convention (a heuristic)
 *     "component"  inferred from the derived component grouping
 *   confidence — "high" | "medium" | "low" (consumers downgrade low to "verify").
 */
export type ProvenanceBasis =
  | "exact"
  | "manifest"
  | "parsed"
  | "path-token"
  | "name"
  | "component";
export type ConfidenceTier = "high" | "medium" | "low";
export interface Provenance {
  basis: ProvenanceBasis;
  confidence: ConfidenceTier;
}

/** Classification of a discovered (inert) candidate command. */
export type CandidateCommandKind = "build" | "test" | "lint" | "other";

export interface Language {
  name: string;
  /** Sorted by the serializer. */
  evidence: string[];
  source: LanguageSource;
}

export interface PackageManager {
  name: string;
  /** POSIX-relative; sorted by the serializer. */
  manifest_paths: string[];
}

/**
 * A discovered build/test command recorded as INERT data — NEVER executed
 * (RULE-004, REQ-RU-004). `raw` is the verbatim string from the manifest/Makefile.
 */
export interface CandidateCommand {
  label: string;
  raw: string;
  source_file: string;
  kind: CandidateCommandKind;
}

export interface Component {
  /** POSIX-relative id, e.g. "src/commands". */
  name: string;
  path: string;
  file_count: number;
  /** P1-3 — basis+confidence; additive, omit-when-absent. */
  provenance?: Provenance;
}

export interface Entrypoint {
  name: string;
  path: string;
  /** e.g. "package.json:bin" | "package.json:main" | "convention". */
  source: string;
  /** P1-3 — basis+confidence; additive, omit-when-absent. */
  provenance?: Provenance;
}

export interface ApiHint {
  name: string;
  source: string;
}

export interface PublicApiSurface {
  /** Sorted by name by the serializer. */
  hints: ApiHint[];
  confidence: "heuristic";
  /** P1-3 — basis+confidence; additive, omit-when-absent. Generalises `confidence`. */
  provenance?: Provenance;
}

export interface OwnershipHint {
  /** POSIX-relative. */
  path_prefix: string;
  /** Component.name. */
  component: string;
  /** P1-3 — basis+confidence; additive, omit-when-absent. */
  provenance?: Provenance;
}

/**
 * P2-1 — an exported symbol extracted from a source file by lightweight, pure text
 * parsing (NEVER execution — RULE-004). `kind` is a coarse, language-agnostic bucket
 * ("function" | "class" | "type" | "const" | "interface" | "enum" | "other"); over-
 * coarse is fine (RULE-008). Additive + omit-when-absent (REQ-NFR-004).
 */
export type SymbolKind =
  | "function"
  | "class"
  | "type"
  | "interface"
  | "enum"
  | "const"
  | "trait"
  | "other";
export interface ExportedSymbol {
  name: string;
  kind: SymbolKind;
}

export interface FileEntry {
  /** POSIX-relative; the primary sort key. */
  path: string;
  /** Component.name; null = unowned. */
  component: string | null;
  /** Language.name; null when ambiguous. */
  language: string | null;
  is_test: boolean;
  /** Sorted lexicographically by the serializer. */
  req_ids: string[];
  /**
   * P2-1 — exported symbols (parsed). Additive, omit-when-absent. The serializer
   * emits this key ONLY when the array is non-empty; sorts by (name, kind).
   */
  symbols?: ExportedSymbol[];
}

/**
 * P2-2 — an import edge between two in-repo files (resolved) OR from an in-repo file
 * to an UNRESOLVED specifier (bare/aliased/tsconfig-paths — recorded honestly as
 * `external`, NEVER guessed). `basis` carries the Provenance basis:
 *   "parsed"     — `to` is an in-repo path resolved from a relative/same-package
 *                  specifier (trustworthy; only these may outrank path-token signals).
 *   "unresolved" — the specifier is bare/aliased and `to` is the RAW specifier text;
 *                  `external:true`. NEVER promoted to high confidence (P2-5/P2-8).
 *
 * `EdgeBasis` deliberately reuses the `parsed` ProvenanceBasis value and adds the
 * edge-only `unresolved` sentinel.
 */
export type EdgeBasis = "parsed" | "alias" | "unresolved";
export interface ImportEdge {
  /** POSIX-relative source file (always in-repo). */
  from: string;
  /** POSIX-relative target file (in-repo) when basis="parsed"; raw specifier when "unresolved". */
  to: string;
  kind: "import";
  basis: EdgeBasis;
  /** True when `to` is NOT an in-repo path (bare/aliased/tsconfig-paths). Omit-when-false. */
  external?: boolean;
}

export interface ReqAnchor {
  /** Matches the canonical REQ_ID_PATTERN. */
  req_id: string;
  /** POSIX-relative; sorted by the serializer. */
  locations: string[];
}

export interface BlastRadiusSignal {
  flag: BlastRadiusFlag;
  /** POSIX-relative; sorted by the serializer. */
  matching_paths: string[];
  /** Sorted by the serializer. */
  trigger_patterns: string[];
  /** P1-3 — basis+confidence; additive, omit-when-absent. */
  provenance?: Provenance;
}

/**
 * P3-5 — a pruned/excluded path with a machine reason. In-memory ONLY (part of
 * ScanReport); surfaced by `th repo map` but NEVER persisted (run-varying — depends
 * on traversal). The reasons are a closed vocabulary so callers can switch on them.
 */
export type ExclusionReason =
  | "generated-dir" // a known generated/build/cache dir name (node_modules, dist, …)
  | "vendor-at-module-root" // vendor/bin/obj pruned because a sibling manifest indicates deps
  | "producer-dir" // TwinHarness's own state dir (.twinharness)
  | "gitignore-signal" // matched a .gitignore pattern (signal only — never blind)
  | "configured"; // matched a project .twinharnessignore / ScanOptions exclude
export interface ExclusionEntry {
  /** POSIX-relative path that was pruned. */
  path: string;
  reason: ExclusionReason;
}

/**
 * Bounded-scan report (REQ-NFR-007). In-memory ONLY — the serializer strips it;
 * it never appears in the persisted `repo-map.json`.
 */
export interface ScanReport {
  filesScanned: number;
  filesSkipped: number;
  capHit: null | "file-count" | "total-bytes";
  /**
   * P3-6 — set when files were scanned (> a small floor) but NO source roots and
   * NO components were derived: a likely-missed layout. Surfaced as a visible
   * warning so a structure miss is never silent. In-memory only.
   */
  lowConfidenceStructure?: boolean;
  /**
   * P3-5 — per-path exclusion reasons (why a dir/file was pruned). In-memory only;
   * surfaced in `th repo map`, never persisted (run-varying).
   */
  exclusions?: ExclusionEntry[];
}

/**
 * In-memory repo map. `repoRoot` + `scanReport` are run-specific and are STRIPPED
 * by `serializeRepoMap` — they never appear on disk (ADR-003). Everything else is
 * persisted, in canonical sorted order.
 */
export interface RepoMap {
  schema_version: number;
  /** In-memory only — stripped on serialize. */
  repoRoot: string;
  /** In-memory only — stripped on serialize. */
  scanReport: ScanReport;
  languages: Language[];
  package_managers: PackageManager[];
  candidate_commands: CandidateCommand[];
  source_roots: string[];
  test_roots: string[];
  docs_roots: string[];
  generated_paths: string[];
  components: Component[];
  entrypoints: Entrypoint[];
  public_api: PublicApiSurface | null;
  ownership_hints: OwnershipHint[];
  files: FileEntry[];
  req_anchors: ReqAnchor[];
  blast_radius_signals: BlastRadiusSignal[];
  /**
   * P2-2 — import edges (parsed). Additive, omit-when-absent (REQ-NFR-004): the
   * serializer emits `edges` ONLY when the array is non-empty, so a repo with no
   * parsed imports stays byte-backward-readable. Sorted by (from, to, basis).
   */
  edges?: ImportEdge[];
  /**
   * DS-002 — POSIX-relative path → SHA-256 hex (64-char lowercase).
   * Additive, omit-when-absent (REQ-NFR-004). Populated by `runRepoMap` after
   * scanning; absent on pre-epic maps. `serializeRepoMap` emits this key ONLY
   * when present and non-empty. `parseRepoMap` validates every value is 64-char
   * lowercase hex when the key is present (map_schema on violation).
   *
   * Anchor: REQ-202 — per-file hashes enable modified-file detection.
   * Anchor: REQ-204 — hash basis for added/removed/modified diff buckets.
   * Anchor: REQ-NFR-004 — backward-compatible; omitted when absent.
   */
  fileHashes?: Record<string, string>;
}

/** Construct an empty, valid in-memory RepoMap. `fileHashes` is absent (omit-when-absent — DS-002). */
export function emptyRepoMap(repoRoot: string): RepoMap {
  return {
    schema_version: REPO_MAP_SCHEMA_VERSION,
    repoRoot,
    scanReport: { filesScanned: 0, filesSkipped: 0, capHit: null },
    languages: [],
    package_managers: [],
    candidate_commands: [],
    source_roots: [],
    test_roots: [],
    docs_roots: [],
    generated_paths: [],
    components: [],
    entrypoints: [],
    public_api: null,
    ownership_hints: [],
    files: [],
    req_anchors: [],
    blast_radius_signals: [],
    // fileHashes intentionally absent — omit-when-absent (REQ-NFR-004)
  };
}

/* ------------------------------------------------------------------ *
 * Determinism helpers — the SINGLE sort/normalization point.          *
 * ------------------------------------------------------------------ */

/** Normalize any path to POSIX-relative (forward slashes), defensively. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Stable lexicographic string sort (independent of host locale). */
function sortStrings(arr: string[]): string[] {
  return [...arr].map(toPosix).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function byKey<T>(arr: T[], key: (t: T) => string): T[] {
  return [...arr].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * P1-3 — emit a `Provenance` object (fixed key order: basis, confidence) ONLY
 * when present (omit-when-absent — REQ-NFR-004). Returned as a spreadable
 * fragment so callers append it as the LAST key of each structure deterministically.
 */
function provenanceFragment(p: Provenance | undefined): { provenance?: Provenance } {
  return p ? { provenance: { basis: p.basis, confidence: p.confidence } } : {};
}

/**
 * Deterministic serialization of a RepoMap to the persisted on-disk form
 * (IF-004). THE single enforcement point for determinism (ADR-003):
 *
 * - emits keys in the exact contract order, `schema_version` FIRST;
 * - strips the in-memory-only `repoRoot` + `scanReport`;
 * - sorts every collection by its declared key and every inner array
 *   lexicographically;
 * - normalizes every path to POSIX-relative (forward slash);
 * - NEVER writes the reserved `extensions` key (RULE-012);
 * - emits `JSON.stringify(ordered, null, 2) + "\n"` (2-space indent, single
 *   trailing newline) — no timestamp, abs path, PID, or nonce.
 */
export function serializeRepoMap(map: RepoMap): string {
  const ordered = {
    schema_version: map.schema_version,
    // P1-2 — deterministic partial-scan marker (the #5 root cause). We persist
    // ONLY the bounded, traversal-order-independent `capHit` enum and the derived
    // `partial` boolean. The run-varying counts (`filesScanned`/`filesSkipped`)
    // are NEVER persisted — they depend on `readdir` order and would break the
    // byte-identical golden (REQ-NFR-001). A `null` capHit ⇒ a complete scan.
    capHit: map.scanReport.capHit,
    partial: map.scanReport.capHit !== null,
    languages: byKey(
      map.languages.map((l) => ({
        name: l.name,
        evidence: sortStrings(l.evidence),
        source: l.source,
      })),
      (l) => l.name,
    ),
    package_managers: byKey(
      map.package_managers.map((pm) => ({
        name: pm.name,
        manifest_paths: sortStrings(pm.manifest_paths),
      })),
      (pm) => pm.name,
    ),
    candidate_commands: byKey(
      map.candidate_commands.map((c) => ({
        label: c.label,
        raw: c.raw,
        source_file: toPosix(c.source_file),
        kind: c.kind,
      })),
      // Stable across runs even when two commands share a source file/kind.
      (c) => `${toPosix(c.source_file)} ${c.kind} ${c.label} ${c.raw}`,
    ),
    source_roots: sortStrings(map.source_roots),
    test_roots: sortStrings(map.test_roots),
    docs_roots: sortStrings(map.docs_roots),
    generated_paths: sortStrings(map.generated_paths),
    components: byKey(
      map.components.map((c) => ({
        name: toPosix(c.name),
        path: toPosix(c.path),
        file_count: c.file_count,
        ...provenanceFragment(c.provenance),
      })),
      (c) => toPosix(c.name),
    ),
    entrypoints: byKey(
      map.entrypoints.map((e) => ({
        name: e.name,
        path: toPosix(e.path),
        source: e.source,
        ...provenanceFragment(e.provenance),
      })),
      (e) => `${toPosix(e.path)} ${e.source} ${e.name}`,
    ),
    public_api: map.public_api
      ? {
          hints: byKey(
            map.public_api.hints.map((h) => ({ name: h.name, source: h.source })),
            (h) => `${h.name} ${h.source}`,
          ),
          confidence: map.public_api.confidence,
          ...provenanceFragment(map.public_api.provenance),
        }
      : null,
    ownership_hints: byKey(
      map.ownership_hints.map((o) => ({
        path_prefix: toPosix(o.path_prefix),
        component: toPosix(o.component),
        ...provenanceFragment(o.provenance),
      })),
      (o) => toPosix(o.path_prefix),
    ),
    files: byKey(
      map.files.map((f) => ({
        path: toPosix(f.path),
        component: f.component === null ? null : toPosix(f.component),
        language: f.language,
        is_test: f.is_test,
        req_ids: sortStrings(f.req_ids),
        // P2-1 — emit `symbols` ONLY when non-empty (omit-when-absent — REQ-NFR-004).
        // Sorted by (name, kind) for byte-stable output (ADR-003).
        ...(f.symbols && f.symbols.length > 0
          ? {
              symbols: byKey(
                f.symbols.map((s) => ({ name: s.name, kind: s.kind })),
                (s) => `${s.name} ${s.kind}`,
              ),
            }
          : {}),
      })),
      (f) => toPosix(f.path),
    ),
    req_anchors: byKey(
      map.req_anchors.map((r) => ({
        req_id: r.req_id,
        locations: sortStrings(r.locations),
      })),
      (r) => r.req_id,
    ),
    blast_radius_signals: byKey(
      map.blast_radius_signals.map((s) => ({
        flag: s.flag,
        matching_paths: sortStrings(s.matching_paths),
        trigger_patterns: sortStrings(s.trigger_patterns),
        ...provenanceFragment(s.provenance),
      })),
      (s) => s.flag,
    ),
    // P2-2: emit `edges` ONLY when non-empty (omit-when-absent — REQ-NFR-004).
    // Sorted by (from, to, basis) for byte-stable output (ADR-003). `external` is
    // emitted only when true (omit-when-false). Placed after blast_radius_signals
    // and before fileHashes (fixed contract order).
    ...(map.edges && map.edges.length > 0
      ? {
          edges: byKey(
            map.edges.map((e) => ({
              from: toPosix(e.from),
              // "parsed"/"alias" carry an in-repo path → POSIX-normalize; "unresolved"
              // carries the RAW specifier text → leave verbatim.
              to: e.basis === "unresolved" ? e.to : toPosix(e.to),
              kind: e.kind,
              basis: e.basis,
              ...(e.external ? { external: true } : {}),
            })),
            (e) => `${toPosix(e.from)} ${e.to} ${e.basis}`,
          ),
        }
      : {}),
    // DS-002: emit fileHashes ONLY when present and non-empty (omit-when-absent —
    // REQ-NFR-004). Keys are sorted for byte-stable output (REQ-NFR-002).
    // Anchor: REQ-NFR-002 — deterministic: sorted keys, CRLF-normalized values (via hashContent).
    // Anchor: REQ-NFR-004 — backward-compat: absent field → no key emitted → pre-epic byte identity.
    ...(map.fileHashes && Object.keys(map.fileHashes).length > 0
      ? {
          fileHashes: Object.fromEntries(
            Object.entries(map.fileHashes)
              .map(([k, v]) => [toPosix(k), v] as [string, string])
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ),
        }
      : {}),
  };

  return JSON.stringify(ordered, null, 2) + "\n";
}

/* ------------------------------------------------------------------ *
 * Strict defensive parser — mirrors validateState (never throws).     *
 * ------------------------------------------------------------------ */

/** Tagged failure variants (IF-002/IF-003 error contracts). */
export type RepoMapParseFailure =
  | "map_missing"
  | "map_invalid-json"
  | "map_schema"
  | "map_version";

export interface RepoMapParseResult {
  ok: boolean;
  /** Present only on success. */
  map?: RepoMap;
  /** Present only on failure — the stable machine code consumers switch on. */
  error?: RepoMapParseFailure;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

const LANGUAGE_SOURCES: readonly string[] = ["extension", "manifest", "both"];
const COMMAND_KINDS: readonly string[] = ["build", "test", "lint", "other"];
const SCAN_CAPS: readonly (string | null)[] = [null, "file-count", "total-bytes"];

// P1-3 — provenance vocabulary, mirrored from the `ProvenanceBasis`/`ConfidenceTier`
// unions above so the defensive parser can validate an on-disk value.
const PROVENANCE_BASES: readonly string[] = [
  "exact",
  "manifest",
  "parsed",
  "path-token",
  "name",
  "component",
];
const CONFIDENCE_TIERS: readonly string[] = ["high", "medium", "low"];

// P2-1/P2-2 — symbol-kind + edge-basis vocabularies, mirrored from the unions above.
const SYMBOL_KINDS: readonly string[] = [
  "function",
  "class",
  "type",
  "interface",
  "enum",
  "const",
  "trait",
  "other",
];
const EDGE_BASES: readonly string[] = ["parsed", "alias", "unresolved"];

/** Validate an optional `symbols` array (P2-1). Absent ⇒ valid (omit-when-absent). */
function isValidSymbols(v: unknown): boolean {
  if (v === undefined) return true;
  return (
    Array.isArray(v) &&
    v.every(
      (s) =>
        isPlainObject(s) &&
        typeof s.name === "string" &&
        typeof s.kind === "string" &&
        SYMBOL_KINDS.includes(s.kind),
    )
  );
}

/**
 * Validate an optional `provenance` value (P1-3). Absent ⇒ valid (omit-when-absent).
 * Present ⇒ must be a plain object with a known `basis` + `confidence`.
 */
function isValidProvenance(v: unknown): boolean {
  if (v === undefined) return true;
  return (
    isPlainObject(v) &&
    typeof v.basis === "string" &&
    PROVENANCE_BASES.includes(v.basis) &&
    typeof v.confidence === "string" &&
    CONFIDENCE_TIERS.includes(v.confidence)
  );
}

/**
 * Parse + validate a `repo-map.json` blob. Returns a TAGGED result and NEVER
 * throws (REQ-RU-043). Mirrors `validateState`: the success path produces a fully
 * typed in-memory `RepoMap` (with `repoRoot` defaulted to "" and a zeroed
 * `scanReport`, since neither is persisted).
 *
 * Failure ordering matters: `map_invalid-json` (unparseable) → `map_version`
 * (parseable but unrecognized `schema_version`) → `map_schema` (recognized
 * version but malformed). A `null`/missing raw string yields `map_missing`.
 */
export function parseRepoMap(raw: string | null | undefined): RepoMapParseResult {
  if (raw === null || raw === undefined) {
    return { ok: false, error: "map_missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "map_invalid-json" };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: "map_schema" };
  }

  // Version check before structural validation so an unknown version is reported
  // as map_version (not map_schema) — consumers re-run `th repo map` (RULE-006).
  const ver = parsed.schema_version;
  if (typeof ver !== "number" || !Number.isInteger(ver)) {
    return { ok: false, error: "map_schema" };
  }
  if (ver !== REPO_MAP_SCHEMA_VERSION) {
    return { ok: false, error: "map_version" };
  }

  if (!validateRepoMapShape(parsed)) {
    return { ok: false, error: "map_schema" };
  }

  const p = parsed as Record<string, unknown>;
  // P1-2 — reconstruct the partial-scan marker. The run-varying counts are not
  // persisted, so they default to 0; only `capHit` (and the derived `partial`)
  // survive a round-trip. `partial` is purely derived from `capHit`, so we trust
  // `capHit` as the canonical signal (validated by `validateRepoMapShape`).
  const persistedCap = (p.capHit ?? null) as ScanReport["capHit"];
  const map: RepoMap = {
    schema_version: ver,
    repoRoot: "",
    scanReport: { filesScanned: 0, filesSkipped: 0, capHit: persistedCap },
    languages: p.languages as Language[],
    package_managers: p.package_managers as PackageManager[],
    candidate_commands: p.candidate_commands as CandidateCommand[],
    source_roots: p.source_roots as string[],
    test_roots: p.test_roots as string[],
    docs_roots: p.docs_roots as string[],
    generated_paths: p.generated_paths as string[],
    components: p.components as Component[],
    entrypoints: p.entrypoints as Entrypoint[],
    public_api: (p.public_api ?? null) as PublicApiSurface | null,
    ownership_hints: p.ownership_hints as OwnershipHint[],
    files: p.files as FileEntry[],
    req_anchors: p.req_anchors as ReqAnchor[],
    blast_radius_signals: p.blast_radius_signals as BlastRadiusSignal[],
    // P2-2: carry edges when present (validated above).
    ...(p.edges !== undefined && p.edges !== null
      ? { edges: p.edges as ImportEdge[] }
      : {}),
    // DS-002: carry fileHashes when present (validated above).
    ...(p.fileHashes !== undefined && p.fileHashes !== null
      ? { fileHashes: p.fileHashes as Record<string, string> }
      : {}),
  };
  return { ok: true, map };
}

/** Structural validation of an already-version-checked plain object. */
function validateRepoMapShape(v: Record<string, unknown>): boolean {
  // P1-2 — partial-scan marker. `capHit` (when present) must be a known cap enum
  // and `partial` (when present) a boolean. Both are absent on a hand-built v1
  // shape but always emitted in v2; tolerated-when-absent so a future reader stays
  // permissive (REQ-NFR-004).
  if (v.capHit !== undefined && !SCAN_CAPS.includes(v.capHit as string | null)) return false;
  if (v.partial !== undefined && typeof v.partial !== "boolean") return false;

  if (!Array.isArray(v.languages) ||
    !v.languages.every((l) =>
      isPlainObject(l) &&
      typeof l.name === "string" &&
      isStringArray(l.evidence) &&
      typeof l.source === "string" &&
      LANGUAGE_SOURCES.includes(l.source))
  ) return false;

  if (!Array.isArray(v.package_managers) ||
    !v.package_managers.every((pm) =>
      isPlainObject(pm) && typeof pm.name === "string" && isStringArray(pm.manifest_paths))
  ) return false;

  if (!Array.isArray(v.candidate_commands) ||
    !v.candidate_commands.every((c) =>
      isPlainObject(c) &&
      typeof c.label === "string" &&
      typeof c.raw === "string" &&
      typeof c.source_file === "string" &&
      typeof c.kind === "string" &&
      COMMAND_KINDS.includes(c.kind))
  ) return false;

  if (!isStringArray(v.source_roots)) return false;
  if (!isStringArray(v.test_roots)) return false;
  if (!isStringArray(v.docs_roots)) return false;
  if (!isStringArray(v.generated_paths)) return false;

  if (!Array.isArray(v.components) ||
    !v.components.every((c) =>
      isPlainObject(c) &&
      typeof c.name === "string" &&
      typeof c.path === "string" &&
      typeof c.file_count === "number" &&
      Number.isInteger(c.file_count) &&
      (c.file_count as number) >= 0 &&
      isValidProvenance(c.provenance))
  ) return false;

  if (!Array.isArray(v.entrypoints) ||
    !v.entrypoints.every((e) =>
      isPlainObject(e) &&
      typeof e.name === "string" &&
      typeof e.path === "string" &&
      typeof e.source === "string" &&
      isValidProvenance(e.provenance))
  ) return false;

  if (v.public_api !== null && v.public_api !== undefined) {
    const pa = v.public_api;
    if (!isPlainObject(pa)) return false;
    if (pa.confidence !== "heuristic") return false;
    if (!isValidProvenance(pa.provenance)) return false;
    if (!Array.isArray(pa.hints) ||
      !pa.hints.every((h) =>
        isPlainObject(h) && typeof h.name === "string" && typeof h.source === "string")
    ) return false;
  }

  if (!Array.isArray(v.ownership_hints) ||
    !v.ownership_hints.every((o) =>
      isPlainObject(o) &&
      typeof o.path_prefix === "string" &&
      typeof o.component === "string" &&
      isValidProvenance(o.provenance))
  ) return false;

  if (!Array.isArray(v.files) ||
    !v.files.every((f) =>
      isPlainObject(f) &&
      typeof f.path === "string" &&
      (f.component === null || typeof f.component === "string") &&
      (f.language === null || typeof f.language === "string") &&
      typeof f.is_test === "boolean" &&
      isStringArray(f.req_ids) &&
      isValidSymbols(f.symbols))
  ) return false;

  // P2-2 — edges: optional. When present, every entry must have in-repo `from`,
  // string `to`, kind "import", a known basis, and (when present) boolean external.
  if (v.edges !== undefined && v.edges !== null) {
    if (!Array.isArray(v.edges) ||
      !v.edges.every((e) =>
        isPlainObject(e) &&
        typeof e.from === "string" &&
        typeof e.to === "string" &&
        e.kind === "import" &&
        typeof e.basis === "string" &&
        EDGE_BASES.includes(e.basis) &&
        (e.external === undefined || typeof e.external === "boolean"))
    ) return false;
  }

  const reqIdRe = new RegExp(`^${REQ_ID_PATTERN}$`);
  if (!Array.isArray(v.req_anchors) ||
    !v.req_anchors.every((r) =>
      isPlainObject(r) &&
      typeof r.req_id === "string" &&
      reqIdRe.test(r.req_id) &&
      isStringArray(r.locations))
  ) return false;

  const flags: readonly string[] = BLAST_RADIUS_FLAGS;
  if (!Array.isArray(v.blast_radius_signals) ||
    !v.blast_radius_signals.every((s) =>
      isPlainObject(s) &&
      typeof s.flag === "string" &&
      flags.includes(s.flag) &&
      isStringArray(s.matching_paths) &&
      isStringArray(s.trigger_patterns) &&
      isValidProvenance(s.provenance))
  ) return false;

  // DS-002: fileHashes is optional. When present, every value must be a 64-char
  // lowercase hex string (SHA-256). Any invalid value → map_schema (REQ-NFR-004).
  // Anchor: REQ-NFR-004 — absent field accepted; invalid value → map_schema error.
  // Anchor: REQ-202 — when present, hashes enable modified-file detection.
  if (v.fileHashes !== undefined && v.fileHashes !== null) {
    if (!isPlainObject(v.fileHashes)) return false;
    const hexRe = /^[0-9a-f]{64}$/;
    for (const val of Object.values(v.fileHashes as Record<string, unknown>)) {
      if (typeof val !== "string" || !hexRe.test(val)) return false;
    }
  }

  return true;
}

/* ------------------------------------------------------------------ *
 * Compact markdown renderer (IF-005) — deterministic, byte-stable.    *
 * ------------------------------------------------------------------ */

/**
 * Render the compact human/agent summary `docs/00-repo-map.md` (IF-005) — NOT a
 * full map dump (REQ-NFR-004). Deterministic and byte-stable: no date, no
 * absolute path; ends with a single trailing newline. Sections are emitted in a
 * fixed order and each is stable when empty. The serialized form is the source
 * of all counts so the markdown inherits the same sort determinism.
 */
export function renderRepoMapMarkdown(map: RepoMap): string {
  const serialized = JSON.parse(serializeRepoMap(map)) as ReturnType<typeof JSON.parse> & {
    languages: Language[];
    package_managers: PackageManager[];
    source_roots: string[];
    test_roots: string[];
    docs_roots: string[];
    generated_paths: string[];
    components: Component[];
    entrypoints: Entrypoint[];
    public_api: PublicApiSurface | null;
    files: FileEntry[];
    req_anchors: ReqAnchor[];
    candidate_commands: CandidateCommand[];
    blast_radius_signals: BlastRadiusSignal[];
  };

  const lines: string[] = [];
  lines.push("# Repo Map");
  lines.push("");

  // P4-4 — PARTIAL banner: when the scan hit a cap the map is INCOMPLETE, and every
  // downstream consumer (relevance/impact/context pack) inherits that incompleteness.
  // Surface it at the very top of the human artifact so it is impossible to miss. The
  // `capHit` enum is the deterministic marker (P1-2); the run-varying counts are not
  // emitted here, so the markdown stays stable for an unchanged scan.
  if (map.scanReport.capHit !== null) {
    lines.push(`> ⚠ **PARTIAL SCAN** — cap hit: \`${map.scanReport.capHit}\`. This map is INCOMPLETE; relevance/impact/context results derived from it will be partial. Raise the scan caps and re-run \`th repo map\`.`);
    lines.push("");
  }

  lines.push("## Languages");
  if (serialized.languages.length === 0) lines.push("(none detected)");
  else for (const l of serialized.languages) lines.push(`- ${l.name} (${l.source})`);
  lines.push("");

  lines.push("## Package managers");
  if (serialized.package_managers.length === 0) lines.push("(none detected)");
  else for (const pm of serialized.package_managers) lines.push(`- ${pm.name} (${pm.manifest_paths.length} manifest(s))`);
  lines.push("");

  lines.push("## Roots");
  lines.push(`- Source: ${serialized.source_roots.join(", ") || "(none)"}`);
  lines.push(`- Test: ${serialized.test_roots.join(", ") || "(none)"}`);
  lines.push(`- Docs: ${serialized.docs_roots.join(", ") || "(none)"}`);
  lines.push("");

  lines.push("## Components");
  if (serialized.components.length === 0) lines.push("(none detected)");
  else for (const c of serialized.components) lines.push(`- ${c.name} (${c.file_count} file(s))`);
  lines.push("");

  lines.push("## Entrypoints");
  if (serialized.entrypoints.length === 0) lines.push("(none detected)");
  else for (const e of serialized.entrypoints) lines.push(`- ${e.name} — ${e.path} (${e.source})`);
  lines.push("");

  lines.push("## Public API");
  lines.push(serialized.public_api ? `${serialized.public_api.hints.length} hint(s) (heuristic)` : "(not detected)");
  lines.push("");

  lines.push("## Blast-radius signals");
  if (serialized.blast_radius_signals.length === 0) lines.push("(none detected)");
  else for (const s of serialized.blast_radius_signals) lines.push(`- ${s.flag} (${s.matching_paths.length} match(es))`);
  lines.push("");

  lines.push("## Counts");
  lines.push(`- Files: ${serialized.files.length}`);
  lines.push(`- REQ anchors: ${serialized.req_anchors.length}`);
  lines.push(`- Candidate commands: ${serialized.candidate_commands.length}`);
  lines.push(`- Generated dirs: ${serialized.generated_paths.length}`);

  return lines.join("\n") + "\n";
}
