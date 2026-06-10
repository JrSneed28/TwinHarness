/**
 * Error CLASSES at the run boundary (Channel B — fatal; ADR-007 / RULE-008).
 *
 * Two distinct fatal markers flow to `agent-run`'s unrecoverable-error path:
 *  - FatalToolError — an executor hit an invariant breach / transcript write
 *    failure that must NOT be normalized to a ToolResult; the registry re-raises
 *    it (IF-008 "re-raised" row). The precise classification of *which*
 *    conditions are fatal is SLICE-7's job; SLICE-2 only needs the marker so the
 *    registry knows not to swallow it.
 *  - LlmFatalError (`LLM_FATAL`, ERR-013) — the LlmClient seam exhausted retries
 *    or hit a non-transient failure; `agent-run` maps it to unrecoverable-error
 *    → Failed (non-zero exit).
 *
 * Both are real thrown Error subclasses with a stable `code`, so callers can
 * branch on type without string-matching messages.
 */

/** Marker code for a fatal tool error (Channel B). */
export const FATAL_TOOL_ERROR = "FATAL_TOOL_ERROR";

/**
 * A fatal class raised by a tool executor (invariant breach / transcript write
 * failure). The registry re-raises this rather than normalizing it.
 */
export class FatalToolError extends Error {
  readonly code: string;
  constructor(message: string, code: string = FATAL_TOOL_ERROR) {
    super(message);
    this.name = "FatalToolError";
    this.code = code;
  }
}

/** True iff `err` is the fatal tool class (must be re-raised, not normalized). */
export function isFatalToolError(err: unknown): err is FatalToolError {
  return err instanceof FatalToolError;
}

/**
 * Marker code for a user-abort signal raised at an approval prompt (IF-009).
 * This is NOT a fatal class: `user-abort` is a CLEAN stop (classified Stopped, not
 * Failed). It is distinct from both `FatalToolError` (→ unrecoverable-error/Failed)
 * and an ordinary error ToolResult (→ loop continues). It must NOT be normalized
 * to a ToolResult by the registry — it propagates up so the run terminates cleanly.
 * The full StopCondition classification (user-abort → Stopped) is SLICE-7's; SLICE-4
 * only needs this distinct, non-fatal marker so the abort is not swallowed.
 */
export const USER_ABORT = "USER_ABORT";

/**
 * Thrown by `tool-writeedit` (and later edit/command tools) when `ApprovalGate`
 * returns `"user-abort"`. The registry re-raises it (like a fatal) rather than
 * normalizing it — but `agent-run`/`budget-stop` (SLICE-7) classify it as a CLEAN
 * `user-abort` StopCondition → Stopped, NOT Failed (it is deliberately NOT a
 * `FatalToolError`).
 */
export class UserAbortError extends Error {
  readonly code = USER_ABORT;
  constructor(message = "user aborted at an approval prompt") {
    super(message);
    this.name = "UserAbortError";
  }
}

/** True iff `err` is the user-abort class (clean Stopped — re-raised, not normalized). */
export function isUserAbortError(err: unknown): err is UserAbortError {
  return err instanceof UserAbortError;
}

/** The LLM_FATAL error code (ERR-013, Channel B). */
export const LLM_FATAL = "LLM_FATAL";

/**
 * Thrown by the `llm-client` seam on a non-transient failure or retry
 * exhaustion. `agent-run` catches it and classifies the run as
 * unrecoverable-error → Failed (ERR-013, non-zero exit).
 */
export class LlmFatalError extends Error {
  readonly code = LLM_FATAL;
  /** The terminal error class that caused the fatal (e.g. http_401, exhausted). */
  readonly errorClass: string;
  constructor(message: string, errorClass: string) {
    super(message);
    this.name = "LlmFatalError";
    this.errorClass = errorClass;
  }
}

/** True iff `err` is the LLM_FATAL class (agent-run maps it to Failed). */
export function isLlmFatalError(err: unknown): err is LlmFatalError {
  return err instanceof LlmFatalError;
}
