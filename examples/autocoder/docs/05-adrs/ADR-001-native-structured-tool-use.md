# ADR-001 — Tool-use protocol = Anthropic native structured tool-use

> **Stage 5 — Architecture Decision Record** (spec §15.5). One file per decision. Links to the
> REQ-IDs and components it serves.

**Decision summary:** The agent loop drives the model through **Anthropic's native structured
tool-use** (Messages API `tool_use` / `tool_result` content blocks) rather than a custom text-parsed
protocol, because the SDK and model are first-class for it and the requirements already mandate the
Anthropic SDK with function-calling.

---

## Title / ID

**ADR-001** — Tool-use protocol = Anthropic native structured tool-use

---

## Status

accepted

*Date accepted:* 2026-06-09
*Supersedes:* —
*Superseded by:* —

*Basis:* human-gated irreversible decision (ARCH-RISK-001, confirmed 2026-06-09 — the human deferred
the explicit gate and adopted the architect's recommended option).

---

## Context

Autocoder runs an LLM-driven loop in which the model must request file reads/writes, searches, and
shell commands, and receive their results, iterating until the task converges (REQ-004, REQ-005).
There are two ways the harness can carry that request/response traffic:

1. **Native structured tool-use** — declare typed tool schemas to the Messages API, receive
   `tool_use` blocks with parsed arguments, return `tool_result` blocks. The SDK validates and
   shapes this traffic.
2. **A custom text protocol** — instruct the model to emit a bespoke text/markup format (e.g. a
   fenced JSON or DSL), then parse it out of the free-text response with regexes/heuristics.

The constraints push hard toward option 1: the Anthropic TS SDK is a **locked** hard constraint, and
REQ-004/005 already specify "tool-use / function-calling" as the mechanism. The conversation shape,
the `LlmClient` interface contract, the `ToolRegistry` schema format, and every `ToolResult`
round-trip are built around whichever protocol is chosen — this is foundational to the loop's core
message handling, which is why it is costly to reverse.

**Relevant REQ-IDs:** REQ-004, REQ-005, REQ-NFR-002, REQ-NFR-004
**Components affected:** `llm-client`, `agent-run`, `tool-registry`

---

## Decision

> **Chosen:** Anthropic native structured tool-use (`tool_use` / `tool_result` content blocks via the
> Messages API), confined behind the `LlmClient` seam.

The harness declares the five tool schemas to the model through the SDK; the model answers with
structured `tool_use` blocks whose arguments are already parsed and typed; the harness returns each
outcome as a `tool_result` block. This optimizes for **robustness and low parsing surface**: typed,
validated tool arguments mean the loop's correctness does not depend on brittle regex extraction from
free text, and it aligns with the model's trained behavior so tool-calling is more reliable. The
tradeoff consciously accepted is **vendor coupling** of the protocol to Anthropic's API — mitigated
by confining the entire protocol to the single `LlmClient` interface (REQ-NFR-002), so a future
change is bounded to that seam rather than spread across the loop.

*Human gate triggered:* yes — confirmed by user on 2026-06-09 (recommended option adopted; explicit
gate deferred).

---

## Consequences

### Positive

- **`agent-run` core message handling stays simple and robust** — tool arguments arrive parsed and
  typed, so no free-text parsing layer sits on the critical loop path (REQ-005).
- **`tool-registry` schemas map directly to the SDK's tool-definition format** — one schema
  declaration serves both the model and validation, no separate prompt-format spec to maintain
  (REQ-005, REQ-023 five-tool surface).
- **Higher tool-call reliability** — using the model's first-class structured mode reduces malformed
  / unparseable tool requests, supporting the loop's convergence and the 70% success target
  (REQ-004).

### Negative

- **`llm-client` is coupled to Anthropic's structured-tool-use API shape** — the conversation format
  (content blocks, `tool_use_id` correlation) is Anthropic-specific; a future multi-provider effort
  (Future scope) cannot reuse this transport unchanged and must abstract it behind the seam.
- **Behavior is bound to model/SDK evolution** — if Anthropic changes tool-use semantics or block
  structure, `llm-client`, `agent-run`, and `tool-registry` may need coordinated updates
  (Model/tool-protocol drift, Risks).
- **Costly to reverse** — swapping to a text-parsed protocol later means rewriting the loop's core
  message accumulation and the tool round-trip, not a localized edit.

### Future obligations

- The `07-contracts.md` `LlmClient` interface contract must express the structured-tool-use shape
  (tool schemas in, `tool_use` blocks + usage out, `tool_result` blocks back) as the testable
  boundary.
- A future multi-provider abstraction (Future scope) must keep this protocol entirely behind the
  `LlmClient` seam so the loop is provider-agnostic above it.

---

## Alternatives Considered

### Option A — Anthropic native structured tool-use *(chosen)*

The SDK/model first-class path. Chosen for typed/validated arguments, low parsing surface, and
alignment with the locked Anthropic-SDK constraint — see Decision.

### Option B — Custom text-parsed tool protocol

- **What it is:** prompt the model to emit a bespoke text/JSON/DSL format for tool calls, then
  extract and parse tool calls and arguments from the model's free-text response.
- **Why rejected:** brittle and higher-risk — regex/heuristic parsing of free text is a fragile
  critical-path dependency that undermines loop reliability (REQ-NFR-004) and contradicts the spirit
  of the locked Anthropic SDK + function-calling mandate (REQ-004/005). It adds a parsing/validation
  layer the structured protocol gives for free.
- **Would be right if:** the project needed a single tool format portable across providers that lack
  native tool-use, or had to run against a model with no function-calling support — neither holds for
  the Anthropic-only MVP (see ADR-008).

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-004 | drives this decision (LLM loop via Anthropic SDK) |
| Requirement | REQ-005 | drives this decision (tool-use / function-calling) |
| Requirement | REQ-NFR-002 | constrains this decision (protocol confined to the injected `LlmClient` seam) |
| Requirement | REQ-NFR-004 | served by this decision (typed args reduce malformed-call failures) |
| Component | `llm-client` | owns this decision (the protocol lives here) |
| Component | `agent-run` | affected (loop message accumulation built on the structured shape) |
| Component | `tool-registry` | affected (tool schemas declared in the SDK's format) |
| Downstream artifact | `06-technical-design.md` | must reflect the structured round-trip in `llm-client` / `agent-run` designs |
| Downstream artifact | `07-contracts.md` | the `LlmClient` interface contract follows from this decision |
