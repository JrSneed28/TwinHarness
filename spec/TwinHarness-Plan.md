# TwinHarness — Outline

A Claude Code / agentic-coding skill that takes a user from *"I want to create X"* through a controlled
software-development lifecycle — requirements, scope, domain model, architecture, design, contracts, tests,
vertical-slice planning, implementation, and verification — producing structured artifacts that **govern**
implementation rather than decorate it.

The system does not jump straight to code, and it does not treat its documents as a frozen plan. Each engaged
stage produces a verifiable artifact; those artifacts form a living control system that implementation both
follows and feeds back into.

---

## 1. Core Idea

Turn a vague software idea into a sequence of verifiable artifacts, then build from them slice-by-slice, while
treating those artifacts as a **living control system** rather than a one-way specification. Discoveries made
while building flow back into the documents so they stay honest instead of going stale.

**Name:** Agentic SDLC Orchestrator.

---

## 2. The Governing Principle

Every non-obvious decision in this system resolves to a single axis:

> **The irreversible, taste-driven, high-blast-radius layer — requirements, scope, and anything touching
> security, money, data integrity, or migrations — gets human gates and strict, sticky treatment.
> Everything else flows, self-maintains, auto-generates, or can be bypassed.**

This one rule generates:

- which stages require a **human approval gate** vs. merely allow a human **interrupt** (§8),
- which spec layers are **sticky** vs. allowed to **drift** from implementation reality (§10),
- when a task can **skip the whole process** vs. when blast radius **vetoes** the skip (§5),
- where to spend scarce human attention, scarce tokens, and scarce verification effort.

If a new judgment call arises during construction that this outline does not explicitly cover, apply this axis
and the system stays internally consistent.

---

## 3. Main Philosophy

The system is spec-driven, stage-gated, adaptive, document-first, and verification-heavy — but explicitly **not
waterfall.** Documents control the parts of the work that are about *intent*. Implementation is allowed to teach
the documents about *reality*.

Core commitments:

- The AI does not start coding before there is enough shared understanding to build the right thing.
- Each engaged stage produces a markdown artifact with a short summary and full detail.
- Artifacts are **verified for coherence** before downstream stages depend on them.
- Process depth **scales to complexity and risk** — including the option of no process at all.
- Implementation discoveries are written **back** into the artifacts (bidirectional), so they stay honest
  instead of silently going stale.
- The human stays in control of the irreversible, taste-driven calls and is free to ignore the rest.

The honest framing of "docs are not decoration":

> Docs are the control system **for intent and consistency.** Code is the control system **for behavior.**
> Tests and the human are the control system **for correctness.**

---

## 4. Source-of-Truth Model

A coherent rule for *which* artifact wins when two disagree — without this, "everything is source of truth"
means nothing is.

- **Requirements and scope are the source of truth for *what* and *why* (intent).** They are sticky. Changing
  them requires a human decision.
- **Code is the source of truth for *how* and the actual *behavior*.** When code and a derived design document
  disagree about behavior, **code wins** and the document is updated to match.
- **The middle layer — domain model, architecture, ADRs, technical design, contracts, test strategy, slice
  plan — is *derived* and semi-disposable.** It exists to orient humans and agents and to enable
  consistency-checking. It evolves as implementation reveals reality.

Consequences:

- The master spec is **for orientation and consistency-checking, never a compiler input.** You never regenerate
  the whole system from it.
- Regeneration from spec is permitted at **single-module or single-slice granularity at most**, never globally.
- When code contradicts a *derived* doc → auto-reconcile (update the doc, log it). When code contradicts a
  *requirement* → escalate to the human (§10). That distinction is the entire drift-escalation rule.

---

## 5. Adaptive Complexity Model & Tier 0 Bypass

The workflow runs at the shallowest depth that is safe. Depth is chosen by the Orchestrator and is always
visible and reversible — the system announces the tier it picked and the human can escalate with a word.

**Tier 0 — Bypass.** Trivial, low-blast-radius work (rename, copy fix, add a log line, tweak a constant). No
documents. The Orchestrator says, in effect, *"this is too small for the full process — I'll just build it,"*
optionally leaving a one-line note. This tier exists because real-world experiments repeatedly show framework
overhead exceeding its benefit on small tasks.

A concrete Tier-0 classifier (so the routing isn't hand-wavy): a task is Tier 0 only if **all** hold — it
touches a single file or a tightly local area; it changes no public interface, schema, or contract; it adds no
new dependency; it has an obvious, testable correct answer; and it carries **none** of the blast-radius flags
below. Any miss promotes it to Tier 1.

> **Blast-radius veto (the guardrail):** apparent size never overrides risk category. If a task touches
> **authentication, authorization, data integrity, money/billing, or migrations**, it **cannot** be Tier 0 no
> matter how small it looks.

**Tier 1 — Simple** (small utilities, scripts, tiny apps):
Requirements (light) → Scope → Light Architecture → Slice Plan (a few slices) → Code → Verify.

**Tier 2 — Medium** (normal apps and tools):
Requirements → Scope → Domain Model → Architecture → Contracts → Test Strategy → Slice Plan → Code → Verify.

**Tier 3 — Complex / Critical** (serious or high-risk systems):
Requirements → Scope → Domain Modeling → Architecture → ADRs → Detailed Technical Design → Contracts →
**Security** → **Failure Modes** → Test Strategy → Slice Plan → Code → Final Verification + traceability view.

**Tiering principle:**

- More **uncertainty** → more clarification (conversation), not more documents.
- More **blast radius** → more verification *and* more human gates.
- More **complexity** → more staged artifacts.
- Blast radius can pull a small project **up** a tier (the veto); it never pushes a risky thing **down**.

Vertical-slice planning (§6.3, §15.9) runs in every engaged tier — lightweight in Tier 1, full in Tier 3 — and
is skipped only at Tier 0.

Note on input quality: vague mega-requests ("build me a SaaS dashboard") are a documented failure mode of
spec-driven tools — they yield a useless high-level spec. The Requirements and Scope stages must therefore
**aggressively narrow** before anything proceeds, and the Orchestrator should refuse to advance from a
too-vague brief, asking targeted questions instead (§7, §14.1).

---

## 6. Agent Architecture

A separate agent is justified **only** by one of: context isolation, tool isolation, or parallelism. A
stage-specific *prompt* alone does **not** justify a separate agent. Applying that rule yields **five real
agents plus prompt modes**.

### 6.1 Orchestrator (the controller)

- Classify project complexity **and blast radius**; pick the tier (including Tier 0 bypass).
- Decide which stages run and in what order.
- Spawn the Vertical Slice, Builder, and Critic agents when needed; run Builders in parallel where slices are
  independent.
- Route the **right prior context** to each stage — summaries by default, full artifacts on demand (§9).
- Enforce coherence gates and the human-approval gates (§8).
- Own the state file and the dependency graph; trigger cascade re-verification (§18).
- Handle drift: auto-apply derived-layer drift, escalate requirement-level drift to the human (§10).
- Start implementation only when the tier's prerequisites and an approved slice plan exist.

### 6.2 Spec Agent (runs as stage *modes*, not separate agents)

One agent, parameterized by mode. Modes map **one-to-one** to the document stages:

`requirements` · `scope` · `domain-model` · `architecture` · `adr` · `technical-design` · `contracts` ·
`test-strategy` · (`security` · `failure-modes` when Tier 3 triggers them).

The Spec Agent shares one toolset across modes and runs sequentially, so there is no isolation or parallelism
benefit to splitting it — hence one agent. In every mode it reads prior **summaries** (fetching full artifacts
only when genuinely needed), produces a **draft first** rather than interrogating from scratch, asks **only the
clarifying questions that matter** (§7), and emits an artifact with a **Summary** block plus full detail.

### 6.3 Vertical Slice Agent

Owns the decomposition of the design into **vertical slices** — thin, end-to-end paths through every layer the
feature needs (interface → logic → data), each delivering one demonstrable, independently testable capability —
rather than horizontal layers (all data, then all logic, then all UI) that leave nothing working until the end.

It is a real agent on **context-isolation** grounds, the same justification as the Critic: both humans and LLMs
default to horizontal-layer decomposition, and an agent that produces the slice plan in a **fresh context**,
uncontaminated by the layer-by-layer thinking of the design stages, produces cleaner slices. Its output is then
checked by the Critic in slice mode (§7), the same producer→critic pattern used everywhere.

What it produces is the Stage 9 artifact (§15.9): an ordered set of slices, a walking-skeleton first slice, and
the per-slice tasks and self-contained task files the Builder consumes.

> Minimalist alternative: if you want to hold the agent count down, the Vertical Slice Agent collapses into a
> Spec-Agent `slice-planning` mode plus a Critic `slice` mode. It is kept distinct here because slicing is the
> hinge between design and build, and slicing it wrong silently breaks incremental delivery.

### 6.4 Builder (tool + parallelism isolation)

Real because it holds tools the others lack (write-to-codebase, run-tests, run-checks) and because multiple
Builders can run in parallel on independent slices. It:

- implements **one slice at a time, one task at a time**, from the slice plan plus each task's self-contained
  file (§9),
- writes tests **with the implementation**, carrying requirement-ID anchors (§11),
- verifies the **whole slice end-to-end** (its acceptance tests pass) before the next slice,
- writes discoveries **back** as drift entries and updates derived docs when behavior diverges (§10),
- does not invent undocumented behavior.

### 6.5 Critic (context isolation is the whole point)

A critic must run in a **fresh context without the author's rationalizations**, or it agrees with itself and
manufactures false confidence. One parameterized Critic serves every stage (requirements-critic,
architecture-critic, slice-critic, code-review-critic, …) under the grounding discipline in §7.

> The original Traceability Agent is gone — its job is now mechanical (§11, §17). Integration Review and Code
> Critic collapse into the single Critic in code-review mode.

---

## 7. Agent + Critic Pattern

```
Producer (Spec / Vertical Slice / Builder) creates artifact
  → Critic (fresh context) reviews for COHERENCE against upstream summaries
  → grounded defects returned (possibly zero)
  → author revises
  → artifact passes (coherence) or escalates to human
  → next stage proceeds
```

Hard rules, several written specifically to avoid documented failures:

- **Critiques must be grounded** in a prior approved artifact or a concrete coherence/correctness defect. A
  valid critique points at something specific: *"does not support REQ-004,"* *"omits the `Payment` entity,"*
  *"Slice 3 is a horizontal data-layer task, not a vertical slice."* Ungrounded stylistic critiques are
  discarded.
- **Zero issues is a valid, celebrated terminal state.** There is **no minimum-issue quota — ever** (forced
  quotas are a documented cause of endless review loops and artificial nitpicking).
- **The revise loop is capped** (default 3 rounds). If the cap is reached with issues still open, the
  Orchestrator **escalates to the human** rather than looping forever.
- **Clarification is conversational and selective.** Because natural-language ambiguity is irreducible, the
  agent asks about what is genuinely unclear and leans on sensible defaults for the rest — it does not
  interrogate the user about every detail.

---

## 8. Human Involvement Model — Interrupt, Don't Approve

Many sequential approval prompts train the user to rubber-stamp, hollowing out every gate. The system asks for
explicit human **approval** only where the axis (§2) demands it, and lets everything else **stream** with the
human able to interrupt at any moment.

**Hard human-approval gates (blocking):**

- Requirements sign-off.
- Scope sign-off.
- One or two genuinely irreversible architecture decisions (surfaced as explicit choices, not buried).
- Any **blocking drift escalation** (a requirement is contradicted — §10).
- Any work touching **security, money, data integrity, or migrations** (the blast-radius set).

**Everything else streams** — domain model, technical design, contracts, test strategy, slice plan, ordinary
tasks, and derived-layer drift — with the human able to pause, inspect, and rewrite, but not required to click
"approve" to proceed.

---

## 9. Context & Token Economics

Injecting every prior document into every stage and task does not survive contact with cost, latency, or
context limits. This is a constraint that shapes the architecture, not a footnote.

- **Summaries are the default handoff currency.** Every artifact opens with a compact Summary block. Stages and
  tasks consume summaries by default and **fetch full artifacts only on demand**.
- **Hierarchical, link-out specs.** A master index (`00-project-summary.md`) links out to sub-documents rather
  than concatenating everything; agents navigate links and pull the relevant leaf.
- **Self-contained task files.** Each implementation task gets a focused file embedding exactly the
  requirements, contracts, and design notes that task needs, so long sessions don't "forget" earlier
  decisions. Slices keep these files small by construction.
- **Code is the leaf-level spec.** Below the design docs, the code carries the most granular, unambiguous
  specification, so docs need not restate what the code already says.

The Orchestrator tracks approximate context cost per stage and prefers summaries; full fetches are deliberate.

---

## 10. Bidirectional Specs & Drift Management

Discovery during build is **the norm, not an exception.** A document nobody updates goes stale, and a stale spec
is worse than none because agents follow it confidently into building the wrong thing. So spec maintenance is
**tiered and bidirectional** — if agents can write code, they can maintain the derived spec.

**Derived-layer drift → auto-write-back, non-blocking.** When a Builder finds reality differs from a *derived*
doc — e.g. *"found an existing `ThemeContext` provider; architecture assumed a new store"* — it wires into
reality, updates the derived doc, and appends a **drift-log entry** the human reviews asynchronously. This never
blocks the build.

**Requirement/scope drift → escalate, blocking.** When a discovery contradicts a requirement or scope decision,
the Builder stops and the Orchestrator escalates to the human (§8). Requirements/scope are sticky; only a human
moves them.

That single distinction — derived vs. intent — is the entire escalation policy, falling straight out of the §2
axis. Because work proceeds slice-by-slice, drift is contained to the slice in flight, which keeps escalations
small and local.

**Drift log** (`drift-log.md`, append-only). Each entry records discovery, affected layer, action taken, and
escalation status:

```
## DRIFT-003  (SLICE-2 / TASK-012, Builder)  — derived layer, auto-applied
Discovery : Existing ThemeContext provider found; architecture §3 assumed a new preference store.
Action    : Wired into ThemeContext; updated 04-architecture.md §3 (v2).
Escalation: none (no requirement contradicted).

## DRIFT-007  (SLICE-5 / TASK-031, Builder)  — requirement layer, BLOCKING
Discovery : Offline-first sync (REQ-004) is infeasible with the chosen 3rd-party API's auth model.
Action    : Build paused on SLICE-5.
Escalation: awaiting human decision on REQ-004.
```

When code changes behavior, the relevant derived doc is updated in the **same change**, so the doc and code move
together.

---

## 11. Consistency vs. Correctness & Mechanical Enforcement

- **Coherence gates (the Critic) check internal consistency** — does this artifact contradict an upstream one?
  The Critic shares the author's blind spots, so it cannot certify the design is *right*, only that it is
  *consistent*. A fully green traceability view can still describe the wrong product.
- **Correctness is checked only by tests-against-reality and by the human.** This is stated plainly so no one
  mistakes a coherent spec for a correct one.

**Instructions are not enforcement.** A doc saying *"the Builder must follow the contracts"* does not make it
so. Enforcement must be **mechanical:**

- **Requirement-ID anchors (REQ-001, …)** thread through the chain: referenced in design sections and
  contracts, embedded in slice definitions and task IDs (`SLICE-2 / TASK-014` cites `REQ-001`), and embedded in
  test names (`test_REQ001_offline_sync`).
- **Tests are the contract.** A task or slice is done when its anchored tests pass and checks are green — not
  when an agent asserts it.
- These anchors are also what make traceability a **rendered view** rather than a maintained document (§17).

---

## 12. Document / Artifact Structure

```
docs/
  00-project-summary.md        # master index + orientation; LINKS OUT to the rest (hierarchy, §9)
  01-requirements.md
  02-scope.md
  03-domain-model.md
  04-architecture.md           # security + failure modes are SECTIONS here by default (§13)
  05-adrs/
    ADR-001-architecture-style.md
    ADR-002-data-storage.md
  06-technical-design.md
  07-contracts.md
  08-test-strategy.md
  09-implementation-plan.md    # vertical slice plan + per-slice tasks (§15.9)
  10-verification-report.md
  # Tier-3 / critical only — these graduate from sections to their own stages+files:
  08a-security-threat-model.md
  08b-failure-edge-cases.md

  drift-log.md                 # append-only record of implementation discoveries (§10)

.agentic-sdlc/
  state.json                   # see §18
```

Conventions: no standalone traceability matrix file (it rots first — §17); every artifact opens with a
**Summary** block; each artifact is **versioned** (v1, v2, …) with a content hash referenced by `state.json`
and the drift log.

---

## 13. Full Stage Pipeline

Each stage maps to one Spec-Agent mode, except Stage 9, which the Vertical Slice Agent owns. Security and
failure-mode work are sections of architecture by default and graduate to their own stages only when the
project is security- or reliability-critical.

| # | Stage | Producer | Runs in | Notes |
|---|-------|----------|---------|-------|
| 1 | Requirements Engineering | Spec | T1, T2, T3 | Light in T1 |
| 2 | Scope Definition | Spec | T1, T2, T3 | |
| 3 | Domain Modeling | Spec | T2, T3 | |
| 4 | System Architecture | Spec | T1, T2, T3 | Security + failure modes are sections here by default |
| 5 | Architecture Decision Records | Spec | T3 | |
| 6 | Detailed Technical Design | Spec | T3 | |
| 7 | Contracts (API / interface / data) | Spec | T2, T3 | |
| 8 | Test Strategy | Spec | T2, T3 | |
| 9 | Implementation Planning & Vertical Slicing | **Vertical Slice Agent** | all engaged tiers | Verified by Critic (slice mode) |
| 10 | Software Implementation | Builder | all engaged tiers | Slice-by-slice, task-by-task |
| 11 | Final Verification | Critic + human | T1 light – T3 full | + traceability view |
| S | Security & Threat Modeling | Spec (`security`) | T3 / any blast-radius project | Graduates to its own stage |
| F | Failure Mode & Edge-Case Design | Spec (`failure-modes`) | T3 / reliability-critical | Graduates to its own stage |

---

## 14. Stage Detail — Stages 1–4

### 14.1 Stage 1 — Requirements Engineering → `01-requirements.md`

**Purpose:** turn a vague idea into clear intent. **Mode:** `requirements`.

Captures core goal, intended users, problem statement, must-have behavior, constraints, non-negotiables, risks,
and definition of success. For non-technical users it offers examples (*"Is this for personal use, a team, or
customers?"*); for technical users it asks directly about functional and non-functional requirements and hard
limits. It asks **only what matters.**

If the brief is a vague mega-request, the agent does **not** produce a thin, useless spec — it narrows through
targeted questions until the core goal and at least one success measure are concrete. Requirement IDs
(REQ-001…) are assigned here and become the anchors used everywhere downstream.

**Completion:** core goal clear; users identified; key constraints captured or explicitly "none"; ≥1 success
measure; shared understanding reached. **Human gate:** yes (sticky).

**Sections:** Goal · Intended Users · Problem Statement · Functional Requirements (REQ-IDs) · Non-Functional
Requirements · Constraints · Non-Negotiables · Risks · Success Criteria · Assumptions · Open Questions.

### 14.2 Stage 2 — Scope Definition → `02-scope.md`

**Purpose:** decide what is built now vs. later. **Mode:** `scope`.

The agent recaps goal and success criteria, **proposes** an MVP, and asks the user to confirm/remove/add,
separating essentials from future features. It asks the useful pruning questions: *"Required for the first
usable version?"*, *"Would the project still solve the core problem without this?"*

**Completion:** MVP defined; in/out of scope clear; future features separated; user agrees on the first
version. **Human gate:** yes (sticky).

**Sections:** Requirements Summary · MVP Scope · V1 Scope · Future Scope · Out of Scope · Non-Goals · Scope
Risks · User-Confirmed Decisions.

### 14.3 Stage 3 — Domain Modeling → `03-domain-model.md`

**Purpose:** define the system's important concepts and how they relate. **Mode:** `domain-model`.

Reads requirements + scope, **proposes an initial model first**, explains it in plain language, then lets the
user confirm/correct/expand. Identifies entities, relationships, attributes, states, rules, events, vocabulary.
Plain framing for non-technical users; entities/state-machines/invariants for technical ones.

**Completion:** core entities identified; relationships understandable; key states and rules captured; the user
can say *"yes, this is the world of my project."* **Human gate:** no — streams.

**Sections:** Domain Summary · Core Entities · Relationships · Attributes · State Models · Domain Rules · Domain
Events · Glossary · Open Domain Questions.

### 14.4 Stage 4 — System Architecture → `04-architecture.md`

**Purpose:** define the system's high-level structure. **Mode:** `architecture`.

Defines major components and responsibilities, data and runtime flow, boundaries, external systems,
communication paths, and deployment shape. By default it also carries a **Security** section and a
**Failure-Modes** section (these graduate to their own stages in Tier 3 / blast-radius projects). It is **not**
about detailed tech picks unless those are hard constraints; if the user has no preference, the agent
recommends a sane default.

**Verification (Critic, architecture mode):** grounded coherence only — supports every REQ-ID; fits scope;
reflects the domain model; covers all entities; clean responsibilities and boundaries; risks noted.

**Completion:** components, responsibilities, and interactions defined and aligned with requirements/scope/
domain model; critic passes. **Human gate:** only the one or two irreversible style decisions; the rest
streams.

**Sections:** Architecture Summary · Inputs Used · Major Components · Responsibilities · System Boundaries ·
Data Flow · Runtime Flow · External Dependencies · Deployment Shape · Security (folded) · Failure Modes
(folded) · Architecture Risks · Verification Notes.

---

## 15. Stage Detail — Stages 5–9, S, F

### 15.5 Stage 5 — Architecture Decision Records → `docs/05-adrs/`

**Purpose:** capture each significant, hard-to-reverse technical decision with its reasoning, so future agents
and humans don't silently relitigate or contradict it. **Mode:** `adr`. **Tier:** T3.

The agent scans the architecture and the human-gated style choices for decisions that are both significant and
costly to reverse, and drafts one ADR each. It links every ADR to the REQ-IDs and components it serves.
Non-technical users get each decision explained as a plain tradeoff. Streams; only genuinely irreversible
decisions reach the human (§8).

**Completion:** every significant irreversible decision has an ADR; each links to what it serves; none
contradicts requirements/scope.

**Critic (adr mode):** each ADR grounded in a real decision (not trivia); consequences honest including
downsides; alternatives genuinely considered; no contradiction with architecture or requirements.

**Sections (per ADR):** Title/ID · Status · Context · Decision · Consequences (incl. negative) · Alternatives
Considered · Linked REQs/Components.

### 15.6 Stage 6 — Detailed Technical Design → `06-technical-design.md`

**Purpose:** specify the internal behavior the architecture left abstract — workflows, algorithms, state
machines, error handling, concurrency, retries, idempotency — to the depth a Builder needs without inventing.
**Mode:** `technical-design`. **Tier:** T3.

For each non-trivial component the agent specifies internal logic, state transitions, failure handling, and
ordering/concurrency concerns, and states invariants. It deliberately **stops where code is clearer than
prose** (ambiguity is irreducible — over-specifying trivial components wastes effort). Streams; asks the human
only where a behavior choice is product-meaningful (e.g., on conflict, last-write-wins vs. merge).

**Completion:** every component with non-obvious behavior has a design; state machines and error/concurrency
handling specified; invariants stated; nothing a Builder would have to guess.

**Critic (technical-design mode):** each design supports its REQ-IDs and respects domain invariants and
contracts; concurrency/failure handling present where the architecture implies it; nothing over- or
under-specified.

**Sections:** Component Designs · Key Algorithms/Workflows · State Machines · Error Handling ·
Concurrency/Ordering/Idempotency · Invariants · Open Design Questions.

### 15.7 Stage 7 — Contracts → `07-contracts.md`

**Purpose:** pin the precise interfaces between parts — APIs, module boundaries, data schemas, events,
request/response formats — so independently built slices integrate without surprise. Contracts are the testable
boundary (§11). **Mode:** `contracts`. **Tiers:** T2, T3.

The agent derives contracts from architecture + domain model, defining each interface's inputs/outputs/errors,
typed and constrained schemas, event shapes, and versioning expectations, and anchors each to the REQ-IDs and
slices that depend on it. Streams; surfaces product-affecting choices (pagination model, auth scheme — note:
auth is blast-radius, so it goes to a human gate).

**Completion:** every cross-component interface defined; schemas typed and constrained; error cases enumerated;
contracts anchored to REQs; consumers and producers identified.

**Critic (contracts mode):** each contract serves a REQ; error/edge cases covered; no field missing vs. the
domain model; no two contracts conflict.

**Sections:** Interface Index · API/Module Contracts · Data Schemas · Events · Error Contracts · Versioning ·
Consumer/Producer Map.

### 15.8 Stage 8 — Test Strategy → `08-test-strategy.md`

**Purpose:** define how correctness is proven, mapped to REQ-IDs **and to slices**, so each slice has its
acceptance criteria before it is built — the mechanism that makes "tests are the contract" real (§11).
**Mode:** `test-strategy`. **Tiers:** T2, T3.

From requirements + contracts + failure modes, the agent defines the test pyramid (unit, integration, contract,
e2e, plus performance/security where relevant), assigns each REQ-ID at least one verifying test, and defines
**per-slice acceptance tests**. It specifies what "done" means mechanically. Streams; asks the human about
quality bars only where they are real tradeoffs (coverage targets, performance SLOs).

**Completion:** every MVP REQ-ID maps to ≥1 test; each slice has end-to-end acceptance tests; test levels chosen
with rationale.

**Critic (test-strategy mode):** no REQ-ID without a test; tests exercise behavior (not tautologies);
failure-mode cases have negative tests; slice acceptance tests are end-to-end, not layer-local.

**Sections:** Test Philosophy · Test Levels & Rationale · REQ→Test Map · Per-Slice Acceptance Tests ·
Non-Functional Tests · Tooling · Definition of Done.

### 15.9 Stage 9 — Implementation Planning & Vertical Slicing → `09-implementation-plan.md`

**Purpose:** decompose the design into an ordered set of **vertical slices** — each a thin, end-to-end path
through every layer the capability needs, delivering one demonstrable, independently testable behavior — and,
within each slice, the buildable tasks and their self-contained task files. **Producer:** Vertical Slice Agent
(§6.3). **Tiers:** all engaged (light in T1, full in T3).

**Why vertical, not horizontal.** Horizontal layering (all data, then all logic, then all UI) yields nothing
working until the end, hides integration risk, and defeats the Builder's task-by-task and bidirectional-drift
model. Vertical slices give early working software, an early correctness signal, contained blast radius per
task, and early drift discovery.

**What the agent produces:**

- **Slice 0 — the walking skeleton:** the thinnest end-to-end path that exercises the architecture's spine and
  proves the boundaries integrate, even if it does almost nothing functionally.
- **Subsequent slices**, each with: name; REQ-IDs satisfied (fully or partially); the user-demonstrable
  capability it delivers; the layers/components it touches end-to-end; its anchored acceptance tests (from
  Stage 8); dependencies and order; and a definition of done.
- **Within each slice:** the ordered tasks and their self-contained task files (§9).
- **A coverage map:** the slice set covers all MVP REQ-IDs with no gaps and no slice that is a pure horizontal
  layer.

Streams; surfaces slice **ordering** to the human when sequencing has product implications (what is demoable
first).

**Completion:** ordered slices defined; Slice 0 is a true walking skeleton; every slice independently
demonstrable and testable; all MVP REQ-IDs covered; tasks and task files generated.

**Critic (slice mode), fresh context, checks:** Is each slice actually vertical (end-to-end) or a disguised
horizontal layer? Does each deliver demonstrable, user-visible behavior? Is each independently testable via its
acceptance tests? Does the ordering yield a working system after every slice? Do the slices cover all MVP
REQ-IDs with no gaps or overlap? Is Slice 0 a genuine walking skeleton?

**Sections:** Slicing Summary · Slice 0 (Walking Skeleton) · Slice List (ordered, fields above) · REQ Coverage
Map · Per-Slice Tasks & Task Files · Build Order & Dependencies · Slice Verification Notes.

### 15.S Stage S — Security & Threat Modeling → `08a-security-threat-model.md`

**Purpose:** for projects handling auth, money, sensitive data, or migrations, model assets, trust boundaries,
threats, abuse cases, and mitigations **grounded in this system's actual architecture**, not generic
boilerplate. **Mode:** `security`. **Tiers:** T3 / any blast-radius project.

From architecture + contracts + domain model, the agent identifies assets and trust boundaries, enumerates the
threats at each boundary, defines the authn/authz model, lists abuse cases, and maps concrete mitigations to
components and REQ-IDs. **Anti-boilerplate rule:** every threat must point at a specific component, boundary, or
data flow in this system; generic checklist items with no anchor are discarded. Blast-radius → human gate on
the security model and any auth decision (§8).

**Completion:** assets and boundaries mapped; each boundary's threats enumerated and grounded; authn/authz
defined; mitigations mapped to components and REQs; abuse cases have negative tests in the test strategy.

**Critic (security mode):** each threat anchored to a real component; no mitigation without a threat; auth model
consistent with contracts; high-risk flows covered.

**Sections:** Assets · Trust Boundaries · Data Flows · Threats (grounded) · Authn/Authz · Abuse Cases ·
Mitigations (→ components/REQs) · Residual Risks.

### 15.F Stage F — Failure Modes & Edge Cases → `08b-failure-edge-cases.md`

**Purpose:** for reliability-critical systems, specify behavior under invalid input, duplicate operations,
partial failure, dependency outage, crash/restart, race conditions, and unexpected states. **Mode:**
`failure-modes`. **Tiers:** T3 / reliability-critical.

From architecture + technical design + contracts, the agent walks each component and boundary for failure
scenarios and defines the expected behavior (fail-closed/open, retry/backoff, idempotency, compensation),
anchoring each to negative tests in the test strategy. **Anti-boilerplate rule:** each failure mode is tied to
a specific component or flow; generic "handle errors gracefully" is discarded. Streams; escalates where a
failure-handling choice is product- or risk-meaningful (e.g., data-loss tradeoffs — blast-radius).

**Completion:** each relevant component/boundary has its failure modes and defined behavior;
idempotency/retry/compensation specified where needed; negative tests exist; unexpected-state handling defined.

**Critic (failure-modes mode):** each failure mode anchored; defined behavior consistent with contracts and
invariants; no critical flow without failure handling.

**Sections:** Failure Catalog (per component/flow) · Invalid Input · Duplicates/Idempotency · Partial Failure ·
Dependency Outage · Crash/Restart Recovery · Race Conditions · Unexpected States · Negative-Tests Map.

---

## 16. Stage 10 — Software Implementation

**Output:** `src/`, `tests/`, `configs/`, `README.md`. **Agent:** Builder, parallel where slices are
independent.

Rules:

- Build **slice-by-slice**, starting with the walking skeleton; within a slice, **one task at a time** from its
  self-contained task file.
- Read only the relevant summaries and task file before each task (not the whole corpus — §9).
- Write **tests with the implementation**, anchored to REQ-IDs (§11).
- A task is done when its **anchored tests pass**; a slice is done when its **end-to-end acceptance tests pass**
  — not when the Builder asserts it.
- Do **not** invent undocumented behavior.
- On discovery, apply the **bidirectional drift loop** (§10): auto-update derived docs and log; escalate
  requirement contradictions. Code wins on behavior; requirements win on intent.

**Parallel builds (slice-aware):** two slices may be built concurrently only if their touched component sets are
disjoint; the Orchestrator reads the per-slice "components touched" field from Stage 9 to decide. Slices that
share a component are serialized to avoid merge conflicts and drift races.

---

## 17. Stage 11 — Final Verification & On-Demand Traceability

**Output:** `10-verification-report.md` + a **rendered** traceability view (not a maintained file).

The verification report proves the implementation satisfies requirements, scope, contracts, and tests,
explicitly distinguishing **coherence** (consistency, by Critic) from **correctness** (tests + human, §11).

Traceability is **generated on demand** by scanning the durable anchors that live next to the code: REQ-IDs in
requirements, design sections, contracts, slice/task IDs, and test names. Because those anchors move with the
code, the view never goes stale the way a hand-maintained matrix does.

Rendered view shape (generated, never stored as a maintained artifact):

```
Requirement | Design ref     | Contract | Slice / Task        | Test          | Code
REQ-001      | tech-design §2  | API §3    | SLICE-2 / TASK-014   | test_REQ001_* | src/sync.ts
```

---

## 18. State Management

**State schema:**

```json
{
  "tier": "T2",
  "complexity_rationale": "normal web app; no blast-radius flags",
  "blast_radius_flags": [],
  "current_stage": "implementation-planning",
  "approved_artifacts": [
    { "file": "01-requirements.md", "version": 2, "hash": "a1b2c3" },
    { "file": "02-scope.md",        "version": 1, "hash": "d4e5f6" }
  ],
  "summaries_index": "00-project-summary.md",
  "slices": [
    { "id": "SLICE-0", "status": "done",        "components": ["api", "store"] },
    { "id": "SLICE-1", "status": "in-progress", "components": ["api", "ui"] }
  ],
  "implementation_allowed": true,
  "open_questions": [],
  "drift_open_blocking": 0,
  "revise_loop_counts": { "architecture": 1, "slice-plan": 1 }
}
```

**Resume after crash.** `state.json` plus the append-only drift log let the Orchestrator re-enter at the last
clean checkpoint. A stage interrupted mid-run is **idempotent** — re-run from its inputs; outputs are versioned
so a partial write is replaced, not duplicated. A half-built slice resumes at its first incomplete task.

**Cascade re-verification (diff-scoped).** Artifacts form a dependency graph. When an upstream artifact's
version changes, downstream artifacts are marked **stale**, and the Critic re-runs **only against the diff** of
the upstream summary rather than re-verifying everything from scratch, escalating genuine conflicts. This keeps
a small upstream edit from triggering a full re-verify storm.

**Versioning.** Every artifact carries a version + hash; the drift log and state reference them, so "which
version of the architecture did SLICE-2 build against" is always answerable.

**Loop termination.** Agent↔Critic is capped (default 3 rounds); **zero issues is a valid stop**; hitting the
cap with open issues escalates to the human. **No minimum-issue quota, ever.**

---

## 19. What the Field Got Wrong & How This Design Avoids It

A compact record so the rationale travels with the outline.

- **Spec drift is the #1 killer.** A document humans must maintain goes stale and misleads agents confidently.
  → **Bidirectional specs + drift log (§10); agents maintain the derived layer.**
- **Maintenance tax can double overhead; small tasks don't justify the framework.** → **Tier 0 bypass with a
  blast-radius veto (§5).**
- **Natural-language ambiguity is irreducible.** → **Conversational, selective clarification (§7); hierarchical
  link-out specs and code-as-leaf-spec (§9); never regenerate globally (§4).**
- **Spec quality collapses on vague/large input.** → **Requirements/Scope must narrow; refuse to advance from a
  too-vague brief (§5, §14.1).**
- **Forced critic quotas cause endless review loops and nitpicking.** → **No quota; zero issues is a pass;
  capped loop with human escalation (§7, §18).**
- **"Rules" don't enforce themselves; agents half-follow instructions.** → **Mechanical enforcement via REQ-ID
  anchors and tests-as-contract (§11).**
- **Context loss over long sessions.** → **Self-contained task files + summaries as the handoff currency, kept
  small by vertical slicing (§9, §15.9).**
- **Horizontal "build all the layers first" decomposition leaves nothing working and hides integration risk.**
  → **A dedicated Vertical Slice Agent, walking-skeleton-first, slice-by-slice builds (§6.3, §15.9, §16).**
- **Single-IDE / cloud lock-in and rigidity.** → **Stay portable as a Claude Code skill; the process is the
  product, not a bundled toolchain.**

---

## 20. Key Decisions Log

1. **Adaptive tiers, not a fixed heavyweight process** — including a **Tier 0 bypass** with a concrete
   classifier for trivial work.
2. **Blast radius overrides apparent size** (auth/data/money/migrations can never be bypassed).
3. **Five real agents** (Orchestrator, Spec, Vertical Slice, Builder, Critic) **+ prompt modes** — each
   boundary justified by context/tool isolation or parallelism.
4. **Vertical slicing is the implementation decomposition unit:** walking-skeleton first, then thin end-to-end
   slices, each independently demonstrable and testable; the Builder works slice-by-slice.
5. **Source-of-truth split:** requirements/scope own *intent* (sticky); code owns *behavior*; the middle layer
   is derived and semi-disposable.
6. **Bidirectional specs:** derived-layer drift auto-writes back (non-blocking); requirement-level drift
   escalates (blocking); a drift log is the async review surface.
7. **Summaries are the default handoff;** full artifacts fetched on demand; specs are hierarchical and link out;
   code is the leaf-level spec.
8. **Coherence ≠ correctness:** Critic gates check consistency; tests + human check correctness.
9. **Enforcement is mechanical** (REQ-ID anchors + tests-as-contract), not prose instructions.
10. **Human approval only on irreversible/taste/blast-radius gates;** everything else streams with interrupt.
11. **Critiques must be grounded;** zero issues is valid; revise loop capped with escalation; **no
    minimum-issue quota.**
12. **No maintained traceability matrix** — rendered on demand from anchors.
13. **Security & failure-mode work folded into architecture by default;** standalone only when
    security/reliability-critical, and always grounded to real components.
14. **Rich state with versioning, idempotent resume, and diff-scoped cascade re-verification** on upstream
    change.
15. **The single governing axis (§2)** resolves any new judgment call: strict + gated for the irreversible/
    high-blast-radius/taste layer; flowing/self-maintaining/bypassable for everything else.

---

## 21. Still To Refine

- **Drift-log review UX:** how the human skims and ratifies async derived-layer changes without it becoming
  noise.
- **Slice-granularity heuristics:** how thin is too thin, and how the Vertical Slice Agent decides where one
  slice ends and the next begins for a given domain.
- **Brownfield slicing:** how Slice 0 and the walking skeleton differ when building into an existing codebase
  rather than greenfield.
- ~~**Parallel-build merge protocol:** the concrete mechanism for integrating concurrently built disjoint slices
  and detecting accidental shared-state coupling at merge time.~~ **RESOLVED (Phase 5).** Parallel Builders
  (and scoped sub-Builders) run in isolated git worktrees (`isolation: worktree`); `.twinharness/` stays a
  shared coordination plane (every `th` state/lease/drift call from a worktree targets the main root via
  `--cwd` or the `mcp__plugin_twinharness_th__*` tools). On Critic PASS the Orchestrator merges each worktree
  branch back in **wave order** — within a wave the `th build plan` schedule already makes branches
  component-disjoint, so they merge cleanly; a non-clean merge between plan-disjoint slices is the mechanical
  signal of accidental shared-state coupling and is opened as **blocking** drift (`th drift add --layer
  requirement`) for human resolution, a clean merge → `th build release`. See the **Worktree isolation +
  merge-back protocol** sections of `agents/orchestrator.md` (parallel-build coordination) and
  `skills/twinharness/reference/build-and-verify.md` (Stage 10, parallel waves).
