/**
 * Deterministic DI-seam stubs for the test suite (REQ-NFR-002, ADR-004, RULE-015).
 *
 * These stub the only two non-deterministic edges so the harness runs offline:
 *  - StubLlmClient replays a scripted sequence of LlmResponses (no network).
 *  - StubCommandRunner returns canned results and records calls (no real subprocess).
 */
import type {
  CommandResult,
  CommandRunner,
  ConversationMessage,
  LlmClient,
  LlmResponse,
  ToolSchema,
} from "../src/contracts.js";

/** One recorded send() call — enough to assert what the loop sent each turn. */
export interface RecordedSend {
  conversationLength: number;
  schemaCount: number;
  /** A shallow snapshot of the conversation roles the loop accumulated. */
  conversationRoles: string[];
  /** A snapshot of the tool schema names the loop attached (RULE-012). */
  schemaNames: string[];
}

/** Records every send() call so a test can assert no extra round-trips. */
export interface StubLlmClient extends LlmClient {
  readonly calls: RecordedSend[];
}

/** Replays `script` one response per send(); throws if over-called. */
export function createStubLlmClient(script: LlmResponse[]): StubLlmClient {
  const calls: RecordedSend[] = [];
  let i = 0;
  return {
    calls,
    async send(
      conversation: ConversationMessage[],
      toolSchemas: ToolSchema[],
    ): Promise<LlmResponse> {
      calls.push({
        conversationLength: conversation.length,
        schemaCount: toolSchemas.length,
        conversationRoles: conversation.map((m) => m.role),
        schemaNames: toolSchemas.map((s) => s.name),
      });
      const next = script[i++];
      if (!next) {
        throw new Error("StubLlmClient: scripted responses exhausted (no network in tests)");
      }
      return next;
    },
  };
}

/**
 * A scripted LLM TRANSPORT (the seam-excluded inner call) for retry/backoff
 * tests. Each scripted step is EITHER a thrown TransportError (transient/fatal)
 * OR a resolved LlmResponse. `createLlmClient` wraps this with the retry policy,
 * so a test can assert how many transport calls happened, what was retried, and
 * the final resolve/throw — all without any network. Reused via the import in the
 * SLICE-2 retry test.
 */
export type TransportStep =
  | { throw: unknown }
  | { resolve: LlmResponse };

export interface ScriptedTransport {
  (
    conversation: ConversationMessage[],
    toolSchemas: ToolSchema[],
  ): Promise<LlmResponse>;
  /** Number of transport invocations (SDK-call count) — assert ≤ 5. */
  readonly callCount: () => number;
}

export function createScriptedTransport(steps: TransportStep[]): ScriptedTransport {
  let i = 0;
  const fn = (async (): Promise<LlmResponse> => {
    const step = steps[i++];
    if (!step) {
      throw new Error("ScriptedTransport: steps exhausted (no network in tests)");
    }
    if ("throw" in step) {
      throw step.throw;
    }
    return step.resolve;
  }) as ScriptedTransport;
  // Attach the call counter (i advances per invocation).
  Object.defineProperty(fn, "callCount", { value: () => i });
  return fn;
}

/** Records every run() call; a Slice-0 read path must never invoke it. */
export interface StubCommandRunner extends CommandRunner {
  readonly calls: { command: string; cwd: string; timeoutMs: number }[];
}

/**
 * A canned CommandRunner result, OR a function of the call args (so a test can return
 * different results per command — used to exercise spawn-failure / timeout / non-zero
 * exit distinctions deterministically, with NO real subprocess; RULE-015).
 */
export type StubCommandResult =
  | CommandResult
  | ((command: string, cwd: string, timeoutMs: number) => CommandResult);

export function createStubCommandRunner(
  result: StubCommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false },
): StubCommandRunner {
  const calls: { command: string; cwd: string; timeoutMs: number }[] = [];
  return {
    calls,
    async run(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
      calls.push({ command, cwd, timeoutMs });
      return typeof result === "function" ? result(command, cwd, timeoutMs) : result;
    },
  };
}
