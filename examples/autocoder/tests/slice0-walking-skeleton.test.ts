/**
 * SLICE-0 / TASK-001 — walking-skeleton acceptance test.
 *
 * Anchored to REQ-NFR-002 (partial): this is the determinism / stubbed-seam proof
 * for the harness. It drives the full spine — cli (composition root) → config →
 * agent-run → repo-context → STUBBED llm-client → tool-registry → tool-read →
 * path-sandbox.checkRead → approval-gate passthrough → ToolResult → transcript →
 * reporter → RunOutcome — against a temp-dir fixture with NO network call and NO
 * real subprocess. The REQ-NFR-002 anchor below is what `th anchors scan` matches.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAutocoder, transcriptPathFor } from "../src/cli.js";
import { readTranscript } from "../src/transcript.js";
import type { LlmResponse } from "../src/contracts.js";
import { createStubCommandRunner, createStubLlmClient } from "./stubs.js";

// Anchor: REQ-NFR-002 (determinism of harness — stubbed DI seams).
describe("SLICE-0 walking skeleton (REQ-NFR-002)", () => {
  let tmpRoot: string;
  let transcriptDir: string;
  let fixtureFile: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice0-"));
    transcriptDir = path.join(tmpRoot, ".transcripts");
    fixtureFile = path.join(tmpRoot, "README.md");
    await fs.writeFile(fixtureFile, "# fixture\nline two\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /**
   * test_REQNFR002_walking_skeleton_wires_end_to_end
   * (canonical task name: test_slice0_walking_skeleton_wires_end_to_end)
   *
   * Anchor: REQ-NFR-002.
   */
  it("test_slice0_walking_skeleton_wires_end_to_end (REQ-NFR-002)", async () => {
    // Stub the LlmClient: one read_file tool_use, then a finalAnswer.
    const script: LlmResponse[] = [
      {
        toolCalls: [
          {
            id: "call-1",
            toolName: "read_file",
            arguments: { path: fixtureFile },
          },
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
    const llm = createStubLlmClient(script);
    const commandRunner = createStubCommandRunner();

    const outcome = await runAutocoder({
      task: "read the readme",
      root: tmpRoot,
      transcriptDir,
      llm,
      commandRunner,
      runId: "run-slice0",
    });

    // RunOutcome assertion.
    expect(outcome.status).toBe("succeeded");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.runId).toBe("run-slice0");

    // Stubbed-seam determinism: no real subprocess was ever spawned (read path).
    expect(commandRunner.calls).toHaveLength(0);
    // Exactly the two scripted model round-trips occurred (no network beyond stub).
    expect(llm.calls).toHaveLength(2);

    // On-disk transcript: ordered chain in seq order.
    const transcriptFile = transcriptPathFor(transcriptDir, "run-slice0");
    const entries = await readTranscript(transcriptFile);

    // The chain CONTAINS the spine events in order. (SLICE-2 made the loop real,
    // so the transcript now additionally carries context-gathered + per-turn
    // iteration-started entries per IF-015 / design step 4 — see DRIFT-002. The
    // REQ-NFR-002 determinism contract this test anchors is unchanged: the
    // ordered subsequence below still holds, and seq stays monotonic/gap-free.)
    const types = entries.map((e) => e.type);
    const indexOfInOrder = (needles: string[]): number[] => {
      const idxs: number[] = [];
      let from = 0;
      for (const n of needles) {
        const i = types.indexOf(n, from);
        idxs.push(i);
        if (i >= 0) from = i + 1;
      }
      return idxs;
    };
    const spine = indexOfInOrder([
      "run-started",
      "context-gathered",
      "tool-called",
      "tool-result",
      "run-completed",
    ]);
    // Every spine event is present and strictly increasing in seq order.
    for (const i of spine) expect(i).toBeGreaterThanOrEqual(0);
    for (let k = 1; k < spine.length; k++) {
      expect(spine[k]).toBeGreaterThan(spine[k - 1]);
    }

    // seq is monotonic, gap-free, strictly increasing from 0 (INV-009).
    const seqs = entries.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(seqs[0]).toBe(0);

    // The tool-called entry is the read_file dispatch; tool-result is ok.
    const toolCalled = entries.find((e) => e.type === "tool-called");
    expect(toolCalled?.payload.toolName).toBe("read_file");
    const toolResult = entries.find((e) => e.type === "tool-result");
    expect(toolResult?.payload.status).toBe("ok");

    // run-completed carries the succeeded/exit-0 outcome (INV-006).
    const completed = entries.find((e) => e.type === "run-completed");
    expect(completed?.payload.status).toBe("succeeded");
    expect(completed?.payload.exitCode).toBe(0);

    // Every entry carries the versioned envelope (ADR-002).
    for (const e of entries) {
      expect(e.schemaVersion).toBe("1.0");
      expect(e.runId).toBe("run-slice0");
      expect(typeof e.ts).toBe("string");
    }
  });
});
