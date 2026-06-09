import type { ProjectPaths } from "../core/paths";
import { readState } from "../core/state-store";

/**
 * Stop-gate decision (plan pre-mortem #2 mitigation): the mechanical gate that
 * blocks a premature "stage complete" claim. Logic lives in tested CLI code, not
 * in a shell hook, so the gate is verifiable.
 */
export interface StopGateDecision {
  block: boolean;
  reasons: string[];
}

/**
 * Decide whether the orchestrator may declare completion.
 *
 * - No state.json  → no TwinHarness run active in this project → allow.
 * - Invalid state  → block (the orchestrator must repair state first).
 * - Open BLOCKING drift (§10) → block.
 * - Otherwise → allow.
 *
 * Later slices extend this with `tier veto-check` and coverage-gap gating.
 */
export function evaluateStopGate(paths: ProjectPaths): StopGateDecision {
  const r = readState(paths);
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
 */
export function runHookStopGate(paths: ProjectPaths): { stdout: string; exitCode: number } {
  const decision = evaluateStopGate(paths);
  if (decision.block) {
    return {
      stdout: JSON.stringify({
        decision: "block",
        reason: "TwinHarness stop-gate blocked completion: " + decision.reasons.join(" "),
      }),
      exitCode: 0,
    };
  }
  return { stdout: JSON.stringify({}), exitCode: 0 };
}
