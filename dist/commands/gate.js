"use strict";
/**
 * `th gate …` — pure READERS over the shared gate-precondition predicates (SG3
 * P2-C). A gate reader inspects state, runs the matching predicate from
 * `src/core/gate-preconditions.ts` (the single source of truth), and reports the
 * result — it NEVER mutates state and NEVER calls another verb (no verb-calls-verb;
 * the predicate is the seam both this reader and the typed MCP gate tools consume,
 * so they can never disagree about what "ready" means).
 *
 *   runGateProductionReality — reports `checkProductionReality` (6 stable tokens).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runGateProductionReality = runGateProductionReality;
const output_1 = require("../core/output");
const guards_1 = require("../core/guards");
const state_store_1 = require("../core/state-store");
const log_1 = require("../core/log");
const gate_preconditions_1 = require("../core/gate-preconditions");
/**
 * `th gate production-reality` — PURE READER of `checkProductionReality`. Returns the
 * predicate's pass/fail and, on failure, its STABLE error token + detail. Exit 0 when
 * the rung passes, non-zero when it blocks (so CI / a human can gate on it). It is the
 * SAME predicate `canAdvanceStage` / `canUnlockImplementation` / `checkFinalVerification`
 * compose (after the enforce commit) and that the MCP gate tools inherit, so the token
 * this reader reports is identical to the one a blocked `th stage advance` / `th next`
 * surfaces for the same red state (the seam-parity guarantee).
 */
function runGateProductionReality(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid:\n${(0, guards_1.formatIssues)(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const res = (0, gate_preconditions_1.checkProductionReality)(paths, r.state);
    (0, log_1.structuredLog)({ cmd: "gate production-reality", ok: res.ok, error: res.ok ? undefined : res.error });
    // BSC-3 / Axis-B slice-4a (I1 observability) — surface the per-dimension verification-
    // driver trust-label summary `checkProductionReality` attaches when there is something to
    // observe (a clean grandfathered/absence PASS carries NO `dimensions` field, so render
    // nothing then). PURE rendering of Lane B's existing field; this reader never recomputes
    // the verdict. Identical on the MCP twin, which calls this same function.
    const hasDimensions = (res.dimensions?.length ?? 0) > 0;
    const dimensionsLine = hasDimensions
        ? `\nVerification dimensions: ${res.dimensions
            .map((d) => `${d.name}=${d.observed ? "observed" : "unobserved"}/${d.trustLabel}`)
            .join(", ")}.`
        : "";
    const dimensionsData = hasDimensions ? { dimensions: res.dimensions } : {};
    if (!res.ok) {
        return (0, output_1.failure)({
            human: `Production-reality gate BLOCKS (${res.error}).${dimensionsLine}`,
            data: { ok: false, gate: "production-reality", error: res.error, ...dimensionsData, ...(res.detail ?? {}) },
        });
    }
    return (0, output_1.success)({
        data: { ok: true, gate: "production-reality", ...dimensionsData },
        human: "Production-reality gate clear: no unretired user-visible simulation, verify green, Tester record attached, no unledgered simulation in dist/." +
            dimensionsLine,
    });
}
