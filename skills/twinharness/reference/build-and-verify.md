# TwinHarness Build, Documentation & Verification — Reference (part of the TwinHarness orchestrator playbook)

Full detail for Stage 10 (implementation / build loop / drift loop / parallel waves / write-gate),
Stage 10.5 (documentation), Stage 11 (final verification), and cascade re-verification (§18). Read
this when you enter any of those stages.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## Stage 10 — Software Implementation (all engaged tiers)

**Prerequisite gate (non-negotiable).** Do not begin until ALL are true:
- `th state verify` exits zero (the Stop hook enforces this independently).
- `drift_open_blocking` in `state.json` is `0`.
- An approved `docs/09-implementation-plan.md` exists (`th coverage check` previously exited zero).
- `implementation_allowed` is `true` (set by the Orchestrator once the slice plan is registered and
  tier prerequisites are cleared).

### Build loop — slice-by-slice, task-by-task

Spawn the **Builder agent (`agents/builder.md`)** for each slice in approved plan order. The Builder:

1. Reads only the task file (SLICE-N / TASK-MMM) + relevant artifact Summary blocks, not the full
   corpus (§9).
2. Implements production code + writes anchored tests in the **same change** (§11). Every test MUST
   carry its requirement's anchor in canonical hyphenated form (`REQ-001`, `REQ-NFR-002`) in the
   `describe`/`it` string or a `// Anchor: REQ-XXX` comment above the test — the literal string
   `th anchors scan` and `th coverage check` look for (e.g. `it("REQ-001: offline sync queues a
   write", ...)`), not only a bare function name.
3. Runs `th anchors scan --scan-tests --scan-code` to confirm anchors are present.
4. A **task** is complete only when its anchored tests pass and checks are green — not when asserted (§11).
5. After all tasks in a slice pass, runs the slice's **end-to-end acceptance tests**; the slice is
   complete only when those pass.

**Per-slice triad (Pattern C, REQ-PCO-021).** In each slice's worktree the Builder runs as a **triad**
with the **Test-Author agent (`agents/test-author.md`)** and a **Verifier**:

- The **Test-Author** extends the REQ-anchored suite **concurrently** with the Builder (same anchor
  rules as step 2), rather than the Builder writing every test serially.
- The **Verifier** runs checks **continuously** as code/tests land, surfacing failures early.
- The three exchange feedback over the **blackboard** (`delegations/` dir) so a Verifier failure or
  Test-Author gap reaches the Builder **without a main-context round-trip**.

The code-review **Critic still gates the slice** (loop below). The triad accelerates production
inside the slice; it does not replace the fresh-context Critic gate.

### Critic code-review loop (after each slice)

Route the completed slice to the **Critic agent (`agents/critic.md`) in `code-review` mode**, fresh
context:

- Check `th revise status code-review --json` → if `escalate: true`, surface open grounded issues to
  the human and stop (cap reached, default 3 rounds).
- Critic **PASS** → register the slice and advance. Zero issues is a valid terminal state — do not
  invent defects.
- Critic **FAIL** → run `th revise bump code-review`, route grounded defects back to the Builder,
  re-run until PASS or escalation.

### Context-budget checkpoint (after each stage and each build wave)

After a stage settles and after **each build wave**, check the context budget so the run never hits
a hard compaction mid-flight:

```
th budget check --files-read <n> --slices-built <n> --tool-calls <n> --artifacts <n> [--max <k>] --json
```

You supply the proxy counts; the deterministic layer returns `{ estTokens, pct, verdict }` against
the budget (`--max`×1000, else persisted `max_tokens`, else the tier-aware default). On the verdict:

- **`ok`** → dispatch the next wave.
- **`warn`** (pct ≥ 0.75) → finish the current wave, then consider a handoff before the next.
- **`over`** (pct ≥ 1.0) → **PAUSE** and surface an `AskUserQuestion`:
  - **"Continue in this session"** → proceed (accept compaction risk).
  - **"Fresh session"** → run **`th handoff write`** (writes `.twinharness/HANDOFF.md` — run state,
    the `th next` action, artifact Summary blocks, open questions, a *don't re-read `docs/`*
    directive), then **STOP** and print the exact `/twinharness:th-run` restart command. The user
    opens a **new Claude Code conversation**; that session runs `th resume` (then `th handoff verify`
    for `current_stage`/slice/artifact-hash parity) and continues from `current_stage`.

### Bidirectional drift loop (§10) — runs continuously during the build

The Builder classifies every discovery against the two-layer rule:

**Derived-layer drift (auto-write-back, NON-BLOCKING)** — when reality differs from a *derived* doc
(architecture, design, contracts, slice plan): wire the implementation into reality, update the
derived doc in the same change, log it, and continue immediately:
```
th drift add --layer derived --ref "SLICE-N / TASK-MMM" --discovery "..." --action "..."
```
Review derived entries asynchronously via `/th-drift`.

**Requirement / scope drift (BLOCKING, human gate)** — when a discovery contradicts
`docs/01-requirements.md` or `docs/02-scope.md`: the Builder stops the task and logs a blocking entry,
which increments `drift_open_blocking` (the stop-gate blocks all completion claims while it is > 0):
```
th drift add --layer requirement --ref "SLICE-N / TASK-MMM" --discovery "..." --action "build paused"
```
The Orchestrator escalates to the human (§8). **Only a human moves requirements/scope.** Build does
not resume until the escalation is resolved and `drift_open_blocking` is back to zero.

The source-of-truth rule (§4): **code wins on behavior; requirements win on intent.**

### Brownfield build protocol (`project_mode: "brownfield"`)

On an adoption run the build attaches to existing code rather than creating it from nothing:

- **Slice 0 is characterization, not skeleton** — its acceptance test pins the adoption seam end-to-
  end (per `docs/00-existing-codebase-analysis.md`) with existing components untouched.
- **Reuse over reimplementation** is normal derived drift: wire tests against the existing
  implementation and log a derived entry (`--discovery "existing <component> at <path> already
  satisfies REQ-XXX"`, `--action "reused; no reimplementation"`); build continues (non-blocking).
- **Existing code that contradicts a requirement-level REQ is BLOCKING** — handle as any requirement
  contradiction (stop, `--layer requirement`, escalate).
- **Stay inside the seam** — existing module code is off-limits except narrow conformance fixes that
  bring it into line with a requirement-level REQ, owned by the slice for that component within its
  write-gate boundary.

### Parallel builds (§16)

After the coverage gate passes, sync the slice plan into state and compute the wave schedule:

```
th slices sync
th build plan
```

`th slices sync` parses `docs/09-implementation-plan.md` and writes all slices into `state.slices`
(statuses preserved on re-sync). `th build plan` reads `state.slices` — not the raw document — and
computes a **wave schedule**: component-disjoint slices group into the same wave (built
concurrently); slices that share any component are serialized into separate waves to prevent merge
conflicts and drift races.

- **Within a wave:** spawn one Builder per slice concurrently (component sets guaranteed disjoint).
- **Across waves:** wait for all wave-N slices to pass the code-review Critic loop before spawning
  wave N+1. Shared components are the serialization boundary.

> **Emit a wave's Builder spawns in ONE message (critical for real concurrency).** "Concurrently" is
> mechanical: the Orchestrator MUST emit **all** of a wave's Builder spawn calls in a **single
> message / single turn** so they actually run in parallel — spawning them across turns serializes
> the wave. Run `th build dispatch` to get the full parallel set plus a ready-to-spawn per-slice
> descriptor in one payload, and emit every returned descriptor together in that one message.

Update slice statuses as work progresses:

```
th slice set-status <SLICE-ID> in-progress   # before spawning the Builder
th slice set-status <SLICE-ID> done          # after the Critic code-review PASS
```

The `th build plan` schedule is mechanical input — apply it exactly as computed, not as a judgment call.

**Speculative dispatch against an upstream contract (Slice 11, REQ-PCO-070).** A downstream slice that
needs only the *interface* of an upstream slice may declare that as `depends_on_soft` (interface-only)
rather than a hard `depends_on`. A slice whose only unmet dependencies are `depends_on_soft` may be
dispatched **SPECULATIVELY**: the Orchestrator spawns its Builder against the upstream's **published
contract** (`docs/07-contracts.md` / the upstream task file's contract block) *before* that upstream
is `done`, widening real parallelism when the interface is stable.

- **Hard `depends_on` still gates** — a true behavioral dependency stays serialized into a later wave.
  Speculation relaxes only the *ordering* wait on `depends_on_soft` edges; component-set disjointness
  is still required.
- **The merge backstop catches a bad speculation.** If the upstream contract shifts, the divergence
  surfaces at merge-back as a conflict between plan-disjoint slices, and the Merge-Coordinator's
  "non-clean merge → BLOCKING drift" backstop opens `th drift add --layer requirement` rather than
  hand-resolving.

### Worktree isolation + merge-back protocol (§21)

Parallel Builders — and any **scoped sub-Builder** spawned under a component sub-lease (see "Spawning
sub-agents (Phase 5)" in `agents/builder.md` / `agents/debugger.md`) — run in **isolated git
worktrees** (`isolation: worktree`), so half-written files in one slice are never visible to another.

**Single merge-back controller (REQ-PCO-020).** The **Merge-Coordinator agent
(`agents/merge-coordinator.md`)** is the SINGLE top-level controller that performs wave-order
merge-back — no Builder or sub-Builder merges its own branch. This centralizes the **single-
deterministic-writer invariant**: exactly one actor writes the main branch, so merges are serialized
and ordered. On a clean merge it runs `th build release <SLICE-ID>`; on a conflict between plan-
disjoint slices it opens BLOCKING drift instead of hand-resolving.

1. **Parallel Builders run in isolated worktrees** branched off the default branch (an unchanged
   worktree is auto-cleaned).

2. **Shared-state gotcha (load-bearing): `.twinharness/` must stay SHARED, not per-worktree.** The
   lease ledger, `state.json`, and drift log are a **cross-process coordination plane** — the
   collision guard in `th build claim` / `th build sub-claim` only works because every Builder reads
   and writes the **same** `.twinharness/`. Per-worktree copies would make the cross-process lock
   protect nothing (two Builders could "claim" the same component unseen). So worktrees isolate
   **CODE only**: every `th` state/lease/drift command from inside a worktree MUST target the **main
   project root** — pass `--cwd <main-root>`, or (preferred) use the typed MCP tools, which resolve
   `${CLAUDE_PROJECT_DIR}` to the stable root (see `skills/twinharness/reference/mcp-tools.md`). **One shared
   coordination plane; isolated code trees** — restate this in every Builder/sub-Builder prompt.

3. **On Critic PASS, the Merge-Coordinator merges each worktree branch back in WAVE ORDER.** Within a
   wave the branches are component-disjoint by construction, so they merge cleanly. (A `th` CLI cannot
   perform git merges; the merge is a Merge-Coordinator action, hooked by `th build release` on a
   clean merge and `th drift add` on a dirty one.)

4. **A NON-CLEAN merge is the mechanical signal of accidental shared-state coupling.** Two
   plan-disjoint slices producing a conflict is evidence of a coupling `th build plan` could not see.
   The Merge-Coordinator does NOT hand-resolve — it opens BLOCKING drift so the stop-gate refuses
   completion until a human decides:
   ```
   th drift add --layer requirement \
     --ref "<SLICE-A> + <SLICE-B>" \
     --discovery "merge conflict between plan-disjoint slices — accidental shared-state coupling" \
     --action "build paused for human resolution"
   ```
   A **clean** merge → the Merge-Coordinator runs `th build release <SLICE-ID>` and continues.

5. **Relationship to leases (useful redundancy).** The lease is the primary guard; worktrees add
   filesystem isolation; the merge is the after-the-fact backstop.

### Write-gate

Setting slice status to `in-progress` before spawning each Builder is also what the write-gate
(`th hook pretool-gate`) relies on for Phase-B component-boundary enforcement: writes to paths owned
by a slice that is not `in-progress` are flagged. The gate is always active when `state.json` exists
and is fail-open. Configure with `th state set write_gate ask|deny|off` (default `ask`). A fired gate
is a component-boundary escalation, not a retry. See `spec/write-gate-design.md`.

After each slice's Critic PASS, register the slice artifact and advance state:

```
th artifact register docs/09-implementation-plan.md --version N
th state set current_stage implementation
```

---

## Stage 10.5 — Documentation-Phase Gate (menu)

After all slices have passed the code-review Critic loop and before Final Verification, present this
**repeatable menu** via `AskUserQuestion`. Do **not** auto-generate documentation — wait for the user.

```
Documentation phase — what would you like to do?

[1] Write documentation      — run the Doc-Writer (tier-appropriate modes), then return here.
[2] Run qa-tester            — run a live QA pass against the built project, then return here.
[3] Skip → Final Verification — advance to Stage 11 now.
```

Only **[3]** advances the pipeline. **[1]** and **[2]** execute the requested work, then **return to
this menu** so the user may pick again. No documentation is generated unless the user picks **[1]**.

### Option [1] — Write documentation

Delegate to the **Doc-Writer agent (`agents/doc-writer.md`)** with the tier-appropriate mode set:

| Tier | Modes |
|------|-------|
| T1 | `readme` only |
| T2 | `readme`, `user-guide`, `api-reference` |
| T3 | `readme`, `user-guide`, `api-reference`, `developer-guide`, `changelog` |

**Summaries handoff (§9).** Pass Summary blocks of `docs/01-requirements.md`, `docs/02-scope.md`,
`docs/07-contracts.md` (if exists), and `docs/09-implementation-plan.md`. The doc-writer reads the
full `docs/07-contracts.md` for `api-reference` mode (contracts are source of truth for the API ref).

**Concurrent doc fan-out (T2/T3) — zero-conflict (REQ-PCO-010).** `readme` runs first and alone. After
it completes, the remaining modes — `user-guide`, `api-reference`, `developer-guide`, `changelog` —
write **DISJOINT output files** (one per mode), so they are a **zero-conflict fan-out** and MUST be
dispatched **CONCURRENTLY**: emit all their Doc-Writer spawns in **ONE message / single turn**
(spawning across turns serializes them and defeats the parallelism). Each fanned-out mode is gated
**independently by its own Critic in `documentation` mode** — one producer→Critic loop per mode.

**Critic loop (documentation mode).** After each mode, route to the **Critic agent in `documentation`
mode**, fresh context:

- Check `th revise status documentation --json` → if `escalate: true`, surface open issues and stop.
- Critic **PASS** → next mode (zero issues is a valid terminal state).
- Critic **FAIL** → run `th revise bump documentation`, route defects back to the Doc-Writer, re-run
  until PASS or escalation.

After all modes complete, advance state: `th state set current_stage documentation`, then **return to
the documentation-phase menu**.

### Option [2] — Run qa-tester

Delegate to the **Tester agent (`agents/tester.md`)** — the broad-QA live-app driver. It launches and
drives the real built project (CLI/service/web/TUI), classifies findings as PASS/FAIL/REGRESSION/
FLAKY, and routes them to `th drift add` / the blackboard. It does not write `docs/` and does not
self-certify pass.

Flow: `th delegate plan --intent review` (decides if a capsule is needed, suggests model/effort) →
`th delegate pack --agent tester` (bounded child handoff with tier, built artifacts, `current_stage`)
→ spawn the Tester with the handoff (it selects the driver per project type; `claude-in-chrome` for
web; tmux optional) → validate its returned capsule with `th delegate check --capsule <path>`. Then
**return to the documentation-phase menu**.

### Option [3] — Skip → Final Verification

Advance directly to Stage 11. No documentation is generated unless the user previously chose **[1]**.

---

## Stage 11 — Final Verification (T1 light → T3 full) — IMPLEMENTED (Slice 6)

After all slices have passed the Builder + code-review Critic loop and Stage 10.5 has passed the
Critic, run Final Verification to produce `docs/10-verification-report.md`.

**Step 1 — Render the traceability view (on demand, never stored).** `th trace render` scans the
durable REQ-ID anchors next to the code (requirements, design sections, contracts, slice/task IDs,
test names) and renders the authoritative view on demand. Because anchors move with the code it never
goes stale (§17). Do not maintain a separate traceability matrix file — it would rot. Shape:

```
Requirement | Design ref      | Contract | Slice / Task        | Test (anchor in description/comment) | Code
REQ-001      | tech-design §2  | API §3    | SLICE-2 / TASK-014  | it("REQ-001: …") / test_req001_*     | src/sync.ts
```

**Step 2 — Confirm coverage is clean.** `th coverage check` asserts every MVP REQ-ID maps to ≥1 slice
and ≥1 test — a **hard gate** (non-zero exit blocks the report until gaps are resolved; return to the
Vertical Slice agent or Builder, then re-run). For the planned/implemented/tested/passing breakdown
run `th coverage report`. If test commands are configured (`th verify add "<command>"`), run
`th verify run` here so the report's **passing** column and `th doctor` reflect a genuinely green
suite — `th verify run` is the only command that executes; suite passing is a correctness signal
certified by the human, not the Critic (§11).

**Step 3 — Produce the verification report.**

- **T1 light:** the Orchestrator (Spec agent, lightweight) writes `docs/10-verification-report.md`
  from `templates/10-verification-report.md`, recording that `th coverage check` exited zero and
  summarising `th trace render`.
- **T2/T3 full:** delegate to the Spec agent for a full draft, then route to the **Critic agent
  (`agents/critic.md`) in `final-verification` mode**, fresh context.

The report must **explicitly separate**:
- **Coherence** — certified by the Critic: claims internally consistent and traceable to the
  `th trace render` anchors.
- **Correctness** — certified by tests passing against reality and by the human (§11). The Critic
  cannot certify correctness; the report must state this plainly.

A report that conflates coherence with correctness, or claims correctness the tests do not
demonstrate, is a grounded defect the Critic returns (§11, §17).

**Critic loop (final-verification mode, T2/T3).**

- Check `th revise status final-verification --json` → if `escalate: true`, surface open issues and stop.
- Critic **PASS** (zero defects) → coherence-gated; present to the human for correctness sign-off (§8).
- Critic **FAIL** (≥1 defect) → run `th revise bump final-verification`, route defects back to the
  Spec agent, re-run until PASS or escalation.

**Human correctness gate.** After Critic PASS, present the rendered traceability view and the report
to the human via AskUserQuestion — the human is the final authority on correctness (§11). Do not
claim the project complete until the human has reviewed.

**Mechanical stop-gate at final-verification.** The stop-gate (`th hook stop-gate`) blocks completion
while any slice in `state.slices` has a status other than `done` or `blocked`. Finish or explicitly
block all remaining slices with `th slice set-status <SLICE-ID> done` (or `blocked`) before the run
may stop cleanly.

Register the artifact after human sign-off:

```
th artifact register docs/10-verification-report.md --version 1
th state set current_stage final-verification
```

---

## Cascade re-verification (§18) — IMPLEMENTED (Slice 6)

When an upstream artifact is revised and re-registered (new content hash), downstream artifacts that
depended on it are stale and may be incoherent against the new version.

**Step 1 — Get the stale set BEFORE re-registering.** `th stale --artifact docs/<changed-artifact>.md`
compares the recorded content hash against disk and returns all registered downstream artifacts in
pipeline order. Run it *before* re-registering; re-registering first updates the hash and `th stale`
would find no change. Capture the stale set.

**Step 2 — Re-register the changed upstream artifact.**
`th artifact register docs/<changed-artifact>.md --version N+1` records the new content hash in
`state.json`.

**Step 3 — Re-run the Critic diff-scoped, not full.** For each stale artifact, route to the **Critic
in the matching mode**, passing only the diff of the upstream summary (not the full upstream artifact)
as the change context. Check the cap first with `th revise status <mode> --json`. The Critic reviews
only whether the downstream artifact is coherent against the *changed portion* — not a full re-review.

**Run the stale set CONCURRENTLY (Slice 12, REQ-PCO-071).** The stale set is **independent** downstream
artifacts with no ordering dependency, so re-run the matching Critic for **every stale downstream
artifact concurrently**: emit all the stale-set Critic spawns in **ONE batched message / single turn**
(across turns serializes the cascade — same rule as the parallel-wave Builder spawns). Each stale
Critic runs in its own fresh context and respects its own `th revise status <mode>` cap. Independent
**Researchers** and **Debuggers** likewise run **in parallel** on independent topics/slices (see
`agents/researcher.md` and `agents/debugger.md`).

**Step 4 — Escalate genuine conflicts.** If the Critic finds a grounded defect (a real incoherence
from the upstream change), escalate per the normal producer→Critic loop (cap + human escalation at
cap). If there is no genuine conflict, the Critic returns PASS and the stale flag is cleared.

**What cascade re-verification is not.** It does not re-run all Critic modes from scratch, does not
touch artifacts outside the diff-scoped stale set, and does not substitute for the human correctness
gate on the verification report.
