"use strict";
/**
 * Production-reality taxonomy + simulation-ledger primitives (SG3 P2-C, audit
 * C-05..C-08). The classification enum names every way a user-visible production
 * path can be standing in for the real thing, ordered from "is the real thing" to
 * "fixed demo data". The ledger that TRACKS these entries lives in a SEPARATE
 * append-only file (`.twinharness/simulation-ledger.json`) — NOT `state.json` — so
 * an in-flight run's reality posture is auditable history, not a mutable scalar.
 *
 * This module is PURE parse/format/classify (no IO). The IO (read/append/retire)
 * lives in `src/commands/sim.ts`, mirroring the drift-log / decisions split where
 * the ledger SHAPE is here and the chokepoint-governed writes are in the command.
 *
 * Required invariant (audit Part 5): mocks may exist in tests; emulators only with
 * explicit approval + a named real-provider replacement plan; stubs/hardcoded only
 * inside an explicitly labeled prototype or Slice 0. A FEATURE MUST NOT BE MARKED
 * COMPLETE WHILE ITS USER-VISIBLE PRODUCTION PATH DEPENDS ON UNRESOLVED SIMULATED
 * BEHAVIOR. The production-reality gate (`gate-preconditions.ts`) enforces the last
 * clause mechanically; this module supplies the classification + the predicate
 * (`blocksProductionReality`) it reads.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SIMULATION_SCAN_TOKENS = exports.SIMULATION_STATUSES = exports.SIMULATION_CLASSIFICATIONS = void 0;
exports.asClassification = asClassification;
exports.asStatus = asStatus;
exports.isSimulatedClassification = isSimulatedClassification;
exports.blocksProductionReality = blocksProductionReality;
exports.nextSimulationId = nextSimulationId;
/**
 * How a code path stands in (or does not) for the real production dependency.
 * Ordered most-real → least-real (the array order IS the severity order):
 *  - `Real`      — live provider (production or the official sandbox/prod tier).
 *  - `Sandbox`   — the real provider in its official test environment.
 *  - `Emulated`  — a local substitute reproducing behavior, explicitly approved.
 *  - `Mocked`    — a controlled test replacement (legitimate INSIDE tests).
 *  - `Stubbed`   — an incomplete placeholder (Slice-0 / labeled-prototype only).
 *  - `Hardcoded` — fixed demo data (Slice-0 / labeled-prototype only).
 */
exports.SIMULATION_CLASSIFICATIONS = [
    "Real",
    "Sandbox",
    "Emulated",
    "Mocked",
    "Stubbed",
    "Hardcoded",
];
/** A ledger entry's lifecycle status. `active` still simulates; `retired` is replaced by reality. */
exports.SIMULATION_STATUSES = ["active", "retired"];
/** Narrow an arbitrary string to a known classification (or undefined). */
function asClassification(v) {
    if (v === undefined)
        return undefined;
    return exports.SIMULATION_CLASSIFICATIONS.includes(v)
        ? v
        : undefined;
}
/** Narrow an arbitrary string to a known status (or undefined). */
function asStatus(v) {
    if (v === undefined)
        return undefined;
    return exports.SIMULATION_STATUSES.includes(v) ? v : undefined;
}
/**
 * `Real` and `Sandbox` are the real provider (prod or its official test tier), so
 * they never simulate behavior — they need no ledger entry and never block. The
 * remaining four ARE simulation. Pure helper so callers don't re-encode the rule.
 */
function isSimulatedClassification(c) {
    return c !== "Real" && c !== "Sandbox";
}
/**
 * The single invariant the production-reality gate's "ledger" rung reads: does this
 * entry BLOCK marking a feature complete? True iff it is on a user-visible path,
 * still actively simulating (not retired), AND its classification is a simulation
 * (Mocked/Stubbed/Hardcoded/Emulated — Real/Sandbox are reality and never block).
 *
 * This is the mechanical form of the audit's required invariant: "a feature must
 * not be marked complete while its user-visible production path depends on
 * unresolved simulated behavior." Consumed by BOTH `th sim` reporting and the gate
 * predicate so they can never disagree about what "blocks" means.
 */
function blocksProductionReality(entry) {
    return entry.userVisible && entry.status !== "retired" && isSimulatedClassification(entry.classification);
}
/** Mint the next `SIM-NNN` id from the existing entries (max + 1, zero-padded to 3). */
function nextSimulationId(entries) {
    let max = 0;
    for (const e of entries) {
        const m = /^SIM-(\d+)$/.exec(e.id);
        if (m)
            max = Math.max(max, Number(m[1]));
    }
    return `SIM-${String(max + 1).padStart(3, "0")}`;
}
/**
 * The deterministic, unledgered-simulation token set `th sim scan` greps `dist/`
 * and the test tree for (audit Part 5). A hit on any of these in `dist/` that has
 * no matching ledger entry is flagged. Case-insensitive at the call site.
 */
exports.SIMULATION_SCAN_TOKENS = [
    "mock",
    "fake",
    "stub",
    "fixture",
    "placeholder",
    "demo",
    "TODO",
    "canned",
    "hardcoded",
];
