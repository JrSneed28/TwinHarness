# ADR-004 — Deterministic harness via DI seams for the LLM SDK and shell

> **Stage 5 — Architecture Decision Record** (spec §15.5). One file per decision. Links to the
> REQ-IDs and components it serves.

**Decision summary:** The two non-deterministic dependencies — the Anthropic SDK and OS process/shell
execution — are isolated behind exactly two injected interfaces (`LlmClient`, `CommandRunner`) so the
entire harness is plain deterministic code, unit-testable offline with stubs.

---

## Title / ID

**ADR-004** — Deterministic harness via dependency-injection seams (`LlmClient`, `CommandRunner`)

---

## Status

accepted

*Date accepted:* 2026-06-09
*Supersedes:* —
*Superseded by:* —

*Basis:* locked constraint — REQ-NFR-002 is a hard non-negotiable (determinism of harness).

---

## Context

REQ-NFR-002 is a hard non-negotiable: all non-LLM logic — tool dispatch, path sandboxing, diff
generation, edit application, loop control, stop conditions, config parsing — must be deterministic
and testable **without** live network, live model calls, or live shell execution (also a
Non-Negotiable; REQ-NFR-001 requires every functional REQ to be automated-test-verifiable, and
RULE-015 makes the harness unit-testable with stubs). This is the **strongest force on the whole
design**: it dictates where every non-deterministic edge of the system must live.

The system has exactly two sources of non-determinism that cross into the real world: the Anthropic
Messages API (network + model) and OS process/shell execution. The decision is how to structure the
codebase so these two edges do not contaminate the harness's testability — and this structural choice
is foundational because every component above the seams is written against the interfaces, not the
concrete implementations. Reversing it (letting components call the SDK or `child_process` directly)
would re-couple the whole harness to live dependencies.

**Relevant REQ-IDs:** REQ-NFR-002, REQ-NFR-001, REQ-009, REQ-004, REQ-005
**Components affected:** `llm-client`, `command-runner`, `agent-run`, `cli` (composition root), and
transitively every harness component

---

## Decision

> **Chosen:** isolate the SDK behind a single `LlmClient` interface and OS process/shell execution
> behind a single `CommandRunner` interface; inject real implementations at the `cli` composition
> root in production and deterministic stubs in tests.

These are the **only two seams** in the system; everything else is deterministic by construction.
This optimizes for **full offline testability of the harness**: with the model and shell stubbed,
loop control, sandboxing, diffing, approval, budget, and stop logic are all plain deterministic code
exercised by Vitest without network or live processes (REQ-NFR-002, RULE-015). The seams also
contain two cross-cutting concerns cleanly — bounded-backoff retry lives in `llm-client` (REQ-NFR-004)
and cross-platform shell handling lives in `command-runner` (REQ-NFR-007). The tradeoff consciously
accepted is the **indirection and the discipline** the rule imposes: no component may reach for the
SDK or `child_process` directly, and the seam interfaces become contracts that must stay faithful to
the real dependencies they wrap.

*Human gate triggered:* no — locked non-negotiable (REQ-NFR-002) carried from requirements.

---

## Consequences

### Positive

- **The entire harness is unit-testable offline** — with `LlmClient` and `CommandRunner` stubbed,
  `agent-run`, `path-sandbox`, `diff-engine`, `approval-gate`, `budget-stop` and the tools run
  deterministically under Vitest (REQ-NFR-002, REQ-NFR-001, RULE-015).
- **Cross-cutting concerns are contained at the seams** — retry/backoff sits in `llm-client`
  (REQ-NFR-004); cross-platform shell/path quirks sit in `command-runner` (REQ-NFR-007,
  SCOPE-RISK-005), instead of being scattered.
- **The two irreversible protocol/format choices are bounded** — the tool-use protocol (ADR-001) is
  confined to `llm-client`, limiting the blast radius of a future change to that one interface.

### Negative

- **Indirection cost** — every model/shell interaction goes through an interface rather than a direct
  call; contributors must thread dependencies from the `cli` composition root and resist calling the
  SDK / `child_process` inline.
- **Seam-fidelity risk** — a stub that diverges from the real `@anthropic-ai/sdk` or `child_process`
  behavior can give false test confidence; the seams need contract-level coverage, not just unit
  stubs, to stay honest.
- **A small live/integration surface remains untested by the deterministic suite** — the real
  `LlmClient` and `CommandRunner` implementations still need their own (network/process-touching)
  verification outside the offline harness tests.

### Future obligations

- `07-contracts.md` must define the `LlmClient` and `CommandRunner` interface contracts as the
  testable boundaries, including what the stubs must honor.
- `08-test-strategy.md` must specify both the offline harness suite (stubbed seams) and the
  contract-level checks that keep the seams faithful to the real dependencies.

---

## Alternatives Considered

### Option A — Two DI seams (`LlmClient`, `CommandRunner`) *(chosen)*

Isolate the only two non-deterministic edges behind injected interfaces; everything else
deterministic. Chosen because it directly realizes the REQ-NFR-002 non-negotiable — see Decision.

### Option B — Direct SDK / `child_process` calls with network & shell mocking in tests

- **What it is:** let components call `@anthropic-ai/sdk` and Node `child_process` directly, and rely
  on module-level mocking / network interception (e.g. nock, vi.mock) in tests for determinism.
- **Why rejected:** it fails the spirit of REQ-NFR-002 — non-determinism would be smeared across the
  codebase rather than isolated to two seams, making the harness's determinism depend on fragile,
  test-only mocking infrastructure instead of clean architecture. It also disperses retry and
  cross-platform handling instead of containing them.
- **Would be right if:** there were no determinism non-negotiable and the priority were minimal
  indirection over testability — the opposite of this project's hard constraint.

### Option C — A single generic "effects" seam covering both LLM and shell

- **What it is:** one interface abstracting all side effects (model + shell + fs) behind a common
  port.
- **Why rejected:** over-generalizes two genuinely different concerns — model transport (with
  tool-use protocol + retry) and process execution (with cross-platform shell handling) have
  different contracts, errors, and stub shapes; collapsing them yields a leaky, awkward interface and
  obscures the distinct cross-cutting concerns each seam contains.
- **Would be right if:** the two dependencies shared a near-identical contract — they do not.

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-NFR-002 | drives this decision (determinism non-negotiable) |
| Requirement | REQ-NFR-001 | drives this decision (every REQ automated-test-verifiable) |
| Requirement | REQ-NFR-004 | served (retry/backoff contained in `llm-client`) |
| Requirement | REQ-NFR-007 | served (cross-platform handling contained in `command-runner`) |
| Requirement | REQ-009 | constrained (shell exec only via `command-runner`) |
| Component | `llm-client` | owns this decision (SDK seam) |
| Component | `command-runner` | owns this decision (shell seam) |
| Component | `cli` | affected (composition root injects real impls or stubs) |
| Component | `agent-run` | affected (depends on the interfaces, not concretes) |
| Downstream artifact | `07-contracts.md` | the `LlmClient` / `CommandRunner` interface contracts follow from this decision |
| Downstream artifact | `08-test-strategy.md` | must reflect the offline harness suite + seam-fidelity checks |
