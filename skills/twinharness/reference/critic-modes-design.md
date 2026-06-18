# TwinHarness Critic Modes — Design & Analysis (part of the TwinHarness orchestrator playbook)

Grounded-defect checklists for Critic modes in the design/analysis stages:
`contracts`, `test-strategy`, `adr`, `technical-design`, `security`, `failure-modes`, `documentation`,
`ux-design`, `ui-design`, `research`, and `debug-review`.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## `contracts` — IMPLEMENTED (Slice 7)

Check a contracts artifact (`docs/07-contracts.md`):

- **Every contract serves a REQ-ID** from `docs/01-requirements.md`. No anchor → grounded defect.
- **Error/edge cases covered.** Every failure interaction named in requirements/domain model must appear as an enumerated error case; success-only contracts are defects.
- **No field missing vs. the domain model.** Every attribute `docs/03-domain-model.md` marks required/invariant must appear in the schema (absent with no rationale → defect).
- **No two contracts conflict.** Producer/consumer types must be compatible; a schema mismatch is a defect even if each contract is individually coherent.
- **Consumer/producer map complete.** A contract with no stated consumer is dead interface or anchor-free scope — flag it.
- **Versioning expectations stated** for any interface consumed externally or by multiple slices.

> Example: "Contract `POST /payments` has no REQ-ID anchor and no requirement references a payment submission endpoint"
> Example: "Contract `OrderEvent` emits `{ orderId, total }` but `InvoiceService` expects `{ order_id, amount }` — producer/consumer schema mismatch"

---

## `test-strategy` — IMPLEMENTED (Slice 7)

Check a test-strategy artifact (`docs/08-test-strategy.md`):

- **No REQ-ID without a test.** Every MVP REQ-ID maps to ≥1 test in the REQ→Test Map. Confirm mechanically: `th anchors scan --scan-tests`.
- **Tests exercise behavior, not tautologies.** "function runs without error" / "module loads" restates implementation; each test must assert an observable outcome (spec §15.8).
- **Failure-mode cases have negative tests.** Every failure in `docs/08b-failure-edge-cases.md` (or `04-architecture.md` Failure Modes for T1/T2) needs a negative test.
- **Slice acceptance tests are end-to-end, not layer-local** (spec §15.9): from external entry point to observable output.
- **Test levels chosen with rationale.** Missing a level the architecture implies (e.g. no contract tests with cross-service contracts) is a grounded defect.
- **Definition of Done is mechanical** (anchored tests pass, checks exit zero) — not "the agent believes it is correct."

> Example: "REQ-006 (rate limiting) is in `01-requirements.md` but absent from the REQ→Test Map"
> Example: "Slice 3 acceptance test `test_db_schema_migrated` is single-layer, not end-to-end (spec §15.9)"

---

## `adr` — IMPLEMENTED (Slice 7)

Check ADR artifacts (`docs/05-adrs/`):

- **Each ADR captures a real, significant, hard-to-reverse decision.** Trivial detail ADRs (UTF-8, naming) are grounded defects.
- **Consequences are honest, including downsides** — benefits-only Consequences are incomplete/dishonest.
- **Alternatives genuinely considered.** "None considered" or no rejection reasoning → defect.
- **No contradiction with `04-architecture.md` or `01-requirements.md`** — decision, architecture, requirements must align.
- **Links to the REQ-IDs and components it serves** (spec §15.5).
- **Status current** (Proposed/Accepted/Superseded/Deprecated reflects reality).

> Example: "ADR-003 documents 4-space indentation — not a significant, hard-to-reverse decision"
> Example: "ADR-001 records REST; `04-architecture.md §3` describes a GraphQL API — ADR contradicts the architecture"

---

## `technical-design` — IMPLEMENTED (Slice 7)

Check a technical-design artifact (`docs/06-technical-design.md`):

- **Each design references the REQ-IDs it implements** (spec §11). No anchor → defect.
- **Domain invariants and contracts respected** — no behavior that violates a `03-domain-model.md` invariant or a `07-contracts.md` schema.
- **Concurrency and failure handling present** for any component the architecture marks async/event-driven/distributed/shared-state: ordering/isolation, partial-failure handling, idempotency (spec §15.6).
- **Nothing over-specified** — stop where code is clearer than prose; trivial detail (variable names, exact SQL) is over-specification (spec §15.6).
- **Nothing under-specified for the Builder** — non-obvious behavior (state machines, retry, conflict resolution, idempotency keys) must have a design entry.
- **State machines complete** — all states/transitions from the domain model present.
- **Open Design Questions tracked**, not silently omitted.

> Example: "Component `SyncEngine` has no REQ-ID anchor (spec §11)"
> Example: "Architecture §4 describes `NotificationWorker` as async fan-out; design has no ordering/dedup/at-least-once spec — concurrency handling absent (spec §15.6)"

---

## `security` — IMPLEMENTED (Slice 7)

**ANTI-BOILERPLATE RULE (spec §15.S):** Every threat must anchor to a specific component, trust boundary, or data flow that exists in this system. Unanchored generic threats are silently discarded; an artifact that is mostly unanchored boilerplate is itself a grounded defect. Enforcing this rule is the Critic's primary job here.

Check a security artifact (`docs/08a-security-threat-model.md`) against `04-architecture.md` / `06-technical-design.md`:

- **Each threat anchored to a real component/boundary/flow.** "SQL injection" with no named component is UNANCHORED BOILERPLATE → defect; "SQL injection on `UserQueryService → PostgreSQL` boundary (architecture §3.2)" is anchored and passes.
- **No mitigation without a threat** — a mitigation with no upstream threat is defensive theatre.
- **Auth model consistent with contracts** — e.g. bearer-token auth but no `401` in `07-contracts.md` is a coherence defect.
- **High-risk flows covered** — any auth/money/sensitive-data/migration flow needs ≥1 anchored threat (spec §15.S, §2 blast-radius veto).
- **Abuse cases have negative tests** in `docs/08-test-strategy.md`.

> Rejects: "Threat 'SQL injection' names no component/boundary/flow — unanchored boilerplate, discarded (spec §15.S)"
> Passes: "Threat 'SQL injection on `UserQueryService → PostgreSQL` boundary (architecture §3.2): untrusted `username` into a dynamic query' — anchored"
> Example: "`PaymentGatewayAdapter` is a §2 blast-radius boundary (money) with zero threat entries — high-risk flow uncovered"

---

## `failure-modes` — IMPLEMENTED (Slice 7)

**ANTI-BOILERPLATE RULE (spec §15.F):** Each failure mode must anchor to a specific component or flow. Generic entries ("handle errors gracefully," "implement retry logic," "validate all inputs") with no named component are UNANCHORED BOILERPLATE → grounded defects. Enforcing this is the Critic's primary job here.

Check a failure-modes artifact (`docs/08b-failure-edge-cases.md`):

- **Each failure mode anchored** to a component/flow from `04-architecture.md` or `06-technical-design.md`.
- **Defined behavior consistent with contracts and invariants** — must not contradict `07-contracts.md` error cases or `03-domain-model.md` invariants (e.g. returning success on failure → defect).
- **No critical flow without failure handling** — every §2 blast-radius flow (auth/money/data-integrity/migrations) needs an entry.
- **Idempotency specified** for any retried / at-least-once component.
- **Negative tests exist** in `docs/08-test-strategy.md` for each catalog entry.
- **Unexpected-state handling defined** (corrupted state, unexpected enum, migration residue) — absence is a defect for Tier 3.

> Rejects: "Entry 'handle errors gracefully' names no component/flow — unanchored boilerplate (spec §15.F)"
> Passes: "Entry 'PaymentProcessor: gateway timeout (>5 s) on `POST /charge` — return `PaymentResult.TIMEOUT`, do not charge, retry-safe with idempotency key' — anchored with behavior + idempotency"

---

## `documentation` — IMPLEMENTED (Stage 10.5)

Reviews doc-writer output (Stage 10.5) — README, user guide, API reference — in **fresh context** (spec §6.5): check what was written, not what was intended.

**ANTI-BOILERPLATE RULE (§doc):** Generic filler ("makes development easier," "designed for performance," "a modern solution") with no anchor to a REQ-ID, contract, or implemented behavior is a grounded defect. Documentation is DERIVED from reality.

Check a documentation artifact (README, `docs/user/`, API reference):

- **Every documented feature/claim anchors to a REQ-ID or contract** (`01-requirements.md` / `07-contracts.md`).
- **No documented behavior that does not exist** in code/tests — docs-vs-reality drift is the most critical defect class here.
- **Every public interface in `07-contracts.md` documented or explicitly excluded.**
- **Install/setup steps match the actual manifest/config** (`package.json`, `pyproject.toml`, …).
- **Code examples consistent with the contracts** — field names, signatures, endpoint paths must match.
- **No generic filler prose** unanchored to this system (§doc).

> Example: "README 'Features' claims 'intelligent deduplication' — no REQ-ID; absent from `01-requirements.md` and contracts (docs-vs-reality drift)"
> Example: "Install step `npm install my-app -g` but `package.json` name is `my-tool` — install command does not match the manifest"

---

## `ux-design` — IMPLEMENTED (Stage 4a)

Reviews `docs/04a-ux-design.md` (ux-ui-designer, Stage 4a) in **fresh context** (spec §6.5). Stage 4a precedes Stage 4b (UI): it defines users, journeys, IA, and task flows before any visual design.

Check a UX design artifact:

- **Every persona, journey, task flow serves ≥1 REQ-ID** — unanchored ones are speculative scope.
- **Every user-facing MVP REQ-ID (`02-scope.md`) maps to ≥1 journey/flow** — uncovered is a defect.
- **Every task flow starts and ends at a defined state** — undefined boundaries block Stage 4b.
- **Information architecture covers the requirements** — each IA area anchors to a REQ-ID/persona goal; a user-facing requirement with no IA place is a gap.
- **Assumptions surfaced** in UX Research & Assumptions (or as an Open UX Question), not buried.
- **Vocabulary matches the `03-domain-model.md` glossary** — synonyms for domain terms are defects.
- **No journey/flow serves out-of-scope features** (`02-scope.md` Out of Scope).

> Example: "Persona 'Power Analyst' has no REQ-ID anchor — speculative scope"
> Example: "Journey 'Checkout' calls it a 'Purchase'; glossary canonical term is 'Order' — vocabulary mismatch"

---

## `ui-design` — IMPLEMENTED (Stage 4b)

Reviews `docs/04b-ui-design.md` (ux-ui-designer, Stage 4b) in **fresh context** (spec §6.5). Stage 4b realizes the approved UX (`04a-ux-design.md`) as screens, wireframes, and tokens.

Check a UI design artifact:

- **Every screen serves ≥1 REQ-ID** — unanchored screens are speculative scope.
- **Every user-facing MVP REQ-ID maps to ≥1 screen/flow.**
- **Every user flow starts and ends at named screens** — "some screen" is a defect.
- **Every screen defines its empty, loading, and error states** — happy-path-only is incomplete.
- **Vocabulary matches the `03-domain-model.md` glossary.**
- **No screen serves out-of-scope features.**
- **Accessibility Requirements section present** (WCAG target, keyboard nav, min contrast).
- **Design tokens are concrete values, not vibes** — hex/px/rem/font names, not "warm blue."

> Example: "Screen 'Analytics Dashboard' has no REQ-ID anchor and no analytics requirement exists — speculative scope"
> Example: "Order Detail screen defines only the populated view — no loading/empty/error state"
> Example: "Design token 'Primary color: a calming blue' has no hex value — not a concrete token"

---

## `research` — IMPLEMENTED — checks `docs/00-research/<topic>.md`

The Researcher is conditional and external-facing; its biggest failure mode is a confident, uncited (or fabricated) claim. Review for grounded evidence, not coverage.

- **Every claim cited to a real, reachable source** with an access date. A citation that does not support the claim is worse than none.
- **No fabricated or unverifiable sources** — a hallucinated citation is the worst failure here.
- **Opinion separated from established fact.**
- **Version/recency noted** on version-sensitive claims.
- **Each finding bears on a named REQ-ID** — findings with no anchor are scope creep.
- **Implications stated, not decisions made** ("X favors approach A on REQ-007", not "we will use A").

> Example: "Findings §2 asserts 'library X is faster than Y' with no source — uncited performance claim"
> Example: "§3 cites a 2019 post for a rate limit the current v3 docs contradict — stale, recency not noted"

---

## `debug-review` — IMPLEMENTED — checks the Debugger's Evidence Report + `debug-log.md`

The Debugger must PROVE a root cause, not narrate a plausible story. Review the evidence.

- **Root cause (not symptom) anchored to a `file:line`, captured output, or `th` state fact.** Unanchored root cause → defect.
- **Reproduction is a real command**, not a description — an unreproducible defect is a hypothesis, labelled as such with a discriminating experiment.
- **Hypotheses carry discriminating experiments** that would confirm or kill them.
- **The fix maps to the owning slice/REQ and stays in its component boundary** (§16) — a cross-component fix is a redesign.
- **A requirement contradiction is opened as BLOCKING drift** (`th drift add --layer requirement …`), not a silent behavior change.

> Example: "Report concludes 'race condition in the cache' with no anchored evidence and no failing repro — unproven root cause"
> Example: "Root cause changes the documented export format (contradicts REQ-007) but no requirement-layer drift was opened"
