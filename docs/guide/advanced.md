# Advanced orchestration

The internals a power user reaches for: how process scales with risk, the full gate
ladder, the coverage and drift machinery, how parallel Builders avoid collisions, and
the MCP surface. This is a narrative over [USAGE.md Part 3](../../USAGE.md#part-3--the-th-cli-advanced)
— it links into the exhaustive reference rather than restating it. For the conceptual
"why," see [architecture.md](./architecture.md).

## Tier scaling & the blast-radius floor

Every project is classified on two independent axes. **Complexity** picks the tier;
**blast radius** sets a floor under it. Blast radius can pull a project *up*; it never
pushes a risky one *down*.

- **Tier 0 — bypass.** All five must hold: single file / tightly local; no public
  interface or schema change; no new dependency; an obvious testable answer; and **no
  blast-radius flag**. Result: no documents, no stages — it just gets built. Any miss
  → Tier 1 minimum.
- **The blast-radius veto.** Five flags — `authentication`, `authorization`,
  `data-integrity`, `money`, `migrations` — can **never** be Tier 0. This floor is
  enforced twice: `th tier veto-check` exits non-zero when a flag is present, and the
  state schema itself refuses `tier = T0` while any flag is recorded.
- **T1 → T3** engage progressively more stages (domain model, ADRs, technical design,
  standalone security and failure-modes stages, test strategy) and more human gates.

Full pipelines per tier and the classification rules are in
[Tiers and blast radius](../../USAGE.md#tiers-and-blast-radius). Model/effort routing
also scales with tier and blast radius — opus where wrong answers are expensive, haiku
for trivial summarization — see
[Model & effort routing](../../USAGE.md#model--effort-routing-automatic).

## The gate ladder

Gates are not reminders; they are typed CLI commands and harness hooks that fail
closed. There are three layers:

### 1. Typed gate commands (the CLI ladder)
`th tier record`, `th stage advance`, and `th implementation unlock` each validate the
**full prerequisite ladder** before they mutate state. Gate-owned fields
(`implementation_allowed`, `tier`, `blast_radius_flags`, `write_gate`,
`drift_open_blocking`) cannot be patched directly with `th state set` — they require
the typed command, or a loud, audit-ledgered `--emergency` override. See
[Typed gate commands](../../USAGE.md#typed-gate-commands-the-gate-ladder).

### 2. The stop-gate (Stop / SubagentStop hooks)
`th hook stop-gate` blocks a turn from ending while state is invalid, a blocking
requirement-drift is open, or — at `final-verification` — slices are unbuilt or the
verify suite is missing/red. It blocks at most once per stop sequence. See
[The stop-gate](../../USAGE.md#the-stop-gate).

### 3. The write-gate (PreToolUse hook)
`th hook pretool-gate` runs before every file write. **Phase A** (pre-implementation)
blocks writes to anything but doc/state paths until the gates clear; **Phase B**
(mid-build) flags writes that cross a slice's component boundary. Semantics are tuned
by the `write_gate` state field (`ask` default · `deny` · `off` · `strict`).

**Env bypass — `TH_DISABLE_WRITE_GATE=1`.** Set this environment variable to `1` to
disable the write-gate globally for the session: the PreToolUse hook stands down and
every write is allowed, regardless of the `write_gate` mode. It is the emergency
manual override — reach for it when the gate misclassifies a legitimate write (e.g. a
tooling edit) and is blocking you, accepting that you own the writes while it is off.
Like every gate it only binds a *compliant* agent, so it is a convenience switch, **not
a security boundary** — think "turn the guardrail off for now," not containment. See
[The write-gate](../../USAGE.md#the-write-gate) and [SECURITY.md](../../SECURITY.md).

### Decision governance & the audit ledger
Irreversible, taste-driven decisions go through `th decision add` →
`th decision approve` (or `/twinharness:th-decision-approve`), a **human-only** gate
that requires an interactive TTY. Every gate-relevant mutation is appended to
`.twinharness/gate-ledger.jsonl` — observability only, never a blocker. See
[Decision governance](../../USAGE.md#decision-governance-th-decision) and
[Gate-mutation audit ledger](../../USAGE.md#gate-mutation-audit-ledger).

## Coverage & drift

**Coverage** is a hard gate before the build starts: `th coverage check` blocks until
every in-scope (MVP) REQ-ID maps to ≥ 1 slice **and** ≥ 1 test. It scans `tests/`
fully recursively in any language, filtered by the `## MVP Scope` section of
`docs/02-scope.md`. `th coverage report` gives the planned/implemented/tested/passing
breakdown. See [Artifacts, coverage, traceability](../../USAGE.md#artifacts-coverage-traceability).

**Drift** is bidirectional and tracked in `drift-log.md` plus a state counter. Derived
drift auto-applies and is logged (`th drift add --layer derived`); requirement/scope
drift increments `drift_open_blocking`, which the stop-gate reads — nothing can be
declared done until you resolve it with `th drift resolve`. The source-of-truth rule:
**code wins on behavior; requirements win on intent.** See
[Drift log](../../USAGE.md#drift-log) and
[The build: vertical slices, waves, and drift](../../USAGE.md#the-build-vertical-slices-waves-and-drift).

## Parallel build coordination

The build runs Builders concurrently without collisions, using a layered scheme:

- **Waves.** `th slices sync` parses the plan into `state.slices`; `th build plan`
  schedules slices into **waves** — disjoint component sets build in parallel,
  overlapping ones serialize. This is computed from state, not judged. See
  [Build scheduling](../../USAGE.md#build-scheduling).
- **Leases.** Concurrent `th` mutations are serialized by a cross-process advisory
  lock on `.twinharness/.state.lock`, so simultaneous `th drift add` calls never lose
  an update. For intra-artifact fan-out, **section-level artifact leases**
  (`th artifact claim|release|leases`) prevent two agents from editing the same
  heading. See [Live build coordination](../../USAGE.md#live-build-coordination--parallel-builders-without-collisions).
- **Sub-leases.** A Builder can spawn bounded nested sub-agents under a scoped
  **sub-lease** (`th build sub-claim --components ...`), keeping each sub-agent's write
  scope explicit and enforced. See
  [Sub-leases & nested sub-agents](../../USAGE.md#sub-leases--nested-sub-agents-scoped-bounded).
- **Worktrees.** Parallel work can run in separate git worktrees with a defined
  merge-back protocol. See
  [Worktrees & the merge-back protocol](../../USAGE.md#worktrees--the-merge-back-protocol).

For T2/T3, the **collab/debate** primitives add a shared blackboard (`th collab`) and a
blocking debate ledger (`th debate`) for multi-agent stages. These features activate by
tier — check `th tier features` for what is live. See
[Parallel collaborative orchestration](../../USAGE.md#parallel-collaborative-orchestration-collab--debate--section-level-artifact-leases).

## Context budget

Long runs are kept within a per-session token budget. `--max-tokens <k>` (on `th-run`
/ `th init`) persists as `max_tokens` (×1000); `th budget check` reads it, defaulting to
a tier-aware budget (T0/T1 ≈120k, T2 ≈160k, T3 ≈200k) when unset. When a wave checkpoint
goes over budget, the Orchestrator runs a Continue/Fresh handoff. See
[Context budget](../../USAGE.md#context-budget-th-budget-check) and
[Context preservation & delegation](../../USAGE.md#context-preservation--delegation).

## Context-pages: what lands on disk

ContextPages ships an **on-by-default PostToolUse hook** (registered in `hooks/hooks.json`,
matching `Read|Grep|Glob|Bash|WebFetch|mcp__.*`). By default it runs in **OBSERVE** mode:
it does **not** alter any tool output, but it **does** persist data locally under
`.twinharness/context-pages/`. `.twinharness/` is gitignored, so nothing is committed, and
nothing leaves the machine — but the cold store is **local plaintext**, so it is worth
knowing what is written and how to clear it.

What gets persisted by default:

- **`objects/<hh>/<hash>`** — the raw text of *non-sensitive* tool outputs (file reads,
  bash output, web/MCP results), stored **in plaintext** in a content-addressed cold store.
- **`ledger-*.jsonl`, `telemetry.jsonl`, `epoch.json`** — counts, hashes, and labels only.
  No raw content lives here; when a payload is sensitive, only its short hash is recorded.

**Secret redaction (best-effort).** Sensitive content — detected by a path denylist plus a
secret-regex classifier, biased **fail-toward-sensitive** — is **never** written to the cold
store; only its hash is recorded in the ledger. Detection is **best-effort** and may miss
unusual secret shapes, so treat the cold store as potentially holding any output you read or
ran. **Retention is until you clean it up**: objects persist until `gc` or `purge` (below).

Control knobs:

- **`TH_DISABLE_CONTEXT_PAGES=1`** — full passthrough; the hook records **nothing** (no I/O).
- **OBSERVE vs suppress.** The default is OBSERVE: data is recorded but tool output is never
  altered. **`TH_EXACT_SUPPRESS=1`** opts in to actual content suppression (off by default).
- **`th context-pages gc [--age-days <n>]`** — remove cold CAS objects older than *n* days
  (default 5). It **never** removes ledger records. Human-only.
- **`th context-pages purge`** — remove **all** context-pages data. Human-only, destructive.

See [Token-savings display](../../README.md#the-th-cli) for how the OBSERVE-mode savings are
reported, and [SECURITY.md](../../SECURITY.md) for the trust model.

## The MCP surface

The entire `th` read/compute surface is exposed as a typed MCP server — an **82-tool**
surface at parity with the CLI (parity is enforced by tests). Sub-agents call the
`th_*` tools natively instead of shelling out; a tool that *returns* an error result
(e.g. `not_initialized`) is working as intended. See
[MCP tools](../../USAGE.md#mcp-tools-registered-count-82) and the
[full MCP roster](../../USAGE.md#mcp-tool-roster-exhaustive--all-82).

## Using `th` in CI

The exit codes are designed for pipelines: `th tier veto-check` (non-zero on a
forbidden T0), `th coverage check`, `th stale`, and `th anchors scan --strict` all fail
a build on a broken contract. See [Exit codes](../../USAGE.md#exit-codes) and
[Using `th` in CI](../../USAGE.md#using-th-in-ci).

## See also

- [architecture.md](./architecture.md) — why these mechanisms exist and how the halves
  fit together.
- [cli-reference.md](./cli-reference.md) — the command-surface tour.
- [USAGE.md Part 3](../../USAGE.md#part-3--the-th-cli-advanced) — the exhaustive
  reference and [complete flag matrix](../../USAGE.md#complete-flag-reference).
