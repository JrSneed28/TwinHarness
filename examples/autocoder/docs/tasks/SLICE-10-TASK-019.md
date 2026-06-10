# SLICE-10 / TASK-019 — Closed-loop e2e + composite safety + offline determinism

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-NFR-001, REQ-NFR-002, REQ-NFR-005, REQ-NFR-007
**Slice:** SLICE-10 — Closed-loop acceptance (plan → edit → test-fail → self-correct → test-pass)
**Depends on:** ALL prior slices (SLICE-0…SLICE-9) complete — this is the integration slice

---

## Goal

Author the headline end-to-end acceptance test and the composite non-functional assertions: a
scripted multi-iteration `LlmClient` stub drives the **real** full system against a temp-dir fixture
repo through plan → edit → run tests (stubbed fail) → read failure → corrective edit → run tests
(stubbed pass) → final answer → exit 0, with every change in the transcript as a diff; plus a
one-scenario composite-safety test (out-of-root write blocked + non-allowlisted command gated + edit
gated), an offline-determinism test (full loop with both seams stubbed, no network / no real shell),
and the cross-platform confinement composite.

---

## REQ-IDs

- **REQ-NFR-001** — *Implementability:* the system is delivered as real, runnable, tested code; every
  functional REQ is verifiable by an automated test (satisfied structurally by the green suite).
- **REQ-NFR-002** — *Determinism of harness:* all non-LLM logic is deterministic and testable without
  live network or live model calls; the SDK and shell are injected behind interfaces.
- **REQ-NFR-005** — *Safety / least authority:* file mutations and command execution confined to the
  root, shell gated by the command policy, edits gated by the edit policy.
- **REQ-NFR-007** — *Portability:* runs across macOS/Linux/Windows on Node ≥ 18; path/command
  handling accounts for cross-platform differences.

---

## Relevant Contracts / Interfaces

```
Closed-loop e2e (08-test-strategy §End-to-End): entry = cli (or composed agent-run); a scripted
  LlmClient stub returns an ordered queue of ToolCalls ending in a finalAnswer; a CommandRunner stub
  returns deterministic exit codes (the fixture's test command returns exit 1 then exit 0 across
  iterations). Asserts the RunOutcome (status, exitCode, filesChanged, testsResult) and an
  inspectable Transcript with every change as a diff.

Composite safety (REQ-NFR-005): one scenario asserting REQ-021 (out-of-root write blocked) +
  REQ-016 (non-allowlisted command gated) + REQ-012 (edit gated) together.

Offline determinism (REQ-NFR-002): full loop → RunOutcome with no network call and no real
  subprocess; strictly sequential (one ToolCall fully resolved before the next; single transcript
  writer).
```

---

## Relevant Design Notes

- This slice writes **no new production component** — it integrates the components built in SLICE-0…9
  and proves they compose. If a gap surfaces, fix it in the owning slice's module (log to
  `drift-log.md`), not here.
- The closed-loop test is the **headline Success Criterion** ("closed loop demonstrated"): plan →
  edit → run tests → read a failure → self-correct → reach passing tests across multiple iterations,
  all changes as diffs.
- REQ-NFR-001 is a **meta-assertion** — `08-test-strategy.md` gives it no tautological standalone
  anchor; it is satisfied by every other anchored test passing on Node ≥18 + Vitest. The named
  `test_REQNFR001_implementability_all_functional_reqs_tested` exists for traceability and asserts the
  whole suite is green / `th coverage check` zero-gap.

---

## Acceptance Test(s)

- `test_closedloop_plan_edit_test_fail_selfcorrect_pass` — a scripted multi-iteration stub drives
  plan → edit → test-fail → read failure → corrective edit → test-pass → final answer → exit 0, with
  every change in the transcript as a diff (Success Criteria "closed loop demonstrated").
- `test_REQNFR001_implementability_all_functional_reqs_tested` — the full suite passes on Node ≥18 +
  Vitest and `th coverage check` reports zero gaps (meta-assertion).
- `test_REQNFR002_harness_runs_offline_with_stubbed_seams` — a full loop runs to outcome with both
  seams stubbed, no network / no real subprocess.
- `test_REQNFR002_sequential_no_inprocess_race` — one ToolCall fully resolved before the next; single
  transcript writer.
- `test_REQNFR005_writes_confined_commands_gated_edits_gated` — one end-to-end scenario: an out-of-root
  write is blocked (REQ-021), a non-allowlisted command is gated (REQ-016), and an edit is gated
  (REQ-012).

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green; the full suite (`npx vitest run`) is green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] No contract changes expected (integration only); if a gap forces one, promote it to
      `07-contracts.md` from the owning slice's module.
- [ ] `th coverage check` passes with **zero gaps** across REQ-001…025 and REQ-NFR-001…008;
      REQ-NFR-001/002/005/007 map to passing tests.

---

## Out of Scope for This Task

- Any new production component logic — fix gaps in the owning slice's module, not here.
- Live-API or real-subprocess testing (excluded by REQ-NFR-002; everything is stubbed-seam).
- The ≥90% line / ≥85% branch coverage measurement (a project-done quality bar run separately, not a
  per-test assertion).
