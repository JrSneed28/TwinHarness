# TwinHarness Critic Modes — Specification Stages (part of the TwinHarness orchestrator playbook)

Grounded-defect checklists for Critic modes in the specification stages: `requirements`, `scope`,
`domain-model`, and `architecture` — the problem space and high-level design before implementation.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## `requirements` — IMPLEMENTED (Slice 1)

Check a requirements artifact (`docs/01-requirements.md`):

- **Internally consistent** — no section contradicts another; constraints don't forbid stated
  requirements; success criteria are achievable.
- **REQ-IDs assigned** to every functional requirement (REQ-001 …) — the downstream anchors (spec §11).
- **Success measures present** — ≥1 concrete, verifiable criterion (spec §14.1).
- **Not a vague mega-spec** — narrowed to a concrete core goal; a thin spec over a vague mega-request is a defect.
- **No contradictions** — non-negotiables don't silently contradict functional requirements.
- **Users identified** — ≥1 intended user type named.
- **Goal is clear and bounded** — usable as a one-sentence brief to a new developer.

> Example: "Success Criteria section is empty — spec §14.1 requires ≥1 success measure"
> Example: "Non-Negotiables §4 forbids third-party auth; REQ-007 requires OAuth — direct contradiction"
> Example: "Core goal ('build a SaaS thing') is not bounded — vague mega-spec defect (spec §5)"

---

## `scope` — IMPLEMENTED (Slice 2)

Check a scope artifact (`docs/02-scope.md`):

- **Every MVP item passes both pruning questions** — *"Required for the first usable version?"* AND
  *"Would the project fail to solve the core problem without it?"* An item that fails both belongs in
  V1/Future Scope, not MVP — a grounded defect.
- **Nothing in requirements is silently absent** — every functional REQ-ID appears in MVP/V1/Future/Out
  of Scope, or carries an explicit deferral with a reason.
- **Scope decisions carry REQ-ID anchors** (spec §11) — unanchored placements can't be coherence-verified.
- **Future Scope is distinguishable from MVP** — no item in both sections.
- **Out of Scope does not contradict any functional requirement** — placing a REQ-required capability
  Out of Scope is a direct contradiction.
- **Scope Risks trace to specific REQ-IDs** with the mechanism of risk; an unanchored risk is a defect.
- **User-Confirmed Decisions section present** (spec §8) recording human-signed-off scope choices.

> Example: "MVP item 'Advanced analytics dashboard' — REQ-011 doesn't require it for the first usable version and the core problem is solved without it; fails both pruning questions"
> Example: "REQ-009 appears in `01-requirements.md` but has no entry in any scope section — silently absent"
> Example: "'Third-party SSO login' is Out of Scope but REQ-006 explicitly requires OAuth — contradiction"

---

## `domain-model` — IMPLEMENTED (Slice 3)

Check a domain-model artifact (`docs/03-domain-model.md`):

- **Entity coverage** — every significant noun in requirements/scope is an entity (or attribute) or
  explicitly excluded with a reason. A noun in ≥1 REQ-ID with no entity and no rationale is a defect.
- **Relationship consistency** — directionally consistent (an "A has many B" has a corresponding B-side
  reference unless the unidirectional nature is justified).
- **No entity contradicts scope** — an out-of-scope entity (per `02-scope.md`) is a defect unless flagged future-scope.
- **State models complete** — any entity with a lifecycle mentioned in requirements has a state model;
  missing transitions are defects.
- **Domain rules are grounded** — each traces to ≥1 REQ-ID or scope constraint.
- **Glossary consistent** with terms used in entity/relationship sections.
- **REQ-ID anchors present** on core entities and rules (spec §11).

> Example: "Entity 'Payment' appears in REQ-007 but has no Core Entities entry and no exclusion rationale"
> Example: "Order state model omits the 'Cancelled' transition mentioned in REQ-003"
> Example: "Domain Rule DR-02 has no REQ-ID anchor — spec §11 requires anchors on all rules"

---

## `architecture` — IMPLEMENTED (Slice 3)

Check an architecture artifact (`docs/04-architecture.md`). **Grounded coherence only** (spec §14.4):
verify consistency with requirements/scope/domain model and internal self-consistency. Do NOT raise
technology-preference opinions as defects.

- **Every REQ-ID supported** — each functional REQ-ID traceable to ≥1 component or flow.
- **Fits scope** — no component exists solely for out-of-scope functionality unless flagged future-scope.
- **Reflects the domain model** — every core entity is handled by ≥1 component (stored/processed/routed).
- **All domain entities covered** — check Core Entities against the Responsibilities section.
- **Clean responsibilities** — each component's responsibility set is coherent, not an unrelated grab-bag.
- **Clean boundaries** — boundaries between components and external systems are explicit.
- **Architecture Risks present** when the architecture has evident tradeoffs.
- **Security and Failure-Modes sections present** (folded) for T1/T2; for T3 a note that they graduate
  to `08a-security-threat-model.md` / `08b-failure-edge-cases.md` satisfies this.
- **Verification Notes present** — which REQ-IDs the Critic verified and any open questions escalated.

> Example: "REQ-005 (export to CSV) has no component or flow responsible for it"
> Example: "Entity 'Subscription' (domain model §2) appears in no component's responsibilities"
> Example: "Security section is absent — required for Tier 2 (spec §14.4)"
