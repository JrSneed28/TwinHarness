# TwinHarness Pipeline Stages — Reference (part of the TwinHarness orchestrator playbook)

This file contains the full per-stage walkthroughs for the engaged-tier design stages. It is
read on demand by the Orchestrator when entering each stage. Every `th` command, §-citation, and
behavioral rule here is canonical.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## Critic loop boilerplate (used in every stage)

The producer→Critic mechanic is identical in every design stage:

1. Check `th revise status <mode> --json` → if `escalate: true`, surface open grounded issues to
   the human and stop looping (spec §18 cap reached, default 3 rounds).
2. Critic returns **PASS** (zero grounded defects) → proceed. Zero issues is a valid, celebrated
   terminal state — do not invent defects.
3. Critic returns **FAIL** (≥1 grounded defect) → run `th revise bump <mode>`, route grounded
   defects back to the Spec agent, re-run. Repeat until PASS or escalation.

---

## Brownfield adaptations (`project_mode: "brownfield"`)

When the run adopts an existing codebase (`th init --brownfield`), the pipeline overlays reality
instead of starting clean. Three adaptations apply across the stages below:

- **Inspection step before tiering.** Spawn the **Codebase-Inspector agent**
  (`agents/codebase-inspector.md`, fresh context) first. It maps language/build, modules, public
  APIs, the test framework, and any existing blast-radius surfaces (auth, authz, money,
  data-integrity, migrations), emitting source-anchored `docs/00-existing-codebase-analysis.md`.
  Feed its findings to `th tier classify` / `th tier veto-check` — existing blast-radius code the
  new work touches triggers the §5 veto just like new code. Register it after the Critic passes:
  `th artifact register docs/00-existing-codebase-analysis.md --version 1`.
- **Architecture/contracts as an overlay.** The Spec agent acknowledges existing components by path
  (new vs. reused) and treats existing public APIs as constraints, not blanks. It does not redesign
  working, out-of-scope components.
- **Slice 0 is a characterization test.** The Vertical-Slice agent does not build a fresh walking
  skeleton (the system already boots). Slice 0 becomes an end-to-end **characterization** test that
  pins the adoption seam where new work attaches, with existing components untouched (see Stage 9).

---

## Standing services — Librarian (Phase 6, REQ-PCO-060)

The **Librarian agent (`agents/librarian.md`)** is a **long-lived repo-understanding service**, not
a per-stage agent. The Orchestrator stands it up once and keeps it alive across stages; it is the
single owner of the **repo-map + artifact-summary index**.

- **What it owns.** The Librarian maintains the repo map and the index of artifact summaries, built
  and refreshed via `th repo map`, `th repo relevant`, `th repo impact`, and `th context pack`
  (**prefer the typed `mcp__plugin_twinharness_th__*` MCP tools** for these calls — they return
  structured results and resolve `${CLAUDE_PROJECT_DIR}` from any worktree; see
  `reference/mcp-tools.md`). It does not edit artifacts; it indexes and summarizes them.
- **What it answers.** Any agent (Orchestrator, Spec, Builder, Critic, Debugger, Researcher) can ask
  the Librarian **locate** queries ("where does component X live / which files touch REQ-NNN") and
  **summary** queries ("give me the design context for SLICE-3"). It replies with **compact
  capsules** — a few anchored lines plus file/§ pointers — rather than the full artifacts.
- **Why it exists.** The capsule answer is the mechanism that keeps the **main context from
  reloading big artifacts**: instead of pulling a whole design doc or source tree into context, an
  agent asks the Librarian and gets back just the relevant, anchored slice. This complements the
  §9 Summaries-handoff rule — Summaries are the static handoff currency; the Librarian is the live
  query service over the repo and the index.

The Librarian is read-only with respect to artifacts and code; it never gates a stage and never
substitutes for a Critic or a human gate.

---

## Stage 4 — Scope (T1, T2, T3)

Delegate to the **Spec agent in `scope` mode** with the `templates/02-scope.md` skeleton. The
agent reads the approved requirements Summary, recaps goal and success criteria, proposes an MVP,
asks the user to confirm/remove/add, and separates essentials from future features using the two
pruning questions: *"Required for the first usable version?"* and *"Would the project still solve
the core problem without this?"*

**Critic loop (scope mode).** Route the draft to the **Critic agent in `scope` mode**, fresh
context, same producer→critic mechanic (see above):

- Check `th revise status scope --json` → if `escalate: true`, surface open grounded issues to
  the human and stop (cap reached).
- Critic **PASS** → proceed to scope sign-off. Zero issues is a valid terminal state.
- Critic **FAIL** → run `th revise bump scope`, route grounded defects back to the Spec agent,
  re-run. Repeat until PASS or escalation.

Grounded defects for scope: MVP includes items that fail both pruning questions; Out of Scope
omits items explicitly in requirements; scope decisions lack REQ-ID anchors; Future Scope is
indistinguishable from MVP; Scope Risks not traced to specific requirements.

**Scope sign-off gate (sticky — §8).** Advance state (`th state set current_stage scope`) and
present the human gate via AskUserQuestion. Scope is intent; only a human moves it once signed
off (§10). Do not advance until the human approves.

---

## Stage 5 — Stop-gate

Completion is mechanically gated at every stage: the Stop hook runs `th state verify`, so you
cannot truthfully claim "done" while state is invalid or a blocking drift is open.

---

## Stage 6 — Domain Model (T2, T3)

Skip this stage for Tier 1. For Tier 2 and Tier 3, delegate to the **Spec agent in
`domain-model` mode** with the `templates/03-domain-model.md` skeleton.

**Summaries handoff (§9).** The Spec agent reads the **Summary blocks** of
`docs/01-requirements.md` and `docs/02-scope.md` — not the full documents. Full artifacts are
fetched only if a specific detail cannot be resolved from the summary. This is the default for
every stage from here forward.

The agent proposes an initial model first, explains it in plain language, then refines with the
user. It anchors every entity and rule to REQ-IDs (§11).

**Critic loop (domain-model mode).** Route the draft to the **Critic agent in `domain-model`
mode**, fresh context, same producer→critic mechanic:

- Check `th revise status domain-model --json` → if `escalate: true`, surface open grounded
  issues to the human and stop (cap reached, default 3 rounds).
- Critic **PASS** → proceed. Zero issues is a valid, celebrated terminal state.
- Critic **FAIL** → run `th revise bump domain-model`, route grounded defects back to the Spec
  agent, re-run. Repeat until PASS or escalation.

**Debate mode (Phase 4, REQ-PCO-043 — optional augmentation, Pattern B).** For Domain Model the
Orchestrator may run the stage as a **debate** instead of a single draft, when the design space has
genuine competing shapes worth surfacing:

1. **Competing producers in fresh contexts.** Spawn 2–3 **Spec agents in `domain-model` mode**, each
   in a **fresh, isolated context** (`agents/spec.md` debate-mode addendum). Each produces a
   *competing* model for the same stage; fresh context is the mechanism that surfaces real
   alternatives instead of one anchored line of thinking.
2. **Each output is a blackboard fragment** (not the stage artifact). Initialize once with
   `th collab init --stage domain-model`; each producer writes its position with
   `th collab fragment --stage domain-model --round <round> --name <name> --text <...>`. Fragments
   land under `.twinharness/collab/domain-model/<round>/`. `th collab merge --stage domain-model
   --round <round>` mechanically rejects any round containing a fragment with no REQ-ID anchor (§11
   enforced at the fragment boundary).
3. **Reconciler adjudicates.** Spawn the **Reconciler agent (`agents/reconciler.md`)**: it reads the
   competing fragments (`th collab list --stage domain-model --round <round>`) and merges them into
   one artifact, recording every contested decision in the **debate ledger** —
   `th debate add --topic <...>` per fork, `th debate list` to review, `th debate resolve <DEBATE-NNN>
   --resolution <...>` as each is settled.
4. **Critic gate on the merge.** Route the merged artifact to the **Critic agent in `debate-reconcile`
   mode**, fresh context — it certifies the merge is coherent against the competing inputs and the
   resolved ledger entries (no resolved fork silently dropped or contradicted; every concept still
   REQ-ID-anchored). This runs *in addition to* the normal `domain-model` critic checks.
5. **Human sees only the distilled forks.** Genuine, product-meaningful divergences the Reconciler
   cannot settle on coherence grounds escalate to the human — who sees only the **distilled 1–2
   forks**, not the full debate. **Recorded reconciliations seed ADR drafts** downstream (Stage 5,
   T3). When the divergence is a real domain-model fork, it streams as usual once resolved (§8,
   §14.3 — no standing human gate for domain model otherwise).

When **not** run in debate mode, Domain Model produces a single draft exactly as above; debate mode
is an Orchestrator-selected augmentation, not the default.

**No human gate (§8, §14.3).** The domain model streams. The user may interrupt at any point but
is not required to click approve. Once the Critic passes, register the artifact and advance state:

```
th artifact register docs/03-domain-model.md --version 1
th state set current_stage domain-model
```

---

## Stage 7 — Architecture (T1 light, T2, T3)

Delegate to the **Spec agent in `architecture` mode** with the `templates/04-architecture.md`
skeleton.

**Summaries handoff (§9).** The Spec agent reads the **Summary blocks** of
`docs/01-requirements.md`, `docs/02-scope.md`, and (if it exists) `docs/03-domain-model.md`.
Full artifacts fetched only on demand.

The agent defines major components, responsibilities, data flow, runtime flow, system boundaries,
external dependencies, and deployment shape. It folds a **Security** section and a
**Failure-Modes** section into the artifact for Tier 1/2 (these graduate to standalone stages in
Tier 3 — §15.S, §15.F). It anchors every component and decision to REQ-IDs (§11).

**Irreversible decisions gate (§8, §14.4).** The bulk of the architecture streams. The agent
surfaces **only the 1–2 genuinely irreversible style decisions** (e.g. sync vs. async backbone,
monolith vs. service split, data-store category) as explicit choices via **AskUserQuestion**.
These are the only blocking gates in this stage. Do not add gates for decisions the user can
change cheaply.

**Critic loop (architecture mode).** Route the draft to the **Critic agent in `architecture`
mode**, fresh context:

- Check `th revise status architecture --json` → if `escalate: true`, surface open grounded
  issues to the human and stop.
- Critic **PASS** → proceed to artifact registration.
- Critic **FAIL** → run `th revise bump architecture`, route grounded defects back to the Spec
  agent, re-run. Repeat until PASS or escalation.

**Debate mode (Phase 4, REQ-PCO-043 — optional augmentation, Pattern B).** Architecture is the other
stage that may run as a **debate** rather than a single draft — it is the highest-leverage stage for
surfacing genuinely competing structures (e.g. monolith vs. service split, sync vs. async backbone)
before the irreversible-decision gates:

1. **Competing producers in fresh contexts.** Spawn 2–3 **Spec agents in `architecture` mode**, each
   in a **fresh, isolated context** (`agents/spec.md` debate-mode addendum). Each produces a
   *competing* architecture for the same stage; independent fresh-context designs surface real
   structural alternatives rather than one anchored design.
2. **Each output is a blackboard fragment** (not the stage artifact). `th collab init --stage
   architecture` once, then each producer writes
   `th collab fragment --stage architecture --round <round> --name <name> --text <...>`. Fragments
   land under `.twinharness/collab/architecture/<round>/`; `th collab merge --stage architecture
   --round <round>` rejects any round with an unanchored fragment (§11 at the fragment boundary).
3. **Reconciler adjudicates.** The **Reconciler agent (`agents/reconciler.md`)** reads the competing
   fragments (`th collab list --stage architecture --round <round>`) and merges them into one
   artifact, recording each contested decision in the **debate ledger** — `th debate add --topic
   <...>` per fork, `th debate list`, `th debate resolve <DEBATE-NNN> --resolution <...>`.
4. **Critic gate on the merge.** Route the merged artifact to the **Critic agent in `debate-reconcile`
   mode**, fresh context, in addition to the normal `architecture` critic checks: it certifies the
   merge is coherent against the competing inputs and the resolved ledger entries, with every
   component still REQ-ID-anchored and no resolved fork silently dropped or contradicted.
5. **Human sees only the distilled forks.** A real, product-meaningful structural divergence the
   Reconciler cannot settle on coherence grounds escalates to the **irreversible-decision human gate**
   above — but the human sees only the **distilled 1–2 forks**, not the full debate. **Recorded
   reconciliations seed ADR drafts** (Stage 5, T3): each resolved ledger entry maps to a candidate
   ADR for the decision it settled.

When **not** run in debate mode, Architecture produces a single draft exactly as above; debate mode
is an Orchestrator-selected augmentation, not the default.

**Standing red-team (Phase 5, REQ-PCO-050).** From the moment the Architecture/Technical-Design/
Contracts stages open, the Orchestrator runs the **Red-Team agent (`agents/red-team.md`)**
CONCURRENTLY with these downstream design stages — it is not a serial gate that waits for a draft
to finish. The Red-Team agent reads the in-flight design fragments and posts **grounded,
component-anchored attacks** to the blackboard as fragments (`th collab fragment`): each attack
names a specific component, boundary, or data flow and an abuse/break it enables — never a generic
checklist item (same anti-boilerplate bar as §15.S). The design agents on these stages must
**answer each posted attack** (mitigation anchored to a component + REQ-ID) or **convert it** into
a `th drift add` entry or a `th debate add` ledger fork when it exposes a real design fork. This is
a continuous adversary running alongside design, not a one-shot review. **The human gate on the
security model is unchanged and is never streamed** — the standing red-team feeds the design and the
security artifact, but it does not move or bypass the blast-radius human gate at Stage S; that gate
still requires explicit human approval (§8, §15.S).

Once the Critic passes and the human has answered any irreversible-decision gates, register and
advance state:

```
th artifact register docs/04-architecture.md --version 1
th state set current_stage architecture
```

**Artifact registration.** After every stage's artifact is approved and registered, its content
hash and version are recorded in `.twinharness/state.json` under `approved_artifacts`. Downstream
stages use this record to detect staleness (`th stale --artifact <file>` — §18).

---

## Stage 7b — UI Design (conditional: only when the project has a user interface)

Skip this stage for projects without a user interface (CLIs, background services, pure API
libraries). For any project with a web UI, mobile UI, desktop UI, or rich TUI, engage Stage 4b
after Architecture is approved and before Contracts/Test Strategy.

Delegate to the **UI Designer agent (`agents/ui-designer.md`) in a FRESH CONTEXT** (§6.3
rationale: user-centered design is contaminated by backend-architecture thinking; fresh context
produces cleaner, user-centered results).

**Human gate on design direction (taste-driven — §2).** The UI Designer presents 2–3 distinct
design directions to the human via `AskUserQuestion` with the `preview` field containing ASCII
mockups side by side. Do not proceed until the human selects a direction. After direction
sign-off, the detailed design streams.

**Critic loop (ui-design mode).** Route the draft to the **Critic agent in `ui-design` mode**,
fresh context:

- Check `th revise status ui-design --json` → if `escalate: true`, surface open grounded issues
  to the human and stop (cap reached, default 3 rounds).
- Critic **PASS** → proceed to artifact registration. Zero issues is a valid terminal state.
- Critic **FAIL** → run `th revise bump ui-design`, route grounded defects back to the UI
  Designer agent, re-run. Repeat until PASS or escalation.

Once the Critic passes, register and advance state:

```
th artifact register docs/04b-ui-design.md --version 1
th state set current_stage ui-design
```

**No second human gate after direction sign-off** — the Critic gates quality. The Vertical
Slice agent (Stage 9) receives the `docs/04b-ui-design.md` Summary block so slices for
UI-bearing projects reference specific screens and flows.

---

## Stage 9 — Implementation Planning & Vertical Slicing (all engaged tiers)

Delegate to the **Vertical Slice agent (`agents/vertical-slice.md`) in a FRESH CONTEXT** (spec
§6.3, §15.9). Fresh context is the mechanism: both humans and LLMs default to horizontal-layer
decomposition; a fresh context uncontaminated by the design-stage thinking produces cleaner
vertical slices.

**Summaries handoff (§9).** The Vertical Slice agent reads the **Summary blocks** of
`docs/01-requirements.md`, `docs/02-scope.md`, `docs/04-architecture.md`, and (if they exist)
`docs/07-contracts.md` and `docs/08-test-strategy.md`. Full artifacts fetched only on demand.

The agent produces:
- **Slice 0** — the walking skeleton: the thinnest end-to-end path that exercises every significant
  architectural boundary, with an integration acceptance test, even if it does almost nothing
  functionally. **Brownfield (`project_mode: "brownfield"`):** Slice 0 is instead a
  **characterization** test around the adoption seam (the integration point new work attaches to,
  per `docs/00-existing-codebase-analysis.md`), with existing components untouched — the system
  already boots, so there is no fresh skeleton to stand up.
- **Ordered subsequent slices**, each with: name; REQ-IDs satisfied; user-demonstrable capability;
  components touched end-to-end (drives §16 parallel-build serialization); anchored acceptance
  tests; dependencies and order; definition of done.
- **Ordered tasks and self-contained task files** (§9, `templates/task-file.md`) within each slice.
- **REQ Coverage Map** — every MVP REQ-ID mapped to ≥1 slice; machine-parseable for
  `th coverage check`.

Writes `docs/09-implementation-plan.md` from `templates/09-implementation-plan.md`. Streams;
surfaces slice ordering to the human **only** when the sequencing has real product implications
(e.g. what is demoable first).

**Tiering:** all engaged tiers run this stage. **T1** — lightweight (fewer slices, lighter task
files). **T3** — full detail (per-slice ADR references, detailed component list, full task files
with contracts and design notes embedded).

**Parallelism-optimizer loop (Phase 3, REQ-PCO-030 — runs BEFORE the slice gate and coverage
gate).** After the Vertical Slice agent produces the draft plan, run one reconciliation pass that
widens disjoint-component parallelism, then proceed to the unchanged gates below:

1. Route the draft to the **Critic agent in `parallelism` mode**, fresh context. That Critic
   consults `th build plan --advise`, which reports the plan's current max-parallelism width and the
   **conflict pairs** (slices with overlapping component sets or `depends_on` edges that serialize
   them — computed from `conflictPairs`). It returns concrete re-cut suggestions (split a shared
   component along its seam, hoist a shared dependency into Slice 0, break a needless `depends_on`
   edge), routed back to the Vertical Slice agent.
2. The **Vertical Slice agent reconciles** the plan: re-cuts *incidental* overlaps so more slices
   land in the same build wave, updating the **Components touched** field and the **Build Order &
   Dependencies** section. *Essential* shared boundaries are left as-is.
3. **The hard gates win.** This loop never weakens vertical-slice integrity or REQ coverage — it
   may not disguise a horizontal layer, drop a slice's user-visible capability, or remove coverage.
   The `slice` coherence gate and the `th coverage check` hard-gate (both below) run afterward and
   override any optimization. Zero re-cut suggestions is a valid PASS — an already-wide plan needs
   no change.

**Soft (interface-only) dependencies for speculative dispatch (Phase 7, Slice 11, REQ-PCO-070).**
When a slice needs only the *interface* of an upstream slice and not its finished behavior, the
Vertical Slice agent records that edge as **`depends_on_soft`** in the **Build Order &
Dependencies** section rather than a hard `depends_on`. A `depends_on_soft` edge lets the build
stage dispatch the downstream slice **speculatively** against the upstream contract before that
upstream is `done` (the merge-conflict-as-BLOCKING-drift backstop catches a bad speculation); a true
behavioral dependency stays `depends_on` and still gates. The mechanics live in
`reference/build-and-verify.md` (Parallel builds). Use `depends_on_soft` only for genuine
interface-only edges — over-using it to fake parallelism is caught at merge-back.

**Critic loop (slice mode).** Route the draft to the **Critic agent (`agents/critic.md`) in
`slice` mode**, fresh context:

- Check `th revise status slice --json` → if `escalate: true`, surface open grounded issues to
  the human and stop (cap reached, default 3 rounds).
- Critic **PASS** → proceed to coverage gate. Zero issues is a valid, celebrated terminal state.
- Critic **FAIL** → run `th revise bump slice`, route grounded defects back to the Vertical Slice
  agent, re-run. Repeat until PASS or escalation.

Grounded defects the Critic will catch: a disguised horizontal layer ("implement all DB schemas"
is not a vertical slice); a slice with no user-visible capability; a slice with only unit-test
acceptance criteria; a Slice 0 that does not integrate the architectural boundaries; ordering that
does not yield a working system after each slice; any MVP REQ-ID missing from the coverage map.

**Mechanical coverage gate (non-negotiable).** After Critic PASS, run:

```
th coverage check
```

This command asserts that every MVP REQ-ID maps to ≥1 slice and ≥1 test (spec §3). It is a
**hard gate** — non-zero exit means building does not start. Resolve any gap by returning to the
Vertical Slice agent (fresh context) and adding the missing coverage before proceeding.

**No human gate** (spec §8, §15.9). The slice plan streams. The human may interrupt at any point
but is not required to approve. Once the Critic passes and `th coverage check` exits zero,
register the artifact and advance state:

```
th artifact register docs/09-implementation-plan.md --version 1
th state set current_stage implementation-planning
```

---

## Downstream stages — complete tier pipeline

After Architecture, the engaged stages that follow depend on the chosen tier. All stage sequences
below are defined by spec §5/§13; the numbered stages match the full pipeline table (§13).

---

### Stage 5 — Architecture Decision Records (T3 only) → `docs/05-adrs/`

Skip this stage for T1 and T2. For T3, delegate to the **Spec agent in `adr` mode** with the
`templates/05-adr.md` skeleton (§15.5).

The agent scans the architecture and the human-gated style choices for decisions that are
significant and costly to reverse, drafts one ADR per decision, and links every ADR to the REQ-IDs
and components it serves. Streams; only genuinely irreversible decisions reach the human (§8).

**Critic loop (adr mode).** Route the draft to the **Critic agent in `adr` mode**, fresh context,
same producer→critic mechanic:

- Check `th revise status adr --json` → if `escalate: true`, surface open grounded issues to the
  human and stop (cap reached, default 3 rounds).
- Critic **PASS** → proceed to artifact registration. Zero issues is a valid, celebrated terminal
  state.
- Critic **FAIL** → run `th revise bump adr`, route grounded defects back to the Spec agent,
  re-run. Repeat until PASS or escalation.

Once the Critic passes, register and advance state:

```
th artifact register docs/05-adrs/ --version 1
th state set current_stage adrs
```

---

### Stage 6 — Detailed Technical Design (T3 only) → `06-technical-design.md`

Skip this stage for T1 and T2. For T3, delegate to the **Spec agent in `technical-design` mode**
with the `templates/06-technical-design.md` skeleton (§15.6).

The agent specifies internal behavior the architecture left abstract: workflows, algorithms, state
machines, error handling, concurrency, retries, idempotency. It stops where code is clearer than
prose. Streams; asks the human only where a behavior choice is product-meaningful.

**Standing red-team applies here too (Phase 5, REQ-PCO-050).** This is one of the downstream design
stages the **Red-Team agent (`agents/red-team.md`)** runs CONCURRENTLY against (see the standing
red-team note under Stage 7 — Architecture). Component-anchored attacks it posts to the blackboard
(`th collab fragment`) against the detailed-design fragments must be answered (anchored mitigation)
or converted to drift/debate. The human security gate at Stage S is unchanged and never streamed.

**Summaries handoff (§9).** The Spec agent reads Summary blocks of `docs/01-requirements.md`,
`docs/04-architecture.md`, and any ADRs in `docs/05-adrs/`. Full artifacts fetched only on demand.

**Critic loop (technical-design mode).** Route the draft to the **Critic agent in
`technical-design` mode**, fresh context:

- Check `th revise status technical-design --json` → if `escalate: true`, surface open grounded
  issues to the human and stop.
- Critic **PASS** → proceed to artifact registration.
- Critic **FAIL** → run `th revise bump technical-design`, route grounded defects back to the Spec
  agent, re-run. Repeat until PASS or escalation.

Once the Critic passes, register and advance state:

```
th artifact register docs/06-technical-design.md --version 1
th state set current_stage technical-design
```

---

### Stage 7 — Contracts (T2, T3) → `07-contracts.md`

Skip this stage for T1. For T2 and T3, delegate to the **Spec agent in `contracts` mode** with
the `templates/07-contracts.md` skeleton (§15.7).

**Summaries handoff (§9).** The Spec agent reads Summary blocks of `docs/01-requirements.md`,
`docs/04-architecture.md`, `docs/03-domain-model.md` (T2/T3), and (for T3)
`docs/06-technical-design.md`. Full artifacts fetched only on demand.

The agent derives contracts from architecture + domain model: each interface's
inputs/outputs/errors, typed and constrained schemas, event shapes, versioning expectations,
anchored to REQ-IDs and slices. Streams; surfaces product-affecting choices to the human.

**Standing red-team applies here too (Phase 5, REQ-PCO-050).** Contracts is one of the downstream
design stages the **Red-Team agent (`agents/red-team.md`)** runs CONCURRENTLY against (see the
standing red-team note under Stage 7 — Architecture). Component-anchored attacks it posts to the
blackboard (`th collab fragment`) against in-flight contract fragments — e.g. an interface that
leaks a trust boundary, an unvalidated input shape, a missing authz check on a typed endpoint —
must be answered with an anchored mitigation or converted to a drift/debate entry. This runs
alongside (not instead of) the auth human gate below and the Stage S human security gate, both of
which are unchanged and never streamed.

**Auth decisions are blast-radius — human gate required (§8, §15.7).** If any auth scheme
(authentication or authorization model, token structure, permission boundaries) surfaces as a
contract choice, it must go to a **AskUserQuestion** gate before proceeding. Do not assume; do not
auto-select an auth model.

**Critic loop (contracts mode).** Route the draft to the **Critic agent in `contracts` mode**,
fresh context:

- Check `th revise status contracts --json` → if `escalate: true`, surface open grounded issues to
  the human and stop (cap reached).
- Critic **PASS** → proceed to artifact registration. Zero issues is a valid terminal state.
- Critic **FAIL** → run `th revise bump contracts`, route grounded defects back to the Spec agent,
  re-run. Repeat until PASS or escalation.

Once the Critic passes and any auth gates are cleared, register and advance state:

```
th artifact register docs/07-contracts.md --version 1
th state set current_stage contracts
```

---

### Stage S — Security & Threat Modeling (T3 / any blast-radius project) → `08a-security-threat-model.md`

**Default (T1/T2):** Security is a folded section inside `docs/04-architecture.md`. Do not
produce a standalone artifact unless the project is T3 or carries a blast-radius flag.

**Graduated stage (T3 / blast-radius):** for projects handling auth, money, sensitive data, or
migrations, this section graduates to its own stage and file. Delegate to the **Spec agent in
`security` mode** with the `templates/08a-security-threat-model.md` skeleton (§15.S).

**Summaries handoff (§9).** The Spec agent reads Summary blocks of `docs/04-architecture.md`,
`docs/07-contracts.md`, and `docs/03-domain-model.md`. Full artifacts fetched only on demand.

The agent identifies assets and trust boundaries, enumerates grounded threats at each boundary,
defines the authn/authz model, lists abuse cases, and maps concrete mitigations to components and
REQ-IDs. **Anti-boilerplate rule (§15.S):** every threat must point at a specific component,
boundary, or data flow in this system; generic checklist items with no anchor are discarded and
the Critic will reject them.

**Standing red-team feeds this stage (Phase 5, REQ-PCO-050).** The **Red-Team agent
(`agents/red-team.md`)** has been running CONCURRENTLY against Architecture/Technical-Design/
Contracts (see the standing red-team note under Stage 7). The grounded, component-anchored attacks
it posted to the blackboard (`th collab fragment`) are inputs to this threat model: every
unanswered attack is either a threat to enumerate here (anchored to its component/boundary, per the
anti-boilerplate rule above) or a resolved mitigation to record. The standing red-team accelerates
and grounds the security artifact; it does **not** alter the gate below.

**Human gate on the security model and every auth decision (§8, §15.S — blast-radius).**
Surface the completed security model to the human via **AskUserQuestion** before proceeding.
Any auth decision (authentication flows, authorization model, trust boundaries) is blast-radius
and must have explicit human approval. Do not stream past auth without a gate. **This human gate is
unchanged by the standing red-team and is NEVER streamed** — the concurrent adversary informs the
model, but only a human signs off on the security model and auth decisions (§8).

**Critic loop (security mode).** Route the draft to the **Critic agent in `security` mode**,
fresh context:

- Check `th revise status security --json` → if `escalate: true`, surface open grounded issues to
  the human and stop (cap reached).
- Critic **PASS** → proceed to human gate (required — see above). Zero issues is a valid terminal
  state.
- Critic **FAIL** → run `th revise bump security`, route grounded defects back to the Spec agent,
  re-run. Repeat until PASS or escalation.

After human approval, register and advance state:

```
th artifact register docs/08a-security-threat-model.md --version 1
th state set current_stage security
```

---

### Stage F — Failure Modes & Edge Cases (T3 / reliability-critical) → `08b-failure-edge-cases.md`

**Default (T1/T2):** Failure modes is a folded section inside `docs/04-architecture.md`. Do not
produce a standalone artifact unless the project is T3 or reliability-critical.

**Graduated stage (T3 / reliability-critical):** for systems requiring formal failure-mode
design, this section graduates to its own stage and file. Delegate to the **Spec agent in
`failure-modes` mode** with the `templates/08b-failure-edge-cases.md` skeleton (§15.F).

**Summaries handoff (§9).** The Spec agent reads Summary blocks of `docs/04-architecture.md`,
`docs/06-technical-design.md` (T3), and `docs/07-contracts.md`. Full artifacts fetched only on
demand.

The agent walks each component and boundary for failure scenarios and defines expected behavior
(fail-closed/open, retry/backoff, idempotency, compensation), anchoring each to negative tests in
the test strategy. **Anti-boilerplate rule (§15.F):** each failure mode is tied to a specific
component or flow; generic "handle errors gracefully" entries are discarded.

**Standing red-team feeds this stage too (Phase 5, REQ-PCO-050).** Failure-Modes is one of the
downstream design stages the **Red-Team agent (`agents/red-team.md`)** runs CONCURRENTLY against
(see the standing red-team note under Stage 7 — Architecture). The grounded, component-anchored
attacks it posts to the blackboard (`th collab fragment`) against the in-flight design — an abuse
that drives a component to a data-loss state, a missing fail-closed path on a boundary — are inputs
here: each unanswered attack is either a failure mode to enumerate (anchored to its component/flow,
per the anti-boilerplate rule above) or a resolved mitigation to record, or it converts to a
`th drift add` / `th debate add` entry. The concurrent adversary grounds the failure model; it does
not move the data-loss-tradeoff human gate below, and the security model's human gate (Stage S) is
unchanged and never streamed.

Streams. Escalates where a failure-handling choice involves a data-loss tradeoff — that is
blast-radius and requires a human gate (§8).

**Critic loop (failure-modes mode).** Route the draft to the **Critic agent in `failure-modes`
mode**, fresh context:

- Check `th revise status failure-modes --json` → if `escalate: true`, surface open grounded
  issues to the human and stop (cap reached).
- Critic **PASS** → proceed to artifact registration. Zero issues is a valid terminal state.
- Critic **FAIL** → run `th revise bump failure-modes`, route grounded defects back to the Spec
  agent, re-run. Repeat until PASS or escalation.

Register and advance state:

```
th artifact register docs/08b-failure-edge-cases.md --version 1
th state set current_stage failure-modes
```

---

### Stage 8 — Test Strategy (T2, T3) → `08-test-strategy.md`

Skip this stage for T1. For T2 and T3, delegate to the **Spec agent in `test-strategy` mode**
with the `templates/08-test-strategy.md` skeleton (§15.8).

**Summaries handoff (§9).** The Spec agent reads Summary blocks of `docs/01-requirements.md`,
`docs/07-contracts.md`, and (for T3) `docs/08b-failure-edge-cases.md`. Full artifacts fetched only
on demand.

The agent defines the test pyramid, assigns each REQ-ID at least one verifying test, and defines
per-slice acceptance tests. It specifies what "done" means mechanically. Streams; asks the human
about quality bars only where they are real tradeoffs (coverage targets, performance SLOs).

**Critic loop (test-strategy mode).** Route the draft to the **Critic agent in `test-strategy`
mode**, fresh context:

- Check `th revise status test-strategy --json` → if `escalate: true`, surface open grounded
  issues to the human and stop (cap reached).
- Critic **PASS** → proceed to artifact registration. Zero issues is a valid terminal state.
- Critic **FAIL** → run `th revise bump test-strategy`, route grounded defects back to the Spec
  agent, re-run. Repeat until PASS or escalation.

Register and advance state:

```
th artifact register docs/08-test-strategy.md --version 1
th state set current_stage test-strategy
```
