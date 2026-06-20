# Test Strategy — <project name>

> **Stage 8 — Test Strategy** (spec §15.8). Tiers: T2, T3. Streams; asks the human about
> quality bars only where they are real tradeoffs (coverage targets, performance SLOs).
> Mechanically enforced by `th coverage check`: every MVP REQ-ID must map to ≥1 anchored
> test; every slice in the REQ Coverage Map must have ≥1 passing anchored test; any gap is
> a blocking failure before Stage 9 may proceed.

## Summary

<3–6 sentences: what this project's correctness proof strategy is, which test levels are
load-bearing, and what "done" means mechanically. This block is the default handoff currency —
the Builder reads THIS before each slice, not the whole document (§9).>

- **Test pyramid shape:** <unit-heavy / integration-heavy / e2e-only — one phrase>
- **Coverage gate:** every MVP REQ-ID maps to ≥1 anchored test (`th coverage check`)
- **Slice acceptance signal:** end-to-end acceptance tests pass; `th coverage check` green

---

## Test Philosophy

<One paragraph: the governing principle for this project's test approach. State which layer
of the pyramid carries the most weight and why — driven by the architecture (§4), contracts
(§7), and the blast-radius profile (§2). Name the irreducible correctness boundary: what
must pass before any slice is declared done? Reference §11 ("tests are the contract").>

---

## Test Levels & Rationale

<For each level used, state: what it covers, which components/boundaries it exercises, and
why it is load-bearing (or explicitly excluded) for this project. Rationale must reference
the architecture, contracts, or a REQ-ID — not a generic assertion that "unit tests are good."
Drop any level that genuinely does not apply; do not pad.>

### Unit Tests

<Which component logic is covered at unit level? What is deliberately NOT unit-tested here
(i.e., pushed to integration or contract level, and why)?>

### Integration Tests

<Which cross-component boundaries are exercised? Which contracts (§7) are validated at
this level? Name the specific interfaces — e.g., "CLI → Orchestrator boundary (§7 Contract-002)".>

### Contract Tests

<Which published interfaces have consumer-driven contract tests? If this project has no
published external API, state that explicitly and note how boundary correctness is otherwise
enforced.>

### End-to-End (Acceptance) Tests

<Per-slice acceptance tests live in §Per-Slice Acceptance Tests below. This sub-section
describes the e2e strategy: entry point, scope (happy path only? error paths?), and what
constitutes a passing e2e run for a slice.>

### Real-Path Proof Tests

<Required for any task with an External Dependency (see the task file's `## External Dependencies`).
A green test suite that only exercises mocks proves consistency, not reality — these tests prove the
USER-VISIBLE PRODUCTION PATH actually works end-to-end against the real (or official sandbox)
boundary. For each external boundary, specify:>

- **Persistence restart test** — data written in one process survives a process restart (proves real
  persistence, not an in-memory fake).
- **Real-auth-rejection test** — a deliberately bad credential is actually REJECTED by the real/sandbox
  provider (proves auth is wired to reality, not a no-op that always succeeds).
- **Real-provider request evidence** — a recorded real/sandbox request+response (or its capture) proves
  the live boundary was exercised, not a stub.
- **Real data-flow verification** — data flows through the real path end-to-end (not a hardcoded return).

<Any boundary still backed by a simulation at completion must be in the ledger (`th sim list`) and
gates completion (`th gate production-reality`). State "Not applicable — no external boundary" only
when the task file's External Dependencies says "None".>

### Performance / Load Tests

<Required only if REQ-NFR-### specifies a measurable SLO. If no performance REQ-ID exists,
state "Not applicable for this project" and omit further content. Do not add boilerplate
performance tests without a grounding REQ-ID.>

### Security Tests

<Required only if §08a-security-threat-model.md exists or a security REQ-NFR is defined.
Abuse cases from the threat model (§08a) map to negative tests here — list the mapping or
state "See Negative-Tests Map" in §08b if that document is the source.>

---

## REQ→Test Map

<This table is the mechanical coverage check read by `th coverage check`. Every MVP REQ-ID
from `01-requirements.md` must appear exactly once. The "Test name(s)" column uses the
`test_REQ<###>_<capability_slug>` anchor convention — these exact names appear in the test
files and are what `th coverage check` scans for. A REQ-ID with no row here is a blocking
gap; the Stage 9 plan cannot proceed until it is closed.>

| REQ-ID | Requirement (short label) | Test name(s) | Test level |
|--------|--------------------------|--------------|------------|
| REQ-001 | <short label> | `test_REQ001_<capability_slug>` | <unit / integration / e2e> |
| REQ-002 | <short label> | `test_REQ002_<capability_slug>`, `test_REQ002_<edge_slug>` | <…> |
| REQ-003 | <short label> | `test_REQ003_<capability_slug>` | <…> |
| REQ-NFR-001 | <short label> | `test_REQ_NFR001_<capability_slug>` | <…> |
| … | … | … | … |

**Verification:** `th coverage check` scans test files for these exact anchors. Any REQ-ID
missing from this table, or whose named test does not exist in the test suite, is a blocking
gap reported by the tool.

---

## Per-Slice Acceptance Tests

<For each slice defined in `09-implementation-plan.md`, list its end-to-end acceptance tests.
These are the tests the Builder runs to declare a slice done (§16). Tests must be end-to-end
for the slice's capability — not layer-local unit tests. Each test name follows the
`test_REQ<###>_<capability_slug>` convention so it appears in the REQ→Test Map above.>

### Slice 0 — Walking Skeleton

- **Anchored acceptance test:** `test_slice0_walking_skeleton_wires_end_to_end`
- **What it proves:** the architecture's integration boundary is correctly wired; the path
  from entry point through all touched components to observable output completes without error.

### Slice 1 — <name>

- `test_REQ<###>_<capability_slug>` — <one sentence: what observable behavior this asserts>
- `test_REQ<###>_<capability_slug>` — <…>

### Slice N — <name>

- `test_REQ<###>_<capability_slug>` — <…>

---

## Non-Functional Tests

<Tests for REQ-NFR-### items: performance SLOs, reliability targets, accessibility, security
posture. Each entry must cite its REQ-NFR-ID. If no non-functional REQs exist, state that
explicitly — do not add non-functional tests without a grounding requirement.>

| REQ-NFR-ID | What is measured | Test name | Pass threshold |
|------------|-----------------|-----------|---------------|
| REQ-NFR-001 | <…> | `test_REQ_NFR001_<slug>` | <concrete threshold> |
| … | … | … | … |

---

## Tooling

<Name the specific tools used for each test level. State the run command. If a tool choice
has a rationale (e.g., "vitest over jest because the project uses ESM"), state it in one
sentence — no padding.>

| Level | Tool | Run command |
|-------|------|-------------|
| Unit | <tool> | `<command>` |
| Integration | <tool> | `<command>` |
| E2E / Acceptance | <tool> | `<command>` |
| Coverage gate | `th coverage check` | `th coverage check` |

---

## Definition of Done

<The mechanical, non-negotiable definition of "done" for a task, a slice, and the project.
These must be checkable — not aspirational. Reference §11 and §16.>

**Task done:**
- Its anchored tests (`test_REQ<###>_*`) pass.
- No regressions in earlier slices.
- `th coverage check` does not report a new gap.

**Slice done:**
- All per-slice acceptance tests (§Per-Slice Acceptance Tests above) pass end-to-end.
- `th coverage check` confirms every REQ-ID in this slice maps to ≥1 passing test.
- No regressions in earlier slices.

**Project done:**
- Every MVP REQ-ID in the REQ→Test Map has ≥1 passing anchored test.
- All non-functional thresholds in §Non-Functional Tests are met.
- `th coverage check` passes with zero gaps.
- Final verification report (`10-verification-report.md`) produced and human-approved.
