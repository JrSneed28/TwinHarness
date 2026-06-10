# SLICE-5 / TASK-022 — Resize / too-small handling + Help screen + launch-latency budget

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-030, REQ-034, REQ-NFR-001, REQ-NFR-009
**Slice:** SLICE-5 — TUI shell & cross-cutting behavior
**Depends on:** SLICE-5 / TASK-021 complete

---

## Goal

Complete the cross-cutting robustness/discoverability surface: graceful resize relayout with a
"terminal too small" degraded screen below 80×24, the Help/keybindings screen listing all documented
bindings, the launch-latency budget (< 300 ms to first interactive frame), the one-job-at-a-time and
stale-event guards, and the no-color-only accessibility guarantee — so the shell never crashes and is
fully keyboard-discoverable.

---

## REQ-IDs

- **REQ-030** — Keyboard-driven navigation + a help/keybindings screen that lists the bindings.
- **REQ-034** — The TUI resizes gracefully (no crash on resize) and degrades readably on small
  terminals (clear message if too small).
- **REQ-NFR-001** — Fast launch: cold start to first interactive frame < 300 ms; UI responsive while
  simulated operations run.
- **REQ-NFR-009** — Terminal accessibility/robustness: resize handled; no reliance on color alone
  (icons/labels accompany color); tolerates limited terminals.

---

## Relevant Contracts / Interfaces

**IF-015 reducer arms:** `Message::Resize(w, h)` recomputes layout-affecting state and sets
`model.render_mode` (`Normal`/`Degraded`); `Message::OpenHelp` populates the help screen model.
`StartBuild`/`StartFlash` while a job is active are refused ("one job at a time" notice, no command);
a `WorkerEvent` for a no-longer-active job is folded or ignored (no invalid transition, no panic).

The reducer is pure/synchronous and runs only on the UI thread (INV-008); these guards are reducer
behavior, asserted headlessly.

---

## Relevant Design Notes — breakpoints, wireframe, accessibility (embed; do not invent)

**Responsive breakpoints** (`04b-ui-design` §Responsive Breakpoints):
- `minimum` 80×24 → 1-up tiles, split panels stack, StatusBar collapses to 1 row.
- `comfortable` 100–119 cols → 2-up tiles. `wide` 120+ → 3-up tiles, full CpuKey, side-by-side
  Phase-2 panels.
- `too-small` `< 80 cols OR < 24 rows` → a single centered message: `"Terminal too small (NNxMM).
  Minimum: 80×24. Please resize."` in warning color **with `[!]` glyph**; no other content; the app
  does not crash; the event loop keeps handling resize and recovers automatically.

**`HelpScreen`** (anchors REQ-030, REQ-NFR-008): `KeymapTable` sections — Global keys, Dashboard,
Read NAND, Key Library, Build Workflow, Flash Workflow, Logs View, Troubleshoot Stepper, Command
Palette — listing at least every documented navigation binding (`1`–`7`, `F1`/`?`, `Ctrl-P`, `Esc`,
`q`, `Tab`/arrows/`Enter`, and per-screen action keys). `[Esc]`/`[F1]` closes Help.

**Accessibility (REQ-NFR-009):** every state distinction carries a glyph/label
(`[✓]`/`[!]`/`[ERR]`/`[·]`, `►`); focus = heavy-vs-light border; success green (#107C10) is below
4.5:1 so it **must** always pair with `[✓]`/"PASS"; Unicode box-drawing falls back to ASCII
(`+===+`/`+---+`, `#`/`-` progress). No exception — color alone never conveys state.

---

## Acceptance Test(s)

- `test_REQ034_tui_too_small_terminal_degraded_screen` — terminal size (40, 10) below 80×24 →
  `model.render_mode = Degraded`; no panic. *(unit; also anchors REQ-NFR-009)*
- `test_REQ034_tui_resize_relayouts_without_crash` — `Message::Resize(w, h)` folded into the reducer;
  layout recomputed; no panic; `model.terminal_size` updated. *(unit)*
- `test_REQ_NFR001_launch_under_300ms` — wall-clock from process start to first `draw()` call < 300
  ms in a release build. *(integration)*
- `test_REQ_NFR001_reducer_rejects_concurrent_job` — a second `Start*` while a job is active → no
  `Command::StartJob`; reducer returns the one-job-at-a-time notice. *(unit)*
- `test_REQ_NFR008_help_screen_lists_keybindings` — `Message::OpenHelp` → the help screen model
  contains ≥ the navigation key bindings documented in REQ-030. *(unit)*
- `test_REQ_NFR006_reducer_rejects_start_precondition` — `StartBuild`/`StartFlash` with an
  unsatisfied precondition → no `Command`; a `ValidationIssue` lands in `Model.pending_issues`.
  *(unit)*
- `test_REQ_NFR006_reducer_only_runs_on_ui_thread` — all `model::update` calls run on the test thread
  with no shared mutable cross-thread state; data-race structural proof. *(unit)*
- `test_REQ_NFR011_reducer_tolerates_stale_worker_event` — a `WorkerEvent` for a no-longer-active job
  → folded or ignored; no invalid transition; no panic. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass; resize never crashes, too-small shows the degraded message, Help
      lists all bindings, launch is < 300 ms in release.
- [ ] No state communicated by color alone anywhere in the shell (REQ-NFR-009 enforced + asserted).
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] `th coverage check` does not regress (REQ-030, REQ-034, REQ-NFR-001, REQ-NFR-009 still map to
      passing tests).

---

## Out of Scope for This Task

- The widget layer / Dashboard / palette — SLICE-5 / TASK-019.
- LogsView + logging — SLICE-5 / TASK-020.
- ConfigSettings + path resolution — SLICE-5 / TASK-021.
- File-browser widget (ODQ-001) — typed-path entry remains sufficient for MVP.
