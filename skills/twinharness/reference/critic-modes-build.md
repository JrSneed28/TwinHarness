# TwinHarness Critic Modes — Build & Verification (part of the TwinHarness orchestrator playbook)

This file contains the grounded-defect checklists for Critic modes in the build and final verification stages:
`slice`, `code-review`, and `final-verification`. These stages validate the implementation plan and the completed code.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## `slice` — IMPLEMENTED (Slice 4)

**What to check for an implementation-plan artifact (`docs/09-implementation-plan.md`):**

Run in **fresh context** (spec §6.3, §6.5). You have not seen the design-stage reasoning; that
isolation is the point. Check the slice plan against the approved upstream summaries and the
§15.9 contract below.

- **Every slice is actually vertical (end-to-end).** A slice that touches only one layer — e.g.
  "implement the database schema," "write all the API handlers," "build the UI components" — is a
  **horizontal layer disguised as a slice**. Every slice must exercise the full path from interface
  to data (or the equivalent for this system's shape) for its capability. A disguised horizontal
  slice is a grounded defect.
- **Every slice delivers demonstrable, user-visible behavior.** A slice whose stated capability
  cannot be observed or verified by a human — only by reading code — does not deliver demonstrable
  behavior. "Internal scaffolding complete" is not a user-visible capability.
- **Every slice is independently testable via its acceptance tests.** Each slice must name the
  specific acceptance tests (from Stage 8 test strategy) that gate it. A slice with no acceptance
  tests, or whose acceptance tests are layer-local unit tests rather than end-to-end behavioral
  tests, is a grounded defect.
- **The ordering yields a working system after every slice.** After each slice is applied in the
  stated order, the system must be in a runnable, regression-safe state — not "will work once the
  next three slices land." An ordering that requires multiple slices before anything integrates is
  a grounded defect.
- **The slices cover all MVP REQ-IDs with no gaps.** Every MVP REQ-ID from
  `docs/01-requirements.md` must appear in the REQ Coverage Map and be satisfied (fully or
  partially) by ≥1 slice. A REQ-ID with no slice coverage is a coverage gap — a grounded defect.
- **No two slices duplicate the same REQ-ID coverage without justification.** Overlap is a defect
  unless explicitly justified (e.g. a REQ-ID satisfied partially by two slices, documented as
  such).
- **Slice 0 is a genuine walking skeleton.** Slice 0 must: exercise every significant
  architectural boundary in a single end-to-end round-trip; have an integration acceptance test;
  deliver no substantial user feature beyond proving the integration holds. A Slice 0 that is
  "just the data model" or "just the project scaffold with no integration test" is not a walking
  skeleton — it is a horizontal layer.

Grounded defect examples for this mode:

> "Slice 3 is a horizontal data-layer task — it only implements the database schema with no
>  interface or logic path; it is not a vertical slice"
> "REQ-007 is covered by no slice in the REQ Coverage Map — coverage gap (spec §15.9)"
> "Slice 2's acceptance tests are unit tests against a single module, not end-to-end behavioral
>  tests; spec §15.9 requires anchored end-to-end acceptance tests per slice"
> "Slice 0 contains no integration test and does not exercise the API-to-database boundary;
>  it is a scaffold, not a walking skeleton"
> "Slices 1–4 all depend on Slice 5 completing before any of them integrate; the ordering does
>  not yield a working system after each slice"

---

## `code-review` — IMPLEMENTED (Slice 5)

**Context:** Integration Review and Code Critic are collapsed into this single mode (spec §6.5).
Run in **fresh context** — you have not seen the author's reasoning or the build session. That
isolation is the point.

**What to check for a completed slice (implementation + tests in `src/` and `tests/`):**

- **Implementation matches the contracts it claims.** For every contract in `docs/07-contracts.md`
  that the slice touches, verify the implementation honours the precise interface: input types,
  output shape, error cases, and any stated invariants. A deviation (even a "compatible" one) is
  a grounded defect unless a drift entry covers it.
- **Anchored tests actually exist and exercise behavior.** For every REQ-ID the slice claims to
  satisfy, at least one test named `test_REQ<###>_<capability_slug>` must exist. Confirm with:
  ```
  th anchors scan --scan-tests --scan-code
  ```
  A REQ-ID that appears in the slice plan but has no anchored test is a grounded defect.
- **Tests are not tautologies.** A test that only re-states the implementation without asserting
  observable behavior is not a contract (spec §15.8 spirit). Check that each anchored test
  asserts a concrete, externally observable outcome — not just "function was called" or
  "no exception raised."
- **REQ-ID anchors present in test names.** Every test relevant to this slice must follow the
  `test_REQ<###>_<capability_slug>` convention. Tests without REQ-ID anchors do not count toward
  coverage.
- **No undocumented behavior introduced without a drift entry.** If the implementation does
  something not specified in the task file, the relevant contracts, or the relevant design notes,
  there must be a corresponding derived-layer drift entry in `drift-log.md`. Implementation that
  invents behavior with no drift log entry is a grounded defect.
- **Derived-doc updates accompany behavior changes.** If a derived artifact (architecture,
  contracts, domain model, technical design, slice plan) was changed during this slice's build,
  the change must appear in the diff. A behavior change with no corresponding doc update is a
  grounded defect — the doc and the code must move together (§10).
- **No requirement-layer contradictions silently present.** If any aspect of the implementation
  appears to contradict `docs/01-requirements.md` or `docs/02-scope.md`, that is a blocking
  defect — flag it explicitly and escalate; do not treat it as a derived-layer drift entry.

Grounded defect examples for this mode:

> "REQ-004 appears in the slice's REQ Coverage Map but no test named `test_REQ004_*` exists —
>  anchor missing (spec §11)"
> "Function `syncQueue()` returns `void` but `07-contracts.md §3` specifies it returns
>  `Promise<SyncResult>` — contract deviation with no drift entry"
> "`test_REQ007_export_csv` only asserts the function does not throw; it does not assert the
>  output shape or content — tautology, not a behavioral contract (spec §15.8)"
> "Architecture §3 now references `ThemeContext` but the implementation uses `PreferenceStore`;
>  `04-architecture.md` was not updated in this change — derived-doc drift without an update"
> "The implementation adds an undocumented `/admin/debug` endpoint not present in any task file,
>  contract, or design note, and no drift entry exists — undocumented behavior (spec §6.4)"

---

## `final-verification` — IMPLEMENTED (Slice 6)

**Context:** Stage 11 (spec §17). The Critic's job here is narrow and explicit: certify that the
verification report is **coherent** — its claims are internally consistent and traceable to the
anchors in the codebase. The Critic does **not** certify that the implementation is *correct*;
correctness is certified only by tests passing against reality and by the human (spec §11). That
distinction must be stated plainly in the report itself and is itself a grounded check.

Run in **fresh context** (§6.5). You have not seen the build sessions. That isolation is the point.

**Prerequisite CLI checks (run before reading the report):**

```
th trace render          # renders the on-demand traceability view; never a stored file (§17)
th coverage check        # asserts every MVP REQ-ID maps to ≥1 slice and ≥1 test
```

If `th coverage check` exits non-zero, the verification report cannot pass — there are coverage
gaps. Surface them as grounded defects immediately.

**What to check for the verification report (`docs/10-verification-report.md`):**

- **Coherence-vs-correctness separation is explicit.** The report must contain a section or
  clearly labelled block that states: the Critic certifies *coherence* (internal consistency,
  traceable anchors) and tests + the human certify *correctness*. A report that conflates the two,
  or that claims correctness solely on the basis of the Critic's review, is a grounded defect
  (spec §11, §17). This is the most important check in this mode.

- **Every MVP REQ-ID appears in the rendered traceability view with ≥1 test.** Run
  `th trace render` and read the output. Each REQ-ID must have an entry with a non-empty Test
  column. A REQ-ID present in `docs/01-requirements.md` but absent from the rendered view, or
  present with no test, is a grounded defect.

- **No requirement is unaddressed.** Cross-reference the REQ-ID list from `docs/01-requirements.md`
  against the traceability view. Every MVP REQ-ID must appear. A gap is a grounded defect even if
  the report body claims full coverage.

- **The report does not assert correctness that tests do not demonstrate.** If the report says a
  requirement is "met," verify that the traceability view shows a passing test for that REQ-ID.
  A correctness claim with no anchored test is a grounded defect. The Critic cannot substitute
  for those tests.

- **Traceability claims are anchored, not asserted.** The report may summarise the traceability
  view but must reference `th trace render` as the authoritative source and must not reproduce a
  hand-maintained matrix (spec §17 explicitly forbids a maintained traceability file — it rots).
  A report that presents a static, hand-curated matrix as if it were the authoritative traceability
  record is a grounded defect.

- **Coverage check is confirmed clean.** The report must record that `th coverage check` exited
  zero (or list the specific gaps if it did not). An absent coverage-check confirmation is a
  grounded defect.

- **Internal consistency of the report body.** Claims in the Executive Summary do not contradict
  claims in per-requirement sections; pass/fail statuses are consistent throughout; no section
  references a REQ-ID that does not exist in `docs/01-requirements.md`.

Grounded defect examples for this mode:

> "The report's 'Verification Summary' section claims all requirements are satisfied but does not
>  distinguish Critic coherence from test-demonstrated correctness — conflation of the two
>  (spec §11, §17)"
> "REQ-005 appears in docs/01-requirements.md but is absent from the th trace render output —
>  coverage gap; th coverage check would exit non-zero"
> "The report states REQ-008 is 'fully verified' but the traceability view shows no test in the
>  Test column for REQ-008 — correctness claim without a test (spec §11)"
> "The report includes a hand-maintained Requirements Traceability Matrix table as its primary
>  traceability record — spec §17 forbids maintained traceability files; th trace render is the
>  authoritative source"
> "Executive Summary says 12 requirements are covered; per-requirement section lists only 11 —
>  internal inconsistency within the report"
