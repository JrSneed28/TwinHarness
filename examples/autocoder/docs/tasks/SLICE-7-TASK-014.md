# SLICE-7 / TASK-014 — BudgetController: accrue + pre-turn guard + defaults

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-015, REQ-NFR-003
**Slice:** SLICE-7 — Budget, stop conditions & iteration/token ceilings
**Depends on:** SLICE-2 / TASK-005 complete (the loop the guard bounds)

---

## Goal

Implement `budget-stop` accrual and the **pre-turn guard**: accrue iterations and token usage
monotonically, and before each model call return a verdict that **prevents** the turn from starting
once `iterationsUsed >= maxIterations` (→ `max-iterations-reached`) or `tokensUsed >= tokenBudget`
(→ `budget-exhausted`); apply the conservative defaults (25 iterations, ~1,000,000 tokens) absent
config; fall back to a character-based token estimate when the SDK omits usage.

---

## REQ-IDs

- **REQ-015** — The CLI enforces a configurable maximum iteration count (default ceiling) and a
  configurable token/cost budget; reaching either ends the run cleanly with a clear reason.
- **REQ-NFR-003** — *Cost / runaway protection:* no run can exceed its configured iteration ceiling
  or token/cost budget; absent explicit config, conservative defaults apply.

---

## Relevant Contracts / Interfaces

```
IF-011 BudgetController:
  accrue(usage): usage { inputTokens: int≥0, outputTokens: int≥0 } — added to tokensUsed;
                 iterationsUsed++ per turn
  checkGuard(): → { proceed: boolean, stopCondition?: "max-iterations-reached"|"budget-exhausted" }
                 proceed=false ⇒ stopCondition set; AgentRun must NOT start the turn (RULE-006)
  Preconditions: Budget ceilings (maxIterations, tokenBudget) resolved from Config.
  Postconditions: accrual monotonic; the guard runs BEFORE the model call (a near-budget turn is
    PREVENTED, not aborted mid-flight — INV-004); exactly one StopCondition fires (INV-005).
  Side effect: emits budget-exceeded { kind, iterationsUsed, tokensUsed } when a ceiling is hit.

Defaults: maxIterations = 25, tokenBudget ≈ 1,000,000 (input+output per run).
usage.estimated:true signals a character-based estimate was used (DQ-001 / ODQ-005).
```

---

## Relevant Design Notes

- **Pre-turn guard, never mid-flight (RULE-006, INV-004):** the guard runs on every Iterating →
  Iterating step *before* `LlmClient.send`; once a ceiling is reached, the next turn does not start
  (no half-iteration — `test_REQ015_invalid_transition_to_iterating`).
- Ceilings are a **hard** backstop — a runaway/never-finalizing model is bounded by `maxIterations`
  (`test_REQNFR003_budget_pre_turn_guard_stops_runaway`).
- Token accrual uses the SDK's reported usage; when absent, a character-based estimate
  (`usage.estimated:true`).

---

## Acceptance Test(s)

- `test_REQ015_max_iterations_guard` — the pre-turn guard stops at `iterationsUsed >= maxIterations`
  (→ `max-iterations-reached`) before starting the turn.
- `test_REQ015_token_budget_guard` — the guard stops at `tokensUsed >= tokenBudget`
  (→ `budget-exhausted`) before starting the turn.
- `test_REQ015_usage_estimate_fallback` — a character-based estimate is used when the SDK omits usage.
- `test_REQ015_invalid_transition_to_iterating` — no half-iteration is started past a ceiling.
- `test_REQNFR003_no_run_exceeds_iteration_or_token_ceiling` — no run starts a turn past either
  ceiling.
- `test_REQNFR003_conservative_defaults_applied` — absent config, defaults (25 iters, ~1e6 tokens)
  apply.
- `test_REQNFR003_budget_pre_turn_guard_stops_runaway` — an infinite-tool-call stub stops in ≤
  maxIterations turns (ABU-008 reconciled).

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The controller matches IF-011; any newly-pinned detail promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-015 / REQ-NFR-003 still map to passing tests).

---

## Out of Scope for This Task

- Terminal StopCondition classification + RunOutcome + exit code (SLICE-7 / TASK-015).
- The final summary rendering of tokensUsed/iterationsUsed (SLICE-8).
