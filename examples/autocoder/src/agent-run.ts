/**
 * AgentRun orchestrator (`agent-run`) — owns the run lifecycle and drives the
 * single sequential agent loop (ADR-003, REQ-004/005). Realizes the
 * `gatherContext → iterate → callModel → dispatchTool → observe → record` cycle.
 *
 * SLICE-2 (the REAL loop over the stubbed model seam):
 *  - emit `context-gathered` (IF-015) from the RepoContext built upstream,
 *  - each iteration sends the ACCUMULATED conversation + the FIVE tool schemas to
 *    `LlmClient.send`, then either:
 *      - routes each returned `tool_use` through `ToolRegistry.dispatch` STRICTLY
 *        SEQUENTIALLY (one ToolCall fully resolved before the next — ADR-003 /
 *        REQ-NFR-002 no-in-process-race), feeding the normalized ToolResult back
 *        into the conversation, or
 *      - finalizes on a final answer.
 *  - an UNKNOWN `stopReason` is handled without a hang (treated as a terminal
 *    final answer if no tool calls; otherwise the tool calls are dispatched).
 *  - a thrown `LlmFatalError` (retries exhausted / non-transient — ERR-013) maps
 *    to the unrecoverable-error path → Failed (non-zero exit).
 *
 * REQ-NFR-002: the LlmClient + CommandRunner seams are injected so this loop is
 * deterministic and offline-testable — no network, no real subprocess.
 *
 * SLICE-7 (REQ-014, REQ-015, REQ-NFR-003): the temporary structural turn cap is
 * REPLACED by the real `budget-stop` BudgetController. Before every turn the loop
 * consults the PRE-TURN guard (RULE-006, INV-004) — once a ceiling is hit the next
 * turn does NOT start (no half-iteration), a `budget-exceeded` entry is emitted, and
 * the run terminates on the ceiling StopCondition. After every turn the controller
 * accrues the turn's token usage (or a character-based estimate when the SDK omits
 * it). At Terminating the controller `classify`s the terminating signal into exactly
 * one StopCondition + RunOutcome (RULE-007/011, INV-005/006), and `LlmFatalError`
 * maps to the unrecoverable-error path → Failed.
 */
import {
  SCHEMA_VERSION,
  type ConversationMessage,
  type LlmClient,
  type RunOutcome,
  type ToolRegistry,
  type TranscriptWriter,
  type Usage,
} from "./contracts.js";
import {
  createBudgetController,
  estimateUsage,
  type BudgetController,
  type TerminalSignal,
} from "./budget-stop.js";
import type { RepoContext } from "./repo-context.js";
import type { Reporter } from "./reporter.js";
import { isLlmFatalError, isUserAbortError } from "./tool-errors.js";

export interface AgentRunDeps {
  runId: string;
  task: string;
  root: string;
  modelId: string;
  context: RepoContext;
  llm: LlmClient;
  registry: ToolRegistry;
  transcript: TranscriptWriter;
  reporter: Reporter;
  /**
   * The per-run BudgetController (IF-011). OPTIONAL: when absent (the SLICE-2
   * callers and the current composition root), the loop constructs one from the
   * resolved ceilings below, falling back to the conservative IF-011 defaults
   * (25 iterations, ~1,000,000 tokens) when those are also absent. This keeps the
   * `agent-run` constructor back-compatible while wiring the real guard.
   */
  budget?: BudgetController;
  /** Iteration ceiling resolved from Config (REQ-015); used only when `budget` is absent. */
  maxIterations?: number;
  /** Token ceiling resolved from Config (REQ-015); used only when `budget` is absent. */
  tokenBudget?: number;
}

export function createAgentRun(deps: AgentRunDeps) {
  const now = (): string => new Date().toISOString();

  return {
    async run(): Promise<RunOutcome> {
      const { runId, task, root, modelId, context } = deps;

      // The per-run BudgetController (IF-011). Resolves the real ceilings from the
      // injected deps (Config), defaulting to the conservative IF-011 defaults when
      // absent. This REPLACES the temporary SLICE-2 structural turn cap: the loop is
      // now bounded by the real pre-turn guard (RULE-006), not a hard-coded number.
      // Constructed BEFORE the lifecycle try so the catch's `terminate` can classify
      // a failure on the very first transcript appends (DRIFT-016, below).
      const budget =
        deps.budget ??
        createBudgetController({
          maxIterations: deps.maxIterations,
          tokenBudget: deps.tokenBudget,
        });

      // The terminating signal the loop accumulates; classified into the RunOutcome
      // at Terminating (RULE-007). It starts at model-give-up (a model that never
      // finalizes is a give-up, but the guard's ceiling takes precedence in
      // classify when a ceiling was hit — INV-005). A real final answer overwrites
      // it with task-success.
      let terminalSignal: TerminalSignal = { kind: "model-give-up" };

      let turn = 0;
      try {
        // DRIFT-016 fix (SLICE-10): the run-lifecycle try/catch now ENCLOSES the
        // pre-loop transcript appends (run-started + context-gathered) so a fatal
        // TRANSCRIPT_WRITE_FAILED on those FIRST entries is classified as
        // unrecoverable-error → Failed — consistent with every other write in the
        // loop (ERR-014 / RULE-010). Previously these two appends were OUTSIDE the
        // try, so a write failure on them escaped unclassified.
        await deps.transcript.open(runId);
        await deps.transcript.append({
          schemaVersion: SCHEMA_VERSION,
          ts: now(),
          runId,
          type: "run-started",
          payload: { task, root, modelId },
        });

        // Emit the bounded RepoContext metadata (IF-015 `context-gathered`).
        // Payload is EXACTLY { projectType, testCommand, fileCount } — never the
        // whole repo (REQ-003 bound; the listing/key files stay in-process).
        await deps.transcript.append({
          schemaVersion: SCHEMA_VERSION,
          ts: now(),
          runId,
          type: "context-gathered",
          payload: {
            projectType: context.projectType,
            testCommand: context.testCommand,
            fileCount: context.fileCount,
          },
        });

        // The accumulating conversation handed to the LlmClient each turn. The
        // gathered (bounded) context seeds the system message — not the whole repo.
        const conversation: ConversationMessage[] = [
          { role: "system", content: "autocoder agent" },
          {
            role: "system",
            content: {
              projectType: context.projectType,
              testCommand: context.testCommand,
              fileCount: context.fileCount,
              keyFiles: context.keyFiles,
            },
          },
          { role: "user", content: task },
        ];
        const toolSchemas = deps.registry.schemas();

        // Single sequential loop bounded ONLY by the real budget guard. The guard
        // runs BEFORE every model call so a near-budget turn is PREVENTED, never
        // aborted mid-flight (RULE-006, INV-004) — there is no structural cap and no
        // half-iteration past a ceiling.
        for (;;) {
          // Pre-turn budget guard (RULE-006). proceed=false ⇒ the turn does NOT
          // start; emit `budget-exceeded` once and terminate on the ceiling.
          const verdict = budget.checkGuard();
          if (!verdict.proceed) {
            const event = budget.exceededEvent();
            if (event !== null) {
              await deps.transcript.append({
                schemaVersion: SCHEMA_VERSION,
                ts: now(),
                runId,
                type: "budget-exceeded",
                payload: {
                  kind: event.kind,
                  iterationsUsed: event.iterationsUsed,
                  tokensUsed: event.tokensUsed,
                },
              });
            }
            // The ceiling is the terminal condition; classify resolves it (it takes
            // precedence over `terminalSignal` when a ceiling was hit).
            break;
          }

          // Call the model over the seam (retry/backoff is inside the seam).
          // A thrown LlmFatalError propagates to the catch below (unrecoverable).
          const response = await deps.llm.send(conversation, toolSchemas);

          // Accrue this completed turn's token usage AFTER the send: when the SDK
          // reports usage, use it; when it omits usage (estimated flag / missing),
          // fall back to a character-based estimate flagged `estimated:true`
          // (DQ-001 / ODQ-005). Accrual increments iterationsUsed and is monotonic.
          budget.accrue(resolveTurnUsage(response.usage, conversation, response));

          await deps.transcript.append({
            schemaVersion: SCHEMA_VERSION,
            ts: now(),
            runId,
            type: "iteration-started",
            payload: { index: turn },
          });
          turn += 1;

          const hasToolCalls =
            Array.isArray(response.toolCalls) && response.toolCalls.length > 0;

          // Final answer (no tool calls) → the run is done. An UNKNOWN stopReason
          // with no tool calls is also terminal here (handled without a hang). A
          // finalized answer is task-success (success-verification refinement is
          // out of this slice's scope — the model's declaration is accepted).
          if (!hasToolCalls) {
            terminalSignal = { kind: "task-success" };
            break;
          }

          // Append the assistant turn (the tool_use request) before dispatching,
          // so the conversation reflects the model's action ordering.
          conversation.push({ role: "assistant", content: response.toolCalls });

          // Dispatch each tool call STRICTLY SEQUENTIALLY (ADR-003): one ToolCall
          // is fully resolved (dispatched + recorded + fed back) before the next.
          for (const toolCall of response.toolCalls ?? []) {
            await deps.transcript.append({
              schemaVersion: SCHEMA_VERSION,
              ts: now(),
              runId,
              type: "tool-called",
              payload: {
                toolCallId: toolCall.id,
                toolName: toolCall.toolName,
                arguments: toolCall.arguments,
              },
            });

            // dispatch yields EXACTLY ONE normalized ToolResult, never a throw
            // (RULE-008/INV-008) — a FATAL class would re-raise and is caught below.
            const result = await deps.registry.dispatch(toolCall);

            await deps.transcript.append({
              schemaVersion: SCHEMA_VERSION,
              ts: now(),
              runId,
              type: "tool-result",
              payload: {
                toolCallId: result.toolCallId,
                status: result.status,
                errorCode: result.error?.code ?? null,
              },
            });

            // Feed the ToolResult back into the conversation for the next turn.
            // Each step is independent — an error result does NOT roll back the
            // prior ok results already in the conversation (no rollback).
            conversation.push({ role: "tool", content: result });
          }
        }
      } catch (err) {
        // A re-raised UserAbortError is a CLEAN stop (user-abort → Stopped, NOT
        // Failed; tool-errors.ts). Any other throw — a fatal LLM failure (ERR-013),
        // a re-raised FatalToolError, or an unexpected throw — is unrecoverable →
        // Failed (never a silent crash). Both route through budget.classify so the
        // exit-code invariant (exit 0 IFF succeeded — INV-006) is enforced in ONE
        // place. A ceiling already hit before the throw still takes precedence in
        // classify (single StopCondition — INV-005).
        const errSignal: TerminalSignal["kind"] = isUserAbortError(err)
          ? "user-abort"
          : "unrecoverable-error";
        const errorClass = isLlmFatalError(err)
          ? err.errorClass
          : isUserAbortError(err)
            ? "user-abort"
            : "unexpected";
        const outcome = await terminate({ kind: errSignal }, { errorClass });
        return outcome;
      }

      // Normal Terminating: classify the accumulated terminating signal into exactly
      // one StopCondition + RunOutcome (RULE-007). A ceiling hit takes precedence in
      // classify, so a run bounded by the guard terminates Stopped on the ceiling
      // even though the loop's own signal is model-give-up.
      return terminate(terminalSignal);

      /**
       * Terminating step (RULE-007/011, INV-005/006): classify → emit run-stopped +
       * run-completed → flush → return the RunOutcome. Centralizes the terminal so
       * exactly one StopCondition is recorded and exit 0 IFF Succeeded. `extra` is
       * merged into the run-stopped payload (e.g. errorClass for an error path).
       */
      async function terminate(
        signal: TerminalSignal,
        extra?: Record<string, unknown>,
      ): Promise<RunOutcome> {
        const classified = budget.classify(signal);

        await deps.transcript.append({
          schemaVersion: SCHEMA_VERSION,
          ts: now(),
          runId,
          type: "run-stopped",
          payload: { stopCondition: classified.stopCondition, ...(extra ?? {}) },
        });

        const outcome: RunOutcome = {
          status: classified.status,
          exitCode: classified.exitCode,
          runId,
        };

        await deps.transcript.append({
          schemaVersion: SCHEMA_VERSION,
          ts: now(),
          runId,
          type: "run-completed",
          payload: { status: outcome.status, exitCode: outcome.exitCode },
        });
        await deps.transcript.flush();
        return outcome;
      }
    },
  };
}

/**
 * Resolve the token usage to accrue for one completed turn: prefer the SDK's
 * reported usage; when it is missing OR explicitly flagged `estimated:true` with no
 * counts, fall back to a character-based estimate over the conversation sent and the
 * model's textual response (DQ-001 / ODQ-005). The estimate is bounded and monotonic
 * — its only job is to keep the token ceiling enforceable when the SDK omits counts,
 * never to be exact.
 */
function resolveTurnUsage(
  reported: Usage | undefined,
  conversation: ConversationMessage[],
  response: { toolCalls: unknown; finalAnswer: string | null },
): Usage {
  const hasCounts =
    reported !== undefined &&
    typeof reported.inputTokens === "number" &&
    typeof reported.outputTokens === "number" &&
    (reported.inputTokens > 0 || reported.outputTokens > 0) &&
    reported.estimated !== true;
  if (hasCounts) {
    return reported as Usage;
  }
  // Estimate: input chars ≈ the serialized conversation handed to the model; output
  // chars ≈ the final answer text plus the serialized tool-call requests.
  const inputChars = JSON.stringify(conversation).length;
  const outputChars =
    (response.finalAnswer ?? "").length +
    (response.toolCalls ? JSON.stringify(response.toolCalls).length : 0);
  return estimateUsage(inputChars, outputChars);
}

export type AgentRun = ReturnType<typeof createAgentRun>;
