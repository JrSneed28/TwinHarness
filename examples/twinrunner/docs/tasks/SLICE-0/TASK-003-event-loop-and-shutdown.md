# SLICE-0 / TASK-003 — TUI event loop + reducer wiring + clean shutdown

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-028, REQ-030, REQ-NFR-006, REQ-NFR-011
**Slice:** SLICE-0 — Walking Skeleton
**Depends on:** SLICE-0 / TASK-002 complete

---

## Goal

Wire the crossterm raw-mode / ratatui alternate-screen event loop to the pure `model::update`
reducer and the worker channels, render a placeholder Dashboard first frame, and make a
`Message::Quit` flow through the reducer to produce `Command::ShutdownWorker` → signal the worker →
**join** the thread → leave raw mode → exit cleanly. This closes the walking-skeleton round-trip:
launch → render → UI↔worker round-trip → reducer → clean shutdown.

---

## REQ-IDs

- **REQ-028** — Launches into an interactive full-screen TUI (ratatui + crossterm) with a
  persistent layout. *(This task renders the first frame and the persistent title/status strips.)*
- **REQ-030** — Navigation and primary actions are keyboard-driven via documented bindings.
  *(This task delivers the `Quit` binding path; full keymap in SLICE-5.)*
- **REQ-NFR-006** — TUI logic testable by separating state/update from rendering: the reducer is
  reachable and asserted headlessly, no live terminal required.
- **REQ-NFR-011** — A failing operation never crashes the TUI; shutdown returns to a safe state
  (raw mode is always restored, the worker thread is always joined).

---

## Relevant Contracts / Interfaces

**IF-015 — `model::update` reducer** (the seam this task drives):

```rust
fn update(model: Model, msg: Message) -> (Model, Vec<Command>)
// Pure, synchronous, total. No I/O, no terminal reads, no wall-clock. UI-thread only (INV-008).

// Messages this task needs: Message::Quit, Message::Resize(w, h)
// Command this task needs:  Command::ShutdownWorker   (tui sends WorkerCommand::Shutdown then joins)
```

**Per-tick event lifecycle** (architecture §Runtime Flow): each tick the loop (a) polls crossterm
for input with a short timeout, translating keys to `Message`s via the keymap; (b) drains the
worker→UI channel with `try_recv` into `Message`s; (c) calls `update` once per message; (d)
dispatches returned `Command`s; (e) renders the current Model with ratatui. The reducer never
blocks and never touches the terminal.

**Shutdown** (architecture §Runtime Flow): on quit, the shell signals the worker
(`WorkerCommand::Shutdown`), joins the worker thread, leaves the alternate screen and raw mode, and
flushes pending log writes.

---

## Relevant Design Notes

- **Reducer purity (INV-008):** `update` is only ever called from the UI thread; it returns a new
  `Model` plus a `Vec<Command>` — it performs no side effects. The shell executes the commands.
- **`Quit` folding:** `Message::Quit` → reducer emits `Command::ShutdownWorker`. The shell, on
  seeing that command, sends `WorkerCommand::Shutdown` and `join()`s — proving the full UI→worker
  shutdown round-trip and tying back to SLICE-0/TASK-002.
- **First frame:** render a placeholder Dashboard (title bar + empty content + status footer); no
  real tiles yet (Dashboard tiles are SLICE-5/TASK-019). The point is to prove the render path runs.
- **Terminal restoration is unconditional:** restore raw mode / leave alternate screen even on an
  error path so a failure never leaves the terminal corrupted (REQ-NFR-011).

---

## Acceptance Test(s)

- `test_slice0_event_loop_exits_on_quit_message` — send `Message::Quit` into `model::update`;
  assert the returned `Command` set includes `Command::ShutdownWorker`. *(unit)*

*(REQ-028 and REQ-NFR-006 layout/headless-reachability are anchored by
`test_REQ028_model_initial_state_has_layout_fields` and `test_slice0_model_initial_state_constructed`
delivered in SLICE-0/TASK-001; this task must not regress them.)*

---

## Definition of Done

- [ ] The acceptance test passes; the binary launches to a first frame and quits cleanly (worker
      joined, raw mode restored) when run manually.
- [ ] SLICE-0/TASK-001 and TASK-002 tests still pass (no regression).
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] `th coverage check` does not regress (REQ-028, REQ-030 still map to passing tests).

---

## Out of Scope for This Task

- The full keymap and all key bindings — SLICE-5 / TASK-019, TASK-022.
- Dashboard tiles, command palette, help, logs, config screens — SLICE-5.
- Resize relayout / too-small degradation assertions — SLICE-5 / TASK-022.
- Launch-latency (< 300 ms) measurement — SLICE-5 / TASK-022.
- Any domain operation dispatch (`LoadDump`, `StartBuild`, …) — owned by SLICE-1/C/D.
