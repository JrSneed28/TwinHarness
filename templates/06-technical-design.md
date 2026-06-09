# Technical Design — <project name>

> **Stage 6 — Detailed Technical Design** (spec §15.6). Streams; asks the human only where a
> behavior choice is product-meaningful (e.g., last-write-wins vs. merge on conflict). Reads the
> Summary blocks from `04-architecture.md` and `07-contracts.md` (when available) by default;
> fetches full artifacts only when a detail cannot be resolved from the Summary (§9). Deliberately
> **stops where code is clearer than prose** — over-specifying trivial components wastes effort.
> Component designs are anchored to REQ-IDs from `01-requirements.md` (§11).

## Summary

<3–6 sentences: which components received non-trivial designs, the key algorithms or state
machines introduced, and any product-meaningful behavior choices the human approved. This block
is the default handoff currency — downstream stages read THIS, not the whole document (§9).>

- **Components designed:** <list of non-trivial components with one-phrase responsibility each>
- **Key algorithms / state machines:** <one line per significant one>
- **Human-approved behavior choices:** <any product-meaningful decisions that went to a human gate>

---

## Component Designs

<For each component with non-obvious internal behavior, specify the internal logic, entry/exit
points, and any invariants the component must maintain. Skip components whose behavior is
obvious from the architecture — name them and state "no non-trivial design" so the Critic
knows they were consciously omitted.

Each component design must anchor to the REQ-IDs it serves.>

### <ComponentName>

**Realizes:** REQ-<###>, REQ-<###>
**Purpose (one sentence):** <what this component does internally>

<Internal logic description: inputs accepted, processing steps, outputs produced, side effects.
Reference domain rules from `03-domain-model.md` where the logic enforces them.>

**Entry point(s):** <method / event / message that triggers this component>
**Exit point(s):** <return value / event emitted / side effect produced>
**Invariants maintained:** <what must always be true before and after this component runs>

### <ComponentName>

**Realizes:** REQ-<###>
**Purpose (one sentence):** <…>

<Internal logic description.>

**Entry point(s):** <…>
**Exit point(s):** <…>
**Invariants maintained:** <…>

---

## Key Algorithms / Workflows

<For each non-trivial algorithm or multi-step workflow, describe the steps in enough detail that
a Builder can implement without guessing. Use numbered steps or pseudocode where precision
matters. Anchor each to the REQ-IDs it satisfies and the component(s) that own it.

Stop where code is clearer than prose — if the algorithm is a standard library call or a
trivial loop, state that and move on.>

### <Algorithm / Workflow Name>

**Owned by:** `<component-name>`
**Realizes:** REQ-<###>

1. <Step 1 — input, precondition, action>
2. <Step 2 — transformation, validation, decision>
3. <Step 3 — output, side effect, postcondition>

**Edge cases:** <inputs that require special handling — empty set, zero, overflow, concurrent
callers, etc.>
**Complexity / cost:** <O(n) note or latency expectation if non-obvious>

---

## State Machines

<For each entity or component with meaningful state — more than trivially "created → done" —
draw the state machine as a list of states, transitions, and guards. Name the event or action
that triggers each transition and the component that fires it. Anchor to domain State Models
from `03-domain-model.md` where they overlap.>

### <Entity / Component Name> State Machine

**Realizes:** REQ-<###>
**Defined in domain model:** <yes — see `03-domain-model.md` §State Models | no — new>

| From state | Event / action | Guard | To state | Side effect |
|---|---|---|---|---|
| `<state>` | `<event>` | <condition, or "—"> | `<state>` | <emitted event / written record / "none"> |
| `<…>` | | | | |

**Terminal states:** <states from which no further transition is possible>
**Invalid transitions:** <transitions that must be rejected and the error returned>

---

## Error Handling

<For each error category, specify: what triggers it, which component owns the handling, what
response or recovery action is taken, and whether the error is exposed to the caller or
swallowed. Every entry must be anchored to a component and, where applicable, a REQ-ID.

Anti-boilerplate rule: "handle errors gracefully" is not a valid entry — each row must name a
specific component, error condition, and response.>

| Component | Error condition | Owner of handling | Response / recovery | Exposed to caller? |
|---|---|---|---|---|
| `<component-name>` | <specific error — timeout, validation failure, conflict, …> | `<component-name>` | <retry N times / fail-closed / return error code / escalate> | yes / no |
| `<…>` | | | | |

**Error propagation model:** <how errors bubble up — exceptions / result types / error events /
status codes — and where the boundary between internal and external error representation is.>

---

## Concurrency / Ordering / Idempotency

<Specify any concurrency or ordering constraints the Builder must respect. For each concern,
name the component, state the constraint, and give the mechanism that enforces it.

If this system is single-threaded or has no concurrent writers, state that explicitly — the
Critic needs to know it was considered, not skipped.>

### Concurrency constraints

- **`<component-name>`** — <constraint: e.g., "at most one writer at a time; enforced by <mutex /
  queue / optimistic lock / …>">
- <…>

### Ordering constraints

- **`<component-name>`** — <constraint: e.g., "event B must always be processed after event A for
  the same entity; enforced by <sequence number / per-entity queue / …>">
- <…>

### Idempotency

- **`<operation>`** — <idempotent: yes / no> — <mechanism: e.g., "deduplicated by request-id;
  duplicate returns the same response without re-executing side effects">
- <…>

---

## Invariants

<State the system-wide and per-component invariants that must hold at all times — not just
within a single operation, but across the lifetime of the system. These become the assertions
the Critic checks and the property-based test seeds for Stage 8.

Anchor each invariant to the REQ-ID or domain rule it expresses.>

- **INV-001** — <invariant statement> — enforced by: `<component-name>` — anchors: REQ-<###>
- **INV-002** — <…> — enforced by: <…> — anchors: REQ-<###>
- **INV-003** — <…>

---

## Open Design Questions

<Genuinely unresolved design choices that would affect implementation. Each question must either
be answered before Stage 8 (test strategy) begins or be explicitly deferred with a recorded
consequence. Blocking questions must be closed before the Critic passes this stage.>

- **ODQ-001** — <question> — blocking: <yes / no> — owner: <component / stage> — consequence if
  deferred: <…>
- **ODQ-002** — <…>
