# SLICE-2 / TASK-005 — AgentRun loop + ToolRegistry dispatch over the LlmClient seam

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-004, REQ-005
**Slice:** SLICE-2 — Repo context & the real agent loop over the stubbed model
**Depends on:** SLICE-2 / TASK-004 complete (the loop sends the gathered context)

---

## Goal

Implement the **real** `agent-run` loop over the `LlmClient` seam and the `tool-registry` dispatcher:
each iteration sends the accumulated conversation + the five tool schemas to `LlmClient.send`, and
either routes a returned `tool_use` through `tool-registry.dispatch` (feeding the normalized
`ToolResult` back into the conversation) or finalizes on a final answer; `tool-registry` exposes
exactly the five schemas, dispatches each `ToolCall` to its executor, and normalizes every outcome
(including unknown tool names and malformed arguments) into exactly one `ToolResult` — never a throw.

---

## REQ-IDs

- **REQ-004** — The agent runs an LLM-driven loop using the Anthropic TS SDK with a Claude model:
  each iteration sends the task, accumulated context, and tool results to the model and receives
  either tool calls or a final answer.
- **REQ-005** — The agent exposes a tool interface to the model and executes the model's tool calls,
  feeding results back into the loop (tool-use / function-calling).

---

## Relevant Contracts / Interfaces

```typescript
// IF-006 LlmClient.send
send(conversation, toolSchemas): Promise<{
  toolCalls: ToolCall[] | null;   // null when finalAnswer present
  finalAnswer: string | null;
  stopReason: "tool_use" | "end_turn" | "max_tokens" | "stop_sequence";
  usage: { inputTokens: number; outputTokens: number; estimated: boolean };
}>

// IF-008 ToolRegistry
schemas(): ToolSchema[];                          // EXACTLY five (RULE-012)
dispatch(toolCall: ToolCall): Promise<ToolResult>; // exactly one ToolResult per dispatch (INV-008)

// ToolCall (untrusted model output)
interface ToolCall { id: string; toolName: "read_file"|"list_search"|"write_edit"|"run_command"|"apply_patch"; arguments: object; }

// ERR-005 UNKNOWN_TOOL (Channel A): toolName not one of the five → error ToolResult (no throw).
// Malformed arguments → the tool's typed error result (no throw).
```

---

## Relevant Design Notes

- **Strictly sequential** — one `ToolCall` resolved fully before the next (locked: no parallel
  tools). REQ-NFR-002's no-in-process-race property depends on this.
- `tool-registry` enforces RULE-012 (fixed five-tool surface) and RULE-008 (tool errors become
  results, never crashes). An unknown `stopReason` must be handled without a hang
  (`test_REQ004_unknown_stop_reason_handled`).
- A **fatal** class raised by an executor (invariant breach / transcript write failure) is
  re-raised, not swallowed — it flows to the `agent-run` unrecoverable-error path (classification is
  SLICE-7's job; here just propagate it).
- This task uses real tool *stubs* for dispatch wiring; real tool bodies arrive in SLICE-3+.

---

## Acceptance Test(s)

- `test_REQ004_loop_sends_conversation_and_receives_action` — each iteration calls
  `LlmClient.send` with the accumulated conversation + the five tool schemas and routes the returned
  tool_use/final answer.
- `test_REQ004_unknown_stop_reason_handled` — an unknown `stop_reason` is handled without a hang.
- `test_REQ005_dispatch_executes_and_feeds_result` — `tool-registry.dispatch` returns exactly one
  normalized `ToolResult` that is fed back into the loop.
- `test_REQ005_unknown_tool_rejected` — an unknown tool name → `UNKNOWN_TOOL` error result (no throw).
- `test_REQ005_malformed_tool_arguments` — malformed args → the tool's typed error result (no throw).
- `test_REQ005_independent_steps_no_rollback` — independent steps do not roll back one another.

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The loop + dispatch honor IF-006 / IF-008; any newly-pinned shape promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-004/005 still map to passing tests).

---

## Out of Scope for This Task

- LlmClient retry/backoff + fatal classification (SLICE-2 / TASK-006).
- Real tool behavior (SLICE-3…6) — dispatch to stub executors here.
- Budget pre-turn guard / stop classification (SLICE-7).
