/**
 * SLICE-7 / TASK-014 — BudgetController accrue + pre-turn guard + defaults
 * (REQ-015, REQ-NFR-003).
 *
 * Anchored to REQ-015 (configurable iteration + token ceilings end the run
 * cleanly) and REQ-NFR-003 (cost/runaway protection: no run can exceed its
 * configured iteration or token ceiling; absent config, conservative defaults
 * apply). These tests prove the PRE-TURN guard PREVENTS (never aborts mid-flight)
 * an over-ceiling turn, that accrual is monotonic with an estimate fallback, and
 * that an infinite-tool-call stub is bounded by `maxIterations`.
 *
 * The guard's "prevent not abort" property is proven OBSERVABLY: the stub
 * LlmClient is NOT called on the over-ceiling turn (no half-iteration). The
 * runaway bound is proven by scripting an INFINITE tool_use response and asserting
 * the loop stops in ≤ maxIterations sends.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentRun } from "../src/agent-run.js";
import {
  createBudgetController,
  estimateUsage,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TOKEN_BUDGET,
} from "../src/budget-stop.js";
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
  Usage,
} from "../src/contracts.js";
import { createStubLlmClient } from "./stubs.js";

describe("SLICE-7 BudgetController pre-turn guard + defaults (REQ-015 / REQ-NFR-003)", () => {
  let root: string;
  let transcriptDir: string;
  let fixtureFile: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice7-budget-"));
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

  /**
   * Run the real loop with an explicit BudgetController (so ceilings are tiny and
   * deterministic). Returns the outcome, the stub (call count = sends made), and
   * the transcript entries.
   */
  async function runLoop(opts: {
    script: LlmResponse[];
    maxIterations?: number;
    tokenBudget?: number;
    runId?: string;
  }) {
    const llm = createStubLlmClient(opts.script);
    const registry = realRegistry();
    const transcript = createTranscriptWriter({ dir: transcriptDir });
    const reporter = createReporter();
    const context = buildRepoContext(root);
    const runId = opts.runId ?? "run-budget";
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
    return { outcome, llm, entries, budget };
  }

  /** A response that always asks for one more tool call (an infinite-tool-call model). */
  function infiniteToolUse(usage?: Usage): LlmResponse {
    return {
      toolCalls: [{ id: "loop", toolName: "read_file", arguments: { path: fixtureFile } }],
      finalAnswer: null,
      stopReason: "tool_use",
      usage: usage ?? { inputTokens: 1, outputTokens: 1, estimated: false },
    };
  }

  /**
   * An LlmClient that NEVER finalizes — every send returns one more tool_use. Unlike
   * the scripted stub it does not exhaust, so the ONLY thing that can stop the loop
   * is the budget guard. Records its call count to prove the runaway is bounded.
   */
  function createInfiniteLlmClient(usage?: Usage): LlmClient & { count: () => number } {
    let calls = 0;
    return {
      count: () => calls,
      async send(
        _conversation: ConversationMessage[],
        _toolSchemas: ToolSchema[],
      ): Promise<LlmResponse> {
        calls += 1;
        return infiniteToolUse(usage);
      },
    };
  }

  // Anchor: REQ-015.
  it("test_REQ015_max_iterations_guard", () => {
    // The pure controller: accrue up to the ceiling, then the guard forbids the turn.
    const budget = createBudgetController({ maxIterations: 3, tokenBudget: 1_000_000 });
    expect(budget.checkGuard().proceed).toBe(true);
    budget.accrue({ inputTokens: 1, outputTokens: 1, estimated: false });
    budget.accrue({ inputTokens: 1, outputTokens: 1, estimated: false });
    expect(budget.checkGuard().proceed).toBe(true); // 2 < 3
    budget.accrue({ inputTokens: 1, outputTokens: 1, estimated: false });
    const verdict = budget.checkGuard(); // 3 >= 3
    expect(verdict.proceed).toBe(false);
    expect(verdict.stopCondition).toBe("max-iterations-reached");
    expect(budget.iterationsUsed()).toBe(3);
  });

  // Anchor: REQ-015.
  it("test_REQ015_token_budget_guard", () => {
    // The guard trips on tokens independent of iteration count.
    const budget = createBudgetController({ maxIterations: 1000, tokenBudget: 100 });
    expect(budget.checkGuard().proceed).toBe(true);
    budget.accrue({ inputTokens: 60, outputTokens: 30, estimated: false }); // 90 < 100
    expect(budget.checkGuard().proceed).toBe(true);
    budget.accrue({ inputTokens: 10, outputTokens: 0, estimated: false }); // 100 >= 100
    const verdict = budget.checkGuard();
    expect(verdict.proceed).toBe(false);
    expect(verdict.stopCondition).toBe("budget-exhausted");
    expect(budget.tokensUsed()).toBe(100);
  });

  // Anchor: REQ-015.
  it("test_REQ015_usage_estimate_fallback", async () => {
    // The pure estimate is flagged and bounded.
    const est = estimateUsage(400, 80); // ~100 + ~20 tokens
    expect(est.estimated).toBe(true);
    expect(est.inputTokens).toBe(100);
    expect(est.outputTokens).toBe(20);

    // In-loop: a response with NO usage counts (estimated:true, zero counts) makes
    // the loop fall back to a character estimate — and the run flags usedEstimate.
    const noUsage: Usage = { inputTokens: 0, outputTokens: 0, estimated: true };
    const script: LlmResponse[] = [
      {
        toolCalls: [{ id: "c1", toolName: "read_file", arguments: { path: fixtureFile } }],
        finalAnswer: null,
        stopReason: "tool_use",
        usage: noUsage,
      },
      { toolCalls: null, finalAnswer: "done", stopReason: "end_turn", usage: noUsage },
    ];
    const { budget, outcome } = await runLoop({ script, maxIterations: 25, tokenBudget: 1_000_000 });
    expect(outcome.status).toBe("succeeded");
    // The loop accrued a non-zero, ESTIMATED token total (the SDK omitted counts).
    expect(budget.usedEstimate()).toBe(true);
    expect(budget.tokensUsed()).toBeGreaterThan(0);
  });

  // Anchor: REQ-015.
  it("test_REQ015_invalid_transition_to_iterating", async () => {
    // NO half-iteration past a ceiling: with maxIterations=2, a never-finalizing
    // model is sent EXACTLY 2 times — the guard PREVENTS the 3rd turn before send.
    const llm = createInfiniteLlmClient();
    const registry = realRegistry();
    const transcript = createTranscriptWriter({ dir: transcriptDir });
    const reporter = createReporter();
    const context = buildRepoContext(root);
    const budget = createBudgetController({ maxIterations: 2, tokenBudget: 1_000_000 });
    const agentRun = createAgentRun({
      runId: "run-noflight",
      task: "spin",
      root,
      modelId: "stub-model",
      context,
      llm,
      registry,
      transcript,
      reporter,
      budget,
    });
    await agentRun.run();
    // The guard prevented the over-ceiling turn: the model was called EXACTLY
    // maxIterations times — never a 3rd (half-)iteration past the ceiling.
    expect(llm.count()).toBe(2);
    expect(budget.iterationsUsed()).toBe(2);
    expect(budget.checkGuard().proceed).toBe(false);
  });

  // Anchor: REQ-NFR-003.
  it("test_REQNFR003_no_run_exceeds_iteration_or_token_ceiling", async () => {
    // No run starts a turn past EITHER ceiling. Drive both: tiny token budget that
    // trips before the iteration ceiling. The stub must NOT be called past the point
    // where tokens crossed the budget.
    const usage: Usage = { inputTokens: 30, outputTokens: 30, estimated: false }; // 60/turn
    const llm = createInfiniteLlmClient(usage);
    const registry = realRegistry();
    const transcript = createTranscriptWriter({ dir: transcriptDir });
    const reporter = createReporter();
    const context = buildRepoContext(root);
    // tokenBudget=100 ⇒ after turn 2 tokens=120 ≥ 100 ⇒ guard stops before turn 3.
    const budget = createBudgetController({ maxIterations: 1000, tokenBudget: 100 });
    const agentRun = createAgentRun({
      runId: "run-tokceil",
      task: "spin",
      root,
      modelId: "stub-model",
      context,
      llm,
      registry,
      transcript,
      reporter,
      budget,
    });
    await agentRun.run();
    // Two turns ran (tokens 60 then 120); the 3rd was PREVENTED by the token guard.
    expect(llm.count()).toBe(2);
    expect(budget.tokensUsed()).toBe(120);
    // The run never exceeded the iteration ceiling either (it stopped on tokens far
    // below 1000 iterations).
    expect(budget.iterationsUsed()).toBeLessThan(1000);
    expect(budget.checkGuard().stopCondition).toBe("budget-exhausted");
  });

  // Anchor: REQ-NFR-003.
  it("test_REQNFR003_conservative_defaults_applied", () => {
    // Absent config (no ceilings passed), the conservative IF-011 defaults apply.
    const budget = createBudgetController();
    expect(DEFAULT_MAX_ITERATIONS).toBe(25);
    expect(DEFAULT_TOKEN_BUDGET).toBe(1_000_000);
    // A fresh controller proceeds; it only stops at the defaults.
    expect(budget.checkGuard().proceed).toBe(true);
    // Accrue 24 turns: still proceeds (24 < 25); the 25th forbids.
    for (let i = 0; i < 24; i++) {
      budget.accrue({ inputTokens: 1, outputTokens: 1, estimated: false });
    }
    expect(budget.checkGuard().proceed).toBe(true);
    budget.accrue({ inputTokens: 1, outputTokens: 1, estimated: false }); // 25th
    expect(budget.checkGuard().proceed).toBe(false);
    expect(budget.checkGuard().stopCondition).toBe("max-iterations-reached");
    // Invalid (non-positive / non-finite) ceilings also fall back to the defaults.
    const fallback = createBudgetController({ maxIterations: 0, tokenBudget: -5 });
    for (let i = 0; i < 24; i++) {
      fallback.accrue({ inputTokens: 1, outputTokens: 1, estimated: false });
    }
    expect(fallback.checkGuard().proceed).toBe(true); // default 25 applied, not 0
  });

  // Anchor: REQ-NFR-003.
  it("test_REQNFR003_budget_pre_turn_guard_stops_runaway", async () => {
    // An infinite-tool-call stub (never finalizes) is bounded by maxIterations: the
    // loop stops in ≤ maxIterations turns and emits budget-exceeded. ABU-008.
    const MAX = 5;
    const llm = createInfiniteLlmClient();
    const registry = realRegistry();
    const transcript = createTranscriptWriter({ dir: transcriptDir });
    const reporter = createReporter();
    const context = buildRepoContext(root);
    const budget = createBudgetController({ maxIterations: MAX, tokenBudget: 1_000_000 });
    const agentRun = createAgentRun({
      runId: "run-runaway",
      task: "spin forever",
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
    // Runaway BOUNDED: the never-finalizing model was sent ≤ MAX times, then stopped.
    expect(llm.count()).toBeLessThanOrEqual(MAX);
    expect(llm.count()).toBe(MAX);
    expect(outcome.status).toBe("stopped");
    expect(outcome.exitCode).not.toBe(0);
    const entries = await readTranscript(path.join(transcriptDir, "run-runaway.jsonl"));
    const exceeded = entries.find((e) => e.type === "budget-exceeded");
    expect(exceeded).toBeDefined();
    expect(exceeded?.payload.kind).toBe("max-iterations-reached");
    expect(exceeded?.payload.iterationsUsed).toBe(MAX);
    const stopped = entries.find((e) => e.type === "run-stopped");
    expect(stopped?.payload.stopCondition).toBe("max-iterations-reached");
  });
});
