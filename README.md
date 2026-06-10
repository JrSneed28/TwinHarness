# TwinHarness

**Agentic SDLC Orchestrator**, packaged as a Claude Code plugin. TwinHarness drives a vague idea
through tier-scaled SDLC stages — requirements, scope, domain model, architecture, UI design
(conditional), contracts, security & failure modes, test strategy, vertical-slice planning,
implementation, documentation, verification — producing structured artifacts that **govern**
implementation rather than decorate it, and feeding implementation discoveries back into those
artifacts so they stay honest.

**New here? Read [`USAGE.md`](./USAGE.md)** — the full usage guide, from install and first run
through tiers, drift, the stop-gate, and the complete `th` CLI reference.

See [`spec/TwinHarness-Plan.md`](./spec/TwinHarness-Plan.md) for the frozen spec and
[`spec/build-plan.md`](./spec/build-plan.md) for the build plan.

## Design: hybrid plugin (Option B)

- **Prompt orchestration** — 7 agents plus Spec/Critic modes, encoded as skills + agents +
  templates.
- **A deterministic `th` CLI** (TypeScript, zero runtime dependencies) owns every **mechanical**
  operation: `state.json`, content hashing, REQ-anchor scanning, traceability rendering, coverage
  checks, drift-log, cascade-staleness, and the blast-radius veto. *Instructions don't enforce —
  code does* (spec §11).

### Agents (7)

| Agent | Role |
|---|---|
| `orchestrator` | Tiering, routing, gates, state; your own playbook |
| `spec` | Modal artifact producer (requirements, scope, domain model, architecture, contracts, etc.) |
| `critic` | Modal coherence reviewer, always fresh context |
| `vertical-slice` | Fresh-context slice decomposition (Stage 9) |
| `builder` | Write code + tests, run checks, drift write-back (Stage 10) |
| `ui-designer` | User-centered UI design in fresh context (Stage 4b, conditional on project having a UI) |
| `doc-writer` | Tier-scaled documentation generation from contracts and implementation (Stage 10.5) |

The CLI **records and computes; it never decides** which stage/agent/tier runs.

## Install as a Claude Code plugin

The repo doubles as its own single-plugin marketplace (`.claude-plugin/marketplace.json`):

```
/plugin marketplace add <path-or-github-repo>   # e.g. C:\path\to\TwinHarness or JrSneed28/TwinHarness
/plugin install twinharness@twinharness
```

For a throwaway local test session instead:

```
claude --plugin-dir C:\path\to\TwinHarness
```

Installed surface (plugin-namespaced):

| Invocation | What it does |
|---|---|
| `/twinharness:th-run <idea>` | Start or resume an orchestration run |
| `/twinharness:th-status` | Tier / stage / gates / drift snapshot |
| `/twinharness:th-drift` | Review + ratify the drift log |
| `/twinharness:th-escalate` | Show everything blocking completion |

Plus 7 agents (orchestrator, spec, critic, vertical-slice, builder, ui-designer, doc-writer), the
`twinharness` skill, and a **Stop hook** that runs `th hook stop-gate` so "done" cannot be claimed
while state is invalid or a blocking drift is open. The hook blocks at most once per stop sequence
(it honors `stop_hook_active`), then yields with a visible warning — blocking drift needs a *human*
decision, not an infinite model loop.

**Note:** `dist/` is committed on purpose. Plugin installs copy this repo as-is into the Claude
Code plugin cache — no `npm install`/build step runs — so the compiled zero-dependency CLI must
ship in git. After editing `src/`, run `npm run build` and commit `dist/` together with the source
(`tests/plugin-manifest.test.ts` enforces this mechanically).

## Repository layout

```
.claude-plugin/   plugin manifest + marketplace.json
agents/           7 agent prompt files (orchestrator, spec, critic, vertical-slice, builder, ui-designer, doc-writer)
commands/         4 Claude Code commands (th-run, th-status, th-drift, th-escalate)
dist/             compiled CLI — COMMITTED ON PURPOSE (no build step at install time)
hooks/            Stop hook wiring (hooks.json → th hook stop-gate)
skills/           twinharness/ SKILL.md — full orchestrator playbook
spec/             frozen spec (TwinHarness-Plan.md) + build plan (build-plan.md)
src/              TypeScript source for the th CLI
templates/        artifact skeletons for each SDLC stage
tests/            REQ-anchored vitest suite (CLI behavior + plugin-packaging integrity)
examples/         example TwinHarness runs (autocoder T3)
```

## `th` CLI (current surface)

```
th init [--force]                 Scaffold docs/, .twinharness/state.json, drift-log.md
th state get [dotted.path]        Print state.json (or one value)
th state set <dotted.key> <value> Patch state.json (refuses invalid results; rejects unknown keys)
th state status                   Human-readable tier/stage/gate snapshot
th state verify                   Validate state.json (exit 0 = valid)
th revise bump <mode> [--cap N]   Increment revise-loop count (computes escalate = count >= cap)
th revise status <mode> [--cap N] Report revise-loop count + cap (no mutation)
th revise reset <mode>            Zero revise-loop count (stage passed / zero issues)
th tier classify <brief.json>     Advisory Tier-0 eligibility + detected blast-radius flags
th tier veto-check <brief.json>   Mechanical veto gate (exit 3 when a blast-radius flag forbids T0)
th artifact register <file> --version <n>  Content-hash a file and record it in approved_artifacts
th artifact list                  List recorded approved artifacts (file, version, hash)
th coverage check [--reqs F] [--plan F] [--tests D] [--scope F]
                                  Verify every (MVP) REQ-ID maps to ≥1 slice and ≥1 test
th build plan [--include-done]    Schedule slices into conflict-free build waves (§16)
th anchors scan [--scan-reqs] [--scan-tests] [--scan-code] [--strict]
                                  Map REQ-anchors across docs/tests/src; report orphans
th trace render                   Render the §17 traceability view from anchors (on demand; never stored)
th stale --since <hash>           Compute the diff-scoped downstream artifacts made stale by an upstream change
th stale --artifact <file>        Same as --since but look up the artifact by file key (safe before re-registering)
th slices sync [--plan F] [--dry-run] [--remove-missing]
                                  Upsert state.slices from the implementation plan
th slice set-status <SLICE-ID> <status>  Set a single slice's status (pending|in-progress|done|blocked)
th drift add --layer <derived|requirement> [--ref ...] [--discovery ...] [--action ...] [--escalation ...] [--source ...]
                                  Append a §10 drift entry
th drift list                     List drift entries + open blocking count
th drift resolve <DRIFT-NNN>      Append a resolution note; decrement blocking counter only for requirement-layer entries
th hook stop-gate                 Emit a Claude Code Stop-hook decision
th version                        Print the CLI version
th help                           Show this help
```

`th tier classify` is **advisory** — it computes the five Tier-0 conditions and never picks the
tier number (that is judgment). `th tier veto-check` is **mechanical**: it exits **exit 3** (and
`--json` `{"blocked":true,"flags":[...]}`) when any blast-radius flag is present, forbidding Tier 0.
The Tier-0 veto floor is **also a state invariant** — `th state set tier T0` is refused while any
blast-radius flag is set.

`th slices sync` parses `docs/09-implementation-plan.md` into `state.slices`, preserving existing
statuses on re-sync. `th build plan` **reads `state.slices`** (populated by `slices sync`, not the
raw document) and computes the §16 parallel-build schedule: slices with **disjoint** component sets
parallelize (share a wave), while slices that **share** a component serialize (different waves) to
avoid merge conflicts and drift races.

`th anchors scan` maps each REQ-ID to the files it appears in across `docs/`, `tests/`, and `src/`
and flags **orphans** — anchors in tests or code with no matching defined requirement. `--strict`
makes an orphan a hard failure (exit 1).

`th trace render` renders the §17 traceability view on demand from durable REQ-ID anchors
and **never stores** it as a maintained matrix. Trace now associates SLICE/TASK tokens per-REQ
instead of dumping all tokens on every row.

`th stale --artifact <file>` looks up the registered artifact by file key, compares the recorded
hash against disk, and returns **all registered downstream artifacts** in pipeline order. Run this
**before** re-registering the changed artifact — once you re-register, the recorded hash updates
and `th stale` would find no change. The recommended cascade flow:

```
th stale --artifact docs/<changed>.md   # get stale set BEFORE re-registering
th artifact register docs/<changed>.md --version N+1
# then run Critic in matching mode for each stale artifact
```

`th drift` is the **append-only** bidirectional drift log. `drift add --layer derived` is
non-blocking (auto-applies); `--layer requirement` is **BLOCKING** — it increments
`state.drift_open_blocking`, which the stop-gate reads to refuse premature completion. `--source`
names who logged the entry (defaults to Builder). `drift resolve <id>` validates the ID exists,
rejects double-resolves, and only decrements the blocking counter for requirement-layer entries.

`th coverage check` scans tests/ **fully recursively** in any language and applies an MVP filter
from `docs/02-scope.md`'s `## MVP Scope` section when present; `--scope <file>` overrides the
scope file. `th state set` **rejects unknown top-level keys** (exit with `unknown_field` error).

## Model & effort routing

Agent frontmatter defaults are **sonnet** (spec, critic, builder, doc-writer, ui-designer) with
**opus** retained for orchestrator and vertical-slice. The Orchestrator escalates to opus for T3
or blast-radius design stages, blast-radius code-review builds, and any situation where a wrong
answer is expensive. **Haiku** handles trivial recaps (e.g. drift-log summarisation). Effort scales
with tier and blast radius. The full policy table lives in `skills/twinharness/SKILL.md` under
"Model & effort routing (automatic)".

## State directory

`th init` creates `.twinharness/state.json` (renamed from `.agentic-sdlc` in v0.2.0). Existing
projects with `.agentic-sdlc/state.json` keep working via automatic legacy fallback —
`resolveProjectPaths` prefers `.twinharness` and falls back to `.agentic-sdlc` if the new dir
doesn't exist.

## Development

```
npm install      # dev deps only (typescript, vitest) — no runtime deps
npm run build    # compile src/ -> dist/
npm test         # run the REQ-anchored vitest suite
npm run typecheck
```

## Status

v0.2.0 — 7 agents, 206 tests passing. 0.2.0 added two new agents (ui-designer, doc-writer),
six new CLI commands, state directory renamed to `.twinharness` with legacy fallback, and
automatic model/effort routing.

## License

MIT
