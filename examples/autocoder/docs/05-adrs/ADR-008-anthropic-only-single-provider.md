# ADR-008 — Single LLM provider: Anthropic-only for the MVP

> **Stage 5 — Architecture Decision Record** (spec §15.5). One file per decision. Links to the
> REQ-IDs and components it serves.

**Decision summary:** The MVP targets a **single LLM provider — Anthropic** (the `@anthropic-ai/sdk`
driving a Claude model) rather than a provider-agnostic abstraction; multi-provider support is
explicitly Future scope.

---

## Title / ID

**ADR-008** — Single LLM provider = Anthropic-only (MVP); multi-provider is Future

---

## Status

accepted

*Date accepted:* 2026-06-09
*Supersedes:* —
*Superseded by:* —

*Basis:* locked constraint — "LLM provider/SDK: Anthropic TypeScript SDK driving a Claude model
(Hard constraint — locked)"; multi-provider is Future scope.

---

## Context

The agent's reasoning and tool-calling are driven by an LLM. A coding-agent project could be built
provider-agnostically (an abstract model port with adapters for Anthropic, OpenAI, etc.) or bound to
one provider. The requirements settle this as a **hard locked constraint**: the Anthropic TS SDK
driving a Claude model, with the native structured tool-use protocol (ADR-001) as the chosen
transport. This decision is worth recording as an ADR because it is a deliberate, scope-shaping
choice with a real tradeoff (portability vs. focus), it interacts directly with ADR-001 and ADR-004,
and recording it prevents a future agent from silently "adding multi-provider support" as if it were
in scope.

It is moderately costly to reverse: the `llm-client` seam, the tool-use protocol bound to it, and the
conversation shape are Anthropic-specific; broadening to multiple providers later means generalizing
that seam and its protocol.

**Relevant REQ-IDs:** REQ-004, REQ-NFR-002, REQ-005
**Components affected:** `llm-client`, `agent-run`, `cli` (composition root)

---

## Decision

> **Chosen:** Anthropic-only for the MVP — production `llm-client` calls `@anthropic-ai/sdk` against a
> Claude model; no provider abstraction is built. Multi-provider support is deferred to Future scope.

This optimizes for **focus and depth on a flagship example that will be fully built**: a single
provider lets the harness commit to one first-class tool-use protocol (ADR-001) and one well-tested
transport rather than diluting effort across adapters, and it honors the locked constraint. The
tradeoff consciously accepted is **provider lock-in for the MVP** — the system cannot run on a
different model/provider without future work — mitigated by the fact that the SDK is already isolated
behind the single `llm-client` seam (ADR-004, REQ-NFR-002), so a future multi-provider effort is
bounded to generalizing that one interface.

*Human gate triggered:* no — locked constraint carried from requirements; multi-provider explicitly
Future scope.

---

## Consequences

### Positive

- **First-class tool-use depth** — committing to one provider lets `llm-client` and `agent-run` build
  on Anthropic's native structured tool-use (ADR-001) without lowest-common-denominator
  compromises (REQ-004, REQ-005).
- **Smaller, fully-buildable surface** — one transport to implement and test thoroughly, fitting the
  "flagship example, fully built and tested" delivery constraint.
- **Lock-in is already bounded** — because the SDK lives behind the single `llm-client` seam
  (ADR-004), the provider coupling is concentrated in one place rather than spread through the loop.

### Negative

- **Provider lock-in for the MVP** — the system cannot target another model/provider without building
  the deferred abstraction; users tied to a different provider cannot use the MVP.
- **A future multi-provider effort is real work** — generalizing `llm-client` and the tool-use
  protocol (ADR-001) to a provider-agnostic port, plus per-provider adapters and their tests, is a
  non-trivial change (Future scope), not a config toggle.
- **Coupled to Anthropic availability/pricing** — the run's feasibility and cost depend entirely on
  one vendor's API and rate limits (mitigated operationally by retry/backoff and the Budget, but the
  single-vendor dependency itself remains).

### Future obligations

- If multi-provider is taken up (Future scope), the `llm-client` interface in `07-contracts.md` must
  be generalized to a provider-agnostic model port, keeping ADR-001's protocol behind an
  Anthropic-specific adapter.

---

## Alternatives Considered

### Option A — Anthropic-only for the MVP *(chosen)*

Commit to one provider and one first-class tool-use protocol. Chosen per the locked constraint and
for focus/depth on a fully-built example — see Decision.

### Option B — Provider-agnostic model abstraction from day one

- **What it is:** an abstract model port with pluggable adapters (Anthropic, OpenAI, others) built in
  the MVP.
- **Why rejected:** contradicts the locked Anthropic-SDK constraint and adds breadth that dilutes
  depth — a generic port tends toward a lowest-common-denominator tool-use protocol, undercutting the
  native structured tool-use decision (ADR-001) and increasing MVP surface for a capability scope
  defers to Future.
- **Would be right if:** multi-provider portability were an MVP requirement — it is explicitly not;
  it is deferred to Future scope.

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-004 | drives this decision (Anthropic SDK + Claude model, locked) |
| Requirement | REQ-005 | constrained (tool-use bound to one provider's protocol, ADR-001) |
| Requirement | REQ-NFR-002 | mitigates this decision (SDK isolated behind the `llm-client` seam) |
| Component | `llm-client` | owns this decision (Anthropic-specific implementation) |
| Component | `agent-run` | affected (depends on the single-provider seam) |
| Component | `cli` | affected (wires the one real `llm-client` impl) |
| Downstream artifact | `07-contracts.md` | the `LlmClient` contract is single-provider for the MVP |
| Related ADR | ADR-001 | the bound tool-use protocol; ADR-004 — the seam that bounds the lock-in |
