# ADR-003 — Single sequential agent loop, no parallel tool execution

> **Stage 5 — Architecture Decision Record** (spec §15.5). One file per decision. Links to the
> REQ-IDs and components it serves.

**Decision summary:** The agent runs **one strictly sequential loop** that resolves each tool call
fully before the next, with **no parallel tool execution, queues, or schedulers**, because it
maximizes determinism, auditability, and safety-gating simplicity for the MVP — parallelism is
Future scope.

---

## Title / ID

**ADR-003** — Single sequential agent loop, no parallel tool execution

---

## Status

accepted

*Date accepted:* 2026-06-09
*Supersedes:* —
*Superseded by:* —

*Basis:* locked constraint (single sequential loop, no parallel tools — Assumptions / scope; parallel
tools are explicitly Future scope).

---

## Context

The harness must execute the model's tool calls and feed results back (REQ-004, REQ-005), while every
mutating/executing call passes through two safety gates — `path-sandbox` (REQ-021) and `approval-gate`
(REQ-012/016) — and a human may be prompted to approve an edit or a non-allowlisted command mid-run
(domain state `AwaitingApproval`). The execution model is foundational: it shapes the conversation
accumulation, the budget guard placement, the approval-prompt flow, and the transcript event
ordering. Choosing concurrency here would ripple through all of those.

A model turn can return more than one `tool_use` block. The harness can either resolve them one at a
time (sequential) or dispatch several concurrently (parallel). Concurrency is attractive for latency
but it collides with the project's non-negotiables: deterministic harness (REQ-NFR-002), bounded
ordered audit (RULE-010), per-turn budget guard (RULE-006), and synchronous human approval.

**Relevant REQ-IDs:** REQ-004, REQ-005, REQ-NFR-002, REQ-014, REQ-015
**Components affected:** `agent-run`, `tool-registry`, `approval-gate`, `budget-stop`, `transcript`

---

## Decision

> **Chosen:** a single, strictly sequential agent loop — one tool call resolved fully (gate →
> execute → record) before the next; no parallel tool execution, no queues, no schedulers.

The MVP is synchronous and sequential by design. The only concurrency concern is bounded-backoff
retry inside `llm-client`, which is sequential from the loop's perspective. This optimizes for
**determinism, simple safety-gating, and a clean ordered audit**: with one effect in flight at a
time, `path-sandbox` and `approval-gate` see a single unambiguous request, the human is prompted for
exactly one action at a time, the `budget-stop` guard runs cleanly before each turn, and the
`transcript` is a single totally-ordered event stream. The tradeoff consciously accepted is
**higher wall-clock latency** for multi-action turns and a hard cap on throughput — accepted because
the MVP value is delegated, auditable, controlled coding, not speed.

*Human gate triggered:* no — locked constraint carried from requirements/scope (parallel tools are
Future scope).

---

## Consequences

### Positive

- **`agent-run` is deterministic and simple to test** — a single in-flight effect means loop control,
  budget checks, and stop resolution are plain sequential code unit-testable with stubs (REQ-NFR-002,
  RULE-015).
- **`approval-gate` and `path-sandbox` gate one unambiguous request at a time** — no interleaving of
  concurrent write/exec intents, so the safety boundary stays simple and the `AwaitingApproval`
  human-prompt flow is a clean suspend/resume (REQ-012/016, REQ-021).
- **`transcript` is a single totally-ordered event stream** — no concurrent-event interleaving to
  reconcile, which keeps the JSONL audit (ADR-002) faithful and reconstructable (RULE-010,
  REQ-NFR-008).

### Negative

- **Higher latency / lower throughput per multi-action turn** — independent reads/searches the model
  requests in one turn execute one after another instead of concurrently; `agent-run` cannot overlap
  I/O.
- **No speedup from inherently parallel work** — e.g. running independent read-only searches in
  parallel is impossible in the MVP, capping how fast a run can converge.
- **A future move to parallel tools is a real change to `agent-run`** — loop control, budget
  accounting per concurrent call, gate ordering, and transcript ordering would all need rework
  (Future scope), so the simplicity is bought against that future cost.

### Future obligations

- If parallel tool execution is adopted later (Future scope), the budget guard (RULE-006), approval
  ordering, and transcript ordering semantics must be redesigned and re-tested; `06-technical-design.md`
  should note the sequential assumption explicitly so the future change is scoped.

---

## Alternatives Considered

### Option A — Single sequential loop *(chosen)*

One tool call resolved fully before the next; no concurrency. Chosen for determinism, simple gating,
and clean ordered audit — see Decision.

### Option B — Parallel / concurrent tool execution

- **What it is:** dispatch multiple `tool_use` blocks from a single model turn concurrently (e.g.
  several reads/searches at once), collecting results as they complete.
- **Why rejected:** collides with the locked determinism non-negotiable (REQ-NFR-002) and complicates
  every safety-critical path — concurrent write/exec intents make `approval-gate` prompting ambiguous,
  the per-turn `budget-stop` guard harder to enforce exactly (RULE-006), and the `transcript`
  ordering non-trivial (RULE-010). It buys latency at the cost of the project's core guarantees.
- **Would be right if:** throughput were a primary requirement and the tool surface were read-only /
  side-effect-free, removing the gating and ordering hazards — not the case for a mutating,
  exec-capable, audit-critical MVP.

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-004 | constrained by this decision (loop is sequential) |
| Requirement | REQ-005 | constrained by this decision (tool calls resolved one at a time) |
| Requirement | REQ-NFR-002 | drives this decision (determinism non-negotiable) |
| Requirement | REQ-014 | served (single in-flight effect → clean stop resolution) |
| Requirement | REQ-015 | served (per-turn budget guard runs cleanly) |
| Component | `agent-run` | owns this decision (the loop) |
| Component | `tool-registry` | affected (dispatches one call at a time) |
| Component | `approval-gate` | affected (gates one request at a time) |
| Component | `budget-stop` | affected (pre-turn guard relies on sequential turns) |
| Component | `transcript` | affected (single ordered event stream) |
| Downstream artifact | `06-technical-design.md` | must reflect the sequential loop in the `agent-run` design |
