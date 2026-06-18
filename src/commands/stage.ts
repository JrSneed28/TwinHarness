import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState } from "../core/state-store";
import { NOT_INIT, formatIssues } from "../core/guards";
import {
  STAGE_PIPELINE,
  stageContract,
  canonicalizeStage,
  nextStageAfterFor,
  type StageContract,
} from "../core/stages";
import { canAdvanceStage, canUnlockImplementation } from "../core/gate-preconditions";
import { applyGateMutation } from "./state";

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

/**
 * `th stage advance` — typed gate command mirroring the MCP `th_stage_advance`
 * tool (#11). Runs the FULL `canAdvanceStage` ladder (the same single source of
 * truth `th next` uses); on pass, computes the next APPLICABLE stage for the run
 * via `nextStageAfterFor` (the same has_ui-aware oracle `th next` uses, so a no-UI
 * run skips the UX/UI stages here too — #13) and writes it through the shared
 * locked + ledgered `applyGateMutation` (source "th stage advance"). The gate-checked
 * path operators should prefer over a raw `th state set current_stage`.
 */
export function runStageAdvance(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid; fix it before advancing the stage:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }
  const state = r.state;
  const adv = canAdvanceStage(paths, state);
  if (!adv.ok) {
    return failure({
      human: `Cannot advance stage (${adv.error}).`,
      data: { error: adv.error, ...(adv.detail ?? {}) },
    });
  }
  const current = canonicalizeStage(state.current_stage);
  const next = nextStageAfterFor(current, state);
  if (!next) {
    return failure({
      human: "Already at the terminal engaged stage for this run; there is no next stage to advance to.",
      data: { error: "no_next_stage", current_stage: current },
    });
  }
  return applyGateMutation(paths, { current_stage: next.stage }, "th stage advance");
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
export function runImplementationUnlock(paths: ProjectPaths, opts: { lock?: boolean } = {}): CommandResult {
  const allowed = !opts.lock;
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid; fix it before changing the implementation gate:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }
  if (allowed) {
    const check = canUnlockImplementation(paths, r.state);
    if (!check.ok) {
      return failure({
        human: `Cannot unlock implementation (${check.error}).`,
        data: { error: check.error, ...(check.detail ?? {}) },
      });
    }
  }
  return applyGateMutation(paths, { implementation_allowed: allowed }, "th implementation unlock");
}
