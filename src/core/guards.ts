/**
 * Shared command-handler guards (extracted to kill duplication: `NOT_INIT` and
 * `formatIssues` were copy-pasted across ~8 command files, and the
 * read-state-then-validate ladder repeated in ~20 handlers). Pure helpers over
 * the existing `readState` / `CommandResult` primitives — no behavior change.
 */
import type { ProjectPaths } from "./paths";
import type { TwinHarnessState, ValidationIssue } from "./state-schema";
import { readState } from "./state-store";
import { type CommandResult, failure } from "./output";

/** The canonical "no run here" failure, shared by every command that reads state. */
export const NOT_INIT: CommandResult = failure({
  human: "No state.json found. Run `th init` first.",
  data: { error: "not_initialized" },
});

/** Indent + join validation issues for human output (shared rendering). */
export function formatIssues(issues: ValidationIssue[] | undefined): string {
  return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}

export type RequireStateResult =
  | { state: TwinHarnessState; result?: undefined }
  | { state?: undefined; result: CommandResult };

/**
 * Collapse the repeated read-then-validate guard. Returns the validated state,
 * or an early-return `CommandResult` (NOT_INIT when absent; an `invalid_state`
 * failure when present-but-invalid). New commands use this; existing call sites
 * with bespoke human wording keep their messages.
 */
export function requireState(paths: ProjectPaths): RequireStateResult {
  const r = readState(paths);
  if (!r.exists) return { result: NOT_INIT };
  if (!r.state) {
    return {
      result: failure({
        human: `state.json is invalid:\n${formatIssues(r.issues)}`,
        data: { error: "invalid_state", issues: r.issues },
      }),
    };
  }
  return { state: r.state };
}
