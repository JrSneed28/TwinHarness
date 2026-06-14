"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOT_INIT = void 0;
exports.formatIssues = formatIssues;
exports.requireState = requireState;
const state_store_1 = require("./state-store");
const output_1 = require("./output");
/** The canonical "no run here" failure, shared by every command that reads state. */
exports.NOT_INIT = (0, output_1.failure)({
    human: "No state.json found. Run `th init` first.",
    data: { error: "not_initialized" },
});
/** Indent + join validation issues for human output (shared rendering). */
function formatIssues(issues) {
    return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}
/**
 * Collapse the repeated read-then-validate guard. Returns the validated state,
 * or an early-return `CommandResult` (NOT_INIT when absent; an `invalid_state`
 * failure when present-but-invalid). New commands use this; existing call sites
 * with bespoke human wording keep their messages.
 */
function requireState(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return { result: exports.NOT_INIT };
    if (!r.state) {
        return {
            result: (0, output_1.failure)({
                human: `state.json is invalid:\n${formatIssues(r.issues)}`,
                data: { error: "invalid_state", issues: r.issues },
            }),
        };
    }
    return { state: r.state };
}
