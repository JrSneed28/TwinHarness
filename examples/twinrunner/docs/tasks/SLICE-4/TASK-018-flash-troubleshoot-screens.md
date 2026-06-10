# SLICE-4 / TASK-018 — FlashWorkflow + TroubleshootFlow screens + ActionLog history

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-021, REQ-023, REQ-024, REQ-027, REQ-031
**Slice:** SLICE-4 — Flash workflow + guided RGH/JTAG troubleshooting (simulated)
**Depends on:** SLICE-4 / TASK-017 complete (and TASK-016 for flash stepping)

---

## Goal

Wire the four-phase `FlashWorkflow` screen and the `TroubleshootFlow` screen through the reducer and
worker: select/confirm a flash operation, stream progress + verify + recovery into the Model, run the
guided RGH/JTAG setup checklist and repair stepper — and write every flash and guided action to the
structured `ActionLog` so the full history is reviewable.

---

## REQ-IDs

- **REQ-021** — Flashing workflow with read/write/erase against a simulated programmer; operation,
  target, image shown clearly before execution.
- **REQ-023** — Deterministic progress, live log, verify-after-write, clear success/failure result.
- **REQ-024** — Recovery steps shown on flash failure.
- **REQ-027** — All flashing and guided-workflow actions write to the structured log/history.
- **REQ-031** — Live, scrollable log/console view that streams progress and persists session history
  (this task feeds the ActionLog the LogsView later renders).

---

## Relevant Contracts / Interfaces

**IF-015 reducer arms:** `ConfigureFlash(op, image?)`, `StartFlash` (RULE-012 for Write image path;
pass → `Command::RunFlash`, fail → `ValidationIssue` in Model), `CancelJob`, `TroubleshootStart(id)`,
`TroubleshootAdvance(response)`, `TroubleshootBack`, `TroubleshootAbandon`; worker-event folds
`JobStarted/Progressed/Logged/Completed/Failed`.

**IF-017 — `log::ActionLog::append`:** every flash/guided action appends a `LogEntry { timestamp,
level, operation, message, payload }`; append-only, immutable, in arrival order (RULE-011).
`JobLogged` entries from the worker are appended via `log` (redaction applies — implemented in
SLICE-5/TASK-020; this task must route entries through `log::append`).

**IF-013/IF-014:** `Command::RunFlash` → `WorkerCommand::StartFlash`; ordered `Started → Progress* →
(Completed|Failed)`; drained per tick.

---

## Relevant Design Notes — wireframes (embed; do not invent layout)

**`FlashWorkflow`** (anchors REQ-021, REQ-022, REQ-023, REQ-024, REQ-025, REQ-027): four phases —
- **Phase 1 — Select Operation** (`Backend: SimulatorBackend [SIMULATED]`): `Programmer:
  SimulatedNAND-X [Ready] · Capacity 64 MB`; `FlashOperation` radio `( ) Read ( •) Write ( ) Erase`;
  `Source image (for Write)`; `[!] All operations are SIMULATED — no real hardware accessed.`;
  `[F] Flash  [Esc] Back`.
- **Phase 2 — Running:** `ProgressBar` + `StreamingLogPanel`, `[SIMULATED]` badge, `[Esc] Cancel`.
- **Phase 3 — Verifying** (Write only): verify-read progress + `[✓] Verify PASSED — Written SHA-256
  … = Intended SHA-256 … [match ✓]`.
- **Phase 4 — Done / Recovery:** success `[✓] FLASH SUCCEEDED` + checksum; failure `[ERR] Flash
  FAILED — <desc>` + ordered `Recovery Steps: [1]… [2]… [3]… [4]…` + `[R] Retry  [L] View Log
  [Esc] Dashboard`. The **guided RGH/JTAG setup stepper** (REQ-025) is a Phase variant (StepHeader,
  StepPrompt, StepExplanation, StepProgressBar, Pass/Fail/Skip response bar).

**`TroubleshootFlow`** (anchors REQ-025, REQ-026, REQ-027): a `FlowListPanel` with a
`ConsoleTypeFilter` label (`[!] no dump loaded` when none), a flow table (`Flow Name · GlitchType ·
Type`), `[Enter] start`; a `StepperPanel` (`Step N of M`, prompt, explanation, progress bar,
`[P] Pass [F] Fail [S] Skip [Esc] Abandon (confirm)`).

**No color-only state** (REQ-NFR-009): every status carries a glyph/label.

---

## Acceptance Test(s)

- `test_REQ021_flash_read_write_erase_ops_available` — the screen offers Read/Write/Erase; each
  dispatches a valid `FlashJob`. *(unit)*
- `test_REQ023_flash_write_verify_passes_clean` — a screen-driven Write runs through the worker;
  `Verifying` appears before `Succeeded` in the Model. *(integration)*
- `test_REQ024_flash_failure_surfaces_recovery_steps` — an induced failure leaves the Model in the
  Phase-4 recovery state with a non-empty ordered recovery list. *(unit)*
- `test_REQ027_actions_appear_in_action_log` — after a flash job run through `model::update`,
  `model.session.action_log` contains `FlashStarted`, `FlashProgressed`, and `FlashCompleted`
  entries. *(unit)*
- `test_REQ026_troubleshoot_flow_decision_tree_navigates` — screen-driven `TroubleshootStart` +
  `TroubleshootAdvance` steps a repair flow to `Completed`. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass; FlashWorkflow (4 phases) and TroubleshootFlow are demonstrable from
      the keyboard; every action appears in the ActionLog.
- [ ] No state communicated by color alone — REQ-NFR-009 honored (`[SIMULATED]`, `[✓]`, `[ERR]`).
- [ ] A second flash while one is active is refused (one-job-at-a-time), not crashed.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] `th coverage check` does not regress (REQ-021, REQ-023, REQ-024, REQ-027, REQ-031 still map to
      passing tests).

---

## Out of Scope for This Task

- Flash job stepping / verify / recovery internals — SLICE-4 / TASK-016.
- Troubleshoot stepper logic — SLICE-4 / TASK-017.
- LogsView rendering + CPU-key redaction + log file mirror — SLICE-5 / TASK-020 (this task routes
  entries into the ActionLog; the dedicated log view and redaction land in SLICE-5).
- Dashboard "Flash Device" / "Last Job" tiles — SLICE-5 / TASK-019.
