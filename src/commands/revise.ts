import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState, writeState, withStateLock } from "../core/state-store";
import { type ValidationIssue, validateState } from "../core/state-schema";
import { structuredLog } from "../core/log";

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
export const DEFAULT_REVISE_CAP = 3;

function formatIssues(issues: ValidationIssue[] | undefined): string {
  return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}

const NOT_INIT = failure({
  human: "No state.json found. Run `th init` first.",
  data: { error: "not_initialized" },
});

function invalidState(issues: ValidationIssue[] | undefined): CommandResult {
  return failure({
    human: `state.json is invalid:\n${formatIssues(issues)}`,
    data: { error: "invalid_state", issues },
  });
}

/**
 * `th revise bump <mode> [--cap N]` — increment the revise-loop count for a mode
 * (missing → 0), persist, and report whether the cap is reached. Computes; the
 * orchestrator decides whether to escalate.
 */
export function runReviseBump(paths: ProjectPaths, mode: string, cap = DEFAULT_REVISE_CAP): CommandResult {
  return withStateLock(paths, () => runReviseBumpLocked(paths, mode, cap));
}

function runReviseBumpLocked(paths: ProjectPaths, mode: string, cap = DEFAULT_REVISE_CAP): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) return invalidState(r.issues);

  const current = r.state.revise_loop_counts[mode] ?? 0;
  const count = current + 1;
  const next = { ...r.state, revise_loop_counts: { ...r.state.revise_loop_counts, [mode]: count } };

  const validation = validateState(next);
  if (!validation.ok) {
    return failure({
      human: `Refusing to write: result would be invalid:\n${formatIssues(validation.issues)}`,
      data: { error: "would_be_invalid", issues: validation.issues },
    });
  }
  writeState(paths, validation.state!);
  structuredLog({ cmd: "revise bump", mode, count, cap });

  const escalate = count >= cap;
  return success({
    data: { mode, count, cap, escalate },
    human: `${mode}: round ${count}/${cap}`,
  });
}

/**
 * `th revise status <mode> [--cap N]` — read the current count (missing → 0) and
 * report the cap comparison WITHOUT mutating state.
 */
export function runReviseStatus(paths: ProjectPaths, mode: string, cap = DEFAULT_REVISE_CAP): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) return invalidState(r.issues);

  const count = r.state.revise_loop_counts[mode] ?? 0;
  const escalate = count >= cap;
  return success({
    data: { mode, count, cap, escalate },
    human: `${mode}: round ${count}/${cap}`,
  });
}

/**
 * `th revise reset <mode>` — zero the revise-loop count for a mode (used when a
 * stage passes / zero issues), persist, and report.
 */
export function runReviseReset(paths: ProjectPaths, mode: string): CommandResult {
  return withStateLock(paths, () => runReviseResetLocked(paths, mode));
}

function runReviseResetLocked(paths: ProjectPaths, mode: string): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) return invalidState(r.issues);

  const next = { ...r.state, revise_loop_counts: { ...r.state.revise_loop_counts, [mode]: 0 } };

  const validation = validateState(next);
  if (!validation.ok) {
    return failure({
      human: `Refusing to write: result would be invalid:\n${formatIssues(validation.issues)}`,
      data: { error: "would_be_invalid", issues: validation.issues },
    });
  }
  writeState(paths, validation.state!);
  structuredLog({ cmd: "revise reset", mode });

  return success({ data: { mode, count: 0 }, human: `${mode}: reset to round 0` });
}
