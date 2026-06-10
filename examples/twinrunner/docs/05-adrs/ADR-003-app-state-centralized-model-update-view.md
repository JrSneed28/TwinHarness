# ADR-003 — App-State Pattern: Centralized Model-Update-View Reducer

> **Stage 5 — Architecture Decision Record** (spec §15.5). Streams; only genuinely irreversible
> decisions reach the human (§8). One file per decision; lives in `docs/05-adrs/ADR-NNN-*.md`.
> Each ADR must link to the REQ-IDs and components it serves. Non-technical users receive the
> decision framed as a plain tradeoff.

**Decision summary:** All application state lives in a single `Model` struct inside
`twinrunner-core::model`; state transitions happen exclusively through a pure synchronous `update`
reducer that takes a `Message` and the current `Model` and produces the next `Model` plus a list
of `Command`s — chosen over scattered per-widget mutable state because it creates a clean, testable
seam between state and rendering that REQ-NFR-006 depends on, and because retrofitting a centralized
reducer onto scattered widget state later is one of the costliest architectural refactors in a TUI
codebase.

---

## Title / ID

**ADR-003** — App-State Pattern: centralized Model + Message/`update` reducer (Elm-style,
immediate-mode) with no per-widget mutable state

---

## Status

Accepted

*Date accepted:* 2026-06-10
*Supersedes:* —
*Superseded by:* —

---

## Context

TwinRunner has significant application state: the loaded `NandImage` and its lifecycle, the active
`Session`, the `KeyLibrary`, running `BuildJob`/`FlashJob` progress, the `ActionLog`, navigation
state (which screen is active, which widget has focus), and the results of validation and extraction
operations. This state must flow from domain operations into the TUI render layer without coupling
domain logic to rendering (REQ-NFR-006).

Two broad architectural options exist for TUI state management:

1. **Centralized reducer:** one `Model` struct holds all state; a single `update(model, message)
   -> (Model, Vec<Command>)` function transitions it. The TUI renders only what it reads from the
   Model; it never writes to domain state.

2. **Scattered per-widget mutable state:** each screen or widget owns the slice of state it
   displays and mutates it directly in response to events. State is distributed across the widget
   tree via `RefCell`, `Arc<Mutex<...>>`, or callback closures.

This choice is irreversible at architecture scale because it determines the shape of every state
access in the codebase. In a scattered-state design, extracting a centralized reducer later requires
identifying every state mutation site across every widget (often dozens of locations), lifting
state into a shared struct, and replacing mutations with message dispatches — an invasive
multi-week refactor on a non-trivial TUI. In a centralized-reducer design, adding new state is
additive (extend the `Model`, add `Message` variants, update `update`) and does not require
touching unrelated screens.

The testability requirement (REQ-NFR-006) is the forcing function: "the TUI logic is testable by
separating state/update from rendering." This is a statement of the centralized reducer pattern.
Proving that "simulated flash shows deterministic 0→100% progress" (the top success measure in
`01-requirements.md`) requires feeding `Message`s into `update` and asserting on the resulting
`Model` — without a terminal.

**Relevant REQ-IDs:** REQ-NFR-006, REQ-NFR-011, REQ-019, REQ-023, REQ-NFR-001
**Components affected:** `twinrunner-core::model`, `twinrunner::tui`, `twinrunner::worker`

---

## Decision

All application state resides in a single `Model` struct owned by `twinrunner-core::model`. State
transitions occur exclusively through:

```
fn update(model: Model, msg: Message) -> (Model, Vec<Command>)
```

The reducer is **pure** (no I/O, no terminal access, no threading) and **synchronous** (no
`async fn`). Long-running work is dispatched as a `Command` (e.g., `Command::RunBuild(job)`) that
the binary shell sends to the worker thread; it is never executed inline inside `update`. The
`twinrunner::tui` shell reads the `Model` each frame and renders it via ratatui; it never holds
authoritative state about domain objects.

> **Chosen:** centralized Model + Message/`update` reducer (Elm-style) with immediate-mode
> rendering and zero per-widget mutable domain state

The decision optimizes for testability (every behavior is provable by feeding messages and checking
the output Model), for auditability (every state transition has a single point of truth), and for
correct cross-cutting precondition enforcement (the reducer can check RULE-002, RULE-012 in one
place rather than in every widget that might trigger a dependent action).

The cost consciously accepted: the central `Model` struct and the `Message` enum grow as features
are added; adding a new operation requires defining new `Message` variants, new `Command` variants,
and new `Model` fields, rather than just wiring a callback in a local widget.

*Human gate triggered:* yes — surfaced to user via AskUserQuestion; approved 2026-06-10 (recommended
default: centralized Model-Update-View over scattered widget state)

---

## Consequences

### Positive

- `twinrunner-core::model`'s `update` function is fully unit-testable: a test harness feeds
  `Message`s and asserts on the resulting `Model` without importing ratatui or spawning a terminal
  (REQ-NFR-006). This is the mechanism that makes every functional REQ automatable.
- Cross-cutting preconditions (RULE-002: extracted image required before build; RULE-012: timing
  file required before build) are enforced in a single location — the reducer checks them before
  emitting a `Command::RunBuild`, so no screen can accidentally bypass them.
- Adding a new screen or widget is additive: define new `Message` variants, handle them in
  `update`, render the new `Model` field in the new screen. No existing state machinery changes.
- The reducer never crashes silently: all error paths return a new `Model` with an error state
  rather than panicking, satisfying REQ-NFR-011 at the state-management level.
- The `ActionLog` (REQ-027, REQ-031) is a natural `Model` field: every operation that emits log
  entries does so by producing `LogEntry` values via `update`, which are then reflected in the
  live log view on the next render.

### Negative

- **Boilerplate scales with feature count.** Every new user action requires a new `Message`
  variant (and often a new `Command` variant and new `Model` field). For a project with 44 MVP
  REQ-IDs covering four major workflow areas, this is a non-trivial ongoing cost. Developers
  adding features must touch `model.rs` for every change, creating a high-churn central file.
- **Central `Model` struct grows without bound.** The `Model` is the single source of truth for
  all state — NAND image lifecycle, key library, build/flash job progress, navigation state,
  log entries, config. As features are added, the struct becomes larger and understanding which
  fields are relevant in a given screen requires more context. Without discipline (sub-structs,
  nested state), the `Model` becomes unwieldy.
- **No incremental Model sharing.** Because the reducer produces a new `Model` each update (or
  mutates it in-place — either way, it is monolithic), there is no automatic dirty-region
  tracking. The TUI re-renders all state each frame, even fields that have not changed. For a
  local TUI this is acceptable, but it is a structural limitation.
- **Deep nesting of message handling.** A complex wizard flow (e.g., the multi-step
  troubleshooting flow in REQ-025/026) requires threading `Message::TroubleshootStep(step_id,
  response)` variants through `update`, which can make the reducer long if not organized into
  sub-handlers. Discipline is required to prevent `update` from becoming a sprawling match
  statement.

### Future obligations

- `docs/06-technical-design.md` must enumerate the core `Message` variants and `Command` variants
  for each workflow area (NAND, keys, build, flash, troubleshoot, navigation) and document the
  update function's precondition-check structure.
- `docs/07-contracts.md` must treat the `Message`/`Command` type set as a typed internal API
  contract between `twinrunner::tui` (producer of Messages, consumer of Model) and
  `twinrunner-core::model` (owner of update).
- The `Model` struct definition and its invariants must be captured in `06-technical-design.md`'s
  State Machines and Invariants sections.

---

## Alternatives Considered

### Option A — Centralized Model-Update-View reducer *(chosen)*

Single-source-of-truth `Model`, pure `update` reducer, zero per-widget domain state. Chosen —
see Decision above.

### Option B — Scattered per-widget mutable state

- **What it is:** each screen or widget struct owns the domain state it displays. For example,
  a `BuildScreen` widget holds the current `BuildJob` as a `RefCell<Option<BuildJob>>`; a
  `KeyLibraryScreen` owns a `Vec<KeyRecord>` in its own fields; callbacks or event closures
  mutate state in place. State is shared between screens via `Arc<Mutex<...>>` or passed by
  reference.
- **Why rejected:** this design entangles state with rendering at every screen boundary. Testing
  that "a simulated flash shows deterministic progress" would require constructing a full
  `FlashScreen` widget, injecting an event, and inspecting internal `RefCell` values — not
  feeding a `Message` to a pure function. Cross-cutting precondition enforcement (e.g., RULE-002)
  would have to be duplicated at every widget that launches a build, since there is no single
  dispatch point. Most critically, the NAND image lifecycle state (Unvalidated → Validating →
  Validated/Invalid → Extracted) must be consistent across screens; sharing it via `Arc<Mutex>`
  introduces lock contention risk and forces every screen to take a lock to read display-only
  state. Retrofitting a centralized reducer onto this design once the codebase is built is one
  of the most expensive structural refactors in a TUI: every mutation site must be found and
  replaced.
- **Would be right if:** the application had very few screens with genuinely isolated state (each
  screen's state is used only within that screen and never needs to be reflected elsewhere), and
  testability were not a first-class requirement. TwinRunner's state is heavily cross-cutting:
  the loaded NandImage is used by key binding, build inputs, flash targeting, and log rendering.
  Scattered state is the wrong fit.

### Option C — Reactive / signal-based state (e.g., a Leptos/signals-style model in a TUI)

- **What it is:** a reactive system where UI components subscribe to fine-grained signals
  (observables); when a signal changes, only the components subscribed to it re-render. This is
  the model used by web frameworks like SolidJS/Leptos.
- **Why rejected:** no mature, production-ready reactive TUI layer exists for ratatui in the Rust
  ecosystem. Implementing a signal/subscription system from scratch would add substantial
  complexity to the project beyond its scope as a TUI example. The immediate-mode ratatui model
  deliberately foregoes reactive subscriptions in favor of full-frame redraw from a Model snapshot
  — combining them would require replacing ratatui's rendering model entirely. The benefits
  (dirty-region redraws, fine-grained reactivity) are not needed for a local, offline, single-user
  TUI at this scale.
- **Would be right if:** the TUI had hundreds of independently updating widgets with fine-grained
  performance requirements, and a mature Rust reactive TUI library existed. Neither condition
  applies here.

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-NFR-006 | Drives: state/render separation for testability is the primary forcing function for this pattern |
| Requirement | REQ-NFR-011 | Constrained by: all error paths return a new Model state; no silent panics in state transitions |
| Requirement | REQ-019 | Constrained by: build progress events arrive as Messages and update the Model; the TUI reads progress from the Model |
| Requirement | REQ-023 | Constrained by: flash progress + verify-after-write events feed through the same Message/update path |
| Requirement | REQ-NFR-001 | Constrained by: reducer is pure/synchronous; long work dispatched as Commands, never blocking update |
| Requirement | REQ-027 | Constrained by: ActionLog is a Model field; all operation log entries flow through update |
| Requirement | REQ-031 | Constrained by: live log view reads ActionLog from the Model each render frame |
| Component | `twinrunner-core::model` | Owns this decision — defines Model, Message, Command, and the update function |
| Component | `twinrunner::tui` | Affected — reads Model each frame; dispatches Messages; holds no authoritative domain state |
| Component | `twinrunner::worker` | Affected — emits WorkerEvents that are converted to Messages and fed into update |
| Downstream artifact | `06-technical-design.md` | Must enumerate Message/Command variants and document update's precondition-check structure |
| Downstream artifact | `07-contracts.md` | Message/Command type set is a typed internal API contract between tui and model |
