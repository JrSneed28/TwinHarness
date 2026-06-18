# TwinHarness Build, Documentation & Verification — Reference (part of the TwinHarness orchestrator playbook)

This file contains the full detail for Stage 10 (software implementation / build loop / drift
loop / parallel waves / write-gate), Stage 10.5 (documentation), Stage 11 (final verification),
and cascade re-verification (§18). Read this when you enter any of those stages.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## Stage 10 — Software Implementation (all engaged tiers)

**Prerequisite gate (non-negotiable).** Do not begin until ALL of the following are true:
- `th state verify` exits zero (the Stop hook enforces this independently).
- `drift_open_blocking` in `state.json` is `0` (no unresolved requirement-layer escalations).
- An approved `docs/09-implementation-plan.md` exists (`th coverage check` previously exited zero).
- `implementation_allowed` is `true` in `state.json` (set by the Orchestrator after the slice
  plan is registered and all tier prerequisites are cleared).

### Build loop — slice-by-slice, task-by-task

Spawn the **Builder agent (`agents/builder.md`)** for each slice in the approved plan order.
The Builder:

1. Reads only the task file (SLICE-N / TASK-MMM) + relevant artifact Summary blocks — not the
   full corpus (§9).
2. Implements production code + writes anchored tests in the **same change** (§11). Every test
   MUST carry its requirement's anchor in the canonical hyphenated form — `REQ-001`,
   `REQ-NFR-002` — in the `describe`/`it` description string or a `// Anchor: REQ-XXX` comment
   immediately above the test. This is the literal string `th anchors scan` and
   `th coverage check` look for. Because identifiers cannot contain hyphens, the matchable
   anchor lives in the description/comment (e.g. `it("REQ-001: offline sync queues a write", ...)`)
   not only in the bare function name (e.g. `test_req001_offline_sync_queues_write`).
3. Runs `th anchors scan --scan-tests --scan-code` to confirm REQ-ID anchors are present.
4. A **task** is complete only when its anchored tests pass and checks are green — not when the
   Builder asserts it (§11).
5. After all tasks in a slice pass, runs the slice's **end-to-end acceptance tests**. The slice
   is complete only when those pass.

**Per-slice triad (Pattern C, REQ-PCO-021).** Within each slice's worktree the Builder does not run
alone — it runs as a **triad** with the new **Test-Author agent (`agents/test-author.md`)** and a
**Verifier**:

- The **Test-Author** extends the REQ-anchored test suite **concurrently** with the Builder (same
  anchor rules as step 2), rather than the Builder writing every test itself serially.
- The **Verifier** runs checks **continuously** as code and tests land, surfacing failures as they
  appear instead of only at the end.
- The three exchange feedback over the **blackboard** — the existing `delegations/` dir — so a
  Verifier failure or a Test-Author gap reaches the Builder **without a main-context round-trip**.
  This keeps the tight build/test/verify loop inside the slice's worktree.

The code-review **Critic still gates the slice** (the loop below). The triad accelerates production
inside the slice; it does not replace the fresh-context Critic gate.

### Critic code-review loop (after each slice)

Route the completed slice to the **Critic agent (`agents/critic.md`) in `code-review` mode**,
fresh context, same producer→critic mechanic:

- Check `th revise status code-review --json` → if `escalate: true`, surface open grounded issues
  to the human and stop (cap reached, default 3 rounds).
- Critic **PASS** → register the slice and advance. Zero issues is a valid, celebrated terminal
  state — do not invent defects.
- Critic **FAIL** → run `th revise bump code-review`, route grounded defects back to the Builder,
  re-run. Repeat until PASS or escalation.

### Bidirectional drift loop (§10) — runs continuously during the build

The Builder classifies every discovery against the two-layer rule:

**Derived-layer drift (auto-write-back, NON-BLOCKING):**
When reality differs from a *derived* doc (architecture, design, contracts, slice plan, etc.):
- Wire the implementation into reality.
- Update the derived doc in the same change.
- Log the entry:
  ```
  th drift add --layer derived \
    --ref "SLICE-N / TASK-MMM" \
    --discovery "..." \
    --action "..."
  ```
- Build continues immediately. You review derived-layer entries asynchronously via `/th-drift`.

**Requirement / scope drift (BLOCKING, human gate):**
When a discovery contradicts `docs/01-requirements.md` or `docs/02-scope.md`:
- Builder stops the current task.
- Logs the blocking entry:
  ```
  th drift add --layer requirement \
    --ref "SLICE-N / TASK-MMM" \
    --discovery "..." \
    --action "build paused"
  ```
  This increments `drift_open_blocking`. The stop-gate blocks all completion claims while
  `drift_open_blocking > 0`.
- Orchestrator escalates to the human (§8). **Only a human moves requirements/scope.**
- Build does not resume until the human resolves the escalation and `drift_open_blocking` is
  back to zero.

The source-of-truth rule (§4): **code wins on behavior; requirements win on intent.**

### Brownfield build protocol (`project_mode: "brownfield"`)

On an adoption run, the build attaches to existing code rather than creating it from nothing. The
Builder applies these adaptations on top of the normal loop:

- **Slice 0 is characterization, not skeleton.** The first slice's acceptance test pins the adoption
  seam end-to-end (per `docs/00-existing-codebase-analysis.md`) with existing components untouched —
  proving the integration point before any new behavior lands.
- **Reuse over reimplementation — the common derived drift.** Discovering existing code already
  satisfies a REQ is normal derived-layer drift: wire tests against the existing implementation and
  log a derived entry (`--discovery "existing <component> at <path> already satisfies REQ-XXX"`,
  `--action "reused; no reimplementation"`). Build continues — non-blocking.
- **Existing code that contradicts a requirement-level REQ is BLOCKING.** Handle it exactly like any
  requirement contradiction (stop, `--layer requirement`, escalate). Only a human moves requirements.
- **Stay inside the seam.** Existing module code is off-limits except narrow *conformance fixes* that
  bring existing code into line with a requirement-level REQ — and those fixes belong to a slice that
  owns that component, within its write-gate boundary.

### Parallel builds (§16)

After the coverage gate passes, sync the slice plan into state and then compute the wave schedule:

```
th slices sync
th build plan
```

`th slices sync` parses `docs/09-implementation-plan.md` and writes all slices into
`state.slices` (statuses preserved on re-sync). `th build plan` reads `state.slices` — not the
raw document — and computes a **wave schedule**: slices whose component sets are disjoint are
grouped into the same wave and may be built concurrently; slices that share any component are
placed in separate waves and serialized to prevent merge conflicts and drift races.

- **Within a wave:** spawn one Builder per slice concurrently. Component sets are guaranteed
  disjoint by `th build plan`.
- **Across waves:** wait for all slices in wave N to pass the code-review Critic loop before
  spawning wave N+1. Shared components are the serialization boundary.

> **Emit a wave's Builder spawns in ONE message (critical for real concurrency).** "Concurrently"
> is mechanical, not aspirational: the Orchestrator MUST emit **all** of a wave's Builder spawn
> calls in a **single message / single turn**, so they actually run in parallel. Spawning them
> across separate turns serializes the wave. To get the full parallel set plus a ready-to-spawn
> per-slice descriptor in one payload, run `th build dispatch` and emit every returned spawn
> descriptor together in that one message.

Update slice statuses as work progresses:

```
th slice set-status <SLICE-ID> in-progress   # before spawning the Builder
th slice set-status <SLICE-ID> done          # after the Critic code-review PASS
```

The wave schedule from `th build plan` is the mechanical input — not a judgment call. Apply it
exactly as computed.

**Speculative dispatch against an upstream contract (Slice 11, REQ-PCO-070).** A downstream slice
that needs only the *interface* of an upstream slice — not its finished implementation — may declare
that relationship as `depends_on_soft` (an interface-only dependency) rather than a hard
`depends_on`. A slice whose only unmet dependencies are `depends_on_soft` may be dispatched
**SPECULATIVELY**: the Orchestrator spawns its Builder against the upstream's **published contract**
(`docs/07-contracts.md` / the upstream task file's contract block) *before* that upstream slice is
`done`, instead of waiting a full wave. This widens real parallelism when the interface is stable
even though the implementation is not.

- **Hard `depends_on` still gates.** A true dependency — where the downstream slice needs the
  upstream's *behavior*, not just its shape — stays `depends_on` and is serialized into a later wave
  exactly as before. Speculation applies only to `depends_on_soft` edges. Component-set disjointness
  (the wave rule above) is still required; speculation relaxes the *ordering* wait, not the
  shared-component serialization.
- **The merge backstop catches a bad speculation.** If the upstream contract shifts under the
  speculation (the interface the downstream built against was wrong), the divergence surfaces at
  merge-back as a **conflict between plan-disjoint slices** — and the Merge-Coordinator's existing
  "non-clean merge → BLOCKING drift" backstop (see the worktree merge-back protocol below) catches
  it: it opens `th drift add --layer requirement` for human resolution rather than hand-resolving.
  Speculation never needs a new failure path — it rides the existing merge-conflict-as-BLOCKING-drift
  guard.

### Worktree isolation + merge-back protocol (§21)

Parallel Builders — and any **scoped sub-Builder** one of them spawns under a component sub-lease
(see the "Spawning sub-agents (Phase 5)" section of `agents/builder.md` / `agents/debugger.md`) —
run in **isolated git worktrees** (`isolation: worktree` in `agents/builder.md`). A worktree gives
each concurrent slice its own branched-off copy of the **code tree**, so half-written files in one
slice are never visible to another. The protocol has five parts.

**Single merge-back controller (REQ-PCO-020).** The **Merge-Coordinator agent
(`agents/merge-coordinator.md`)** is the SINGLE top-level controller that performs wave-order
merge-back. All branch merges flow through it — no Builder and no sub-Builder merges its own branch.
This centralizes the **single-deterministic-writer invariant**: exactly one actor ever writes the
main branch, so merges are serialized and ordered rather than racing. Its mechanics are spelled out
in parts 3 and 4 below — on a clean merge it runs `th build release <SLICE-ID>`; on a conflict
between plan-disjoint slices it opens BLOCKING drift instead of hand-resolving.

1. **Parallel Builders run in isolated worktrees.** Each Builder (and each scoped sub-Builder)
   operates on its own `isolation: worktree` checkout branched off the default branch; an
   unchanged worktree is auto-cleaned.

2. **Shared-state gotcha (load-bearing): `.twinharness/` must stay SHARED, not per-worktree.**
   This is the part that is easy to get wrong and silently breaks everything. The lease ledger,
   `state.json`, and the drift log are a **cross-process coordination plane** — the collision guard
   in `th build claim` / `th build sub-claim` only works because every Builder reads and writes the
   **same** `.twinharness/`. If each worktree got its own copy of `.twinharness/`, each Builder would
   hold its own private lease ledger and the cross-process lock would protect **nothing** — two
   Builders could "claim" the same component and never see the conflict. So worktrees isolate
   **CODE only**: every `th` state / lease / drift command issued from inside a worktree MUST target
   the **main project root** — either pass `--cwd <main-root>`, or (preferred) use the typed MCP
   tools, which resolve `${CLAUDE_PROJECT_DIR}` to the stable project root regardless of which
   worktree the caller is in. See `reference/mcp-tools.md` for the MCP-first routing rule.
   **One shared coordination plane; isolated code trees.** Restate this in every Builder /
   sub-Builder delegation prompt — it is the single most important sentence of the parallel-build
   contract.

3. **On Critic PASS, the Merge-Coordinator merges each worktree branch back in WAVE ORDER.** When a
   slice's `code-review` Critic passes, the **Merge-Coordinator agent** merges its worktree branch
   back into the main branch before releasing it. It does this **wave by wave**: the `th build plan`
   schedule already serializes any slices that share a component into separate waves, so **within a
   wave the branches are component-disjoint and merge cleanly** by construction. (A `th` CLI cannot
   perform git merges — the merge is a Merge-Coordinator action; its mechanical hook is
   `th build release` on a clean merge, and `th drift add` on a dirty one, below.)

4. **A NON-CLEAN merge is the mechanical signal of accidental shared-state coupling.** If two
   slices the plan believed disjoint produce a merge **conflict**, that conflict is the evidence of
   a coupling the static `th build plan` could not see (e.g. two slices that both edit a file the
   plan never attributed to either component). The Merge-Coordinator does NOT hand-resolve it
   silently — it opens it as **BLOCKING** drift so the stop-gate refuses completion until a human
   decides:
   ```
   th drift add --layer requirement \
     --ref "<SLICE-A> + <SLICE-B>" \
     --discovery "merge conflict between plan-disjoint slices — accidental shared-state coupling" \
     --action "build paused for human resolution"
   ```
   A **clean** merge → the Merge-Coordinator runs `th build release <SLICE-ID>` and continues to
   the next slice / wave.

5. **Relationship to leases (acknowledged, useful redundancy).** The lease stays the scheduler's
   **live oracle** — `th build claim` / `th build next-wave` consult it, and it prevents the
   collision **up front**. Worktrees add **filesystem-level** enforcement (a Builder physically
   cannot see another slice's uncommitted files), and the merge adds a **second** conflict check
   **after** the fact (it catches a coupling the static plan never modeled). That the lease and the
   merge can both flag the same class of problem is deliberate redundancy: the lease is the primary
   guard; the merge is the backstop for what the static plan missed.

### Write-gate

Setting slice status to `in-progress` before spawning each Builder is also what the write-gate
(`th hook pretool-gate`) relies on for Phase-B component-boundary enforcement: writes to paths
owned by a slice that is not `in-progress` are flagged automatically. The gate is always active
when `state.json` exists and is fail-open throughout. Configure it with
`th state set write_gate ask|deny|off` (default `ask`). If a Builder reports the gate fired, treat
it as a component-boundary escalation — not a retry. See `spec/write-gate-design.md`.

After each slice's Critic PASS, register the slice artifact and advance state:

```
th artifact register docs/09-implementation-plan.md --version N
th state set current_stage implementation
```

---

## Stage 10.5 — Documentation-Phase Gate (menu)

After all slices have passed the code-review Critic loop and before Final Verification, present
the following **repeatable menu** via `AskUserQuestion`. Do **not** automatically generate
documentation — wait for the user to choose.

```
Documentation phase — what would you like to do?

[1] Write documentation      — run the Doc-Writer (tier-appropriate modes), then return here.
[2] Run qa-tester            — run a live QA pass against the built project, then return here.
[3] Skip → Final Verification — advance to Stage 11 now.
```

Only **[3]** advances the pipeline. **[1]** and **[2]** execute the requested work, then
**return to this menu** so the user may pick again (e.g., write docs → run QA → skip, or run
QA first, then write docs). No documentation is generated unless the user picks **[1]**.

---

### Option [1] — Write documentation

Delegate to the **Doc-Writer agent (`agents/doc-writer.md`)** with the tier-appropriate mode
set:

| Tier | Modes |
|------|-------|
| T1 | `readme` only |
| T2 | `readme`, `user-guide`, `api-reference` |
| T3 | `readme`, `user-guide`, `api-reference`, `developer-guide`, `changelog` |

**Summaries handoff (§9).** Pass Summary blocks of `docs/01-requirements.md`,
`docs/02-scope.md`, `docs/07-contracts.md` (if exists), and `docs/09-implementation-plan.md`.
The doc-writer reads the full `docs/07-contracts.md` for `api-reference` mode (contracts are
source of truth for the API reference).

**Concurrent doc fan-out (T2/T3) — zero-conflict (REQ-PCO-010).** `readme` runs first and on its
own. After `readme` completes, the remaining doc modes — `user-guide`, `api-reference`,
`developer-guide`, `changelog` — write **DISJOINT output files** (one file per mode, no shared
edits), so they are a **zero-conflict fan-out** and MUST be dispatched **CONCURRENTLY**: emit all
their Doc-Writer spawns in **ONE message / single turn** (spawning across separate turns serializes
them and defeats the parallelism). Each fanned-out mode is then gated **independently by its own
Critic in `documentation` mode** — one producer→Critic loop per mode, not a shared gate.

**Critic loop (documentation mode).** After each mode, route to the **Critic agent in
`documentation` mode**, fresh context:

- Check `th revise status documentation --json` → if `escalate: true`, surface open grounded
  issues to the human and stop (cap reached, default 3 rounds).
- Critic **PASS** → proceed to the next mode. Zero issues is a valid terminal state.
- Critic **FAIL** → run `th revise bump documentation`, route grounded defects back to the
  Doc-Writer agent, re-run. Repeat until PASS or escalation.

After all modes complete their Critic loops, advance state:

```
th state set current_stage documentation
```

Then **return to the documentation-phase menu**.

---

### Option [2] — Run qa-tester

Delegate to the **Tester agent (`agents/tester.md`)** — the broad-QA, live-app driver. It
launches and drives the real built project (CLI/service/web/TUI), classifies findings as
PASS/FAIL/REGRESSION/FLAKY, and routes them to `th drift add` / the blackboard. It does not
write `docs/` files and does not self-certify pass.

Delegation flow:

1. `th delegate plan --intent review` → determines whether a capsule is needed and suggests the
   model/effort for the Tester's tier.
2. `th delegate pack --agent tester` → produces a bounded child handoff with project context
   (tier, built artifacts, `current_stage`).
3. Spawn the Tester agent with the handoff. The Tester selects the right driver per project type
   (direct process/stdio for CLI/services; `claude-in-chrome` for web; tmux optional and never
   required).
4. Receive the Delegation Capsule and validate with `th delegate check --capsule <path>`.

After the Tester returns its capsule, **return to the documentation-phase menu**.

---

### Option [3] — Skip → Final Verification

Advance directly to Stage 11. No documentation is generated unless the user previously chose
**[1]** in this menu session.

---

## Stage 11 — Final Verification (T1 light → T3 full) — IMPLEMENTED (Slice 6)

After all slices have passed the Builder + code-review Critic loop, and after Stage 10.5
Documentation has passed the Critic, run Final Verification to produce
`docs/10-verification-report.md`.

**Step 1 — Render the traceability view (on demand, never stored).**

```
th trace render
```

This scans the durable REQ-ID anchors that live next to the code (requirements, design sections,
contracts, slice/task IDs, test names) and renders the view on demand. It is the authoritative
traceability source. Because anchors move with the code, this view never goes stale (spec §17).
Do not create or maintain a separate traceability matrix file — it would rot.

Rendered view shape:

```
Requirement | Design ref      | Contract | Slice / Task        | Test (anchor in description/comment) | Code
REQ-001      | tech-design §2  | API §3    | SLICE-2 / TASK-014  | it("REQ-001: …") / test_req001_*     | src/sync.ts
```

**Step 2 — Confirm coverage is clean.**

```
th coverage check
```

This command asserts every MVP REQ-ID maps to ≥1 slice and ≥1 test. It is a **hard gate** — a
non-zero exit means the verification report cannot be produced until the gaps are resolved. Return
to the Vertical Slice agent or Builder as needed, then re-run.

For the planned/implemented/tested/passing breakdown, run `th coverage report`. If the project's
test commands are configured (`th verify add "<command>"`), run `th verify run` here so the
report's **passing** column and `th doctor` reflect a genuinely green suite — coverage anchoring is
necessary but not sufficient for correctness. `th verify run` is the only command that executes;
the suite passing is a correctness signal, certified by the human, not the Critic (§11).

**Step 3 — Produce the verification report.**

- **T1 light:** the Orchestrator (Spec agent in a lightweight pass) writes
  `docs/10-verification-report.md` from the `templates/10-verification-report.md` skeleton,
  recording that `th coverage check` exited zero and summarising the `th trace render` output.
- **T2/T3 full:** the Orchestrator delegates to the Spec agent for a full draft, then routes to
  the **Critic agent (`agents/critic.md`) in `final-verification` mode**, fresh context.

The report must **explicitly separate**:
- **Coherence** — certified by the Critic: the report's claims are internally consistent and
  traceable to the anchors returned by `th trace render`.
- **Correctness** — certified by tests passing against reality and by the human (spec §11). The
  Critic cannot certify correctness. The report must state this distinction plainly.

A report that conflates coherence with correctness, or that claims correctness the tests do not
demonstrate, is a grounded defect the Critic will return (spec §11, §17).

**Critic loop (final-verification mode, T2/T3).**

- Check `th revise status final-verification --json` → if `escalate: true`, surface open grounded
  issues to the human and stop (cap reached, default 3 rounds).
- Critic **PASS** (zero grounded defects) → the report is coherence-gated. Present to the human
  for correctness sign-off (§8 — the human certifies correctness).
- Critic **FAIL** (≥1 grounded defect) → run `th revise bump final-verification`, route defects
  back to the Spec agent, re-run. Repeat until PASS or escalation.

**Human correctness gate.** After Critic PASS, present the rendered traceability view and the
report to the human via AskUserQuestion. The human is the final authority on correctness (§11).
Do not claim the project complete until the human has reviewed.

**Mechanical stop-gate at final-verification.** In addition to the human gate, the stop-gate
(`th hook stop-gate`) enforces a mechanical condition at this stage: it blocks completion while
any slice in `state.slices` has a status other than `done` or `blocked`. Finish or explicitly
block all remaining slices with `th slice set-status <SLICE-ID> done|blocked` before the run
may stop cleanly.

Register the artifact after human sign-off:

```
th artifact register docs/10-verification-report.md --version 1
th state set current_stage final-verification
```

---

## Cascade re-verification (§18) — IMPLEMENTED (Slice 6)

When an upstream artifact is revised and re-registered (its content changes, producing a new
hash), downstream artifacts that depended on it are stale and may be incoherent against the new
version.

**Step 1 — Get the stale set BEFORE re-registering.**

```
th stale --artifact docs/<changed-artifact>.md
```

Run this *before* re-registering. `th stale --artifact` compares the recorded content hash
against the file on disk and returns all registered downstream artifacts in pipeline order
(downstream-of-changed-artifact, registered artifacts only — not a diff of summaries; every
registered downstream artifact is returned when the file has changed). Capture this stale set.
If you re-register first, the recorded hash updates and `th stale` would find no change.

**Step 2 — Re-register the changed upstream artifact.**

```
th artifact register docs/<changed-artifact>.md --version N+1
```

This records the new content hash in `state.json`.

**Step 3 — Re-run the Critic diff-scoped, not full.**

For each artifact in the stale set, route to the **Critic in the matching mode**, passing only the
diff of the upstream summary (not the full upstream artifact) as the change context:

```
th revise status <mode> --json     # check the cap before re-running
```

The Critic reviews only whether the downstream artifact is coherent against the *changed portion*
of the upstream summary — not a full re-review from scratch. This keeps re-verification
proportionate to the actual change.

**Run the stale set CONCURRENTLY (Slice 12, REQ-PCO-071).** The diff-scoped stale set from
`th stale` is a set of **independent** downstream artifacts — each is re-checked against the same
upstream diff with no ordering dependency between them. So re-run the matching Critic for **every
stale downstream artifact concurrently**: emit all the stale-set Critic spawns in **ONE batched
message / single turn** (spawning them across turns serializes the cascade and defeats the
parallelism — same mechanical rule as the parallel-wave Builder spawns above). Each stale Critic
still runs in its own fresh context and respects its own `th revise status <mode>` cap.
Independent **Researchers** and **Debuggers** likewise run **in parallel** when they are working on
independent topics or independent slices (Researchers cross-check findings before feeding design;
Debuggers are scoped by sub-lease to disjoint components) — see `agents/researcher.md` and
`agents/debugger.md`.

**Step 4 — Escalate genuine conflicts.**

If the Critic finds a grounded defect — a real incoherence introduced by the upstream change —
escalate per the normal producer→Critic loop (cap + human escalation at cap). If there is no
genuine conflict (the downstream artifact is unaffected by the diff), the Critic returns PASS and
the stale flag is cleared.

**What cascade re-verification is not.** It does not re-run all Critic modes from scratch. It does
not touch artifacts outside the diff-scoped stale set. It does not substitute for the human
correctness gate on the verification report.
