# ADR-NNN — <short decision title>

> **Stage 5 — Architecture Decision Record** (spec §15.5). Streams; only genuinely irreversible
> decisions reach the human (§8). One file per decision; lives in `docs/05-adrs/ADR-NNN-*.md`.
> Each ADR must link to the REQ-IDs and components it serves. Non-technical users receive the
> decision framed as a plain tradeoff.

**Decision summary:** <one sentence stating what was decided and the primary reason.>

---

## Title / ID

**ADR-NNN** — <full decision title>

---

## Status

<proposed | accepted | superseded by ADR-NNN>

*Date accepted:* <YYYY-MM-DD>
*Supersedes:* <ADR-NNN, or "—">
*Superseded by:* <ADR-NNN, or "—">

---

## Context

<What situation, constraint, or requirement forced this decision? Describe the forces at play:
the technical environment, the requirements driving the choice, the constraints in scope, and
any prior decisions this builds on. Be specific — name the components, REQ-IDs, and domain
rules involved. This section answers "why did we have to decide anything at all?">

**Relevant REQ-IDs:** REQ-<###>, REQ-<###>
**Components affected:** `<component-name>`, `<component-name>`

---

## Decision

<State the decision clearly in one or two sentences, then explain the full reasoning: why this
option over the alternatives, which forces it resolves best, and which tradeoffs were consciously
accepted. If a human gate was triggered (§8), record that sign-off here.>

> **Chosen:** <the option selected>

<Explanation of reasoning — what this decision optimizes for and what it trades away.>

*Human gate triggered:* <yes — approved by user on YYYY-MM-DD | no — streamed>

---

## Consequences

<ALL consequences must be listed — including the negative ones. Split into positive and negative.
Each consequence must be anchored to a real component, REQ-ID, or downstream stage — generic
statements ("improves maintainability") without an anchor are not valid here.>

### Positive

- <concrete benefit anchored to component or REQ-ID>
- <…>

### Negative

- <concrete cost, constraint, or risk anchored to component or REQ-ID>
- <…>

### Future obligations

- <anything this decision requires to be done later — e.g., a migration path, a versioning
  contract, or a Stage 7 contract that must reflect this choice>

---

## Alternatives Considered

<Each alternative must be genuinely considered — not a strawman. For each, state what it is,
why it was not chosen, and what would have to be true for it to be the right answer instead.>

### Option A — <name> *(chosen)*

<Brief summary. Why chosen — see Decision section above.>

### Option B — <name>

- **What it is:** <description>
- **Why rejected:** <specific reason anchored to a REQ-ID, constraint, or consequence>
- **Would be right if:** <the condition under which this would be the better choice>

### Option C — <name>

- **What it is:** <description>
- **Why rejected:** <…>
- **Would be right if:** <…>

---

## Linked REQs / Components

<Every REQ-ID and component this ADR affects. This table is the mechanical anchor that lets the
Critic (adr mode) verify that the ADR is grounded and that downstream artifacts (Stages 6–9)
pick up the decision.>

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-<###> | <drives this decision / constrained by this decision> |
| Requirement | REQ-<###> | <…> |
| Component | `<component-name>` | <owns this decision / affected by this decision> |
| Component | `<component-name>` | <…> |
| Downstream artifact | `06-technical-design.md` | <must reflect this decision in §Component Designs> |
| Downstream artifact | `07-contracts.md` | <interface shape follows from this decision> |
