/**
 * SLICE-10 / TASK-019 — Closed-loop e2e + composite safety + offline determinism.
 *
 * The integration finale: a scripted multi-iteration `LlmClient` stub drives the
 * REAL composed system (the `cli` composition root via `runAutocoder`, which wires
 * ALL FIVE real tool executors + the real budget guard from SLICE-10) against a
 * temp-dir fixture repo. Anchored to:
 *
 *   - REQ-NFR-001 — implementability (meta: the full suite green + zero-gap coverage),
 *   - REQ-NFR-002 — determinism of harness (both seams stubbed, no network/subprocess;
 *     strictly sequential — one ToolCall fully resolved before the next),
 *   - REQ-NFR-005 — safety / least authority (out-of-root write blocked + non-allowlisted
 *     command gated + edit gated, one composite scenario),
 *   - REQ-NFR-007 — portability (the composed run uses the cross-platform PathSandbox +
 *     CommandRunner shell selection; exercised on this host through the real composition).
 *
 * The headline `test_closedloop_plan_edit_test_fail_selfcorrect_pass` proves the
 * Success Criterion "closed loop demonstrated": plan → edit → run tests (stubbed
 * exit 1) → read the failure → corrective edit → run tests (stubbed exit 0) → final
 * answer → exit 0, with every change in the transcript as a diff.
 *
 * NO network, NO real subprocess in the agent path (RULE-015, REQ-NFR-002): the
 * LlmClient and CommandRunner are the two stubbed seams; approval is driven by an
 * injected confirm seam (or auto mode). The ONE allowed real subprocess is the
 * `th coverage check` shell in the REQ-NFR-001 meta-assertion below.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runAutocoder, transcriptPathFor } from "../src/cli.js";
import { readTranscript } from "../src/transcript.js";
import type {
  CommandResult,
  LlmResponse,
  TranscriptEntry,
} from "../src/contracts.js";
import type { ConfirmFn, ConfirmCommandFn } from "../src/approval-gate.js";
import { createStubCommandRunner, createStubLlmClient } from "./stubs.js";

/** Absolute paths for the `th coverage check` meta-assertion (the one real shell). */
const PROJECT_DIR = path.resolve(__dirname, "..");
const TH_CLI = path.resolve(PROJECT_DIR, "..", "..", "dist", "cli.js");

describe("SLICE-10 closed-loop e2e + composite safety (REQ-NFR-001/002/005/007)", () => {
  let root: string;
  let transcriptDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice10-"));
    transcriptDir = path.join(root, ".transcripts");
    // A Node fixture repo so repo-context detects projectType=node + testCommand=
    // "npm test" (the tests-as-signal completion command the closed loop runs).
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { test: "vitest run" } }, null, 2),
      "utf8",
    );
    await fs.writeFile(path.join(root, "sum.js"), "module.exports = (a, b) => a - b;\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Headline closed loop: plan → edit → test-fail → self-correct → test-pass.
  // --------------------------------------------------------------------------

  // Anchor: REQ-NFR-002 (the closed-loop e2e is the determinism finale; named per
  // the task file as test_closedloop_*). Drives the REAL composed system.
  it("test_closedloop_plan_edit_test_fail_selfcorrect_pass (REQ-NFR-002)", async () => {
    const sumPath = path.join(root, "sum.js");
    const testCmd = "npm test";

    // Scripted model: a multi-iteration closed loop. Iteration ordering:
    //   1. write_edit (replace the buggy `-` with `+`, FIRST attempt — but wrong),
    //   2. run_command testCmd  → stubbed exit 1 (tests FAIL),
    //   3. read_file the source to inspect the failure,
    //   4. write_edit (the CORRECTIVE edit that actually fixes it),
    //   5. run_command testCmd  → stubbed exit 0 (tests PASS),
    //   6. finalAnswer (no tool calls) → task-success → exit 0.
    const script: LlmResponse[] = [
      turn([
        {
          id: "edit-1",
          toolName: "write_edit",
          arguments: {
            targetPath: "sum.js",
            mode: "replace",
            search: "a - b",
            replacement: "a * b", // first attempt: still wrong (a*b, not a+b)
          },
        },
      ]),
      turn([{ id: "test-1", toolName: "run_command", arguments: { command: testCmd } }]),
      turn([{ id: "read-1", toolName: "read_file", arguments: { path: sumPath } }]),
      turn([
        {
          id: "edit-2",
          toolName: "write_edit",
          arguments: {
            targetPath: "sum.js",
            mode: "replace",
            search: "a * b",
            replacement: "a + b", // corrective edit: the real fix
          },
        },
      ]),
      turn([{ id: "test-2", toolName: "run_command", arguments: { command: testCmd } }]),
      final("fixed the bug — tests pass"),
    ];

    const llm = createStubLlmClient(script);
    // The test command returns exit 1 on its FIRST run, exit 0 on the SECOND
    // (drives the fail-then-pass sequence). Every other command returns exit 0.
    let testRuns = 0;
    const commandRunner = createStubCommandRunner((command): CommandResult => {
      if (command === testCmd) {
        testRuns += 1;
        return { exitCode: testRuns === 1 ? 1 : 0, stdout: "", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });

    const outcome = await runAutocoder({
      task: "fix the buggy sum function so the tests pass",
      root,
      transcriptDir,
      llm,
      commandRunner,
      runId: "run-closedloop",
      // auto mode so edits + commands proceed deterministically with no prompts.
      editMode: "auto",
      commandMode: "auto",
    });

    // ---- RunOutcome: succeeded, exit 0 (the headline) ----
    expect(outcome.status).toBe("succeeded");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.runId).toBe("run-closedloop");

    // The corrective edit landed on disk (the real write_edit persisted it).
    const finalSource = await fs.readFile(sumPath, "utf8");
    expect(finalSource).toContain("a + b");

    const entries = await readTranscript(transcriptPathFor(transcriptDir, "run-closedloop"));

    // ---- filesChanged: BOTH edits applied + every change carried a Diff ----
    const editApplied = entries.filter((e) => e.type === "edit-applied");
    expect(editApplied.length).toBe(2); // first (wrong) edit + corrective edit
    const editProposed = entries.filter((e) => e.type === "edit-proposed");
    // Each proposed edit carries the unified diff (no silent writes — RULE-002).
    expect(editProposed.length).toBe(2);
    for (const e of editProposed) {
      const diff = e.payload.diff as string;
      expect(typeof diff).toBe("string");
      expect(diff.length).toBeGreaterThan(0);
      // A unified diff has +/- change lines.
      expect(/^[+-]/m.test(diff)).toBe(true);
    }

    // ---- testsResult: the failing-then-passing test runs in SEQUENCE order ----
    const testsRun = entries
      .filter((e) => e.type === "tests-run")
      .sort((a, b) => a.seq - b.seq);
    expect(testsRun.length).toBe(2);
    expect(testsRun[0].payload.passed).toBe(false); // first run FAILED (exit 1)
    expect(testsRun[0].payload.exitCode).toBe(1);
    expect(testsRun[1].payload.passed).toBe(true); // second run PASSED (exit 0)
    expect(testsRun[1].payload.exitCode).toBe(0);
    // The fail strictly precedes the pass (the self-correct happened between them).
    expect(testsRun[0].seq).toBeLessThan(testsRun[1].seq);

    // ---- The full plan→edit→test order is preserved in the transcript ----
    // Subsequence: edit-applied (1st) → tests-run(fail) → edit-applied (corrective)
    // → tests-run(pass) → run-completed(succeeded).
    const seqOf = (pred: (e: TranscriptEntry) => boolean): number => {
      const found = entries.find(pred);
      return found ? found.seq : -1;
    };
    const firstEditSeq = editApplied[0].seq;
    const failSeq = testsRun[0].seq;
    const correctiveEditSeq = editApplied[1].seq;
    const passSeq = testsRun[1].seq;
    const completedSeq = seqOf((e) => e.type === "run-completed");
    expect(firstEditSeq).toBeLessThan(failSeq);
    expect(failSeq).toBeLessThan(correctiveEditSeq);
    expect(correctiveEditSeq).toBeLessThan(passSeq);
    expect(passSeq).toBeLessThan(completedSeq);

    // ---- Determinism: exactly the scripted round-trips; no extra network ----
    expect(llm.calls).toHaveLength(script.length);
    // The test command ran exactly twice (fail then pass) — no real subprocess.
    expect(testRuns).toBe(2);
    // The run-completed row records the succeeded/exit-0 outcome (INV-006).
    const completed = entries.find((e) => e.type === "run-completed");
    expect(completed?.payload.status).toBe("succeeded");
    expect(completed?.payload.exitCode).toBe(0);
  });

  // --------------------------------------------------------------------------
  // REQ-NFR-002 — offline determinism: full loop to outcome, both seams stubbed.
  // --------------------------------------------------------------------------

  // Anchor: REQ-NFR-002.
  it("test_REQNFR002_harness_runs_offline_with_stubbed_seams", async () => {
    const script: LlmResponse[] = [
      turn([{ id: "r1", toolName: "read_file", arguments: { path: path.join(root, "sum.js") } }]),
      turn([{ id: "ls1", toolName: "list_search", arguments: { mode: "list", path: "." } }]),
      final("inspected the repo"),
    ];
    const llm = createStubLlmClient(script);
    // Both edges are the only injected seams; no network, no real subprocess.
    const commandRunner = createStubCommandRunner({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });

    const outcome = await runAutocoder({
      task: "inspect the repo",
      root,
      transcriptDir,
      llm,
      commandRunner,
      runId: "run-offline",
      editMode: "auto",
      commandMode: "auto",
    });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.exitCode).toBe(0);
    // No command ever spawned (this loop only read/listed) — fully offline.
    expect(commandRunner.calls).toHaveLength(0);
    // Exactly the scripted model round-trips (the StubLlmClient throws if over-called,
    // proving there was no hidden network fallback).
    expect(llm.calls).toHaveLength(script.length);

    const entries = await readTranscript(transcriptPathFor(transcriptDir, "run-offline"));
    // seq is monotonic, gap-free from 0 (single writer — INV-009 / REQ-NFR-002).
    const seqs = entries.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  // Anchor: REQ-NFR-002 — strictly sequential: one ToolCall fully resolved before
  // the next; single transcript writer (ordering proves no in-process race).
  it("test_REQNFR002_sequential_no_inprocess_race", async () => {
    // One turn carrying THREE tool calls; the loop must resolve each (tool-called →
    // tool-result) before the next begins. Assert the strict interleaving.
    const script: LlmResponse[] = [
      turn([
        { id: "a", toolName: "read_file", arguments: { path: path.join(root, "sum.js") } },
        { id: "b", toolName: "read_file", arguments: { path: path.join(root, "package.json") } },
        { id: "c", toolName: "list_search", arguments: { mode: "list", path: "." } },
      ]),
      final("done"),
    ];
    const llm = createStubLlmClient(script);
    const commandRunner = createStubCommandRunner();

    await runAutocoder({
      task: "read three things",
      root,
      transcriptDir,
      llm,
      commandRunner,
      runId: "run-seq",
      editMode: "auto",
      commandMode: "auto",
    });

    const entries = await readTranscript(transcriptPathFor(transcriptDir, "run-seq"));
    // Filter to the tool-called / tool-result pairs in seq order.
    const toolRows = entries
      .filter((e) => e.type === "tool-called" || e.type === "tool-result")
      .sort((a, b) => a.seq - b.seq);
    // Strict alternation: called(a) result(a) called(b) result(b) called(c) result(c).
    expect(toolRows.map((e) => e.type)).toEqual([
      "tool-called",
      "tool-result",
      "tool-called",
      "tool-result",
      "tool-called",
      "tool-result",
    ]);
    // The id order is preserved A → B → C (one fully resolved before the next).
    const calledIds = toolRows
      .filter((e) => e.type === "tool-called")
      .map((e) => e.payload.toolCallId);
    expect(calledIds).toEqual(["a", "b", "c"]);
    const resultIds = toolRows
      .filter((e) => e.type === "tool-result")
      .map((e) => e.payload.toolCallId);
    expect(resultIds).toEqual(["a", "b", "c"]);
    // Single transcript writer: seq is gap-free / strictly increasing (no concurrent
    // writer could interleave a gap or duplicate — INV-009).
    const seqs = entries.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  // --------------------------------------------------------------------------
  // REQ-NFR-005 — composite safety: out-of-root write blocked + non-allowlisted
  // command gated + edit gated, in ONE confirm-each scenario with a deny seam.
  // --------------------------------------------------------------------------

  // Anchor: REQ-NFR-005.
  it("test_REQNFR005_writes_confined_commands_gated_edits_gated", async () => {
    // An out-of-root path: a sibling of the temp root (escapes the working root).
    const outOfRoot = path.join(path.dirname(root), "ESCAPE.txt");

    // The model attempts, in sequence:
    //   1. an OUT-OF-ROOT write_edit → PATH_ESCAPE (blocked, fail-closed — REQ-021),
    //   2. a NON-ALLOWLISTED command (rm -rf) → gated, user DENIES (REQ-016),
    //   3. an in-root edit → gated, user DENIES (REQ-012),
    //   4. finalAnswer.
    const script: LlmResponse[] = [
      turn([
        {
          id: "escape-write",
          toolName: "write_edit",
          arguments: { targetPath: outOfRoot, mode: "write", content: "pwned" },
        },
      ]),
      turn([{ id: "danger-cmd", toolName: "run_command", arguments: { command: "rm -rf /" } }]),
      turn([
        {
          id: "in-root-edit",
          toolName: "write_edit",
          arguments: {
            targetPath: "sum.js",
            mode: "replace",
            search: "a - b",
            replacement: "a + b",
          },
        },
      ]),
      final("attempted (all gated/blocked)"),
    ];
    const llm = createStubLlmClient(script);
    const commandRunner = createStubCommandRunner();

    // Confirm-each mode with injected seams that DENY every prompt — so a gated edit/
    // command is rejected (not silently run). Record whether each seam was consulted.
    const editPrompts: string[] = [];
    const confirm: ConfirmFn = async (p) => {
      editPrompts.push(p.targetPath);
      return "deny";
    };
    const cmdPrompts: string[] = [];
    const confirmCommand: ConfirmCommandFn = async (p) => {
      cmdPrompts.push(p.command);
      return "deny";
    };

    const outcome = await runAutocoder({
      task: "try to escape, run a dangerous command, and edit a file",
      root,
      transcriptDir,
      llm,
      commandRunner,
      runId: "run-safety",
      editMode: "confirm-each",
      commandMode: "allowlist-confirm",
      confirm,
      confirmCommand,
    });

    // The run still completes cleanly (each gated action returns an error ToolResult;
    // the loop continues and the model finalizes) → task-success.
    expect(outcome.status).toBe("succeeded");

    const entries = await readTranscript(transcriptPathFor(transcriptDir, "run-safety"));
    const resultFor = (id: string): TranscriptEntry | undefined => {
      // The tool-result row is the one whose payload.toolCallId matches AND is a result.
      return entries.find(
        (e) => e.type === "tool-result" && e.payload.toolCallId === id,
      );
    };

    // 1. OUT-OF-ROOT write → PATH_ESCAPE (REQ-021), blocked fail-closed. The
    //    confine primitive rejected it BEFORE any prompt — so the edit seam was
    //    NOT consulted for the out-of-root target (no diff, no approval, no write).
    const escapeResult = resultFor("escape-write");
    expect(escapeResult?.payload.status).toBe("error");
    expect(escapeResult?.payload.errorCode).toBe("PATH_ESCAPE");
    expect(editPrompts).not.toContain(outOfRoot);
    // The out-of-root file was never created on disk (zero side effect).
    await expect(fs.stat(outOfRoot)).rejects.toBeDefined();

    // 2. NON-ALLOWLISTED command → gated (the command confirm seam WAS consulted),
    //    user denied → APPROVAL_DENIED (REQ-016); the command never ran.
    expect(cmdPrompts).toContain("rm -rf /");
    const cmdResult = resultFor("danger-cmd");
    expect(cmdResult?.payload.status).toBe("error");
    expect(cmdResult?.payload.errorCode).toBe("APPROVAL_DENIED");
    expect(commandRunner.calls).toHaveLength(0); // no real spawn at all

    // 3. IN-ROOT edit → gated (the edit confirm seam WAS consulted for sum.js), user
    //    denied → APPROVAL_DENIED (REQ-012); the file was NOT modified.
    expect(editPrompts).toContain("sum.js");
    const editResult = resultFor("in-root-edit");
    expect(editResult?.payload.status).toBe("error");
    expect(editResult?.payload.errorCode).toBe("APPROVAL_DENIED");
    const unchanged = await fs.readFile(path.join(root, "sum.js"), "utf8");
    expect(unchanged).toContain("a - b"); // the original (un-edited) source
  });

  // --------------------------------------------------------------------------
  // REQ-NFR-001 — implementability (meta): the full suite is green AND
  // `th coverage check` reports ZERO gaps across all 33 requirements.
  // --------------------------------------------------------------------------

  // Anchor: REQ-NFR-001.
  it("test_REQNFR001_implementability_all_functional_reqs_tested", () => {
    // The ONE allowed real subprocess (the task file's explicit exception): shell the
    // `th` CLI's coverage check against this project and assert exit 0 + zero gaps.
    // This is NOT the agent path (no LlmClient / CommandRunner) — it is the harness's
    // own coverage gate, proving every REQ maps to ≥1 test (REQ-NFR-001 meta). The CLI
    // writes the human "coverage complete" line to STDOUT and the machine JSON summary
    // (with the gaps count) to STDERR, exiting 0 IFF there are zero gaps. spawnSync
    // gives both streams + the exit status in one non-throwing call.
    const res = spawnSync("node", [TH_CLI, "--cwd", PROJECT_DIR, "coverage", "check"], {
      encoding: "utf8",
    });
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    const exitCode = res.status ?? 1;

    // Zero gaps: exit 0 is the DoD gate; the human stdout confirms it, and the JSON
    // summary on stderr reports gaps:0 / covered==total across all 33 requirements.
    expect(exitCode).toBe(0);
    expect(stdout).toContain("33/33");
    const jsonLine =
      stderr
        .trim()
        .split("\n")
        .find((l) => l.trim().startsWith("{")) ?? "{}";
    const summary = JSON.parse(jsonLine) as { total: number; covered: number; gaps: number };
    expect(summary.gaps).toBe(0);
    expect(summary.covered).toBe(summary.total);
    // All 33 requirements (REQ-001..025 + REQ-NFR-001..008) are mapped.
    expect(summary.total).toBe(33);
  });
});

/** Build a tool-use turn (a model response carrying one+ tool calls, no final). */
function turn(toolCalls: LlmResponse["toolCalls"]): LlmResponse {
  return {
    toolCalls,
    finalAnswer: null,
    stopReason: "tool_use",
    usage: { inputTokens: 8, outputTokens: 4, estimated: false },
  };
}

/** Build a final-answer turn (no tool calls → task-success → exit 0). */
function final(answer: string): LlmResponse {
  return {
    toolCalls: null,
    finalAnswer: answer,
    stopReason: "end_turn",
    usage: { inputTokens: 6, outputTokens: 2, estimated: false },
  };
}
