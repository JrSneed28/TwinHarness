# Implementation Plan — <project name>

> **Stage 9 — Implementation Planning & Vertical Slicing** (spec §15.9). Produced by the
> Vertical Slice Agent in a **fresh context**, uncontaminated by layer-by-layer design thinking
> (§6.3). Runs in all engaged tiers — lightweight in Tier 1, full in Tier 3. Streams; surfaces
> slice ordering to the human when sequencing has product implications. Verified by Critic in
> **slice mode** (fresh context: is each slice truly vertical? all MVP REQ-IDs covered? Slice 0
> a genuine skeleton?) and by **`th coverage check`** (mechanical: every MVP REQ-ID maps to ≥1
> slice and ≥1 anchored test; no pure-horizontal slice passes).

## Summary

<3–6 sentences: number of slices, what Slice 0 proves, the delivery arc (what the user can
demonstrate after each slice), and any ordering constraints worth surfacing. This block is the
default handoff currency — the Builder reads THIS before each slice, not the whole document (§9).>

- **Slice count:** <N slices (Slice 0 + N-1 feature slices)>
- **Walking skeleton proves:** <the one integration boundary Slice 0 validates end-to-end>
- **First user-visible capability:** <Slice 1 — one sentence>
- **All MVP REQ-IDs covered:** <yes / see Coverage Map below>

---

---

## Grounding Manifest Pointer

> **Builder-pause:** before any slice begins, the Builder reads this section. If the work class
> requires external grounds (`version-pin`, `digest-manifest`, or `visual-hash`) and the signed
> EvidenceManifest listed below does not exist or `th grounding check` is not clean for every
> required ground kind, **the Builder stops and surfaces the gap to the Orchestrator**. No slice
> — including Slice 0 — begins until all required grounds are signed and recorded. This is a
> mechanical blocker: a missing required ground is not a warning; it is a pre-condition the gate
> enforces under `TH_BSC10_ENFORCE`.

<Filled in by the Architect before slice planning proceeds. Copied from `docs/04-architecture.md`
→ Grounding Manifest Pointer. Point to the signed manifest — do NOT copy digest values here.>

- **Work class:** <greenfield | redesign | recreation | integration | migration>
- **Required ground kinds:** <version-pin | digest-manifest | visual-hash | a11y — list all>
- **Signed EvidenceManifest path:** <relative path, e.g., `.twinharness/grounding/manifest-<id>.json`>
- **Grounding check status at slice-plan time:** <output of `th grounding check` — must be clean>

*If this section reads "none required" and the work class is pure greenfield with no external
dependencies, the Builder-pause does not apply and slice execution proceeds normally.*

---

## Slicing Summary

<One paragraph explaining the slicing strategy: why these slices in this order, what principle
governs the boundaries (e.g., "each slice adds one user-facing capability, touching every layer
from CLI to storage"), and any trade-offs in ordering (e.g., "Slice 3 before Slice 4 because it
provides the auth context Slice 4 depends on"). Name the REQ-IDs the ordering was designed to
satisfy early.>

**Anti-horizontal rule:** every slice listed below is vertical — it touches the full stack end-to-end
for its capability. Pure horizontal-layer slices ("implement all database models") are not valid and
will be rejected by the Critic and by `th coverage check`.

---

## Slice 0 — Walking Skeleton

**Goal:** prove that the architecture's integration boundaries wire together correctly before any
real feature logic is added. The walking skeleton does almost nothing functionally — it exists to
surface wiring failures early, not to deliver user value.

<Describe the thinnest end-to-end path: which entry point is invoked, which layers it traverses
(e.g., CLI → Orchestrator → one Spec-Agent stub → artifact write → state update), and what
observable output proves the wiring works. Be specific about the boundary being validated. Name
the component labels from `04-architecture.md` that are touched.>

- **Path:** <entry point> → <component A> → <component B> → <observable output>
- **Components touched:** `<component-label-a>`, `<component-label-b>`
- **Observable output proving integration:** <what the human or test sees when it works>
- **REQ-IDs satisfied:** none (structural only) — *or* REQ-<###> partial
- **Anchored acceptance test:** `test_slice0_walking_skeleton_wires_end_to_end`
- **Definition of done:** the anchored test passes; `th coverage check` does not regress.

---

## Slice List (ordered)

<Repeat the SLICE-N block below for each slice after Slice 0. Order is the build order — Slice 1
is built first, Slice 2 second, etc. Each slice must be independently demonstrable and testable
before the next begins. Do not list a slice if its capability cannot be shown to a user without
the next slice also being complete — that is a sign the boundary is in the wrong place.>

---

### SLICE-1 — <name: one short capability phrase>

- **REQ-IDs satisfied:**
  - Full: REQ-<###>, REQ-<###>
  - Partial: REQ-<###> *(remaining portion in SLICE-<N>)*
- **User-demonstrable capability:** <One sentence a non-technical observer can verify. Starts
  with a verb: "User can…", "Running `th X` produces…", "The system stores…". No "infrastructure
  is set up" — that is horizontal.>
- **Components touched (end-to-end):** `<component-label-a>`, `<component-label-b>`, `<component-label-c>`
  *(These are the canonical labels from `04-architecture.md` §Major Components. The Orchestrator
  reads this field to decide whether this slice can build in parallel with another — §16.)*
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ<###>_<capability_slug>`
  - `test_REQ<###>_<capability_slug>`
- **Dependencies & order:** <"None — can start immediately" or "Requires SLICE-0 complete because
  `<component>` contract is established there.">
- **Definition of done:** all anchored acceptance tests above pass; `th coverage check` confirms
  REQ-<###> maps to this slice and at least one passing test; no regressions in earlier slices.

---

### SLICE-2 — <name>

- **REQ-IDs satisfied:**
  - Full: REQ-<###>
  - Partial: REQ-<###>
- **User-demonstrable capability:** <…>
- **Components touched (end-to-end):** `<component-label-x>`, `<component-label-y>`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ<###>_<capability_slug>`
- **Dependencies & order:** Requires SLICE-1 complete.
- **Definition of done:** <…>

---

### SLICE-N — <name>

- **REQ-IDs satisfied:**
  - Full: REQ-<###>
  - Partial: *(none)*
- **User-demonstrable capability:** <…>
- **Components touched (end-to-end):** `<component-label>`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ<###>_<capability_slug>`
- **Dependencies & order:** <…>
- **Definition of done:** <…>

---

## REQ Coverage Map

<This table is the mechanical coverage check. Every MVP REQ-ID from `01-requirements.md` must
appear in exactly one "Covered by slices" cell. `th coverage check` reads this table and the
anchored test names to verify: (1) every MVP REQ-ID maps to ≥1 slice, (2) every mapped slice
has ≥1 anchored passing test for that REQ-ID, (3) no slice is a pure horizontal layer. Fix any
gap before declaring the plan complete — a gap here means unplanned work will surface during
build, which is the failure mode this stage exists to prevent.>

| REQ-ID | Requirement (short label) | Covered by slice(s) | Coverage type |
|--------|--------------------------|---------------------|---------------|
| REQ-001 | <short label> | SLICE-1 | Full |
| REQ-002 | <short label> | SLICE-1 (partial), SLICE-3 (remainder) | Partial → Full |
| REQ-003 | <short label> | SLICE-2 | Full |
| REQ-NFR-001 | <short label> | SLICE-2, SLICE-N | Full |
| … | … | … | … |

**Verification:** `th coverage check` confirms the above mechanically. Any REQ-ID missing from
this table or lacking an anchored test in Stage 8 (`08-test-strategy.md`) is a blocking gap.

---

## Per-Slice Tasks & Task Files

<For each slice, list the ordered tasks within it. Each task gets a stable ID (`SLICE-N /
TASK-MMM`) and a self-contained task file at `docs/tasks/SLICE-N-TASK-MMM.md` (see template
`templates/task-file.md`). The Builder reads one task file at a time — summaries for context,
full task file for implementation detail (§9). Tasks within a slice are sequential; tasks in
independent slices may be parallel (see Build Order below).>

### SLICE-1 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-1 / TASK-001 | <title> | REQ-<###> | `docs/tasks/SLICE-1-TASK-001.md` |
| SLICE-1 / TASK-002 | <title> | REQ-<###> | `docs/tasks/SLICE-1-TASK-002.md` |

### SLICE-2 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-2 / TASK-003 | <title> | REQ-<###> | `docs/tasks/SLICE-2-TASK-003.md` |

### SLICE-N tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-N / TASK-MMM | <title> | REQ-<###> | `docs/tasks/SLICE-N-TASK-MMM.md` |

---

## Build Order & Dependencies

<Ordered list of slices for build execution. Annotate whether adjacent slices can be parallelized.
The rule (§16): two slices may build concurrently only if their "components touched" sets are
completely disjoint. The Orchestrator reads the per-slice "Components touched" fields above to
decide — this section makes the result explicit so it does not have to be re-derived each time.>

1. **SLICE-0** — Walking Skeleton *(prerequisite for all; must complete before any feature slice)*
2. **SLICE-1** — <name> *(sequential after SLICE-0; establishes `<component>` contract)*
3. **SLICE-2** — <name> *(sequential after SLICE-1; shares `<component-label>` with SLICE-1)*
4. **SLICE-3** — <name> *(parallel-eligible with SLICE-4 — disjoint component sets: `{component-a}` vs `{component-b}`)*
5. **SLICE-4** — <name> *(parallel-eligible with SLICE-3 — see above)*
6. **SLICE-N** — <name> *(sequential after SLICE-3 and SLICE-4; depends on both)*

**Parallel-eligible pairs / groups:**

| Slices | Basis for parallel eligibility |
|--------|-------------------------------|
| SLICE-3 + SLICE-4 | Disjoint components: `{<component-a>}` vs `{<component-b>}` — no shared write surface |
| <…> | <…> |

**Serialized pairs:**

| Slices | Reason for serialization |
|--------|--------------------------|
| SLICE-1 → SLICE-2 | Both touch `<component-label>`; concurrent writes risk merge conflict and drift race |
| <…> | <…> |

---

## Slice Verification Notes

<Checklist for the Critic in slice mode (spec §15.9). The Critic runs in a fresh context and
checks coherence only — that the slice plan is internally consistent with upstream artifacts and
that slices are genuinely vertical. These notes record what the Critic will verify and any
pre-existing acknowledged deviations.>

- [ ] Every slice is vertical: it touches the full stack end-to-end for its capability (no pure
      horizontal-layer slice passes — e.g., "implement all DB models" is rejected).
- [ ] Every slice delivers a user-demonstrable, independently testable capability.
- [ ] Slice 0 is a genuine walking skeleton: it exercises the integration boundary without
      delivering functional requirements.
- [ ] The ordering produces a working, demonstrable system after every slice completes.
- [ ] Every MVP REQ-ID from `01-requirements.md` appears in the REQ Coverage Map with ≥1 slice.
- [ ] Every slice in the Coverage Map has ≥1 anchored acceptance test in `08-test-strategy.md`.
- [ ] `th coverage check` passes with zero gaps on the coverage map above.
- [ ] Component labels in "Components touched" match the canonical labels in `04-architecture.md`.
- [ ] Parallel-eligible pairs confirmed disjoint by component-set inspection.
- [ ] No task file is missing for any task listed in Per-Slice Tasks above.
