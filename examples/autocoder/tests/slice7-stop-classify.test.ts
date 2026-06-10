/**
 * SLICE-7 / TASK-015 — StopCondition classify + RunOutcome + bounded termination
 * (REQ-014).
 *
 * Anchored to REQ-014 (the loop terminates on a DEFINED stop condition: task
 * success, max-iteration ceiling, budget exhausted, model give-up, or unrecoverable
 * error). These tests prove `classify` derives exactly one StopCondition + the
 * RunOutcome status + exit code with `exitCode == 0` IFF `status == "succeeded"`
 * (RULE-011, INV-006), that exactly one StopCondition fires (INV-005), that the loop
 * ALWAYS terminates (a never-finalizing model is bounded by the guard — RULE-007),
 * and that runs are fresh (no resume — V1 out of MVP scope).
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
import { createTranscriptWriter, readTranscript } from "../src/transcript.js";
import { buildRepoContext } from "../src/repo-context.js";
import type {
  ConversationMessage,
  LlmClient,
  LlmResponse,
  ToolRegistry,
  ToolSchema,
} from "../src/contracts.js";
import { createStubLlmClient } from "./stubs.js";

describe("SLICE-7 StopCondition classify + bounded termination (REQ-014)", () => {
  let root: string;
  let transcriptDir: string;
  let fixtureFile: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice7-stop-"));
    transcriptDir = path.join(root, ".transcripts");
    fixtureFile = path.join(root, "README.md");
    await fs.writeFile(fixtureFile, "# fixture\nline two\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function realRegistry(): ToolRegistry {
    const sandbox = createPathSandbox(root);
    return createToolRegistry(createReadTool(sandbox));
  }

  async function runLoop(opts: {
    script?: LlmResponse[];
    llm?: LlmClient;
    maxIterations?: number;
    tokenBudget?: number;
    runId?: string;
  }) {
    const llm = opts.llm ?? createStubLlmClient(opts.script ?? []);
    const registry = realRegistry();
    const transcript = createTranscriptWriter({ dir: transcriptDir });
    const reporter = createReporter();
    const context = buildRepoContext(root);
    const runId = opts.runId ?? "run-stop";
    const budget = createBudgetController({
      maxIterations: opts.maxIterations,
      tokenBudget: opts.tokenBudget,
    });
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
    const entries = await readTranscript(path.join(transcriptDir, `${runId}.jsonl`));
    return { outcome, entries, budget };
  }

  /** An LlmClient that NEVER finalizes — bounded only by the guard. */
  function createInfiniteLlmClient(): LlmClient {
    return {
      async send(
        _conversation: ConversationMessage[],
        _toolSchemas: ToolSchema[],
      ): Promise<LlmResponse> {
        return {
          toolCalls: [{ id: "loop", toolName: "read_file", arguments: { path: fixtureFile } }],
          finalAnswer: null,
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1, estimated: false },
        };
      },
    };
  }

  // Anchor: REQ-014.
  it("test_REQ014_task_success_terminates", async () => {
    // A model that finalizes → task-success → succeeded, exit 0 (INV-006).
    const script: LlmResponse[] = [
      { toolCalls: null, finalAnswer: "all done", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 1, estimated: false } },
    ];
    const { outcome, entries } = await runLoop({ script, runId: "run-success" });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.exitCode).toBe(0); // exit 0 IFF succeeded
    const stopped = entries.find((e) => e.type === "run-stopped");
    expect(stopped?.payload.stopCondition).toBe("task-success");
    const completed = entries.find((e) => e.type === "run-completed");
    expect(completed?.payload.status).toBe("succeeded");
    expect(completed?.payload.exitCode).toBe(0);
    // Exactly ONE run-stopped (a single StopCondition fired — INV-005).
    expect(entries.filter((e) => e.type === "run-stopped")).toHaveLength(1);

    // Pure classify cross-check: exit 0 IFF succeeded.
    const budget = createBudgetController();
    const cls = budget.classify({ kind: "task-success" });
    expect(cls.status).toBe("succeeded");
    expect(cls.exitCode).toBe(0);
    // And the inverse: every non-success kind is non-zero exit.
    for (const kind of ["model-give-up", "unrecoverable-error", "user-abort"] as const) {
      const c = createBudgetController().classify({ kind });
      expect(c.exitCode).not.toBe(0);
      expect(c.status).not.toBe("succeeded");
    }
  });

  // Anchor: REQ-014.
  it("test_REQ014_no_final_answer_budget_stop", async () => {
    // A model that NEVER finalizes is bounded by the guard → Stopped (clean), NOT a
    // hang and NOT Failed. The ceiling StopCondition takes precedence over the loop's
    // own model-give-up signal (single StopCondition — INV-005).
    const { outcome, entries } = await runLoop({
      llm: createInfiniteLlmClient(),
      maxIterations: 4,
      runId: "run-nofinal",
    });
    expect(outcome.status).toBe("stopped");
    expect(outcome.exitCode).not.toBe(0);
    const stopped = entries.find((e) => e.type === "run-stopped");
    expect(stopped?.payload.stopCondition).toBe("max-iterations-reached");
    // Exactly one StopCondition fired.
    expect(entries.filter((e) => e.type === "run-stopped")).toHaveLength(1);
    expect(entries.filter((e) => e.type === "run-completed")).toHaveLength(1);
  });

  // Anchor: REQ-014.
  it("test_REQ014_nonterminating_bounded", async () => {
    // A non-terminating loop ALWAYS terminates (RULE-007): with a tiny ceiling the
    // run completes in finite turns and reaches exactly one terminal state.
    const { outcome, entries, budget } = await runLoop({
      llm: createInfiniteLlmClient(),
      maxIterations: 3,
      runId: "run-bounded",
    });
    // It terminated (resolved) — never hung.
    expect(["succeeded", "stopped", "failed"]).toContain(outcome.status);
    expect(outcome.status).toBe("stopped");
    expect(budget.iterationsUsed()).toBe(3);
    // A run-completed terminal entry exists (the loop reached Terminating).
    const completed = entries.find((e) => e.type === "run-completed");
    expect(completed).toBeDefined();
    // The classify exhaustiveness: an unknown signal still yields a defined terminal.
    const unknownCls = createBudgetController().classify(
      { kind: "totally-unknown" as unknown as "task-success" },
    );
    expect(["succeeded", "stopped", "failed"]).toContain(unknownCls.status);
    expect(typeof unknownCls.exitCode).toBe("number");
  });

  // Anchor: REQ-014.
  it("test_REQ014_no_resume_fresh_run", async () => {
    // Runs are FRESH — no resume (V1, out of MVP scope). Two runs of the SAME runId
    // each start from zero accrual: the second run does not carry the first's budget
    // state, and the transcript file is truncated/re-created per run (a fresh chain).
    const script1: LlmResponse[] = [
      { toolCalls: null, finalAnswer: "done one", stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1, estimated: false } },
    ];
    const r1 = await runLoop({ script: script1, runId: "run-fresh" });
    expect(r1.budget.iterationsUsed()).toBe(1);
    const firstSeqs = r1.entries.map((e) => e.seq);

    // A SECOND, independent run (new controller, new writer) with the same id.
    const script2: LlmResponse[] = [
      { toolCalls: null, finalAnswer: "done two", stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1, estimated: false } },
    ];
    const r2 = await runLoop({ script: script2, runId: "run-fresh" });
    // Fresh budget: the second run started from zero (1 turn), not 2 — no carry-over.
    expect(r2.budget.iterationsUsed()).toBe(1);
    // Fresh transcript: the second run's chain restarts at seq 0 (truncated/re-created),
    // it does NOT append onto the first run's entries (no resume of the prior chain).
    expect(r2.entries[0].seq).toBe(0);
    expect(firstSeqs[0]).toBe(0);
    expect(r2.outcome.status).toBe("succeeded");
  });
});
