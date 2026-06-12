import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState } from "../core/state-store";
import { STAGE_PIPELINE, stageContract, type StageContract } from "../core/stages";

/**
 * `th stage` — the mechanical per-stage contract (Phase 3).
 *
 * Records and computes; never decides. Gives the Orchestrator an
 * always-available answer to "what does this stage produce, who reviews it, does
 * it need a human gate?" without depending on the prose playbook surviving the
 * context window (audit F7).
 */

function renderContract(c: StageContract): string {
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
export function runStageList(): CommandResult {
  const human = STAGE_PIPELINE.map(
    (c) => `${c.stage.padEnd(22)} ${c.tiers.join("/").padEnd(10)} ${c.humanGate ? "[gate] " : "       "}${c.produces || "-"}`,
  ).join("\n");
  return success({ data: { stages: STAGE_PIPELINE }, human });
}

/** `th stage describe <stage>` — one stage's contract. */
export function runStageDescribe(stage?: string): CommandResult {
  if (!stage) return failure({ human: "usage: th stage describe <stage>" });
  const c = stageContract(stage);
  if (!c) {
    return failure({
      human: `Unknown stage: ${stage}. Known: ${STAGE_PIPELINE.map((s) => s.stage).join(", ")}`,
      data: { error: "unknown_stage", stage },
    });
  }
  return success({ data: { stage: c }, human: renderContract(c) });
}

/** `th stage current` — the contract for state.current_stage. */
export function runStageCurrent(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return failure({ human: "No state.json found. Run `th init` first.", data: { error: "not_initialized" } });
  if (!r.state) return failure({ human: "state.json is invalid.", data: { error: "invalid_state", issues: r.issues } });

  const current = r.state.current_stage;
  const c = stageContract(current);
  if (!c) {
    // Pre-pipeline stages (e.g. "init") have no contract — report plainly.
    return success({
      data: { current_stage: current, contract: null },
      human: `Current stage "${current}" has no pipeline contract (pre-stage or bypass). Run \`th stage list\` to see the engaged stages.`,
    });
  }
  return success({ data: { current_stage: current, contract: c }, human: renderContract(c) });
}
