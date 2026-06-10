# SLICE-0 / TASK-001 — Wire the end-to-end walking-skeleton spine

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** (structural — no functional REQ; REQ-NFR-002 partial)
**Slice:** SLICE-0 — Walking Skeleton
**Depends on:** none (first task built)

---

## Goal

Stand up the thinnest end-to-end path that exercises every significant architectural boundary in one
round-trip: `cli` parses argv → `config` resolves (stub key + temp-dir root) → `agent-run` is
constructed → `repo-context` builds a minimal context → the **stubbed `llm-client`** returns one
`read_file` `tool_use` then a `finalAnswer` → `tool-registry` dispatches to a minimal `tool-read` →
`path-sandbox.checkRead` passes → `approval-gate` passthrough (reads need no gate) → `ToolResult` fed
back → every event appended to the `transcript` (JSONL) → `reporter` emits a `RunOutcome` → `cli`
exits 0. It delivers no feature — it proves the wiring holds.

---

## REQ-IDs

- **(structural only)** — Slice 0 claims no functional REQ; it is the integration skeleton.
- **REQ-NFR-002 (partial)** — *Determinism of harness:* the Anthropic SDK and shell are injected
  behind interfaces so tests can stub them. This task establishes the stubbed-seam backbone
  (`LlmClient` + `CommandRunner` stubs, no network, no real shell).

---

## Relevant Contracts / Interfaces

```typescript
// IF-006 LlmClient (the seam the skeleton stubs) — send returns parsed model output + usage
interface LlmClient {
  send(conversation: ConversationMessage[], toolSchemas: ToolSchema[]): Promise<{
    toolCalls: ToolCall[] | null;   // null when finalAnswer present
    finalAnswer: string | null;
    stopReason: "tool_use" | "end_turn" | "max_tokens" | "stop_sequence";
    usage: { inputTokens: number; outputTokens: number; estimated: boolean };
  }>;
}

// IF-008 ToolRegistry — exactly one normalized ToolResult per dispatch (INV-008)
interface ToolRegistry {
  schemas(): ToolSchema[];                       // the five tool schemas
  dispatch(toolCall: ToolCall): Promise<ToolResult>;
}

// ToolResult (normalized)
interface ToolResult {
  toolCallId: string;
  status: "ok" | "error";
  output?: object;   // present iff status="ok"
  error?: { code: string; message: string };  // present iff status="error"
}

// IF-012 TranscriptWriter — append-only JSONL; minimal entries for the skeleton
interface TranscriptWriter {
  open(runId: string): Promise<void>;
  append(entry: TranscriptEntry): Promise<void>; // durable per entry
  flush(): Promise<void>;
}

// RunOutcome (rendered by reporter; classified fully in SLICE-7) — minimal for the skeleton
interface RunOutcome { status: "succeeded" | "stopped" | "failed"; exitCode: number; runId: string; }
```

Transcript entries the skeleton must emit, in `seq` order: `run-started`, `tool-called` (read_file),
`tool-result`, `run-completed`.

---

## Relevant Design Notes

- **Single sequential loop, DI seams injected (REQ-NFR-002, ADR-004).** `cli` is the composition
  root: it injects the stub `LlmClient` + stub `CommandRunner` in tests, real ones in production.
- This is a **skeleton, not a prototype**: prefer thin real implementations of the wiring over mocks
  for the in-process components (`agent-run`, `tool-registry`, `transcript`, `reporter`); only the
  two DI seams are stubbed.
- The acceptance test asserts the **ordered transcript chain across all components**, not any single
  component in isolation — that is the integration proof.

---

## Acceptance Test(s)

- `test_slice0_walking_skeleton_wires_end_to_end` — a single stubbed iteration (one `read_file`
  tool_use then a final answer) drives entry → config → loop → dispatch → read tool → both gates →
  transcript → reporter → `RunOutcome{status:"succeeded", exitCode:0}`, and the on-disk transcript
  contains `run-started` → `tool-called` → `tool-result` → `run-completed` in `seq` order, against a
  temp-dir fixture, with no network call and no real subprocess.

---

## Definition of Done

- [ ] `test_slice0_walking_skeleton_wires_end_to_end` passes against stubbed `LlmClient` + stubbed
      `CommandRunner` + temp-dir fixture.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The minimal interfaces touched (`LlmClient`, `ToolRegistry`, `TranscriptWriter`, `RunOutcome`)
      match `07-contracts.md`; any newly-pinned shape is promoted there.
- [ ] `th coverage check` does not regress (Slice 0 adds no functional coverage row).

---

## Out of Scope for This Task

- Real config precedence / fail-fast (SLICE-1 / TASK-003).
- The real multi-turn loop semantics, retry, and tool-error normalization (SLICE-2).
- Real tool behavior beyond a trivial read (SLICE-3+); the skeleton's `tool-read` need only return
  canned content sufficient to produce a `ToolResult`.
- Budget/stop classification, the full `--json` summary, allowlist — later slices.
