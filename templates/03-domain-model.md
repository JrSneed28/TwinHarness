# Domain Model — <project name>

> **Stage 3 — Domain Modeling** (spec §14.3). Streams; no human gate. Reads the Summaries from
> `01-requirements.md` and `02-scope.md` by default; fetches full artifacts only when a detail
> cannot be resolved from the Summary (§9). Proposes an initial model first, then invites the
> user to confirm, correct, or expand. Where entities realize a specific requirement, anchor them
> to the REQ-ID so traceability holds downstream (§11).

## Summary

<3–6 sentences: the core concepts this system works with, the most important entity, and the key
rule or invariant that governs the domain. This block is the default handoff currency —
downstream stages read THIS, not the whole document (§9).>

- **Central entity:** <the one concept everything else orbits>
- **Key relationship:** <the most important structural link between entities>
- **Core domain rule:** <the one invariant that must never be violated>

---

## Domain Summary

<One or two paragraphs describing the "world" of this project in plain language — the concepts,
actors, and rules a new reader needs to understand before looking at any code. Derive this from
the requirements Summary and scope Summary. Name the problem domain and explain what the system
is doing inside it. Avoid implementation language here; this is conceptual.>

---

## Core Entities

<The important "things" the system knows about and operates on. For each entity, state what it
represents in plain language, list the REQ-IDs it helps realize, and note which other entities
it is closely related to. Use the user's own vocabulary where possible.>

### <Entity Name>  <!-- REQ-<###>, REQ-<###> -->

<What this concept is in the real world or domain. One to three sentences. Anchor to the
requirement(s) this entity realizes.>

### <Entity Name>  <!-- REQ-<###> -->

<…>

---

## Relationships

<How entities connect to each other. Describe each meaningful relationship in plain language,
then give the cardinality (one-to-one, one-to-many, many-to-many) and direction. A simple list
or table is fine; avoid UML formalism unless the user is technical and asks for it.>

- **<EntityA> → <EntityB>** (one-to-many) — <what the relationship means>
- **<EntityB> → <EntityC>** (many-to-many) — <what the relationship means>
- <…>

---

## Attributes

<The properties that matter for each entity — not an exhaustive database schema, but the fields
that carry domain meaning, have constraints, or appear in rules. State any format or constraint
next to each attribute.>

### <Entity Name>

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| <name> | <string / date / enum / …> | <required, unique, ≥0, …> |
| <…> | | |

### <Entity Name>

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| <…> | | |

---

## State Models

<For entities that move through a lifecycle, name each state and list the transitions with their
triggering events. Plain prose for non-technical users; a state table or diagram description for
technical ones. Only model states that have domain significance — don't enumerate trivial CRUD
transitions.>

### <Entity Name> States

| State | Meaning | Transitions to | Trigger |
|---|---|---|---|
| <Pending> | <…> | <Active> | <user confirms> |
| <Active> | <…> | <Closed>, <Suspended> | <…> |
| <…> | | | |

---

## Domain Rules

<The invariants, policies, and business rules the system must enforce. Each rule should be
stated precisely enough that a developer could write a test for it. Anchor rules to REQ-IDs
where they enforce a specific requirement. Mark rules that carry blast-radius (security, money,
data integrity) — these will have human gates in implementation (§8).>

- **RULE-001** — <plain-language statement of the invariant> — REQ-<###>
- **RULE-002** — <…>  ⚠ *blast-radius: <data integrity / money / auth>*
- <…>

---

## Domain Events

<Significant things that happen in the domain that the system must observe, record, or react to.
Events are named in past tense ("OrderPlaced", "UserDeactivated"). Note which entity emits each
event and which REQ-ID motivates tracking it.>

| Event | Emitted by | REQ-ID | Meaning |
|---|---|---|---|
| <EntityCreated> | <Entity> | REQ-<###> | <what happened and why it matters> |
| <…> | | | |

---

## Glossary

<Definitions of domain terms in the user's own vocabulary. Every term that appears in the model
and might be ambiguous belongs here. The goal is that any agent reading this document shares the
same meaning for these words.>

| Term | Definition |
|---|---|
| <term> | <plain-language definition, disambiguating from any near-synonyms> |
| <…> | |

---

## Open Domain Questions

<Genuinely unresolved questions about the domain — ambiguities that could not be resolved from
the requirements and scope documents, or new ones surfaced by the modeling exercise. Blocking
questions must be resolved before architecture can proceed. Non-blocking questions may continue
with an assumed default noted.>

- **DQ-001** *(blocking / non-blocking)* — <question> — assumed default if proceeding: <…>
- **DQ-002** — <…>
