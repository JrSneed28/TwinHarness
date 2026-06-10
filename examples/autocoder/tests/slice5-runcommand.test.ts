/**
 * SLICE-5 / TASK-012 — run_command tool + tests-as-signal + exec-cwd confinement
 * (REQ-009, REQ-013, REQ-021).
 *
 * Drives the REAL tool against temp-dir fixtures through the REAL PathSandbox +
 * ApprovalGate + Allowlist, with the CommandRunner SPAWN STUBBED (no real subprocess;
 * RULE-015). The fixed order (checkExecCwd → resolveCommand → CommandRunner.run) is
 * exercised end-to-end, and the data-integrity negatives are asserted:
 *   - an out-of-root cwd is rejected fail-closed → PATH_ESCAPE (REQ-021 exec-side);
 *   - a spawn failure → COMMAND_FAILED, DISTINCT from a non-zero exit (a result);
 *   - a timeout → COMMAND_TIMEOUT;
 *   - a non-zero exit is a status:"ok" ToolResult carrying exitCode (ADR-007);
 *   - the detected test command sets isTestRun + emits a tests-run `passed` signal;
 *   - identical commands are NOT deduplicated.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPathSandbox } from "../src/path-sandbox.js";
import { createApprovalGate } from "../src/approval-gate.js";
import { createAllowlist } from "../src/allowlist.js";
import { createRunCommandTool, type RunCommandDeps } from "../src/tool-runcommand.js";
import { createStubCommandRunner, type StubCommandResult } from "./stubs.js";
import type {
  AllowlistEntry,
  CommandApprovalPolicy,
  CommandResult,
  ToolCall,
  ToolResult,
  TranscriptEntryInput,
  TranscriptWriter,
} from "../src/contracts.js";

const AUTO: CommandApprovalPolicy = { commandMode: "auto" };

const ALLOWLIST: AllowlistEntry[] = [
  { pattern: "npm test" },
  { pattern: "git status" },
  { pattern: "ls" },
];

/** A recording transcript sink (asserts command-run / tests-run rows). */
function recordingTranscript(): TranscriptWriter & { entries: TranscriptEntryInput[] } {
  const entries: TranscriptEntryInput[] = [];
  return {
    entries,
    async open() {},
    async append(entry: TranscriptEntryInput) {
      entries.push(entry);
    },
    async flush() {},
  };
}

describe("SLICE-5 run_command tool (REQ-009 / REQ-013 / REQ-021)", () => {
  let root: string;
  let sibling: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice5-"));
    root = path.join(base, "root");
    sibling = path.join(base, "sibling");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  /** Build the tool with the REAL sandbox/gate/allowlist + a stubbed runner. */
  function tool(
    runnerResult: StubCommandResult,
    overrides: Partial<RunCommandDeps> = {},
  ): {
    exec: ReturnType<typeof createRunCommandTool>;
    runner: ReturnType<typeof createStubCommandRunner>;
  } {
    const runner = createStubCommandRunner(runnerResult);
    const exec = createRunCommandTool({
      sandbox: createPathSandbox(root),
      approval: createApprovalGate({ confirmCommand: async () => "approve" }),
      runner,
      allowlist: createAllowlist(ALLOWLIST),
      policy: AUTO, // auto-run so the gate is not the variable under test here
      workingRoot: root,
      ...overrides,
    });
    return { exec, runner };
  }

  function call(args: Record<string, unknown>): ToolCall {
    return { id: "c1", toolName: "run_command", arguments: args };
  }

  // -------------------------------------------------------------- REQ-009 ----

  // Anchor: REQ-009.
  it("test_REQ009_runs_command_captures_exit_stdout_stderr", async () => {
    const result: CommandResult = {
      exitCode: 0,
      stdout: "hello\n",
      stderr: "warn\n",
      timedOut: false,
    };
    const { exec, runner } = tool(result);
    const r: ToolResult = await exec.execute(call({ command: "ls -la" }));

    expect(r.status).toBe("ok");
    expect(r.output?.exitCode).toBe(0);
    expect(r.output?.stdout).toBe("hello\n");
    expect(r.output?.stderr).toBe("warn\n");
    expect(r.output?.timedOut).toBe(false);
    expect(r.output?.truncated).toBe(false);
    // The runner was invoked with the canonical (in-root) cwd and the default timeout.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe("ls -la");
    expect(runner.calls[0].timeoutMs).toBe(120_000);
  });

  // Anchor: REQ-009. A timeout maps to COMMAND_TIMEOUT (ERR-009), an error result.
  it("test_REQ009_command_timeout", async () => {
    const result: CommandResult = {
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: true,
    };
    const { exec } = tool(result);
    const r = await exec.execute(call({ command: "sleep 999", timeoutMs: 1000 }));

    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("COMMAND_TIMEOUT");
  });

  // Anchor: REQ-009. A spawn failure maps to COMMAND_FAILED (ERR-010), DISTINCT from a
  // non-zero exit — the process never started.
  it("test_REQ009_command_spawn_failure", async () => {
    const result: CommandResult = {
      exitCode: -1,
      stdout: "",
      stderr: "ENOENT: nonsuchbin not found",
      timedOut: false,
      spawnFailed: true,
    };
    const { exec } = tool(result);
    const r = await exec.execute(call({ command: "nonsuchbin --x" }));

    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("COMMAND_FAILED");
    // It is NOT a COMMAND_TIMEOUT and NOT a non-zero-exit "ok" result.
    expect(r.error?.code).not.toBe("COMMAND_TIMEOUT");
  });

  // Anchor: REQ-009. Identical commands are run each time — never deduplicated.
  it("test_REQ009_command_not_deduplicated", async () => {
    const { exec, runner } = tool({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

    await exec.execute(call({ command: "git status" }));
    await exec.execute(call({ command: "git status" }));
    await exec.execute(call({ command: "git status" }));

    // Three identical commands → three distinct runner invocations (no caching).
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls.every((c) => c.command === "git status")).toBe(true);
  });

  // -------------------------------------------------------------- REQ-013 ----

  // Anchor: REQ-013. The detected test command sets isTestRun + emits a tests-run
  // entry carrying `passed`, the PRIMARY completion signal.
  it("test_REQ013_test_run_marks_isTestRun_completion_signal", async () => {
    const transcript = recordingTranscript();
    const { exec } = tool(
      { exitCode: 0, stdout: "All tests passed\n", stderr: "", timedOut: false },
      { testCommand: "npm test", transcript, runId: "run-1" },
    );

    const r = await exec.execute(call({ command: "npm test" }));

    expect(r.status).toBe("ok");
    expect(r.output?.isTestRun).toBe(true);

    // A tests-run entry was emitted with passed:true (exitCode 0) — the completion signal.
    const testsRun = transcript.entries.find((e) => e.type === "tests-run");
    expect(testsRun).toBeDefined();
    expect(testsRun?.payload.command).toBe("npm test");
    expect(testsRun?.payload.passed).toBe(true);
    expect(testsRun?.payload.exitCode).toBe(0);

    // A non-test command does NOT set isTestRun and emits NO tests-run entry.
    const transcript2 = recordingTranscript();
    const { exec: exec2 } = tool(
      { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      { testCommand: "npm test", transcript: transcript2, runId: "run-2" },
    );
    const r2 = await exec2.execute(call({ command: "git status" }));
    expect(r2.output?.isTestRun).toBe(false);
    expect(transcript2.entries.some((e) => e.type === "tests-run")).toBe(false);
  });

  // Anchor: REQ-013. A FAILING test run is a status:"ok" ToolResult carrying exitCode
  // != 0 — a RESULT the agent reasons about, NOT an error (ADR-007). The tests-run
  // signal carries passed:false.
  it("test_REQ013_nonzero_exit_is_result", async () => {
    const transcript = recordingTranscript();
    const { exec } = tool(
      { exitCode: 1, stdout: "", stderr: "2 tests failed\n", timedOut: false },
      { testCommand: "npm test", transcript, runId: "run-3" },
    );

    const r = await exec.execute(call({ command: "npm test" }));

    // NON-ZERO exit is a SUCCESS ToolResult, not an error.
    expect(r.status).toBe("ok");
    expect(r.error).toBeUndefined();
    expect(r.output?.exitCode).toBe(1);
    expect(r.output?.isTestRun).toBe(true);

    // The completion signal reports the failure (passed:false) for the loop to reason about.
    const testsRun = transcript.entries.find((e) => e.type === "tests-run");
    expect(testsRun?.payload.passed).toBe(false);
    expect(testsRun?.payload.exitCode).toBe(1);
  });

  // -------------------------------------------------------------- REQ-021 ----

  // Anchor: REQ-021. A cwd OUTSIDE the root is rejected fail-closed → PATH_ESCAPE,
  // BEFORE the command is gated or spawned (exec-side confinement).
  it("test_REQ021_exec_cwd_escape_rejected", async () => {
    const { exec, runner } = tool({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

    // A sibling dir outside the root.
    const r1 = await exec.execute(call({ command: "ls", cwd: sibling }));
    expect(r1.status).toBe("error");
    expect(r1.error?.code).toBe("PATH_ESCAPE");

    // A traversal that climbs out of the root.
    const r2 = await exec.execute(
      call({ command: "ls", cwd: path.join(root, "..", "sibling") }),
    );
    expect(r2.status).toBe("error");
    expect(r2.error?.code).toBe("PATH_ESCAPE");

    // FAIL-CLOSED ordering: the runner was NEVER invoked (rejection precedes spawn).
    expect(runner.calls).toHaveLength(0);

    // An in-root cwd (the default working root, or a subdir) is allowed.
    const r3 = await exec.execute(call({ command: "ls", cwd: root }));
    expect(r3.status).toBe("ok");
  });

  // -------------------------------------------------- APPROVAL_DENIED path ----

  // Anchor: REQ-016 (exec-side). A denied command → APPROVAL_DENIED error result; the
  // runner is never invoked.
  it("test_REQ016_denied_command_is_approval_denied_result", async () => {
    const runner = createStubCommandRunner({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    const exec = createRunCommandTool({
      sandbox: createPathSandbox(root),
      approval: createApprovalGate({ confirmCommand: async () => "deny" }),
      runner,
      allowlist: createAllowlist(ALLOWLIST),
      policy: { commandMode: "allowlist-confirm" },
      workingRoot: root,
    });

    // `rm -rf /` is non-allowlisted → prompts → user denies → APPROVAL_DENIED.
    const r = await exec.execute(call({ command: "rm -rf /" }));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("APPROVAL_DENIED");
    expect(runner.calls).toHaveLength(0);
  });
});
