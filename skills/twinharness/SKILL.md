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

## Running `th` — MCP tools first, CLI as fallback

TwinHarness exposes its coordination / observability / state handlers as **typed MCP tools**
named `mcp__plugin_twinharness_th__*`. **Prefer those tools** for every such operation — they
return structured results and resolve the project root automatically (worktree-safe), so they are
the **primary** path. See `${CLAUDE_PLUGIN_ROOT}/skills/twinharness/reference/mcp-tools.md` for the
routing rule, the why, and a non-exhaustive snapshot of the current tools.

**Fallback — the `th` CLI.** The CLI ships inside this plugin (zero runtime dependencies, Node ≥
18) and covers verbs not exposed as MCP tools. Wherever this playbook — or any TwinHarness agent or
command — says `th <args>` and no matching MCP tool exists, run:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>
```

Pass that exact invocation on to every agent you spawn (they receive the same substitution, but
restate it in your delegation prompt so there is no ambiguity). A globally linked `th` (dev
`npm link` setups) also works, but prefer the plugin's own copy.

**A returned error result is NOT a broken tool.** When an MCP tool *returns* a structured error —
`not_initialized` (no `state.json` yet), `map_missing`, `slice_not_found` — it **worked**: it reported
a fact (the MCP result carries `isError: true` only because the underlying command exited non-zero).
**Keep using the MCP tools.** Switch to the CLI only when the verb has no MCP tool (the fallback list
above) or the server is genuinely unreachable (tools not advertised / a transport-level error — not a
domain result). A `not_initialized` is your cue to `th init` (CLI — it has no MCP tool), then **resume
the MCP tools**; it is never a reason to abandon them.

## Mechanical truths are CODE, not prose (critical)

Instructions do not enforce themselves (spec §11). All **mechanical** operations go through the `th`
CLI — never hand-edit `state.json`, never eyeball traceability, never "remember" a hash:

| Need | Command |
|---|---|
| Scaffold a project | `th init` |
| Read/patch/validate state | `th state get\|set\|status\|verify` |
| Emit a stop-gate decision | `th hook stop-gate` |

The state, drift, build-lease, route, decision, repo, context, and delegate verbs below have typed
`mcp__plugin_twinharness_th__*` equivalents — invoke them via those MCP tools per
`reference/mcp-tools.md`; use the CLI form only for verbs without an MCP tool.

> Also available (all implemented): `th artifact register|list` (accepts a directory, e.g. `docs/05-adrs/`),
> `th anchors scan`, `th trace render`, `th coverage check|report`, `th verify add|list|clear|run`,
> `th drift add|list|resolve`, `th stale --artifact`, `th tier classify`, `th tier veto-check`,
> `th build plan|next-wave|claim|release|leases`, `th debug pack|log`, `th revise bump|status|reset`,
> `th slices sync`, `th slice set-status`, `th doctor`, `th next`, `th context estimate|pack`,
> `th delegate plan|pack|capsule|check`, `th stage current|describe|list`, `th manifest export`, `th version`.
>
> **`th next`** is the mechanical next-action oracle: when unsure what the run owes next (or after a
> long context window), run it for the single highest-priority obligation. It computes; you still decide.
>
> **On-demand agents** (you invoke when the situation calls for it, like the Critic): the **Researcher**
> (`agents/researcher.md`) — conditional, only when a project needs unfamiliar external knowledge; emits
> source-cited `docs/00-research/`. The **Debugger** (`agents/debugger.md`) — fresh-context, evidence-first,
> on a failing suite or grounded defect; starts from `th debug pack`, records via `th debug log`. The
> **Codebase-Inspector** (`agents/codebase-inspector.md`) — fresh-context, on a **brownfield** run; maps
> the existing repo and emits source-anchored `docs/00-existing-codebase-analysis.md`. During
> the build, dispatch parallel Builders with `th build next-wave` and guard collisions with `th build claim`.

Run `th` with `--json` whenever you need to parse the result. The CLI **records and computes; it
never decides** which stage/agent/tier runs — those are your calls.

## Orchestration flow overview

The full per-stage playbook lives in the reference files below. Read them on demand when you enter
each stage. This section is the compact routing guide.

**Full per-stage design-stage playbook:** read `${CLAUDE_PLUGIN_ROOT}/skills/twinharness/reference/pipeline-stages.md` when you reach any design stage (Scope through Test Strategy, including UI Design, Slicing).

**Full build, documentation, and verification playbook:** read `${CLAUDE_PLUGIN_ROOT}/skills/twinharness/reference/build-and-verify.md` when you enter Stage 10 (implementation), Stage 10.5 (docs), Stage 11 (final verification), or need cascade re-verification (§18).

### 1. Init

Run `th init` in the project root (creates `docs/`, `.twinharness/state.json`, `drift-log.md`).
**When this skill (or `/twinharness:th-run`) is invoked and no `.twinharness/state.json` exists, run
`th init` YOURSELF and proceed through the flow — never stop to ask the user to initialize.** ("No
state" / "not initialized" — whether from the pre-prompt snapshot, `th state status`, or a
`th_state_get` / `th_next` MCP result — is the cue to START a run, not an error to report back.)

**Greenfield vs. brownfield — an explicit decision at init.** Before scaffolding, decide whether
this is a greenfield run (a fresh project) or a brownfield run (building INTO an existing repo) and
pick the matching init: plain `th init` for greenfield, `th init --brownfield` (stamps
`project_mode: "brownfield"`) for brownfield. On a brownfield run you **MUST invoke the
Codebase-Inspector before tiering** — mapping the existing language, modules, public APIs, test
framework, and any existing blast-radius surfaces (auth/authz/money/data-integrity/migrations) is a
prerequisite for `th tier classify` / `th tier veto-check`, not an optional nicety. Brownfield
shifts three things: Slice 0 becomes a characterization test around the
adoption seam (not a fresh walking skeleton), the architecture is an overlay on existing components
(what's new vs. reused), and the Builder reuses existing code that already satisfies a REQ rather
than reimplementing it. Existing auth/money/migrations in touched code are §5 blast-radius. See the
*Brownfield adaptations* notes in
`${CLAUDE_PLUGIN_ROOT}/skills/twinharness/reference/pipeline-stages.md` and
`${CLAUDE_PLUGIN_ROOT}/skills/twinharness/reference/build-and-verify.md`.

### 1.5. Interview gate (`--interview`)

When `/twinharness:th-run` is invoked with **`--interview`**, run a full **confidence-scored Socratic
loop** immediately **after `th init`** and **before** tier classification. This **replaces the §14.1
vague-narrow step** for that run (without `--interview`, the lightweight §14.1 narrowing still applies).

The deterministic `th` layer cannot call an LLM, so **the Orchestrator (you) performs the scoring**;
the `th_interview_*` MCP tools only persist state (store-only, under `.twinharness/interview.json`):

- `th_interview_start { idea, cutoff? }` → creates `.twinharness/interview.json`. Resolve the
  cutoff as `--cutoff` flag → state field `interview_cutoff` → **0.80** default.
- Each round: ask one sharp clarifying question, **score it yourself**, then
  `th_interview_record { question, answer, scores{goal,constraints,criteria}, confidence, entities[] }`
  (pass `scores`/`entities` as JSON-encoded strings). **Show the confidence score each round.**
- `th_interview_status {}` → `{ rounds, confidence, cutoff, ready }`. Stop when `ready`
  (confidence ≥ cutoff).
- **Early-exit** allowed from **round 3** with a recorded warning; **hard cap 20 rounds**.
- Then proceed to tiering + requirements, **seeding from `.twinharness/interview.json`**.

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

**Build-phase gate (§8-style human gate — always, immediately before implementation).** After the
design stages are coherence-gated and the slice plan is approved, and **before the first Builder
writes any code**, surface an `AskUserQuestion` with two choices:

- **"begin now"** → continue building in this same session.
- **"begin in a fresh Claude Code session"** → **pause** and print the EXACT `/twinharness:th-run`
  resume command (carrying the project context so the new conversation re-enters at `current_stage`),
  then **STOP**. "Fresh session" = a **new Claude Code conversation**, never a detached/tmux/background
  process.

This gate is a human gate exactly like the other §8 gates: it **never** calls `th_state_set
implementation_allowed` and never flips any gate-owned field — it only decides *where* the build
begins (this session vs. a fresh one), not *whether* the prerequisite gate is satisfied. The
prerequisite gate below and the Stop-gate hook own `implementation_allowed`.

Prerequisite gate: `th state verify` exits zero; `drift_open_blocking` = 0; approved slice plan;
`implementation_allowed: true`. Build slice-by-slice, task-by-task; Critic code-review loop after
each slice; bidirectional drift loop throughout; parallel waves via `th slices sync` + `th build plan`.

**Full detail:** read `${CLAUDE_PLUGIN_ROOT}/skills/twinharness/reference/build-and-verify.md`.

### 10.5. Documentation-Phase Gate & 11. Final Verification

After all slices pass the code-review Critic loop, present a **repeatable menu** (human gate via
`AskUserQuestion`) before advancing to Final Verification:

- **[1] Write documentation** — delegate to the Doc-Writer agent (tier-appropriate modes), run
  the per-mode Critic loops, advance `current_stage documentation`, then return to the menu.
- **[2] Run qa-tester** — delegate to the Tester agent (`agents/tester.md`) for a live QA pass
  against the built project, receive the Delegation Capsule, then return to the menu.
- **[3] Skip → Final Verification** — advance to Stage 11 immediately.

Documentation is **never generated automatically** — it is produced only when the user picks
**[1]**. Options **[1]** and **[2]** loop back to the menu; only **[3]** advances. Final
Verification: `th trace render` + `th coverage check` + verification report + Critic
`final-verification` mode (T2/T3) + human correctness gate. Cascade re-verification (§18)
covers upstream artifact changes.

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
- **UX/UI Designer** (`agents/ux-ui-designer.md`) — user-centered design in fresh context: Stage 4a UX (research/journeys/IA/flows → `docs/04a-ux-design.md`) then Stage 4b UI (visual/wireframes → `docs/04b-ui-design.md`), conditional on project having a UI.
- **Doc-Writer** (`agents/doc-writer.md`) — tier-scaled documentation generation from contracts and implementation (Stage 10.5).
- **Codebase-Inspector** (`agents/codebase-inspector.md`) — fresh-context existing-codebase mapper on a brownfield run; emits source-anchored `docs/00-existing-codebase-analysis.md` (on-demand, like the Researcher/Debugger).
- **Tester** (`agents/tester.md`) — **broad-QA, on-demand** (not a fixed SDLC stage): launches and drives the *real* built project (CLI/TUI/service/web) to find defects. Selects a driver per project type (direct process/stdio capture; `claude-in-chrome` for web; tmux optional — never required), routes its model by tier/blast (sonnet floor → opus), and routes findings to `th drift add` / the blackboard. No Agent spawn. Invoke directly or via `/twinharness:th-test`.
- **Orchestrator** (`agents/orchestrator.md`) — your own playbook for tiering, routing, gates, state.

## Delegating high-context work (`th delegate`)

The main context window is a scarce control-plane resource: you coordinate, child agents consume
detail. Before doing heavy work directly (broad reads, code edits, debugging, long reviews, repo
inspection, log/impact analysis), ask whether it will bloat the main context — and if so, delegate:

1. `th delegate plan --intent <read|write|debug|review|artifact|repo-analysis> [--files N] [--writes] [--noisy] [--slice <ID>]`
   → a `delegate` / `keep-main` recommendation, a suggested agent, and whether a capsule is required (advisory).
2. `th delegate pack --agent <agent> [--slice <ID>] [--intent <i>]` → a **bounded** child handoff
   (reuses `th context pack` for a slice). Spawn the agent with it.
3. Require a **Delegation Capsule** back; validate with `th delegate check --capsule <path>`
   (`th delegate capsule` prints the blank skeleton). Keep only the capsule in the main context;
   long-form detail lives in durable files under `.twinharness/delegations/DEL-###/`.

Keep small queries, tiny reads, one-line updates, short commands, approval moments, and `th next`
checks in the main context — delegation is for the high-context work, not every action.

## Model & effort routing (mechanical)

The routing table is CODE, not prose (spec §2). Before each agent spawn, ask the CLI for the
recommended model and effort, then pass them into the delegation prompt:

```
th route --agent <agent> --mode <stage/mode> [--component-blast] --json
```

It returns `{model, effort, rationale}` computed from the agent, its mode, the tier, and the
blast-radius flags (sourced from state). It is **advisory** — it computes; you apply the override at
spawn (the §3 boundary, exactly like `th tier classify`). If `th route` is unavailable, fall back to
the frontmatter `model:` default. Rationale: effort scales with tier and blast radius — cheap by
default, expensive where wrong answers are expensive.

## Resume

If `.twinharness/state.json` already exists, read it (`th state status`) and re-enter at
`current_stage` instead of starting over (spec §18 idempotent resume).
