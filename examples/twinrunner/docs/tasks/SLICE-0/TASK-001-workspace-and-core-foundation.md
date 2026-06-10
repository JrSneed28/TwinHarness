# SLICE-0 / TASK-001 — Cargo workspace + core foundation modules

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-028, REQ-NFR-002, REQ-NFR-006
**Slice:** SLICE-0 — Walking Skeleton
**Depends on:** none

---

## Goal

Create the two-crate cargo workspace (`twinrunner-core` library + `twinrunner` binary) and the
foundation core modules — `config`, `error`, `clock`, `log` (skeleton) and a `model` with a
constructible initial `Model`/`Session` — so that `Model::new(config)` produces an `Idle` session
with a navigation surface and a status-footer field, with zero dependency on ratatui/crossterm in
the core crate.

---

## REQ-IDs

- **REQ-028** — TwinRunner launches into an interactive full-screen TUI with a persistent layout:
  a main menu / navigation surface, content panels, and a status/footer area. *(This task delivers
  the Model-side layout fields the shell will render.)*
- **REQ-NFR-002** — Cross-platform single Rust binary crate (cargo) that builds and runs on
  Windows, Linux, macOS; path handling/file I/O account for cross-platform differences.
- **REQ-NFR-006** — Testability: every functional REQ verifiable by automated test; TUI logic is
  testable by separating state/update from rendering (the core crate is terminal-free).

---

## Relevant Contracts / Interfaces

`twinrunner-core` is a **pure library** with no dependency on ratatui/crossterm (architecture
§Architecture Summary). The `model::update` reducer (IF-015) is the central seam; this task only
needs its type surface to exist:

```rust
// twinrunner-core::model
fn update(model: Model, msg: Message) -> (Model, Vec<Command>)  // IF-015 — full body in SLICE-0/TASK-003

// Model carries (this task): a Screen navigation enum + a status-footer field + a Session in Idle.
// Screen enum (from 06-technical-design §Reducer): Dashboard | ConsoleInfo | KeyLibrary | Build
//   | Flash | Troubleshoot | Log | Help | Config
// Session: starts Idle, empty ActionLog, no active job.
```

`clock::Clock` trait (IF-018) — define the trait + two impls:

```rust
trait Clock: Send + Sync { fn now(&self) -> Timestamp; }  // Timestamp = ISO-8601 UTC String
// SystemClock — wraps std::time::SystemTime (production)
// FixedClock  — returns a pinned Timestamp (tests)
```

`error` module (architecture §error): owns `ValidationIssue`, `ValidationCode`, `IssueSeverity`
(`Info|Warning|Error`), and the crate `Error` enum (thiserror-style; e.g. `Error::Io`).

`config` (FS-004 / IF not indexed): `AppConfig { library_path, output_dir, build_backend,
flash_backend, log_verbosity, log_file_path }`; resolved from defaults → TOML file → env/flags;
TOML format; missing/invalid fields fall back to defaults (full resolution in SLICE-5/TASK-021 —
here a `AppConfig::default()` + a stub `load` is sufficient).

---

## Relevant Design Notes

- **Architectural split (load-bearing):** `twinrunner-core` owns all domain logic and is
  **terminal-free**; the `twinrunner` binary owns the crossterm event loop, ratatui, input/keymap,
  and the worker bridge. Keep ratatui/crossterm out of `twinrunner-core`'s `Cargo.toml` entirely.
- **Recommended crates (sane defaults, substitutable):** `serde`+`serde_json`+`toml`, `thiserror`
  (core), `anyhow` (binary only), `directories`/`dirs`, `uuid`, a time crate. **No async runtime.**
- **Cross-platform paths (REQ-NFR-002):** all paths via `std::path::PathBuf`; no hard-coded
  separators (the dedicated assertion lands in SLICE-5/TASK-021, but build it right here).
- **Workspace shape:** `Cargo.toml` workspace with members `twinrunner-core` and `twinrunner`;
  `twinrunner` depends on `twinrunner-core`. `cargo build --workspace` must produce one binary.

---

## Acceptance Test(s)

- `test_REQ028_model_initial_state_has_layout_fields` — `Model::new(config)` produces a `Screen`
  with a non-empty navigation surface and a status-footer field; session is `Idle`. *(unit)*
- `test_slice0_model_initial_state_constructed` — `Model::new(config)` yields a `Session` in `Idle`
  with an empty `ActionLog` and no active job. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests above pass; `cargo build --workspace` is green and emits a single binary.
- [ ] `twinrunner-core` has no ratatui/crossterm dependency (verified in its `Cargo.toml`).
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] `th coverage check` does not regress (REQ-028 still maps to a passing test).

---

## Out of Scope for This Task

- The full `model::update` match body and `Command` dispatch — SLICE-0 / TASK-003.
- The worker thread and channel protocol — SLICE-0 / TASK-002.
- Full `AppConfig` file resolution + cross-platform path assertion — SLICE-5 / TASK-021.
- Full structured logging, redaction, and log file mirror — SLICE-5 / TASK-020.
- Any rendering, widgets, or domain modules (`nand`/`keys`/`build`/`flash`/`troubleshoot`).
