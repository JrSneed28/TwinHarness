# TwinHarness Critic Modes — Design & Analysis (part of the TwinHarness orchestrator playbook)

This file contains the grounded-defect checklists for Critic modes in the design and analysis stages:
`contracts`, `test-strategy`, `adr`, `technical-design`, `security`, `failure-modes`, `documentation`,
`ui-design`, `research`, and `debug-review`.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## `contracts` — IMPLEMENTED (Slice 7)

**What to check for a contracts artifact (`docs/07-contracts.md`):**

- **Every contract serves a REQ-ID.** Each defined interface (API endpoint, module boundary, data
  schema, event, request/response format) must be anchored to ≥1 REQ-ID from
  `docs/01-requirements.md`. A contract with no REQ-ID anchor is either speculative scope or a
  hidden requirement — a grounded defect either way.
- **Error and edge cases covered.** For each contract, every non-happy-path interaction named in
  the requirements or domain model must appear as an enumerated error case. A contract that
  defines only success responses while the requirements mention failure scenarios (e.g., "user not
  found," "payment declined," "conflict on concurrent edit") is a grounded defect.
- **No field missing vs. the domain model.** Cross-reference each data schema in the contracts
  against the corresponding entity in `docs/03-domain-model.md`. Every attribute that the domain
  model marks as required or invariant must appear in the schema. A field present in the domain
  model entity but absent from the contract schema (with no exclusion rationale) is a grounded
  defect.
- **No two contracts conflict.** If two contracts describe the same interface — or if one
  contract's output type is consumed as another contract's input type — the types must be
  compatible. A schema mismatch between a producer and a consumer contract is a grounded defect
  even if each contract is individually coherent.
- **Consumer/producer map complete.** Each contract must identify its consumers and producers. A
  contract with no stated consumer is either dead interface or an anchor-free spec addition —
  flag it.
- **Versioning expectations stated.** For any interface consumed by an external system or by
  multiple slices, a versioning expectation must be present. Absence is a defect when the
  architecture implies external consumers.

Grounded defect examples for this mode:

> "Contract `POST /payments` has no REQ-ID anchor — it does not appear in the Consumer/Producer
>  Map and no requirement references a payment submission endpoint"
> "`UserSchema` in contracts §2 omits `account_status` — the domain model (`03-domain-model.md`
>  §1) defines `account_status` as a required attribute of the `User` entity"
> "Contract `OrderEvent` emits `{ orderId, total }` but `InvoiceService` contract expects
>  `{ order_id, amount }` as input — schema mismatch between producer and consumer"
> "`GET /items` contract documents only the 200 response; REQ-009 specifies that an empty
>  result set returns 404 — error case missing from contract"

---

## `test-strategy` — IMPLEMENTED (Slice 7)

**What to check for a test-strategy artifact (`docs/08-test-strategy.md`):**

- **No REQ-ID without a test.** Every MVP REQ-ID from `docs/01-requirements.md` must map to ≥1
  test in the REQ→Test Map. A REQ-ID present in requirements but absent from the map is a
  grounded defect. Confirm mechanically via:
  ```
  th anchors scan --scan-tests
  ```
- **Tests exercise behavior, not tautologies.** A test entry that describes verifying "the
  function runs without error" or "the module loads" is a tautology — it restates the
  implementation without asserting observable behavior. Each test must assert a concrete,
  externally observable outcome tied to the requirement it anchors (spec §15.8). Tautology tests
  are grounded defects.
- **Failure-mode cases have negative tests.** Every failure scenario named in
  `docs/08b-failure-edge-cases.md` (or in the Failure Modes section of `docs/04-architecture.md`
  for Tier 1/2) must have at least one negative test — a test that asserts the system behaves
  correctly under that failure condition (rejects bad input, returns the defined error, retries,
  fails closed, etc.). A failure mode with no negative test is a grounded defect.
- **Slice acceptance tests are end-to-end, not layer-local.** The Per-Slice Acceptance Tests
  section must define tests that exercise the full path relevant to the slice — from the
  slice's external entry point through to its observable output — not tests scoped to a single
  layer (e.g., a unit test on a single function or a database migration in isolation). A slice
  acceptance test that is scoped to one layer is a grounded defect (spec §15.9).
- **Test levels are chosen with rationale.** The Test Levels & Rationale section must explain why
  each level is used (or not used). An absent rationale is a minor defect; a missing level that
  the architecture clearly implies (e.g., no contract tests when there are cross-service contracts)
  is a grounded defect.
- **Definition of Done is mechanical.** The Definition of Done must state concrete, checkable
  criteria (anchored tests pass, checks exit zero) — not assertions like "the agent believes it
  is correct." A DoD that cannot be verified mechanically is a grounded defect.

Grounded defect examples for this mode:

> "REQ-006 (rate limiting) appears in `01-requirements.md` but is absent from the REQ→Test Map —
>  no test anchored to this requirement"
> "Test entry for REQ-002: 'verify that the login function is called' — tautology; it does not
>  assert the user is authenticated or that a session token is returned (spec §15.8)"
> "Failure mode 'payment gateway timeout' in `08b-failure-edge-cases.md` §3 has no corresponding
>  negative test in the Non-Functional Tests or REQ→Test Map sections"
> "Slice 3 acceptance test is `test_db_schema_migrated` — a single-layer database test, not an
>  end-to-end behavioral test; spec §15.9 requires end-to-end acceptance tests per slice"

---

## `adr` — IMPLEMENTED (Slice 7)

**What to check for ADR artifacts (`docs/05-adrs/`):**

- **Each ADR is grounded in a real, significant decision.** An ADR must capture a decision that
  is both meaningful and costly to reverse — a genuine architectural choice with tradeoffs. An
  ADR documenting a trivial or obvious implementation detail (e.g., "we will use UTF-8 encoding,"
  "we will name variables clearly") is not a significant decision — it is not worth an ADR and
  its presence wastes future readers' attention. Flag trivial ADRs as grounded defects.
- **Consequences are honest, including downsides.** The Consequences section must contain both
  positive outcomes and genuine negative consequences of the decision. An ADR whose Consequences
  section lists only benefits is either incomplete or dishonest — flag it. The downside must be
  substantive and specific to this decision, not a generic disclaimer.
- **Alternatives were genuinely considered.** The Alternatives Considered section must name real
  options that were evaluated and explain why they were rejected. "None considered" or a
  single-alternative section with no rejection reasoning is a grounded defect.
- **No contradiction with architecture or requirements.** Each ADR must be consistent with
  `docs/04-architecture.md` and `docs/01-requirements.md`. An ADR that records a decision already
  contradicted by the architecture (or that contradicts a requirement) is a coherence defect —
  the decision, the architecture, and the requirements must align.
- **Each ADR links to the REQ-IDs and components it serves.** Per spec §15.5, every ADR must
  reference the requirements and architectural components the decision serves. An ADR with no
  such linkage cannot be verified for coherence against upstream artifacts.
- **Status is current.** ADR status (Proposed, Accepted, Superseded, Deprecated) must reflect
  the actual state. An ADR marked Proposed when implementation is already underway based on it,
  or Accepted when it contradicts a later decision, is a grounded defect.

Grounded defect examples for this mode:

> "ADR-003 documents the decision to use 4-space indentation — this is not a significant,
>  hard-to-reverse architectural decision; it does not belong as an ADR"
> "ADR-001 (event-sourcing) Consequences section lists only performance and auditability benefits;
>  it omits eventual-consistency tradeoffs and query complexity — consequences are not honest"
> "ADR-002 (PostgreSQL over MongoDB) Alternatives section states 'MongoDB was considered' with no
>  rejection rationale — alternatives not genuinely evaluated"
> "ADR-001 records a decision to use REST; `04-architecture.md §3` describes a GraphQL API —
>  ADR contradicts the architecture"
> "ADR-004 has no Linked REQs/Components field — cannot verify coherence against upstream
>  artifacts (spec §15.5)"

---

## `technical-design` — IMPLEMENTED (Slice 7)

**What to check for a technical-design artifact (`docs/06-technical-design.md`):**

- **Each design supports its REQ-IDs.** Every component design must reference the REQ-IDs it
  implements. A component with no REQ-ID anchor cannot be coherence-verified; the anchor is the
  mechanical link (spec §11). A design section with no REQ-IDs is a grounded defect.
- **Domain invariants and contracts respected.** The detailed design must not introduce behavior
  that violates a domain invariant from `docs/03-domain-model.md` or that contradicts a contract
  in `docs/07-contracts.md`. A design that, for example, allows a state transition the domain
  model forbids, or returns a type that does not match the contract schema, is a grounded defect.
- **Concurrency and failure handling present where the architecture implies it.** For each
  component that the architecture describes as async, event-driven, distributed, or shared-state,
  the technical design must specify: how concurrent operations are ordered or isolated; how
  partial failures are handled; and whether operations are idempotent. A component whose
  architecture section implies concurrency but whose technical design has no ordering, isolation,
  or failure-handling specification is a grounded defect (spec §15.6).
- **Nothing over-specified.** The technical design must stop where code is clearer than prose
  (spec §15.6). A section that specifies trivial implementation details — e.g., variable names,
  loop structure, exact SQL syntax for a simple query — is over-specified. Flag it, because
  over-specification creates maintenance debt without adding clarity.
- **Nothing under-specified for the Builder.** Conversely, any component with non-obvious
  behavior (state machines, retry logic, conflict resolution, idempotency keys) that has no
  design entry forces the Builder to invent behavior — a grounded defect. The design must cover
  what a Builder would otherwise have to guess.
- **State machines are complete.** Any state machine defined in the technical design must include
  all states and transitions named in the domain model. A state or transition present in the
  domain model but absent from the technical design is a grounded defect.
- **Open Design Questions are tracked.** Unresolved design choices must appear in the Open Design
  Questions section, not be silently omitted. A design section that contains unclear behavior
  without a corresponding open question is a grounded defect.

Grounded defect examples for this mode:

> "Component design for `SyncEngine` has no REQ-ID anchor — cannot verify it serves any
>  requirement (spec §11)"
> "SyncEngine design allows writing to a record in `archived` state; `03-domain-model.md` Domain
>  Rule DR-04 forbids writes to archived records — domain invariant violated"
> "Architecture §4 describes `NotificationWorker` as an async fan-out worker with multiple
>  concurrent deliveries; `06-technical-design.md` has no ordering, deduplication, or at-least-once
>  / at-most-once specification for NotificationWorker — concurrency handling absent"
> "PaymentProcessor design specifies the exact variable name (`retryCount`) and loop structure
>  for retry logic — over-specified implementation detail that belongs in code, not design
>  (spec §15.6)"
> "Order state machine in technical design omits the `Cancelled → Refunded` transition defined
>  in `03-domain-model.md` State Models §2"

---

## `security` — IMPLEMENTED (Slice 7)

**ANTI-BOILERPLATE RULE (spec §15.S):** Every threat must be anchored to a specific component,
trust boundary, or data flow that actually exists in this system. Generic checklist items with no
such anchor are discarded — not flagged as issues, but silently dropped from consideration. A
security artifact that consists primarily of unanchored boilerplate threats is itself a grounded
defect. The primary job of the Critic in this mode is to enforce this rule.

**What to check for a security artifact (`docs/08a-security-threat-model.md`):**

- **Each threat is anchored to a real component, boundary, or flow.** Read the threats against
  `docs/04-architecture.md` (or `docs/06-technical-design.md` for detail). Every threat entry
  must name a specific component, boundary, or data flow from those documents. A threat entry
  that could apply to any system — "SQL injection," "XSS," "man-in-the-middle" with no named
  component — is UNANCHORED BOILERPLATE and must be flagged as a grounded defect.
  A threat entry that says "SQL injection on the `UserQueryService` database boundary (line 4 of
  `04-architecture.md` Data Flow section)" is ANCHORED and passes.
- **No mitigation without a threat.** For each mitigation entry, verify there is a named threat
  it addresses. A mitigation with no upstream threat is either defensive theatre or a fragment
  left from a cut-paste template. Flag it.
- **Auth model consistent with contracts.** The authn/authz model defined in this document must
  be consistent with the auth-related fields and error cases in `docs/07-contracts.md`. An auth
  model that requires a bearer token but contracts that define no `401 Unauthorized` response are
  a coherence defect.
- **High-risk flows covered.** Any flow the architecture marks as touching auth, money, sensitive
  data, or migrations must have at least one anchored threat entry. A high-risk flow with zero
  threat coverage is a grounded defect (spec §15.S, §2 blast-radius veto).
- **Abuse cases have negative tests.** Each abuse case listed must appear as a negative test in
  `docs/08-test-strategy.md`. An abuse case with no negative test is an unverified claim.

**Defect example — REJECTS an unanchored boilerplate threat:**

> "Threat entry 'SQL injection — attackers may inject malicious SQL' names no component, boundary,
>  or data flow from the architecture; it applies generically to any system with a database.
>  This is unanchored boilerplate. It is discarded as a defect (spec §15.S anti-boilerplate rule)."

**Defect example — PASSES an anchored threat:**

> "Threat entry 'SQL injection on `UserQueryService → PostgreSQL` boundary (architecture §3.2
>  Data Flow): untrusted `username` parameter passed directly into a dynamic query' is anchored
>  to a specific component and data flow in this system. It passes the anti-boilerplate check."

Additional grounded defect examples for this mode:

> "Threat 'session hijacking' has no named component or boundary — it is unanchored boilerplate;
>  discard (spec §15.S)"
> "Mitigation 'implement input validation' in §4 has no upstream threat entry it addresses —
>  mitigation without a threat"
> "Auth model (§5) requires JWT bearer tokens; `07-contracts.md` `POST /login` contract defines
>  no `401 Unauthorized` error case — auth model inconsistent with contracts"
> "Architecture §2 flags `PaymentGatewayAdapter` as a blast-radius boundary (money flow); it has
>  zero threat entries in the threat model — high-risk flow uncovered (spec §2)"

---

## `failure-modes` — IMPLEMENTED (Slice 7)

**ANTI-BOILERPLATE RULE (spec §15.F):** Each failure mode must be anchored to a specific
component or flow that actually exists in this system. Generic entries like "handle errors
gracefully," "implement retry logic," or "validate all inputs" with no named component are
UNANCHORED BOILERPLATE and must be flagged as grounded defects. The primary job of the Critic in
this mode is to enforce this rule.

**What to check for a failure-modes artifact (`docs/08b-failure-edge-cases.md`):**

- **Each failure mode is anchored to a specific component or flow.** Every entry in the Failure
  Catalog must name the specific component or flow from `docs/04-architecture.md` or
  `docs/06-technical-design.md` where this failure occurs. An entry that names no component and
  could apply to any system is UNANCHORED BOILERPLATE — flag it as a grounded defect.
- **Defined behavior is consistent with contracts and invariants.** For each failure mode, the
  specified behavior (fail-closed, retry, compensation, error response) must not contradict:
  (a) the error cases in `docs/07-contracts.md` for that component's interface, and (b) the
  domain invariants in `docs/03-domain-model.md`. A failure mode that specifies returning a
  success response on failure, or that violates an invariant to recover, is a grounded defect.
- **No critical flow without failure handling.** Any flow the architecture marks as critical
  (auth, money, data integrity, migrations — the blast-radius set, spec §2) must have explicit
  failure handling in the Failure Catalog. A critical flow with no failure-mode entry is a
  grounded defect.
- **Idempotency specified where needed.** For each component the architecture describes as
  handling retried or at-least-once operations, the failure mode entry must specify the
  idempotency strategy. Absence for such a component is a grounded defect.
- **Negative tests exist.** Each failure mode in the catalog must map to at least one negative
  test in `docs/08-test-strategy.md`. A failure mode with no negative test is an unverified
  claim — grounded defect.
- **Unexpected-state handling defined.** The artifact must address what happens when a component
  receives input it was not designed for (corrupted state, unexpected enum value, schema
  migration residue). Absence of any unexpected-state section is a grounded defect for Tier 3
  projects.

**Defect example — REJECTS an unanchored failure mode:**

> "Failure mode entry 'handle errors gracefully — the system should return appropriate error
>  messages to users' names no component or flow and applies generically to any system. This is
>  unanchored boilerplate. It is a grounded defect (spec §15.F anti-boilerplate rule)."

**Defect example — PASSES an anchored failure mode:**

> "Failure mode entry 'PaymentProcessor: payment gateway timeout (>5 s) on `POST /charge`
>  call — behavior: return `PaymentResult.TIMEOUT`, do not charge, log correlation ID; idempotency:
>  request is safe to retry with same idempotency key' is anchored to a specific component and
>  flow with defined behavior and idempotency strategy. It passes the anti-boilerplate check."

Additional grounded defect examples for this mode:

> "Entry 'implement retry logic for all external calls' names no component or boundary —
>  unanchored boilerplate; grounded defect (spec §15.F)"
> "Failure mode `NotificationWorker: delivery failure` specifies sending a success `200 OK` to
>  the caller after exhausting retries; `07-contracts.md §6` specifies `NotificationService`
>  returns `{ delivered: boolean }` — behavior contradicts the contract"
> "Architecture §3 marks `OrderFulfillmentService` as a blast-radius boundary (inventory +
>  money); it has no entry in the Failure Catalog — critical flow without failure handling
>  (spec §2)"
> "SyncEngine is described as at-least-once in architecture §4; its failure mode entry has no
>  idempotency strategy — required for at-least-once components"

---

## `documentation` — IMPLEMENTED (Stage 10.5)

**Context:** This mode reviews the output of the doc-writer agent (Stage 10.5) — README, user
guide, API reference, or other documentation produced for the BUILT project. Run in **fresh
context** (spec §6.5). You have not seen the doc-writer's reasoning session. That isolation
ensures you check what was actually written, not what was intended.

**ANTI-BOILERPLATE RULE (§doc):** Generic filler prose that could describe any project — "this
tool makes development easier," "designed for performance and reliability," "a modern solution
for your needs" — with no anchor to a specific REQ-ID, contract, or implemented behavior is a
grounded defect. Documentation is DERIVED from reality; every claim must trace to something
that exists in the implementation.

**What to check for a documentation artifact (README, `docs/user/`, API reference, etc.):**

- **Every documented feature/claim anchors to a REQ-ID or a contract.** Each documented
  behavior, endpoint, capability, or feature must reference either a REQ-ID from
  `docs/01-requirements.md` or a contract in `docs/07-contracts.md`. A documented capability
  with no upstream anchor is either speculative scope or a docs-vs-reality drift — a grounded
  defect.
- **No documented behavior that does not exist in the implementation.** Verify documented
  claims against the implementation and tests. A claim like "the system retries up to 5 times"
  is a grounded defect if no such retry logic exists in the code or tests. Docs-vs-reality drift
  is the most critical defect class in this mode.
- **Every public interface in `docs/07-contracts.md` is documented or explicitly excluded.**
  Cross-reference each contract interface against the documentation. A contract endpoint,
  schema, or event that has no documentation entry — and no stated reason for exclusion — is
  a grounded defect.
- **Install/setup steps match the project's actual manifest/config.** Verify documented
  install commands, package names, config file paths, and environment variables against
  `package.json`, `pyproject.toml`, or the relevant manifest. A documented install command that
  does not match the actual manifest is a grounded defect.
- **Code examples are consistent with the contracts.** Every code example, function signature,
  field name, and endpoint path in the documentation must exactly match what is defined in
  `docs/07-contracts.md` and implemented in the codebase. A code example using a field name
  that differs from the contract schema is a grounded defect.
- **Anti-boilerplate: no generic filler prose with no anchor to this system.** A documentation
  section that consists of generic marketing language without a single anchor to a specific
  REQ-ID, contract endpoint, or implemented behavior is a grounded defect (§doc anti-boilerplate
  rule). Every paragraph of documentation must be grounded in this project's reality.

Grounded defect examples for this mode:

> "README section 'Features' states 'unlimited file uploads with intelligent deduplication' —
>  no REQ-ID anchors this claim; it does not appear in `01-requirements.md` or any contract in
>  `07-contracts.md` — undocumented-behavior claim (docs-vs-reality drift)"
> "User guide §3 documents `POST /api/v1/exports` with a `format` field accepting `'pdf'` and
>  `'xlsx'`; `07-contracts.md` defines the `format` field as accepting `'csv'` only — code
>  example contradicts the contract"
> "API reference omits `GET /api/v1/status` (contract §8 in `07-contracts.md`); no exclusion
>  rationale provided — public interface undocumented"
> "README installation step: `npm install my-app -g`; `package.json` name field is `my-tool`
>  and there is no `my-app` package — install command does not match the manifest"
> "README overview paragraph: 'A powerful, flexible, enterprise-ready platform built for scale
>  and reliability' — no REQ-ID, contract, or implementation anchor; this is generic filler
>  prose that could describe any software project (§doc anti-boilerplate rule)"

---

## `ui-design` — IMPLEMENTED (Stage 4b)

**Context:** This mode reviews `docs/04b-ui-design.md` produced by the ui-designer agent
(Stage 4b). Run in **fresh context** (spec §6.5). You have not seen the designer's direction
conversation. That isolation ensures you check the artifact against requirements and domain
reality, not against the designer's intent.

**What to check for a UI design artifact (`docs/04b-ui-design.md`):**

- **Every screen serves ≥1 REQ-ID.** For each screen in the Screen Inventory, verify it
  anchors to at least one REQ-ID from `docs/01-requirements.md`. A screen with no REQ-ID anchor
  is speculative scope — it may represent a feature the project never required. A screen with no
  anchor is a grounded defect.
- **Every MVP REQ-ID with user-facing behavior maps to ≥1 screen or flow.** Cross-reference
  the MVP REQ-IDs from `docs/02-scope.md` that involve user interaction against the Screen
  Inventory and User Flows. A user-facing MVP REQ-ID with no screen coverage is a grounded
  defect — the design cannot support the requirement.
- **Every user flow starts and ends at defined screens.** Each flow in the User Flows section
  must reference specific, named screens for both its entry point and its terminal state. A flow
  that begins or ends at "some screen" or at an unnamed state is a grounded defect — undefined
  boundaries create unresolvable ambiguity for slice builders.
- **Every screen defines its empty, loading, and error states.** A screen that shows only the
  happy-path content state, with no definition of its loading state (what the user sees while
  data is fetched), empty state (what the user sees when the data set is empty), and error state
  (what the user sees when an operation fails) is a grounded defect. A screen with only the
  happy-path state is incomplete by construction.
- **Vocabulary matches the domain-model glossary.** Cross-reference terms used in screen names,
  labels, and flow descriptions against the Glossary in `docs/03-domain-model.md` (if it exists)
  or against the REQ-IDs' vocabulary. A screen calling an "Order" a "Purchase," or an "Account"
  a "Profile," when the domain model uses the former term, is a vocabulary mismatch — a grounded
  defect (it creates naming inconsistency that leaks into the codebase).
- **No screen serves out-of-scope features.** Cross-reference screen anchors against
  `docs/02-scope.md` Out of Scope section. A screen that exists solely to support an explicitly
  out-of-scope capability is a grounded defect — it is speculative scope in the design layer.
- **Accessibility requirements section present.** The artifact must contain an Accessibility
  Requirements section stating the WCAG target level, keyboard navigation plan, and minimum
  color contrast ratios. An absent or empty accessibility section is a grounded defect.
- **Design tokens are concrete values, not vibes.** The Design Tokens section must state
  specific values — hex codes for colors, pixel/rem values for spacing and typography, named
  font families — not descriptors like "warm blue," "comfortable spacing," or "clean sans-serif."
  A token entry with no concrete value is a grounded defect.

Grounded defect examples for this mode:

> "Screen 'Analytics Dashboard' in the Screen Inventory has no REQ-ID anchor — there is no
>  analytics requirement in `01-requirements.md`; this screen is speculative scope"
> "REQ-005 (bulk export) is an MVP user-facing requirement but has no corresponding screen or
>  flow in the Screen Inventory or User Flows sections — coverage gap"
> "User Flow 'Checkout' ends at 'confirmation screen' but no screen named 'confirmation screen'
>  (or equivalent) appears in the Screen Inventory — flow ends at an undefined screen"
> "Order Detail screen shows only the populated order view; no loading state (skeleton or
>  spinner), empty state (order not found), or error state (fetch failed) is defined — screen
>  with only the happy-path state is a grounded defect"
> "Screen label uses 'Purchase' throughout; `03-domain-model.md` Glossary defines the canonical
>  term as 'Order' — vocabulary mismatch that will leak into code naming"
> "Design Tokens section lists 'Primary color: a calming blue' with no hex value — not a
>  concrete design token; a Builder cannot implement 'calming blue'"

---

## `research` — IMPLEMENTED — checks `docs/00-research/<topic>.md`

The Researcher agent is conditional and external-facing; its single biggest failure mode is a
confident, uncited (or fabricated) claim. Review for grounded evidence, not coverage.

**What to check for research artifacts:**

- **Every claim is cited to a real, reachable source** with an access date. A material claim with no
  citation is a grounded defect. A citation to a URL that does not support the claim is worse — flag
  it.
- **No fabricated or unverifiable sources.** A hallucinated citation is the worst failure for this
  agent; treat any source you cannot reconcile with the claim as a defect.
- **Opinion is separated from established fact.** A blog author's preference presented as a settled
  fact is a defect; it must be labelled opinion.
- **Version/recency is noted on version-sensitive claims.** A benchmark or API detail for a since-
  rewritten major version, presented as current, is a grounded defect.
- **Each finding bears on a named REQ-ID.** Research that does not change any design decision is
  scope creep — flag findings with no REQ-ID anchor.
- **Implications are stated, not decisions made.** The artifact may say "X favors approach A on
  REQ-007"; it may not say "we will use A" — that is the design stage's and human's call.

Example grounded defects:

> "Findings §2 asserts 'library X is faster than Y' with no source — uncited performance claim"
> "Sources table lists a URL that 404s / does not mention the benchmarked operation — unverifiable"
> "§3 states the rate limit as 100 req/s citing a 2019 post; the current v3 API docs say 50 — stale,
>  recency not noted"

---

## `debug-review` — IMPLEMENTED — checks the Debugger's Evidence Report + `debug-log.md`

The Debugger must PROVE a root cause, not narrate a plausible story. Review the evidence, not the
prose.

**What to check for debug findings:**

- **Root cause (not symptom) anchored to a `file:line`, captured output, or `th` state fact.** "The
  export looks wrong" is a symptom; "src/export.ts:42 joins rows without a terminating newline" is a
  rooted cause. An unanchored root cause is a grounded defect.
- **Reproduction is a real command**, not a description. A defect that cannot be reproduced is a
  hypothesis — it must be labelled as such, with a discriminating experiment.
- **Hypotheses carry discriminating experiments.** A ranked hypothesis with no experiment that would
  confirm or kill it is hand-waving.
- **The fix maps to the owning slice/REQ and stays in its component boundary** (§16). A proposed fix
  spanning unrelated components is a redesign, not a debug fix — flag it.
- **A requirement contradiction is opened as BLOCKING drift.** If the root cause contradicts a
  requirement, the report must record a `th drift add --layer requirement …` — not silently propose a
  behavior change.

Example grounded defects:

> "Report concludes 'race condition in the cache' with no anchored evidence and no failing repro —
>  unproven root cause"
> "Proposed fix edits `auth/` and `billing/` to fix a CSV export defect — crosses component
>  boundaries; this is a redesign, not the minimal fix"
> "Root cause contradicts REQ-007 (it changes the documented export format) but no requirement-layer
>  drift was opened — silent requirement contradiction"
