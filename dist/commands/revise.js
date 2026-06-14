"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_REVISE_CAP = void 0;
exports.runReviseBump = runReviseBump;
exports.runReviseStatus = runReviseStatus;
exports.runReviseReset = runReviseReset;
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const state_schema_1 = require("../core/state-schema");
const log_1 = require("../core/log");
const guards_1 = require("../core/guards");
/**
 * `th revise` — the mechanical revise-loop cap (spec §18 "Loop termination").
 *
 * The loop COUNT and the cap COMPARISON are mechanical truths, so they live in
 * code (build plan Principle 1). This command *records and computes*: it reports
 * `escalate = count >= cap`, but the actual decision to escalate to the human is
 * the orchestrator's (build plan §3 boundary rule). There is no minimum-issue
 * quota — zero issues is a valid stop, the orchestrator simply calls `reset`.
 */
/** Default Agent↔Critic revise-loop cap (spec §18). */
exports.DEFAULT_REVISE_CAP = 3;
function invalidState(issues) {
    return (0, output_1.failure)({
        human: `state.json is invalid:\n${(0, guards_1.formatIssues)(issues)}`,
        data: { error: "invalid_state", issues },
    });
}
/**
 * `th revise bump <mode> [--cap N]` — increment the revise-loop count for a mode
 * (missing → 0), persist, and report whether the cap is reached. Computes; the
 * orchestrator decides whether to escalate.
 */
function runReviseBump(paths, mode, cap = exports.DEFAULT_REVISE_CAP) {
    return (0, state_store_1.withStateLock)(paths, () => runReviseBumpLocked(paths, mode, cap));
}
function runReviseBumpLocked(paths, mode, cap = exports.DEFAULT_REVISE_CAP) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state)
        return invalidState(r.issues);
    const current = r.state.revise_loop_counts[mode] ?? 0;
    const count = current + 1;
    const next = { ...r.state, revise_loop_counts: { ...r.state.revise_loop_counts, [mode]: count } };
    const validation = (0, state_schema_1.validateState)(next);
    if (!validation.ok) {
        return (0, output_1.failure)({
            human: `Refusing to write: result would be invalid:\n${(0, guards_1.formatIssues)(validation.issues)}`,
            data: { error: "would_be_invalid", issues: validation.issues },
        });
    }
    (0, state_store_1.writeState)(paths, validation.state);
    (0, log_1.structuredLog)({ cmd: "revise bump", mode, count, cap });
    const escalate = count >= cap;
    return (0, output_1.success)({
        data: { mode, count, cap, escalate },
        human: `${mode}: round ${count}/${cap}`,
    });
}
/**
 * `th revise status <mode> [--cap N]` — read the current count (missing → 0) and
 * report the cap comparison WITHOUT mutating state.
 */
function runReviseStatus(paths, mode, cap = exports.DEFAULT_REVISE_CAP) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state)
        return invalidState(r.issues);
    const count = r.state.revise_loop_counts[mode] ?? 0;
    const escalate = count >= cap;
    return (0, output_1.success)({
        data: { mode, count, cap, escalate },
        human: `${mode}: round ${count}/${cap}`,
    });
}
/**
 * `th revise reset <mode>` — zero the revise-loop count for a mode (used when a
 * stage passes / zero issues), persist, and report.
 */
function runReviseReset(paths, mode) {
    return (0, state_store_1.withStateLock)(paths, () => runReviseResetLocked(paths, mode));
}
function runReviseResetLocked(paths, mode) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state)
        return invalidState(r.issues);
    const next = { ...r.state, revise_loop_counts: { ...r.state.revise_loop_counts, [mode]: 0 } };
    const validation = (0, state_schema_1.validateState)(next);
    if (!validation.ok) {
        return (0, output_1.failure)({
            human: `Refusing to write: result would be invalid:\n${(0, guards_1.formatIssues)(validation.issues)}`,
            data: { error: "would_be_invalid", issues: validation.issues },
        });
    }
    (0, state_store_1.writeState)(paths, validation.state);
    (0, log_1.structuredLog)({ cmd: "revise reset", mode });
    return (0, output_1.success)({ data: { mode, count: 0 }, human: `${mode}: reset to round 0` });
}
