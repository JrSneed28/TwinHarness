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

import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { NOT_INIT, formatIssues } from "../core/guards";
import { readState } from "../core/state-store";
import { structuredLog } from "../core/log";
import { checkProductionReality } from "../core/gate-preconditions";

/**
 * `th gate production-reality` — PURE READER of `checkProductionReality`. Returns the
 * predicate's pass/fail and, on failure, its STABLE error token + detail. Exit 0 when
 * the rung passes, non-zero when it blocks (so CI / a human can gate on it). It is the
 * SAME predicate `canAdvanceStage` / `canUnlockImplementation` / `checkFinalVerification`
 * compose (after the enforce commit) and that the MCP gate tools inherit, so the token
 * this reader reports is identical to the one a blocked `th stage advance` / `th next`
 * surfaces for the same red state (the seam-parity guarantee).
 */
export function runGateProductionReality(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const res = checkProductionReality(paths, r.state);
  structuredLog({ cmd: "gate production-reality", ok: res.ok, error: res.ok ? undefined : res.error });

  if (!res.ok) {
    return failure({
      human: `Production-reality gate BLOCKS (${res.error}).`,
      data: { ok: false, gate: "production-reality", error: res.error, ...(res.detail ?? {}) },
    });
  }
  return success({
    data: { ok: true, gate: "production-reality" },
    human: "Production-reality gate clear: no unretired user-visible simulation, verify green, Tester record attached, no unledgered simulation in dist/.",
  });
}
