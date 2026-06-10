/**
 * SLICE-2 / TASK-005 — AgentRun loop + ToolRegistry dispatch (REQ-004, REQ-005).
 *
 * Anchored to REQ-004 (LLM-driven loop over the LlmClient seam) and REQ-005 (tool
 * interface + dispatch with errors-as-results). These tests drive the REAL loop
 * with a scripted StubLlmClient and a real ToolRegistry (read_file real, the
 * other four stubbed), asserting:
 *   - each iteration sends the accumulated conversation + the five tool schemas,
 *   - a tool_use is routed through dispatch and the normalized result fed back,
 *   - an unknown stop_reason is handled without a hang,
 *   - unknown tool / malformed args normalize to exactly one error ToolResult
 *     (never a throw),
 *   - independent steps do not roll back one another.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentRun } from "../src/agent-run.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createReadTool } from "../src/tool-read.js";
import { createPathSandbox } from "../src/path-sandbox.js";
import { createReporter } from "../src/reporter.js";
import { createTranscriptWriter, readTranscript } from "../src/transcript.js";
import { buildRepoContext } from "../src/repo-context.js";
import { FatalToolError } from "../src/tool-errors.js";
import type {
  LlmResponse,
  ToolCall,
  ToolRegistry,
  ToolResult,
  ToolSchema,
} from "../src/contracts.js";
import { createStubLlmClient } from "./stubs.js";

describe("SLICE-2 AgentRun loop + ToolRegistry dispatch (REQ-004 / REQ-005)", () => {
  let root: string;
  let transcriptDir: string;
  let fixtureFile: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice2-loop-"));
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
    script: LlmResponse[];
    registry?: ToolRegistry;
    runId?: string;
  }) {
    const llm = createStubLlmClient(opts.script);
    const registry = opts.registry ?? realRegistry();
    const transcript = createTranscriptWriter({ dir: transcriptDir });
    const reporter = createReporter();
    const context = buildRepoContext(root);
    const runId = opts.runId ?? "run-loop";
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
    });
    const outcome = await agentRun.run();
    const entries = await readTranscript(path.join(transcriptDir, `${runId}.jsonl`));
    return { outcome, llm, entries };
  }

  // Anchor: REQ-004.
  it("test_REQ004_loop_sends_conversation_and_receives_action", async () => {
    const script: LlmResponse[] = [
      {
        toolCalls: [{ id: "c1", toolName: "read_file", arguments: { path: fixtureFile } }],
        finalAnswer: null,
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 2, estimated: false },
      },
      {
        toolCalls: null,
        finalAnswer: "done",
        stopReason: "end_turn",
        usage: { inputTokens: 6, outputTokens: 1, estimated: false },
      },
    ];
    const { outcome, llm, entries } = await runLoop({ script });

    expect(outcome.status).toBe("succeeded");
    // Exactly two model round-trips (the scripted turns).
    expect(llm.calls).toHaveLength(2);
    // Each send carried EXACTLY the five tool schemas (RULE-012).
    for (const call of llm.calls) {
      expect(call.schemaCount).toBe(5);
      expect(call.schemaNames).toEqual([
        "read_file",
        "list_search",
        "write_edit",
        "run_command",
        "apply_patch",
      ]);
    }
    // The conversation ACCUMULATED across turns (the 2nd send saw more than the 1st):
    // the tool_use action + its result were fed back before the 2nd send.
    expect(llm.calls[1].conversationLength).toBeGreaterThan(
      llm.calls[0].conversationLength,
    );
    expect(llm.calls[1].conversationRoles).toContain("assistant");
    expect(llm.calls[1].conversationRoles).toContain("tool");
    // The returned action was routed: a read_file tool-called/tool-result pair exists.
    const toolCalled = entries.find((e) => e.type === "tool-called");
    expect(toolCalled?.payload.toolName).toBe("read_file");
    const toolResult = entries.find((e) => e.type === "tool-result");
    expect(toolResult?.payload.status).toBe("ok");
  });

  // Anchor: REQ-004.
  it("test_REQ004_unknown_stop_reason_handled", async () => {
    // An unknown stop_reason with NO tool calls must terminate (no hang).
    const script: LlmResponse[] = [
      {
        toolCalls: null,
        finalAnswer: null,
        // Deliberately outside the known union to exercise the unknown branch.
        stopReason: "totally_unknown" as unknown as LlmResponse["stopReason"],
        usage: { inputTokens: 3, outputTokens: 0, estimated: false },
      },
    ];
    const { outcome, llm } = await runLoop({ script });
    // It resolved (did not hang / spin) and consumed exactly one send.
    expect(outcome.runId).toBe("run-loop");
    expect(llm.calls).toHaveLength(1);
  });

  // Anchor: REQ-005.
  it("test_REQ005_dispatch_executes_and_feeds_result", async () => {
    const registry = realRegistry();
    // Direct dispatch yields EXACTLY ONE normalized ToolResult (INV-008).
    const result = await registry.dispatch({
      id: "c1",
      toolName: "read_file",
      arguments: { path: fixtureFile },
    });
    expect(result.toolCallId).toBe("c1");
    expect(result.status).toBe("ok");
    expect(result.output).toBeDefined();

    // And in-loop the result is fed back into the conversation before the next send.
    const script: LlmResponse[] = [
      {
        toolCalls: [{ id: "c1", toolName: "read_file", arguments: { path: fixtureFile } }],
        finalAnswer: null,
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 2, estimated: false },
      },
      {
        toolCalls: null,
        finalAnswer: "ok",
        stopReason: "end_turn",
        usage: { inputTokens: 6, outputTokens: 1, estimated: false },
      },
    ];
    const { entries } = await runLoop({ script });
    const results = entries.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(1);
    expect(results[0].payload.status).toBe("ok");
  });

  // Anchor: REQ-005.
  it("test_REQ005_unknown_tool_rejected", async () => {
    const registry = realRegistry();
    // An unknown tool name → UNKNOWN_TOOL error result, NEVER a throw (ERR-005).
    let result: ToolResult | undefined;
    await expect(
      (async () => {
        result = await registry.dispatch({
          id: "c-bad",
          toolName: "delete_everything" as unknown as ToolCall["toolName"],
          arguments: {},
        });
      })(),
    ).resolves.not.toThrow();
    expect(result?.status).toBe("error");
    expect(result?.error?.code).toBe("UNKNOWN_TOOL");
  });

  // Anchor: REQ-005.
  it("test_REQ005_malformed_tool_arguments", async () => {
    const registry = realRegistry();
    // Malformed args (path missing) → the tool's typed error result, no throw.
    let result: ToolResult | undefined;
    await expect(
      (async () => {
        result = await registry.dispatch({
          id: "c-malformed",
          toolName: "read_file",
          // No `path` → the read tool resolves an empty path and returns READ_FAILED.
          arguments: {},
        });
      })(),
    ).resolves.not.toThrow();
    expect(result?.status).toBe("error");
    expect(typeof result?.error?.code).toBe("string");
    // It is normalized — exactly one ToolResult carrying an error code, no crash.
    expect(result?.toolCallId).toBe("c-malformed");
  });

  // Anchor: REQ-005.
  it("test_REQ005_independent_steps_no_rollback", async () => {
    // Two tool calls in one turn: the first ok (read), the second an error
    // (unknown tool). The error must NOT roll back the first ok result — both
    // tool-result rows are present and the run still progresses.
    const script: LlmResponse[] = [
      {
        toolCalls: [
          { id: "ok-1", toolName: "read_file", arguments: { path: fixtureFile } },
          {
            id: "bad-2",
            toolName: "nonexistent" as unknown as ToolCall["toolName"],
            arguments: {},
          },
        ],
        finalAnswer: null,
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 2, estimated: false },
      },
      {
        toolCalls: null,
        finalAnswer: "done",
        stopReason: "end_turn",
        usage: { inputTokens: 6, outputTokens: 1, estimated: false },
      },
    ];
    const { entries } = await runLoop({ script });
    const results = entries.filter((e) => e.type === "tool-result");
    // Both steps produced their own normalized result; neither rolled back.
    expect(results).toHaveLength(2);
    expect(results[0].payload.status).toBe("ok");
    expect(results[1].payload.status).toBe("error");
    expect(results[1].payload.errorCode).toBe("UNKNOWN_TOOL");
    // The ok result is still recorded (not undone by the later error).
    expect(results[0].payload.errorCode).toBeNull();
  });

  // A fatal class re-raised by an executor flows to the unrecoverable-error path
  // (not swallowed). This drives the REAL registry's try/catch: a read_file
  // executor that throws FatalToolError must be RE-RAISED, while an EXPECTED throw
  // would be normalized to an error ToolResult (RULE-008 / IF-008 re-raise row).
  it("test_REQ005_fatal_class_reraised_by_registry", async () => {
    const fatalReadTool = {
      toolName: "read_file" as const,
      execute: async (): Promise<ToolResult> => {
        throw new FatalToolError("transcript write failed");
      },
    };
    const registry = createToolRegistry(fatalReadTool);
    // Real registry re-raises the fatal class rather than normalizing it.
    await expect(
      registry.dispatch({ id: "x", toolName: "read_file", arguments: {} }),
    ).rejects.toBeInstanceOf(FatalToolError);

    // An EXPECTED throw from an executor is instead NORMALIZED (no throw).
    const expectedThrowTool = {
      toolName: "read_file" as const,
      execute: async (): Promise<ToolResult> => {
        throw new Error("file vanished mid-read");
      },
    };
    const reg2 = createToolRegistry(expectedThrowTool);
    const normalized = await reg2.dispatch({
      id: "y",
      toolName: "read_file",
      arguments: {},
    });
    expect(normalized.status).toBe("error");
    expect(normalized.error?.code).toBe("TOOL_EXECUTION_ERROR");
  });
});
