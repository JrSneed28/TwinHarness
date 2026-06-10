/**
 * SLICE-2 / TASK-006 — LlmClient retry/backoff + errors-as-results (REQ-NFR-004).
 *
 * Anchored to REQ-NFR-004: transient LLM API failures are retried with bounded
 * backoff + full jitter honoring `Retry-After`; non-transient 4xx and retry
 * exhaustion are fatal (LLM_FATAL → agent-run maps to Failed); expected TOOL
 * failures normalize to status:"error" ToolResults so the loop continues.
 *
 * Determinism: the jitter source and the sleep are INJECTED, so backoff is
 * deterministic and FAST — no real multi-second sleeping. delayMs is asserted
 * from the computed value without waiting.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  computeBackoffMs,
  createLlmClient,
  MAX_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  type TransportError,
} from "../src/llm-client.js";
import { LlmFatalError, isLlmFatalError } from "../src/tool-errors.js";
import { createAgentRun } from "../src/agent-run.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createReadTool } from "../src/tool-read.js";
import { createPathSandbox } from "../src/path-sandbox.js";
import { createReporter } from "../src/reporter.js";
import { createTranscriptWriter, readTranscript } from "../src/transcript.js";
import { buildRepoContext } from "../src/repo-context.js";
import type { LlmResponse } from "../src/contracts.js";
import { createScriptedTransport, createStubLlmClient } from "./stubs.js";

/** A no-op sleep + scripted jitter make every retry test deterministic and fast. */
const noSleep = async (_ms: number): Promise<void> => {};
const finalAnswer: LlmResponse = {
  toolCalls: null,
  finalAnswer: "done",
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, estimated: false },
};

describe("SLICE-2 LlmClient retry/backoff (REQ-NFR-004)", () => {
  // Anchor: REQ-NFR-004.
  it("test_REQNFR004_transient_retry_backoff", async () => {
    // Two transient 503s, then success. Assert: ≤5 calls, exp backoff + jitter,
    // and the emitted llm-retry entries carry { attempt, errorClass, delayMs }.
    const retries: { attempt: number; errorClass: string; delayMs: number }[] = [];
    const transport = createScriptedTransport([
      { throw: { status: 503 } as TransportError },
      { throw: { status: 500 } as TransportError },
      { resolve: finalAnswer },
    ]);
    const client = createLlmClient({
      transport,
      onRetry: (e) => retries.push(e),
      random01: () => 0.5, // deterministic jitter
      sleep: noSleep,
    });
    const res = await client.send([{ role: "user", content: "hi" }], []);
    expect(res.finalAnswer).toBe("done");
    expect(transport.callCount()).toBe(3);
    expect(transport.callCount()).toBeLessThanOrEqual(MAX_ATTEMPTS);

    // Two retries emitted, with monotonically growing base backoff (pre-jitter):
    // attempt 1 base 1000ms, attempt 2 base 2000ms; full jitter at 0.5 halves it.
    expect(retries).toHaveLength(2);
    expect(retries[0].attempt).toBe(1);
    expect(retries[0].errorClass).toBe("http_503");
    expect(retries[0].delayMs).toBe(Math.floor(RETRY_BASE_MS * 1 * 0.5)); // 500
    expect(retries[1].attempt).toBe(2);
    expect(retries[1].errorClass).toBe("http_500");
    expect(retries[1].delayMs).toBe(Math.floor(RETRY_BASE_MS * 2 * 0.5)); // 1000
    // Backoff never exceeds the cap.
    for (const r of retries) expect(r.delayMs).toBeLessThanOrEqual(RETRY_CAP_MS);
  });

  // Anchor: REQ-NFR-004.
  it("test_REQNFR004_rate_limit_retry_after", async () => {
    // A 429 with Retry-After: 7s. With full jitter at 0.0 the jittered delay is 0,
    // so Retry-After FLOORS it to 7000ms.
    const retries: { attempt: number; errorClass: string; delayMs: number }[] = [];
    const transport = createScriptedTransport([
      { throw: { status: 429, retryAfterSeconds: 7 } as TransportError },
      { resolve: finalAnswer },
    ]);
    const client = createLlmClient({
      transport,
      onRetry: (e) => retries.push(e),
      random01: () => 0, // jittered delay would be 0 → Retry-After floor wins
      sleep: noSleep,
    });
    await client.send([{ role: "user", content: "hi" }], []);
    expect(retries).toHaveLength(1);
    expect(retries[0].errorClass).toBe("http_429");
    expect(retries[0].delayMs).toBe(7000);

    // Unit-level: computeBackoffMs floors by Retry-After.
    expect(computeBackoffMs(1, 0, 7000)).toBe(7000);
    // ...but a larger jittered delay is NOT reduced by a smaller Retry-After.
    expect(computeBackoffMs(4, 0.99, 1000)).toBeGreaterThan(1000);
  });

  // Anchor: REQ-NFR-004.
  it("test_REQNFR004_retries_exhausted_fatal", async () => {
    // Five transient failures (all attempts) → LLM_FATAL (retries exhausted).
    const transport = createScriptedTransport([
      { throw: { status: 503 } as TransportError },
      { throw: { status: 503 } as TransportError },
      { throw: { status: 503 } as TransportError },
      { throw: { status: 503 } as TransportError },
      { throw: { status: 503 } as TransportError },
    ]);
    const retries: unknown[] = [];
    const client = createLlmClient({
      transport,
      onRetry: (e) => retries.push(e),
      random01: () => 0.5,
      sleep: noSleep,
    });
    await expect(client.send([{ role: "user", content: "hi" }], [])).rejects.toBeInstanceOf(
      LlmFatalError,
    );
    // Exactly MAX_ATTEMPTS (5) SDK calls — no more.
    expect(transport.callCount()).toBe(MAX_ATTEMPTS);
    // 4 retries were emitted before exhaustion (the 5th failure is fatal, no retry).
    expect(retries).toHaveLength(MAX_ATTEMPTS - 1);
  });

  // Anchor: REQ-NFR-004.
  it("test_REQNFR004_fatal_4xx_no_retry", async () => {
    // 401/403/400 are NOT retried — fatal on the first attempt.
    for (const status of [401, 403, 400]) {
      const transport = createScriptedTransport([
        { throw: { status } as TransportError },
        { resolve: finalAnswer }, // must NEVER be reached
      ]);
      const retries: unknown[] = [];
      const client = createLlmClient({
        transport,
        onRetry: (e) => retries.push(e),
        sleep: noSleep,
      });
      let caught: unknown;
      await client.send([{ role: "user", content: "x" }], []).catch((e) => (caught = e));
      expect(isLlmFatalError(caught)).toBe(true);
      expect((caught as LlmFatalError).errorClass).toBe(`http_${status}`);
      // Exactly ONE SDK call — no retry, the resolve step was never consumed.
      expect(transport.callCount()).toBe(1);
      expect(retries).toHaveLength(0);
    }
  });

  // Anchor: REQ-NFR-004.
  it("test_REQNFR004_network_timeout_retry", async () => {
    // A non-HTTP network timeout is transient → retried, then succeeds.
    const transport = createScriptedTransport([
      { throw: { kind: "timeout" } as TransportError },
      { resolve: finalAnswer },
    ]);
    const retries: { errorClass: string }[] = [];
    const client = createLlmClient({
      transport,
      onRetry: (e) => retries.push(e),
      random01: () => 0.25,
      sleep: noSleep,
    });
    const res = await client.send([{ role: "user", content: "x" }], []);
    expect(res.finalAnswer).toBe("done");
    expect(retries).toHaveLength(1);
    expect(retries[0].errorClass).toBe("network_timeout");
    expect(transport.callCount()).toBe(2);
  });

  // Anchor: REQ-NFR-004.
  it("test_REQNFR004_api_outage_retry_then_fail", async () => {
    // A sustained outage (socket resets every attempt) retries then fails cleanly.
    const steps = Array.from({ length: MAX_ATTEMPTS }, () => ({
      throw: { kind: "socket_reset" } as TransportError,
    }));
    const transport = createScriptedTransport(steps);
    const client = createLlmClient({
      transport,
      random01: () => 0.5,
      sleep: noSleep,
    });
    await expect(client.send([{ role: "user", content: "x" }], [])).rejects.toBeInstanceOf(
      LlmFatalError,
    );
    // Bounded at exactly 5 attempts — failed cleanly (no hang, no >5 calls).
    expect(transport.callCount()).toBe(MAX_ATTEMPTS);
  });

  // Anchor: REQ-NFR-004.
  it("test_REQNFR004_expected_error_normalized", async () => {
    // An EXPECTED tool failure (read of a missing file) becomes a status:"error"
    // ToolResult — NOT a thrown crash — so the loop continues (RULE-008).
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice2-norm-"));
    try {
      const sandbox = createPathSandbox(tmp);
      const registry = createToolRegistry(createReadTool(sandbox));
      const result = await registry.dispatch({
        id: "miss",
        toolName: "read_file",
        arguments: { path: path.join(tmp, "does-not-exist.txt") },
      });
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("READ_FAILED");
      // It is a normalized result, not a throw — exactly one ToolResult.
      expect(result.toolCallId).toBe("miss");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Anchor: REQ-NFR-004.
  it("test_REQNFR004_fatal_class_terminates", async () => {
    // A fatal LLM class terminates the RUN into Failed (non-zero exit, ERR-013).
    // Drive the real agent-run loop with an LlmClient whose transport throws a
    // fatal 401 — the loop maps it to unrecoverable-error → Failed.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "autocoder-slice2-fatal-"));
    const transcriptDir = path.join(tmp, ".transcripts");
    try {
      const transport = createScriptedTransport([
        { throw: { status: 401 } as TransportError },
      ]);
      const llm = createLlmClient({ transport, sleep: noSleep });
      const sandbox = createPathSandbox(tmp);
      const registry = createToolRegistry(createReadTool(sandbox));
      const transcript = createTranscriptWriter({ dir: transcriptDir });
      const reporter = createReporter();
      const context = buildRepoContext(tmp);
      const agentRun = createAgentRun({
        runId: "run-fatal",
        task: "fail please",
        root: tmp,
        modelId: "stub-model",
        context,
        llm,
        registry,
        transcript,
        reporter,
      });
      const outcome = await agentRun.run();
      // The run mapped the fatal to Failed with a non-zero exit (ERR-013).
      expect(outcome.status).toBe("failed");
      expect(outcome.exitCode).not.toBe(0);

      const entries = await readTranscript(path.join(transcriptDir, "run-fatal.jsonl"));
      const stopped = entries.find((e) => e.type === "run-stopped");
      expect(stopped?.payload.stopCondition).toBe("unrecoverable-error");
      const completed = entries.find((e) => e.type === "run-completed");
      expect(completed?.payload.status).toBe("failed");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // A plain (non-LLM) sanity check that the loop over the WRAPPED retrying client
  // resolves a normal response without any retries (no spurious backoff).
  it("test_REQNFR004_no_retry_on_clean_success", async () => {
    const transport = createScriptedTransport([{ resolve: finalAnswer }]);
    const retries: unknown[] = [];
    const client = createLlmClient({ transport, onRetry: (e) => retries.push(e), sleep: noSleep });
    const res = await client.send([{ role: "user", content: "x" }], []);
    expect(res.finalAnswer).toBe("done");
    expect(retries).toHaveLength(0);
    expect(transport.callCount()).toBe(1);
    // And the stub LlmClient path (no retry wrapper) still works for the loop.
    const stub = createStubLlmClient([finalAnswer]);
    const r2 = await stub.send([{ role: "user", content: "x" }], []);
    expect(r2.finalAnswer).toBe("done");
  });
});
