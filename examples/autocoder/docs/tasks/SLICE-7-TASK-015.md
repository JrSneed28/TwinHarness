# SLICE-7 / TASK-015 — StopCondition classify + RunOutcome + bounded termination

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-014
**Slice:** SLICE-7 — Budget, stop conditions & iteration/token ceilings
**Depends on:** SLICE-7 / TASK-014 complete (the guard supplies ceiling stop conditions)

---

## Goal

Implement `budget-stop.classify`: take the terminating signal and produce exactly one
`StopCondition` and the derived `RunOutcome` status + exit code, so the `agent-run` loop **always
terminates** on one defined condition — task-success, max-iterations-reached, budget-exhausted,
model-give-up, or unrecoverable-error — with `exitCode == 0` iff `status == "succeeded"`.

---

## REQ-IDs

- **REQ-014** — The agent loop terminates on a defined stop condition: task success (model declares
  done and/or tests pass), max-iteration ceiling reached, cost/token budget exhausted, explicit
  give-up by the model, or unrecoverable error.

---

## Relevant Contracts / Interfaces

```
IF-011 BudgetController.classify(signal):
  signal: { kind: "task-success"|"model-give-up"|"unrecoverable-error"|"user-abort",
            testsPassed?: boolean }
  → { status: "succeeded"|"stopped"|"failed",
      stopCondition: one of the 5 conditions, exitCode: integer }
  Postcondition: exitCode == 0 IFF status == "succeeded" (RULE-011, INV-006). Exactly one
  StopCondition fires (INV-005).

Status derivation: task-success → succeeded; max-iterations-reached / budget-exhausted /
  model-give-up / user-abort → stopped; unrecoverable-error → failed.

TranscriptEntries: run-stopped { stopCondition }, run-completed { status, exitCode }.
```

---

## Relevant Design Notes

- **Bounded termination (RULE-007, INV-005):** the loop must reach exactly one terminal state; a
  model that never finalizes is bounded by the guard's `max-iterations-reached`/`budget-exhausted`
  (from TASK-014). A no-final-answer run stops cleanly (`test_REQ014_no_final_answer_budget_stop`).
- `user-abort` and ceiling stops are **Stopped** (clean), `unrecoverable-error` is **Failed**, only
  `task-success` is **Succeeded** (exit 0).
- No resume / fresh-run-only (`test_REQ014_no_resume_fresh_run`) — resume is V1, out of MVP scope.

---

## Acceptance Test(s)

- `test_REQ014_task_success_terminates` — task-success ends the run with exit 0.
- `test_REQ014_no_final_answer_budget_stop` — a model that never finalizes is bounded → Stopped.
- `test_REQ014_nonterminating_bounded` — a non-terminating loop is bounded by the guard.
- `test_REQ014_no_resume_fresh_run` — runs are fresh; no resume.

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] `classify` matches IF-011 (status/exitCode/stopCondition rules); any newly-pinned detail
      promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-014 still maps to a passing test).

---

## Out of Scope for This Task

- The pre-turn ceiling guard + accrual (SLICE-7 / TASK-014).
- Rendering the outcome as a human summary / `--json` (SLICE-8 / TASK-017).
- The CLI translation of `exitCode` into the process exit code (SLICE-1 / TASK-002 — reused here).
