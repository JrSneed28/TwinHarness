/**
 * IF-004 run_command tool (REQ-009, REQ-013, REQ-021). Owner component:
 * `tool-runcommand`.
 *
 * Executes a shell command in the WorkingRoot and captures its result. EVERY run
 * flows through a FIXED order (RULE-001/005) — skipping any step is an invariant breach:
 *
 *   1. checkExecCwd  — `path-sandbox.checkExecCwd` confines the cwd; an out-of-root
 *                      cwd (traversal / absolute-outside / symlink) → PATH_ESCAPE
 *                      (ERR-001), FAIL-CLOSED, BEFORE the command is even gated
 *                      (RULE-001). Completes the EXEC half of REQ-021's confinement.
 *   2. resolveCommand — `approval-gate.resolveCommand` gates the command by the command
 *                      policy + allowlist (allowlist-confirm default / auto); denied →
 *                      APPROVAL_DENIED (ERR-004); abort → UserAbortError (clean Stopped).
 *   3. CommandRunner.run — only after approval does the command actually spawn; the
 *                      seam captures {exitCode, stdout, stderr, timedOut}. The runner
 *                      does NO policy/confinement (that is all done above).
 *
 * tests-as-signal (REQ-013): when `command` EQUALS the detected test command (from
 * `repo-context`, RULE-009), `isTestRun:true` and a `tests-run` TranscriptEntry
 * `{command, passed, exitCode}` is emitted — `passed` (exitCode === 0) is the PRIMARY
 * completion signal the loop reasons about (the stop classification is SLICE-7).
 *
 * Errors-as-results (ADR-007 / RULE-008): the tool NEVER throws for an expected
 * failure — it returns a `status:"error"` ToolResult (PATH_ESCAPE / APPROVAL_DENIED /
 * COMMAND_TIMEOUT / COMMAND_FAILED). The ONE propagating class is `UserAbortError`
 * (clean user-abort StopCondition), re-raised by the registry rather than normalized.
 *
 * CRITICAL distinction (ADR-007): a NON-ZERO exit code is a `status:"ok"` ToolResult
 * carrying `exitCode` — a failing test run is a RESULT the agent reasons about, NOT an
 * error. Only a SPAWN FAILURE (COMMAND_FAILED, distinct from a non-zero exit) and a
 * TIMEOUT (COMMAND_TIMEOUT) are error ToolResults. Commands are NOT deduplicated.
 */
import type {
  ApprovalGate,
  CommandAllowlist,
  CommandApprovalPolicy,
  CommandRunner,
  PathSandbox,
  ToolCall,
  ToolResult,
  TranscriptWriter,
} from "./contracts.js";
import { SCHEMA_VERSION } from "./contracts.js";
import { UserAbortError } from "./tool-errors.js";

/** Default per-command timeout (IF-004): 120s. Bounded to [1000, 600000]. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

/** Bound for captured stream sizes before the `truncated` flag is set (prompt-safe). */
export const STREAM_CAP_BYTES = 64_000;

export interface RunCommandTool {
  readonly toolName: "run_command";
  execute(toolCall: ToolCall): Promise<ToolResult>;
}

export interface RunCommandDeps {
  sandbox: PathSandbox;
  approval: ApprovalGate;
  runner: CommandRunner;
  allowlist: CommandAllowlist;
  /** The resolved command policy (default allowlist-confirm). */
  policy: CommandApprovalPolicy;
  /** The default cwd when the model omits one — the resolved WorkingRoot. */
  workingRoot: string;
  /**
   * The detected test command (from `repo-context`, RULE-009) or null. A run whose
   * `command` equals this exactly is marked `isTestRun` and emits a `tests-run` signal.
   */
  testCommand?: string | null;
  /** Optional transcript sink for command-run / tests-run rows. */
  transcript?: TranscriptWriter;
  runId?: string;
  now?: () => string;
}

/** Truncate a captured stream to the prompt-safe cap; report whether it was clipped. */
function capStream(s: string): { value: string; truncated: boolean } {
  if (s.length <= STREAM_CAP_BYTES) return { value: s, truncated: false };
  return { value: s.slice(0, STREAM_CAP_BYTES), truncated: true };
}

/** Clamp a model-supplied timeout into [MIN, MAX]; fall back to default when absent/invalid. */
function resolveTimeout(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  const n = Math.trunc(raw);
  if (n < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (n > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return n;
}

export function createRunCommandTool(deps: RunCommandDeps): RunCommandTool {
  const now = deps.now ?? (() => new Date().toISOString());

  async function emit(
    type: "command-run" | "tests-run",
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!deps.transcript || !deps.runId) return;
    await deps.transcript.append({
      schemaVersion: SCHEMA_VERSION,
      ts: now(),
      runId: deps.runId,
      type,
      payload,
    });
  }

  return {
    toolName: "run_command",
    async execute(toolCall: ToolCall): Promise<ToolResult> {
      const args = toolCall.arguments ?? {};
      const command = typeof args.command === "string" ? args.command : "";
      if (command.length < 1) {
        return errorResult(toolCall.id, "COMMAND_FAILED", "command is required (min length 1)");
      }
      const cwd =
        typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : deps.workingRoot;
      const timeoutMs = resolveTimeout(args.timeoutMs);

      // ---- STEP 1: checkExecCwd — confinement FAIL-CLOSED before anything else ----
      // (RULE-001). An out-of-root cwd → PATH_ESCAPE (ERR-001); no gate, no spawn.
      // This completes the EXEC half of REQ-021's confinement.
      const verdict = deps.sandbox.checkExecCwd(cwd);
      if (!verdict.allowed || !verdict.canonicalPath) {
        return errorResult(
          toolCall.id,
          "PATH_ESCAPE",
          verdict.reason?.message ?? `cwd escapes root: ${cwd}`,
        );
      }
      const canonicalCwd = verdict.canonicalPath;

      // ---- STEP 2: resolveCommand — gate by the command policy + allowlist --------
      // (RULE-005). Abort throws UserAbortError (re-raised by the registry — clean
      // Stopped); denied → APPROVAL_DENIED error result (loop continues).
      const decision = await deps.approval.resolveCommand(command, deps.policy, deps.allowlist);
      if (decision === "user-abort") {
        // Clean Stopped (NOT Failed): raise the user-abort StopCondition carrier.
        throw new UserAbortError(`user aborted the command: ${command}`);
      }
      if (decision === "denied") {
        return errorResult(toolCall.id, "APPROVAL_DENIED", `command was denied: ${command}`);
      }
      // decision is "auto-approved" | "approved-by-user" — permitted.

      // ---- STEP 3: CommandRunner.run — spawn (no policy/confinement here) ----------
      const result = await deps.runner.run(command, canonicalCwd, timeoutMs);

      // A SPAWN FAILURE (the process never started) → COMMAND_FAILED (ERR-010),
      // DISTINCT from a process that ran and exited non-zero (ADR-007).
      if (result.spawnFailed) {
        return errorResult(
          toolCall.id,
          "COMMAND_FAILED",
          `failed to spawn command: ${command}${result.stderr ? ` (${result.stderr})` : ""}`,
        );
      }
      // A TIMEOUT (the process was killed at timeoutMs) → COMMAND_TIMEOUT (ERR-009).
      if (result.timedOut) {
        return errorResult(
          toolCall.id,
          "COMMAND_TIMEOUT",
          `command exceeded ${timeoutMs}ms and was killed: ${command}`,
        );
      }

      // The process RAN and EXITED (any code). A non-zero exit is a RESULT, not an
      // error (ADR-007) — it returns as a status:"ok" ToolResult carrying exitCode.
      const out = capStream(result.stdout);
      const err = capStream(result.stderr);
      const truncated = out.truncated || err.truncated;

      // tests-as-signal (REQ-013): mark a run of the detected test command and emit a
      // `tests-run` entry whose `passed` (exitCode === 0) is the PRIMARY completion signal.
      const isTestRun =
        typeof deps.testCommand === "string" &&
        deps.testCommand.length > 0 &&
        command === deps.testCommand;
      const passed = result.exitCode === 0;

      // `command-run` records every run (NOT deduplicated — each run is its own entry).
      await emit("command-run", { command, exitCode: result.exitCode, timedOut: false });
      if (isTestRun) {
        await emit("tests-run", { command, passed, exitCode: result.exitCode });
      }

      return {
        toolCallId: toolCall.id,
        status: "ok",
        output: {
          exitCode: result.exitCode,
          stdout: out.value,
          stderr: err.value,
          timedOut: false,
          isTestRun,
          truncated,
        },
      };
    },
  };
}

/** Build a normalized error ToolResult (never a throw for expected failures — RULE-008). */
function errorResult(toolCallId: string, code: string, message: string): ToolResult {
  return { toolCallId, status: "error", error: { code, message } };
}
