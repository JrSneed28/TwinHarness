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
vertical-slice implementation plan → slice-by-slice build → final verification.

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
   `docs/` (the artifacts), `.agentic-sdlc/state.json` (machine-readable run state — never edit it
   by hand), and `drift-log.md` (the build's discovery journal).
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
6. **Slice plan, then build.** A fresh-context agent decomposes the design into **vertical slices**
   — each one a thin end-to-end capability you can see working — and Builders implement them
   slice-by-slice, tests included, with a code-review Critic after each slice.
7. **Verification.** A final report separates what the Critic can certify (coherence) from what
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
architecture choices, any authentication/authorization decision, the security model (when one is
produced), data-loss tradeoffs, blocking drift resolutions, and final correctness sign-off.

You will **not** be gated on: domain models, ADRs, technical design, contracts (minus auth),
test strategy, the slice plan, or each slice's code — those stream past you with a Critic check
instead. Interrupt whenever you like; approval is not required.

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
| **T1** — simple | Requirements → Scope → Architecture (light; Security + Failure-Modes folded in) → Slice Plan → Code → Verify |
| **T2** — medium | Requirements → Scope → Domain Model → Architecture (folded sections) → Contracts → Test Strategy → Slice Plan → Code → Verify |
| **T3** — large/critical | Requirements → Scope → Domain Model → Architecture → ADRs → Technical Design → Contracts → **Security** (standalone) → **Failure Modes** (standalone) → Test Strategy → Slice Plan → Code → Final Verification |

### Artifacts, Summary blocks, and REQ-IDs

Every stage writes one artifact into `docs/` from a skeleton in the plugin's `templates/`. Each
artifact opens with a compact **Summary block** — that summary, not the full document, is what
downstream agents read (full text is fetched only when a detail can't be resolved from it). This
keeps context small and handoffs clean.

Requirements assign **REQ-IDs**; every downstream entity, component, contract, slice, test, and
code file anchors back to them. Anchors are what make traceability and coverage *computable* —
`th coverage check` and `th trace render` scan them mechanically.

When an artifact is approved, it is **registered**: `th artifact register` content-hashes the file
and records `{file, version, hash}` in `state.json`. Those hashes are what staleness detection
(§ cascade re-verification, below) works from.

### The Critic loop

After every producer (Spec, Vertical-Slice, Builder) finishes a draft, a **Critic agent in fresh
context** reviews it — fresh context deliberately, so the author's rationalizations aren't in the
room. Rules that keep the loop honest:

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
≥ 1 test.

**Parallel waves.** Before building, `th build plan` reads each slice's "components touched" list
and schedules slices into waves: disjoint component sets build concurrently, overlapping ones
serialize. This is computed, not judged.

**Bidirectional drift** is what keeps documents honest during the build:

- **Derived-layer drift** (architecture, design, contracts, slice plan disagree with reality): the
  Builder wires in reality, updates the doc *in the same change*, logs it, and keeps building. You
  review these asynchronously with `/twinharness:th-drift` — they're for ratifying, not approving.
- **Requirement/scope drift** (reality contradicts what you signed off): the build **stops**. The
  entry increments a blocking counter that the stop-gate reads, and nothing can be declared done
  until you decide. Resolve via `/twinharness:th-drift` → `th drift resolve DRIFT-NNN`.

The source-of-truth rule: **code wins on behavior; requirements win on intent.**

### The stop-gate

A Stop hook runs `th hook stop-gate` whenever Claude tries to end its turn. It blocks the stop —
forcing Claude to keep working or surface the problem — when `state.json` is invalid or any
blocking drift is open. So "done" cannot be truthfully claimed over a broken run.

Loop protection: the gate blocks **at most once per stop sequence**. If Claude is already
continuing because of a prior block and the gate is *still* unsatisfied, it lets the stop through
with a visible warning instead — because a blocking drift needs *your* decision, and re-blocking
forever would just spin the model. Projects with no `.agentic-sdlc/state.json` are never gated; the
hook is inert outside TwinHarness runs.

### Resuming

Runs are idempotent to re-enter. If `.agentic-sdlc/state.json` exists, `/twinharness:th-run`
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
th init [--force]                  Scaffold docs/, .agentic-sdlc/state.json, drift-log.md
th state get [dotted.path]         Print state (or one value: th state get slices[0].status)
th state set <dotted.key> <value>  Patch one value; REFUSES writes that would invalidate state
th state status                    Human-readable tier/stage/gates/slices snapshot
th state verify                    Exit 0 = valid; non-zero with a precise issue list otherwise
```

`state set` JSON-parses the value (`true` → boolean, `3` → number, `["a"]` → array) and falls back
to a bare string. Dotted paths support array indices. Because every write is re-validated against
the schema, illegal states — e.g. `tier T0` while a blast-radius flag is set — are mechanically
unwritable.

`state.json` schema (canonical field order; spec §18):

| Field | Type | Meaning |
|---|---|---|
| `tier` | `"T0".."T3"` \| null | Classified tier (null until classified) |
| `complexity_rationale` | string | Why that tier |
| `blast_radius_flags` | string[] | Subset of the five veto flags |
| `current_stage` | string | Resume point (`init`, `requirements`, `scope`, … `implementation`, `final-verification`) |
| `approved_artifacts` | {file, version, hash}[] | Registered artifacts (hashes drive staleness) |
| `summaries_index` | string | Index doc for summary handoffs |
| `slices` | {id, status, components}[] | Slice ledger; `status` ∈ pending/in-progress/done/blocked; `components` drives wave scheduling |
| `implementation_allowed` | boolean | Set true only after the slice plan + tier prerequisites clear |
| `open_questions` | string[] | Unresolved questions blocking advancement |
| `drift_open_blocking` | number | Open requirement-layer escalations; stop-gate blocks while > 0 |
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

Modes are stage names (`requirements`, `scope`, `architecture`, `slice`, `code-review`, …). Default
cap 3. The CLI computes `escalate`; the Orchestrator decides what to do about it.

### Artifacts, coverage, traceability

```
th artifact register <file> --version <n>   Hash + record in approved_artifacts
th artifact list                            What's registered (file, version, hash)
th coverage check [--reqs F] [--plan F] [--tests D]
th anchors scan [--scan-reqs] [--scan-tests] [--scan-code] [--strict]
th trace render                             The full traceability view, rendered on demand
th stale --since <hash>                     Diff-scoped downstream staleness (see cascade below)
```

- **Coverage** asserts every MVP REQ-ID maps to ≥ 1 slice *and* ≥ 1 test. Non-zero exit = the build
  may not start (or the verification report may not be produced). Defaults:
  `--reqs docs/01-requirements.md --plan docs/09-implementation-plan.md --tests tests`.
- **Anchors** maps each REQ-ID to the files it appears in across `docs/`, `tests/`, and `src/`, and
  flags **orphans** — anchors in tests/code with no defined requirement. `--strict` makes an orphan
  exit 1. Tests anchor by naming convention: `test_REQ001_<capability_slug>`.
- **Trace render** produces the requirement → design → contract → slice/task → test → code table
  fresh on every call. It is deliberately **never stored** — a maintained traceability matrix would
  rot; anchors that live next to the code cannot.

### Cascade re-verification (upstream artifact changed)

When an approved upstream artifact is revised:

```
th artifact register docs/02-scope.md --version 2     # re-register → new hash recorded
th stale --since <old-hash>                           # who downstream is affected by the DIFF
```

`stale` recompares the old recorded hash against the file on disk and returns only the downstream
artifacts whose summaries the diff actually touches — a one-line scope edit does not trigger a
full re-verify storm. Each stale artifact gets a *diff-scoped* Critic pass (check
`th revise status <mode>` first), and only genuine conflicts escalate.

### Drift log

```
th drift add --layer derived     --ref "SLICE-2 / TASK-014" --discovery "..." --action "..."
th drift add --layer requirement --ref "SLICE-2 / TASK-014" --discovery "..." --action "build paused"
th drift list [--json]           Entries + open blocking count
th drift resolve <DRIFT-NNN>     Append resolution; decrement the blocking counter
```

`--layer requirement` increments `drift_open_blocking` (stop-gate blocks); `--layer derived` is
non-blocking bookkeeping. The log (`drift-log.md`) is append-only.

### Build scheduling

```
th build plan [--include-done]
```

Computes the §16 wave schedule from each slice's `components` list: disjoint → same wave (safe to
run Builders concurrently), shared component → later wave (serialized). By default only unfinished
slices are scheduled.

### The hook

```
th hook stop-gate
```

Speaks the Claude Code Stop-hook protocol on stdout: `{}` to allow;
`{"decision":"block","reason":"..."}` to block. Reads the hook payload on stdin and honors
`stop_hook_active` (see Part 2). Always exits 0 — the JSON carries the decision. You rarely run
this by hand except to debug why a session refuses to finish.

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

### Templates

The artifact skeletons live in the plugin's `templates/` directory (`01-requirements.md` …
`10-verification-report.md`, plus `task-file.md`). Editing them changes what every future stage
emits. Keep the **Summary** block at the top of each template — it is the handoff currency — and
keep REQ-ID anchor patterns intact, or `coverage`/`anchors`/`trace` lose their inputs.

### Developing the plugin itself

```
npm install        # dev deps only (typescript, vitest)
npm run build      # src/ -> dist/
npm test           # REQ-anchored vitest suite (incl. plugin-packaging integrity)
```

Two invariants are enforced by `tests/plugin-manifest.test.ts` — do not fight them:

- **`dist/` is committed.** Plugin installs copy the repo with no build step, so after editing
  `src/`, rebuild and commit `dist/` together with the source.
- **Components never call a bare `th`.** Every skill/command/agent resolves the CLI via
  `${CLAUDE_PLUGIN_ROOT}/dist/cli.js` (substituted by Claude Code at load time), because installed
  users don't have `th` on PATH.

After changing plugin components, reinstall (or `/plugin marketplace update twinharness` then
update the plugin) and restart the session; `claude --plugin-dir .` is the fast loop for testing.

### Uninstall

```
claude plugin uninstall twinharness@twinharness
claude plugin marketplace remove twinharness
```

A project's run artifacts (`docs/`, `.agentic-sdlc/`, `drift-log.md`) are plain files in *your*
repo — they survive uninstall and contain everything needed to resume after a reinstall.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Session "can't finish" — keeps getting pushed back to work | The stop-gate is blocking: run `/twinharness:th-escalate`. Either `state.json` is invalid (`th state verify` lists exactly what's wrong) or blocking drift is open (`th drift list`, then decide and `th drift resolve DRIFT-NNN`). |
| `{"error":"not_initialized"}` | No run in this directory. Start one (`/twinharness:th-run <idea>`) or pass `--cwd` to point at the right project. |
| `th state set tier T0` refused | A blast-radius flag is recorded — that's the veto floor working. Clear the flags only if they are genuinely wrong, or accept Tier ≥ 1. |
| `coverage check` fails before build | An MVP REQ-ID has no slice or no test. Re-enter the Vertical Slice stage; do not hand-wave the gap. |
| Critic loop stuck at the cap | By design: round 3 reached with open grounded issues. The open issues are now yours to decide — `/twinharness:th-escalate` lists them. |
| Commands not found after install | Restart the session (plugins load at startup). Verify with `claude plugin list`. |
| Hook errors about a missing `dist/cli.js` | The installed copy predates a fix, or a dev clone wasn't rebuilt: update the marketplace + plugin, or `npm run build` in the clone. |

### FAQ

**Can I skip a gate?** Streaming stages, yes — they never blocked you. Sticky gates (requirements,
scope, auth, blocking drift), no: they exist precisely because those calls are yours. The honest
shortcut is a lower tier, and `th tier classify` will tell you if the project qualifies.

**Can I edit `docs/` artifacts by hand?** Yes — they're your files. But re-register the changed
artifact (`th artifact register <file> --version <n+1>`) and run the cascade
(`th stale --since <old-hash>`) so downstream artifacts get re-checked, or the harness will be
governing from a hash that no longer matches reality.

**Why did it refuse to pick an auth scheme by itself?** Auth is blast-radius. Every
authentication/authorization decision is human-gated by design — the model proposes, you choose.

**Does the stop-gate affect my other projects?** No. With no `.agentic-sdlc/state.json` in the
working directory, the gate always allows.
