# CLI reference — a guided tour

TwinHarness exposes two surfaces: **16 slash commands** you use inside Claude Code,
and the underlying **`th` CLI** they wrap. This guide tours both the way a human
learns them — by purpose, not alphabetically. For the exhaustive flag-by-flag
matrix, jump to [USAGE.md Part 3](../../USAGE.md#part-3--the-th-cli-advanced) and its
[Complete flag reference](../../USAGE.md#complete-flag-reference); this page does not
duplicate those tables.

> New to TwinHarness? Read [getting-started.md](./getting-started.md) first — it gets
> you to a first successful command. This page assumes you have a run going.

## The mental model

The `th` CLI **records and computes; it never decides.** Every verb either reports a
mechanical truth (state, coverage, hashes, drift counts) or applies a typed,
gate-checked mutation. The Orchestrator runs it for you; you call it directly only to
inspect a run, script CI, or debug. Wherever docs say `th <args>`, the literal
invocation is `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>` (or
`node <clone>/dist/cli.js <args>` from a checkout).

## The 16 slash commands

### The four run commands

These four are all most users ever touch:

| Command | When to use it |
|---|---|
| `/twinharness:th-run [flags] <idea>` | Start a new run — or resume an interrupted one from `state.json`. |
| `/twinharness:th-status` | Where am I? Tier, current stage, gates, slices, open drift. |
| `/twinharness:th-drift` | Review the drift log: skim auto-applied doc updates, decide blocked escalations. |
| `/twinharness:th-escalate` | Show everything currently waiting on a **human** decision. |

`th-run`'s flags (`--interview`, `--no-interview`, `--cutoff`, `--max-tokens`) are
covered in [getting-started.md](./getting-started.md#twinharnessth-run-flags-optional)
and in detail in [USAGE.md](../../USAGE.md#twinharnessth-run-flags).

### The twelve verb wrappers

Thin wrappers over the most-used `th` verbs, so you can inspect a run without typing
the full CLI path:

| Command | Wraps | Purpose |
|---|---|---|
| `/twinharness:th-init` | `th init` | Scaffold a run (rarely by hand; `th-run` does it). |
| `/twinharness:th-doctor` | `th doctor` | Full run-health audit. |
| `/twinharness:th-next` | `th next` | The single mechanical obligation the run owes next. |
| `/twinharness:th-scorecard` | `th scorecard` | One-screen post-run summary. |
| `/twinharness:th-stage` | `th stage` | The current/any stage's contract (produces / Critic mode / gate). |
| `/twinharness:th-verify` | `th verify` | Configure & run the project's own test/check commands. |
| `/twinharness:th-coverage` | `th coverage` | Planned / implemented / tested / passing breakdown. |
| `/twinharness:th-tier` | `th tier` | Tier eligibility & blast-radius veto check. |
| `/twinharness:th-route` | `th route` | Advisory model/effort routing for an agent spawn. |
| `/twinharness:th-repo` | `th repo` | The repo-understanding layer (map / relevant / impact). |
| `/twinharness:th-test` | `th verify run` | Run the configured suite and record the report. |
| `/twinharness:th-decision-approve` | `th decision approve` | The **human-only** decision gate (interactive TTY). |

The `twinharness` skill itself (`/twinharness:twinharness`) is the full Orchestrator
playbook, and Claude invokes it automatically when you ask for spec-driven,
stage-gated development in prose.

## The `th` verb groups

Run `th help` for the full listing. The surface organizes into these groups:

### Lifecycle & state
`th init`, `th state get|set|status|verify|unlock|adopt`, `th resume`. State is the
single source of mechanical truth in `.twinharness/state.json`; gate-owned fields are
guarded (see [advanced.md](./advanced.md)). Detail:
[USAGE.md → Lifecycle & state](../../USAGE.md#lifecycle--state).

### Tiering & the gate ladder
`th tier classify|veto-check|record|features`, `th stage advance`,
`th implementation unlock`. These are the typed gate commands — each validates the
full ladder before it mutates. Detail:
[Tiering](../../USAGE.md#tiering) and
[Typed gate commands](../../USAGE.md#typed-gate-commands-the-gate-ladder).

### Artifacts, coverage & traceability
`th artifact register|list`, `th coverage check|report`, `th anchors scan`,
`th trace render`, `th stale`, `th research write`. This is the REQ-ID traceability
engine — coverage and trace views are computed from anchors, never stored. Detail:
[Artifacts, coverage, traceability](../../USAGE.md#artifacts-coverage-traceability).

### Slices, build scheduling & drift
`th slices sync`, `th build plan`, `th drift add|list|resolve`. `th slices sync`
parses the plan into `state.slices`; `th build plan` schedules disjoint slices into
parallel waves. Detail: [Slices](../../USAGE.md#slices),
[Build scheduling](../../USAGE.md#build-scheduling),
[Drift log](../../USAGE.md#drift-log).

### Verify (the project's own tests)
`th verify add|list|approve|clear|run`. The configured command set is **unapproved
until `th verify approve`**, which requires an interactive TTY — an agent cannot
self-approve. Detail: [Verify](../../USAGE.md#verify--run-the-projects-own-testschecks).

### Decision governance
`th decision add|approve` (and `/twinharness:th-decision-approve`). The human-only
approval gate for irreversible, taste-driven decisions. Detail:
[Decision governance](../../USAGE.md#decision-governance-th-decision).

### Repo-understanding layer
`th repo map|relevant|impact|search`. Builds and queries a structural map of the
target repository (especially for brownfield work). Detail:
[Repo-understanding layer](../../USAGE.md#repo-understanding-layer-th-repo).

### Advanced coordination (T2/T3)
`th artifact claim|release|leases` (section-level leases), `th collab`, `th debate`,
`th build sub-claim` (sub-leases). These activate only at higher tiers; see
[advanced.md](./advanced.md) and
[Parallel collaborative orchestration](../../USAGE.md#parallel-collaborative-orchestration-collab--debate--section-level-artifact-leases).

### Diagnostics & inspection
`th doctor`, `th next`, `th scorecard`, `th budget check`, `th manifest export`,
`th debug pack|log`. Detail:
[Diagnostics & run inspection](../../USAGE.md#diagnostics--run-inspection).

## Exit codes & CI

The `th` verbs return meaningful exit codes (e.g. `th tier veto-check` exits non-zero
when a blast-radius flag forbids Tier 0; `th coverage check` and `th stale` fail when
a contract is broken). Wire them into CI to fail a build on a drifted artifact or a
broken coverage map. See [Exit codes](../../USAGE.md#exit-codes) and
[Using `th` in CI](../../USAGE.md#using-th-in-ci).

## MCP parity

Every read/compute verb is also exposed as a typed MCP tool (an 81-tool surface at
parity with the CLI) so sub-agents call it natively instead of shelling out. See
[advanced.md](./advanced.md#the-mcp-surface) and
[MCP tools](../../USAGE.md#mcp-tools-registered-count-81).

## See also

- [getting-started.md](./getting-started.md) — install and first run.
- [architecture.md](./architecture.md) — why the CLI never decides.
- [advanced.md](./advanced.md) — the gate ladder and coordination internals.
- [USAGE.md Part 3](../../USAGE.md#part-3--the-th-cli-advanced) — the exhaustive
  reference, schema, and complete flag matrix.
