"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStageList = runStageList;
exports.runStageDescribe = runStageDescribe;
exports.runStageCurrent = runStageCurrent;
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const stages_1 = require("../core/stages");
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
