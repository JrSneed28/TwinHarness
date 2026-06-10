# SLICE-4 / TASK-017 — Troubleshoot fixture-backed flow stepper (setup + repair)

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-025, REQ-026
**Slice:** SLICE-4 — Flash workflow + guided RGH/JTAG troubleshooting (simulated)
**Depends on:** SLICE-0 complete · SLICE-1 complete (detected ConsoleType for flow filtering)

---

## Goal

Implement the `troubleshoot` flow stepper over finite, fixture-backed `TroubleshootingFlow`
decision trees: load the bundled flows, start a session, advance through ordered setup checklists and
repair decision-trees from declared responses only, and reach a terminal `Completed` node — scoping
flows to the detected console type when a dump is loaded, never expanding dynamically.

---

## REQ-IDs

- **REQ-025** — Guided, step-by-step RGH/JTAG setup workflows: ordered, checklist-style screens for
  the detected console/board type, with per-step explanations and confirmations.
- **REQ-026** — Guided RGH/JTAG repair/troubleshooting flows: a decision-tree/wizard that, given
  symptoms, proposes diagnosis and next actions, anchored to the extracted console info.

---

## Relevant Contracts / Interfaces

**IF-016 — `troubleshoot` flow stepper:**

```
load_flows() -> Vec<TroubleshootingFlow>
  // all bundled fixture flows; ≥1 entry normally; empty Vec ONLY if fixtures missing (error logged) — no crash

FlowSession::start(flow: &TroubleshootingFlow) -> FlowSession   // NotStarted → AtStep(start_step_id); emits FlowStarted
FlowSession::advance(response: String) -> StepResult            // response MUST be in the step's declared responses
  // StepResult::AtStep(TroubleshootingStep) | StepResult::Completed
FlowSession::back() -> StepResult                               // walks the visited stack; no-op at start
FlowSession::abandon() -> ()                                    // → Abandoned; emits FlowAbandoned

Errors:
  Error UndeclaredResponse  — advance(response) not in the current step's responses (ERR-024, RULE-013) → stays AtStep
  Error SessionNotStarted   — advance/back before start (ERR-025) → not advanced
```

Flows may be pre-filtered by `applicable_console_types` (DQ-005 default) but all flows remain
browsable.

---

## Relevant Design Notes

- **Finite, fixture-backed, no dynamic expansion (RULE-013 / INV-009):** `advance` follows only
  declared edges of the bundled flow; there is no runtime tree growth. This bounds SCOPE-RISK-001 (no
  open-ended repair encyclopedia).
- **Console scoping (REQ-026):** when a dump is loaded, filter the flow list by the detected
  `ConsoleType`/`GlitchType`; with no dump loaded, show all flows unfiltered with a `[!]` notice.
- **Session lifecycle:** `NotStarted → AtStep → Completed/Abandoned`; the visited stack supports
  `back()`. Each confirmed step writes an `ActionLog` entry (logging wiring is shared with TASK-018).

---

## Acceptance Test(s)

- `test_REQ025_setup_flow_steps_ordered_checklist` — start an RGH/JTAG setup flow; the first step is
  non-empty; `advance(first_response)` transitions to step 1. *(unit)*
- `test_REQ025_advance_before_start_refused` — `advance`/`back` before `start` → `SessionNotStarted`
  (ERR-025); session not advanced. *(unit)*
- `test_REQ025_load_flows_missing_fixtures_no_crash` — `load_flows()` with a missing fixture bundle →
  empty `Vec`; no crash; no panic. *(unit)*
- `test_REQ026_troubleshoot_flow_decision_tree_navigates` — step a repair flow through a known
  decision path to a terminal `Done` node; the session reaches `Completed`. *(unit)*
- `test_REQ026_advance_rejects_undeclared_response` — `advance(response)` with an undeclared response
  → `UndeclaredResponse` (ERR-024); session stays `AtStep`. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it matches IF-016 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-025, REQ-026 still map to passing tests).

---

## Out of Scope for This Task

- The `TroubleshootFlow` screen rendering (list panel + stepper panel) — SLICE-4 / TASK-018.
- Flash job stepping / verify / recovery — SLICE-4 / TASK-016.
- The guided RGH/JTAG **setup** sub-flow rendered inside FlashWorkflow — SLICE-4 / TASK-018 wires the
  screen; this task provides the stepper logic both screens call.
