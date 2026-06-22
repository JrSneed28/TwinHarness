# TwinHarness Usage Guide

From first install to advanced CLI surgery. **New here? Read [Key concepts in 60 seconds](#key-concepts-in-60-seconds)
first**, then Part 1 — you can drive a full run knowing nothing past Part 1.

This guide is organized so you can stop reading as soon as you have what you need:

- [Key concepts in 60 seconds](#key-concepts-in-60-seconds) — the vocabulary, defined plainly (start here)
1. [Getting started](#part-1--getting-started) — install, first run, **driving it inside Claude Code** (beginner → advanced), what you'll be asked
2. [Understanding a run](#part-2--understanding-a-run) — tiers, stages, the Critic loop, drift, gates
3. [The `th` CLI](#part-3--the-th-cli-advanced) — full command reference, state schema, exit codes
4. [Customization & development](#part-4--customization--development) — templates, dev workflow, troubleshooting

> **Reading paths.** *Just want to use it?* Key concepts → Part 1, and stop. *Want to understand
> what it's doing while it runs?* Add Part 2. *Scripting, CI, or debugging the harness itself?*
> Part 3 and Part 4.

---

## What is TwinHarness?

TwinHarness turns a vague software idea ("build me a habit tracker") into working, tested code by
driving it through a **tier-scaled SDLC pipeline**: requirements → scope → design stages → a
vertical-slice implementation plan → slice-by-slice build → documentation → final verification.

Three things make it different from "just asking an agent to build it":

- **Artifacts govern; they don't decorate.** Every stage produces a document (requirements, scope,
  architecture, …) that downstream stages are mechanically checked against. When reality diverges
  during the build, the documents are updated — in both directions.
- **The process scales with risk, not ceremony.** A trivial change bypasses everything ("Tier 0:
  this is too small for the full process — I'll just build it"). A project touching auth, money, or
  migrations gets the strictest treatment, and that floor is enforced by code, not by promises.
- **Mechanical truths are code.** State, hashing, traceability, coverage, drift counts, and the
  completion gate live in a deterministic CLI (`th`) with a test suite — not in prompt text the
  model could "forget."

The one governing rule that resolves every judgment call:

> The irreversible, taste-driven, high-blast-radius layer — requirements, scope, and anything
> touching security, money, data integrity, or migrations — gets **human gates**.
> **Everything else flows.**

---

## Key concepts in 60 seconds

You don't need to memorize these — but every section below assumes them. Skim once; refer back as needed.

| Term | What it means |
|---|---|
| **Run** | One pass of TwinHarness over one idea, in one project directory. All its state lives in `.twinharness/` and `docs/`. |
| **Orchestrator** | The lead agent (a Claude Code *skill*) that drives the whole run — it picks stages, spawns the other agents, and calls the `th` CLI. You mostly talk to it. |
| **Agent** | A specialized, fresh-context sub-Claude with one job (Spec writes requirements, Builder writes code, Critic reviews, etc.). There are **16**. You don't invoke them directly; the Orchestrator does. |
| **`th` CLI** | A deterministic TypeScript command-line tool bundled with the plugin. It **records and computes** the mechanical truth (state, hashes, coverage, drift counts) — it never *decides* anything. The agents run it for you. |
| **Artifact** | A governing document a stage produces (`docs/01-requirements.md`, `docs/04-architecture.md`, …). Artifacts **govern** downstream work — they're checked against, not just written and forgotten. |
| **Summary block** | The compact header at the top of every artifact. Downstream agents read the Summary, not the whole doc — that's what keeps context small. |
| **REQ-ID** | A stable label for one requirement (`REQ-001`, `REQ-NFR-002`). Everything downstream — slices, tests, code — **anchors** back to a REQ-ID, which makes traceability and coverage computable. |
| **Tier (T0–T3)** | How much process the project gets, sized to its complexity. **T0** = trivial, skip everything and just build. **T3** = large/critical, every stage and gate. |
| **Blast radius** | Five high-risk flags — `authentication`, `authorization`, `data-integrity`, `money`, `migrations`. Any one of them sets a **floor**: the project can never be Tier 0, no matter how small. Enforced by code (`th tier veto-check`). |
| **Slice** | A thin, end-to-end, demonstrable capability (not a layer). The build proceeds slice-by-slice. **Slice 0** is the *walking skeleton* — the thinnest path that touches every architectural boundary. |
| **Wave** | A batch of slices safe to build in parallel because their components don't overlap. `th build plan` computes the waves. |
| **Gate** | A checkpoint. A **human gate** stops and asks *you* (requirements, scope, auth, irreversible architecture, blocking drift, final sign-off). Everything else **streams** past with only an automated check. |
| **Critic loop** | After any agent drafts something, a **fresh-context Critic** reviews it (capped at 3 rounds). Fresh context on purpose — so the author's rationalizations aren't in the room. |
| **Drift** | A discovery during the build that contradicts a document. *Derived* drift (design details) auto-applies and is logged. *Requirement* drift (contradicts what you signed off) **stops the build** until you decide. |
| **Coverage gate** | `th coverage check` mechanically blocks the build from starting until every in-scope REQ-ID maps to ≥ 1 slice **and** ≥ 1 test. |
| **Stop-gate** | A Claude Code *Stop hook* that refuses to let the session claim "done" while state is invalid, a blocking drift is open, or final slices/tests aren't finished. It's code, not a reminder. |
| **Write-gate** | A Claude Code *PreToolUse hook* that blocks file writes before the pre-build gates clear, and polices slice boundaries during the build. Fail-open: it never touches non-TwinHarness projects. |
| **MCP tools** | The same `th` read/compute surface exposed as **73** typed `th_*` tools so agents can call it natively over MCP instead of shelling out. |

---

## Part 1 — Getting started

### Install

From a local clone:

```
/plugin marketplace add C:\path\to\TwinHarness
/plugin install twinharness@twinharness
```

(or headless: `claude plugin marketplace add <path>` then
`claude plugin install twinharness@twinharness`). The plugin installs at **user scope** — it is
available in every project. For a throwaway test session instead: `claude --plugin-dir <path>`.

Requirements: **Node ≥ 20** on PATH (declared in `engines.node`; the bundled `th` CLI has zero
runtime dependencies). Claude Code ≥ 1.0.0 (the plugin targets the hook + agent manifest schema v1).

### Your first run

Open Claude Code in the project directory where you want the software built (an empty directory is
fine) and run:

```
/twinharness:th-run build a CLI tool that tracks my reading list
```

What happens next:

1. **Scaffolding.** The Orchestrator runs `th init`, creating three things in your project:
   `docs/` (the artifacts), `.twinharness/state.json` (machine-readable run state — never edit it
   by hand), and `drift-log.md` (the build's discovery journal).

   > **Migration note:** If your project has a `.agentic-sdlc/state.json` from a prior run,
   > it keeps working automatically — TwinHarness prefers `.twinharness/` but falls back to
   > `.agentic-sdlc/` when the new directory does not exist. To migrate, rename the folder:
   > `mv .agentic-sdlc .twinharness`.

2. **Requirements.** A Spec agent drafts `docs/01-requirements.md` first, then asks you **only the
   questions that matter** — it will not interrogate you field by field. Each requirement gets a
   REQ-ID (`REQ-001`, `REQ-002`, …) that everything downstream anchors to.
3. **Your first gate.** A fresh-context Critic reviews the draft; once it passes, you get an
   explicit approve/revise question. Requirements and scope are *sticky* — once you sign off, only
   you can change them.
4. **Tier classification.** The Orchestrator sizes the project (Tier 0–3, see Part 2) and tells you
   which stages will run. Small idea → few stages. Risky idea → more stages and more gates.
5. **Design stages stream.** Most stages (domain model, architecture, …) do not block on you. You
   can interrupt at any time, but you'll only be *asked* about genuinely irreversible choices
   (e.g. monolith vs. services) and anything blast-radius (e.g. an auth scheme).
6. **UX then UI design direction** (when your project has a user interface). A fresh-context
   UX/UI-Designer runs two ordered stages after Architecture: **Stage 4a (UX)** — research,
   personas/journeys, information architecture, task flows — then **Stage 4b (UI)** — visual
   direction, screens, wireframes, tokens. Each stage presents 2–3 distinct directions (with ASCII
   mockup previews for UI) and asks you to choose. These are the taste-driven gates: after you pick
   a direction, that stage's detail streams past you. UX is gated and approved first; UI builds on it.
7. **Slice plan, then build.** A fresh-context agent decomposes the design into **vertical slices**
   — each one a thin end-to-end capability you can see working — and Builders implement them
   slice-by-slice, tests included, with a code-review Critic after each slice.
8. **Documentation.** After all slices pass, a Doc-Writer agent generates tier-appropriate docs
   (T1: readme only; T2: readme + user guide + API reference; T3: full suite). A Critic reviews the
   docs; no human gate.
9. **Verification.** A final report separates what the Critic can certify (coherence) from what
   only tests and you can certify (correctness), and you sign off.

### Driving TwinHarness inside Claude Code

How you actually use it day-to-day, from your first run to power use.

**Beginner — let it drive.** You only need one command and the ability to answer a question:

1. `cd` into your project (empty is fine) and open Claude Code.
2. Type `/twinharness:th-run <one sentence about what you want>`.
3. Answer the gates when it asks. It will *only* stop you for the decisions that are genuinely
   yours (requirements, scope, an irreversible architecture choice, a UI direction, auth, final
   sign-off). Everything else streams past — you can just watch.
4. When it says it's done, it has already passed its own stop-gate (state valid, no blocking drift,
   slices built, tests green where configured). You give the final correctness sign-off.

You don't have to type any `th` commands or invoke any agent — the Orchestrator does all of that.
You can also just **ask in prose** ("build me X, spec-driven, with tests") and Claude will invoke
the `twinharness` skill automatically.

**Intermediate — watch and steer mid-run.** While a run is in progress (or between sessions):

| You want to… | Do this |
|---|---|
| See where the run is | `/twinharness:th-status` — tier, current stage, gates, slices, open drift |
| Review what changed during the build | `/twinharness:th-drift` — skim auto-applied doc updates, decide any blocked escalations |
| See what's waiting on *you* | `/twinharness:th-escalate` — everything currently blocked on a human decision |
| Resume after closing the session | `/twinharness:th-run` again — it reads `state.json` and picks up where it left off; it never starts over |
| Interrupt | Just type. You can interrupt any streaming stage at any time; you don't need a command. |

**Advanced — drive the mechanism directly.** Power users (and CI) can call the `th` CLI and the
inspection commands themselves:

- **Inspect a run without the full CLI path** via the verb-wrapper slash commands:
  `/twinharness:th-next` (what does the run owe next?), `/twinharness:th-doctor` (full health audit),
  `/twinharness:th-scorecard` (one-screen summary), `/twinharness:th-coverage`, `/twinharness:th-stage`,
  `/twinharness:th-tier`, `/twinharness:th-verify`, `/twinharness:th-repo`, `/twinharness:th-route`,
  `/twinharness:th-test`, `/twinharness:th-init`, and `/twinharness:th-decision-approve` (the human-only
  decision gate).
- **Run `th` straight** for scripting/debugging: `node <plugin-or-clone>/dist/cli.js <command>` — the
  full surface is in [Part 3](#part-3--the-th-cli-advanced).
- **Let agents call it over MCP:** the 62 `th_*` MCP tools expose the same read/compute surface to
  sub-agents natively (no shelling out).
- **Wire the exit-code gates into CI** so a drifted artifact/test contract fails the build — see
  [Using `th` in CI](#using-th-in-ci).

### The 16 slash commands

Four commands drive a run; twelve are thin wrappers over the most-used `th` verbs so you can inspect
a run without typing the full CLI path.

**Run commands (the four you'll actually use):**

| Invocation | When to use it |
|---|---|
| `/twinharness:th-run [--interview] [--cutoff <0..1>] [--max-tokens <k>] <idea>` | Start a new run — or resume an interrupted one (it picks up from `state.json`) |
| `/twinharness:th-status` | Where am I? Tier, current stage, gates, slices, open drift |
| `/twinharness:th-drift` | Review the drift log: skim auto-applied doc updates, decide blocked escalations |
| `/twinharness:th-escalate` | Show everything currently waiting on a *human* decision |

**Verb wrappers (inspection & one-off `th` calls):**

| Invocation | Wraps |
|---|---|
| `/twinharness:th-init` | `th init` — scaffold a run (rarely needed by hand; `th-run` does it) |
| `/twinharness:th-doctor` | `th doctor` — full run-health audit |
| `/twinharness:th-next` | `th next` — the single mechanical obligation the run owes next |
| `/twinharness:th-scorecard` | `th scorecard` — one-screen post-run summary |
| `/twinharness:th-stage` | `th stage` — the current/any stage's contract (produces / Critic mode / gate) |
| `/twinharness:th-verify` | `th verify` — configure & run the project's own test/check commands |
| `/twinharness:th-coverage` | `th coverage` — the planned/implemented/tested/passing breakdown |
| `/twinharness:th-tier` | `th tier` — tier eligibility & blast-radius veto check |
| `/twinharness:th-route` | `th route` — advisory model/effort routing for an agent spawn |
| `/twinharness:th-repo` | `th repo` — the repo-understanding layer (map / relevant / impact / check) |
| `/twinharness:th-test` | `th verify run` — run the configured test suite and record the report |
| `/twinharness:th-decision-approve` | `th decision approve` — the **human-only** decision gate (interactive TTY) |

The `twinharness` skill itself (`/twinharness:twinharness`) is the full Orchestrator playbook;
Claude also invokes it automatically when you ask for spec-driven, stage-gated development in prose.

### `/twinharness:th-run` flags

`th-run` accepts four optional flags before the idea text:

| Flag | Default | Effect |
|---|---|---|
| `--interview` | off | Run a full confidence-scored Socratic loop after `th init` and before tier classification. **Replaces** the lightweight vague-narrowing step for this run. |
| `--no-interview` | *(default)* | Skip the scored loop; if the brief is vague, lightweight narrowing still applies. |
| `--cutoff <0..1>` | `0.80` | Interview gate cutoff. Precedence: `--cutoff` flag → `state.json` field `interview_cutoff` → 0.80 default. |
| `--max-tokens <k>` | tier default | Per-session context budget in thousands. Passed through to `th init`; see `th init --max-tokens` and the **Context budget** section in Part 3 for full detail. |

#### Interview gate (`--interview`)

When `--interview` is passed, the Orchestrator runs a **confidence-scored Socratic loop** immediately after `th init` and before tier classification. This replaces the lightweight §14.1 vague-narrowing for that run.

- The Orchestrator calls `th_interview_start` to create `.twinharness/interview.json`. The cutoff resolves as: `--cutoff` flag → `state.json` field `interview_cutoff` → 0.80 default.
- Each round: the Orchestrator asks you **one sharp clarifying question**, then **scores it itself** across three dimensions (goal / constraints / criteria). The deterministic `th` layer cannot call an LLM, so the model supplies the scores. The round is persisted via `th_interview_record`, and **the running confidence score is shown to you each round**.
- After each round, `th_interview_status` returns `{ rounds, confidence, cutoff, ready }`. The loop stops when `ready` (confidence ≥ cutoff).
- **Early exit** is allowed from round 3 onward — you can say "good enough" and the Orchestrator records a warning round and proceeds. **Hard cap: 20 rounds** — the loop stops and proceeds even if `ready` is not reached.
- On completion, the loop seeds both tier classification and the requirements stage from `.twinharness/interview.json` (the captured idea, rounds, and brief).

Without `--interview`, if the brief is a vague mega-request, the lightweight §14.1 narrowing still applies.

#### Examples

```
# Start a run with the scored interview loop (default 0.80 cutoff)
/twinharness:th-run --interview build a budgeting CLI

# Require higher confidence before tiering
/twinharness:th-run --interview --cutoff 0.9 build a multi-tenant SaaS billing service

# Set a context budget without the interview (no-interview is the default)
/twinharness:th-run --max-tokens 150 build a CLI tool that tracks my reading list
```

### What you will be asked (and what you won't)

You **will** be gated on: requirements sign-off, scope sign-off, the 1–2 genuinely irreversible
architecture choices, UX design direction and UI design direction (when your project has a UI), any
authentication/authorization decision, the security model (when one is produced), data-loss
tradeoffs, blocking drift resolutions, and final correctness sign-off.

You will **not** be gated on: domain models, ADRs, technical design, contracts (minus auth),
test strategy, the slice plan, each slice's code, or documentation — those stream past you with a
Critic check instead. Interrupt whenever you like; approval is not required.

---

## Part 2 — Understanding a run

### Tiers and blast radius

The Orchestrator classifies every project on two independent axes — **complexity** picks the tier,
**blast radius** sets a floor under it. Blast radius can pull a project *up* a tier; it never pushes
a risky project *down*.

**Tier 0 — bypass.** ALL five must hold: single file / tightly local; no public
interface/schema/contract change; no new dependency; obvious testable answer; **no blast-radius
flag**. Result: no documents, no stages — it just gets built. Any miss → Tier 1 minimum.

**The blast-radius veto (the floor).** Five flags — `authentication`, `authorization`,
`data-integrity`, `money`, `migrations` — can never be Tier 0, no matter how small the change. This
is enforced twice mechanically: `th tier veto-check` exits non-zero when a flag is present, and the
state schema itself refuses `tier = T0` while any flag is recorded.

**Stage pipelines per tier:**

| Tier | Pipeline |
|------|----------|
| **T1** — simple | Requirements → Scope → Architecture (light; Security + Failure-Modes folded in) → [UX Design 4a + UI Design 4b if UI] → Slice Plan → Code → Documentation (readme) → Verify |
| **T2** — medium | Requirements → Scope → Domain Model → Architecture (folded sections) → [UX Design 4a + UI Design 4b if UI] → Contracts → Test Strategy → Slice Plan → Code → Documentation (readme + user-guide + api-reference) → Verify |
| **T3** — large/critical | Requirements → Scope → Domain Model → Architecture → [UX Design 4a + UI Design 4b if UI] → ADRs → Technical Design → Contracts → **Security** (standalone) → **Failure Modes** (standalone) → Test Strategy → Slice Plan → Code → Documentation (full suite) → Final Verification |

### Stages 4a & 4b — UX and UI Design (conditional)

For any project with a web UI, mobile UI, desktop UI, or rich TUI, one fresh-context **UX/UI-Designer**
agent runs two ordered stages after Architecture is approved. Fresh context is deliberate — it keeps
the architecture stage's component/data-flow thinking from contaminating user-centered design.

- **Stage 4a — UX** → `docs/04a-ux-design.md`: who the users are, what they're trying to do, how the
  product is organized, and the task flows that get them there (UX research, personas, journeys,
  information architecture, task flows). Critic reviews in `ux-design` mode.
- **Stage 4b — UI** → `docs/04b-ui-design.md`: the visual/structural realization — screen inventory,
  wireframes, component hierarchy, design tokens, interaction states, responsive breakpoints,
  accessibility. Critic reviews in `ui-design` mode.

The ordering is deliberate: UX defines the problem space; UI realizes it; contracts derive from the
approved user experience, not the reverse. Each stage presents **2–3 distinct directions** via
`AskUserQuestion` (with ASCII mockups for UI). You pick a direction (taste-driven → gated by §2),
**4a is approved first**, then 4b builds on it; after each pick the detail streams without further
gates. CLIs, background services, and pure API libraries skip both stages.

### Stage 10.5 — Documentation

After all build slices pass their Critic loops (but before Final Verification), a Doc-Writer agent
generates documentation appropriate to the tier. The Critic reviews each document in `documentation`
mode. There is no human gate — the Critic gates quality. This stage runs at documented-reality
(post-drift): the docs describe what was actually built, not the original plan.

### Model & effort routing (automatic)

The Orchestrator selects the model for each agent spawn. Frontmatter defaults apply unless an
escalation row matches — pass a model override in the delegation prompt when escalating.

| Situation | Model |
|---|---|
| Default (all agents) | frontmatter default (sonnet; opus for orchestrator, vertical-slice & ux-ui-designer) |
| Spec in `architecture`, `security`, `failure-modes`, or `technical-design` mode on a T3 or blast-radius project | opus |
| Critic in `slice` or `code-review` mode on a blast-radius project | opus |
| Builder on a slice touching a blast-radius component | opus |
| Trivial mechanical summarization (e.g. drift-log recap) | haiku |

**Rationale:** effort scales with tier and blast radius. Cheap by default; expensive where wrong
answers are expensive.

### Artifacts, Summary blocks, and REQ-IDs

Every stage writes one artifact into `docs/` from a skeleton in the plugin's `templates/`. Each
artifact opens with a compact **Summary block** — that summary, not the full document, is what
downstream agents read (full text is fetched only when a detail can't be resolved from it). This
keeps context small and handoffs clean.

Requirements assign **REQ-IDs**; every downstream entity, component, contract, slice, test, and
code file anchors back to them. Anchors are what make traceability and coverage *computable* —
`th coverage check` and `th trace render` scan them mechanically.

When an artifact is approved, it is **registered**: `th artifact register` content-hashes the file
and records `{file, version, hash}` in `.twinharness/state.json`. Those hashes are what staleness
detection (§ cascade re-verification, below) works from.

### The Critic loop

After every producer (Spec, UX/UI-Designer, Vertical-Slice, Builder, Doc-Writer) finishes a draft, a
**Critic agent in fresh context** reviews it — fresh context deliberately, so the author's
rationalizations aren't in the room. Rules that keep the loop honest:

- **Critiques must be grounded.** Every defect points at a specific REQ-ID, upstream artifact, or
  concrete incoherence. "Could be clearer" is discarded.
- **Zero issues is a valid terminal state.** There is no minimum-defect quota — a clean PASS ends
  the loop immediately.
- **The loop is capped** (default 3 rounds, tracked by `th revise bump/status`). At the cap, open
  issues escalate to you instead of looping forever.

### The build: vertical slices, waves, and drift

**Slices, not layers.** The implementation plan decomposes the system into vertical slices — each
an end-to-end, user-demonstrable capability with its own acceptance tests. Slice 0 is always the
*walking skeleton*: the thinnest path that exercises every architectural boundary. A coverage gate
(`th coverage check`) mechanically blocks building until every MVP REQ-ID maps to ≥ 1 slice and
≥ 1 test. Coverage scans tests/ **fully recursively** in any language, filtered by the `## MVP
Scope` section of `docs/02-scope.md`.

**Parallel waves.** Before building, `th slices sync` parses the implementation plan into
`state.slices`, then `th build plan` reads `state.slices` and schedules slices into waves: disjoint
component sets build concurrently, overlapping ones serialize. `th build plan` works from the
state data — not the raw plan document. This is computed, not judged. Concurrent `th` mutations
(e.g. two Builders calling `th drift add` simultaneously) are serialized by a cross-process
advisory lock on `.twinharness/.state.lock`, so no update is silently lost.

**Bidirectional drift** is what keeps documents honest during the build:

- **Derived-layer drift** (architecture, design, contracts, slice plan disagree with reality): the
  Builder wires in reality, updates the doc *in the same change*, logs it with
  `th drift add --layer derived --source Builder`, and keeps building. You review these
  asynchronously with `/twinharness:th-drift` — they're for ratifying, not approving.
- **Requirement/scope drift** (reality contradicts what you signed off): the build **stops**. The
  entry increments a blocking counter that the stop-gate reads, and nothing can be declared done
  until you decide. Resolve via `/twinharness:th-drift` → `th drift resolve DRIFT-NNN`.

The source-of-truth rule: **code wins on behavior; requirements win on intent.**

### The stop-gate

A Stop hook runs `th hook stop-gate` whenever Claude tries to end its turn. It blocks the stop —
forcing Claude to keep working or surface the problem — when any of these conditions hold:

1. `.twinharness/state.json` is present but invalid (must be repaired before completion can be claimed).
2. Any blocking requirement-layer drift is open (`drift_open_blocking > 0`).
3. `current_stage` is `final-verification` and any slice's status is not `done` or `blocked` — this catches a claimed-complete run with unbuilt slices. **This check fires only at `final-verification`**; at every earlier stage the gate never tests slice completeness, so legitimate mid-build pauses are never interrupted.
4. `current_stage` is `final-verification`, verify commands are configured, and the last `th verify run` is **missing or red** — a run may not claim completion with a known-red or never-run suite. (Inert when no verify commands are configured; the CLI still doesn't *certify* correctness — tests + your sign-off do.)

Loop protection: the gate blocks **at most once per stop sequence**. If Claude is already
continuing because of a prior block and the gate is *still* unsatisfied, it lets the stop through
with a visible warning instead — because a blocking drift needs *your* decision, and re-blocking
forever would just spin the model. Projects with no `.twinharness/state.json` are never gated; the
hook is inert outside TwinHarness runs.

### The write-gate

A PreToolUse hook runs `th hook pretool-gate` before every `Write`, `Edit`, or `NotebookEdit`
call. A second matcher fires on `Bash` as defense-in-depth (see below). Its job: prevent
implementation files from being written before the gates clear, and police component boundaries
during the build.

**Matcher details:**
- `Write|Edit|NotebookEdit` — the primary matcher. For `NotebookEdit`, the gate reads
  `notebook_path` (not `file_path`) because that is the field NotebookEdit supplies.
  (`MultiEdit` was removed from Claude Code in v2.0 and is no longer listed.)
- `Bash` (Phase A only) — a second, conservative matcher heuristically detects obvious
  shell-mediated writes (`>`, `>>`, `tee`, `dd of=`, `sed -i`) into in-root implementation paths
  during Phase A. It is fail-open: if the command cannot be clearly parsed, the gate allows it
  through. This matcher never fires in Phase B to avoid false-positives. Bash-mediated writes
  remain out of scope as a guarantee — this is defense-in-depth, not a closed gate.

**Phase A — pre-implementation** (`implementation_allowed: false`): any write to a path that is
not a doc or state path fires the gate with the configured semantics. Doc/state paths
(`docs/**`, `.twinharness/**`, `.claude/**`, `drift-log.md`, root `*.md`, `.gitignore`) are
always allowed regardless of phase — spec writers, Critic, and doc-writers keep working through
every pre-build stage.

**Phase B — mid-build** (once `implementation_allowed` is true and slices exist): writes to paths
owned by a slice whose status is not `in-progress` are flagged — a likely component-boundary
violation. Writes to in-progress slices' paths and to paths owned by no slice are allowed.

**Gate semantics** are controlled by the optional `write_gate` state field:

| Value | Behaviour |
|---|---|
| `ask` (default) | Claude Code presents an allow/deny prompt. Human sessions proceed with one click; headless agents are effectively blocked. |
| `deny` | Writes are hard-blocked. Use for strict runs where no slip-through is acceptable. |
| `off` | Gate disabled. Equivalent to setting `TH_DISABLE_WRITE_GATE=1`. |
| `strict` | `deny` semantics plus Phase-B Bash-mediated-write enforcement of the §16 component-boundary rule — a backward-compatible superset of `deny`. |

Set it with `th state set write_gate deny` (or `ask`, `off`, `strict`). The field is absent by default (behaves as `ask`).

**Env escape hatch:** `TH_DISABLE_WRITE_GATE=1` disables the gate for the current session without
touching state.

**Fail-open by design:** no `state.json` → instant allow (non-TwinHarness projects are completely
unaffected); invalid state → allow with a system-message warning; tool has no `file_path` → allow.

### Gate-mutation audit ledger

Every gate-relevant state change is appended to `.twinharness/gate-ledger.jsonl` — an append-only
JSONL file recording mutations to `implementation_allowed`, `tier`, `blast_radius_flags`,
`write_gate`, and `drift_open_blocking`, as well as blocking-drift open and resolve events, each
with an ISO-8601 UTC timestamp.

The ledger is **observability only** — it never blocks a mutation, and makes no provenance claim
(the CLI cannot tell who invoked it). Writes are best-effort and never crash the triggering
command. The ledger is reviewable via `th manifest export` (timestamps are dropped in the
deterministic manifest to ensure byte-stability; use the raw file for forensics).

### Resuming

Runs are idempotent to re-enter. If `.twinharness/state.json` exists, `/twinharness:th-run`
reads `current_stage` and resumes there — it never starts over. You can close the session
mid-architecture and pick up days later.

---

## Part 3 — The `th` CLI (advanced)

Everything mechanical goes through `th`. Inside a session the agents run it for you; you need it
directly for debugging, CI, or scripting. The plugin ships it at
`<plugin-root>/dist/cli.js` — run it as `node <plugin-root>/dist/cli.js <args>` (the installed
copy lives under `~/.claude/plugins/cache/twinharness/twinharness/<version>/`), or `npm link` a
clone to get a global `th`.

Global flags: every command accepts `--json` (machine-readable output) and `--cwd <dir>` (operate
on another project). Flags accept both `--flag value` and `--flag=value`; a bare `--` ends flag
parsing so a positional may begin with `--`. Unknown flags and value-less flags are **rejected**
(exit 1, `bad_args`) rather than silently swallowed — a typo'd flag fails loudly. Every flag, grouped
and described, is in the [Complete flag reference](#complete-flag-reference) at the end of this part.

### Lifecycle & state

```
th init [--force] [--brownfield] [--max-tokens <k>]   Scaffold docs/, .twinharness/state.json, drift-log.md
th state get [dotted.path]         Print state (or one value: th state get slices[0].status)
th state set <dotted.key> <value> [--emergency]   Patch one value; REFUSES writes that would invalidate state; REJECTS unknown top-level keys
th state status                    Human-readable tier/stage/gates/slices snapshot
th state verify                    Exit 0 = valid; non-zero with a precise issue list otherwise
```

`th init` flags:

| Flag | Effect |
|---|---|
| `--force` | Reset an existing `state.json` and re-scaffold (otherwise `init` refuses to clobber a live run). |
| `--brownfield` | Scaffold a **brownfield** run — stamps `project_mode: "brownfield"` so the pipeline overlays an existing codebase (Codebase-Inspector + `th repo map` prerequisites, characterization Slice 0). |
| `--max-tokens <k>` | Per-session context budget in **thousands**; persisted as `max_tokens` (×1000 — e.g. `150` → `150000`). Drives the tier-aware default of `th budget check`. |

`state set` JSON-parses the value (`true` → boolean, `3` → number, `["a"]` → array) and falls back
to a bare string. Dotted paths support array indices. Because every write is re-validated against
the schema, illegal states — e.g. `tier T0` while a blast-radius flag is set — are mechanically
unwritable. Attempts to set an unknown top-level key exit with `unknown_field`.

**Field ownership — what `th state set` will and won't write.** Two classes of field are protected:

- **Unconditionally refused (`managed_field`).** `drift_open_blocking` and `debate_open_blocking`
  are counters owned by the drift / debate flows; `state set` always refuses them. Use
  `th drift add`/`th drift resolve` and `th debate add`/`th debate resolve` instead.
- **Gate-owned (require `--emergency`).** `implementation_allowed`, `tier`, `current_stage`,
  `write_gate`, and `blast_radius_flags` move the gate ladder. A raw `th state set` on any of them is
  refused **unless you pass `--emergency`**, which forces the raw write and records it loudly in the
  audit ledger. The normal path is the **typed gate commands** — `th tier record`, `th stage advance`,
  `th implementation unlock` (see below) — which validate the gate preconditions before mutating.
  (The agent-facing MCP raw setter never accepts these fields at all.)

`--emergency` is an escape hatch for repairing a wedged run by hand; prefer the typed gate command
whenever one exists.

`state.json` schema (canonical field order; spec §18):

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | number \| absent | Schema version stamped by `th init` and upgraded by `th migrate`. Absent on legacy files (treated as v1). |
| `tier` | `"T0".."T3"` \| null | Classified tier (null until classified) |
| `complexity_rationale` | string | Why that tier |
| `blast_radius_flags` | string[] | Subset of the five veto flags |
| `current_stage` | string | Resume point (`init`, `requirements`, `scope`, … `implementation`, `final-verification`) |
| `approved_artifacts` | {file, version, hash}[] | Registered artifacts (hashes drive staleness) |
| `summaries_index` | string | Index doc for summary handoffs |
| `slices` | {id, status, components}[] | Slice ledger; `status` ∈ pending/in-progress/done/blocked; `components` drives wave scheduling |
| `implementation_allowed` | boolean | Set true only after the slice plan + tier prerequisites clear |
| `open_questions` | string[] | Unresolved questions blocking advancement |
| `drift_open_blocking` | number | Open requirement-layer escalations; stop-gate blocks while > 0. **Managed field** — `state set` refuses writes; use `th drift add` / `th drift resolve` to modify. |
| `debate_open_blocking` | number \| absent | Open blocking debate-reconciliation obligations (Pattern B, REQ-PCO-042); stop-gate blocks while > 0. **Managed field** — owned by `th debate add` / `th debate resolve`; absent when zero (omitted so existing files hash identically). |
| `revise_loop_counts` | {mode: count} | Critic-loop round counters per mode |
| `write_gate` | `"ask"` \| `"deny"` \| `"off"` \| `"strict"` \| absent | PreToolUse write-gate semantics; absent = `ask`. `strict` adds Phase-B Bash-mediated-write enforcement on top of `deny`. Set with `th state set write_gate <value>`. |
| `project_mode` | `"greenfield"` \| `"brownfield"` \| absent | Whether the run adopts an existing codebase; absent = greenfield. Stamped by `th init --brownfield`; omitted from serialization when absent so existing files hash identically. |

### Tiering

```
th tier classify <brief.json>      Advisory: Tier-0 eligibility + detected flags
th tier veto-check <brief.json>    Mechanical: exit 3 + {"blocked":true,"flags":[...]} if any flag
th tier record <T0-T3>             Typed gate command: validate + record the run's tier
```

`brief.json` shape (all four booleans required):

```json
{
  "description": "add a --verbose flag to the export command",
  "single_file_or_local": true,
  "changes_public_interface": false,
  "adds_dependency": false,
  "obvious_testable_answer": true,
  "blast_radius_flags": []
}
```

`classify` is advisory — it computes the five Tier-0 conditions and never picks the tier (that's
judgment). `veto-check` is not advisory: it is an exit-code gate. `th tier record <T0-T3>` is the
typed gate command that actually **writes** the chosen tier into `state.json` (gate-checked — it
refuses a tier that the blast-radius veto forbids, and an upgrade backfills any stages a lower tier
would have skipped). It is the gate-safe alternative to `th state set tier …`, which is refused
without `--emergency`.

### Typed gate commands (the gate ladder)

Three fields move the run forward through gates: the tier, the current stage, and the
implementation lock. These are **gate-owned** (raw `th state set` refuses them without `--emergency`),
so each has a dedicated typed command that validates the gate preconditions before mutating:

```
th tier record <T0-T3>             Validate + record the tier (refuses a veto-forbidden tier; upgrades backfill skipped stages)
th stage advance                   Advance current_stage to the next engaged stage — only when the full gate ladder for the current stage clears
th implementation unlock [--lock]  Set implementation_allowed=true once the slice plan + tier prerequisites clear; --lock re-locks (sets it false)
```

- `th stage advance` is the only gate-checked way to move `current_stage`. It refuses to advance
  while the current stage still owes an obligation (an unregistered artifact, an open human gate, an
  open blocking drift/debate, a capped revise loop) — i.e. it enforces the same ladder `th next`
  reports. On success it advances to the next stage engaged for the run's tier (skipping stages that
  tier does not run).
- `th implementation unlock` flips the Phase-A → Phase-B write-gate boundary. It unlocks only when
  the **full gate ladder** clears *and* the coverage gate passes *and* `current_stage` is at least
  `implementation-planning` (the same composition `th next` enforces; for a brownfield run the
  repo-map must also be fresh). Once unlocked, the tier is frozen. `--lock` reverses it (sets
  `implementation_allowed=false`) if you need to re-gate writes mid-run.

### Critic loop bookkeeping

```
th revise bump <mode> [--cap N]    Increment a mode's round count; reports escalate = count >= cap
th revise status <mode> [--cap N]  Read count/cap/escalate without mutating
th revise reset <mode>             Zero the counter (stage passed)
```

Modes are stage names (`requirements`, `scope`, `architecture`, `slice`, `code-review`,
`documentation`, `ux-design`, `ui-design`, …). Default cap 3. The CLI computes `escalate`; the Orchestrator
decides what to do about it.

### Artifacts, coverage, traceability

```
th artifact register <path> --version <n>   Hash + record in approved_artifacts (file OR directory)
th artifact list                            What's registered (file, version, hash)
th coverage check [--reqs F] [--plan F] [--tests D] [--scope F]
th coverage report [--reqs F] [--plan F] [--tests D] [--scope F] [--code D]
th anchors scan [--scan-reqs] [--scan-tests] [--scan-code] [--strict]
th trace render                             The full traceability view, rendered on demand
th stale --since <hash>                     Diff-scoped downstream staleness (look up by recorded hash)
th stale --artifact <file>                  Same lookup, by file key (safe before re-registering)
```

- **Artifact register accepts a directory.** A path that is a directory (e.g. the T3 ADR set
  `docs/05-adrs/`) is hashed deterministically over its contents and recorded as one entry keyed
  `docs/05-adrs` (trailing slash normalized away). `th stale --artifact docs/05-adrs` round-trips
  on it. Single files behave exactly as before.
- **Coverage** asserts every MVP REQ-ID maps to ≥ 1 slice *and* ≥ 1 test. Non-zero exit = the
  build may not start. Scans tests/ **fully recursively** in any language, but the **tested**
  dimension counts a REQ-ID only when its anchor is in a **recognized test file** (`*.test.*`,
  `*.spec.*`, `*_test.*`, `test_*.*`, or any file under a `tests/`/`__tests__/`/`spec/` dir) — an
  anchor in a prose/README/fixture file under `tests/` does **not** satisfy the gate. Applies the
  MVP filter from `docs/02-scope.md`'s `## MVP Scope` section (or `--scope <file>` override).
  Defaults: `--reqs docs/01-requirements.md --plan docs/09-implementation-plan.md --tests tests`.
- **`th coverage report`** is the read-only breakdown (it is **not** a gate — `th coverage check`
  stays the gate). Per REQ-ID it reports four dimensions: **planned** (in a slice), **implemented**
  (anchored in the code dir — `--code`, default `src`), **tested** (anchored in a test), and
  **passing** (whole-suite, from the last `th verify run`; shown as `—` when no verify report
  exists).
- **Anchors** maps each REQ-ID to the files it appears in across `docs/`, `tests/`, and `src/`, and
  flags **orphans** — anchors in tests/code with no defined requirement. `--strict` makes an orphan
  exit 1. Tests anchor by placing the canonical hyphenated REQ-ID (e.g. `REQ-001`,
  `REQ-NFR-002`) in the test description or comment — the extractor matches `REQ-[A-Z0-9…]`; use
  a descriptive function name for readability. (The old `test_REQ001_` convention has no hyphen
  and does not match the extractor — use the hyphenated form.)
- **Trace render** produces the requirement → design → contract → slice/task → test → code table
  fresh on every call. Associates SLICE/TASK tokens per-REQ. It is deliberately **never stored** —
  a maintained traceability matrix would rot; anchors that live next to the code cannot.

### Cascade re-verification (upstream artifact changed)

When an approved upstream artifact is revised, run `th stale --artifact` **before** re-registering
to capture the stale set. If you re-register first, the recorded hash updates and `th stale`
would find no change.

```
th stale --artifact docs/02-scope.md          # capture stale set BEFORE re-registering
th artifact register docs/02-scope.md --version 2     # re-register → new hash recorded
# for each artifact in the stale set, run Critic in matching mode
```

`th stale` returns **all registered downstream artifacts** of the changed file in pipeline order —
it does not diff summaries. Every registered downstream artifact is returned when the file has
changed. Each stale artifact then gets a diff-scoped Critic pass (check
`th revise status <mode>` first), and only genuine conflicts escalate.

### Slices

```
th slices sync [--plan F] [--dry-run] [--remove-missing]
                                  Upsert state.slices from docs/09-implementation-plan.md;
                                  statuses preserved on re-sync; --dry-run computes without writing
th slice set-status <SLICE-ID> <status>  Set one slice's status (pending|in-progress|done|blocked)
```

Run `th slices sync` before `th build plan`. `th build plan` reads `state.slices` — not the raw
implementation plan document.

### Drift log

```
th drift add --layer derived     --ref "SLICE-2 / TASK-014" --discovery "..." --action "..." [--source "Builder"]
th drift add --layer requirement --ref "SLICE-2 / TASK-014" --discovery "..." --action "build paused" [--source "Builder"]
th drift list [--json]           Entries + open blocking count
th drift resolve <DRIFT-NNN>     Append resolution; decrement blocking counter only for requirement-layer entries
```

`--layer requirement` increments `drift_open_blocking` (stop-gate blocks); `--layer derived` is
non-blocking bookkeeping. `--source` names who logged the entry; defaults to "Builder". The log
(`drift-log.md`) is append-only.

`drift resolve <DRIFT-NNN>` validates that the ID exists and has not already been resolved; rejects
double-resolves. Only requirement-layer entries decrement the blocking counter.

### Build scheduling

```
th build plan [--include-done] [--advise]
```

Reads `state.slices` (populated by `th slices sync`) and computes the §16 wave schedule: disjoint
component sets → same wave (safe to run Builders concurrently), shared component → later wave
(serialized). By default only unfinished slices are scheduled. `th build plan` does NOT read the
raw plan file — always run `th slices sync` first.

| Flag | Effect |
|---|---|
| `--include-done` | Also schedule slices already marked `done` (default: only unfinished slices). |
| `--advise` | Append a parallelism-optimizer advisory — the maximum achievable wave width plus the slice pairs that serialize because they share a component. |

Exits **7** (`dependency_graph_unsatisfiable`) when the `depends_on` graph has a cycle or a dangling
reference; the full plan data is still emitted alongside the error so `--json`/MCP consumers see both.

### Live build coordination — parallel Builders without collisions

```
th build next-wave               Slices dispatchable in parallel right now (live)
th build claim <SLICE-ID>        Take a live component lease (refuses an overlapping claim)
th build release <SLICE-ID>      Release the slice's lease
th build sub-claim <PARENT-SLICE> --components <c1,c2,...>
                                 Open a SUB-lease under an in-progress parent (for a scoped sub-Builder)
th build sub-release <SUB-ID>    Release a sub-lease
th build leases                  List active component leases (and sub-leases)
```

`th build plan` schedules from the *static* plan; these commands coordinate the *live* build. The
flow for each wave:

1. `th build next-wave` → the slices ready now: status `pending`, every `depends_on` slice `done`,
   and components free of in-progress slices, active leases, and each other. Held slices are listed
   with the reason (`dependency` or `component-conflict`).
2. For each dispatched slice: `th slice set-status <ID> in-progress`, then `th build claim <ID>`,
   then spawn its Builder. `claim` is the **collision guard** — it refuses (exit 1) if any of the
   slice's components are already leased to a different slice, even when the static plan thought them
   disjoint (drift can grow a component set mid-build). Claims serialize under the state lock.
3. On Critic PASS: `th slice set-status <ID> done` and `th build release <ID>`, then re-run
   `th build next-wave`. On failure: set the slice `blocked`, release, and engage the Debugger.
   Setting a slice `done`/`blocked` **auto-releases its lease**, so a forgotten `th build release`
   can't leave a stale lease behind. Leases are also reconciled against slice state: a lease held by a
   `done`/`blocked`/missing slice is **stale** — ignored by `next-wave`/`claim`, shown separately by
   `th build leases`, and flagged by `th doctor`.

`next-wave` also guards against deadlocks: if the `depends_on` graph has a **cycle** or a **dangling
reference**, or pending slices can't dispatch with nothing in progress to unblock them, it reports a
**STALL** instead of a silent empty wave (`th next` surfaces this as `stalled-build`; `th doctor`
validates the graph). Break the cycle / fix the reference in the plan and re-sync.

Slices may declare `depends_on` (parsed by `th slices sync` from a `Depends on: SLICE-1, SLICE-2`
line) so a feature slice waits for the walking skeleton even when their components are disjoint. One
**top-level** coordinator (the Orchestrator) drives N Builders — only it calls `th build next-wave`
and the top-level `th build claim` — so there is no second top-level controller to collide with.

### Sub-leases & nested sub-agents (scoped, bounded)

A Builder or Debugger holds the `Agent` tool and may, within a tight charter, spawn a nested
sub-agent. There are exactly two allowed kinds of child: a **read-only advisory agent** (a
Researcher, a fresh-context Critic, or a Debugger — runs in the foreground, looks and reports, never
writes), or a **single scoped sub-Builder** constrained to a **subset** of the parent slice's
components. Before that sub-Builder writes anything, the parent opens a **component sub-lease**:

```
th build sub-claim <PARENT-SLICE> --components <subset>   # mints <PARENT>#sub-<n>
th build sub-release <SUB-ID>                             # release when the child is done
```

`sub-claim` validates that the subset belongs to an **in-progress** parent slice and is **disjoint**
from any sibling sub-lease; the sub-Builder operates strictly within the parent slice's already-held
top-level lease — it **never** opens a new top-level claim and **never** calls `th build next-wave`,
so there is still exactly **one top-level controller**. A parent slice settling to `done`/`blocked`
makes every sub-lease under it stale, so a forgotten `sub-release` can't wedge the schedule (release
explicitly anyway). Nesting is capped at one level, with a small per-slice spawn cost cap. See the
"Spawning sub-agents (Phase 5)" section of `agents/builder.md` / `agents/debugger.md`.

### Worktrees & the merge-back protocol

Parallel Builders (and any scoped sub-Builder) run in **isolated git worktrees**
(`isolation: worktree`), so concurrent slices never see each other's half-written files. The
load-bearing rule: **code is isolated; `.twinharness/` is shared.** A per-worktree copy of the state
dir would give each Builder its own lease ledger and the cross-process lock would protect nothing —
so every `th` state/lease/drift command issued from inside a worktree MUST target the **main project
root** (pass `--cwd <main-root>`, or use the typed `mcp__plugin_twinharness_th__*` MCP tools, which
resolve `${CLAUDE_PROJECT_DIR}` to the stable project root). On a slice's Critic PASS the Orchestrator
merges its worktree branch back **in wave order**: the `th build plan` schedule already serializes
shared-component slices, so within a wave the branches are component-disjoint and merge cleanly. A
**non-clean** merge between plan-disjoint slices is the mechanical signal of accidental shared-state
coupling — it is opened as **blocking** drift (`th drift add --layer requirement`) for human
resolution; a clean merge → `th build release <SLICE-ID>`. The lease stays the live scheduler oracle;
the worktree adds filesystem-level enforcement and the merge a second conflict check (deliberate,
useful redundancy). Full protocol: `skills/twinharness/reference/build-and-verify.md` (Stage 10) and
`agents/orchestrator.md` (parallel-build coordination).

### Parallel collaborative orchestration (collab · debate · section-level artifact leases)

When several agents work the **same stage** at once (a fan-out design round, a multi-author artifact),
three coordination primitives keep them collision-safe and reconcilable. Like every other `th` command,
they only *record and compute* — they never decide who runs.

**Blackboard fragments (`th collab`)** — a shared per-stage scratch space so parallel authors drop
contributions without overwriting each other; a Reconciler later merges them:

```
th collab init --stage <s>                                   # initialize the blackboard stage dir (REQ-PCO-040)
th collab fragment --stage <s> --round <r> --name <n> --text <t> [--force]
                                                             # drop a fragment (refuses to overwrite without --force)
th collab list --stage <s> [--round <r>]                     # list fragments
th collab merge --stage <s> --round <r>                      # concatenate fragments (REQ-anchor-validated) for the Reconciler
```

**Debates (`th debate`)** — a BLOCKING reconciliation obligation when authors disagree; an open debate
blocks completion exactly like a requirement-layer drift, until explicitly resolved (REQ-PCO-042):

```
th debate add --topic <t> [--positions ...] [--links a,b] [--source ...]   # open a BLOCKING debate
th debate list                                                             # ledger entries + open blocking count
th debate resolve --id <DEBATE-ID> --resolution <r>                        # resolve (clears the obligation)
```

**Section-level artifact leases (`th artifact claim/release/leases`)** — finer-grained than the
build-component lease: a collision guard for intra-artifact fan-out (several agents editing different
sections of one document, REQ-PCO-041):

```
th artifact claim <file#section> --holder <id>     # take a section-level lease
th artifact release <file#section> --holder <id>   # release it
th artifact leases                                 # list active section-level leases
```

**Batch wave dispatch (`th build dispatch`)** — the companion to `th build next-wave`: it emits the
full parallel wave **plus** a per-slice spawn descriptor (model/effort) in one payload, so the
Orchestrator can spawn an entire wave of Builders in a single message. Like `next-wave` it is a pure
read of state — it dispatches nothing and mutates nothing; each slice still needs its own
`in-progress` + `th build claim` before its Builder is spawned.

**SubagentStop hook (`th hook subagent-stop`)** — emits a Claude Code SubagentStop-hook decision (a
state-validity guard), the sub-agent analogue of the Stop-gate. It is wired by `hooks/hooks.json`; you
do not normally invoke it by hand.

### Debug — evidence-first defect tracing (the Debugger agent)

```
th debug pack [--slice <ID> | --req <REQ-ID>]   Assemble a read-only failure-evidence bundle
th debug log add --ref "REQ-007 / SLICE-2" --symptom "…" [--evidence "…"] [--root-cause "…"] [--status open|resolved]
th debug log list                                List evidence entries + open count
```

`th debug pack` gives the Debugger facts to start from: the failing `th verify run` commands +
output tails, the target slice's components (or a REQ-ID's code/test anchors), recent drift, and any
open findings. `th debug log` is the append-only evidence ledger (`debug-log.md`, mirroring
`drift-log.md`) — each entry anchors a symptom/evidence/root-cause to a REQ-ID/slice. A root cause
that contradicts a requirement is opened as **blocking** drift through `th drift add --layer
requirement` so the stop-gate sees it. The Debugger proposes the minimal fix; the Builder applies it;
tests and the human certify correctness (§11).

### Verify — run the project's own tests/checks

```
th verify add "<command>"        Append a project test/check command (e.g. "npm test")
th verify list                   Show configured commands
th verify clear                  Remove all configured commands
th verify run                    Run every command in order; exit 1 on any failure
```

`th verify run` is the **one** `th` command that executes — it runs operator-authored commands
(configured via `th verify add`, stored in `.twinharness/verify.json`) with the shell, in the
project root, and writes a report (`.twinharness/verify-report.json`). Every other `th` command
only records and computes. The report feeds the **passing** column of `th coverage report` and the
suite signal in `th doctor`. Commands live outside `state.json`, so the state schema and its
content-hash stability are untouched. Each command runs under a wall-clock timeout (5 min) with stdin
closed, so a command that hangs (watch mode, server, stdin wait) is killed and recorded as a failure
rather than blocking the run forever. See `SECURITY.md` — `th verify run` only ever runs commands a
human added; it never sources commands from artifact content.

### Version

```
th version
```

Prints the CLI version from `package.json`. Useful for confirming which plugin version is active.

### Diagnostics & run inspection

```
th doctor [--strict]
```

Self-diagnostic **plus a full run-health audit**. `--strict` escalates two integrity signals from
warnings to **hard failures** (non-zero exit) — a **broken gate-ledger hash chain** (a sealed entry
edited/deleted/reordered) and an **unknown top-level state key** not in the forward-compat allowlist
(catches typos like `teir`) — making `th doctor --strict` a useful CI gate. The other run-health
findings (open blocking drift, unfinished slices, a capped revise loop, a changed/missing artifact,
a stale lock, schema behind) stay informational warnings either way; only hard failures (unsupported
Node, invalid `state.json`) ever exit non-zero in the default mode. Reports:

- **Node version** — checks the running Node major version against the supported floor (Node ≥ 20,
  set by `engines.node`) and reports it.
- **Plugin CLI** — whether `dist/cli.js` is present next to the running binary.
- **Plugin version** — from `package.json`.
- **state.json validity** — valid + tier/stage summary; or a precise issue list if invalid.
- **Schema version** — whether `state.json` is at the current `schema_version`; warns and
  suggests `th migrate` if behind.
- **Blocking drift** — count of open requirement-layer escalations; warns if any are open.
- **Stale state lock** — warns if `.twinharness/.state.lock` is present with age (a crashed `th`
  left the lock behind; safe to remove if no `th` process is running).
- **Audit ledger size** — number of entries in `gate-ledger.jsonl`.
- **Artifact integrity** — recomputes each approved artifact's on-disk hash (file or directory) and
  warns on any that **changed** (a governed doc edited without re-registration) or went **missing**.
- **Slice progress** — done / blocked / in-progress / pending counts; warns while any are unfinished.
- **Coverage** — planned+tested vs total, implemented count, and the suite signal (green/failing/
  unknown) from the last `th verify run`.
- **Revise loops** — warns on any mode that has reached its cap (a human decision is owed).

Exit non-zero only on hard failures (unsupported Node version, invalid `state.json`). All
run-health findings are warnings — they inform; they never fail the process. Never mutates anything.

```
th next
```

The next-action **oracle**: given durable state + on-disk anchors, it returns the single
highest-priority **mechanical** obligation the run owes next, in this priority order — fix invalid
state → resolve blocking drift → escalate a capped revise loop → re-register a silently-changed
artifact → classify the tier → produce/register the current stage's artifact → clear the coverage
gate → finish/block remaining slices (at final verification) → human sign-off → advance to the next
engaged stage. The JSON form carries a stable `kind` token plus the human `action`. Like `th stage
current`, it reports a mechanical obligation; it never chooses strategy — consult it when unsure
what the run owes next, especially after a long context window (F7). Add `--explain` to also get a
short **WHY** string (in `data.why` and a `why:` line) explaining why that obligation outranks the
others right now; without the flag the output is unchanged.

```
th context estimate
th context pack [--slice <SLICE-ID>]
```

`th context estimate` approximates the prompt-surface token cost of the plugin's skill, agent, and
command files (heuristic: ~4 chars/token). Flags any file exceeding Claude Code's ~500-line /
~5,000-token re-attach guidance — these are the files that risk losing their tail after context
compaction on long runs. The on-demand `skills/twinharness/reference/` files are expected to exceed
the threshold by design (they load only when needed for a given stage or mode, not on every turn).
All always-loaded core files are within the guidance.

`th context pack` assembles the §9 **handoff bundle**: the Summary block of every approved artifact
(the handoff currency — full artifacts are fetched only on demand), with a token estimate. With
`--slice <SLICE-ID>` it adds that slice's record, the components it touches, and the other slices it
shares components with (§16 conflict awareness — which slices must serialize). It **computes** a
candidate bundle; deciding what to actually route remains the Orchestrator's call.

### Run preview, scorecard, routing & telemetry

```
th preview [--tier T<n>]
th scorecard [--json] [--hotspots]
th route [--agent A] [--mode M] [--tier T] [--component-blast] [--summarization]
th telemetry on | off | status
```

- **`th preview [--tier T<n>]`** — pre-run view of the pipeline shape for a tier: the engaged stages,
  which carry a human gate, and each stage's Critic mode, plus a stages/gates/reviews summary line.
  `--tier` resolves the tier to preview; absent, it uses the recorded `state.tier`, else defaults to
  T2 (and says so). Read-only.
- **`th scorecard [--json] [--hotspots]`** — one-screen post-run summary: tier/stage, coverage
  (planned/implemented/tested), slice progress, suite status (from the last `th verify run`, `—` if
  none), drift (entries + open blocking), revise escalations, and a **Routing** line summarizing
  recorded `th route` telemetry (`—` when none). `--hotspots` instead emits a per-stage cost table —
  token (estimate/proxy) and wall-clock totals aggregated from the local `telemetry.jsonl`, by stage;
  with telemetry off/empty it prints a "no data" message and still exits 0. If telemetry is on, each
  call also appends a timestamped snapshot.

  | Flag | Effect |
  |---|---|
  | `--json` | Emit the structured scorecard payload instead of the text screen. |
  | `--hotspots` | Per-stage token + wall-clock cost table from the local telemetry log. |

- **`th route`** — advisory model + effort recommendation for one agent spawn. It **computes**; the
  Orchestrator applies the result. All flags optional:

  | Flag | Effect |
  |---|---|
  | `--agent <A>` | The agent being spawned (e.g. `spec`, `critic`, `builder`). |
  | `--mode <M>` | The stage/Critic mode (e.g. `architecture`, `code-review`). |
  | `--tier <T>` | The run's tier (escalation scales with tier). |
  | `--component-blast` | The target slice touches a blast-radius component → escalate the model. |
  | `--summarization` | Trivial mechanical summarization → route to the cheapest model (haiku). |

- **`th telemetry on|off|status`** — opt-in, **local-only** run telemetry stored next to `state.json`
  (`telemetry.json` + `telemetry.jsonl`), off by default. Nothing is ever transmitted off-machine.
  `on` starts recording `th scorecard` snapshots, `off` stops, `status` shows the flag and record count.

### Context budget (`th budget check`)

```
th budget check [--max <k>] [--files-read <n>] [--slices-built <n>] [--tool-calls <n>] [--artifacts <n>]
```

A deterministic context-budget estimate from agent-supplied **proxy counts** (TwinHarness has no
runtime token meter — see SECURITY/known-limits). It returns `{ estTokens, pct, verdict }` where
`verdict` is a budget-pressure signal the Orchestrator uses to decide when to delegate or write a
handoff. All flags optional:

| Flag | Effect |
|---|---|
| `--max <k>` | Budget override in **thousands**. Default: `state.max_tokens` (from `th init --max-tokens`), else a tier-aware default. |
| `--files-read <n>` | Proxy: files read so far this session. |
| `--slices-built <n>` | Proxy: slices built so far. |
| `--tool-calls <n>` | Proxy: tool calls so far. |
| `--artifacts <n>` | Proxy: approved artifacts carried in context. |

### Handoff & resume

```
th handoff write                 Assemble .twinharness/HANDOFF.md for a context handoff
th handoff verify                Confirm a resumed run still matches HANDOFF (pass/fail)
th resume                        Detect HANDOFF.md and print the next mechanical action
```

When a session approaches its context budget, `th handoff write` snapshots the run into
`.twinharness/HANDOFF.md`: current state + the next mechanical action (from `th next`) + every
approved artifact's Summary block + open questions + a "don't re-read `docs/`" directive — everything
a fresh session needs to continue without re-reading the full artifact set. On resume, `th handoff
verify` confirms the live run still matches the handoff (`current_stage`/slice unchanged and every
approved-artifact hash still valid) and reports pass/fail; `th resume` detects the handoff file and
prints the next action so a new session knows where to pick up. None take flags beyond the globals.

### Context preservation & delegation

```
th delegate plan [--intent <i>] [--files <n>] [--writes] [--noisy] [--task <t>] [--slice <ID>]
th delegate pack [--agent <a>] [--slice <ID>] [--task <t>] [--intent <i>]
th delegate capsule
th delegate check --capsule <path>
```

The **Context Preservation / Delegation Layer** keeps the main Orchestrator context a scarce
control-plane resource: heavy reads, edits, debugging, reviews, and repo inspection are **delegated**
to child agents that consume the detail and return a compact capsule. Like `th route` / `th next`,
every verb **computes or checks**; it never decides — the Orchestrator still owns the call. Read-only
(no state mutation).

`th delegate plan` is the **delegate-vs-keep-main oracle**. It recommends `delegate` when any signal
fires — `--intent` is `write|debug|review|artifact|repo-analysis`, expected `--files` exceed the
threshold (3), the task `--writes` source, or it runs `--noisy` commands — otherwise `keep-main`. The
output carries the reasons, a suggested agent, the suggested handoff (built only from commands that
exist: `th context pack`, `th delegate pack`), and whether a capsule is required. `--task` / `--slice`
are contextual labels (echoed; not parsed — the recommendation is deterministic from the signal flags).

`th delegate pack` assembles a **bounded child-agent handoff**: the delegated-agent envelope (agent /
task / intent / slice / allowed scope / required behavior) plus the required Delegation Capsule
format. With `--slice <ID>` it reuses `th context pack` for that slice's artifact Summary blocks and
component-overlap framing (an unknown slice / uninitialized project surfaces that command's failure).

`th delegate capsule` prints the blank **Delegation Capsule** skeleton — the strict, compact return
format (Agent, Task, Intent, Inputs used, Files read, Files changed, Commands run, Findings, Risks,
Tests/checks, Result, Open questions, Recommended next action, Artifacts produced). Long-form detail
belongs in durable files under `.twinharness/delegations/DEL-###/`, never in the capsule.

`th delegate check --capsule <path>` validates that a returned capsule contains **every** required
section heading (presence only — content is not judged; a section may read "none"). Success when all
14 are present; failure lists the missing ones. The same three verbs are exposed as the MCP tools
`th_delegate_plan` / `th_delegate_pack` / `th_delegate_check` (`check` also accepts the capsule
inline as `text`).

### Schema migration

```
th migrate
```

Upgrades `state.json` to the current `schema_version`. Legacy files written before schema
versioning was introduced have no `schema_version` field and are treated as v1. Migration is
**forward-only**: it stamps or upgrades the version, applying any per-version field migrations, but
refuses to touch a file written by a newer `th` (exits with `schema_too_new`). Running `th migrate`
on an already-current file is a no-op (idempotent).

### Stage contracts

```
th stage current
th stage describe <stage>
th stage list
```

Derives the mechanical per-stage contract — what the stage produces, which Critic mode reviews it,
and whether a human gate is required — directly from the pipeline table. Useful when the Orchestrator
needs to re-derive a stage's obligations without depending on the prose playbook surviving the
context window.

- `th stage current` — contract for `state.current_stage`. Pre-pipeline stages (`init` and other
  stages before the pipeline begins) have no contract; the command reports that plainly and
  suggests `th stage list`.
- `th stage describe <stage>` — contract for any named stage.
- `th stage list` — all pipeline stages in order with their tier scope, gate flag, and artifact.

These three only **read** the contract. To actually move `state.current_stage` forward, use the
gate-checked `th stage advance` (see [Typed gate commands](#typed-gate-commands-the-gate-ladder)) —
raw `th state set current_stage …` is refused without `--emergency`.

### Run manifests

```
th manifest export [--json]
```

Produces a deterministic run snapshot aggregating `state.json`, `drift-log.md` entries, and the
gate ledger into a single, stable JSON. Ledger timestamps are dropped so the same run state always
produces byte-identical output — suitable for golden-fixture assertions in CI or archival.

Without `--json`, prints a human-readable summary (tier, stage, artifact/slice/drift counts, gate
ledger size). With `--json`, emits the full manifest. Useful for review, diffing across runs, and
comparing against archived golden fixtures.

### Decision governance (`th decision`)

Significant run choices are recorded, human-approved, and enforced through a hash-chained,
tamper-evident decision ledger.

```
th decision detect                Surface advisory decision candidates (read-only; exit 0)
th decision add --title <t> --rationale <r> [--links a,b] [--proposer <n>]
th decision approve <DECISION-ID> [--reject | --supersede <id>] [--as <actor>]
th decision check                 Exit 6 while an unapproved decision gates the current stage; else 0
th decision list                  List the decision set (ids/titles/statuses/links/audit)
```

- **`th decision detect`** — surfaces candidate decisions from ADRs, the drift log, scope, and
  blast-radius flags. Read-only; always exits 0.
- **`th decision add`** — records a `proposed` decision and mints `DECISION-NNN`. Never auto-approves.

  | Flag | Effect |
  |---|---|
  | `--title <t>` | Decision title (**required**). |
  | `--rationale <r>` | Why this decision (**required**). |
  | `--links <a,b>` | Comma-separated REQ-IDs / ADR-ids / stage ids the decision concerns. |
  | `--proposer <n>` | Proposer attribution (default: `orchestrator`). |

- **`th decision approve <DECISION-ID>`** — the **human-only** transition, behind an interactive-TTY
  barrier: it aborts in any agent/CI/non-TTY context (REQ-412) and is permanently absent from the MCP
  tool registry.

  | Flag | Effect |
  |---|---|
  | `--reject` | Append a `rejected` event instead of `approved` (mutually exclusive with `--supersede`). |
  | `--supersede <id>` | Mark this (approved) decision superseded by `<id>` (mutually exclusive with `--reject`). |
  | `--as <actor>` | Approver attribution only — **not** a barrier (default `TH_APPROVAL_ACTOR`, else `human`). |

- **`th decision check`** — fails (exit **6**) while any unapproved decision is linked to the current
  stage; otherwise exit 0. `th next` surfaces this as a `resolve-decision-obligation` rung.
- **`th decision list`** — the sorted decision read model; exits non-zero if the hash chain is broken.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General failure (invalid state, unknown command, missing args, `unknown_field` on `state set`, `drift_not_found` / `already_resolved` on `drift resolve`, lease collision on `th build claim`) |
| 2 | Path containment violation — a path-escape attempt (a `..`/absolute/separator-bearing segment where a single in-root component is required, e.g. `th collab fragment --name "../x"`); returns a structured `path_containment` failure instead of a raw stack |
| 3 | Blast-radius veto (`th tier veto-check` blocked; also `brownfield_prerequisite_missing` when repo map or codebase analysis is absent) |
| 4 | Repo map stale (`th repo check` — files added/removed/modified since last `th repo map`) |
| 5 | Repo map absent (`th repo check` — `.twinharness/repo-map.json` not found; run `th repo map` first) |
| 6 | Unapproved decision gates the current stage (`th decision check` — use `th decision approve` via interactive TTY to unblock) |
| 7 | Dependency graph unsatisfiable (`th build plan` — `depends_on` graph has a cycle or dangling reference; fix and re-sync) |

### The hooks

```
th hook stop-gate
```

Speaks the Claude Code Stop-hook protocol on stdout: `{}` to allow;
`{"decision":"block","reason":"..."}` to block. Reads the hook payload on stdin and honors
`stop_hook_active` (see Part 2). Always exits 0 — the JSON carries the decision. You rarely run
this by hand except to debug why a session refuses to finish.

```
th hook pretool-gate
```

Speaks the Claude Code PreToolUse-hook protocol on stdout. Reads the tool name and path from
stdin. For `Write`/`Edit` calls the path comes from `tool_input.file_path`; for `NotebookEdit`
the gate falls back to `tool_input.notebook_path` (the field NotebookEdit actually supplies).
Returns `{}` to allow; `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
"permissionDecision":"ask","permissionDecisionReason":"..."}}` to ask; or the same shape with
`"deny"` for hard blocks. Always exits 0.

The hook fires on two matchers:
- `Write|Edit|NotebookEdit` — the primary path-based matcher (`MultiEdit` was removed from Claude
  Code v2.0 and is not listed).
- `Bash` — a conservative Phase-A-only heuristic that catches obvious shell writes (`>`, `>>`,
  `tee`, `dd of=`, `sed -i`) into in-root implementation paths. Fail-open: anything the heuristic
  cannot clearly parse is allowed through. Never fires in Phase B. Bash-mediated writes remain out
  of scope as a guarantee.

See Part 2 — "The write-gate" for full semantics.

#### Hook wiring (`hooks/hooks.json`)

All three hooks are wired via `hooks/hooks.json` in the plugin root. The wiring maps Claude Code
hook events to `th` CLI invocations:

| Hook event | Command | Fires on |
|---|---|---|
| `Stop` | `th hook stop-gate` | Every turn end — blocks Claude from claiming done while state is invalid, blocking drift is open, or (at `final-verification`) slices are unfinished or suite is red |
| `PreToolUse` | `th hook pretool-gate` | `Write`, `Edit`, `NotebookEdit`, `Bash` — the write-gate; enforces phase-gating and component-boundary rules |
| `SubagentStop` | `th hook subagent-stop` | Sub-agent turn ends — state-validity guard analogous to the Stop-gate for spawned child agents |

The hooks are installed automatically with the plugin; `hooks/hooks.json` is the authoritative
wiring file. All three commands always exit 0 — decisions are carried in the JSON payload on
stdout, not in the process exit code.

### Repo-understanding layer (`th repo`)

The repo-understanding layer gives TwinHarness a mechanical spine for understanding an existing codebase before it plans or builds into it. The layer treats all repository content as **untrusted data**: it records build/test commands as inert strings but never executes them.

#### `th repo map`

```
th repo map [--write | --no-write] [--format <summary|json|md>] [--json] [--cwd <dir>]
```

Scans the repository and writes two artifacts:

- `.twinharness/repo-map.json` — the byte-stable, versioned machine map (`schema_version: 1`). POSIX-relative paths only; deterministic across OS; no timestamps, no absolute paths, no run-specific data. Every collection is sorted lexicographically so two runs on an unchanged repo produce byte-identical files (REQ-NFR-001).
- `docs/00-repo-map.md` — a compact human/agent summary: languages, package managers, source/test/docs roots, components, entrypoints, blast-radius signals, and counts. Never a full map dump (REQ-NFR-004).

Bare `th repo map` **writes** both artifacts (REQ-RU-014). Use `--no-write` for a dry/preview run that builds the map in memory without touching the filesystem.

| Flag | Default | Meaning |
|---|---|---|
| `--write` | on | Write the two artifacts (the default; bare invocation writes) |
| `--no-write` | — | Dry/preview: build in memory, emit the summary, write nothing |
| `--format summary\|json\|md` | `summary` | Text rendering: compact counts (default), JSON data payload, or the markdown body |
| `--json` | off | Emit the structured `{ ok, schemaVersion, wrote, artifacts, counts, blastRadiusFlags, scanReport }` envelope |

The map build detects: languages, package managers, candidate build/test commands (inert strings — **never executed**, RULE-004), source/test/docs roots, components, entrypoints, public API surface (heuristic), ownership hints, file-to-component mapping, REQ anchors, and blast-radius signals (authentication, authorization, data-integrity, money, migrations).

The `repo-map` persisted JSON is the **durable source of truth** — it moves with the code. The Codebase-Inspector writes prose analysis (`docs/00-existing-codebase-analysis.md`) while `th repo map` produces the machine-readable `repo-map`; they are complementary, but only the machine `repo-map` is versioned and recomputable (REQ-RU-060). Prose can rot; the map is always regenerable.

#### `th repo relevant`

```
th repo relevant (--slice <ID> | --req <REQ-ID> | --file <path> | --query <kw>)
                 [--maxResults <n>] [--format <slice|req|file|json>] [--json] [--cwd <dir>]
```

Reads the persisted `repo-map.json` and returns precision context for a selector. Exactly one selector is required. Read-only with respect to both `state.json` and `repo-map.json` (REQ-RU-026).

**Selectors (exactly one required):**

| Flag | Meaning |
|---|---|
| `--slice <ID>` | SLICE-ID; resolves components from `state.slices` (REQ-RU-027) |
| `--req <REQ-ID>` | REQ-ID; finds files anchored to it |
| `--file <path>` | A root-contained file path (path guard fires first — REQ-RU-024/042) |
| `--query <kw>` | Keyword or phrase matched against file/component/REQ tokens |

**Output categories** (each item carries a non-empty WHY — REQ-RU-022):

- `readFirst` — highest-priority files to read before editing
- `related` — related files in the same components or via REQ anchors
- `tests` — likely test files for the selection
- `owningComponents` — component names that own the relevant files
- `doNotTouch` — generated/excluded paths (avoid these)
- `risks` — blast-radius signals active for the scope
- `verifyCandidates` — suggested build/test commands (recorded as suggestions, never executed)

`--maxResults <n>` (default 20) caps the combined `readFirst + related + tests` count; `truncated: true` is set when items were dropped. A selector matching nothing yields empty arrays and `truncated: false` — success, not a failure (REQ-RU-020).

#### `th repo impact`

```
th repo impact (--file <path> | --component <name|path>)
               [--format <file|json>] [--json] [--cwd <dir>]
```

Pre-edit blast-radius analysis over the persisted `repo-map.json`. Reads no state (REQ-RU-033). Exactly one selector required.

**Selectors (exactly one required):**

| Flag | Meaning |
|---|---|
| `--file <path>` | Root-contained file path (path guard fires first — REQ-RU-032/042) |
| `--component <name\|path>` | Component name (e.g. `src/commands`) or path form |

**Output** (each item carries a WHY — REQ-RU-022):

- `impactedComponents` — components that will be affected
- `relatedTests` — tests likely to exercise the changed scope
- `downstreamFeatures` — downstream features and REQ anchors in the impact scope
- `reqAnchors` — REQ-IDs in the impact scope
- `riskFlags` — blast-radius signals intersecting the scope
- `verifyCandidates` — recommended build/test commands (never executed)

#### Error responses common to `th repo relevant` and `th repo impact`

| Error code (`data.error`) | Condition | Action |
|---|---|---|
| `path_outside_root` | `--file` or path-form `--component` escapes the project root | Fix the path; guard runs before any read |
| `no_selector` | No selector supplied | Supply exactly one of `--slice`/`--req`/`--file`/`--query` (or `--file`/`--component`) |
| `multiple_selectors` | More than one selector | Supply exactly one |
| `map_missing` | `.twinharness/repo-map.json` absent | Run `th repo map` first |
| `map_invalid-json` / `map_schema` / `map_version` | Map file malformed or unknown version | Run `th repo map` to regenerate |
| `unknown_slice` | `--slice` names no known slice | Check `th state status` for valid slice IDs |

#### MCP tools (registered count 76)

76 MCP tools are registered in `dist/mcp-server.js`, each a thin one-liner adapter over the same handler as its CLI twin. The interview/init surface exposes `th_interview_start`, `th_interview_record`, `th_interview_status`, and `th_init`. Five precondition-gated gate-transition tools safely mutate gate-owned fields: `th_tier_record`, `th_stage_advance`, `th_implementation_unlock`, `th_write_gate_set`, `th_blast_radius_record`. Additional wired handlers: `th_drift_list`, `th_drift_resolve`, `th_coverage_report`, `th_artifact_register`, `th_artifact_list`, `th_verify_add`, `th_verify_list`, `th_verify_clear`, `th_verify_run`, `th_stage_current`, `th_stage_describe`, `th_stage_list`, `th_doctor`, `th_scorecard`, `th_slices_sync`, `th_slice_set_status`. Notable tools highlighted below:

| Tool name | CLI equivalent | Notes |
|---|---|---|
| `th_repo_map` | `th repo map` | `write` (boolean, default true), `format` (string enum) |
| `th_repo_relevant` | `th repo relevant` | `slice`, `req`, `file`, `query`, `maxResults` inputs |
| `th_repo_impact` | `th repo impact` | `file`, `component` inputs |
| `th_context_pack` | `th context pack` | `slice` input; wraps the existing handler |
| `th_budget_check` | `th budget check` | `max`, `filesRead`, `slicesBuilt`, `toolCalls`, `artifacts` inputs; deterministic estimate |
| `th_handoff_write` | `th handoff write` | no inputs; writes `.twinharness/HANDOFF.md` |

All MCP tool schemas are strict and closed (`additionalProperties: false`). Output mirrors the CLI structured payload (`result.data`) as `structuredContent` plus the human text block. Compact by default — the full `repo-map.json` is never dumped into a prompt (REQ-NFR-004), and the heavy oracle tools (`th_coverage_report`, `th_doctor`, `th_scorecard`) return a one-line headline unless called with `verbose: true` (full data is always in `structuredContent`). Each tool advertises MCP behavior hints (`readOnlyHint`/`destructiveHint`/`idempotentHint`) and a grouping `category` (in `_meta`).

<!-- BEGIN AUTO-GENERATED: command-reference (scripts/gen-command-reference.ts) -->

#### Generated command reference

This table is generated from the CLI dispatcher and the MCP `TOOL_DEFS` registry (`scripts/gen-command-reference.ts`); do not edit it by hand. There are **105 CLI command leaves** and **76 MCP tools**.

| CLI command | MCP tool | Status |
|---|---|---|
| `th init` | `th_init` | mirrored |
| `th state get` | `th_state_get` | mirrored |
| `th state set` | `th_state_set` | mirrored |
| `th state status` | — (CLI-only) | Human-readable snapshot; agents read th_state_get / th_scorecard structurally. |
| `th state verify` | — (CLI-only) | CLI/CI exit-code gate; agents read th_doctor for validity posture. |
| `th state unlock` | — (CLI-only) | Local lock-recovery operator surface; destructive (removes the .state.lock dir), not agent-reachable (R-21; mirrors migrate / state status). |
| `th revise bump` | — (CLI-only) | Revise-loop counter is Critic-loop CLI machinery; not an MCP coordination surface. |
| `th revise status` | — (CLI-only) | Revise-loop counter is Critic-loop CLI machinery; not an MCP coordination surface. |
| `th revise reset` | — (CLI-only) | Revise-loop counter is Critic-loop CLI machinery; not an MCP coordination surface. |
| `th tier classify` | — (CLI-only) | Advisory brief classifier (reads a brief.json file); the gated th_tier_record is the MCP write path. |
| `th tier veto-check` | — (CLI-only) | CLI/CI exit-code veto gate; the gated th_tier_record enforces the veto on the MCP write path. |
| `th tier record` | `th_tier_record` | mirrored |
| `th tier features` | — (CLI-only) | Operator inspection of the feature-activation layer; the MCP gate enforces it inline (tier_locked). |
| `th stage advance` | `th_stage_advance` | mirrored |
| `th stage current` | `th_stage_current` | mirrored |
| `th stage describe` | `th_stage_describe` | mirrored |
| `th stage list` | `th_stage_list` | mirrored |
| `th implementation unlock` | `th_implementation_unlock` | mirrored |
| `th artifact register` | `th_artifact_register` | mirrored |
| `th artifact list` | `th_artifact_list` | mirrored |
| `th artifact section` | `th_artifact_section` | mirrored |
| `th artifact claim` | `th_artifact_claim` | mirrored |
| `th artifact release` | `th_artifact_release` | mirrored |
| `th artifact leases` | `th_artifact_leases` | mirrored |
| `th research write` | `th_research_write` | mirrored |
| `th coverage check` | `th_coverage_check` | mirrored |
| `th coverage report` | `th_coverage_report` | mirrored |
| `th verify add` | `th_verify_add` | mirrored |
| `th verify list` | `th_verify_list` | mirrored |
| `th verify approve` | — (CLI-only) | Human-confirms a verify command SET for execution (provenance gate); CLI/human-only. |
| `th verify clear` | `th_verify_clear` | mirrored |
| `th verify run` | `th_verify_run` | mirrored |
| `th build plan` | `th_build_plan` | mirrored |
| `th build next-wave` | `th_build_next_wave` | mirrored |
| `th build dispatch` | `th_build_dispatch` | mirrored |
| `th build claim` | `th_build_claim` | mirrored |
| `th build release` | `th_build_release` | mirrored |
| `th build sub-claim` | `th_build_sub_claim` | mirrored |
| `th build sub-release` | `th_build_sub_release` | mirrored |
| `th build leases` | — (CLI-only) | Lease inspection convenience; agents read th_build_dispatch / th_build_next_wave. |
| `th debug pack` | — (CLI-only) | Debugger evidence-bundle CLI surface (read-first orientation); not an MCP coordination tool. |
| `th debug log add` | — (CLI-only) | Debugger evidence ledger; not an MCP coordination tool. |
| `th debug log list` | — (CLI-only) | Debugger evidence ledger; not an MCP coordination tool. |
| `th anchors scan` | — (CLI-only) | REQ-anchor/CI exit-code surface; not an MCP coordination tool. |
| `th trace render` | — (CLI-only) | On-demand traceability render; not an MCP coordination tool. |
| `th stale` | — (CLI-only) | Diff-scoped staleness CLI surface; not an MCP coordination tool. |
| `th slices sync` | `th_slices_sync` | mirrored |
| `th slice set-status` | `th_slice_set_status` | mirrored |
| `th drift add` | `th_drift_add` | mirrored |
| `th drift list` | `th_drift_list` | mirrored |
| `th drift resolve` | `th_drift_resolve` | mirrored |
| `th sim add` | `th_sim_add` | mirrored |
| `th sim list` | `th_sim_list` | mirrored |
| `th sim retire` | `th_sim_retire` | mirrored |
| `th sim scan` | `th_sim_scan` | mirrored |
| `th tester record` | `th_tester_record` | mirrored |
| `th approve` | `th_approve` | mirrored |
| `th gate production-reality` | `th_gate_production_reality` | mirrored |
| `th collab init` | `th_collab_init` | mirrored |
| `th collab fragment` | `th_collab_fragment` | mirrored |
| `th collab list` | `th_collab_list` | mirrored |
| `th collab merge` | `th_collab_merge` | mirrored |
| `th debate add` | `th_debate_add` | mirrored |
| `th debate list` | `th_debate_list` | mirrored |
| `th debate resolve` | `th_debate_resolve` | mirrored |
| `th hook stop-gate` | — (CLI-only) | Claude Code Stop-hook protocol; not an agent tool. |
| `th hook pretool-gate` | — (CLI-only) | Claude Code PreToolUse write-gate protocol; not an agent tool. |
| `th hook subagent-stop` | — (CLI-only) | Claude Code SubagentStop-hook protocol; not an agent tool. |
| `th migrate` | — (CLI-only) | Destructive state schema rewrite; CLI/human-only (th_init is the safe idempotent MCP entry). |
| `th doctor` | `th_doctor` | mirrored |
| `th next` | `th_next` | mirrored |
| `th preview` | — (CLI-only) | Pre-run pipeline preview (operator orientation); the MCP th_stage_* tools expose stage contracts. |
| `th scorecard` | `th_scorecard` | mirrored |
| `th route` | `th_route` | mirrored |
| `th telemetry on` | — (CLI-only) | Local-only operator opt-in; not an agent capability. |
| `th telemetry off` | — (CLI-only) | Local-only operator opt-in; not an agent capability. |
| `th telemetry status` | — (CLI-only) | Local-only operator opt-in; not an agent capability. |
| `th context estimate` | — (CLI-only) | Prompt-surface estimator (operator sizing); th_context_pack/th_budget_check are the MCP context surfaces. |
| `th context pack` | `th_context_pack` | mirrored |
| `th context read` | `th_context_read` | mirrored |
| `th budget check` | `th_budget_check` | mirrored |
| `th handoff write` | `th_handoff_write` | mirrored |
| `th handoff verify` | — (CLI-only) | Resume-integrity CLI check; th_handoff_write is the MCP handoff surface. |
| `th resume` | — (CLI-only) | Resume detector (prints th next); agents call th_next directly. |
| `th inspector write` | `th_inspector_write` | mirrored |
| `th delegate plan` | `th_delegate_plan` | mirrored |
| `th delegate pack` | `th_delegate_pack` | mirrored |
| `th delegate capsule` | — (CLI-only) | Prints a blank capsule skeleton; a static template, not a coordination tool. |
| `th delegate check` | `th_delegate_check` | mirrored |
| `th repo map` | `th_repo_map` | mirrored |
| `th repo check` | `th_repo_check` | mirrored |
| `th repo relevant` | `th_repo_relevant` | mirrored |
| `th repo impact` | `th_repo_impact` | mirrored |
| `th repo search` | `th_repo_search` | mirrored |
| `th decision detect` | `th_decision_detect` | mirrored |
| `th decision add` | `th_decision_add` | mirrored |
| `th decision approve` | — (CLI-only) | HUMAN-ONLY TTY-gated transition (RULE-011); permanently absent from MCP. |
| `th decision check` | `th_decision_check` | mirrored |
| `th decision list` | `th_decision_list` | mirrored |
| `th manifest export` | — (CLI-only) | Deterministic run-snapshot CLI surface; agents read th_scorecard / th_state_get. |
| `th manifest tools` | — (CLI-only) | MCP advertises tools natively via ListTools; this is the CLI mirror. |
| `th template get` | `th_template_get` | mirrored |
| `th template list` | `th_template_list` | mirrored |
| `th version` | — (CLI-only) | CLI meta; the MCP server advertises version via the protocol. |
| `th help` | — (CLI-only) | CLI meta; MCP clients read tool descriptions, not `th help`. |
| `th_blast_radius_record` | — (MCP-only) | Typed gate setter; the CLI reaches blast_radius only via `th state set ... --emergency`. |
| `th_write_gate_set` | — (MCP-only) | Typed gate setter; the CLI reaches write_gate only via `th state set write_gate ... --emergency`. |
| `th_interview_start` | — (MCP-only) | MCP-driven scored interview (no `th interview` CLI group; the agent supplies all judgment). |
| `th_interview_record` | — (MCP-only) | MCP-driven scored interview (no `th interview` CLI group; the agent supplies all judgment). |
| `th_interview_status` | — (MCP-only) | MCP-driven scored interview (no `th interview` CLI group; the agent supplies all judgment). |

#### MCP tool roster (exhaustive — all 76)

Every registered MCP tool name, in registry order. The CLI↔MCP parity test pins this list against `TOOL_DEFS.map(t => t.name)`, so a tool added/removed/renamed without updating this roster fails CI.

- `th_state_get`
- `th_state_set`
- `th_tier_record`
- `th_stage_advance`
- `th_implementation_unlock`
- `th_write_gate_set`
- `th_blast_radius_record`
- `th_drift_add`
- `th_drift_list`
- `th_drift_resolve`
- `th_build_next_wave`
- `th_build_claim`
- `th_build_release`
- `th_build_dispatch`
- `th_build_plan`
- `th_route`
- `th_coverage_check`
- `th_coverage_report`
- `th_next`
- `th_delegate_plan`
- `th_delegate_pack`
- `th_delegate_check`
- `th_repo_map`
- `th_repo_relevant`
- `th_repo_impact`
- `th_context_pack`
- `th_build_sub_claim`
- `th_build_sub_release`
- `th_repo_check`
- `th_decision_detect`
- `th_decision_add`
- `th_decision_check`
- `th_decision_list`
- `th_artifact_register`
- `th_artifact_list`
- `th_artifact_claim`
- `th_artifact_release`
- `th_artifact_leases`
- `th_collab_init`
- `th_collab_fragment`
- `th_collab_list`
- `th_collab_merge`
- `th_debate_add`
- `th_debate_list`
- `th_debate_resolve`
- `th_verify_add`
- `th_verify_list`
- `th_verify_clear`
- `th_verify_run`
- `th_stage_current`
- `th_stage_describe`
- `th_stage_list`
- `th_doctor`
- `th_scorecard`
- `th_slices_sync`
- `th_slice_set_status`
- `th_interview_start`
- `th_interview_record`
- `th_interview_status`
- `th_init`
- `th_budget_check`
- `th_handoff_write`
- `th_template_get`
- `th_template_list`
- `th_repo_search`
- `th_context_read`
- `th_artifact_section`
- `th_research_write`
- `th_sim_add`
- `th_sim_list`
- `th_sim_retire`
- `th_sim_scan`
- `th_gate_production_reality`
- `th_inspector_write`
- `th_tester_record`
- `th_approve`

<!-- END AUTO-GENERATED: command-reference -->

#### Brownfield workflow (REQ-RU-060/062)

In a brownfield run (`th init --brownfield`), the repo-understanding layer integrates into the pipeline:

1. The Codebase-Inspector writes prose analysis (`docs/00-existing-codebase-analysis.md`). This is human-readable orientation; it can rot.
2. `th repo map` produces the machine-readable `repo-map` — the durable, byte-stable source of truth that moves with the code.
3. Slice 0 characterizes the adoption seam; the Builder uses `th repo relevant` to find related files and `th repo impact` to assess blast radius before editing.
4. The Critic compares ownership (component membership in the map vs. what the slice claims to touch).
5. The Debugger uses `th repo impact` and `th repo relevant` to find related files and tests when tracing a defect.

The prose (`docs/00-existing-codebase-analysis.md`) and the machine `repo-map` are complementary. The machine map is the mechanical input to `th repo relevant`/`impact`; the prose is human orientation. Both are produced once per run; the map is always regenerable with `th repo map`.

### Using `th` in CI

The exit-code gates compose into CI checks for a TwinHarness-built project:

```yaml
- run: node <plugin-or-clone>/dist/cli.js state verify --cwd .
- run: node <plugin-or-clone>/dist/cli.js coverage check --cwd .
- run: node <plugin-or-clone>/dist/cli.js anchors scan --strict --cwd .
```

Any of them failing means the artifact/code/test contract drifted without going through the
process.

### Complete flag reference

Every flag the `th` parser recognizes, grouped by kind. The parenthetical names the command(s) the
flag applies to. (`--json` and `--cwd` are accepted on every command.)

**Global (every command):**

| Flag | Effect |
|---|---|
| `--json` | Emit machine-readable JSON on stdout. |
| `--cwd <dir>` | Operate against `<dir>` instead of the current directory. |

**Boolean flags (presence = true):**

| Flag | Command(s) | Effect |
|---|---|---|
| `--force` | `init`; `collab fragment` | Reset an existing `state.json` (`init`); overwrite an existing fragment (`collab fragment`). |
| `--brownfield` | `init` | Scaffold a brownfield run (`project_mode=brownfield`). |
| `--include-done` | `build plan` | Schedule slices already `done` (default: only unfinished). |
| `--advise` | `build plan` | Emit the parallelism-optimizer advisory (max wave width + serializing conflict pairs). |
| `--scan-reqs` | `anchors scan` | Scan `docs/` for REQ-anchors. |
| `--scan-tests` | `anchors scan` | Scan `tests/` for REQ-anchors. |
| `--scan-code` | `anchors scan` | Scan `src/` for REQ-anchors. |
| `--strict` | `anchors scan`; `doctor` | Exit 1 on orphan anchors (`anchors`); escalate ledger-chain break + unknown state keys to a hard fail (`doctor`). |
| `--dry-run` | `slices sync`; `repo map` (alias `--no-write`) | Compute without writing. |
| `--remove-missing` | `slices sync` | Remove slices absent from the plan. |
| `--explain` | `next` | Add a WHY string explaining why the reported obligation outranks the others. |
| `--hotspots` | `scorecard` | Per-stage token + wall-clock cost table from local telemetry. |
| `--writes` | `delegate plan` | The task modifies source code (a delegate signal). |
| `--noisy` | `delegate plan` | The task runs noisy commands / logs / tests / repo scans (a delegate signal). |
| `--component-blast` | `route` | Target slice touches a blast-radius component → escalate the model. |
| `--summarization` | `route` | Trivial mechanical summarization → route to the cheapest model. |
| `--write` / `--no-write` | `repo map` | Write the artifacts (default) / dry-preview, write nothing. |
| `--reject` | `decision approve` | Append a `rejected` event (mutually exclusive with `--supersede`). |
| `--lock` | `implementation unlock` | Re-lock implementation (`implementation_allowed=false`) instead of unlocking. |
| `--emergency` | `state set` | Force a raw write to a gate-owned field, bypassing the typed gate ladder (loud + audit-ledgered). |

**String-valued flags (`--flag value` or `--flag=value`):**

| Flag | Command(s) | Effect |
|---|---|---|
| `--reqs <file>` | `coverage` | Requirements file (default `docs/01-requirements.md`). |
| `--plan <file>` | `coverage`; `slices sync` | Implementation-plan file (default `docs/09-implementation-plan.md`). |
| `--tests <dir>` | `coverage` | Tests directory (default `tests`). |
| `--scope <file>` | `coverage` | Scope file for MVP filtering (default `docs/02-scope.md`). |
| `--code <dir>` | `coverage report` | Code directory scanned for *implemented* (default `src`). |
| `--tier <T0-T3>` | `preview`; `route` | Tier whose pipeline to preview / tier for routing. |
| `--slice <id>` | `context pack`; `debug pack`; `delegate plan`/`pack`; `repo relevant` | Frame the pack/handoff/query for a SLICE-ID. |
| `--components <c1,c2>` | `build sub-claim` | Comma-separated component subset for the sub-lease. |
| `--req <REQ-ID>` | `debug pack`; `repo relevant` | Frame the pack / select by a REQ-ID. |
| `--symptom <s>` | `debug log add` | The observed failure. |
| `--evidence <s>` | `debug log add` | Anchored evidence (file:line / captured output). |
| `--root-cause <s>` | `debug log add` | The identified root cause. |
| `--status <s>` | `debug log add` | `open` \| `resolved` (default `open`). |
| `--since <hash>` | `stale` | Recorded hash of the upstream artifact to check. |
| `--artifact <file>` | `stale` | Root-relative file key of the artifact to check. |
| `--layer <l>` | `drift add` | `derived` \| `requirement` (**required**). |
| `--ref <s>` | `drift add`; `debug log add` | `SLICE-x / TASK-y` reference. |
| `--discovery <s>` | `drift add` | What was discovered. |
| `--action <s>` | `drift add` | Action taken. |
| `--escalation <s>` | `drift add` | Escalation status. |
| `--source <s>` | `drift add`; `debate add` | Who logged the entry (default `Builder`). |
| `--agent <a>` | `route`; `delegate pack` | The agent being spawned / delegated to. |
| `--mode <M>` | `route` | The stage/Critic mode for routing. |
| `--brief <s>` | `route` | Free-text brief for routing context. |
| `--intent <i>` | `delegate plan`/`pack` | `read`\|`write`\|`debug`\|`review`\|`artifact`\|`repo-analysis`. |
| `--task <s>` | `delegate plan`/`pack` | Free-text task label (echoed; not parsed). |
| `--capsule <path>` | `delegate check` | Capsule file to validate. |
| `--format <f>` | `repo map` (`summary`\|`json`\|`md`); `repo relevant` (`slice`\|`req`\|`file`\|`json`); `repo impact` (`file`\|`json`) | Text rendering. |
| `--query <kw>` | `repo relevant` | Keyword/phrase selector. |
| `--file <path>` | `repo relevant`; `repo impact` | File-path selector (path guard fires first). |
| `--component <name\|path>` | `repo impact` | Component selector (path guard fires first). |
| `--title <t>` | `decision add` | Decision title (**required**). |
| `--rationale <r>` | `decision add` | Decision rationale (**required**). |
| `--links <a,b>` | `decision add`; `debate add` | Comma-separated REQ-IDs / ADR-ids / stage ids. |
| `--proposer <n>` | `decision add` | Proposer attribution (default `orchestrator`). |
| `--supersede <id>` | `decision approve` | Mark this approved decision superseded by `<id>`. |
| `--as <actor>` | `decision approve` | Approver attribution only — not a barrier. |
| `--stage <s>` | `collab init`/`fragment`/`list`/`merge` | The blackboard stage. |
| `--round <r>` | `collab fragment`/`list`/`merge` | The fan-out round. |
| `--name <n>` | `collab fragment` | The fragment name (single in-root component). |
| `--text <t>` | `collab fragment` | The fragment body. |
| `--section <file#section>` | `artifact claim`/`release` | Section-level artifact lease key (also a positional). |
| `--holder <id>` | `artifact claim`/`release` | Lease holder id. |
| `--topic <t>` | `debate add` | Debate topic (also a positional). |
| `--positions <…>` | `debate add` | The contested positions. |
| `--id <DEBATE-ID>` | `debate resolve` | Debate to resolve (also a positional). |
| `--resolution <r>` | `debate resolve` | The resolution note. |

**Number-valued flags:**

| Flag | Command(s) | Effect |
|---|---|---|
| `--cap <n>` | `revise bump`/`status` | Override the revise-loop cap (default 3; positive integer). |
| `--version <n>` | `artifact register` | Artifact version (positive integer). |
| `--files <n>` | `delegate plan` | Expected file reads (delegate when > 3). |
| `--maxResults <n>` | `repo relevant` | Cap on combined emitted items (default 20; ≤ 0 = default). |
| `--max-tokens <k>` | `init` | Per-session context budget in **thousands** (×1000 → `max_tokens`). |
| `--max <k>` | `budget check` | Budget override in **thousands** (default `state.max_tokens`, else tier default). |
| `--files-read <n>` | `budget check` | Proxy: files read so far. |
| `--slices-built <n>` | `budget check` | Proxy: slices built so far. |
| `--tool-calls <n>` | `budget check` | Proxy: tool calls so far. |
| `--artifacts <n>` | `budget check` | Proxy: approved artifacts carried. |

---

## Part 4 — Customization & development

### Repository layout

```
.claude-plugin/   plugin manifest + marketplace.json (installation wiring)
.github/          CI workflow (ci.yml — typecheck, build, dist-sync, test on every push/PR)
agents/           16 agent prompt files
commands/         16 Claude Code command files (4 original + 12 curated th-* verbs)
dist/             compiled CLI — committed on purpose; no build step at install time
hooks/            Stop hook wiring (hooks.json → th hook stop-gate)
schemas/          published JSON Schemas for state.json and brief.json (draft-07; editor validation)
skills/           twinharness/ SKILL.md (lean core) + reference/ (on-demand playbook references)
spec/             frozen spec (TwinHarness-Plan.md) + build plan (build-plan.md)
src/              TypeScript source for the th CLI
templates/        artifact skeletons for each SDLC stage (01 through 10 + task-file.md)
tests/            REQ-anchored vitest suite
CONTRIBUTING.md   dev loop, committed-dist/ invariant, plugin-packaging invariants
SECURITY.md       threat model (gate scope, Bash bypass, global hook, prompt injection, path containment)
```

CI (`npm ci` → `npm run typecheck` → `npm test` → `npm run build` → `git diff --exit-code dist/`)
runs on every push and pull request, enforcing the committed-`dist/` invariant. See
`CONTRIBUTING.md` for the full developer setup and plugin-packaging rules.

### Templates

The artifact skeletons live in the plugin's `templates/` directory (`01-requirements.md` …
`10-verification-report.md`, plus `task-file.md`, `04a-ux-design.md`, and `04b-ui-design.md`). Editing them changes
what every future stage emits. Keep the **Summary** block at the top of each template — it is the
handoff currency — and keep REQ-ID anchor patterns intact, or `coverage`/`anchors`/`trace` lose
their inputs.

### Developing the plugin itself

```
npm install        # dev deps only (typescript, vitest)
npm run build      # src/ -> dist/
npm test           # REQ-anchored vitest suite (incl. plugin-packaging integrity)
```

Three invariants are enforced by `tests/plugin-manifest.test.ts` — do not fight them:

- **`dist/` is committed.** Plugin installs copy the repo with no build step, so after editing
  `src/`, rebuild and commit `dist/` together with the source.
- **Components never call a bare `th`.** Every skill/command/agent resolves the CLI via
  `${CLAUDE_PLUGIN_ROOT}/dist/cli.js` (substituted by Claude Code at load time), because installed
  users don't have `th` on PATH.
- **16 agents, 16 commands, 1 skill.** The manifest test verifies these counts automatically via
  `readdirSync` — adding or removing agents will surface immediately.
- **Version sync.** `plugin.json` version must equal `package.json` version.

After changing plugin components, reinstall (or `/plugin marketplace update twinharness` then
update the plugin) and restart the session; `claude --plugin-dir .` is the fast loop for testing.

### Uninstall

```
claude plugin uninstall twinharness@twinharness
claude plugin marketplace remove twinharness
```

A project's run artifacts (`docs/`, `.twinharness/`, `drift-log.md`) are plain files in *your*
repo — they survive uninstall and contain everything needed to resume after a reinstall.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Session "can't finish" — keeps getting pushed back to work | The stop-gate is blocking: run `/twinharness:th-escalate`. Either `state.json` is invalid (`th state verify` lists exactly what's wrong), blocking drift is open (`th drift list`, then decide and `th drift resolve DRIFT-NNN`), or the run is at `final-verification` with incomplete slices (`th state status` shows which; use `th slice set-status <SLICE-ID> done` or `blocked` for each). |
| `{"error":"not_initialized"}` | No run in this directory. Start one (`/twinharness:th-run <idea>`) or pass `--cwd` to point at the right project. |
| `th state set tier T0` refused | A blast-radius flag is recorded — that's the veto floor working. Clear the flags only if they are genuinely wrong, or accept Tier ≥ 1. |
| `th state set <key> <value>` → `unknown_field` | The key is not a recognized top-level state field. Check `th state status` for the valid schema. |
| `th state set drift_open_blocking <n>` → `managed_field` | `drift_open_blocking` is owned by the drift flow. Use `th drift add --layer requirement` to increment and `th drift resolve DRIFT-NNN` to decrement; do not bypass the owning command. |
| `th drift resolve DRIFT-NNN` fails | Either the ID doesn't exist (`drift_not_found`) or it was already resolved (`already_resolved`). Run `th drift list` to see current entries. |
| `coverage check` fails before build | An MVP REQ-ID has no slice or no test. Re-enter the Vertical Slice stage; do not hand-wave the gap. |
| Critic loop stuck at the cap | By design: round 3 reached with open grounded issues. The open issues are now yours to decide — `/twinharness:th-escalate` lists them. |
| Commands not found after install | Restart the session (plugins load at startup). Verify with `claude plugin list`. |
| Hook errors about a missing `dist/cli.js` | The installed copy predates a fix, or a dev clone wasn't rebuilt: update the marketplace + plugin, or `npm run build` in the clone. |
| `.agentic-sdlc` directory not recognized | Upgrade to v0.2.0+ which reads `.agentic-sdlc` automatically as a legacy fallback. Or rename the folder to `.twinharness`. |
| Edit or write was blocked / asked about by the write-gate | You are in a project with an active TwinHarness run. If you haven't finished the pre-build gates, the write-gate is doing its job: either finish the design stages and let the Orchestrator set `implementation_allowed true`, or run `th state set write_gate off` to disable gating for this run, or set `TH_DISABLE_WRITE_GATE=1` in your shell to bypass for the current session only. If you're mid-build and the gate fired, it is a component-boundary signal: a file you are editing belongs to a slice that is not `in-progress`. Check `th state status` and ensure the Orchestrator called `th slice set-status <SLICE-ID> in-progress` before your Builder started. |
| Bash command blocked by write-gate in Phase A | The Bash defense-in-depth matcher detected a shell-mediated write (e.g. `>`, `tee`, `sed -i`) into an implementation path during Phase A. Same unlock paths as above: finish upstream gates and let the Orchestrator set `implementation_allowed true`, disable the gate with `th state set write_gate off`, or bypass for the session with `TH_DISABLE_WRITE_GATE=1`. |
| `th migrate` → `schema_too_new` | `state.json` was written by a newer version of `th`. Upgrade the plugin to match; `th` never downgrades a state file. |
| `state lock timeout` error | A previous `th` invocation crashed while holding the cross-process lock (`.twinharness/.state.lock`). Run `th doctor` to confirm the lock is stale, then remove `.twinharness/.state.lock` if no `th` process is currently running. |

### FAQ

**Can I skip a gate?** Streaming stages, yes — they never blocked you. Sticky gates (requirements,
scope, auth, blocking drift), no: they exist precisely because those calls are yours. The honest
shortcut is a lower tier, and `th tier classify` will tell you if the project qualifies.

**Can I edit `docs/` artifacts by hand?** Yes — they're your files. But run `th stale --artifact
<file>` first to see what downstream artifacts would become stale, then re-register the changed
artifact (`th artifact register <file> --version <n+1>`) and run diff-scoped Critic passes on each
stale artifact so the harness governs from a hash that matches reality.

**Why did it refuse to pick an auth scheme by itself?** Auth is blast-radius. Every
authentication/authorization decision is human-gated by design — the model proposes, you choose.

**Does the stop-gate affect my other projects?** No. With no `.twinharness/state.json` (or
`.agentic-sdlc/state.json`) in the working directory, the gate always allows.

**Does `th stale` diff summaries?** No. `th stale` returns all registered downstream artifacts
of the changed file in pipeline order — every registered downstream artifact is returned when the
hash has changed. The Critic then does a diff-scoped review, but `th stale` itself does not analyze
the content.
