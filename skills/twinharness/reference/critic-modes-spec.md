# TwinHarness Critic Modes — Specification Stages (part of the TwinHarness orchestrator playbook)

This file contains the grounded-defect checklists for Critic modes in the specification stages:
`requirements`, `scope`, `domain-model`, and `architecture`. These stages define the problem space
and high-level design before implementation.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## `requirements` — IMPLEMENTED (Slice 1)

**What to check for a requirements artifact (`docs/01-requirements.md`):**

- **Internally consistent.** No section contradicts another; stated constraints do not forbid stated
  requirements; success criteria are achievable given the constraints.
- **REQ-IDs assigned.** Every functional requirement has a REQ-ID (REQ-001 …); these are the
  anchors used by every downstream stage (spec §11).
- **Success measures present.** At least one concrete, verifiable success criterion (spec §14.1).
- **Not a vague mega-spec.** The brief must have been narrowed to a concrete core goal; a thin
  high-level spec over a vague mega-request is a defect.
- **No contradictions.** Non-negotiables do not silently contradict functional requirements; risks
  do not include unstated requirements in disguise.
- **Users identified.** At least one intended user type is named.
- **Goal is clear and bounded.** The goal statement could serve as a one-sentence brief to a new
  developer without ambiguity.

Grounded defect examples for this mode:

> "REQ-003 has no REQ-ID — violates the anchor requirement (spec §11)"
> "Success Criteria section is empty — spec §14.1 requires ≥1 success measure"
> "Non-Negotiables §4 forbids third-party auth; Functional Requirements REQ-007 requires OAuth —
> direct contradiction"
> "Core goal statement ('build a SaaS thing') is not bounded — vague mega-spec defect (spec §5)"

---

## `scope` — IMPLEMENTED (Slice 2)

**What to check for a scope artifact (`docs/02-scope.md`):**

- **Every MVP item passes both pruning questions.** For each item listed under MVP Scope, verify
  it can answer YES to: *"Is this required for the first usable version?"* and *"Would the project
  fail to solve the core problem without it?"* An MVP item that fails both questions — i.e., the
  project would still be usable and solve the core problem without it — is a grounded defect. It
  belongs in V1 Scope or Future Scope, not MVP.
- **Nothing listed in requirements is silently absent.** Every functional REQ-ID from
  `docs/01-requirements.md` must appear in one of: MVP Scope, V1 Scope, Future Scope, or
  Out of Scope — or carry an explicit deferral with a reason. A REQ-ID present in requirements
  but absent from the scope artifact with no explanation is a grounded defect.
- **Scope decisions carry REQ-ID anchors.** Each scope placement (MVP / V1 / Future / Out of
  Scope) must reference the REQ-IDs it covers. A scope section that groups requirements without
  anchoring them to REQ-IDs cannot be coherence-verified downstream (spec §11); the missing
  anchors are a grounded defect.
- **Future Scope is distinguishable from MVP.** No item should appear in both the MVP Scope and
  Future Scope sections. A duplicated item is a grounded defect — it creates contradictory
  signals for every downstream stage.
- **Out of Scope does not contradict any functional requirement.** A capability placed Out of
  Scope that is explicitly required by a REQ-ID in `docs/01-requirements.md` is a direct
  contradiction — a grounded defect. Out of Scope is for capabilities never required; it is not
  a place to quietly drop required features.
- **Scope Risks trace to specific requirements.** Each entry in the Scope Risks section must
  name the specific REQ-ID(s) at risk and the mechanism of risk (e.g., "REQ-007 relies on a
  third-party API that is rate-limited — burst traffic may block this MVP capability"). A scope
  risk with no REQ-ID anchor is an ungrounded concern — a defect.
- **User-Confirmed Decisions section present.** The artifact must contain a User-Confirmed
  Decisions section recording which scope choices received explicit human sign-off (spec §8).
  An absent User-Confirmed Decisions section is a grounded defect when the scope includes items
  that required a human call (e.g., items removed from MVP at the human's direction).

Grounded defect examples for this mode:

> "MVP Scope item 'Advanced analytics dashboard' — REQ-011 does not require analytics for the
>  first usable version, and the core problem (task tracking) is fully solved without it. Fails
>  both pruning questions — does not belong in MVP."
> "REQ-009 (email notification on task completion) appears in `01-requirements.md` but has no
>  entry in MVP Scope, V1 Scope, Future Scope, or Out of Scope — silently absent from scope
>  artifact; downstream stages cannot trace it"
> "MVP Scope section lists five capabilities with no REQ-ID anchors — spec §11 requires anchors
>  for mechanical traceability; cannot verify coherence against requirements"
> "Item 'bulk import via CSV' appears in both MVP Scope §2 and Future Scope §4 — duplicate
>  placement creates contradictory signals for slice planning"
> "'Third-party SSO login' is placed Out of Scope but REQ-006 explicitly requires OAuth login —
>  Out of Scope contradicts a functional requirement"

---

## `domain-model` — IMPLEMENTED (Slice 3)

**What to check for a domain-model artifact (`docs/03-domain-model.md`):**

- **Entity coverage.** Every significant noun in the requirements and scope is either represented
  as an entity (or attribute of one) or is explicitly excluded with a reason. A noun present in
  ≥1 REQ-ID that has no entity and no exclusion rationale is a grounded defect.
- **Relationship consistency.** Each stated relationship is directionally consistent: if Entity A
  "has many" Entity B, there must be a corresponding ownership or reference on the Entity B side
  unless the unidirectional nature is explicitly justified.
- **No entity contradicts scope.** An entity that represents out-of-scope functionality (as defined
  in `docs/02-scope.md`) is a grounded defect unless flagged as a future-scope placeholder.
- **State models complete.** Any entity whose lifecycle is mentioned in the requirements (created,
  activated, cancelled, expired, etc.) must have a state model; missing transitions are defects.
- **Domain rules are grounded.** Each domain rule must trace to ≥1 REQ-ID or a scope constraint.
  A rule with no upstream anchor is either ungrounded or an implicit hidden requirement (defect
  either way — surface it).
- **Glossary consistent.** Terms in the Glossary must match terms used in the entity and
  relationship sections; divergent naming is a defect.
- **REQ-ID anchors present.** Entities and rules must reference the REQ-IDs that motivate them
  (spec §11); anchors missing on core entities are a defect.

Grounded defect examples for this mode:

> "Entity 'Payment' appears in REQ-007 but has no entry in Core Entities and no exclusion rationale"
> "Relationship 'Order has many Items' has no inverse on Item — directionality unexplained"
> "Entity 'ReportingDashboard' is in Out of Scope (02-scope.md §4) but modelled as a core entity"
> "Order state model omits 'Cancelled' transition mentioned in REQ-003"
> "Domain Rule DR-02 has no REQ-ID anchor — spec §11 requires anchors on all rules"

---

## `architecture` — IMPLEMENTED (Slice 3)

**What to check for an architecture artifact (`docs/04-architecture.md`):**

**Grounded coherence only** (spec §14.4). You are checking that the architecture is consistent
with the upstream artifacts — requirements, scope, domain model — and internally self-consistent.
You are NOT evaluating whether the chosen technology or style is the best option; do not raise
technology-preference opinions as defects.

- **Every REQ-ID supported.** Each functional REQ-ID from `docs/01-requirements.md` must be
  traceable to ≥1 component or flow in the architecture. A REQ-ID with no architectural home is a
  grounded defect.
- **Fits scope.** No component exists solely to serve out-of-scope functionality (as defined in
  `docs/02-scope.md`) unless it is explicitly flagged as a future-scope placeholder.
- **Reflects the domain model.** Every core entity from `docs/03-domain-model.md` must be handled
  by at least one component (stored, processed, or routed). An entity that appears in no
  component's responsibilities is a grounded defect.
- **All domain entities covered.** Check the Core Entities list in the domain model against the
  Responsibilities section of the architecture; gaps are defects.
- **Clean responsibilities.** Each component's responsibility set is coherent (not a grab-bag);
  a component whose stated responsibilities span unrelated concerns without a justification is a
  defect.
- **Clean boundaries.** Boundaries between components and external systems are explicit; a flow
  that crosses an unstated boundary is a defect.
- **Architecture Risks present.** The artifact must contain an Architecture Risks section; an
  absent or empty risks section (when the architecture has evident tradeoffs) is a defect.
- **Security and Failure-Modes sections present.** For Tier 1/2, these sections must be present
  (folded); their absence is a defect. For Tier 3, their graduation to standalone stages
  (`08a-security-threat-model.md`, `08b-failure-edge-cases.md`) is expected — a note to that
  effect satisfies this check.
- **Verification Notes present.** The artifact must record which REQ-IDs the Critic verified and
  any open questions escalated to the human gate.

Grounded defect examples for this mode:

> "REQ-005 (export to CSV) has no component or flow responsible for it"
> "Entity 'Subscription' (domain model §2) appears in no component's responsibilities"
> "Component 'DataStore' has responsibilities spanning caching, auth session storage, and analytics
>  — three unrelated concerns with no justification"
> "Flow from API Gateway to Worker crosses an unstated external boundary"
> "Security section is absent — required for Tier 2 (spec §14.4)"
> "Architecture Risks section is empty despite an async queue dependency that introduces
>  ordering/delivery uncertainty"
