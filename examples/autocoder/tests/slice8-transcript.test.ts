/**
 * SLICE-8 / TASK-016 — TranscriptWriter: append-only JSONL, durable, fatal-on-fail
 * (REQ-022, REQ-NFR-008).
 *
 * Anchored to REQ-022 (a run transcript / log of iterations, tool calls, tool
 * results, and decisions is recorded for inspection/debugging) and REQ-NFR-008 (the
 * transcript is sufficient to RECONSTRUCT what the agent did and why — each tool
 * call's inputs/outputs and each stop decision).
 *
 * These prove OBSERVABLE behavior, not implementation: a real run's JSONL is
 * append-only + strictly seq-ordered and reconstructs the run; a write/flush failure
 * is FATAL (TRANSCRIPT_WRITE_FAILED → unrecoverable-error → Failed); a crash loses at
 * most the in-flight last line (parse-skip); each entry is durable before `append`
 * returns; a read outside the root is recorded (read-exposure audit); and a single
 * writer owns the run. Temp-dir fixtures, no network, no real subprocess.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentRun } from "../src/agent-run.js";
import { createBudgetController } from "../src/budget-stop.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createReadTool } from "../src/tool-read.js";
import { createPathSandbox } from "../src/path-sandbox.js";
import { createReporter } from "../src/reporter.js";
import {
  createTranscriptWriter,
  readTranscript,
  isTranscriptWriteError,
  TRANSCRIPT_WRITE_FAILED,
} from "../src/transcript.js";
import { buildRepoContext } from "../src/repo-context.js";
import { SCHEMA_VERSION } from "../src/contracts.js";
import type {
  LlmResponse,
  ToolRegistry,
  TranscriptEntryInput,
  TranscriptWriter,
} from "../src/contracts.js";
import { createStubLlmClient } from "./stubs.js";

describe("SLICE-8 TranscriptWriter durable append-only JSONL (REQ-022 / REQ-NFR-008)", () => {
  let root: string;
  let transcriptDir: string;
  let fixtureFile: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice8-tx-"));
    transcriptDir = path.join(root, ".transcripts");
    fixtureFile = path.join(root, "README.md");
    await fs.writeFile(fixtureFile, "# fixture\nline two\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function realRegistry(readPath: string = root): ToolRegistry {
    const sandbox = createPathSandbox(readPath);
    return createToolRegistry(createReadTool(sandbox));
  }

  /** Drive the real loop with a scripted model; return outcome + on-disk entries. */
  async function runLoop(opts: {
    script: LlmResponse[];
    registry?: ToolRegistry;
    transcript?: TranscriptWriter;
    runId?: string;
  }) {
    const llm = createStubLlmClient(opts.script);
    const registry = opts.registry ?? realRegistry();
    const transcript = opts.transcript ?? createTranscriptWriter({ dir: transcriptDir });
    const reporter = createReporter();
    const context = buildRepoContext(root);
    const runId = opts.runId ?? "run-tx";
    const budget = createBudgetController({ maxIterations: 25, tokenBudget: 1_000_000 });
    const agentRun = createAgentRun({
      runId,
      task: "do the thing",
      root,
      modelId: "stub-model",
      context,
      llm,
      registry,
      transcript,
      reporter,
      budget,
    });
    const outcome = await agentRun.run();
    let entries: Awaited<ReturnType<typeof readTranscript>> = [];
    try {
      entries = await readTranscript(path.join(transcriptDir, `${runId}.jsonl`));
    } catch {
      // Some fault-injection tests intentionally leave no readable file.
    }
    return { outcome, entries };
  }

  /** A read-then-finalize script the loop can replay deterministically. */
  function readThenFinalize(readPath: string): LlmResponse[] {
    return [
      {
        toolCalls: [{ id: "call-1", toolName: "read_file", arguments: { path: readPath } }],
        finalAnswer: null,
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 2, estimated: false },
      },
      {
        toolCalls: null,
        finalAnswer: "done",
        stopReason: "end_turn",
        usage: { inputTokens: 4, outputTokens: 1, estimated: false },
      },
    ];
  }

  // Anchor: REQ-022.
  it("test_REQ022_transcript_records_iterations_calls_results", async () => {
    // A full run's JSONL is an append-only, strictly seq-ordered chain that records
    // iterations, the tool call, the tool result, and the stop decision.
    const { outcome, entries } = await runLoop({
      script: readThenFinalize(fixtureFile),
      runId: "run-records",
    });
    expect(outcome.status).toBe("succeeded");

    // seq is gap-free, strictly increasing from 0 (INV-009 — append-only ordering).
    const seqs = entries.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(seqs[0]).toBe(0);

    // The recorded chain includes iterations, the call, the result, and the decision.
    const types = entries.map((e) => e.type);
    expect(types).toContain("iteration-started");
    expect(types).toContain("tool-called");
    expect(types).toContain("tool-result");
    expect(types).toContain("run-stopped");
    expect(types).toContain("run-completed");

    // Every entry carries the versioned envelope (ADR-002 / IF-015) with an ISO ts.
    for (const e of entries) {
      expect(e.schemaVersion).toBe(SCHEMA_VERSION);
      expect(e.runId).toBe("run-records");
      expect(typeof e.type).toBe("string");
      expect(typeof e.payload).toBe("object");
      // ts is ISO-8601 UTC — round-trips through Date and ends in Z.
      expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
    }
  });

  // Anchor: REQ-022.
  it("test_REQ022_transcript_write_fatal", async () => {
    // A write/flush failure is FATAL (ERR-014): append throws TRANSCRIPT_WRITE_FAILED
    // and agent-run routes it through its terminal classifier to unrecoverable-error →
    // Failed (RULE-010, ABU-010). Wrap a real writer so a mid-run append (the loop's
    // iteration-started, inside agent-run's run-lifecycle catch) fails on the durable
    // write — exactly as a real fsync/disk failure would surface.
    const real = createTranscriptWriter({ dir: transcriptDir });
    const failing: TranscriptWriter = {
      open: (runId) => real.open(runId),
      async append(entry: TranscriptEntryInput) {
        if (entry.type === "iteration-started") {
          // Simulate the durable-write failure the real writer raises on fsync error.
          const { TranscriptWriteError } = await import("../src/transcript.js");
          throw new TranscriptWriteError("simulated disk failure on append");
        }
        return real.append(entry);
      },
      flush: () => real.flush(),
    };

    const { outcome } = await runLoop({
      script: readThenFinalize(fixtureFile),
      transcript: failing,
      runId: "run-writefail",
    });
    // The fatal write surfaces as unrecoverable-error → Failed, non-zero exit (never
    // a silently-lost audit and never a crash).
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).not.toBe(0);

    // The error class itself is the stable TRANSCRIPT_WRITE_FAILED code (ERR-014).
    const { TranscriptWriteError } = await import("../src/transcript.js");
    const err = new TranscriptWriteError("x");
    expect(err.code).toBe(TRANSCRIPT_WRITE_FAILED);
    expect(isTranscriptWriteError(err)).toBe(true);
  });

  // Anchor: REQ-022.
  it("test_REQ022_crash_partial_last_line_tolerated", async () => {
    // A crash mid-write leaves a PARTIAL last line. The reader parse-SKIPS it and
    // recovers the durable prefix (a crash loses at most the in-flight line, ADR-002).
    const { entries } = await runLoop({
      script: readThenFinalize(fixtureFile),
      runId: "run-crash",
    });
    const file = path.join(transcriptDir, "run-crash.jsonl");
    const durableCount = entries.length;
    expect(durableCount).toBeGreaterThan(0);

    // Append a TRUNCATED (partial) JSON line, as a crash mid-fsync would leave.
    await fs.appendFile(file, '{"schemaVersion":"1.0","seq":99,"ts":"2026-', "utf8");

    // The reader tolerates the partial last line — it does NOT throw and returns
    // exactly the durable prefix (no phantom 100th entry).
    const recovered = await readTranscript(file);
    expect(recovered).toHaveLength(durableCount);
    const seqs = recovered.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i)); // still gap-free after recovery
  });

  // Anchor: REQ-022.
  it("test_REQ022_single_writer_transcript", async () => {
    // A single writer owns the run: one open() handle, monotonic seq assigned by the
    // writer alone. Even across many appends the seqs never collide or gap, and the
    // file is the single per-run chain (no concurrent second chain).
    const writer = createTranscriptWriter({ dir: transcriptDir });
    await writer.open("run-single");
    for (let i = 0; i < 12; i++) {
      await writer.append({
        schemaVersion: SCHEMA_VERSION,
        ts: new Date().toISOString(),
        runId: "run-single",
        type: "iteration-started",
        payload: { index: i },
      });
    }
    await writer.flush();
    const entries = await readTranscript(path.join(transcriptDir, "run-single.jsonl"));
    // The writer (not the caller) assigned seq: gap-free 0..11, one chain.
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // The payload index the caller passed is preserved alongside the writer's seq.
    expect(entries.map((e) => e.payload.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  // Anchor: REQ-022.
  it("test_REQ022_transcript_durable_per_entry", async () => {
    // Each entry is durable BEFORE append returns: after an awaited append, the line
    // is already readable on disk (no buffered-and-lost write). Read between appends.
    const writer = createTranscriptWriter({ dir: transcriptDir });
    await writer.open("run-durable");
    const file = path.join(transcriptDir, "run-durable.jsonl");

    await writer.append({
      schemaVersion: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      runId: "run-durable",
      type: "run-started",
      payload: { task: "t", root, modelId: "m" },
    });
    // Immediately readable — the first entry was fsynced before append resolved.
    let onDisk = await readTranscript(file);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].type).toBe("run-started");
    expect(onDisk[0].seq).toBe(0);

    await writer.append({
      schemaVersion: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      runId: "run-durable",
      type: "run-completed",
      payload: { status: "succeeded", exitCode: 0 },
    });
    // The second entry is durable too — both are present and ordered.
    onDisk = await readTranscript(file);
    expect(onDisk).toHaveLength(2);
    expect(onDisk[1].type).toBe("run-completed");
    expect(onDisk[1].seq).toBe(1);
  });

  // Anchor: REQ-022.
  it("test_REQ022_read_outside_root_recorded_in_transcript", async () => {
    // A read OUTSIDE the working root is permitted (read-anywhere, INV-002) but must
    // be RECORDED for the read-exposure audit (ABU-002): the tool-called entry carries
    // the outside path in its arguments so the run is reconstructable/auditable.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice8-out-"));
    const outsideFile = path.join(outside, "secret.txt");
    await fs.writeFile(outsideFile, "outside the root\n", "utf8");
    try {
      const { entries } = await runLoop({
        script: readThenFinalize(outsideFile),
        registry: realRegistry(root), // sandbox rooted at `root`; the read is outside it
        runId: "run-readoutside",
      });
      const called = entries.find((e) => e.type === "tool-called");
      expect(called).toBeDefined();
      expect(called?.payload.toolName).toBe("read_file");
      // The outside path is recorded in the audit entry (read exposure is visible).
      expect((called?.payload.arguments as { path?: string })?.path).toBe(outsideFile);
      // The read succeeded (read-anywhere) and the result is recorded too.
      const result = entries.find((e) => e.type === "tool-result");
      expect(result?.payload.status).toBe("ok");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  // Anchor: REQ-NFR-008.
  it("test_REQNFR008_transcript_reconstructs_calls_results_decisions", async () => {
    // The transcript is sufficient to RECONSTRUCT the run: each tool call's input
    // (tool-called.arguments) correlates to its output (tool-result by toolCallId),
    // and the stop DECISION (run-stopped.stopCondition + run-completed status/exit) is
    // present and seq-ordered.
    const { entries } = await runLoop({
      script: readThenFinalize(fixtureFile),
      runId: "run-reconstruct",
    });

    // Tool call I/O correlation: the call's id matches its recorded result's id.
    const called = entries.find((e) => e.type === "tool-called");
    const result = entries.find((e) => e.type === "tool-result");
    expect(called).toBeDefined();
    expect(result).toBeDefined();
    expect(called?.payload.toolCallId).toBe("call-1");
    expect(result?.payload.toolCallId).toBe("call-1");
    expect((called?.payload.arguments as { path?: string })?.path).toBe(fixtureFile);
    expect(result?.payload.status).toBe("ok");

    // The stop decision is recorded: exactly one run-stopped with the StopCondition,
    // and a run-completed carrying the derived status + exitCode (INV-006).
    const stopped = entries.filter((e) => e.type === "run-stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0].payload.stopCondition).toBe("task-success");
    const completed = entries.find((e) => e.type === "run-completed");
    expect(completed?.payload.status).toBe("succeeded");
    expect(completed?.payload.exitCode).toBe(0);

    // Decisions come AFTER the calls they summarize (seq-ordered reconstruction).
    const seqOf = (t: string) => entries.find((e) => e.type === t)?.seq ?? -1;
    expect(seqOf("tool-called")).toBeLessThan(seqOf("tool-result"));
    expect(seqOf("tool-result")).toBeLessThan(seqOf("run-stopped"));
    expect(seqOf("run-stopped")).toBeLessThan(seqOf("run-completed"));
  });
});
