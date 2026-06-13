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

> Also available (all implemented): `th artifact register|list` (accepts a directory, e.g. `docs/05-adrs/`),
> `th anchors scan`, `th trace render`, `th coverage check|report`, `th verify add|list|clear|run`,
> `th drift add|list|resolve`, `th stale --artifact`, `th tier classify`, `th tier veto-check`,
> `th build plan`, `th revise bump|status|reset`, `th slices sync`, `th slice set-status`,
> `th doctor`, `th next`, `th context estimate|pack`, `th stage current|describe|list`,
> `th manifest export`, `th version`.
>
> **`th next`** is the mechanical next-action oracle: when unsure what the run owes next (or after a
> long context window), run it for the single highest-priority obligation. It computes; you still decide.

Run `th` with `--json` whenever you need to parse the result. The CLI **records and computes; it
never decides** which stage/agent/tier runs — those are your calls.

## Orchestration flow overview

The full per-stage playbook lives in the reference files below. Read them on demand when you enter
each stage. This section is the compact routing guide.

**Full per-stage design-stage playbook:** read `${CLAUDE_PLUGIN_ROOT}/skills/twinharness/reference/pipeline-stages.md` when you reach any design stage (Scope through Test Strategy, including UI Design, Slicing).

**Full build, documentation, and verification playbook:** read `${CLAUDE_PLUGIN_ROOT}/skills/twinharness/reference/build-and-verify.md` when you enter Stage 10 (implementation), Stage 10.5 (docs), Stage 11 (final verification), or need cascade re-verification (§18).

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

### 4–9. Engaged-tier design stages (T1/T2/T3)

Stages proceed in tier-appropriate order (see tier pipeline table below). For each stage:

- Delegate to the Spec agent (or UI Designer / Vertical Slice agent as appropriate) in the
  relevant mode with the corresponding template.
- Run the **producer→Critic loop**: check `th revise status <mode> --json` before each critique;
  bump with `th revise bump <mode>` on FAIL; escalate at cap. Zero issues is a valid terminal state.
- Register artifacts and advance state after Critic PASS (and human gate where required).

**Per-stage detail:** see `${CLAUDE_PLUGIN_ROOT}/skills/twinharness/reference/pipeline-stages.md`
for the full numbered walkthroughs of Scope, Domain Model, Architecture, UI Design (Stage 7b),
ADRs (T3), Technical Design (T3), Contracts, Security (T3/blast-radius), Failure Modes
(T3/reliability-critical), Test Strategy, and Vertical Slicing (Stage 9).

### 10. Stage 10 — Software Implementation

Prerequisite gate: `th state verify` exits zero; `drift_open_blocking` = 0; approved slice plan;
`implementation_allowed: true`. Build slice-by-slice, task-by-task; Critic code-review loop after
each slice; bidirectional drift loop throughout; parallel waves via `th slices sync` + `th build plan`.

**Full detail:** read `${CLAUDE_PLUGIN_ROOT}/skills/twinharness/reference/build-and-verify.md`.

### 10.5. Documentation & 11. Final Verification

Documentation (Doc-Writer agent, tier-appropriate modes) runs after all slices pass code-review
Critic and before Final Verification. Final Verification: `th trace render` + `th coverage check`
+ verification report + Critic `final-verification` mode (T2/T3) + human correctness gate.
Cascade re-verification (§18) covers upstream artifact changes.

**Full detail:** read `${CLAUDE_PLUGIN_ROOT}/skills/twinharness/reference/build-and-verify.md`.

---

## Tier pipeline summary (§5/§13)

| Tier | Stage sequence |
|------|---------------|
| **T1** | Requirements → Scope → Architecture (light, folded Security + Failure Modes) → [UI Design if UI present] → Slice Plan → Code → Documentation (readme) → Verify |
| **T2** | Requirements → Scope → Domain Model → Architecture (folded Security + Failure Modes) → [UI Design if UI present] → Contracts → Test Strategy → Slice Plan → Code → Documentation (readme + user-guide + api-reference) → Verify |
| **T3** | Requirements → Scope → Domain Model → Architecture → [UI Design if UI present] → ADRs → Detailed Technical Design → Contracts → **Security** (graduated, §15.S) → **Failure Modes** (graduated, §15.F) → Test Strategy → Slice Plan → Code → Documentation (full suite) → Final Verification + traceability view |

The Vertical Slicing stage (Stage 9) follows the full pre-build pipeline in every engaged tier.
Stage 10 (implementation) and Stage 11 (final verification) are described in the reference file.

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
