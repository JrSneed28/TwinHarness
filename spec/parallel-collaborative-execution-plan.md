# TwinHarness — Parallel & Collaborative Orchestration: Execution Plan

> **Status:** Draft execution plan (plan only — no source/build performed yet).
> **Companion to:** `spec/parallel-collaborative-orchestration.md` (the design/*what*).
> This document is the *how, in what order, in which files, with what tests*.
> **Executor:** this Claude Code session executes the phases below directly.
> **Re-sync note:** rebase onto `main` after the in-flight fix session lands, then execute.

---

## 0. Method & ground rules

We build this the way TwinHarness builds itself (the conventions in `spec/build-plan.md`):
the mechanical/prompt split, vertical slices with a walking skeleton first, REQ-anchored
unit tests, and a per-slice `npm run verify` gate.

1. **Mechanical truths get code; judgment gets prompts.** New coordination mechanics
   (section leases, debate ledger, blackboard fragment validation, spawn batching oracle)
   are deterministic, unit-tested `th` CLI surface. Debate/reconcile/red-team *judgment*
   stays in agent prompts.
2. **Hard CLI surface contract preserved.** The CLI never decides *which* agent/stage/design
   wins. New verbs only **record, compute, and collision-guard**. Any "decide" verb is a
   prompt. (This is the §3 boundary and the build-plan pre-mortem #1 mitigation.)
3. **Vertical slices, walking skeleton first.** Slice 0 proves the end-to-end parallel
   path on the cheapest stage before breadth. Never "all primitives first, then all agents."
4. **Every slice green before the next.** `npm run verify` (typecheck + build + test +
   `git diff --exit-code dist/`) is the per-slice gate. New CLI code ships with REQ-anchored
   unit tests. `dist/` is rebuilt and committed with each source change.
5. **No guarantee regression.** Every slice is checked against the 8 invariants in the
   design doc §1. A slice that weakens one is rejected.

**Requirement anchors** use the prefix `REQ-PCO-###` (Parallel & Collaborative
Orchestration) so `th anchors scan` / `th coverage check` track this work like any other.

---

## 1. Architecture of the change (what gets added, where)

Three layers change. Most effort is prompt/coordination; the new deterministic surface is small.

### 1a. New deterministic CLI surface (`src/`)
| Area | New module(s) | New command(s) |
|---|---|---|
| Section-level artifact leases | extend `src/core/leases.ts`, new `src/commands/artifact-lease.ts` | `th artifact claim <file>#<section>` / `release` / `leases` |
| Debate ledger | new `src/core/debate-log.ts` (mirrors `drift-log.ts`), `src/commands/debate.ts` | `th debate add/list/resolve` |
| Blackboard fragments | new `src/core/collab.ts`, `src/commands/collab.ts` | `th collab init/fragment/list/merge --stage <s>` |
| Wave dispatch oracle (batching) | extend `src/commands/build.ts` | `th build dispatch --json` (emits the full parallel set + per-slice spawn descriptors in one payload) |
| Soft-dependency / speculative dispatch | extend `src/core/wave.ts` | `depends_on_soft` handling in `computeWave` |

### 1b. State schema (`src/core/state-schema.ts`)
Additive, optional fields only (preserves byte-identical round-trips for existing states):
- `collab_open` — count of open blackboard rounds (resume aid).
- `debate_open_blocking` — open debates needing human reconciliation (feeds stop-gate, mirrors `drift_open_blocking`).
- `SliceState.depends_on_soft?: string[]` — interface-only deps eligible for speculative dispatch.
- `ArtifactSectionLease` records (in the lease ledger file, not state.json — same split as component leases today).

### 1c. Agents & skill (`agents/`, `skills/`)
- New: `agents/reconciler.md` (Pattern A/B merger + judge), `agents/red-team.md` (security/failure challenger), `agents/librarian.md` (repo-understanding, long-lived), `agents/merge-coordinator.md` (wave merge-back), `agents/test-author.md` (Pattern C).
- Edited: `agents/orchestrator.md` (gain `Agent` tool / explicit top-level coordinator role + spawn-batching mandate), `agents/spec.md` (debate-mode addendum), `agents/vertical-slice.md` (parallelism-optimizer handshake), `agents/builder.md` (triad blackboard channel), `agents/critic.md` (new `parallelism` + `debate-reconcile` modes).
- Edited: `skills/twinharness/SKILL.md` + both reference files (wire the patterns into each stage's playbook).

### 1d. MCP tool utilization (design-doc §8) — frontmatter + one guideline doc
The coordination phases assume the typed `mcp__plugin_twinharness_th__*` surface is actually
reachable and used; today it is utilized 0% (design doc §8). This is fixed **once, in Phase 0**,
across all agents — not per phase:
- **New:** `skills/twinharness/reference/mcp-tools.md` — the single **MCP Tooling Guideline**
  (canonical "prefer typed MCP over `node dist/cli.js`" rule + dynamic-discovery instruction +
  non-exhaustive snapshot table mapping each MCP tool to its `th` equivalent). The **only** file
  that changes when new tools are added.
- **Edited (all agents):** replace each explicit `tools:` allowlist with *no `tools:`* +
  a `disallowedTools:` denylist (re-expressing only the prior isolation), so every agent
  inherits all current **and future** MCP tools without per-agent edits. Add **one pointer
  line** to the guideline in each agent.
- **Edited:** `skills/twinharness/SKILL.md` (reframe "Running the `th` CLI" so MCP is primary,
  `node dist/cli.js` the fallback; add the pointer) + `commands/th-run.md` (same reframe;
  pre-approve `mcp__plugin_twinharness_th__*`, `Task`, `Agent` in `allowed-tools`).

---

## 2. Phased execution (mapped to the design roadmap)

Each phase is independently shippable and ordered by **boost ÷ risk**. Phases 1–2 deliver
the biggest wins with no new deterministic primitives; Phase 4 introduces the one new core
primitive (blackboard + debate ledger + section leases).

```
P0 Lock + MCP reach + skeleton ─▶ P1 Doc fan-out ─▶ P2 Build throughput ─▶ P3 Slice optimizer
                                                                      │
                          P5 Red-team ◀── P4 Debate primitive ◀──────┘
                                                                      │
                                                       P6 Librarian ─▶ P7 Speculative/cascade
```

---

### Phase 0 — Lock hardening + walking skeleton (prove the parallel path end-to-end)
**Goal:** make the concurrency core robust under real contention, then prove the cheapest
real parallelism + one coordinator merge with no new core primitive beyond a spawn descriptor.

- **Slice 0a — `withStateLock` Windows hardening (prerequisite).** The lock's contention
  path (`state-store.ts:86-87`) only treats `EEXIST` as "held, retry"; on Windows a concurrent
  `mkdirSync` on a contended dir can throw `EPERM` (and sometimes `EACCES`), which is rethrown
  and crashes the caller. This already fails `REQ-STATE-LOCK-001` on `windows-latest` CI.
  Treat `EPERM`/`EACCES` like `EEXIST` (wait/steal-if-stale/retry) so the single deterministic
  writer is reliable under load. **This is pulled into Phase 0 because every later phase — and
  Phase 4 especially (debate ledger + section leases add concurrent writers) — depends on a
  rock-solid lock.**
  - *Files:* `src/core/state-store.ts`, `tests/concurrency.test.ts` (already exercises it), `dist/` rebuild.
  - *Acceptance (`REQ-PCO-000`):* `REQ-STATE-LOCK-001` green on all three OS runners; N parallel
    `drift add` processes each increment with a unique id; no `EPERM` escape.
  - *Note:* this is the **targeted** EPERM fix, not the full `flock` migration (still §7 out-of-scope).

- **Slice 0b — spawn-batching oracle.** Add `th build dispatch --json` returning the full
  parallel set in one payload (wraps `runBuildNextWave`). Edit the build-and-verify playbook
  + orchestrator to **emit all wave `Agent` calls in a single message**. Give the
  orchestrator the `Agent` tool.
  - *Files:* `src/commands/build.ts`, `src/cli.ts`, `agents/orchestrator.md`, `skills/.../build-and-verify.md`, tests.
  - *Acceptance (`REQ-PCO-001`):* `th build dispatch` returns ≥2 slice descriptors for a
    disjoint two-slice fixture; orchestrator prompt instructs single-message batch spawn.
  - *Gate:* `npm run verify` green; manual: a two-slice fixture run spawns 2 Builders concurrently.

- **Slice 0c — MCP reachability (frontmatter denylist).** Convert every `agents/*.md` from an
  explicit `tools:` allowlist (which hard-excludes all MCP tools — design doc §8.2) to *no
  `tools:`* + a `disallowedTools:` denylist that re-expresses only the prior isolation
  (read-only agents deny `Write, Edit`; non-recursing leaves deny `Agent`; Builder denies
  nothing). Give `orchestrator.md` the same treatment so it carries `Agent` + all MCP tools
  (merges with the Slice 0b orchestrator edit). Pre-approve `mcp__plugin_twinharness_th__*`,
  `Task`, `Agent` in `commands/th-run.md`'s `allowed-tools`.
  - *Files:* all `agents/*.md`, `commands/th-run.md`, `tests/` (new guard).
  - *Acceptance (`REQ-PCO-002`):* a guard test (mirroring `tests/mcp-wiring.test.ts`) asserts
    **no agent frontmatter carries a `tools:` allowlist that omits the MCP surface** — every
    agent either omits `tools:` or uses `disallowedTools:`; each read-only agent still denies
    `Write`/`Edit`. Confirm the exact pre-approval pattern for a plugin-bundled server.
  - *Note:* verify the denylist behaves as documented in the running host (omit-`tools:` ⇒
    inherits MCP) on a one-agent smoke run before converting all ten.

- **Slice 0d — MCP Tooling Guideline (one doc) + wiring.** Add
  `skills/twinharness/reference/mcp-tools.md` (canonical prefer-MCP rule, dynamic-discovery
  instruction, non-exhaustive snapshot table mapping each MCP tool → `th` equivalent). Reframe
  `skills/twinharness/SKILL.md`'s "Running the `th` CLI" section so MCP is primary and
  `node dist/cli.js` the documented fallback; replace the scattered MCP parentheticals
  (`builder.md`, `debugger.md`, `orchestrator.md`, `build-and-verify.md`) with **one pointer
  line** to the guideline in each agent/skill/command.
  - *Files:* `skills/twinharness/reference/mcp-tools.md` (new), `skills/twinharness/SKILL.md`,
    `agents/*.md` (pointer line), `commands/th-run.md`, `tests/` (pointer-presence guard).
  - *Acceptance (`REQ-PCO-003`):* the guideline doc exists and lists current MCP tools by
    category with `th` parity; a guard test asserts each agent + `SKILL.md` references it; the
    guideline names **no** count/enumeration that would have to change per tool (snapshot is
    explicitly non-exhaustive). No `src/` change.
  - *Gate:* `npm run verify` green; existing `mcp-wiring`/`mcp-parity` tests unchanged.

**Why first:** isolates the single highest-impact, lowest-risk behavioral fix (batched
spawns) and proves the coordinator pattern before any new primitive exists. **Slices 0c/0d are
a prerequisite for every later phase** — the parallelism work calls the typed coordination
surface, which today no agent can reach (design doc §8).

---

### Phase 1 — Documentation fan-out (free win, zero conflict risk)
- **Slice 1 — parallel doc modes.** After `README`, dispatch T2/T3 doc modes
  (`user-guide`, `api-reference`, `developer-guide`, `changelog`) concurrently; each through
  its own `Critic(documentation)`.
  - *Files:* `agents/doc-writer.md`, `skills/.../build-and-verify.md` (Stage 10.5).
  - *Acceptance (`REQ-PCO-010`):* doc modes write disjoint files; no shared edits; each
    independently gated. No new CLI.
  - *Gate:* verify green; T3 fixture produces all five docs with parallel dispatch in playbook.

**No new primitive. Pure prompt/coordination.** Ship immediately.

---

### Phase 2 — Build throughput (biggest raw speedup)
- **Slice 2 — Merge-Coordinator agent.** New `agents/merge-coordinator.md` owns wave-order
  merge-back, `th build release` on clean merge, `th drift add --layer requirement` on dirty.
  Centralizes the single-top-level-controller invariant.
  - *Acceptance (`REQ-PCO-020`):* clean merge → release; conflict → BLOCKING drift entry;
    `drift_open_blocking` increments and stop-gate blocks.
- **Slice 3 — per-slice triad (Pattern C).** New `agents/test-author.md`; edit
  `agents/builder.md` to run Builder + Test-author + Verifier with the blackboard feedback
  channel inside the slice worktree. (Blackboard here can be the existing
  `delegations/` dir until Phase 4 generalizes it.)
  - *Acceptance (`REQ-PCO-021`):* triad delegation prompt wired; anchored tests authored
    concurrently with code; Verifier evidence routed without a main-context round-trip.
- *Gate:* verify green; existing lease/worktree/merge tests still pass (no regression to §16/§21).

**Reuses existing primitives** (leases, worktrees, merge-conflict-as-drift). Mostly agents.

---

### Phase 3 — Slice-plan parallelism optimizer (force-multiplier)
- **Slice 4 — optimizer critic mode.** New `Critic(parallelism)` mode that challenges the
  slice plan to **minimize shared components and `depends_on` edges**; vertical-slice agent
  reconciles. Add `th build plan --advise` output that reports current max-parallelism and
  the conflict pairs driving serialization (already computable from `conflictPairs`).
  - *Files:* `agents/critic.md`, `agents/vertical-slice.md`, `src/commands/build.ts`,
    `skills/.../pipeline-stages.md` (Stage 9), tests.
  - *Acceptance (`REQ-PCO-030`):* `th build plan --advise` reports parallelism width + the
    serializing conflict pairs; optimizer loop documented; coverage gate unchanged.
- *Gate:* verify green; coverage hard-gate still enforced.

**Widens every future wave** — multiplies the Phase-2 win.

---

### Phase 4 — Debate primitive (the one new deterministic core) ★
This is the only phase that adds a genuinely new deterministic primitive. Build the
mechanics first, test them, then wire the agents.

- **Slice 5 — blackboard core.** `src/core/collab.ts` + `th collab init/fragment/list/merge`.
  `merge` concatenates fragments and **validates every fragment carries REQ-ID anchors**
  (reuses `anchors.ts`); the *merge decision* stays with the Reconciler agent.
  - *Acceptance (`REQ-PCO-040`):* fragments written under `.twinharness/collab/<stage>/<round>/`;
    `merge` rejects an unanchored fragment; idempotent re-run.
- **Slice 6 — section-level artifact leases.** Extend `leases.ts` with `<file>#<section>`
  granularity; `th artifact claim/release/leases`. Same collision-guard + `withStateLock`
  semantics as `th build claim`.
  - *Acceptance (`REQ-PCO-041`):* two agents cannot hold the same section; disjoint sections
    co-held; stale-lease reconciliation mirrors component leases.
- **Slice 7 — debate ledger.** `src/core/debate-log.ts` (mirror `drift-log.ts`:
  parse/format/`nextDebateId`) + `th debate add/list/resolve`; `debate_open_blocking` feeds
  the stop-gate (mirror `drift_open_blocking` in `evaluateStopGate`).
  - *Acceptance (`REQ-PCO-042`):* open debate blocks completion; `resolve` clears it;
    resumable from ledger after a simulated crash.
- **Slice 8 — Reconciler agent + debate wiring.** New `agents/reconciler.md`; wire Pattern B
  into Domain Model + Architecture (competing producers → reconcile → human gate on the
  distilled 1–2 forks → ADR drafts from the debate ledger).
  - *Acceptance (`REQ-PCO-043`):* architecture debate produces a reconciled artifact + ADR
    drafts traceable to ledger entries; human gate sees only the distilled fork-set.
- *Gate:* verify green; **new stop-gate condition covered by tests**; existing stop-gate
  behavior unchanged when `debate_open_blocking == 0`.

---

### Phase 5 — Standing red-team (quality + hidden latency)
- **Slice 9 — red-team agent.** New `agents/red-team.md`; runs Security/Failure challengers
  **concurrently with downstream design stages** via the blackboard, posting grounded attacks
  that design agents must answer or convert to drift. Human gate on the security model
  unchanged.
  - *Acceptance (`REQ-PCO-050`):* red-team posts component-anchored attacks; unanswered
    attack → drift/debate entry; no auth decision streams past a gate.

---

### Phase 6 — Librarian (context hygiene)
- **Slice 10 — repo-understanding agent.** New `agents/librarian.md`, long-lived, owns the
  repo-map (`repo-map/query.ts`) + artifact-summary index; answers locate/summary queries so
  the main context never reloads big artifacts.
  - *Acceptance (`REQ-PCO-060`):* peers resolve "where is REQ-X / summary of contracts §3"
    via the Librarian capsule; main-context artifact reloads measurably reduced in a fixture run.

---

### Phase 7 — Speculative dispatch + parallel cascade re-verify (incremental)
- **Slice 11 — soft dependencies.** Add `depends_on_soft` to `SliceState`; `computeWave`
  allows speculative dispatch against an upstream **contract** in a separate worktree; the
  merge-conflict-as-BLOCKING-drift backstop catches bad speculation.
  - *Acceptance (`REQ-PCO-070`):* a soft-dep slice dispatches before its upstream is `done`;
    a conflicting speculation surfaces as drift, not corruption.
- **Slice 12 — parallel cascade re-verify + parallel research/debuggers.** The `th stale`
  diff-scoped set re-runs each downstream Critic concurrently; multiple Researchers/Debuggers
  on independent topics/slices.
  - *Acceptance (`REQ-PCO-071`):* stale set Critics dispatched in one batch; independent
    Debuggers scoped by sub-lease run concurrently without conflict.

---

## 3. Sequencing & dependencies

| Phase | Depends on | New core primitive? | Boost | Risk |
|---|---|---|---|---|
| P0 lock + skeleton + **MCP reachability** | — | lock hardening + spawn descriptor + MCP frontmatter/guideline (no `src/` for 0c/0d) | enabler / unblocks CI **+ makes the typed coord surface usable** | low |
| P1 docs | P0 | none | moderate (free) | very low |
| P2 build | P0 | none (reuses leases/worktrees) | **highest raw** | medium |
| P3 slicer | P2 | `--advise` (read-only) | force-multiplier | low |
| P4 debate | P0 | **yes** (collab+leases+ledger) | **highest quality** | medium-high |
| P5 red-team | P4 | none | high quality | medium |
| P6 librarian | P4 | none | context hygiene | low |
| P7 speculative | P3,P2 | `depends_on_soft` | incremental | medium |

Critical path to first user-visible speedup: **P0 → P1 → P2 → P3.** Quality track: **P4 → P5.**

---

## 4. Test & verification strategy

- **Unit (deterministic core):** every new `th` command gets REQ-PCO-anchored unit tests in
  `tests/` (mirror existing `leases`/`drift`/`wave` test patterns). Concurrency-sensitive
  paths (section leases, debate counter) get a concurrent-writers test proving
  `withStateLock` serialization holds.
- **Schema round-trip:** new optional fields must serialize byte-identically when absent
  (existing determinism test extended).
- **Stop-gate:** `debate_open_blocking` blocks completion; cleared by `resolve` — covered like
  the drift counter today.
- **Integration:** per phase, a fixture project run asserting the parallel dispatch happens
  and artifacts remain coherent (`th coverage check` / `th trace render` clean).
- **Regression gate:** `npm run verify` (incl. `git diff --exit-code dist/`) green on every
  slice; existing §16/§21 build tests unchanged.

---

## 5. Guardrails / invariant checklist (run per slice)

For every slice, confirm:
1. Only the Coordinator commits state (no agent writes `state.json`/ledgers directly).
2. New CLI verbs record/compute/guard only — no decision logic (§3 boundary).
3. Human gates (requirements, scope, irreversible arch, all auth/security, blocking drift,
   final correctness, debate forks) remain singular & sequential.
4. Every parallel fragment is REQ-anchored; coverage/trace stay clean.
5. Critic gate still runs unchanged; parallelism feeds it, never bypasses it.
6. Peer chatter stays on the blackboard; only capsules reach the main context.
7. No two agents write the same component/section without a lease.
8. Crash mid-phase resumes from `th state status` + ledgers with no orphan state.

---

## 6. Rollback / safety

- Every new primitive is **additive and optional**: with no debate/collab in flight and
  `write_gate`/leases untouched, behavior is byte-identical to today (the optional-field
  omission rule guarantees state compatibility).
- Each phase is a separate mergeable unit; reverting a phase removes its agents + CLI verbs
  without touching prior phases.
- The deterministic core stays the single source of truth; if any agent coordination misbehaves,
  the lease/merge/stop-gate backstops fail **closed** (block completion), never silently corrupt.

---

## 7. Out of scope (explicitly deferred)

- Full migration of `withStateLock` from `mkdir` to `flock` (only needed if critical sections
  grow long; current sections are <100 ms — revisit if Phase 4 contention shows timeouts). Note:
  the **targeted** Windows `EPERM`/`EACCES` hardening is *in scope* as Phase 0, Slice 0a — only
  the larger lock-mechanism swap is deferred.
- ~~Routing `th` calls through the persistent MCP server to cut node-respawn cost (a separate
  performance PR; orthogonal to parallelism).~~ **Revised:** making the agents/main context
  actually *use* the already-shipped MCP tools is now **in scope** as Phase 0, Slices 0c/0d
  (design doc §8) — this is both a correctness fix (the typed coordination surface the
  parallelism phases depend on is currently unreachable) and the source of the node-respawn
  saving. Still out of scope: any *further* MCP-server performance work beyond utilization
  (e.g. pooling, batching CLI calls, transport changes).
- Any change to the human-gate set or the §3 boundary.
