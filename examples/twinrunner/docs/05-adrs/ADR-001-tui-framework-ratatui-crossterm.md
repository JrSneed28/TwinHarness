# ADR-001 — TUI Framework: ratatui + crossterm

> **Stage 5 — Architecture Decision Record** (spec §15.5). Streams; only genuinely irreversible
> decisions reach the human (§8). One file per decision; lives in `docs/05-adrs/ADR-NNN-*.md`.
> Each ADR must link to the REQ-IDs and components it serves. Non-technical users receive the
> decision framed as a plain tradeoff.

**Decision summary:** ratatui (immediate-mode rendering) + crossterm (cross-platform terminal
backend) was selected as the TUI stack because it is the most actively maintained Rust TUI crate
family, its immediate-mode model directly enables the centralized Model-Update-View architecture,
and it is the only Rust TUI stack with first-class Windows/Linux/macOS crossterm support — locking
in this combination at project start is irreversible because every screen, widget, and the
event-loop structure are built directly on top of it.

---

## Title / ID

**ADR-001** — TUI Framework: ratatui + crossterm (immediate-mode, cross-platform)

---

## Status

Accepted

*Date accepted:* 2026-06-10
*Supersedes:* —
*Superseded by:* —

---

## Context

TwinRunner is a full-screen, keyboard-driven terminal application (REQ-028, REQ-029, REQ-030) that
must run on Windows, Linux, and macOS from a single Rust binary (REQ-NFR-002). The TUI stack is
not a library that can be swapped late; every widget, screen layout, event-loop structure, and
resize handler (REQ-034, REQ-NFR-009) is written directly against the chosen framework's APIs. A
switch after significant implementation would require rewriting every screen and widget.

Two real architectural forces pushed toward the immediate-mode ratatui model:

1. **State/render separation (REQ-NFR-006).** The requirement to test the TUI logic by separating
   state update from rendering maps perfectly onto immediate-mode: the framework renders from a
   Model snapshot on each frame rather than maintaining its own widget state. A retained-mode
   framework, where the library owns widget state, would undercut this seam.

2. **Cross-platform terminal support.** The tool must handle Windows cmd/PowerShell/Windows
   Terminal as well as POSIX terminals. crossterm is the only widely adopted Rust terminal
   abstraction that covers raw-mode input, resize events, and alternate-screen on all three
   platforms. ratatui's primary backend is crossterm, making the pairing a single coherent choice.

The project brief also states the TUI stack as a hard constraint locked by the user at project
start: "ratatui + crossterm (immediate-mode)". This ADR records that constraint with its full
context and the alternatives that were genuinely available.

**Relevant REQ-IDs:** REQ-028, REQ-029, REQ-030, REQ-034, REQ-NFR-002, REQ-NFR-006, REQ-NFR-008,
REQ-NFR-009
**Components affected:** `twinrunner::tui`, `twinrunner-core::model`

---

## Decision

Use **ratatui** as the TUI rendering library and **crossterm** as the terminal backend, constituting
the complete `twinrunner::tui` event-loop, widget, and screen layer. The binary crate owns this
dependency entirely; `twinrunner-core` has no ratatui or crossterm import.

> **Chosen:** ratatui + crossterm (immediate-mode, cross-platform)

The pairing resolves every force above: ratatui's draw-from-Model loop directly enables
state/render separation (the reducer in `twinrunner-core::model` never touches the terminal; the
shell calls `terminal.draw(|f| render(f, &model))` each frame), crossterm provides the raw-mode
input + resize event source the event loop needs on all three platforms, and the stack is actively
maintained and widely used in the Rust TUI ecosystem.

The cost consciously accepted: every ratatui release that changes widget or layout APIs requires
updating the binary shell. Retained-mode frameworks can sometimes shield against layout API churn
because the library owns more of the tree, but that benefit is outweighed by the testability
advantage of the immediate-mode model for this project's goals.

*Human gate triggered:* yes — locked by user at project start (constraint); confirmed accepted
2026-06-10

---

## Consequences

### Positive

- `twinrunner-core::model`'s `update` reducer is terminal-free and fully unit-testable by feeding
  `Message`s and asserting on the resulting `Model` — this is the primary mechanism for REQ-NFR-006.
- `twinrunner::tui` can render any `Model` snapshot without carrying its own mutable widget state,
  making the UI deterministic and free of hidden render-side state bugs.
- crossterm covers Windows (cmd, PowerShell, Windows Terminal), Linux (VTE-family), and macOS
  terminals natively, satisfying REQ-NFR-002 and REQ-NFR-009 without per-platform shims.
- The ratatui + crossterm ecosystem has extensive examples and active maintenance, reducing the risk
  of encountering a dead-end API (ARCH-RISK-003 analog for the TUI layer).
- Resize events from crossterm translate directly into ratatui layout recomputation — REQ-034 and
  REQ-NFR-009 are straightforward to implement.

### Negative

- ratatui widget/layout APIs have historically had breaking changes across major releases; the
  `twinrunner::tui` shell will need to track ratatui's API evolution. There is no stable versioned
  contract guaranteed across years the way a mature GUI toolkit might offer.
- The immediate-mode model requires re-rendering the entire frame on every tick, including when
  nothing changed. For a TUI with live progress streaming (REQ-019, REQ-023) this is acceptable,
  but it adds a per-frame render cost that a retained-mode framework with dirty-region tracking
  would avoid.
- There is no built-in accessibility tree (screen readers, ARIA equivalent). This is inherent to
  terminal UIs and not specific to ratatui, but it is a real limitation for users relying on
  assistive technology.
- crossterm's raw-mode handling on some exotic terminal emulators (e.g., older Windows cmd without
  Virtual Terminal Processing) may require workarounds; the team accepts this as a narrow edge case
  given the primary user base.

### Future obligations

- `docs/06-technical-design.md` must reflect ratatui's `Frame`/`Widget` API patterns in the `tui`
  component design section.
- `docs/07-contracts.md` must reflect that the binary-side TUI surface produces no network or
  inter-process interface — all boundaries are terminal I/O and in-process channels.
- Any future headless/CLI surface (REQ-032, REQ-NFR-010 — V1) must be implemented by bypassing
  the ratatui render path entirely, exercising `twinrunner-core` directly without the shell.

---

## Alternatives Considered

### Option A — ratatui + crossterm *(chosen)*

The ecosystem leader for Rust immediate-mode TUIs. Chosen — see Decision above.

### Option B — cursive (retained-mode TUI)

- **What it is:** cursive is an older Rust TUI library that uses a retained-mode model (the
  library owns a view tree, event callbacks mutate view state, and the framework decides when to
  redraw). It supports multiple backends including crossterm.
- **Why rejected:** cursive's retained-mode model scatters state across a tree of view objects
  owned by the framework. This is directly at odds with the centralized Model-Update-View
  requirement (ADR-003): a pure reducer that produces a new Model requires immediate-mode rendering
  where the draw function reads the Model each frame. Retrofitting a centralized reducer onto
  cursive's callback + mutable-view-tree design would require either fighting the framework's
  architecture or abandoning the testability guarantee in REQ-NFR-006. Additionally, cursive's
  development pace is slower than ratatui's, and its Windows support is less mature.
- **Would be right if:** the project prioritized a richer built-in widget set (cursive ships
  dialog boxes, menus, and form widgets) over testability and state/render purity, and if
  Windows support were not a hard constraint.

### Option C — tui-rs (predecessor to ratatui)

- **What it is:** tui-rs was the original Rust immediate-mode TUI library that ratatui forked and
  continued after tui-rs was archived. Same basic API shape as ratatui.
- **Why rejected:** tui-rs is **archived / unmaintained** as of 2023. Using it would mean no
  security patches, no crossterm compatibility updates, and no bug fixes. ratatui is the community-
  designated successor with the same API lineage, actively maintained, and the correct choice.
- **Would be right if:** this decision were made in 2021 before ratatui existed — it would not be
  right today under any realistic set of constraints.

### Option D — A Terminal.Gui Rust port / ported framework

- **What it is:** Terminal.Gui is a mature retained-mode TUI framework for .NET/C#. There is no
  production-ready Rust port; this option represents the class of attempts to bring richer GUI
  toolkit semantics (ownership of layout and state) to a Rust terminal application.
- **Why rejected:** no production-ready Rust port exists with Windows/Linux/macOS coverage. Using
  a foreign-language binding or an immature Rust port would introduce significant FFI complexity
  and undermine the "single Rust binary, no runtime" constraint (REQ-NFR-002). The retained-mode
  model would also conflict with ADR-003 for the same reasons as cursive.
- **Would be right if:** a mature, maintained Rust Terminal.Gui port existed and the project
  prioritized widget richness over state/render separation and build simplicity.

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-028 | Drives: full-screen TUI with persistent layout requires a capable TUI framework |
| Requirement | REQ-029 | Drives: reusable widgets (panels, menus, dialogs, forms, tables, progress) are built on ratatui primitives |
| Requirement | REQ-030 | Drives: keyboard-driven navigation requires crossterm raw-mode input events |
| Requirement | REQ-034 | Drives: graceful resize requires crossterm resize events + ratatui layout recomputation |
| Requirement | REQ-NFR-002 | Drives: cross-platform terminal support — crossterm covers Windows/Linux/macOS |
| Requirement | REQ-NFR-006 | Constrained by: immediate-mode model enables state/render separation for testability |
| Requirement | REQ-NFR-008 | Drives: discoverable keyboard UX requires crossterm key event handling |
| Requirement | REQ-NFR-009 | Drives: terminal robustness + resize without crash requires crossterm resize events |
| Component | `twinrunner::tui` | Owns this decision — entire event loop, widget, and screen layer is built on ratatui + crossterm |
| Component | `twinrunner-core::model` | Affected: the immediate-mode draw-from-Model contract is the interface between core and tui |
| Downstream artifact | `06-technical-design.md` | Must reflect ratatui Widget/Frame API patterns in tui component design |
| Downstream artifact | `07-contracts.md` | TUI shell produces no network interface; all I/O is terminal + in-process channels |
