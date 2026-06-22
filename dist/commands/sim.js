"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SCAN_LIMITS = exports.SimulationLedgerCorruptError = void 0;
exports.simulationLedgerPath = simulationLedgerPath;
exports.readSimulationLedger = readSimulationLedger;
exports.runSimAdd = runSimAdd;
exports.runSimList = runSimList;
exports.runSimRetire = runSimRetire;
exports.runSimScan = runSimScan;
exports.scanForSimulationHits = scanForSimulationHits;
exports.uncoveredAfterExceptions = uncoveredAfterExceptions;
exports.distHitLedgered = distHitLedgered;
exports.computeUnledgeredDistHits = computeUnledgeredDistHits;
exports.simEntryBlocksProductionReality = simEntryBlocksProductionReality;
exports.activeOrUngroundedSimulatedEntries = activeOrUngroundedSimulatedEntries;
exports.computeUnledgeredDistHitsReceiptAware = computeUnledgeredDistHitsReceiptAware;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("../core/paths");
const output_1 = require("../core/output");
const atomic_io_1 = require("../core/atomic-io");
const state_store_1 = require("../core/state-store");
const log_1 = require("../core/log");
const ledger_1 = require("../core/ledger");
const guards_1 = require("../core/guards");
const state_store_2 = require("../core/state-store");
const simulation_1 = require("../core/simulation");
const receipts_1 = require("../core/receipts");
const hash_1 = require("../core/hash");
const scan_completeness_1 = require("../core/scan-completeness");
/** `<stateDir>/simulation-ledger.json` — the append-only ledger file. */
function simulationLedgerPath(paths) {
    return path.join(paths.stateDir, "simulation-ledger.json");
}
/**
 * Read the ledger, returning [] when absent. A present-but-corrupt ledger throws a
 * typed marker so the caller fails CLOSED rather than silently treating a tampered
 * ledger as empty (which would let the gate pass on an unreadable simulation
 * inventory — the same fail-open the verify-config gate already refuses).
 */
class SimulationLedgerCorruptError extends Error {
    code = "simulation_ledger_corrupt";
}
exports.SimulationLedgerCorruptError = SimulationLedgerCorruptError;
function readSimulationLedger(paths) {
    const file = simulationLedgerPath(paths);
    if (!fs.existsSync(file))
        return [];
    let raw;
    try {
        raw = (0, atomic_io_1.readFileWithRetry)(file);
    }
    catch {
        return [];
    }
    if (raw.trim() === "")
        return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
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
    const entries = [];
    for (const row of parsed) {
        if (typeof row !== "object" || row === null) {
            throw new SimulationLedgerCorruptError("simulation-ledger.json contains a non-object entry");
        }
        const r = row;
        if (typeof r.id !== "string" || r.id.trim() === "") {
            throw new SimulationLedgerCorruptError("a simulation entry has a missing/invalid id");
        }
        const classification = (0, simulation_1.asClassification)(typeof r.classification === "string" ? r.classification : undefined);
        if (!classification) {
            throw new SimulationLedgerCorruptError(`simulation entry ${r.id} has a missing/invalid classification`);
        }
        if (typeof r.userVisible !== "boolean") {
            throw new SimulationLedgerCorruptError(`simulation entry ${r.id} has a missing/invalid userVisible flag`);
        }
        // status: absent ⇒ "active" (fail-CLOSED — an entry with no status still blocks);
        // present-but-invalid ⇒ corrupt (a tampered status must not be silently coerced).
        let status;
        if (r.status === undefined) {
            status = "active";
        }
        else {
            const s = (0, simulation_1.asStatus)(typeof r.status === "string" ? r.status : undefined);
            if (!s)
                throw new SimulationLedgerCorruptError(`simulation entry ${r.id} has an invalid status`);
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
function writeSimulationLedger(paths, entries) {
    (0, atomic_io_1.atomicWriteFile)(simulationLedgerPath(paths), JSON.stringify(entries, null, 2) + "\n", { root: paths.root });
}
/**
 * `th sim add --classification <C> [--replaces ...] [--intro-slice ...] [--retire-slice ...] [--owner ...] [--user-visible]`
 * Mint the next SIM id, append an `active` entry. `--classification` is required and
 * must be a known taxonomy value. A `--user-visible` entry of a SIMULATED
 * classification is exactly what the production-reality gate later blocks on, so the
 * human output flags that explicitly.
 */
function runSimAdd(paths, opts) {
    return (0, state_store_1.withStateLock)(paths, () => runSimAddLocked(paths, opts));
}
function runSimAddLocked(paths, opts) {
    const classification = (0, simulation_1.asClassification)(opts.classification);
    if (!classification) {
        return (0, output_1.failure)({
            human: `usage: th sim add --classification <${simulation_1.SIMULATION_CLASSIFICATIONS.join("|")}> [--replaces ...] [--intro-slice ...] [--retire-slice ...] [--owner ...] [--user-visible]`,
            data: { error: "invalid_classification", classification: opts.classification ?? null, valid: simulation_1.SIMULATION_CLASSIFICATIONS },
        });
    }
    const r = (0, state_store_2.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({ human: "state.json is invalid; fix it before adding a simulation entry.", data: { error: "invalid_state", issues: r.issues } });
    }
    let entries;
    try {
        entries = readSimulationLedger(paths);
    }
    catch (e) {
        return ledgerCorruptFailure(e);
    }
    const id = (0, simulation_1.nextSimulationId)(entries);
    const entry = {
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
    const blocks = (0, simulation_1.blocksProductionReality)(entry);
    // Audit ledger (mirrors drift): adding a user-visible simulation opens a gate.
    (0, ledger_1.appendLedger)(paths, { event: "simulation-added", id, classification, userVisible: entry.userVisible, blocks });
    (0, log_1.structuredLog)({ cmd: "sim add", id, classification, userVisible: entry.userVisible, blocks });
    return (0, output_1.success)({
        data: { id, entry, blocks },
        human: blocks
            ? `${id} logged (${classification}, user-visible). This BLOCKS production-reality completion until retired (\`th sim retire ${id}\`).`
            : `${id} logged (${classification}${entry.userVisible ? ", user-visible" : ""}).`,
    });
}
/** `th sim list` — every entry + the count of non-retired user-visible blockers. */
function runSimList(paths, _opts = {}) {
    const r = (0, state_store_2.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    let entries;
    try {
        entries = readSimulationLedger(paths);
    }
    catch (e) {
        return ledgerCorruptFailure(e);
    }
    const blocking = entries.filter(simulation_1.blocksProductionReality);
    const human = entries.length
        ? entries
            .map((e) => `${e.id}  ${e.classification.padEnd(9)} ${e.status.padEnd(7)} ${e.userVisible ? "[user-visible]" : "             "}${(0, simulation_1.blocksProductionReality)(e) ? " [BLOCKS]" : ""}  replaces: ${e.replaces || "-"}`)
            .join("\n")
        : "(no simulation entries)";
    (0, log_1.structuredLog)({ cmd: "sim list", entries: entries.length, blocking: blocking.length });
    return (0, output_1.success)({
        data: { entries, blocking: blocking.map((e) => e.id) },
        human,
    });
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
function runSimRetire(paths, id, opts = {}) {
    return (0, state_store_1.withStateLock)(paths, () => runSimRetireLocked(paths, id, opts));
}
function runSimRetireLocked(paths, id, opts) {
    if (!id)
        return (0, output_1.failure)({ human: "usage: th sim retire <SIM-NNN> [--retire-slice ...] [--target <path>]" });
    const r = (0, state_store_2.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({ human: "state.json is invalid; fix it before retiring a simulation entry.", data: { error: "invalid_state", issues: r.issues } });
    }
    let entries;
    try {
        entries = readSimulationLedger(paths);
    }
    catch (e) {
        return ledgerCorruptFailure(e);
    }
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) {
        return (0, output_1.failure)({
            human: `Simulation entry not found: ${id}. Known: ${entries.map((e) => e.id).join(", ") || "(none)"}`,
            data: { error: "simulation_not_found", id },
        });
    }
    const entry = entries[idx];
    if (entry.status === "retired") {
        return (0, output_1.failure)({ human: `${id} is already retired.`, data: { error: "already_retired", id } });
    }
    // Axis-B slice-1a (BSC-4) grounding. A BLOCKING retire (user-visible + active +
    // simulated) must mint a grounded `sim-retire` receipt BEFORE the flip; a failed
    // mint must leave the entry active (no partial flip). Run the migration FIRST so the
    // entity is not yet terminal/grandfathered when the new producer code runs and it
    // gets a REAL receipt rather than being implicitly grandfathered. Idempotent; the
    // caller holds the state lock.
    if ((0, simulation_1.blocksProductionReality)(entry)) {
        (0, receipts_1.ensureReceiptMigration)(paths);
        if (opts.target === undefined || opts.target === "") {
            return (0, output_1.failure)({
                human: "th sim retire <id> --target <path> is required for a user-visible simulation",
                data: { error: "sim_retire_target_required", id },
            });
        }
        try {
            (0, receipts_1.appendTerminalReceipt)(paths, {
                kind: "sim-retire",
                refId: id,
                targetPath: opts.target,
                producerIdentity: "cli:th sim retire",
            });
        }
        catch (e) {
            if (e instanceof receipts_1.TargetUnresolvedError) {
                return (0, output_1.failure)({
                    human: `Refusing to retire ${id}: target "${opts.target}" does not resolve in source.`,
                    data: { error: e.code, id, target: e.target },
                });
            }
            throw e;
        }
    }
    const updated = {
        ...entry,
        status: "retired",
        retireSlice: opts.retireSlice ?? entry.retireSlice,
    };
    const next = entries.slice();
    next[idx] = updated;
    writeSimulationLedger(paths, next);
    (0, ledger_1.appendLedger)(paths, { event: "simulation-retired", id, classification: entry.classification });
    (0, log_1.structuredLog)({ cmd: "sim retire", id, classification: entry.classification });
    return (0, output_1.success)({
        data: { id, entry: updated },
        human: `${id} retired (${entry.classification}).`,
    });
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
/** Default layered budget (production values). */
exports.DEFAULT_SCAN_LIMITS = {
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
function envScanLimitOverrides() {
    const out = {};
    const num = (v) => {
        if (v === undefined || v === "")
            return undefined;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const f = num(process.env.TH_SCAN_FILE_MAX_BYTES);
    if (f !== undefined)
        out.deepInspectFileMaxBytes = f;
    const a = num(process.env.TH_SCAN_AGGREGATE_MAX_BYTES);
    if (a !== undefined)
        out.deepInspectAggregateMaxBytes = a;
    const w = num(process.env.TH_SCAN_WATCHDOG_MS);
    if (w !== undefined)
        out.watchdogMs = w;
    return out;
}
/** Lowercase token-presence map so "stub" matches "Stubbed" etc., case-insensitively. */
const SCAN_TOKENS_LC = simulation_1.SIMULATION_SCAN_TOKENS.map((t) => t.toLowerCase());
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
function runSimScan(paths, _opts = {}) {
    const r = (0, state_store_2.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    let entries;
    try {
        entries = readSimulationLedger(paths);
    }
    catch (e) {
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
            (0, state_store_1.withStateLock)(paths, () => (0, scan_completeness_1.appendScanCompletenessReceipt)(paths, uncovered));
        }
        catch {
            /* advisory surface — recording the audit receipt is best-effort; the gate recomputes + blocks */
        }
    }
    (0, log_1.structuredLog)({
        cmd: "sim scan",
        distHits: coverage.distHits.length,
        testHits: coverage.testHits.length,
        unledgered: unledgeredDistHits.length,
        enumerated: coverage.enumerated.length,
        unobserved: uncovered.length,
        limitHit: coverage.limitHit,
    });
    const hitsLine = unledgeredDistHits.length > 0
        ? `Found ${unledgeredDistHits.length} UNLEDGERED simulation pattern(s) in dist/ (declare them with \`th sim add\` or remove them):\n` +
            unledgeredDistHits.slice(0, 50).map((h) => `  ${h.file}:${h.line}  [${h.token}]`).join("\n")
        : coverage.distHits.length > 0
            ? `Found ${coverage.distHits.length} simulation pattern(s) in dist/, all covered by active ledger entries.`
            : "No simulation patterns found in dist/.";
    const coverageLine = uncovered.length > 0
        ? `\nSCAN COVERAGE INCOMPLETE — ${uncovered.length} dist/ file(s) could not be deep-inspected (the gate BLOCKS on these):\n` +
            uncovered.slice(0, 50).map((u) => `  ${u.path}  [${u.reason}]`).join("\n")
        : "";
    const human = hitsLine + coverageLine;
    return (0, output_1.success)({
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
function relPath(root, abs) {
    return path.relative(root, abs).split(path.sep).join("/");
}
/** Collect simulation-token hits from one file's text into `sink` (one hit per line). */
function collectHits(rel, content, sink) {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const lc = lines[i].toLowerCase();
        for (let t = 0; t < SCAN_TOKENS_LC.length; t++) {
            if (lc.includes(SCAN_TOKENS_LC[t])) {
                sink.push({ file: rel, line: i + 1, token: simulation_1.SIMULATION_SCAN_TOKENS[t], text: lines[i].trim().slice(0, SCAN_HIT_TEXT_MAX) });
                break; // one hit per line is enough to flag it.
            }
        }
    }
}
/** Recursively list every relevant (scan-extension) file under `absTop`, as absolute paths. */
function walkFiles(absTop) {
    const files = [];
    const dirReadErrors = [];
    const stack = [absTop];
    while (stack.length > 0) {
        const dir = stack.pop();
        let dirents;
        try {
            dirents = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            // Dist traversal errors are coverage gaps, not "clean". The advisory tests/ caller
            // ignores these; enumerateAndHash turns them into unobserved{read_error}.
            dirReadErrors.push(dir);
            continue;
        }
        for (const d of dirents) {
            if (d.isDirectory()) {
                if (!SCAN_SKIP_DIRS.has(d.name))
                    stack.push(path.join(dir, d.name));
                continue;
            }
            if (!d.isFile())
                continue;
            if (!SCAN_EXTENSIONS.has(path.extname(d.name)))
                continue;
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
function enumerateAndHash(paths, limits) {
    const absTop = (0, paths_1.resolveWithinRoot)(paths.root, "dist");
    const enumerated = [];
    const readErrors = [];
    if (!absTop || !fs.existsSync(absTop))
        return { enumerated, readErrors };
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
            enumerated.push({ path: rel, digest: (0, hash_1.hashFileStreaming)(abs) });
        }
        catch {
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
function deepInspect(paths, enumerated, limits, opts) {
    const distHits = [];
    const deepInspected = [];
    const unobserved = [];
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
    const elapsed = () => clockNow() - start + synthetic;
    for (let i = 0; i < enumerated.length; i++) {
        const e = enumerated[i];
        if (elapsed() >= limits.watchdogMs) {
            // Watchdog fired — this and every remaining file are unobserved (safety, fail-closed).
            for (let j = i; j < enumerated.length; j++)
                unobserved.push({ ...enumerated[j], reason: "watchdog" });
            limitHit = true;
            break;
        }
        const abs = (0, paths_1.resolveWithinRoot)(paths.root, e.path);
        if (abs === null) {
            unobserved.push({ ...e, reason: "read_error" });
            limitHit = true;
            continue;
        }
        let size = 0;
        try {
            size = fs.statSync(abs).size;
        }
        catch {
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
            for (let j = i; j < enumerated.length; j++)
                unobserved.push({ ...enumerated[j], reason: "aggregate_limit" });
            limitHit = true;
            break;
        }
        let content;
        try {
            content = fs.readFileSync(abs, "utf8");
        }
        catch {
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
function scanTestsAdvisory(paths, limits) {
    const absTop = (0, paths_1.resolveWithinRoot)(paths.root, "tests");
    const testHits = [];
    if (!absTop || !fs.existsSync(absTop))
        return testHits;
    for (const abs of walkFiles(absTop).files) {
        let size = 0;
        try {
            size = fs.statSync(abs).size;
        }
        catch {
            continue; // advisory: an unreadable test file is skipped, never a gating gap
        }
        if (size > limits.deepInspectFileMaxBytes)
            continue; // advisory: oversize test file skipped
        let content;
        try {
            content = fs.readFileSync(abs, "utf8");
        }
        catch {
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
function scanForSimulationHits(paths, opts = {}) {
    // Precedence: explicit opts.limits (tests) > env override (ops/negative-controls) > defaults.
    const limits = { ...exports.DEFAULT_SCAN_LIMITS, ...envScanLimitOverrides(), ...(opts.limits ?? {}) };
    const { enumerated, readErrors } = enumerateAndHash(paths, limits);
    const inspected = deepInspect(paths, enumerated, limits, opts);
    // Pass-A read errors (digest could not be computed at all) are unobserved too, and are
    // EXCLUDED from the deep-inspect pass (they are not in `enumerated`). Merge + sort so the
    // descriptor's `unobserved` set is deterministic and complete.
    const unobserved = [...readErrors, ...inspected.unobserved].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
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
function uncoveredAfterExceptions(paths, unobserved) {
    return unobserved.filter((u) => {
        if (u.digest === null)
            return true; // unscannable digest ⇒ no ack can scope it ⇒ stays uncovered
        return (0, scan_completeness_1.readScanExceptionValidated)(paths, u.path, u.digest).status !== "accepted";
    });
}
/**
 * The ACTIVE simulated entries — the only ones that can DECLARE a dist hit. `Real`/
 * `Sandbox` are reality (never simulate) and a `retired` entry has been replaced, so
 * neither can cover a live dist simulation.
 */
function activeSimulatedEntries(entries) {
    return entries.filter((e) => e.status !== "retired" && (0, simulation_1.isSimulatedClassification)(e.classification));
}
/**
 * Does some active simulated entry DECLARE this specific dist hit? PER-DEPENDENCY join
 * (audit P1 — NOT global existence): a single unrelated ledger entry must not blanket-
 * cover every dist hit. An entry covers a hit only when it NAMES a non-empty dependency
 * (`replaces`) that appears, case-insensitively, in the hit's file path OR matched
 * source line. An entry that declares no dependency (`replaces` empty) cannot scope-
 * cover anything, so it never suppresses an undeclared stub.
 */
function distHitLedgered(hit, active) {
    const hay = `${hit.file}\n${hit.text}`.toLowerCase();
    for (const e of active) {
        const dep = e.replaces.trim().toLowerCase();
        if (dep.length > 0 && hay.includes(dep))
            return true;
    }
    return false;
}
/**
 * The dist hits that are UNLEDGERED — i.e. not declared by any active simulated entry
 * (per-dependency, via {@link distHitLedgered}). SINGLE source of truth shared by
 * `th sim scan` and the production-reality gate's 4th condition so they can never
 * disagree about which hits count as undeclared.
 */
function computeUnledgeredDistHits(entries, distHits) {
    const active = activeSimulatedEntries(entries);
    if (active.length === 0)
        return distHits.slice();
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
function retirementGrounded(paths, entry) {
    if (entry.status !== "retired")
        return true;
    const s = (0, receipts_1.readReceiptValidated)(paths, "sim-retire", entry.id).status;
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
function simEntryBlocksProductionReality(paths, entry) {
    if (!entry.userVisible || !(0, simulation_1.isSimulatedClassification)(entry.classification))
        return false;
    if (entry.status !== "retired")
        return true; // active user-visible simulation blocks
    return !retirementGrounded(paths, entry); // retired-but-ungrounded still blocks
}
/**
 * The dist-scan coverage set, receipt-aware: simulated entries that are active OR
 * retired-but-ungrounded (control d). A receipt-less retire stays in the coverage set
 * — its declared dependency keeps covering the corresponding dist hit, so the
 * exoneration cannot disappear a live simulation from the scan. `Real`/`Sandbox` are
 * reality and never simulate.
 */
function activeOrUngroundedSimulatedEntries(paths, entries) {
    return entries.filter((e) => (0, simulation_1.isSimulatedClassification)(e.classification) && (e.status !== "retired" || !retirementGrounded(paths, e)));
}
/**
 * Receipt-aware unledgered-dist-hit join — mirrors {@link computeUnledgeredDistHits}
 * but uses the receipt-aware coverage set {@link activeOrUngroundedSimulatedEntries}
 * so a receipt-less retire does not drop its dependency from coverage. Empty coverage
 * set → every dist hit is unledgered (same posture as the non-receipt-aware join).
 */
function computeUnledgeredDistHitsReceiptAware(paths, entries, distHits) {
    const active = activeOrUngroundedSimulatedEntries(paths, entries);
    if (active.length === 0)
        return distHits.slice();
    return distHits.filter((h) => !distHitLedgered(h, active));
}
/** Shared corrupt-ledger failure (fail CLOSED, stable token). */
function ledgerCorruptFailure(e) {
    if (e instanceof SimulationLedgerCorruptError) {
        return (0, output_1.failure)({
            human: `simulation-ledger.json is corrupt (${e.message}); refusing to operate on an unreadable ledger. Inspect \`.twinharness/simulation-ledger.json\`.`,
            data: { error: "simulation_ledger_corrupt" },
        });
    }
    throw e;
}
