"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStageList = runStageList;
exports.runStageDescribe = runStageDescribe;
exports.runStageCurrent = runStageCurrent;
exports.runStageAdvance = runStageAdvance;
exports.runImplementationUnlock = runImplementationUnlock;
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const guards_1 = require("../core/guards");
const stages_1 = require("../core/stages");
const gate_preconditions_1 = require("../core/gate-preconditions");
const state_1 = require("./state");
/**
 * `th stage` — the mechanical per-stage contract (Phase 3).
 *
 * Records and computes; never decides. Gives the Orchestrator an
 * always-available answer to "what does this stage produce, who reviews it, does
 * it need a human gate?" without depending on the prose playbook surviving the
 * context window (audit F7).
 */
function renderContract(c) {
    return [
        `Stage:       ${c.stage}`,
        `Tiers:       ${c.tiers.join(", ")}`,
        `Produces:    ${c.produces || "(no artifact)"}`,
        `Critic mode: ${c.criticMode}`,
        `Human gate:  ${c.humanGate ? "yes (blocking)" : "no (streams)"}`,
        `Summary:     ${c.summary}`,
    ].join("\n");
}
/** `th stage list` — all stages in pipeline order. */
function runStageList() {
    const human = stages_1.STAGE_PIPELINE.map((c) => `${c.stage.padEnd(22)} ${c.tiers.join("/").padEnd(10)} ${c.humanGate ? "[gate] " : "       "}${c.produces || "-"}`).join("\n");
    return (0, output_1.success)({ data: { stages: stages_1.STAGE_PIPELINE }, human });
}
/** `th stage describe <stage>` — one stage's contract. */
function runStageDescribe(stage) {
    if (!stage)
        return (0, output_1.failure)({ human: "usage: th stage describe <stage>" });
    const c = (0, stages_1.stageContract)(stage);
    if (!c) {
        return (0, output_1.failure)({
            human: `Unknown stage: ${stage}. Known: ${stages_1.STAGE_PIPELINE.map((s) => s.stage).join(", ")}`,
            data: { error: "unknown_stage", stage },
        });
    }
    return (0, output_1.success)({ data: { stage: c }, human: renderContract(c) });
}
/** `th stage current` — the contract for state.current_stage. */
function runStageCurrent(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return (0, output_1.failure)({ human: "No state.json found. Run `th init` first.", data: { error: "not_initialized" } });
    if (!r.state)
        return (0, output_1.failure)({ human: "state.json is invalid.", data: { error: "invalid_state", issues: r.issues } });
    const current = r.state.current_stage;
    const c = (0, stages_1.stageContract)(current);
    if (!c) {
        // Pre-pipeline stages (e.g. "init") have no contract — report plainly.
        return (0, output_1.success)({
            data: { current_stage: current, contract: null },
            human: `Current stage "${current}" has no pipeline contract (pre-stage or bypass). Run \`th stage list\` to see the engaged stages.`,
        });
    }
    return (0, output_1.success)({ data: { current_stage: current, contract: c }, human: renderContract(c) });
}
/**
 * `th stage advance` — typed gate command mirroring the MCP `th_stage_advance`
 * tool (#11). Runs the FULL `canAdvanceStage` ladder (the same single source of
 * truth `th next` uses); on pass, computes the next APPLICABLE stage for the run
 * via `nextStageAfterFor` (the same has_ui-aware oracle `th next` uses, so a no-UI
 * run skips the UX/UI stages here too — #13) and writes it through the shared
 * locked + ledgered `applyGateMutation` (source "th stage advance"). The gate-checked
 * path operators should prefer over a raw `th state set current_stage`.
 */
function runStageAdvance(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid; fix it before advancing the stage:\n${(0, guards_1.formatIssues)(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const state = r.state;
    const adv = (0, gate_preconditions_1.canAdvanceStage)(paths, state);
    if (!adv.ok) {
        return (0, output_1.failure)({
            human: `Cannot advance stage (${adv.error}).`,
            data: { error: adv.error, ...(adv.detail ?? {}) },
        });
    }
    const current = (0, stages_1.canonicalizeStage)(state.current_stage);
    const next = (0, stages_1.nextStageAfterFor)(current, state);
    if (!next) {
        return (0, output_1.failure)({
            human: "Already at the terminal engaged stage for this run; there is no next stage to advance to.",
            data: { error: "no_next_stage", current_stage: current },
        });
    }
    return (0, state_1.applyGateMutation)(paths, { current_stage: next.stage }, "th stage advance");
}
/**
 * `th implementation unlock [--lock]` — typed gate command mirroring the MCP
 * `th_implementation_unlock` tool (#11). Unlock (default) requires the FULL
 * `canUnlockImplementation` ladder (the complete advance ladder + coverage + a
 * current stage at/after implementation-planning); `--lock` (re-lock/tighten) is
 * always permitted. Writes through the shared locked + ledgered `applyGateMutation`
 * (source "th implementation unlock"). The gate-checked path operators should
 * prefer over a raw `th state set implementation_allowed`.
 */
function runImplementationUnlock(paths, opts = {}) {
    const allowed = !opts.lock;
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid; fix it before changing the implementation gate:\n${(0, guards_1.formatIssues)(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    if (allowed) {
        const check = (0, gate_preconditions_1.canUnlockImplementation)(paths, r.state);
        if (!check.ok) {
            return (0, output_1.failure)({
                human: `Cannot unlock implementation (${check.error}).`,
                data: { error: check.error, ...(check.detail ?? {}) },
            });
        }
    }
    return (0, state_1.applyGateMutation)(paths, { implementation_allowed: allowed }, "th implementation unlock");
}
