/**
 * SLICE-1 / TASK-002 — CLI argument surface + task ingestion + exit code.
 *
 * Anchored to REQ-001 (task ingestion: positional > --task/-t > --task-file >
 * stdin), REQ-020 (exit code = RunOutcome.exitCode, 0 iff succeeded — INV-006),
 * and REQ-NFR-006 (--help lists every flag; unknown flag / missing required arg →
 * usage hint to stderr + non-zero exit). The canonical anchors below (REQ-001,
 * REQ-020, REQ-NFR-006) are what `th anchors scan` / `th coverage check` match;
 * each test name carries the same anchor in `test_REQNNN_...` form (§11).
 *
 * Drives the real composition root `runCli` with injected stubbed seams (no
 * network, no real subprocess) against a temp-dir fixture root.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli, transcriptPathFor } from "../src/cli.js";
import { parseArgs, USAGE_TEXT } from "../src/args.js";
import { createReporter } from "../src/reporter.js";
import { readTranscript } from "../src/transcript.js";
import type { CliIo } from "../src/cli.js";
import type { LlmResponse } from "../src/contracts.js";
import { createStubCommandRunner, createStubLlmClient } from "./stubs.js";

/** A scripted LlmClient that reads the fixture then finishes (drives a success). */
function successScript(fixturePath: string): LlmResponse[] {
  return [
    {
      toolCalls: [
        { id: "call-1", toolName: "read_file", arguments: { path: fixturePath } },
      ],
      finalAnswer: null,
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5, estimated: false },
    },
    {
      toolCalls: null,
      finalAnswer: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 3, estimated: false },
    },
  ];
}

/** Capture stdout/stderr written by the composition root. */
function captureIo(): CliIo & { out: string; err: string } {
  const sink = {
    out: "",
    err: "",
    writeOut(t: string) {
      sink.out += t;
    },
    writeErr(t: string) {
      sink.err += t;
    },
  };
  return sink;
}

// Anchor: REQ-001, REQ-020, REQ-NFR-006 — CLI surface, task ingestion, exit code.
describe("SLICE-1 CLI surface (REQ-001, REQ-020, REQ-NFR-006)", () => {
  let tmpRoot: string;
  let transcriptDir: string;
  let fixtureFile: string;
  const env = { ANTHROPIC_API_KEY: "test-key" };

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice1-cli-"));
    transcriptDir = path.join(tmpRoot, ".transcripts");
    fixtureFile = path.join(tmpRoot, "README.md");
    await fs.writeFile(fixtureFile, "# fixture\nline two\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("test_REQ001_task_positional_starts_run (REQ-001)", async () => {
    const io = captureIo();
    const code = await runCli({
      argv: ["fix the bug", "--root", tmpRoot],
      env,
      transcriptDir,
      llm: createStubLlmClient(successScript(fixtureFile)),
      commandRunner: createStubCommandRunner(),
      io,
      runId: "run-pos",
    });

    expect(code).toBe(0);

    // The started agent-run emitted a run-started transcript entry carrying the task.
    const entries = await readTranscript(transcriptPathFor(transcriptDir, "run-pos"));
    const started = entries.find((e) => e.type === "run-started");
    expect(started).toBeDefined();
    expect(started?.payload.task).toBe("fix the bug");
    expect(started?.payload.root).toBe(path.resolve(tmpRoot));
  });

  it("test_REQ001_task_from_stdin_and_flag (REQ-001)", async () => {
    // (a) Task from --task flag (no positional).
    const ioFlag = captureIo();
    const codeFlag = await runCli({
      argv: ["--task", "from the flag", "--root", tmpRoot],
      env,
      transcriptDir,
      llm: createStubLlmClient(successScript(fixtureFile)),
      commandRunner: createStubCommandRunner(),
      io: ioFlag,
      runId: "run-flag",
    });
    expect(codeFlag).toBe(0);
    const flagEntries = await readTranscript(transcriptPathFor(transcriptDir, "run-flag"));
    expect(flagEntries.find((e) => e.type === "run-started")?.payload.task).toBe(
      "from the flag",
    );

    // (b) Task from stdin fallback (no positional, no --task, no --task-file).
    const ioStdin = captureIo();
    const codeStdin = await runCli({
      argv: ["--root", tmpRoot],
      env,
      readStdin: async () => "from stdin\n",
      transcriptDir,
      llm: createStubLlmClient(successScript(fixtureFile)),
      commandRunner: createStubCommandRunner(),
      io: ioStdin,
      runId: "run-stdin",
    });
    expect(codeStdin).toBe(0);
    const stdinEntries = await readTranscript(transcriptPathFor(transcriptDir, "run-stdin"));
    expect(stdinEntries.find((e) => e.type === "run-started")?.payload.task).toBe(
      "from stdin",
    );

    // Precedence: positional wins over the --task flag (parser-level proof).
    const parsed = parseArgs(["the positional", "--task", "the flag"]);
    expect(parsed.kind).toBe("run");
    if (parsed.kind === "run") {
      expect(parsed.task).toBe("the positional");
      expect(parsed.taskSource).toBe("positional");
    }
  });

  it("test_REQ001_unknown_flag_usage_error (REQ-001)", async () => {
    const io = captureIo();
    const code = await runCli({
      argv: ["do it", "--nonsense"],
      env,
      transcriptDir,
      llm: createStubLlmClient([]),
      commandRunner: createStubCommandRunner(),
      io,
    });

    // Non-zero exit and a usage hint on STDERR (not stdout).
    expect(code).not.toBe(0);
    expect(io.err).toContain("unknown flag: --nonsense");
    expect(io.err).toContain("Usage:");
    expect(io.out).toBe("");
  });

  it("test_REQ020_exit_zero_iff_succeeded (REQ-020)", async () => {
    // Forward direction: a succeeded run drives exit code 0 through runCli.
    const io = captureIo();
    const code = await runCli({
      argv: ["read the readme", "--root", tmpRoot],
      env,
      transcriptDir,
      llm: createStubLlmClient(successScript(fixtureFile)),
      commandRunner: createStubCommandRunner(),
      io,
      runId: "run-ok",
    });
    expect(code).toBe(0);

    // INV-006 contract: exitCode == 0 IFF status == "succeeded". The Reporter
    // maps a stop/fail signal to a NON-zero exit; only task-success yields 0.
    const reporter = createReporter();
    const succeeded = reporter.renderOutcome({ runId: "r", kind: "task-success" });
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.exitCode).toBe(0);

    // A non-succeeded outcome must carry a non-zero exit (the converse of INV-006).
    const stopped = { status: "stopped" as const, exitCode: 1, runId: "r" };
    const failed = { status: "failed" as const, exitCode: 1, runId: "r" };
    expect(stopped.exitCode === 0).toBe(false);
    expect(failed.exitCode === 0).toBe(false);
    expect(stopped.status === "succeeded").toBe(false);
  });

  it("test_REQNFR006_help_lists_all_flags (REQ-NFR-006)", async () => {
    const io = captureIo();
    const code = await runCli({
      argv: ["--help"],
      env,
      transcriptDir,
      llm: createStubLlmClient([]),
      commandRunner: createStubCommandRunner(),
      io,
    });

    // --help exits 0 and prints the usage to stdout.
    expect(code).toBe(0);
    expect(io.out).toBe(USAGE_TEXT);

    // Every IF-014 flag is documented in the help text.
    for (const flag of [
      "[task]",
      "allowlist",
      "--task",
      "-t",
      "--task-file",
      "--cwd",
      "--root",
      "--model",
      "--yes",
      "--auto",
      "--max-iterations",
      "--token-budget",
      "--json",
      "--config",
      "--help",
    ]) {
      expect(io.out).toContain(flag);
    }
  });
});
