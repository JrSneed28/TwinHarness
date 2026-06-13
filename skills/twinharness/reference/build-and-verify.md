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

Update slice statuses as work progresses:

```
th slice set-status <SLICE-ID> in-progress   # before spawning the Builder
th slice set-status <SLICE-ID> done          # after the Critic code-review PASS
```

The wave schedule from `th build plan` is the mechanical input — not a judgment call. Apply it
exactly as computed.

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

## Stage 10.5 — Documentation

After all slices have passed the code-review Critic loop and before Final Verification, run the
Documentation stage. Documentation at this position describes drift-corrected reality.

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

**Critic loop (documentation mode).** After each mode, route to the **Critic agent in
`documentation` mode**, fresh context:

- Check `th revise status documentation --json` → if `escalate: true`, surface open grounded
  issues to the human and stop (cap reached, default 3 rounds).
- Critic **PASS** → proceed to the next mode or to Final Verification. Zero issues is a valid
  terminal state.
- Critic **FAIL** → run `th revise bump documentation`, route grounded defects back to the
  Doc-Writer agent, re-run. Repeat until PASS or escalation.

**No human gate** (Critic gates). Advance state after all modes pass:

```
th state set current_stage documentation
```

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

**Step 4 — Escalate genuine conflicts.**

If the Critic finds a grounded defect — a real incoherence introduced by the upstream change —
escalate per the normal producer→Critic loop (cap + human escalation at cap). If there is no
genuine conflict (the downstream artifact is unaffected by the diff), the Critic returns PASS and
the stale flag is cleared.

**What cascade re-verification is not.** It does not re-run all Critic modes from scratch. It does
not touch artifacts outside the diff-scoped stale set. It does not substitute for the human
correctness gate on the verification report.
