/**
 * `th sim …` — the simulation-ledger CLI handlers (SG3 P2-C, audit C-05..C-08).
 *
 * The ledger (`.twinharness/simulation-ledger.json`) is a SEPARATE append-only JSON
 * file — NOT `state.json` (the brief's hard requirement). It tracks every place a
 * user-visible production path is standing in for the real thing (Mocked/Stubbed/
 * Hardcoded/Emulated) so the production-reality gate can refuse completion while any
 * non-retired user-visible simulation remains. `retire` is a modeled lifecycle
 * transition (status active→retired), like a decision being superseded — entries are
 * never deleted, so the audit history is complete.
 *
 * Four handlers, each a convention-conformant `CommandResult` handler (paths first,
 * typed opts second, never throws, one `structuredLog` per invocation):
 *   runSimAdd     — append an `active` entry; mint SIM-NNN; audit trail.
 *   runSimList    — the read model (entries + the count that blocks the gate).
 *   runSimRetire  — flip an entry to `retired`; refuse unknown / double-retire.
 *   runSimScan    — grep `dist/` + tests for unledgered simulation patterns (advisory).
 *
 * The classification enum + the gate-blocking predicate live in
 * `src/core/simulation.ts` (the PURE seam, mirroring drift-log / decisions); the
 * production-reality GATE that reads this ledger lives in
 * `src/core/gate-preconditions.ts` (`checkProductionReality`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { resolveWithinRoot } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { atomicWriteFile, readFileWithRetry } from "../core/atomic-io";
import { withStateLock } from "../core/state-store";
import { structuredLog } from "../core/log";
import { appendLedger } from "../core/ledger";
import { NOT_INIT } from "../core/guards";
import { readState } from "../core/state-store";
import {
  type SimulationEntry,
  type SimulationClassification,
  type SimulationStatus,
  SIMULATION_CLASSIFICATIONS,
  SIMULATION_SCAN_TOKENS,
  asClassification,
  asStatus,
  blocksProductionReality,
  isSimulatedClassification,
  nextSimulationId,
} from "../core/simulation";
import {
  appendTerminalReceipt,
  TargetUnresolvedError,
  ensureReceiptMigration,
  readReceiptValidated,
} from "../core/receipts";
import { hashFileStreaming } from "../core/hash";
import {
  appendScanCompletenessReceipt,
  readScanExceptionValidated,
  type UnobservedReason,
} from "../core/scan-completeness";

/** `<stateDir>/simulation-ledger.json` — the append-only ledger file. */
export function simulationLedgerPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "simulation-ledger.json");
}

/**
 * Read the ledger, returning [] when absent. A present-but-corrupt ledger throws a
 * typed marker so the caller fails CLOSED rather than silently treating a tampered
 * ledger as empty (which would let the gate pass on an unreadable simulation
 * inventory — the same fail-open the verify-config gate already refuses).
 */
export class SimulationLedgerCorruptError extends Error {
  readonly code = "simulation_ledger_corrupt";
}

export function readSimulationLedger(paths: ProjectPaths): SimulationEntry[] {
  const file = simulationLedgerPath(paths);
  if (!fs.existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileWithRetry(file);
  } catch {
    return [];
  }
  if (raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SimulationLedgerCorruptError(`simulation-ledger.json is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new SimulationLedgerCorruptError(`simulation-ledger.json is not a JSON array`);
  }
  // FAIL-CLOSED projection (audit P2): a malformed row is NOT silently skipped — this
  // is a SECURITY ledger, and the prior skip-malformed posture let a damaged/edited
  // BLOCKER disappear (dropped row) or downgrade to non-blocking (`userVisible`
  // defaulting to false) while the gate still reported success. So every gate-relevant
  // field (id / classification / status / userVisible) must be well-shaped, or the
  // whole ledger is treated as corrupt — exactly the posture the module doc promises
  // and that `checkProductionReality` maps to `simulation_ledger_corrupt`. The free-text
  // metadata fields (replaces/introSlice/retireSlice/owner) stay tolerant (default "")
  // because they never affect the blocking decision.
  const entries: SimulationEntry[] = [];
  for (const row of parsed as unknown[]) {
    if (typeof row !== "object" || row === null) {
      throw new SimulationLedgerCorruptError("simulation-ledger.json contains a non-object entry");
    }
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.trim() === "") {
      throw new SimulationLedgerCorruptError("a simulation entry has a missing/invalid id");
    }
    const classification = asClassification(typeof r.classification === "string" ? r.classification : undefined);
    if (!classification) {
      throw new SimulationLedgerCorruptError(`simulation entry ${r.id} has a missing/invalid classification`);
    }
    if (typeof r.userVisible !== "boolean") {
      throw new SimulationLedgerCorruptError(`simulation entry ${r.id} has a missing/invalid userVisible flag`);
    }
    // status: absent ⇒ "active" (fail-CLOSED — an entry with no status still blocks);
    // present-but-invalid ⇒ corrupt (a tampered status must not be silently coerced).
    let status: SimulationStatus;
    if (r.status === undefined) {
      status = "active";
    } else {
      const s = asStatus(typeof r.status === "string" ? r.status : undefined);
      if (!s) throw new SimulationLedgerCorruptError(`simulation entry ${r.id} has an invalid status`);
      status = s;
    }
    entries.push({
      id: r.id,
      replaces: typeof r.replaces === "string" ? r.replaces : "",
      introSlice: typeof r.introSlice === "string" ? r.introSlice : "",
      retireSlice: typeof r.retireSlice === "string" ? r.retireSlice : "",
      owner: typeof r.owner === "string" ? r.owner : "",
      classification,
      status,
      userVisible: r.userVisible,
    });
  }
  return entries;
}

/** Atomically persist the whole ledger array through the governed chokepoint. */
function writeSimulationLedger(paths: ProjectPaths, entries: SimulationEntry[]): void {
  atomicWriteFile(simulationLedgerPath(paths), JSON.stringify(entries, null, 2) + "\n", { root: paths.root });
}

export interface SimAddOptions {
  replaces?: string;
  introSlice?: string;
  retireSlice?: string;
  owner?: string;
  classification?: string;
  userVisible?: boolean;
}

/**
 * `th sim add --classification <C> [--replaces ...] [--intro-slice ...] [--retire-slice ...] [--owner ...] [--user-visible]`
 * Mint the next SIM id, append an `active` entry. `--classification` is required and
 * must be a known taxonomy value. A `--user-visible` entry of a SIMULATED
 * classification is exactly what the production-reality gate later blocks on, so the
 * human output flags that explicitly.
 */
export function runSimAdd(paths: ProjectPaths, opts: SimAddOptions): CommandResult {
  return withStateLock(paths, () => runSimAddLocked(paths, opts));
}

function runSimAddLocked(paths: ProjectPaths, opts: SimAddOptions): CommandResult {
  const classification = asClassification(opts.classification);
  if (!classification) {
    return failure({
      human: `usage: th sim add --classification <${SIMULATION_CLASSIFICATIONS.join("|")}> [--replaces ...] [--intro-slice ...] [--retire-slice ...] [--owner ...] [--user-visible]`,
      data: { error: "invalid_classification", classification: opts.classification ?? null, valid: SIMULATION_CLASSIFICATIONS },
    });
  }

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({ human: "state.json is invalid; fix it before adding a simulation entry.", data: { error: "invalid_state", issues: r.issues } });
  }

  let entries: SimulationEntry[];
  try {
    entries = readSimulationLedger(paths);
  } catch (e) {
    return ledgerCorruptFailure(e);
  }

  const id = nextSimulationId(entries);
  const entry: SimulationEntry = {
    id,
    replaces: opts.replaces ?? "",
    introSlice: opts.introSlice ?? "",
    retireSlice: opts.retireSlice ?? "",
    owner: opts.owner ?? "",
    classification,
    status: "active",
    userVisible: opts.userVisible === true,
  };
  writeSimulationLedger(paths, [...entries, entry]);

  const blocks = blocksProductionReality(entry);
  // Audit ledger (mirrors drift): adding a user-visible simulation opens a gate.
  appendLedger(paths, { event: "simulation-added", id, classification, userVisible: entry.userVisible, blocks });

  structuredLog({ cmd: "sim add", id, classification, userVisible: entry.userVisible, blocks });
  return success({
    data: { id, entry, blocks },
    human: blocks
      ? `${id} logged (${classification}, user-visible). This BLOCKS production-reality completion until retired (\`th sim retire ${id}\`).`
      : `${id} logged (${classification}${entry.userVisible ? ", user-visible" : ""}).`,
  });
}

export interface SimListOptions {
  // No flags beyond --json / --cwd (universal).
}

/** `th sim list` — every entry + the count of non-retired user-visible blockers. */
export function runSimList(paths: ProjectPaths, _opts: SimListOptions = {}): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;

  let entries: SimulationEntry[];
  try {
    entries = readSimulationLedger(paths);
  } catch (e) {
    return ledgerCorruptFailure(e);
  }

  const blocking = entries.filter(blocksProductionReality);
  const human = entries.length
    ? entries
        .map(
          (e) =>
            `${e.id}  ${e.classification.padEnd(9)} ${e.status.padEnd(7)} ${e.userVisible ? "[user-visible]" : "             "}${blocksProductionReality(e) ? " [BLOCKS]" : ""}  replaces: ${e.replaces || "-"}`,
        )
        .join("\n")
    : "(no simulation entries)";

  structuredLog({ cmd: "sim list", entries: entries.length, blocking: blocking.length });
  return success({
    data: { entries, blocking: blocking.map((e) => e.id) },
    human,
  });
}

export interface SimRetireOptions {
  retireSlice?: string;
  /**
   * The source path the retirement resolves in (Axis-B slice-1a / BSC-4). REQUIRED
   * to retire a BLOCKING (user-visible + active + simulated) entry — such a flip now
   * mints a grounded `sim-retire` receipt whose target must resolve in source.
   * OPTIONAL (and unused) for a non-blocking retire (not user-visible, or
   * Real/Sandbox), whose behavior is unchanged.
   */
  target?: string;
}

/**
 * `th sim retire <SIM-NNN> [--retire-slice ...] [--target <path>]` — flip an entry
 * to `retired` (records the retiring slice when supplied). Refuses an unknown id and
 * a double-retire. The entry is preserved (status transition, not deletion).
 *
 * Axis-B slice-1a (BSC-4): retiring a BLOCKING entry (user-visible + active +
 * simulated) now REQUIRES `--target` and mints a grounded `sim-retire` receipt
 * BEFORE the status flip, so the completion gate can recompute that the retirement
 * actually corresponds to source (negative-control **c** at creation). A failed mint
 * leaves the entry active — no partial flip.
 */
export function runSimRetire(paths: ProjectPaths, id: string | undefined, opts: SimRetireOptions = {}): CommandResult {
  return withStateLock(paths, () => runSimRetireLocked(paths, id, opts));
}

function runSimRetireLocked(paths: ProjectPaths, id: string | undefined, opts: SimRetireOptions): CommandResult {
  if (!id) return failure({ human: "usage: th sim retire <SIM-NNN> [--retire-slice ...] [--target <path>]" });

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({ human: "state.json is invalid; fix it before retiring a simulation entry.", data: { error: "invalid_state", issues: r.issues } });
  }

  let entries: SimulationEntry[];
  try {
    entries = readSimulationLedger(paths);
  } catch (e) {
    return ledgerCorruptFailure(e);
  }

  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) {
    return failure({
      human: `Simulation entry not found: ${id}. Known: ${entries.map((e) => e.id).join(", ") || "(none)"}`,
      data: { error: "simulation_not_found", id },
    });
  }
  const entry = entries[idx]!;
  if (entry.status === "retired") {
    return failure({ human: `${id} is already retired.`, data: { error: "already_retired", id } });
  }

  // Axis-B slice-1a (BSC-4) grounding. A BLOCKING retire (user-visible + active +
  // simulated) must mint a grounded `sim-retire` receipt BEFORE the flip; a failed
  // mint must leave the entry active (no partial flip). Run the migration FIRST so the
  // entity is not yet terminal/grandfathered when the new producer code runs and it
  // gets a REAL receipt rather than being implicitly grandfathered. Idempotent; the
  // caller holds the state lock.
  if (blocksProductionReality(entry)) {
    ensureReceiptMigration(paths);
    if (opts.target === undefined || opts.target === "") {
      return failure({
        human: "th sim retire <id> --target <path> is required for a user-visible simulation",
        data: { error: "sim_retire_target_required", id },
      });
    }
    try {
      appendTerminalReceipt(paths, {
        kind: "sim-retire",
        refId: id,
        targetPath: opts.target,
        producerIdentity: "cli:th sim retire",
      });
    } catch (e) {
      if (e instanceof TargetUnresolvedError) {
        return failure({
          human: `Refusing to retire ${id}: target "${opts.target}" does not resolve in source.`,
          data: { error: e.code, id, target: e.target },
        });
      }
      throw e;
    }
  }

  const updated: SimulationEntry = {
    ...entry,
    status: "retired",
    retireSlice: opts.retireSlice ?? entry.retireSlice,
  };
  const next = entries.slice();
  next[idx] = updated;
  writeSimulationLedger(paths, next);

  appendLedger(paths, { event: "simulation-retired", id, classification: entry.classification });

  structuredLog({ cmd: "sim retire", id, classification: entry.classification });
  return success({
    data: { id, entry: updated },
    human: `${id} retired (${entry.classification}).`,
  });
}

export interface SimScanOptions {
  // No flags beyond --json / --cwd (universal).
}

/** One unledgered-simulation hit: file:line, the token that matched, and the matched
 *  source line (trimmed/capped) so per-dependency ledger matching can be done per hit. */
export interface ScanHit {
  file: string;
  line: number;
  token: string;
  /** The matched source line (trimmed, capped) — used to join a hit to a ledger entry's `replaces` dependency. */
  text: string;
}

/** Cap on the per-hit `text` we retain (keeps scan output bounded; enough to match a dependency name). */
const SCAN_HIT_TEXT_MAX = 200;

// ---------------------------------------------------------------------------
// BSC-6 (Axis-B slice-2a) — layered, defense-in-depth scan budget.
//
// The OLD single per-file cap (`SCAN_FILE_MAX_BYTES`, 2 MB) SILENTLY skipped any
// oversize file (`continue` with no signal), so a simulation token in a >2 MB
// `dist/` file was invisible to BOTH the gate and `th sim scan` — the proven RED of
// `.omc/audit/probes/new-a-scancap/`. The fix is a TWO-TIER scan:
//
//   • Enumeration tier (ALWAYS, every dist/ path): streaming content-hash via
//     `hashFileStreaming` — cheap, bounded-memory, deterministic. We always know what
//     exists and its digest (the basis for ack scoping + the snapshot coordinate).
//   • Deep-inspection tier (BOUNDED): token detection, bounded by the limits below.
//
// Any enumerated path that CANNOT be deep-inspected (per-file / aggregate / watchdog /
// read error) is marked `unobserved` (≠ clean) and FAILS the gate closed. The
// byte/count limits are the DETERMINISTIC coverage determinant (reproducible across
// runners); the wall-clock watchdog is an operational safety net ONLY (it fails closed
// if it fires but, set far above the sub-second normal scan, never decides the verdict
// by machine speed).
//
// Budgets are sized off the real committed `dist/` (≈ 2.28 MB total; largest file
// `dist/mcp-server.js` ≈ 1.02 MB and growing) with generous headroom, so TwinHarness's
// own shipped bundle is always fully deep-inspected (pinned by a committed-`dist/` ⇒
// `unobserved:[]` regression test). The legacy `SCAN_FILE_MAX_BYTES` / `SCAN_MAX_FILES`
// / `SCAN_MAX_BYTES` caps and the `capHit` boolean are RETIRED (replaced by the
// layered limits + the structured `unobserved` set + `limitHit`).
// ---------------------------------------------------------------------------

/** Per-file deep-inspection ceiling: one huge file is `unobserved{file_limit}`, never silently skipped. */
const DEEP_INSPECT_FILE_MAX_BYTES = 8 * 1024 * 1024; // 8 MB (well above mcp-server.js ≈ 1.02 MB)
/** Aggregate deep-inspection ceiling: total parse/load work; remainder → `unobserved{aggregate_limit}`. */
const DEEP_INSPECT_AGGREGATE_MAX_BYTES = 64 * 1024 * 1024; // 64 MB (well above the ≈ 2.28 MB tree)
/** Wall-clock watchdog (operational safety ONLY, never a coverage determinant). */
const SCAN_WATCHDOG_MS = 30_000; // 30 s — orders of magnitude above the sub-second normal scan
/** Enumeration sanity bound: a pathological file count fails closed (`unobserved`), never a silent break. */
const ENUMERATION_FILE_SANITY_MAX = 50_000;

const SCAN_EXTENSIONS = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"]);
const SCAN_SKIP_DIRS = new Set(["node_modules", ".git"]);

/** The deterministic coverage budget + safety watchdog (injectable so the limits are testable). */
export interface ScanLimits {
  /** Per-file deep-inspect ceiling (bytes). Over ⇒ `unobserved{file_limit}`. */
  deepInspectFileMaxBytes: number;
  /** Aggregate deep-inspect ceiling (bytes). Exhausted ⇒ remainder `unobserved{aggregate_limit}`. */
  deepInspectAggregateMaxBytes: number;
  /** Wall-clock watchdog (ms). Fired ⇒ remainder `unobserved{watchdog}` (safety only). */
  watchdogMs: number;
  /** Enumeration file-count sanity bound. Over ⇒ `unobserved` (fail-closed, never silent). */
  enumerationFileSanityMax: number;
}

/** Default layered budget (production values). */
export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  deepInspectFileMaxBytes: DEEP_INSPECT_FILE_MAX_BYTES,
  deepInspectAggregateMaxBytes: DEEP_INSPECT_AGGREGATE_MAX_BYTES,
  watchdogMs: SCAN_WATCHDOG_MS,
  enumerationFileSanityMax: ENUMERATION_FILE_SANITY_MAX,
};

/**
 * Operational override of the deep-inspect budget via env (`TH_SCAN_FILE_MAX_BYTES`,
 * `TH_SCAN_AGGREGATE_MAX_BYTES`, `TH_SCAN_WATCHDOG_MS`). FAIL-SAFE by construction: a
 * smaller budget marks MORE files `unobserved` (the gate blocks harder), a larger one
 * deep-inspects MORE files (their tokens are then caught by the unledgered check) — NO
 * value lets an `unobserved` file silently pass the gate. Unset in normal operation and
 * on CI (so the determinism + committed-`dist/` invariants hold); lets an operator tune
 * the budget without a recompile, and lets the negative-control suite drive the REAL
 * gate to each `unobserved` reason with tiny fixtures. Explicit `opts.limits` win over env.
 */
function envScanLimitOverrides(): Partial<ScanLimits> {
  const out: Partial<ScanLimits> = {};
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const f = num(process.env.TH_SCAN_FILE_MAX_BYTES);
  if (f !== undefined) out.deepInspectFileMaxBytes = f;
  const a = num(process.env.TH_SCAN_AGGREGATE_MAX_BYTES);
  if (a !== undefined) out.deepInspectAggregateMaxBytes = a;
  const w = num(process.env.TH_SCAN_WATCHDOG_MS);
  if (w !== undefined) out.watchdogMs = w;
  return out;
}

/** Test-only seams so the negative-controls + determinism suites are deterministic. */
export interface ScanOptions {
  /** Override (any subset of) the layered limits — small fixtures exercise the budgets without huge files. */
  limits?: Partial<ScanLimits>;
  /** Injectable monotonic clock (ms); defaults to `Date.now`. */
  now?: () => number;
  /** Synthetic latency (ms) added per deep-inspected file — drives the watchdog (b2) deterministically. */
  deepInspectDelayMs?: number;
}

/** One enumerated `dist/` path and its streaming content digest (`null` only on a Pass-A read error). */
export interface EnumeratedPath {
  path: string;
  digest: string | null;
}

/** An enumerated path that could NOT be deep-inspected — fail-closed (`≠ clean`). */
export interface UnobservedPath {
  path: string;
  digest: string | null;
  reason: UnobservedReason;
}

/**
 * The two-tier scan coverage descriptor (BSC-6). `enumerated` + `unobserved` are the
 * NEW fail-closed coverage signal that supersedes the retired `capHit`:
 *   - `enumerated`   — every `dist/` path + its streaming digest (always computed).
 *   - `deepInspected`— the `dist/` paths actually token-scanned (within budget).
 *   - `distHits`     — simulation-token hits found in the deep-inspected `dist/` files.
 *   - `testHits`     — advisory `tests/` hits (NEVER coverage-gating — OQ#1 scope).
 *   - `unobserved`   — enumerated-but-not-deep-inspected `dist/` paths (the gate blocks
 *                      on these, minus valid exceptions).
 *   - `limitHit`     — any limit was reached (replaces `capHit`).
 */
export interface ScanCoverage {
  enumerated: EnumeratedPath[];
  deepInspected: string[];
  distHits: ScanHit[];
  testHits: ScanHit[];
  unobserved: UnobservedPath[];
  limitHit: boolean;
}

/** Lowercase token-presence map so "stub" matches "Stubbed" etc., case-insensitively. */
const SCAN_TOKENS_LC = SIMULATION_SCAN_TOKENS.map((t) => t.toLowerCase());

/**
 * `th sim scan` — grep `dist/` + `tests/` for the simulation patterns
 * (`mock|fake|stub|fixture|placeholder|demo|TODO|canned|hardcoded`) and flag any hit
 * in `dist/` that has no matching ledger entry. ADVISORY: exit 0 always (the GATE,
 * not scan, refuses advance); read-only; never writes. The gate's 4th condition
 * ("unledgered simulation patterns in dist/") reuses THIS scan's dist-hit logic.
 *
 * Hits in `tests/` are reported separately but are NOT unledgered violations —
 * mocks/fixtures are legitimate inside tests; the dist hits are what matter.
 */
export function runSimScan(paths: ProjectPaths, _opts: SimScanOptions = {}): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;

  let entries: SimulationEntry[];
  try {
    entries = readSimulationLedger(paths);
  } catch (e) {
    return ledgerCorruptFailure(e);
  }

  const coverage = scanForSimulationHits(paths);
  // A dist hit is "ledgered" only when an ACTIVE (or retired-but-ungrounded) simulation
  // entry DECLARES that specific hit — matched per-dependency, NOT by global existence
  // (audit P1). The receipt-aware join (BSC-4, control d) also keeps a receipt-less
  // retire's dependency in coverage. The gate's 4th condition reuses the SAME
  // `computeUnledgeredDistHitsReceiptAware` join, so scan and gate agree.
  const unledgeredDistHits = computeUnledgeredDistHitsReceiptAware(paths, entries, coverage.distHits);

  // BSC-6 (slice-2): the COVERAGE gaps — enumerated `dist/` paths that could not be
  // deep-inspected, minus any exonerated by a valid external-signed exception ack. This
  // is the SAME set the gate's condition-4 recomputes (control e parity); `th sim scan`
  // is advisory (exit 0 stays — the gate refuses, not scan), but it prints what the gate
  // sees and persists the incomplete-scan receipt as the durable audit trail.
  const uncovered = uncoveredAfterExceptions(paths, coverage.unobserved);
  if (uncovered.length > 0) {
    // Persist the incomplete-scan receipt (zero gate authority — a result log). Under the
    // state lock for durability + concurrency-suite coverage. Best-effort: a failure to
    // record must not break the advisory scan, so it is swallowed (the gate enforces).
    try {
      withStateLock(paths, () => appendScanCompletenessReceipt(paths, uncovered));
    } catch {
      /* advisory surface — recording the audit receipt is best-effort; the gate recomputes + blocks */
    }
  }

  structuredLog({
    cmd: "sim scan",
    distHits: coverage.distHits.length,
    testHits: coverage.testHits.length,
    unledgered: unledgeredDistHits.length,
    enumerated: coverage.enumerated.length,
    unobserved: uncovered.length,
    limitHit: coverage.limitHit,
  });

  const hitsLine =
    unledgeredDistHits.length > 0
      ? `Found ${unledgeredDistHits.length} UNLEDGERED simulation pattern(s) in dist/ (declare them with \`th sim add\` or remove them):\n` +
        unledgeredDistHits.slice(0, 50).map((h) => `  ${h.file}:${h.line}  [${h.token}]`).join("\n")
      : coverage.distHits.length > 0
        ? `Found ${coverage.distHits.length} simulation pattern(s) in dist/, all covered by active ledger entries.`
        : "No simulation patterns found in dist/.";
  const coverageLine =
    uncovered.length > 0
      ? `\nSCAN COVERAGE INCOMPLETE — ${uncovered.length} dist/ file(s) could not be deep-inspected (the gate BLOCKS on these):\n` +
        uncovered.slice(0, 50).map((u) => `  ${u.path}  [${u.reason}]`).join("\n")
      : "";
  const human = hitsLine + coverageLine;

  return success({
    data: {
      distHits: coverage.distHits,
      testHits: coverage.testHits,
      unledgeredDistHits,
      enumerated: coverage.enumerated,
      deepInspected: coverage.deepInspected,
      unobserved: uncovered,
      limitHit: coverage.limitHit,
    },
    human,
  });
}

/** Project-root-relative, forward-slash path (the stable coordinate used everywhere). */
function relPath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** Collect simulation-token hits from one file's text into `sink` (one hit per line). */
function collectHits(rel: string, content: string, sink: ScanHit[]): void {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lc = lines[i]!.toLowerCase();
    for (let t = 0; t < SCAN_TOKENS_LC.length; t++) {
      if (lc.includes(SCAN_TOKENS_LC[t]!)) {
        sink.push({ file: rel, line: i + 1, token: SIMULATION_SCAN_TOKENS[t]!, text: lines[i]!.trim().slice(0, SCAN_HIT_TEXT_MAX) });
        break; // one hit per line is enough to flag it.
      }
    }
  }
}

/** Recursively list every relevant (scan-extension) file under `absTop`, as absolute paths. */
function walkFiles(absTop: string): { files: string[]; dirReadErrors: string[] } {
  const files: string[] = [];
  const dirReadErrors: string[] = [];
  const stack: string[] = [absTop];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Dist traversal errors are coverage gaps, not "clean". The advisory tests/ caller
      // ignores these; enumerateAndHash turns them into unobserved{read_error}.
      dirReadErrors.push(dir);
      continue;
    }
    for (const d of dirents) {
      if (d.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(d.name)) stack.push(path.join(dir, d.name));
        continue;
      }
      if (!d.isFile()) continue;
      if (!SCAN_EXTENSIONS.has(path.extname(d.name))) continue;
      files.push(path.join(dir, d.name));
    }
  }
  return { files, dirReadErrors };
}

/**
 * Pass A — ENUMERATION (always runs, every `dist/` path, regardless of limits).
 * Streaming-content-hashes every relevant `dist/` file via {@link hashFileStreaming}
 * (bounded memory). Returns the enumerated `{path,digest}` set SORTED by path (so the
 * downstream aggregate-limit cutoff is DETERMINISTIC across runners, where `readdir`
 * order is not) plus any Pass-A read errors as `unobserved{read_error}`. A pathological
 * file count over the sanity bound fails CLOSED (`unobserved`), never a silent break.
 */
function enumerateAndHash(
  paths: ProjectPaths,
  limits: ScanLimits,
): { enumerated: EnumeratedPath[]; readErrors: UnobservedPath[] } {
  const absTop = resolveWithinRoot(paths.root, "dist");
  const enumerated: EnumeratedPath[] = [];
  const readErrors: UnobservedPath[] = [];
  if (!absTop || !fs.existsSync(absTop)) return { enumerated, readErrors };

  // Sort the file list FIRST so the sanity-bound cutoff is deterministic (readdir order
  // varies by platform; an order-dependent cutoff would be non-reproducible).
  const walked = walkFiles(absTop);
  for (const dir of walked.dirReadErrors) {
    readErrors.push({ path: relPath(paths.root, dir), digest: null, reason: "read_error" });
  }
  const files = walked.files
    .map((abs) => ({ abs, rel: relPath(paths.root, abs) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  let count = 0;
  for (const { abs, rel } of files) {
    count += 1;
    if (count > limits.enumerationFileSanityMax) {
      // Enumeration blowup → fail closed (mapped to aggregate_limit — the closest of the
      // four fixed reasons; an over-budget total of enumerable work), never silent-truncated.
      readErrors.push({ path: rel, digest: null, reason: "aggregate_limit" });
      continue;
    }
    try {
      enumerated.push({ path: rel, digest: hashFileStreaming(abs) });
    } catch {
      readErrors.push({ path: rel, digest: null, reason: "read_error" });
    }
  }
  return { enumerated, readErrors };
}

/**
 * Pass B — DEEP INSPECTION (bounded). Walks the enumerated (sorted) `dist/` paths and
 * token-scans each one UNDER the layered budget. Any path it cannot deep-inspect is
 * marked `unobserved` (≠ clean) with the precise reason:
 *   - `watchdog`       — the wall-clock safety net fired (operational safety only).
 *   - `file_limit`     — the file exceeds the per-file deep-inspect ceiling.
 *   - `aggregate_limit`— the aggregate deep-inspect budget is exhausted (this + remainder).
 *   - `read_error`     — the file errored on `stat`/read at deep-inspect time.
 * NO silent `continue` on any path — the exact opposite of the retired `sim.ts:484`.
 */
function deepInspect(
  paths: ProjectPaths,
  enumerated: EnumeratedPath[],
  limits: ScanLimits,
  opts: ScanOptions,
): { distHits: ScanHit[]; deepInspected: string[]; unobserved: UnobservedPath[]; limitHit: boolean } {
  const distHits: ScanHit[] = [];
  const deepInspected: string[] = [];
  const unobserved: UnobservedPath[] = [];
  let aggregateBytes = 0;
  let limitHit = false;

  // Effective elapsed = real elapsed + injected synthetic latency. The synthetic term is
  // ZERO in production (no `deepInspectDelayMs`), so the watchdog is pure wall-clock there
  // and, set far above the sub-second normal scan, never fires. The test seam advances the
  // synthetic term per deep-inspected file to trip the watchdog DETERMINISTICALLY (b2).
  const clockNow = opts.now ?? Date.now;
  const start = clockNow();
  const delay = opts.deepInspectDelayMs ?? 0;
  let synthetic = 0;
  const elapsed = (): number => clockNow() - start + synthetic;

  for (let i = 0; i < enumerated.length; i++) {
    const e = enumerated[i]!;
    if (elapsed() >= limits.watchdogMs) {
      // Watchdog fired — this and every remaining file are unobserved (safety, fail-closed).
      for (let j = i; j < enumerated.length; j++) unobserved.push({ ...enumerated[j]!, reason: "watchdog" });
      limitHit = true;
      break;
    }
    const abs = resolveWithinRoot(paths.root, e.path);
    if (abs === null) {
      unobserved.push({ ...e, reason: "read_error" });
      limitHit = true;
      continue;
    }
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      unobserved.push({ ...e, reason: "read_error" });
      limitHit = true;
      continue;
    }
    if (size > limits.deepInspectFileMaxBytes) {
      unobserved.push({ ...e, reason: "file_limit" });
      limitHit = true;
      continue;
    }
    if (aggregateBytes + size > limits.deepInspectAggregateMaxBytes) {
      // Aggregate budget exhausted — this and every remaining file are unobserved.
      for (let j = i; j < enumerated.length; j++) unobserved.push({ ...enumerated[j]!, reason: "aggregate_limit" });
      limitHit = true;
      break;
    }
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      unobserved.push({ ...e, reason: "read_error" });
      limitHit = true;
      continue;
    }
    aggregateBytes += size;
    synthetic += delay; // test-only: account the synthetic per-file deep-inspect cost
    deepInspected.push(e.path);
    collectHits(e.path, content, distHits);
  }
  return { distHits, deepInspected, unobserved, limitHit };
}

/**
 * The advisory `tests/` walk (OQ#1 scope): `tests/` hits are reported separately and
 * are NEVER `unobserved`-gating (mocks/fixtures are legitimate inside tests). Bounded by
 * the per-file ceiling (an oversize test file is simply skipped — advisory, not a
 * coverage gap) so a pathological tree cannot blow up. No streaming hash, no enumeration
 * coverage — only the `dist/` tree carries the fail-closed completeness property.
 */
function scanTestsAdvisory(paths: ProjectPaths, limits: ScanLimits): ScanHit[] {
  const absTop = resolveWithinRoot(paths.root, "tests");
  const testHits: ScanHit[] = [];
  if (!absTop || !fs.existsSync(absTop)) return testHits;
  for (const abs of walkFiles(absTop).files) {
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      continue; // advisory: an unreadable test file is skipped, never a gating gap
    }
    if (size > limits.deepInspectFileMaxBytes) continue; // advisory: oversize test file skipped
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    collectHits(relPath(paths.root, abs), content, testHits);
  }
  return testHits;
}

/**
 * The shared two-tier scan core (consumed by `th sim scan` AND the gate's 4th
 * condition). Enumeration (Pass A) ALWAYS runs over every `dist/` path and streaming-
 * content-hashes it; deep inspection (Pass B) is bounded by the layered budget and
 * marks any un-deep-inspectable path `unobserved` (≠ clean). The returned
 * {@link ScanCoverage} is the fail-closed coverage signal the gate recomputes each run.
 * `tests/` stays advisory (`testHits`, never coverage-gating — OQ#1).
 */
export function scanForSimulationHits(paths: ProjectPaths, opts: ScanOptions = {}): ScanCoverage {
  // Precedence: explicit opts.limits (tests) > env override (ops/negative-controls) > defaults.
  const limits: ScanLimits = { ...DEFAULT_SCAN_LIMITS, ...envScanLimitOverrides(), ...(opts.limits ?? {}) };
  const { enumerated, readErrors } = enumerateAndHash(paths, limits);
  const inspected = deepInspect(paths, enumerated, limits, opts);
  // Pass-A read errors (digest could not be computed at all) are unobserved too, and are
  // EXCLUDED from the deep-inspect pass (they are not in `enumerated`). Merge + sort so the
  // descriptor's `unobserved` set is deterministic and complete.
  const unobserved = [...readErrors, ...inspected.unobserved].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    enumerated,
    deepInspected: inspected.deepInspected,
    distHits: inspected.distHits,
    testHits: scanTestsAdvisory(paths, limits),
    unobserved,
    limitHit: inspected.limitHit || readErrors.length > 0,
  };
}

/**
 * BSC-6 (slice-2) — the coverage RESIDUAL: the `unobserved` `dist/` paths that are NOT
 * exonerated by a valid external-signed exception ack. SINGLE source of truth shared by
 * `th sim scan` (the human surface) AND the gate's condition-4 recompute, so the two can
 * never disagree about which coverage gaps still block. A path with a `null` digest (the
 * digest itself could not be computed) can never be matched by a `(path, digest)`-scoped
 * ack, so it always remains uncovered (fail-closed). Only a `status:"accepted"` ack —
 * an Ed25519-verified, path-and-current-digest match — subtracts a file.
 */
export function uncoveredAfterExceptions(paths: ProjectPaths, unobserved: UnobservedPath[]): UnobservedPath[] {
  return unobserved.filter((u) => {
    if (u.digest === null) return true; // unscannable digest ⇒ no ack can scope it ⇒ stays uncovered
    return readScanExceptionValidated(paths, u.path, u.digest).status !== "accepted";
  });
}

/**
 * The ACTIVE simulated entries — the only ones that can DECLARE a dist hit. `Real`/
 * `Sandbox` are reality (never simulate) and a `retired` entry has been replaced, so
 * neither can cover a live dist simulation.
 */
function activeSimulatedEntries(entries: SimulationEntry[]): SimulationEntry[] {
  return entries.filter((e) => e.status !== "retired" && isSimulatedClassification(e.classification));
}

/**
 * Does some active simulated entry DECLARE this specific dist hit? PER-DEPENDENCY join
 * (audit P1 — NOT global existence): a single unrelated ledger entry must not blanket-
 * cover every dist hit. An entry covers a hit only when it NAMES a non-empty dependency
 * (`replaces`) that appears, case-insensitively, in the hit's file path OR matched
 * source line. An entry that declares no dependency (`replaces` empty) cannot scope-
 * cover anything, so it never suppresses an undeclared stub.
 */
export function distHitLedgered(hit: ScanHit, active: SimulationEntry[]): boolean {
  const hay = `${hit.file}\n${hit.text}`.toLowerCase();
  for (const e of active) {
    const dep = e.replaces.trim().toLowerCase();
    if (dep.length > 0 && hay.includes(dep)) return true;
  }
  return false;
}

/**
 * The dist hits that are UNLEDGERED — i.e. not declared by any active simulated entry
 * (per-dependency, via {@link distHitLedgered}). SINGLE source of truth shared by
 * `th sim scan` and the production-reality gate's 4th condition so they can never
 * disagree about which hits count as undeclared.
 */
export function computeUnledgeredDistHits(entries: SimulationEntry[], distHits: ScanHit[]): ScanHit[] {
  const active = activeSimulatedEntries(entries);
  if (active.length === 0) return distHits.slice();
  return distHits.filter((h) => !distHitLedgered(h, active));
}

// ---------------------------------------------------------------------------
// Receipt-aware "no double-exoneration" join (Axis-B slice-1a / BSC-4, control d)
// ---------------------------------------------------------------------------

/**
 * Is a retirement GROUNDED? A retired entry counts as genuinely retired ONLY when a
 * `valid` or `legacy` (grandfathered) `sim-retire` receipt backs it. A non-retired
 * entry is vacuously grounded (it has not claimed reality yet). This is the
 * receipt-aware refinement of "retired": a receipt-less retire (the `--emergency` /
 * attestation bypass) is NOT grounded, so it must not exonerate the entry.
 */
function retirementGrounded(paths: ProjectPaths, entry: SimulationEntry): boolean {
  if (entry.status !== "retired") return true;
  const s = readReceiptValidated(paths, "sim-retire", entry.id).status;
  // Slice-1b: a grounded external `sim-retire` (`valid-grounded`) also exonerates,
  // alongside an in-process attested (`valid`) or grandfathered (`legacy`) one. A
  // `forged` external claim does NOT — it is not grounded, so the entry still blocks.
  return s === "valid" || s === "valid-grounded" || s === "legacy";
}

/**
 * Rung-1 receipt-aware blocker (control d — no double-exoneration). A user-visible
 * simulation blocks production-reality completion when it is active (the existing
 * {@link blocksProductionReality} rule), AND ALSO when it is retired but its
 * retirement is NOT grounded by a receipt — a receipt-less retire cannot clear the
 * gate. `Real`/`Sandbox` and non-user-visible entries never block.
 */
export function simEntryBlocksProductionReality(paths: ProjectPaths, entry: SimulationEntry): boolean {
  if (!entry.userVisible || !isSimulatedClassification(entry.classification)) return false;
  if (entry.status !== "retired") return true; // active user-visible simulation blocks
  return !retirementGrounded(paths, entry); // retired-but-ungrounded still blocks
}

/**
 * The dist-scan coverage set, receipt-aware: simulated entries that are active OR
 * retired-but-ungrounded (control d). A receipt-less retire stays in the coverage set
 * — its declared dependency keeps covering the corresponding dist hit, so the
 * exoneration cannot disappear a live simulation from the scan. `Real`/`Sandbox` are
 * reality and never simulate.
 */
export function activeOrUngroundedSimulatedEntries(paths: ProjectPaths, entries: SimulationEntry[]): SimulationEntry[] {
  return entries.filter(
    (e) => isSimulatedClassification(e.classification) && (e.status !== "retired" || !retirementGrounded(paths, e)),
  );
}

/**
 * Receipt-aware unledgered-dist-hit join — mirrors {@link computeUnledgeredDistHits}
 * but uses the receipt-aware coverage set {@link activeOrUngroundedSimulatedEntries}
 * so a receipt-less retire does not drop its dependency from coverage. Empty coverage
 * set → every dist hit is unledgered (same posture as the non-receipt-aware join).
 */
export function computeUnledgeredDistHitsReceiptAware(
  paths: ProjectPaths,
  entries: SimulationEntry[],
  distHits: ScanHit[],
): ScanHit[] {
  const active = activeOrUngroundedSimulatedEntries(paths, entries);
  if (active.length === 0) return distHits.slice();
  return distHits.filter((h) => !distHitLedgered(h, active));
}

/** Shared corrupt-ledger failure (fail CLOSED, stable token). */
function ledgerCorruptFailure(e: unknown): CommandResult {
  if (e instanceof SimulationLedgerCorruptError) {
    return failure({
      human: `simulation-ledger.json is corrupt (${e.message}); refusing to operate on an unreadable ledger. Inspect \`.twinharness/simulation-ledger.json\`.`,
      data: { error: "simulation_ledger_corrupt" },
    });
  }
  throw e;
}

export type { SimulationEntry, SimulationClassification };
