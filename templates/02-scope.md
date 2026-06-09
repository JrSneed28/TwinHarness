# Scope — <project name>

> **Stage 2 — Scope Definition** (spec §14.2). Sticky, human-gated. Decides what is built now
> versus later. Once signed off, scope is intent — only a human moves it (§10). Reference REQ-IDs
> throughout so downstream mechanical traceability holds (§11, §17).

## Summary

<3–6 sentences: what the MVP is, what is explicitly out of scope, and the key scoping trade-off the
user confirmed. This block is the default handoff currency — downstream stages read THIS, not the
whole document (§9).>

- **MVP in one sentence:** <the smallest thing that makes the project useful to its first users>
- **Key items confirmed out of scope:** <two or three explicit exclusions>
- **Top scope risk:** <the most likely "scope creep" vector>

---

## Requirements Summary

<One paragraph recapping the approved requirements (from `docs/01-requirements.md` Summary). Name
the core goal, primary users, and top success measure. Reference the REQ-IDs this scope document
governs. Do not reproduce the full requirements — this is a recap for orientation.>

---

## MVP Scope

<The minimum set of features required for the project to be useful to its first users. Every item
here must pass both pruning questions:>
<- "Is this required for the first usable version?">
<- "Would the project still solve the core problem without this?">
<If the answer to either is no, it belongs in V1 Scope or Future Scope.>
<Anchor each item to the REQ-ID(s) it satisfies.>

- <Feature / capability> — REQ-<###>
- <Feature / capability> — REQ-<###>
- <…>

---

## V1 Scope

<Items that are not in MVP but are planned for the first public/production release. These passed the
"does the core problem remain solvable?" test but are deferred to keep the MVP tight. Reference
REQ-IDs where applicable.>

- <Feature / capability> — REQ-<###> *(deferred from MVP — rationale)*
- <…>

---

## Future Scope

<Items acknowledged as valuable but explicitly deferred beyond V1. Not committed to; may or may not
be built. Include here to prevent scope creep into MVP or V1.>

- <Feature / capability> *(future — not committed)*
- <…>

---

## Out of Scope

<Things the project will **not** do, stated plainly. Explicit exclusions prevent silent
re-inclusion during implementation. Reference any requirements that were considered and rejected.>

- <Item> — explicitly excluded *(rationale)*
- <…>

---

## Non-Goals

<Outcomes the project is not trying to achieve, even if adjacent to its purpose. Distinct from
"Out of Scope" in that non-goals are about intent, not feature coverage.>

- <Non-goal> — <why it is out of intention, not just deferred>
- <…>

---

## Scope Risks

<Specific risks that could cause scope to grow, shift, or collapse. Each risk should be traceable
to a requirement or a confirmed user decision.>

- **SCOPE-RISK-001** — <risk description> — related: REQ-<###>
- **SCOPE-RISK-002** — <risk description>
- <…>

---

## User-Confirmed Decisions

<The explicit calls the user made during the scoping conversation. Record these verbatim or as
close as possible — they are the sticky decisions that require a human to change (§10). Reference
the REQ-IDs and scope sections each decision affects.>

| Decision | Confirmed by | Affects |
|---|---|---|
| <what was decided> | human (scope sign-off) | MVP Scope · REQ-<###> |
| <what was decided> | human (scope sign-off) | Out of Scope |
| <…> | | |
