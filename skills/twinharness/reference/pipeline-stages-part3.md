# TwinHarness Pipeline Stages — Part 3: Implementation Planning & Vertical Slicing (part of the TwinHarness orchestrator playbook)

This file contains Stage 9 (Implementation Planning & Vertical Slicing), including the
parallelism-optimizer loop (Phase 3, REQ-PCO-030) and soft dependencies (Phase 7, REQ-PCO-070).
It is part of the pipeline-stages reference; see [pipeline-stages.md](pipeline-stages.md) for
the index.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## Stage 9 — Implementation Planning & Vertical Slicing (all engaged tiers)

Delegate to the **Vertical Slice agent (`agents/vertical-slice.md`) in a FRESH CONTEXT** (spec
§6.3, §15.9). Fresh context is the mechanism: both humans and LLMs default to horizontal-layer
decomposition; a fresh context uncontaminated by the design-stage thinking produces cleaner
vertical slices.

**Summaries handoff (§9).** The Vertical Slice agent reads the **Summary blocks** of
`docs/01-requirements.md`, `docs/02-scope.md`, `docs/04-architecture.md`, and (if they exist)
`docs/07-contracts.md` and `docs/08-test-strategy.md`. Full artifacts fetched only on demand.

The agent produces:
- **Slice 0** — the walking skeleton: the thinnest end-to-end path that exercises every significant
  architectural boundary, with an integration acceptance test, even if it does almost nothing
  functionally. **Brownfield (`project_mode: "brownfield"`):** Slice 0 is instead a
  **characterization** test around the adoption seam (the integration point new work attaches to,
  per `docs/00-existing-codebase-analysis.md`), with existing components untouched — the system
  already boots, so there is no fresh skeleton to stand up.
- **Ordered subsequent slices**, each with: name; REQ-IDs satisfied; user-demonstrable capability;
  components touched end-to-end (drives §16 parallel-build serialization); anchored acceptance
  tests; dependencies and order; definition of done.
- **Ordered tasks and self-contained task files** (§9, `templates/task-file.md`) within each slice.
- **REQ Coverage Map** — every MVP REQ-ID mapped to ≥1 slice; machine-parseable for
  `th coverage check`.

Writes `docs/09-implementation-plan.md` from `templates/09-implementation-plan.md`. Streams;
surfaces slice ordering to the human **only** when the sequencing has real product implications
(e.g. what is demoable first).

**Tiering:** all engaged tiers run this stage. **T1** — lightweight (fewer slices, lighter task
files). **T3** — full detail (per-slice ADR references, detailed component list, full task files
with contracts and design notes embedded).

**Parallelism-optimizer loop (Phase 3, REQ-PCO-030 — runs BEFORE the slice gate and coverage
gate).** After the Vertical Slice agent produces the draft plan, run one reconciliation pass that
widens disjoint-component parallelism, then proceed to the unchanged gates below:

1. Route the draft to the **Critic agent in `parallelism` mode**, fresh context. That Critic
   consults `th build plan --advise`, which reports the plan's current max-parallelism width and the
   **conflict pairs** (slices with overlapping component sets or `depends_on` edges that serialize
   them — computed from `conflictPairs`). It returns concrete re-cut suggestions (split a shared
   component along its seam, hoist a shared dependency into Slice 0, break a needless `depends_on`
   edge), routed back to the Vertical Slice agent.
2. The **Vertical Slice agent reconciles** the plan: re-cuts *incidental* overlaps so more slices
   land in the same build wave, updating the **Components touched** field and the **Build Order &
   Dependencies** section. *Essential* shared boundaries are left as-is.
3. **The hard gates win.** This loop never weakens vertical-slice integrity or REQ coverage — it
   may not disguise a horizontal layer, drop a slice's user-visible capability, or remove coverage.
   The `slice` coherence gate and the `th coverage check` hard-gate (both below) run afterward and
   override any optimization. Zero re-cut suggestions is a valid PASS — an already-wide plan needs
   no change.

**Soft (interface-only) dependencies for speculative dispatch (Phase 7, Slice 11, REQ-PCO-070).**
When a slice needs only the *interface* of an upstream slice and not its finished behavior, the
Vertical Slice agent records that edge as **`depends_on_soft`** in the **Build Order &
Dependencies** section rather than a hard `depends_on`. A `depends_on_soft` edge lets the build
stage dispatch the downstream slice **speculatively** against the upstream contract before that
upstream is `done` (the merge-conflict-as-BLOCKING-drift backstop catches a bad speculation); a true
behavioral dependency stays `depends_on` and still gates. The mechanics live in
`skills/twinharness/reference/build-and-verify.md` (Parallel builds). Use `depends_on_soft` only for genuine
interface-only edges — over-using it to fake parallelism is caught at merge-back.

**Critic loop (slice mode).** Route the draft to the **Critic agent (`agents/critic.md`) in
`slice` mode**, fresh context:

- Check `th revise status slice --json` → if `escalate: true`, surface open grounded issues to
  the human and stop (cap reached, default 3 rounds).
- Critic **PASS** → proceed to coverage gate. Zero issues is a valid, celebrated terminal state.
- Critic **FAIL** → run `th revise bump slice`, route grounded defects back to the Vertical Slice
  agent, re-run. Repeat until PASS or escalation.

Grounded defects the Critic will catch: a disguised horizontal layer ("implement all DB schemas"
is not a vertical slice); a slice with no user-visible capability; a slice with only unit-test
acceptance criteria; a Slice 0 that does not integrate the architectural boundaries; ordering that
does not yield a working system after each slice; any MVP REQ-ID missing from the coverage map.

**Mechanical coverage gate (non-negotiable).** After Critic PASS, run:

```
th coverage check
```

This command asserts that every MVP REQ-ID maps to ≥1 slice and ≥1 test (spec §3). It is a
**hard gate** — non-zero exit means building does not start. Resolve any gap by returning to the
Vertical Slice agent (fresh context) and adding the missing coverage before proceeding.

**No human gate** (spec §8, §15.9). The slice plan streams. The human may interrupt at any point
but is not required to approve. Once the Critic passes and `th coverage check` exits zero,
register the artifact and advance state:

```
th artifact register docs/09-implementation-plan.md --version 1
th state set current_stage implementation-planning
```
