# TwinHarness

**Agentic SDLC Orchestrator**, packaged as a Claude Code plugin. TwinHarness drives a vague idea
through tier-scaled SDLC stages — requirements, scope, domain model, architecture, design, contracts,
tests, vertical-slice planning, implementation, verification — producing structured artifacts that
**govern** implementation rather than decorate it, and feeding implementation discoveries back into
those artifacts so they stay honest.

See [`TwinHarness-Plan.md`](./TwinHarness-Plan.md) for the frozen spec and
[`.omc/plans/ralplan-twinharness-plugin.md`](./.omc/plans/ralplan-twinharness-plugin.md) for the build plan.

## Design: hybrid plugin (Option B)

- **Prompt orchestration** — 5 agents (Orchestrator, Spec, Vertical Slice, Builder, Critic) plus
  Spec/Critic *modes*, encoded as skills + agents + templates.
- **A deterministic `th` CLI** (TypeScript, zero runtime dependencies) owns every **mechanical**
  operation: `state.json`, content hashing, REQ-anchor scanning, traceability rendering, coverage
  checks, drift-log, cascade-staleness, and the blast-radius veto. *Instructions don't enforce —
  code does* (spec §11).

The CLI **records and computes; it never decides** which stage/agent/tier runs.

## `th` CLI (current surface)

```
th init [--force]                  Scaffold docs/, .agentic-sdlc/state.json, drift-log.md
th state get [dotted.path]         Print state.json (or one value)
th state set <dotted.key> <value>  Patch state.json (refuses invalid results)
th state status                    Human-readable tier/stage/gate snapshot
th state verify                    Validate state.json (exit 0 = valid)
th revise bump <mode> [--cap N]    Increment revise-loop count (computes escalate = count >= cap)
th revise status <mode> [--cap N]  Report revise-loop count + cap (no mutation)
th revise reset <mode>             Zero revise-loop count (stage passed / zero issues)
th tier classify <brief.json>      Advisory Tier-0 eligibility + detected blast-radius flags
th tier veto-check <brief.json>    Mechanical veto gate (exit 3 when a blast-radius flag forbids T0)
th artifact register <file> --version <n>  Content-hash a file and record it in approved_artifacts
th artifact list                   List recorded approved artifacts (file, version, hash)
th coverage check [--reqs F] [--plan F] [--tests D]  Verify every REQ-ID maps to ≥1 slice and ≥1 test
th build plan [--include-done]     Schedule slices into conflict-free build waves (§16)
th anchors scan [--scan-reqs] [--scan-tests] [--scan-code] [--strict]  Map REQ-anchors across docs/tests/src; report orphans
th trace render                    Render the §17 traceability view from anchors (on demand; never stored)
th stale --since <hash>            Compute the diff-scoped downstream artifacts made stale by an upstream change (§18)
th drift add --layer <derived|requirement> [--ref ...] [--discovery ...] [--action ...] [--escalation ...]  Append a §10 drift entry
th drift list                      List drift entries + open blocking count
th drift resolve <DRIFT-NNN>       Append a resolution note and clear one blocking drift
th hook stop-gate                  Emit a Claude Code Stop-hook decision
```

`th tier classify` is **advisory** — it computes the five Tier-0 conditions (spec §5) and never picks
the tier number (that is judgment). `th tier veto-check` is **mechanical**: it is an exit-code gate that
hard-fails with **exit 3** (and `--json` `{"blocked":true,"flags":[...]}`) when any blast-radius flag
(authentication, authorization, data-integrity, money, migrations) is present, forbidding Tier 0. The
Tier-0 veto floor is **also a state invariant** — `th state set tier T0` is refused while any
blast-radius flag is set, so the floor cannot be bypassed by editing state directly.

`th build plan` **computes** the §16 parallel-build schedule: slices with **disjoint** component
sets parallelize (share a wave; Builders may run concurrently), while slices that **share** a component
serialize (land in different waves) to avoid merge conflicts / drift races. By default only unfinished
slices are scheduled; `--include-done` includes completed ones. It records and computes the conflict-free
ordering — it never decides whether a Builder actually runs.

`th anchors scan` **records and computes** REQ-anchor traceability (spec §17): it maps each REQ-ID to
the files it appears in across `docs/`, `tests/`, and `src/` (pass `--scan-reqs`/`--scan-tests`/`--scan-code`
to narrow; default scans all three) and flags **orphans** — anchors in tests/ or code with no matching
defined requirement. `--strict` makes an orphan a hard failure (exit 1); the orchestrator decides what to do.

`th trace render` **renders** the §17 traceability view on demand from the durable REQ-ID anchors
(requirements, design docs, contracts, plan, tests, code) — it is generated fresh every call and
**never stored** as a maintained matrix (§17, decision #12). `th stale --since <hash>` computes the
**diff-scoped** downstream set (§18): it finds the registered artifact with that recorded hash,
recompares it against the file on disk, and lists the registered downstream artifacts that are now
stale so the Critic can re-verify only against the diff — it persists nothing.

`th drift` is the **append-only** bidirectional drift log (spec §10). `drift add --layer derived`
auto-applies (non-blocking); `--layer requirement` is **BLOCKING** — it increments
`state.drift_open_blocking`, which the stop-gate reads to refuse premature completion until a human
`drift resolve <id>` clears it. The CLI records the discovery and tracks the count; it never decides
whether a requirement is contradicted.

All commands accept `--json` and `--cwd <dir>`. The revise-loop cap defaults to 3 (spec §18);
`--cap <n>` overrides it. The command **records and computes** `escalate = count >= cap` — the
orchestrator decides whether to escalate to the human.

## Development

```
npm install      # dev deps only (typescript, vitest) — no runtime deps
npm run build    # compile src/ -> dist/
npm test         # run the REQ-anchored vitest suite
npm run typecheck
```

## Build status

Built in vertical slices (build plan §4). **Slice 0 — walking skeleton** (this milestone): plugin
manifest + Orchestrator skill + Spec(requirements) + requirements template + the `th` state spine
(`init`, `state`, stop-gate hook) with a green REQ-anchored test suite. Slices 1–7 (Critic loop,
tiering + veto, architecture/domain, vertical slicing, builder + drift, traceability + cascade, Tier-3
extras) follow in order, each gated green before the next.

## License

MIT
