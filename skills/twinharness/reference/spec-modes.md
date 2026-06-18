# TwinHarness Spec Modes — Reference (part of the TwinHarness spec agent playbook)

Per-mode section lists, completion criteria, and behavioral rules for the Spec agent. Find your
mode below; every `th` command, §-citation, and behavioral rule here is canonical.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## `requirements` → `docs/01-requirements.md` (T1, T2, T3) — IMPLEMENTED

Turn a vague idea into clear intent (§14.1): core goal, users, problem, must-have behavior,
constraints, non-negotiables, risks, success criteria. Assign **REQ-IDs** (REQ-001 …) here — the
anchors used everywhere downstream. Ask only what matters; offer examples for non-technical users.
**A vague mega-request must NOT yield a thin spec** — narrow via targeted questions until the core
goal and ≥1 success measure are concrete.

Completion: core goal clear; users identified; constraints captured or explicitly "none"; ≥1 success
measure; shared understanding. **Human gate: yes (sticky).**

Sections: Goal · Intended Users · Problem Statement · Functional Requirements (REQ-IDs) ·
Non-Functional Requirements · Constraints · Non-Negotiables · Risks · Success Criteria · Assumptions
· Open Questions.

---

## `scope` → `docs/02-scope.md` (T1, T2, T3) — IMPLEMENTED

Decide what is built now vs. later (§14.2). Read the approved `01-requirements.md` Summary first.
Recap the goal in 1–2 sentences; propose a concrete MVP (the smallest useful feature set, not the
whole requirements list); ask the user to confirm/remove/add before writing. Filter with the two
pruning questions — *"Required for the first usable version?"* and *"Would the project still solve
the core problem without this?"* — anything failing either goes to V1/Future, not MVP. Write with
`templates/02-scope.md`, referencing REQ-IDs (§11, §17).

Completion: MVP defined and bounded; in/out of scope clear; future features separated; user agrees.
**Human gate: yes (sticky — §8).** Scope is intent; only a human moves it once signed off (§10).

Sections (§14.2): Requirements Summary · MVP Scope · V1 Scope · Future Scope · Out of Scope ·
Non-Goals · Scope Risks · User-Confirmed Decisions.

---

## `domain-model` → `docs/03-domain-model.md` (T2, T3) — IMPLEMENTED

Define the system's concepts and relationships (§14.3). Read the approved `01-requirements.md` and
`02-scope.md` **Summary blocks** first (full artifacts only if a detail is genuinely needed — §9).
Propose a concrete initial model (don't open with a blank form), then let the user confirm/correct/
expand, leaning on sensible defaults. Write with `templates/03-domain-model.md`, anchoring every
entity and rule to REQ-IDs (§11, §17).

Identify: **entities** (nouns the system manages), **relationships** (with cardinalities),
**attributes**, **state models** (lifecycle states + transitions), **domain rules** (invariants),
**domain events**, and **vocabulary** (canonical terms used downstream). Match framing to audience
(plain for non-technical, entities/state-machines/invariants for technical).

Completion: core entities identified; relationships understandable; key states and rules captured;
user can say "yes, this is the world of my project." **Human gate: none — streams (§8, §14.3).**
The Critic checks coherence; the user may interrupt but need not approve.

Sections (§14.3): Domain Summary · Core Entities · Relationships · Attributes · State Models ·
Domain Rules · Domain Events · Glossary · Open Domain Questions.

---

## `architecture` → `docs/04-architecture.md` (T1 light, T2, T3) — IMPLEMENTED

Define high-level structure (§14.4). Read the approved Summary blocks of `01-requirements.md`,
`02-scope.md`, `03-domain-model.md` (full artifacts only if needed — §9).

**Covers:** major components and responsibilities; data flow; runtime flow (request/event end-to-
end); system boundaries and external interfaces; external dependencies; deployment shape. Carries a
folded **Security** and **Failure-Modes** section by default (these graduate to their own stages in
Tier 3 / blast-radius projects — §15.S, §15.F; fold them here for T1/T2).

**Does NOT cover:** detailed internal logic, algorithms, state machines, per-component data models
(those are Stage 6). Don't over-specify tech choices unless they are hard constraints; otherwise
recommend a sane default and move on.

**Streaming vs. human gate (§8, §14.4):** the bulk **streams** (components, responsibilities, data/
runtime flow, deployment, folded Security/Failure-Modes). Surface **only the 1–2 genuinely
irreversible style decisions** (sync vs. async backbone, monolith vs. service split, data-store
category) via **AskUserQuestion** — the "wrong choice now = painful migration later" calls. Don't
gate on cheaply reversible decisions. Anchor every component to its REQ-IDs (§11, §17). Write with
`templates/04-architecture.md`.

Completion: components, responsibilities, interactions defined and aligned with requirements/scope/
domain; folded Security and Failure-Modes present; Critic passes. **Human gate: only the 1–2
irreversible style decisions (§8, §14.4).**

Sections (§14.4): Architecture Summary · Inputs Used · Major Components · Responsibilities ·
System Boundaries · Data Flow · Runtime Flow · External Dependencies · Deployment Shape · Security
(folded) · Failure Modes (folded) · Architecture Risks · Verification Notes.

---

## `adr` → `docs/05-adrs/ADR-NNN-*.md` (T3) — IMPLEMENTED

Capture each significant, hard-to-reverse technical decision with its reasoning so it isn't silently
relitigated (§15.5). Read the approved Summary blocks of `04-architecture.md` and its human-gated
style choices (full artifacts only when needed — §9). One file per ADR via `templates/05-adr.md`.

Scan the architecture (components, data/runtime flow, deployment, recorded style choices) for
candidates — ask "significant AND costly to reverse?" Candidates: data-store category, sync vs.
async backbone, monolith vs. service boundary, auth protocol, schema-evolution strategy,
client/server rendering. **Skip trivially reversible choices** (library version, naming, log
format); when in doubt apply the §2 axis. Each ADR states **Context** (forces/constraints),
**Decision** (what + why), **Consequences** including negatives (benefits-only is dishonest), and
genuinely-considered **Alternatives** (≥1 real option with a real rejection reason), and links REQ-
IDs/components. Status: `Proposed` / `Accepted` / `Superseded` (link successor). Name files
`ADR-001-<slug>.md` … in `docs/05-adrs/`.

**Streaming vs. human gate (§8, §15.5):** streams; only **genuinely irreversible** decisions reach
the human via **AskUserQuestion** before status advances to `Accepted`.

Completion: every significant irreversible decision has an ADR; each links what it serves; none
contradicts requirements/scope; all irreversible decisions human-gated. **Human gate: only genuinely
irreversible decisions (§8).**

Sections per ADR (§15.5): Title/ID · Status · Context · Decision · Consequences (incl. negative) ·
Alternatives Considered · Linked REQs/Components.

---

## `technical-design` → `docs/06-technical-design.md` (T3) — IMPLEMENTED

Specify the internal behavior the architecture left abstract — workflows, algorithms, state
machines, error handling, concurrency, retries, idempotency — to the depth a Builder needs without
inventing (§15.6). Read the approved Summary blocks of `04-architecture.md`, `03-domain-model.md`,
`05-adrs/` first (full artifacts only when a component's detail is needed — §9).

For each architecture component ask "would a Builder have to guess?" If yes, design it; if trivial
(thin wrapper, pass-through, stateless no-branch transform), **deliberately skip it**. For non-
trivial components specify: **workflows/algorithms** (numbered steps or pseudocode when prose is
ambiguous; stop where code is clearer); **state machines** (states, transitions, guards, terminals);
**error handling** (per failure path: behavior, retry policy, fail-open vs. fail-closed + rationale);
**concurrency/ordering/idempotency** (ordering guarantee, idempotency key + duplicate-detection
window). State component **invariants** at stable state boundaries. Record product-meaningful
behavior choices (conflict: LWW vs. merge; rate-limit hit: queue/drop/429) as **Open Design
Questions** surfaced via **AskUserQuestion** — don't silently pick a default on those.

**Streaming vs. human gate (§8, §15.6):** streams; ask the human only on product-meaningful behavior
choices (different choice changes user experience or preserved data). Implementation details (retry
count, backoff base) stream without a gate. Write with `templates/06-technical-design.md`.

Completion: every non-obvious component designed; state machines and error/concurrency handling
specified; invariants stated; nothing a Builder would guess; trivial components skipped. **Human
gate: only product-meaningful behavior choices.**

Sections (§15.6): Component Designs · Key Algorithms/Workflows · State Machines · Error Handling ·
Concurrency/Ordering/Idempotency · Invariants · Open Design Questions.

---

## `contracts` → `docs/07-contracts.md` (T2, T3) — IMPLEMENTED

Pin the precise interfaces between parts — APIs, module boundaries, data schemas, events, request/
response formats — so independently built slices integrate without surprise. Contracts are the
testable boundary (§11, §15.7). Read the approved Summary blocks of `04-architecture.md` and
`03-domain-model.md` first (full artifacts only when a field/component detail is needed — §9).

Build the **Interface Index** first (one line per interface: name, producer, consumer(s), REQ-IDs).
Draft each contract: inputs (names, types, constraints, required/optional), outputs, and the
complete error/edge-case enumeration — deriving field names/types from the domain vocabulary, not
new terms. Every schema field carries a type and ≥1 constraint (format/range/length/enum/
nullability). For each **event**: name, producer, typed payload, ordering and at-least-once/exactly-
once semantics. For each **error contract**: named codes/exceptions, trigger, consumer action
(retry/surface/fail-open/fail-closed). State the **versioning** strategy and compatibility promise.
Build the **Consumer/Producer Map** (interface → producer → consumer(s) → dependent slices) — what
lets the slice plan sequence safely.

**Streaming vs. human gate (§8, §15.7):** the bulk **streams**. Surface product-affecting choices via
**AskUserQuestion** (pagination model, API versioning strategy). **Auth scheme is blast-radius — any
auth decision requires a human gate (§8).** Write with `templates/07-contracts.md`.

Completion: every cross-component interface defined; schemas typed and constrained; error cases
enumerated; each contract anchored to REQ-IDs and dependent slices; consumers/producers identified.
**Human gate: only product-affecting choices and any auth decisions.**

Sections (§15.7): Interface Index · API/Module Contracts · Data Schemas · Events · Error Contracts ·
Versioning · Consumer/Producer Map.

---

## `test-strategy` → `docs/08-test-strategy.md` (T2, T3) — IMPLEMENTED

Define how correctness is proven, mapped to REQ-IDs and slices, so each slice has acceptance
criteria before it is built — the mechanism that makes "tests are the contract" real (§11, §15.8).
Read the approved Summary blocks of `01-requirements.md`, `07-contracts.md`, and (if present)
`08b-failure-edge-cases.md` first (full artifacts only when needed — §9).

State the **Test Philosophy** (3–5 sentences: what the suite proves, automated vs. human split, tie
to REQ-IDs as mechanical enforcement). **Choose and justify test levels** (unit, integration,
contract, end-to-end, plus performance/security where demanded): what each tests, doesn't test,
which tool runs it, why it is included; justify omissions. Build the **REQ→Test Map** — every MVP
REQ-ID maps to ≥1 named test (level, what it asserts/doesn't); non-functional REQs map to a
performance/security test. Define **per-slice acceptance tests** that prove end-to-end user-
demonstrable behavior (not layer-local), anchored to REQ-IDs. Specify **non-functional tests**
(performance SLOs, security/fuzz anchored to `08a-security-threat-model.md`, reliability/chaos).
Specify **tooling** concretely (framework, runner, coverage tool, CI gate). State the **Definition
of Done** mechanically and tie the project-level DoD to `th coverage check` as the authoritative gate.

**Streaming vs. human gate (§8, §15.8):** streams throughout; ask the human only on real quality-bar
tradeoffs (coverage target, performance SLO values, strongly-held test-level choices). Write with
`templates/08-test-strategy.md`.

Completion: every MVP REQ-ID maps to ≥1 test; each slice has end-to-end acceptance tests; test
levels chosen with rationale; tooling specified; Definition of Done is mechanical and ties to
`th coverage check`. **Human gate: none by default — streams; ask only on real quality-bar tradeoffs.**

Sections (§15.8): Test Philosophy · Test Levels & Rationale · REQ→Test Map · Per-Slice Acceptance
Tests · Non-Functional Tests · Tooling · Definition of Done.

---

## `security` → `docs/08a-security-threat-model.md` (T3 / any blast-radius project) — IMPLEMENTED

For projects handling auth, money, sensitive data, or migrations: model assets, trust boundaries,
threats, abuse cases, and mitigations **grounded in this system's actual architecture** (§15.S).
Read the approved Summary blocks of `04-architecture.md`, `07-contracts.md`, `03-domain-model.md`
first (full artifacts when a boundary/flow needs detail — §9).

**Anti-boilerplate rule (hard):** every threat, mitigation, and abuse case MUST name a specific
component, boundary, or data flow from the architecture. Generic items ("validate all inputs", "use
HTTPS", "protect against SQL injection") with no anchor are **discarded** — if you can't name the
component/flow, don't write the threat.

Identify **assets** (valuable data/capabilities, each anchored to its owning entity/component). Map
**trust boundaries** (name each, the principals that cross, what crossing grants). Map **data flows**
for sensitive items (credentials, PII, payment data, tokens) through named components. **Enumerate
threats per boundary** using STRIDE as a prompt but writing only real threats (name, boundary,
affected component(s), vector, impact). Define the **authn/authz model** (who authenticates, RBAC/
ABAC/ownership/scope, where tokens are validated/stored, session lifetime/revocation) — **blast-
radius: human gate via AskUserQuestion (§8) before finalizing.** List **abuse cases** anchored to a
contract endpoint/component. Map **mitigations** to component + REQ (a mitigation with no owning
component is not actionable). State **residual risks** with explicit accept-rationale.

**Streaming vs. human gate (§8, §15.S):** streams; the authn/authz model and any auth decision are
blast-radius — human gate via AskUserQuestion before finalizing. Write with
`templates/08a-security-threat-model.md`.

Completion: assets and boundaries mapped; each boundary's threats grounded to real components;
authn/authz defined and human-approved; mitigations mapped to components and REQs; abuse cases
present; residual risks stated. **Human gate: security model and all auth decisions (blast-radius — §8).**

Sections (§15.S): Assets · Trust Boundaries · Data Flows · Threats (grounded) · Authn/Authz · Abuse
Cases · Mitigations (→ components/REQs) · Residual Risks.

---

## `failure-modes` → `docs/08b-failure-edge-cases.md` (T3 / reliability-critical) — IMPLEMENTED

For reliability-critical systems, specify behavior under invalid input, duplicate operations,
partial failure, dependency outage, crash/restart, race conditions, and unexpected states (§15.F).
Read the approved Summary blocks of `04-architecture.md`, `06-technical-design.md`, `07-contracts.md`
first (full artifacts when a component's behavior needs detail — §9).

**Anti-boilerplate rule (hard):** each failure mode MUST name a specific component or data flow.
Generic entries ("handle errors gracefully", "retry on failure", "validate inputs") are **discarded**.

Build the **Failure Catalog** per component/boundary (component/flow, scenario, trigger, expected
behavior [fail-closed/fail-open/retry/compensate/escalate], anchor to a negative test). **Invalid
Input:** per interface, the exact error-contract response (maps to `07-contracts.md`) — write
"component X's `/endpoint` returns 422 with `{error:'INVALID_FIELD',...}`", not "validate inputs".
**Duplicates/Idempotency:** detection (key, dedup window, unique constraint), duplicate behavior,
key schema. **Partial Failure:** per multi-step/distributed op, compensation (rollback/saga/dead-
letter), observable state, retry/resume. **Dependency Outage:** per external dependency, behavior
when unavailable (circuit breaker, cache fallback, fail, queue), detection, recovery. **Crash/
Restart Recovery:** per stateful component, durable vs. lost state, recovery procedure, post-recovery
invariant. **Race Conditions:** enumerate specific races, resolution (optimistic/pessimistic lock,
CAS, idempotency key, LWW + version); mark benign races explicitly. **Unexpected States:** per state
machine, behavior on a disallowed transition/corrupt state (detect + recover). **Negative-Tests
Map:** each failure mode → its proving negative test, or mark "tested manually only" with rationale.

**Streaming vs. human gate (§8, §15.F):** streams; escalate via **AskUserQuestion** only on product-/
risk-meaningful choices (data-loss tradeoffs, compensation scope, user-visible race resolution) —
blast-radius. Write with `templates/08b-failure-edge-cases.md`.

Completion: each relevant component/boundary has failure modes and defined behavior; idempotency/
retry/compensation specified where needed; negative tests exist for every failure mode; unexpected-
state handling defined; no generic boilerplate. **Human gate: only product-/risk-meaningful failure-
handling choices (blast-radius — §8).**

Sections (§15.F): Failure Catalog (per component/flow) · Invalid Input · Duplicates/Idempotency ·
Partial Failure · Dependency Outage · Crash/Restart Recovery · Race Conditions · Unexpected States ·
Negative-Tests Map.
