# Proposal: Parallel & Collaborative Orchestration for TwinHarness

> **Status:** Draft plan (no implementation yet). This document is the agreed plan
> for introducing genuine parallelism and multi-agent collaboration into TwinHarness
> while preserving its core guarantees. A separate session is currently fixing
> unrelated issues; this PR will be re-synced to `main` before implementation begins.
>
> **Scope of this PR:** plan only. No source, agent, skill, or CLI changes.

---

## 0. Why

`th-run` drives an LLM through **11–16 strictly serial design stages**, each a single
Producer → single Critic loop (up to 3 fresh-context rounds), before a build stage whose
parallelism collapses to serial in most real runs. The result: long wall-clock time, no
agents working together, no intra-stage concurrency.

The goal is to improve **performance, throughput, and build quality** without weakening
the central design: staged SDLC governance, deterministic state, artifact traceability,
verifier/critic loops, governed human decisions, context preservation, and controlled
progression from idea to implementation.

The central insight: **TwinHarness already has a mature parallel coordination plane**
(`withStateLock`, component leases + sub-leases, the wave scheduler, worktree isolation,
the capsule/delegation protocol, cascade staleness) — but it is wired only into the build
stage and only for code-disjoint slices. This plan **generalizes that existing
coordination plane upward into the design stages** and adds exactly one new capability —
structured agent debate/reconcile — on top of the same deterministic, single-writer core.
We reuse the guarantees instead of fighting them.

---

## 1. Invariants any parallelism MUST preserve

Every proposal below is checked against these. A design that breaks one is rejected.

1. **Single deterministic writer.** `state.json`, `drift-log.md`, `approved_artifacts`,
   the lease ledger — mutated only through `th` under `withStateLock`. N agents may *read*
   freely; exactly **one Coordinator commits**.
2. **The §3 boundary.** `th` computes and records; it never decides. Parallelism adds
   agents (deciders), never decision logic to the CLI.
3. **Governed human gates stay singular and sequential.** Requirements sign-off, scope
   sign-off, the 1–2 irreversible architecture decisions, *every* auth/security decision,
   blocking-drift resolution, final correctness. Never parallelized, delegated, or
   auto-resolved.
4. **Traceability is unbroken.** Every parallel fragment carries REQ-ID anchors so
   `th anchors scan` / `th coverage check` / `th trace render` still see one coherent graph.
5. **Coherence gating survives.** A stage is done only when its Critic returns zero
   grounded defects. Parallel production feeds the gate better input; it never skips it.
6. **Context stays bounded.** Agents collaborate through durable scoped files + capsules
   (a *blackboard*), never by streaming peer chatter into the orchestrator's window.
7. **No conflicting edits.** Two agents never write the same artifact region or code
   component concurrently without a lease on it.
8. **Idempotent resume.** A crash mid-parallel-stage resumes from `th state status` with
   no orphaned half-state.

---

## 2. Three collaboration patterns (the reusable building blocks)

Everything composes from three patterns plus one communication substrate.

### Pattern A — Fan-out / reconcile
Several agents work disjoint sub-problems in parallel; each emits a **fragment capsule**;
a **Reconciler** merges fragments into one artifact; the normal Critic gate runs.
*Use where sub-problems are genuinely independent* (per-component security analysis,
per-mode documentation, per-subsystem technical design).

### Pattern B — Debate / adversarial
Two-to-three agents independently produce **competing** outputs (designs, domain models,
threat models). A **Reconciler/Judge** (fresh context) cross-examines them, surfaces
genuine disagreements, and reconciles or escalates the 1–2 irreducible choices to the
human gate. *Use where real design ambiguity exists and a single producer would anchor
prematurely* (architecture, domain model, ADRs).

### Pattern C — Pipelined producer/consumer
Two roles work the **same** unit concurrently with a fast feedback channel: a **Builder**
implements while a **Test-author** extends the anchored suite and a **Verifier** runs it —
continuously, not after. *Use in the build loop and the slice-by-slice critic loop.*

### Communication substrate — a blackboard, not chat
A2A communication must not bloat context or break determinism. Both are protected by
**never letting peer messages enter the main control window**:

- A shared dir `.twinharness/collab/<stage>/<round>/` (mirrors the existing
  `delegations/DEL-###/` convention). Agents write **fragment files**, **critique notes**,
  and **debate turns** there.
- Peers read each other's fragments **directly from disk** in their own contexts — that is
  the "challenge / hand off partial findings" channel.
- Only the **Reconciler** emits a single capsule upward. The Orchestrator's main context
  sees only that capsule + the final registered artifact — never the raw debate.
- A **debate ledger** (`th debate …`, new) records turns and the final reconciliation
  deterministically, so disagreement → resolution is auditable and resumable, exactly like
  the drift ledger today.

---

## 3. Per-stage analysis

For each stage: **①** what stays sequential, **②** what parallelizes, **③** agents,
**④** collaboration (not just fan-out), **⑤** A2A comms, **⑥** merge/reconcile,
**⑦** guardrails, **⑧** payoff.

### Requirements (governed)
- **①** human sign-off gate; REQ-ID minting (single source).
- **②** elicitation fans out: functional REQs / NFRs+constraints / blast-radius+ambiguity hunter.
- **③** 2–3 Spec(requirements) by facet + Reconciler.
- **④** ambiguity-hunter challenges functional drafts before the human sees them.
- **⑤** facet fragments + cross-critique notes on the blackboard.
- **⑥** Reconciler mints canonical REQ-IDs once, dedups; Critic(requirements) gate.
- **⑦** centralized ID minting; human gate unchanged.
- **⑧** Low-moderate (short, human-gated). Mainly draft quality.

### Scope (governed)
- **①** the MVP cut + human sign-off.
- **②** apply the two pruning questions per candidate feature concurrently.
- **④** optional devil's-advocate agent argues to cut each kept item.
- **⑥** drafter reconciles; Critic(scope) gate. **⑧** Low; keep mostly as-is.

### Domain Model (debate candidate)
- **①** none beyond consuming summaries; no human gate (streams).
- **②** two modelers in fresh contexts produce competing models (Pattern B).
- **③** 2× Spec(domain-model) + Reconciler.
- **④** Reconciler cross-examines divergent concepts; each must ground in a REQ-ID;
  converged concepts merge, genuine forks escalate only if a real product fork.
- **⑥** one reconciled `03-domain-model.md`; Critic(domain-model) gate.
- **⑦** every concept REQ-anchored; glossary single-sourced. **⑧** High quality.

### Architecture (marquee debate stage)
- **①** the 1–2 irreversible decisions → human gate; auth never streams.
- **②** competing architectures produced before commit (sync-monolith vs. async-services …).
- **③** 2–3 Spec(architecture) + Reconciler/Judge + a Security/Failure red-team pair
  attacking each candidate concurrently.
- **④** red-team challenges candidates on the blackboard; architects answer or concede;
  Judge distills surviving trade-offs into the genuine forks for the human.
- **⑥** after the human picks, Reconciler writes `04-architecture.md` (folds Security/
  Failure for T1/T2); Critic(architecture) gate.
- **⑦** human gate is on the **reconciled fork-set**, not raw candidates.
- **⑧** Highest design-quality boost; wall-clock similar (candidates run concurrently).

### UI Design (governed taste gate)
- **①** human direction gate. **②** parallel UI-Designers elaborate the 2–3 directions.
- **④** light (intentional divergence, not debate); reconcile only after the human picks.
- **⑧** Moderate (richer choices, same gate).

### ADRs (T3)
- **①** acceptance of irreversible items = human gate.
- **②** one ADR per decision drafted in parallel → `docs/05-adrs/` (single dir register).
- **④** ADRs are the **output of the architecture debate ledger** — recorded
  reconciliations become ADR drafts directly. **⑧** Moderate, near-free if the debate ran.

### Technical Design (T3)
- **②** one designer per subsystem in parallel, each component-anchored.
- **④** interface-seam cross-checks on the blackboard.
- **⑥** Reconciler stitches `06-technical-design.md`; Critic gate. **⑧** High on large T3.

### Contracts (governed auth)
- **①** any auth scheme → human gate.
- **②** contracts per interface drafted in parallel.
- **④** a consumer-perspective agent challenges each contract before the gate.
- **⑥** Reconciler enforces cross-contract type consistency; Critic(contracts) gate.
- **⑧** High for API-heavy systems.

### Security (T3/blast-radius) & Failure Modes
- **①** security model + every auth decision → human gate (strictest stage).
- **②** threats per trust-boundary and failure-modes per component in parallel.
- **③/④** a **standing red-team that challenges** architecture/technical-design/contracts
  and later the implementation plan — adversarial collaboration, not isolated reporting.
- **⑥** Reconciler assembles `08a`/`08b`; Critic gates; human approves the security model.
- **⑦** generic checklist items discarded (existing anti-boilerplate); human gate unchanged.
- **⑧** High quality; red-team runs concurrently with later stages (hidden latency).

### Test Strategy
- **②** pyramid, per-REQ assignment, per-slice acceptance criteria fan out by area.
- **④** test agents hand the Vertical-Slice agent ready-made per-slice acceptance tests and
  later run beside Builders (Pattern C). **⑧** High — seeds build-stage parallelism.

### Vertical Slicing (determines all build parallelism)
- **①** the coverage hard-gate + Critic(slice); fresh-context decomposition stays single-author.
- **②** task-file authoring per slice fans out once the slice set is fixed.
- **④** add a **parallelism-optimizer critic** that challenges the slice plan to maximize
  disjoint-component, dependency-light slices — directly widening every future build wave.
- **⑥** optimizer posts re-cuts; slicer reconciles; Critic(slice) gate; `th coverage check`.
- **⑦** slices stay genuinely vertical (existing Critic); coverage gate unchanged.
- **⑧** Force-multiplier — every bit of build parallelism is bounded by slice disjointness.

### Implementation / Build (biggest raw-throughput win — see §4)
- **①** prerequisite gate; blocking-drift escalation; merge-back in wave order; single
  top-level controller for `next-wave`/`claim`/`release`.
- **②** Builders across disjoint slices in a wave; Builder+Test+Verifier within a slice
  (Pattern C); independent Debuggers on independent failures.
- **④** the Builder+Critic+Verifier triad uses the blackboard as the fast feedback channel.
- **⑥** Merge-Coordinator merges branches wave-by-wave; clean → `th build release`,
  dirty → BLOCKING drift (existing protocol).
- **⑦** leases + worktrees + merge-conflict-as-drift give triple protection.
- **⑧** Highest raw speedup, gated by slice-plan disjointness.

### Documentation (clean fan-out)
- **②** after `README`, T2/T3 modes (`user-guide`, `api-reference`, `developer-guide`,
  `changelog`) run fully in parallel — independent inputs/outputs, no shared edits.
- **⑥** each through Critic(documentation) independently. **⑧** Moderate and free.

### Final Verification (governed)
- **①** `th coverage check` gate; Critic(final-verification); human correctness gate;
  mechanical stop-gate (all slices `done`/`blocked`).
- **②** read-only evidence gathering (`th trace render`, `th coverage report`) parallelizes;
  keep `th verify run` Coordinator-serialized (unlocked, shell-executing).
- **⑧** Low — keep tight and sequential.

### Cross-cutting
- **Research** — multiple Researchers on independent topics that then **compare findings**
  and cross-check sources for contradictions before feeding design.
- **Codebase-Inspection (brownfield)** — runs concurrently with Requirements; can fan out
  one inspector per module, reconciled into `00-existing-codebase-analysis.md`.
- **Librarian (repo-understanding) agent** — a long-lived agent owning the repo-map +
  artifact-summary index, answering "where does REQ-034 live / summary of contracts §3" so
  the main context never reloads big artifacts (persistent form of `repo-map/query.ts`).
- **Cascade re-verification** — the diff-scoped stale set (`th stale`) re-runs each stale
  downstream Critic concurrently.
- **Drift** — derived-layer entries from parallel Builders serialize through
  `withStateLock`; blocking drift always escalates singularly.

---

## 4. Build/test layer in depth (where the biggest boost lives)

1. **Per-slice triad (Pattern C).** Inside each slice's worktree: Builder writes code,
   Test-author extends the anchored suite, Verifier runs checks continuously and pushes
   failures back via the blackboard. The code-review Critic still gates the slice.
2. **DAG-aware, optimistic wave dispatch.** Today `computeWave` holds any slice whose
   `depends_on` aren't all `done`. Fix at the source via the slice-plan optimizer; for
   *soft* (interface) dependencies, allow speculative dispatch against the upstream
   contract in a separate worktree — the merge-conflict-as-BLOCKING-drift backstop makes a
   bad speculation surface as drift, not corruption.
3. **Merge-Coordinator agent.** Owns wave-order merge-back, `th build release`, and
   dirty-merge → drift — the coordinator that merges results into deterministic artifacts
   (for code). Centralizing it preserves the single-top-level-controller invariant.
4. **Independent Debuggers.** Multiple failing slices → multiple Debuggers in parallel,
   each scoped by sub-lease to its slice's components (no overlap = no conflict).

---

## 5. A2A comms: clean, conflict-free, deterministic

Four rules satisfy "communicate / challenge / reconcile" without context bloat,
conflicting edits, or loss of deterministic control:

1. **Propose-then-commit.** Agents never write deterministic state. They write *proposals*
   (fragment files, capsules) to the blackboard. Exactly one Coordinator commits the
   reconciled result through `th` under `withStateLock`.
2. **Lease the artifact, not just the code.** Extend leases to **artifact sections**:
   `th artifact claim 04-architecture.md#security`. Same collision-guard, same lock.
3. **Blackboard for peer chatter; capsule for upward report.** Peers read fragments in
   their own contexts; the Orchestrator receives only the Reconciler's capsule.
4. **Debate ledger for determinism + resume.** `th debate add/list/resolve` mirrors
   `drift-log.ts` (parse/format/next-id, mutate under the lock) — auditable, idempotent,
   resumable.

**New deterministic primitives (all pure/mechanical, all respect §3):**
- `th artifact claim/release <file>#<section>` — section-level collision guard.
- `th debate add/list/resolve` — append-only debate ledger.
- `th collab merge --stage <s>` — concatenate + validate fragment anchors (the *merge
  decision* stays with the Reconciler agent; the CLI only records and checks).

**Two concrete blockers to fix alongside:**
- The orchestrator agent has no `Agent` tool (`agents/orchestrator.md`) — give the
  top-level coordinator role explicit spawn capability.
- Nothing enforces batching parallel spawns into one message — the coordinator prompt must
  emit all wave-Builder `Agent` calls in a single turn (this alone is why "no agents work
  together" happens even on disjoint waves today).

---

## 6. Guardrail summary

| Risk | Guardrail (mostly already present) |
|---|---|
| Lost state updates | One Coordinator commits under `withStateLock` |
| Conflicting artifact edits | Section-level artifact leases (new) |
| Conflicting code edits | Worktrees + leases + merge-conflict → BLOCKING drift |
| Context bloat | Blackboard files + capsule-only upward reporting |
| Weak/averaged output | Reconciler + unchanged Critic gate |
| Lost traceability | Every fragment REQ-anchored; coverage/trace unchanged |
| Bypassed governance | Human gates singular & sequential; auth never streamed |
| Non-resumable debate | Debate ledger (mirrors drift ledger) |
| `verify run` race | Keep Coordinator-serialized (unlocked, shell-executing) |

---

## 7. Prioritized roadmap (biggest boost ÷ risk)

1. **Documentation fan-out** — do first. Zero conflict risk, immediate win, no new primitives.
2. **Build-stage spawn batching + Merge-Coordinator + per-slice triad** — biggest raw
   throughput; primitives already exist. Mostly coordination/prompt.
3. **Slice-plan parallelism optimizer** — force-multiplier for #2; new Critic mode + prompt.
4. **Architecture/Domain-model debate (Pattern B) → ADRs** — biggest quality gain;
   needs the debate ledger + blackboard.
5. **Security/Failure red-team running concurrently with downstream stages** — quality +
   hidden latency; needs blackboard.
6. **Section-level artifact leases + Reconciler** — unlocks intra-artifact fan-out
   (technical-design, contracts, security); the one genuinely new deterministic primitive.
7. **Standing Librarian (repo-understanding) agent** — context hygiene across the board.
8. **Speculative DAG dispatch + parallel cascade re-verify + parallel Researchers/Debuggers**
   — incremental.

**Throughline:** #1–#3 are mostly coordination/prompt changes on primitives that already
exist and give the largest speed wins; #4–#6 add the genuine debate/reconcile collaboration
and need one new deterministic primitive (blackboard + debate ledger + section leases) —
all of which **extend, rather than weaken**, the existing single-writer, lease-guarded,
traceable core.

---

## 8. Note on this PR

This PR contains **the plan only**. A separate session is fixing unrelated issues; once it
lands, this branch must be **re-synced to `main`** (rebase/merge) before implementation
starts. No source, agent, skill, schema, or CLI behavior changes are included here.
