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

// Bounded walk caps (mirror the repo scanner's defensive posture without reusing
// scanRepo, which EXCLUDES dist/ — exactly the tree we must scan here).
const SCAN_MAX_FILES = 5_000;
const SCAN_MAX_BYTES = 16 * 1024 * 1024; // 16 MB
const SCAN_FILE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB — oversize files are skipped.
const SCAN_DIRS = ["dist", "tests"] as const;
const SCAN_EXTENSIONS = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"]);
const SCAN_SKIP_DIRS = new Set(["node_modules", ".git"]);

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

  const result = scanForSimulationHits(paths);
  // A dist hit is "ledgered" only when an ACTIVE (or retired-but-ungrounded) simulation
  // entry DECLARES that specific hit — matched per-dependency, NOT by global existence
  // (audit P1). The receipt-aware join (BSC-4, control d) also keeps a receipt-less
  // retire's dependency in coverage. The gate's 4th condition reuses the SAME
  // `computeUnledgeredDistHitsReceiptAware` join, so scan and gate agree.
  const unledgeredDistHits = computeUnledgeredDistHitsReceiptAware(paths, entries, result.distHits);

  structuredLog({
    cmd: "sim scan",
    distHits: result.distHits.length,
    testHits: result.testHits.length,
    unledgered: unledgeredDistHits.length,
    capHit: result.capHit,
  });

  const human =
    unledgeredDistHits.length > 0
      ? `Found ${unledgeredDistHits.length} UNLEDGERED simulation pattern(s) in dist/ (declare them with \`th sim add\` or remove them):\n` +
        unledgeredDistHits.slice(0, 50).map((h) => `  ${h.file}:${h.line}  [${h.token}]`).join("\n")
      : result.distHits.length > 0
        ? `Found ${result.distHits.length} simulation pattern(s) in dist/, all covered by active ledger entries.`
        : "No simulation patterns found in dist/.";

  return success({
    data: {
      distHits: result.distHits,
      testHits: result.testHits,
      unledgeredDistHits,
      capHit: result.capHit,
    },
    human,
  });
}

/**
 * The shared scan core (consumed by `th sim scan` AND the gate's 4th condition):
 * bounded recursive walk of `dist/` + `tests/`, returning every token hit per tree.
 * Caps mirror the repo scanner's envelope so a pathological tree can never blow up.
 */
export function scanForSimulationHits(paths: ProjectPaths): {
  distHits: ScanHit[];
  testHits: ScanHit[];
  capHit: boolean;
} {
  const distHits: ScanHit[] = [];
  const testHits: ScanHit[] = [];
  let filesSeen = 0;
  let bytesSeen = 0;
  let capHit = false;

  for (const top of SCAN_DIRS) {
    const absTop = resolveWithinRoot(paths.root, top);
    if (!absTop || !fs.existsSync(absTop)) continue;
    const sink = top === "dist" ? distHits : testHits;
    const stack: string[] = [absTop];
    while (stack.length > 0) {
      if (capHit) break;
      const dir = stack.pop()!;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        if (capHit) break;
        if (d.isDirectory()) {
          if (SCAN_SKIP_DIRS.has(d.name)) continue;
          stack.push(path.join(dir, d.name));
          continue;
        }
        if (!d.isFile()) continue;
        if (!SCAN_EXTENSIONS.has(path.extname(d.name))) continue;
        if (filesSeen >= SCAN_MAX_FILES || bytesSeen >= SCAN_MAX_BYTES) {
          capHit = true;
          break;
        }
        const abs = path.join(dir, d.name);
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        if (size > SCAN_FILE_MAX_BYTES) continue;
        filesSeen += 1;
        bytesSeen += size;
        let content: string;
        try {
          content = fs.readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        const rel = path.relative(paths.root, abs).split(path.sep).join("/");
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
    }
  }
  return { distHits, testHits, capHit };
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
  return s === "valid" || s === "legacy";
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
