"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateStopGate = evaluateStopGate;
exports.runHookStopGate = runHookStopGate;
const state_store_1 = require("../core/state-store");
/**
 * Decide whether the orchestrator may declare completion.
 *
 * - No state.json  → no TwinHarness run active in this project → allow.
 * - Invalid state  → block (the orchestrator must repair state first).
 * - Open BLOCKING drift (§10) → block.
 * - Otherwise → allow.
 *
 * The gate checks state validity and open blocking drift. That is the complete
 * set of mechanical stop conditions; no additional gating is wired here.
 */
function evaluateStopGate(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists) {
        return { block: false, reasons: [] };
    }
    if (!r.state) {
        return {
            block: true,
            reasons: [
                "state.json is present but does NOT validate against the schema; repair it before claiming any stage complete.",
                ...(r.issues ?? []).map((i) => `${i.path}: ${i.message}`),
            ],
        };
    }
    if (r.state.drift_open_blocking > 0) {
        const n = r.state.drift_open_blocking;
        return {
            block: true,
            reasons: [`${n} open BLOCKING drift escalation${n === 1 ? "" : "s"} (§10) must be resolved before completing.`],
        };
    }
    return { block: false, reasons: [] };
}
/**
 * `th hook stop-gate` — emit a Claude Code Stop-hook decision on stdout.
 * Blocks with a reason, or allows with `{}`. Always exits 0 (the JSON carries
 * the decision).
 *
 * Loop protection: the gate blocks at most once per stop sequence. If the gate
 * would block again while `stop_hook_active` is true, it allows the stop but
 * surfaces the unresolved reasons as a `systemMessage` — blocking drift needs a
 * human decision, and re-blocking forever would spin the model instead of
 * yielding the turn to that human.
 */
function runHookStopGate(paths, input) {
    const decision = evaluateStopGate(paths);
    if (decision.block) {
        const reason = "TwinHarness stop-gate blocked completion: " + decision.reasons.join(" ");
        if (input?.stop_hook_active === true) {
            return {
                stdout: JSON.stringify({
                    systemMessage: "TwinHarness stop-gate is STILL blocked, but allowed the stop to avoid an infinite loop. " +
                        "A human decision is required. " + reason,
                }),
                exitCode: 0,
            };
        }
        return {
            stdout: JSON.stringify({ decision: "block", reason }),
            exitCode: 0,
        };
    }
    return { stdout: JSON.stringify({}), exitCode: 0 };
}
