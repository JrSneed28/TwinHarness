# Autocoder — a TwinHarness flagship example

This directory is a **worked example of the TwinHarness Agentic SDLC** (the plugin in this repo),
driving a deliberately complex idea — *"build a complex agentic AI coding tool"* — from a vague
one-line brief through a full **Tier 3** pipeline to a complete, coherence-gated, build-ready plan.

**Autocoder** (the product being specified) is an autonomous coding-agent CLI — a "mini Claude Code":
you give it a natural-language task, it plans, edits files across a repo, runs the project's tests,
observes the results, and iterates until the task is verifiably done or it stops. TypeScript/Node +
the Anthropic SDK + Vitest.

## Status: paused at Stage 9 (build not yet started)

The governing artifacts are complete and registered; **no production code has been written yet**.
The build (Stage 10) runs in a later session. Resume with `/twinharness:th-run` — the run picks up
from `current_stage: implementation-planning` in `.agentic-sdlc/state.json` with no rework.

| | |
|---|---|
| Tier | **T3** (blast-radius: `data-integrity`) |
| Current stage | `implementation-planning` |
| `implementation_allowed` | `false` (build gated by human) |
| Approved artifacts | 18 (all Critic-gated; blast-radius stages human-gated) |
| Coverage | 33/33 requirements mapped to a slice (tests written during the build) |

## What's here

- `docs/01-requirements.md` … `docs/09-implementation-plan.md` — the full T3 artifact chain
  (requirements → scope → domain model → architecture → ADRs → technical design → contracts →
  security → failure modes → test strategy → vertical-slice plan).
- `docs/05-adrs/` — 8 Architecture Decision Records.
- `docs/tasks/` — 19 self-contained Builder task files (SLICE-0 … SLICE-10).
- `.agentic-sdlc/state.json` — the authoritative run state (tier, stage, approved-artifact hashes).
- `drift-log.md` — the bidirectional drift log (empty until the build runs).

## How it was produced

Each stage was drafted by the **Spec / Vertical-Slice agents**, then reviewed for coherence by the
**Critic** in a fresh context. The requirements, scope, security trust model, and the
concurrent-write data-loss decision were **human-gated**; the architecture's two irreversible
decisions (native tool-use; append-only JSONL transcript) were confirmed and recorded as ADRs.
State was kept authoritative throughout via the `th` CLI — never hand-edited.

## The build plan (Stage 9)

11 vertical slices. Slice 0 is a walking skeleton that wires every architectural boundary
end-to-end; slices 1–10 each add one user-demonstrable capability:

```
0 walking skeleton → 1 entry/config → 2 loop+retry → 3 read/search → 4 write/edit+diff+approval
→ {5 run-command+allowlist  ∥  6 apply-patch} → 7 budget/stop → 8 transcript+--json
→ 9 allowlist UX → 10 closed-loop acceptance
```

SLICE-5 and SLICE-6 are component-disjoint and may build in parallel; every other pair serializes
on a shared component (`th build plan` computes the waves once the slices are registered at build
kickoff).
