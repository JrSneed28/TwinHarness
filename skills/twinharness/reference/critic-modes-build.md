# TwinHarness Critic Modes — Build & Verification (part of the TwinHarness orchestrator playbook)

Grounded-defect checklists for Critic modes in the build and final-verification stages: `slice`,
`code-review`, and `final-verification`. These validate the implementation plan and the completed code.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## `slice` — IMPLEMENTED (Slice 4)

Check an implementation-plan artifact (`docs/09-implementation-plan.md`) in **fresh context** (spec
§6.3, §6.5) against the approved upstream summaries and the §15.9 contract:

- **Every slice is actually vertical (end-to-end).** A slice touching only one layer ("implement the
  schema", "all the API handlers", "the UI components") is a horizontal layer disguised as a slice —
  a grounded defect. Each must exercise the full interface-to-data path for its capability.
- **Every slice delivers demonstrable, user-visible behavior** — not "internal scaffolding complete."
- **Every slice is independently testable via named acceptance tests** (from Stage 8). No acceptance
  tests, or layer-local unit tests instead of end-to-end ones → defect.
- **The ordering yields a working system after every slice** — runnable and regression-safe, not "will
  work once the next three slices land."
- **The slices cover all MVP REQ-IDs with no gaps** (REQ Coverage Map). A REQ-ID with no slice → defect.
- **No two slices duplicate the same REQ-ID coverage** without explicit, documented justification.
- **Slice 0 is a genuine walking skeleton** — exercises every significant architectural boundary in one
  end-to-end round-trip with an integration acceptance test, delivering no substantial feature beyond
  proving integration. "Just the data model" / "just scaffold, no integration test" is a horizontal layer.

> Example: "Slice 3 only implements the database schema — horizontal data-layer task, not a vertical slice"
> Example: "Slice 0 has no integration test and does not exercise the API-to-database boundary — scaffold, not a walking skeleton"
> Example: "REQ-007 is covered by no slice in the REQ Coverage Map — coverage gap (spec §15.9)"

---

## `code-review` — IMPLEMENTED (Slice 5)

Integration Review and Code Critic collapse into this mode (spec §6.5). Run in **fresh context** — you
have not seen the author's reasoning or build session. Check a completed slice (implementation + tests
in `src/`/`tests/`):

- **Implementation matches the contracts it claims** — for every touched `docs/07-contracts.md`
  contract, honour input types, output shape, error cases, invariants. Any deviation without a drift
  entry → defect.
- **Anchored tests exist and exercise behavior.** Every claimed REQ-ID has ≥1 test named
  `test_REQ<###>_<slug>`. Confirm with `th anchors scan --scan-tests --scan-code`. A planned REQ-ID with
  no anchored test → defect.
- **Tests are not tautologies** (spec §15.8 spirit) — each asserts a concrete observable outcome, not
  "function was called" / "no exception raised."
- **REQ-ID anchors present in test names** (`test_REQ<###>_<slug>`); unanchored tests don't count toward coverage.
- **No undocumented behavior without a derived-layer drift entry** in `drift-log.md`.
- **Derived-doc updates accompany behavior changes** — a changed derived artifact (architecture,
  contracts, domain model, technical design, slice plan) must appear in the diff (§10).
- **No requirement-layer contradictions silently present** — a contradiction with
  `docs/01-requirements.md` / `docs/02-scope.md` is BLOCKING; flag and escalate, never a derived entry.

> Example: "REQ-004 is in the slice's coverage map but no `test_REQ004_*` exists — anchor missing (spec §11)"
> Example: "`syncQueue()` returns `void` but `07-contracts.md §3` specifies `Promise<SyncResult>` — contract deviation, no drift entry"
> Example: "Adds an undocumented `/admin/debug` endpoint absent from any task file/contract/design, no drift entry — undocumented behavior (spec §6.4)"

---

## `final-verification` — IMPLEMENTED (Slice 6)

Stage 11 (spec §17). The Critic's job is narrow: certify the verification report is **coherent**
(claims internally consistent and traceable to codebase anchors). The Critic does **not** certify
*correctness* — that is tests passing against reality + the human (spec §11). That distinction must be
stated plainly in the report and is itself a grounded check. Run in **fresh context** (§6.5).

**Prerequisite CLI checks (before reading the report):**

```
th trace render          # renders the on-demand traceability view; never a stored file (§17)
th coverage check        # asserts every MVP REQ-ID maps to ≥1 slice and ≥1 test
```

A non-zero `th coverage check` means coverage gaps — surface them as grounded defects immediately.

Check the verification report (`docs/10-verification-report.md`):

- **Coherence-vs-correctness separation is explicit** — a clearly labelled block stating the Critic
  certifies coherence and tests + the human certify correctness. Conflating them, or claiming
  correctness on the Critic's review alone, is a grounded defect (spec §11, §17). This is the most
  important check in this mode.
- **Every MVP REQ-ID appears in `th trace render` with ≥1 test** (non-empty Test column).
- **No requirement is unaddressed** — cross-reference `docs/01-requirements.md` against the view; any
  gap is a defect even if the body claims full coverage.
- **The report does not assert correctness tests do not demonstrate** — a "met" claim needs a passing
  test for that REQ-ID in the view.
- **Traceability claims are anchored, not asserted** — reference `th trace render` as authoritative;
  no hand-maintained matrix (spec §17 forbids a maintained traceability file — it rots).
- **Coverage check confirmed clean** — the report records `th coverage check` exited zero (or lists gaps).
- **Internal consistency** — Executive Summary doesn't contradict per-requirement sections; statuses
  consistent; no section references a nonexistent REQ-ID.

> Example: "Summary claims all requirements satisfied but doesn't distinguish Critic coherence from test-demonstrated correctness — conflation (spec §11, §17)"
> Example: "Report states REQ-008 'fully verified' but the trace view shows no test for REQ-008 — correctness claim without a test (spec §11)"
> Example: "Report presents a hand-maintained traceability matrix as its primary record — spec §17 forbids it; `th trace render` is authoritative"
