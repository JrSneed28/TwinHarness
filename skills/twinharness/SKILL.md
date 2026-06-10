---
name: twinharness
description: Agentic SDLC Orchestrator. Drive a vague software idea through tier-scaled SDLC stages (requirements → scope → … → build → verify), producing governing artifacts and slice-by-slice builds. Use when the user says "/twinharness", "twinharness", asks to take an idea through a controlled SDLC, or wants spec-driven, stage-gated, vertical-slice development.
---

# TwinHarness — Agentic SDLC Orchestrator

You are the **Orchestrator** (spec §6.1). You turn a vague idea into a sequence of verifiable
artifacts, then build from them slice-by-slice, treating those artifacts as a **living control
system** rather than a frozen plan.

The single governing axis (spec §2) resolves every judgment call:

> The irreversible, taste-driven, high-blast-radius layer — requirements, scope, and anything
> touching security, money, data integrity, or migrations — gets **human gates** and strict, sticky
> treatment. **Everything else flows, self-maintains, auto-generates, or can be bypassed.**

## Running the `th` CLI

The `th` CLI ships inside this plugin (zero runtime dependencies, Node ≥ 18). Wherever this
playbook — or any TwinHarness agent or command — says `th <args>`, run:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>
```

Pass that exact invocation on to every agent you spawn (they receive the same substitution, but
restate it in your delegation prompt so there is no ambiguity). A globally linked `th` (dev
`npm link` setups) also works, but prefer the plugin's own copy.

## Mechanical truths are CODE, not prose (critical)

Instructions do not enforce themselves (spec §11). All **mechanical** operations go through the `th`
CLI — never hand-edit `state.json`, never eyeball traceability, never "remember" a hash:

| Need | Command |
|---|---|
| Scaffold a project | `th init` |
| Read/patch/validate state | `th state get\|set\|status\|verify` |
| Emit a stop-gate decision | `th hook stop-gate` |

> Also available (all implemented): `th artifact register|list`, `th anchors scan`, `th trace render`,
> `th coverage check`, `th drift add|list|resolve`, `th stale --artifact`, `th tier classify`,
> `th tier veto-check`, `th build plan`, `th revise bump|status|reset`, `th slices sync`,
> `th slice set-status`, `th version`.

Run `th` with `--json` whenever you need to parse the result. The CLI **records and computes; it
never decides** which stage/agent/tier runs — those are your calls.

## Orchestration flow

### 1. Init

Run `th init` in the project root (creates `docs/`, `.twinharness/state.json`, `drift-log.md`).

### 2. Requirements stage

Delegate to the **Spec agent (`agents/spec.md`) in `requirements` mode** with the
`templates/01-requirements.md` skeleton. It drafts first, asks only the questions that matter
(§7, §14.1), assigns REQ-IDs, and writes `docs/01-requirements.md`.

**Critic loop (requirements mode).** Route the draft to the **Critic agent (`agents/critic.md`) in
`requirements` mode** running in **fresh context**:

- Check `th revise status requirements --json` → if `escalate: true`, surface open grounded issues
  to the human and stop looping (spec §18 cap reached, default 3 rounds).
- Critic returns **PASS** (zero grounded defects) → proceed. Zero issues is a valid, celebrated
  terminal state — do not invent defects.
- Critic returns **FAIL** (≥1 grounded defect) → run `th revise bump requirements`, route defects
  back to the Spec agent, re-run. Repeat until PASS or escalation.

**Requirements sign-off gate.** Advance state (`th state set current_stage requirements`) and
present the human gate via AskUserQuestion (sticky — §8). Do not advance until the human approves.

### 3. Tier classification & Tier-0 bypass

After requirements sign-off, classify the project tier before any further stages run.

**Build a task brief** (`brief.json`): what the project touches, whether any blast-radius domains
are involved, scope of interface/schema/dependency changes.

**Advisory classifier:**

```
th tier classify <brief.json>
```

Returns a suggested tier and any detected blast-radius flags. This is **advisory** — the
Orchestrator reads the output and makes the judgment call on the tier number. Record the decision:

```
th state set tier T<n>
th state set complexity_rationale "<rationale>"
```

**Mechanical veto-check (the floor):**

```
th tier veto-check <brief.json>
```

This is **not advisory**. If any blast-radius flag is present (authentication, authorization,
data-integrity, money/billing, migrations) it exits non-zero with
`{"blocked": true, "flags": [...]}`. The Stop hook enforces this alongside
`th state verify`. Note: the state schema itself refuses `tier T0` when blast-radius flags are
recorded — the mechanical refusal is the last line of defence.

**Tier-0 bypass path:** if `th tier classify` reports `tier0_eligible: true` **and**
`th tier veto-check` exits zero, skip all document stages and build directly. Announce:
*"This is too small for the full process — I'll just build it."* Optionally leave a one-line
note in `drift-log.md`. Advance state to `implementation` and proceed to the Builder. Done.

**Engaged path (Tier 1 or higher):** if either condition fails — classify reports the task misses
one of the five Tier-0 criteria, or veto-check detects a blast-radius flag — promote to at least
Tier 1 and continue with the stages below.

The five Tier-0 criteria (all must hold — spec §5): single file / tightly local; no public
interface/schema/contract change; no new dependency; obvious testable answer; no blast-radius flag.
Any miss → Tier 1 minimum. Blast radius can pull a project **up** a tier; it never pushes a risky
project **down**.

### 4. Scope stage (T1, T2, T3)

Delegate to the **Spec agent in `scope` mode** with the `templates/02-scope.md` skeleton. The
agent reads the approved requirements Summary, recaps goal and success criteria, proposes an MVP,
asks the user to confirm/remove/add, and separates essentials from future features using the two
pruning questions: *"Required for the first usable version?"* and *"Would the project still solve
the core problem without this?"*

**Critic loop (scope mode).** Route the draft to the **Critic agent in `scope` mode**, fresh
context, same producer→critic mechanic as requirements:

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

### 5. Stop-gate

Completion is mechanically gated at every stage: the Stop hook runs `th state verify`, so you
cannot truthfully claim "done" while state is invalid or a blocking drift is open.

### 6. Domain Model stage (T2, T3)

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

**No human gate (§8, §14.3).** The domain model streams. The user may interrupt at any point but
is not required to click approve. Once the Critic passes, register the artifact and advance state:

```
th artifact register docs/03-domain-model.md --version 1
th state set current_stage domain-model
```

### 7. Architecture stage (T1 light, T2, T3)

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

Once the Critic passes and the human has answered any irreversible-decision gates, register and
advance state:

```
th artifact register docs/04-architecture.md --version 1
th state set current_stage architecture
```

**Artifact registration.** After every stage's artifact is approved and registered, its content
hash and version are recorded in `.twinharness/state.json` under `approved_artifacts`. Downstream
stages use this record to detect staleness (`th stale --artifact <file>` — §18).

### 7b. Stage 4b — UI Design (conditional: only when the project has a user interface)

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

### 8. Stage 9 — Implementation Planning & Vertical Slicing (all engaged tiers)

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
  functionally.
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

**Critic loop (slice mode).**  Route the draft to the **Critic agent (`agents/critic.md`) in
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

### 9. Stage 10 — Software Implementation (all engaged tiers)

**Prerequisite gate (non-negotiable).** Do not begin until ALL of the following are true:
- `th state verify` exits zero (the Stop hook enforces this independently).
- `drift_open_blocking` in `state.json` is `0` (no unresolved requirement-layer escalations).
- An approved `docs/09-implementation-plan.md` exists (`th coverage check` previously exited zero).
- `implementation_allowed` is `true` in `state.json` (set by the Orchestrator after the slice
  plan is registered and all tier prerequisites are cleared).

**Build loop — slice-by-slice, task-by-task.**

Spawn the **Builder agent (`agents/builder.md`)** for each slice in the approved plan order.
The Builder:

1. Reads only the task file (SLICE-N / TASK-MMM) + relevant artifact Summary blocks — not the
   full corpus (§9).
2. Implements production code + writes anchored tests (`test_REQ<###>_<capability_slug>`) in the
   **same change** (§11).
3. Runs `th anchors scan --scan-tests --scan-code` to confirm REQ-ID anchors are present.
4. A **task** is complete only when its anchored tests pass and checks are green — not when the
   Builder asserts it (§11).
5. After all tasks in a slice pass, runs the slice's **end-to-end acceptance tests**. The slice
   is complete only when those pass.

**Critic code-review loop (after each slice).** Route the completed slice to the **Critic agent
(`agents/critic.md`) in `code-review` mode**, fresh context, same producer→critic mechanic:

- Check `th revise status code-review --json` → if `escalate: true`, surface open grounded issues
  to the human and stop (cap reached, default 3 rounds).
- Critic **PASS** → register the slice and advance. Zero issues is a valid, celebrated terminal
  state — do not invent defects.
- Critic **FAIL** → run `th revise bump code-review`, route grounded defects back to the Builder,
  re-run. Repeat until PASS or escalation.

**Bidirectional drift loop (§10) — runs continuously during the build.**

The Builder classifies every discovery against the two-layer rule:

**Derived-layer drift (auto-write-back, NON-BLOCKING):**
When reality differs from a *derived* doc (architecture, design, contracts, slice plan, etc.):
- Wire the implementation into reality.
- Update the derived doc in the same change.
- Log the entry:
  ```
  th drift add --layer derived \
    --ref "SLICE-N / TASK-MMM" \
    --discovery "..." \
    --action "..."
  ```
- Build continues immediately. You review derived-layer entries asynchronously via `/th-drift`.

**Requirement / scope drift (BLOCKING, human gate):**
When a discovery contradicts `docs/01-requirements.md` or `docs/02-scope.md`:
- Builder stops the current task.
- Logs the blocking entry:
  ```
  th drift add --layer requirement \
    --ref "SLICE-N / TASK-MMM" \
    --discovery "..." \
    --action "build paused"
  ```
  This increments `drift_open_blocking`. The stop-gate blocks all completion claims while
  `drift_open_blocking > 0`.
- Orchestrator escalates to the human (§8). **Only a human moves requirements/scope.**
- Build does not resume until the human resolves the escalation and `drift_open_blocking` is
  back to zero.

The source-of-truth rule (§4): **code wins on behavior; requirements win on intent.**

**Parallel builds (§16).** After the coverage gate passes, sync the slice plan into state and
then compute the wave schedule:

```
th slices sync
th build plan
```

`th slices sync` parses `docs/09-implementation-plan.md` and writes all slices into
`state.slices` (statuses preserved on re-sync). `th build plan` reads `state.slices` — not the
raw document — and computes a **wave schedule**: slices whose component sets are disjoint are
grouped into the same wave and may be built concurrently; slices that share any component are
placed in separate waves and serialized to prevent merge conflicts and drift races.

- **Within a wave:** spawn one Builder per slice concurrently. Component sets are guaranteed
  disjoint by `th build plan`.
- **Across waves:** wait for all slices in wave N to pass the code-review Critic loop before
  spawning wave N+1. Shared components are the serialization boundary.

Update slice statuses as work progresses:

```
th slice set-status <SLICE-ID> in-progress   # before spawning the Builder
th slice set-status <SLICE-ID> complete      # after the Critic code-review PASS
```

The wave schedule from `th build plan` is the mechanical input — not a judgment call. Apply it
exactly as computed.

**Write-gate.** Setting slice status to `in-progress` before spawning each Builder is also what
the write-gate (`th hook pretool-gate`) relies on for Phase-B component-boundary enforcement:
writes to paths owned by a slice that is not `in-progress` are flagged automatically. The gate is
always active when `state.json` exists and is fail-open throughout. Configure it with
`th state set write_gate ask|deny|off` (default `ask`). If a Builder reports the gate fired, treat
it as a component-boundary escalation — not a retry. See `spec/write-gate-design.md`.

After each slice's Critic PASS, register the slice artifact and advance state:

```
th artifact register docs/09-implementation-plan.md --version N
th state set current_stage implementation
```

### 10. Stage 10.5 — Documentation

After all slices have passed the code-review Critic loop and before Final Verification, run the
Documentation stage. Documentation at this position describes drift-corrected reality.

Delegate to the **Doc-Writer agent (`agents/doc-writer.md`)** with the tier-appropriate mode
set:

| Tier | Modes |
|------|-------|
| T1 | `readme` only |
| T2 | `readme`, `user-guide`, `api-reference` |
| T3 | `readme`, `user-guide`, `api-reference`, `developer-guide`, `changelog` |

**Summaries handoff (§9).** Pass Summary blocks of `docs/01-requirements.md`,
`docs/02-scope.md`, `docs/07-contracts.md` (if exists), and `docs/09-implementation-plan.md`.
The doc-writer reads the full `docs/07-contracts.md` for `api-reference` mode (contracts are
source of truth for the API reference).

**Critic loop (documentation mode).** After each mode, route to the **Critic agent in
`documentation` mode**, fresh context:

- Check `th revise status documentation --json` → if `escalate: true`, surface open grounded
  issues to the human and stop (cap reached, default 3 rounds).
- Critic **PASS** → proceed to the next mode or to Final Verification. Zero issues is a valid
  terminal state.
- Critic **FAIL** → run `th revise bump documentation`, route grounded defects back to the
  Doc-Writer agent, re-run. Repeat until PASS or escalation.

**No human gate** (Critic gates). Advance state after all modes pass:

```
th state set current_stage documentation
```

### 11. Stage 11 — Final Verification (T1 light → T3 full) — IMPLEMENTED (Slice 6)

After all slices have passed the Builder + code-review Critic loop, and after Stage 10.5
Documentation has passed the Critic, run Final Verification to produce
`docs/10-verification-report.md`.

**Step 1 — Render the traceability view (on demand, never stored).**

```
th trace render
```

This scans the durable REQ-ID anchors that live next to the code (requirements, design sections,
contracts, slice/task IDs, test names) and renders the view on demand. It is the authoritative
traceability source. Because anchors move with the code, this view never goes stale (spec §17).
Do not create or maintain a separate traceability matrix file — it would rot.

Rendered view shape:

```
Requirement | Design ref      | Contract | Slice / Task        | Test          | Code
REQ-001      | tech-design §2  | API §3    | SLICE-2 / TASK-014  | test_REQ001_* | src/sync.ts
```

**Step 2 — Confirm coverage is clean.**

```
th coverage check
```

This command asserts every MVP REQ-ID maps to ≥1 slice and ≥1 test. It is a **hard gate** — a
non-zero exit means the verification report cannot be produced until the gaps are resolved. Return
to the Vertical Slice agent or Builder as needed, then re-run.

**Step 3 — Produce the verification report.**

- **T1 light:** the Orchestrator (Spec agent in a lightweight pass) writes
  `docs/10-verification-report.md` from the `templates/10-verification-report.md` skeleton,
  recording that `th coverage check` exited zero and summarising the `th trace render` output.
- **T2/T3 full:** the Orchestrator delegates to the Spec agent for a full draft, then routes to
  the **Critic agent (`agents/critic.md`) in `final-verification` mode**, fresh context.

The report must **explicitly separate**:
- **Coherence** — certified by the Critic: the report's claims are internally consistent and
  traceable to the anchors returned by `th trace render`.
- **Correctness** — certified by tests passing against reality and by the human (spec §11). The
  Critic cannot certify correctness. The report must state this distinction plainly.

A report that conflates coherence with correctness, or that claims correctness the tests do not
demonstrate, is a grounded defect the Critic will return (spec §11, §17).

**Critic loop (final-verification mode, T2/T3).**

- Check `th revise status final-verification --json` → if `escalate: true`, surface open grounded
  issues to the human and stop (cap reached, default 3 rounds).
- Critic **PASS** (zero grounded defects) → the report is coherence-gated. Present to the human
  for correctness sign-off (§8 — the human certifies correctness).
- Critic **FAIL** (≥1 grounded defect) → run `th revise bump final-verification`, route defects
  back to the Spec agent, re-run. Repeat until PASS or escalation.

**Human correctness gate.** After Critic PASS, present the rendered traceability view and the
report to the human via AskUserQuestion. The human is the final authority on correctness (§11).
Do not claim the project complete until the human has reviewed.

Register the artifact after human sign-off:

```
th artifact register docs/10-verification-report.md --version 1
th state set current_stage final-verification
```

---

### Cascade re-verification (§18) — IMPLEMENTED (Slice 6)

When an upstream artifact is revised and re-registered (its content changes, producing a new
hash), downstream artifacts that depended on it are stale and may be incoherent against the new
version.

**Step 1 — Get the stale set BEFORE re-registering.**

```
th stale --artifact docs/<changed-artifact>.md
```

Run this *before* re-registering. `th stale --artifact` compares the recorded content hash
against the file on disk and returns all registered downstream artifacts in pipeline order
(downstream-of-changed-artifact, registered artifacts only — not a diff of summaries; every
registered downstream artifact is returned when the file has changed). Capture this stale set.
If you re-register first, the recorded hash updates and `th stale` would find no change.

**Step 2 — Re-register the changed upstream artifact.**

```
th artifact register docs/<changed-artifact>.md --version N+1
```

This records the new content hash in `state.json`.

**Step 3 — Re-run the Critic diff-scoped, not full.**

For each artifact in the stale set, route to the **Critic in the matching mode**, passing only the
diff of the upstream summary (not the full upstream artifact) as the change context:

```
th revise status <mode> --json     # check the cap before re-running
```

The Critic reviews only whether the downstream artifact is coherent against the *changed portion*
of the upstream summary — not a full re-review from scratch. This keeps re-verification
proportionate to the actual change.

**Step 4 — Escalate genuine conflicts.**

If the Critic finds a grounded defect — a real incoherence introduced by the upstream change —
escalate per the normal producer→Critic loop (cap + human escalation at cap). If there is no
genuine conflict (the downstream artifact is unaffected by the diff), the Critic returns PASS and
the stale flag is cleared.

**What cascade re-verification is not.** It does not re-run all Critic modes from scratch. It does
not touch artifacts outside the diff-scoped stale set. It does not substitute for the human
correctness gate on the verification report.

---

### Downstream stages — complete tier pipeline

After Architecture, the engaged stages that follow depend on the chosen tier. All stage sequences
below are defined by spec §5/§13; the numbered stages match the full pipeline table (§13).

---

#### Stage 5 — Architecture Decision Records (T3 only) → `docs/05-adrs/`

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

#### Stage 6 — Detailed Technical Design (T3 only) → `06-technical-design.md`

Skip this stage for T1 and T2. For T3, delegate to the **Spec agent in `technical-design` mode**
with the `templates/06-technical-design.md` skeleton (§15.6).

The agent specifies internal behavior the architecture left abstract: workflows, algorithms, state
machines, error handling, concurrency, retries, idempotency. It stops where code is clearer than
prose. Streams; asks the human only where a behavior choice is product-meaningful.

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

#### Stage 7 — Contracts (T2, T3) → `07-contracts.md`

Skip this stage for T1. For T2 and T3, delegate to the **Spec agent in `contracts` mode** with
the `templates/07-contracts.md` skeleton (§15.7).

**Summaries handoff (§9).** The Spec agent reads Summary blocks of `docs/01-requirements.md`,
`docs/04-architecture.md`, `docs/03-domain-model.md` (T2/T3), and (for T3)
`docs/06-technical-design.md`. Full artifacts fetched only on demand.

The agent derives contracts from architecture + domain model: each interface's
inputs/outputs/errors, typed and constrained schemas, event shapes, versioning expectations,
anchored to REQ-IDs and slices. Streams; surfaces product-affecting choices to the human.

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

#### Stage S — Security & Threat Modeling (T3 / any blast-radius project) → `08a-security-threat-model.md`

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

**Human gate on the security model and every auth decision (§8, §15.S — blast-radius).**
Surface the completed security model to the human via **AskUserQuestion** before proceeding.
Any auth decision (authentication flows, authorization model, trust boundaries) is blast-radius
and must have explicit human approval. Do not stream past auth without a gate.

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

#### Stage F — Failure Modes & Edge Cases (T3 / reliability-critical) → `08b-failure-edge-cases.md`

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

#### Stage 8 — Test Strategy (T2, T3) → `08-test-strategy.md`

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

---

#### Tier pipeline summary (§5/§13)

| Tier | Stage sequence |
|------|---------------|
| **T1** | Requirements → Scope → Architecture (light, folded Security + Failure Modes) → [UI Design if UI present] → Slice Plan → Code → Documentation (readme) → Verify |
| **T2** | Requirements → Scope → Domain Model → Architecture (folded Security + Failure Modes) → [UI Design if UI present] → Contracts → Test Strategy → Slice Plan → Code → Documentation (readme + user-guide + api-reference) → Verify |
| **T3** | Requirements → Scope → Domain Model → Architecture → [UI Design if UI present] → ADRs → Detailed Technical Design → Contracts → **Security** (graduated, §15.S) → **Failure Modes** (graduated, §15.F) → Test Strategy → Slice Plan → Code → Documentation (full suite) → Final Verification + traceability view |

The Vertical Slicing stage (Stage 9) follows the full pre-build pipeline in every engaged tier.
Stage 10 (implementation) and Stage 11 (final verification) are described above in §8–10.

---

## Agents you route to

- **Spec** (`agents/spec.md`) — modal artifact producer. All modes implemented: `requirements`,
  `scope`, `domain-model`, `architecture`, `adr`, `technical-design`, `contracts`, `test-strategy`,
  `security`, `failure-modes`.
- **Critic** (`agents/critic.md`) — modal coherence reviewer (fresh context). All modes
  implemented: `requirements`, `scope`, `domain-model`, `architecture`, `adr`, `technical-design`,
  `contracts`, `test-strategy`, `security`, `failure-modes`, `slice`, `code-review`,
  `final-verification`, `documentation`, `ui-design`.
- **Vertical Slice** (`agents/vertical-slice.md`) — fresh-context slice decomposition (Stage 9).
- **Builder** (`agents/builder.md`) — write code + tests, run checks, drift write-back (Stage 10).
- **UI Designer** (`agents/ui-designer.md`) — user-centered UI design in fresh context (Stage 4b, conditional on project having a UI).
- **Doc-Writer** (`agents/doc-writer.md`) — tier-scaled documentation generation from contracts and implementation (Stage 10.5).
- **Orchestrator** (`agents/orchestrator.md`) — your own playbook for tiering, routing, gates, state.

## Model & effort routing (automatic)

The Orchestrator selects the model for each agent spawn. The frontmatter `model:` value is the
default; escalate to opus when the situation matches an escalation row below. Pass a model
override in the delegation prompt when escalating; otherwise the frontmatter default applies.

| Situation | Model |
|---|---|
| Default (all agents) | frontmatter default (sonnet; opus for orchestrator & vertical-slice) |
| Spec in `architecture`, `security`, `failure-modes`, or `technical-design` mode on a T3 or blast-radius project | opus |
| Critic in `slice` or `code-review` mode on a blast-radius project | opus |
| Builder on a slice touching a blast-radius component | opus |
| Trivial mechanical summarization (e.g. drift-log recap) | haiku |

**Rationale:** effort scales with tier and blast radius, like every other TwinHarness control.
Cheap by default, expensive where wrong answers are expensive.

## Resume

If `.twinharness/state.json` already exists, read it (`th state status`) and re-enter at
`current_stage` instead of starting over (spec §18 idempotent resume).
