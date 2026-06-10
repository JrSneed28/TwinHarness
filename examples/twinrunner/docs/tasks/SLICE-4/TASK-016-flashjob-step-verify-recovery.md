# SLICE-4 / TASK-016 — `FlashJob::step` — progress + verify-after-write + recovery steps

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-023, REQ-024, REQ-NFR-005, REQ-NFR-011
**Slice:** SLICE-4 — Flash workflow + guided RGH/JTAG troubleshooting (simulated)
**Depends on:** SLICE-4 / TASK-015 complete

---

## Goal

Implement `FlashJob::step(clock)`: deterministic 0→100% progress, a mandatory `Verifying`
(verify-after-write) phase before any Write can reach `Done`, and on failure a terminal `Failed`
carrying a non-empty, ordered, fixture-backed `recovery_steps` list. A panicking job is caught and
converted to a `Failed` event so the UI never crashes. Same inputs + `FakeClock` replay identically.

---

## REQ-IDs

- **REQ-023** — Flashing displays deterministic progress (0→100%), a live log, a clear
  success/failure result, and a simulated verify-after-write confirming the written image matches the
  intended image.
- **REQ-024** — On a flashing failure, present recovery steps (state of console/dump, what is safe to
  retry, how to avoid worsening) rather than a bare error.
- **REQ-NFR-005** — Determinism: identical inputs always yield identical progress/verify/log
  sequences.
- **REQ-NFR-011** — A failing job never crashes the TUI; a worker-thread panic becomes a typed
  `Failed` event and the user returns to a safe state.

---

## Relevant Contracts / Interfaces

**IF-012 — `FlashJob::step`:**

```
step(clock: &dyn Clock) -> StepOutcome
StepOutcome::Progress  { pct, log }   // 0..=100 monotonic
StepOutcome::Verifying { pct, log }   // Write only; pct continues from Running
StepOutcome::Done(VerifyResult)       // Write → Pass; Read/Erase → implicit Pass
StepOutcome::Failed { error: ValidationIssue, recovery_steps: Vec<RecoveryStep> }  // exactly once, terminal

// Lifecycle constraint: a Write FlashJob MUST pass through Verifying before Done (REQ-023);
//   Done is NEVER emitted for a Write without a preceding Verifying.
// Failed carries non-empty recovery_steps; Done carries an empty one (REQ-024).
// Failed variants: VerifyMismatch (written != intended) · Cancelled (recovery may be empty for cancel).
```

**IF-014 worker events:** the worker converts a panicking job into `WorkerEvent::Failed`
(REQ-NFR-011); a dropped sender mid-job surfaces as `Disconnected` on `try_recv` (no hang).

**IF-018 `Clock`:** display/audit only (`started_at`); never in the verify/progress sequence
(ADR-006). Tests inject `FixedClock`.

---

## Relevant Design Notes

- **Step-count progress engine** (`06-technical-design`): fixed ordered phases; `pct = step_index *
  100 / step_count`; pure function of `step_index` — no sleep, no wall-clock (RULE-008).
- **Verify-after-write compare:** after the simulated Write phase the job enters `Verifying`, then
  compares the **written-image bytes** against the **intended image bytes** (length check then
  streaming equality). Equal → `VerifyResult::Pass` → `Done` (emit `FlashVerified`/`FlashCompleted`).
  Unequal or induced-fixture failure → `VerifyResult::Fail { first_diff_offset }` → `Failed` with
  the fixture-backed `RecoveryStep` list populated. Read/Erase skip `Verifying` entirely.
- **Recovery steps are ordered + fixture-backed (REQ-024):** e.g. "[1] Do NOT power-cycle…",
  "[2] Retry Write from the same source image…", "[3] If retry also fails, read back…",
  "[4] Source dump at original path is unmodified — safe to use."
- **Panic containment:** the worker wraps stepping in `catch_unwind`; a panic becomes
  `WorkerEvent::Failed`, the worker thread stays alive, the TUI thread is unaffected.

---

## Acceptance Test(s)

- `test_REQ023_flash_write_verify_passes_clean` — Write flash job through the worker; `Verifying`
  appears before `Succeeded`; `verify_result = Ok`. *(integration)*
- `test_REQ023_flash_write_must_verify_before_success` — a Write reaching `Succeeded` without passing
  `Verifying` is forbidden by the state machine. *(unit)*
- `test_REQ023_flash_verify_mismatch_populates_recovery` — induced verify mismatch →
  `VerifyMismatch` (ERR-023) → terminal `Failed` with non-empty `recovery_steps`. *(unit)*
- `test_REQ024_flash_failure_surfaces_recovery_steps` — terminal `JobCompleted` on flash failure
  carries a non-empty `recovery_steps` describing what is safe to retry. *(unit)*
- `test_REQ_NFR005_flash_determinism_with_fake_clock` — same op + `FakeClock` run twice → identical
  progress sequence and verify result (RULE-008). *(unit)*
- `test_REQ_NFR011_worker_job_panic_becomes_failed_event` — a panicking worker job is caught;
  `WorkerEvent::Failed` is delivered; the TUI thread stays live. *(integration)*
- `test_REQ_NFR011_worker_channel_disconnect_no_hang` — sender dropped mid-job → `try_recv` returns
  `Disconnected`; the loop continues without hang; the model transitions to `Failed`. *(integration)*

---

## Definition of Done

- [ ] All acceptance tests pass.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it matches IF-012 / IF-014 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-023, REQ-024, REQ-NFR-005, REQ-NFR-011 still map to
      passing tests).

---

## Out of Scope for This Task

- The trait port + prepare preconditions — SLICE-4 / TASK-015.
- Troubleshooting flows — SLICE-4 / TASK-017.
- The FlashWorkflow screen + ActionLog history rendering — SLICE-4 / TASK-018.
