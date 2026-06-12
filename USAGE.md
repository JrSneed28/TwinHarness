# TwinHarness Usage Guide

From first install to advanced CLI surgery. This guide is organized in four parts:

1. [Getting started](#part-1--getting-started) — install, first run, what you'll be asked
2. [Understanding a run](#part-2--understanding-a-run) — tiers, stages, the Critic loop, drift, gates
3. [The `th` CLI](#part-3--the-th-cli-advanced) — full command reference, state schema, exit codes
4. [Customization & development](#part-4--customization--development) — templates, dev workflow, troubleshooting

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

Requirements: Node ≥ 18 on PATH (the bundled `th` CLI has zero runtime dependencies).

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
6. **UI design direction** (when your project has a user interface). A fresh-context UI Designer
   presents 2–3 distinct design directions with ASCII mockup previews and asks you to choose.
   This is the one taste-driven gate: after you pick a direction, the detailed design streams
   past you.
7. **Slice plan, then build.** A fresh-context agent decomposes the design into **vertical slices**
   — each one a thin end-to-end capability you can see working — and Builders implement them
   slice-by-slice, tests included, with a code-review Critic after each slice.
8. **Documentation.** After all slices pass, a Doc-Writer agent generates tier-appropriate docs
   (T1: readme only; T2: readme + user guide + API reference; T3: full suite). A Critic reviews the
   docs; no human gate.
9. **Verification.** A final report separates what the Critic can certify (coherence) from what
   only tests and you can certify (correctness), and you sign off.

### The commands

| Invocation | When to use it |
|---|---|
| `/twinharness:th-run <idea>` | Start a new run — or resume an interrupted one (it picks up from `state.json`) |
| `/twinharness:th-status` | Where am I? Tier, current stage, gates, slices, open drift |
| `/twinharness:th-drift` | Review the drift log: skim auto-applied doc updates, decide blocked escalations |
| `/twinharness:th-escalate` | Show everything currently waiting on a *human* decision |

The `twinharness` skill itself (`/twinharness:twinharness`) is the full Orchestrator playbook;
Claude also invokes it automatically when you ask for spec-driven, stage-gated development in prose.

### What you will be asked (and what you won't)

You **will** be gated on: requirements sign-off, scope sign-off, the 1–2 genuinely irreversible
architecture choices, UI design direction (when your project has a UI), any authentication/authorization
decision, the security model (when one is produced), data-loss tradeoffs, blocking drift resolutions,
and final correctness sign-off.

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
| **T1** — simple | Requirements → Scope → Architecture (light; Security + Failure-Modes folded in) → [UI Design if UI] → Slice Plan → Code → Documentation (readme) → Verify |
| **T2** — medium | Requirements → Scope → Domain Model → Architecture (folded sections) → [UI Design if UI] → Contracts → Test Strategy → Slice Plan → Code → Documentation (readme + user-guide + api-reference) → Verify |
| **T3** — large/critical | Requirements → Scope → Domain Model → Architecture → [UI Design if UI] → ADRs → Technical Design → Contracts → **Security** (standalone) → **Failure Modes** (standalone) → Test Strategy → Slice Plan → Code → Documentation (full suite) → Final Verification |

### Stage 4b — UI Design (conditional)

For any project with a web UI, mobile UI, desktop UI, or rich TUI, the UI Designer agent runs after
Architecture is approved. It presents **2–3 distinct design directions** via `AskUserQuestion` with
ASCII mockups. You pick a direction (taste-driven → gated by §2), then the detailed design streams
without further gates. The Critic reviews the result in `ui-design` mode. CLIs, background services,
and pure API libraries skip this stage.

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
| Default (all agents) | frontmatter default (sonnet; opus for orchestrator & vertical-slice) |
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

After every producer (Spec, UI Designer, Vertical-Slice, Builder, Doc-Writer) finishes a draft, a
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

Set it with `th state set write_gate deny` (or `ask`, `off`). The field is absent by default (behaves as `ask`).

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
on another project).

### Lifecycle & state

```
th init [--force]                  Scaffold docs/, .twinharness/state.json, drift-log.md
th state get [dotted.path]         Print state (or one value: th state get slices[0].status)
th state set <dotted.key> <value>  Patch one value; REFUSES writes that would invalidate state; REJECTS unknown top-level keys
th state status                    Human-readable tier/stage/gates/slices snapshot
th state verify                    Exit 0 = valid; non-zero with a precise issue list otherwise
```

`state set` JSON-parses the value (`true` → boolean, `3` → number, `["a"]` → array) and falls back
to a bare string. Dotted paths support array indices. Because every write is re-validated against
the schema, illegal states — e.g. `tier T0` while a blast-radius flag is set — are mechanically
unwritable. Attempts to set an unknown top-level key exit with `unknown_field`. Attempts to set a
**managed field** (one owned by a dedicated command) exit with `managed_field` — see the
`drift_open_blocking` row in the schema table below.

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
| `write_gate` | `"ask"` \| `"deny"` \| `"off"` \| absent | PreToolUse write-gate semantics; absent = `ask`; use `th state set write_gate <value>` to configure |
| `open_questions` | string[] | Unresolved questions blocking advancement |
| `drift_open_blocking` | number | Open requirement-layer escalations; stop-gate blocks while > 0. **Managed field** — `state set` refuses writes; use `th drift add` / `th drift resolve` to modify. |
| `revise_loop_counts` | {mode: count} | Critic-loop round counters per mode |

### Tiering

```
th tier classify <brief.json>      Advisory: Tier-0 eligibility + detected flags
th tier veto-check <brief.json>    Mechanical: exit 3 + {"blocked":true,"flags":[...]} if any flag
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
judgment). `veto-check` is not advisory: it is an exit-code gate.

### Critic loop bookkeeping

```
th revise bump <mode> [--cap N]    Increment a mode's round count; reports escalate = count >= cap
th revise status <mode> [--cap N]  Read count/cap/escalate without mutating
th revise reset <mode>             Zero the counter (stage passed)
```

Modes are stage names (`requirements`, `scope`, `architecture`, `slice`, `code-review`,
`documentation`, `ui-design`, …). Default cap 3. The CLI computes `escalate`; the Orchestrator
decides what to do about it.

### Artifacts, coverage, traceability

```
th artifact register <file> --version <n>   Hash + record in approved_artifacts
th artifact list                            What's registered (file, version, hash)
th coverage check [--reqs F] [--plan F] [--tests D] [--scope F]
th anchors scan [--scan-reqs] [--scan-tests] [--scan-code] [--strict]
th trace render                             The full traceability view, rendered on demand
th stale --since <hash>                     Diff-scoped downstream staleness (look up by recorded hash)
th stale --artifact <file>                  Same lookup, by file key (safe before re-registering)
```

- **Coverage** asserts every MVP REQ-ID maps to ≥ 1 slice *and* ≥ 1 test. Non-zero exit = the
  build may not start. Scans tests/ **fully recursively** in any language; applies MVP filter from
  `docs/02-scope.md`'s `## MVP Scope` section (or `--scope <file>` override). Defaults:
  `--reqs docs/01-requirements.md --plan docs/09-implementation-plan.md --tests tests`.
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
th build plan [--include-done]
```

Reads `state.slices` (populated by `th slices sync`) and computes the §16 wave schedule: disjoint
component sets → same wave (safe to run Builders concurrently), shared component → later wave
(serialized). By default only unfinished slices are scheduled. `th build plan` does NOT read the
raw plan file — always run `th slices sync` first.

### Version

```
th version
```

Prints the CLI version from `package.json`. Useful for confirming which plugin version is active.

### Diagnostics & run inspection

```
th doctor
```

Self-diagnostic for environment and project health. Reports:

- **Node version** — fails hard if below 18 (the minimum requirement).
- **Plugin CLI** — whether `dist/cli.js` is present next to the running binary.
- **Plugin version** — from `package.json`.
- **state.json validity** — valid + tier/stage summary; or a precise issue list if invalid.
- **Schema version** — whether `state.json` is at the current `schema_version`; warns and
  suggests `th migrate` if behind.
- **Blocking drift** — count of open requirement-layer escalations; warns if any are open.
- **Stale state lock** — warns if `.twinharness/.state.lock` is present with age (a crashed `th`
  left the lock behind; safe to remove if no `th` process is running).
- **Audit ledger size** — number of entries in `gate-ledger.jsonl`.

Exit non-zero only on hard failures (unsupported Node version, invalid `state.json`). Informational
warnings (outdated schema, open drift, stale lock) exit 0. Never mutates anything.

```
th context estimate
```

Approximates the prompt-surface token cost of the plugin's skill, agent, and command files
(heuristic: ~4 chars/token). Flags any file exceeding Claude Code's ~500-line / ~5,000-token
re-attach guidance — these are the files that risk losing their tail after context compaction on
long runs. The on-demand `skills/twinharness/reference/` files are expected to exceed the threshold
by design (they load only when needed for a given stage or mode, not on every turn). All
always-loaded core files are within the guidance.

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

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General failure (invalid state, unknown command, missing args, `unknown_field` on `state set`, `drift_not_found` / `already_resolved` on `drift resolve`) |
| 3 | Blast-radius veto (`th tier veto-check` blocked) |

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

### Using `th` in CI

The exit-code gates compose into CI checks for a TwinHarness-built project:

```yaml
- run: node <plugin-or-clone>/dist/cli.js state verify --cwd .
- run: node <plugin-or-clone>/dist/cli.js coverage check --cwd .
- run: node <plugin-or-clone>/dist/cli.js anchors scan --strict --cwd .
```

Any of them failing means the artifact/code/test contract drifted without going through the
process.

---

## Part 4 — Customization & development

### Repository layout

```
.claude-plugin/   plugin manifest + marketplace.json (installation wiring)
.github/          CI workflow (ci.yml — typecheck, build, dist-sync, test on every push/PR)
agents/           7 agent prompt files
commands/         4 Claude Code command files (th-run, th-status, th-drift, th-escalate)
dist/             compiled CLI — committed on purpose; no build step at install time
hooks/            Stop hook wiring (hooks.json → th hook stop-gate)
schemas/          published JSON Schemas for state.json and brief.json (draft-07; editor validation)
skills/           twinharness/ SKILL.md (lean core) + reference/ (on-demand playbook references)
spec/             frozen spec (TwinHarness-Plan.md) + build plan (build-plan.md)
src/              TypeScript source for the th CLI
templates/        artifact skeletons for each SDLC stage (01 through 10 + task-file.md)
tests/            REQ-anchored vitest suite
examples/         example TwinHarness runs
CONTRIBUTING.md   dev loop, committed-dist/ invariant, plugin-packaging invariants
SECURITY.md       threat model (gate scope, Bash bypass, global hook, prompt injection, path containment)
```

CI (`npm ci` → `npm run typecheck` → `npm test` → `npm run build` → `git diff --exit-code dist/`)
runs on every push and pull request, enforcing the committed-`dist/` invariant. See
`CONTRIBUTING.md` for the full developer setup and plugin-packaging rules.

### Templates

The artifact skeletons live in the plugin's `templates/` directory (`01-requirements.md` …
`10-verification-report.md`, plus `task-file.md` and `04b-ui-design.md`). Editing them changes
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
- **7 agents, 4 commands, 1 skill.** The manifest test verifies these counts automatically via
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
