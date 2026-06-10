# ADR-005 — Core/Binary Crate Split: `twinrunner-core` lib + `twinrunner` TUI binary

> **Stage 5 — Architecture Decision Record** (spec §15.5). Streams; only genuinely irreversible
> decisions reach the human (§8). One file per decision; lives in `docs/05-adrs/ADR-NNN-*.md`.
> Each ADR must link to the REQ-IDs and components it serves. Non-technical users receive the
> decision framed as a plain tradeoff.

**Decision summary:** The workspace is split into a pure `twinrunner-core` library crate (no
ratatui, no crossterm, no terminal dependency) and a thin `twinrunner` binary crate (TUI shell,
event loop, worker bridge) — chosen because this is the only structure that allows every
functional requirement to be exercised by automated tests without standing up a terminal, which
is the primary mechanism for REQ-NFR-006 and the project's acceptance criteria.

---

## Title / ID

**ADR-005** — Core/binary crate split: `twinrunner-core` pure library crate + `twinrunner` TUI
binary crate in a single cargo workspace

---

## Status

Accepted

*Date accepted:* 2026-06-10
*Supersedes:* —
*Superseded by:* —

---

## Context

TwinRunner is specified as a cross-platform terminal application (REQ-028, REQ-NFR-002) whose
functional logic — NAND parsing, key management, build/flash simulation, troubleshooting flows,
app state — must be exercised by automated tests using bundled deterministic fixtures without
relying on a live terminal (REQ-NFR-006). This is both a testability requirement and the
mechanism through which the MVP acceptance criteria are verified.

The core tension: ratatui and crossterm require a terminal to render and emit events. A codebase
that mixes domain logic with TUI rendering (importing ratatui in the same module that drives a
NAND validation pipeline) cannot be meaningfully unit-tested without a terminal harness, and
testing interactions with the terminal introduces fragility (TTY availability, raw-mode cleanup,
environment setup). The solution is structural separation.

The crate-split decision is irreversible because it determines the shape of every Rust module's
dependency graph:

- If `twinrunner-core` is a separate library crate with no ratatui import, the compiler enforces
  the separation — it is structurally impossible for core logic to call a ratatui widget. This
  cannot be accidentally violated.
- If everything is in a single binary crate, enforcing the separation requires discipline and
  code-review hygiene — a stray `use ratatui::...` in a core module compiles without error.
  Splitting a large single-crate codebase into a lib+binary structure later requires refactoring
  all module paths, resolving visibility constraints, and updating every test that imports from
  the crate — an invasive change comparable in scope to the app-state-pattern retrofit.

The architecture's claim that "every functional REQ is verifiable by an automated test using
bundled deterministic fixtures" (REQ-NFR-006) depends on this structural separation being in
place from day one.

**Relevant REQ-IDs:** REQ-NFR-006, REQ-NFR-002, REQ-NFR-011, REQ-032 (V1 headless surface)
**Components affected:** all `twinrunner-core::*` modules, `twinrunner::tui`, `twinrunner::worker`

---

## Decision

The project is structured as a **single cargo workspace** containing two crates:

1. **`twinrunner-core`** — a Rust library crate (`lib.rs`). It has **zero dependency on ratatui,
   crossterm, or any terminal API**. It owns: `nand`, `keys`, `build`, `flash`, `troubleshoot`,
   `model`, `log`, `config`, `error`, and `worker_api` (the message type definitions). All domain
   logic, all trait ports, both simulator adapters, both real stubs, the centralized Model/reducer,
   and the typed error taxonomy live here. `cargo test` in this crate exercises every functional
   REQ without a terminal.

2. **`twinrunner`** — a Rust binary crate (`main.rs`). It depends on `twinrunner-core` plus
   `ratatui` and `crossterm`. It owns: the crossterm event loop, ratatui widget/screen layer,
   input/keymap translation, the worker thread and channel plumbing (using `worker_api` types from
   core), and the `main` entry point. It contains zero domain logic — only rendering, input
   translation, and the worker bridge.

> **Chosen:** two-crate cargo workspace (`twinrunner-core` lib + `twinrunner` binary)

The workspace produces a single cross-platform terminal binary (`cargo build --release`). There
is no extra runtime, installer, or service. The library crate is not published to crates.io — it
is a workspace-private crate whose purpose is structural separation for testability.

*Human gate triggered:* no — this decision is architecture-derived and follows necessarily from
REQ-NFR-006 + the ratatui/crossterm terminal dependency structure. It is significant and costly
to reverse, but it is not a product-meaningful user choice. Recorded as Accepted per the approved
architecture.

---

## Consequences

### Positive

- `cargo test -p twinrunner-core` exercises every functional REQ (NAND parsing, key management,
  build/flash simulation, troubleshooting flows, model/reducer) without touching a terminal, a
  thread, or the ratatui render path. This is the primary automated-test surface (REQ-NFR-006).
- The compiler structurally enforces the separation: `twinrunner-core` cannot import ratatui
  (it is not in its `Cargo.toml`). No accidental entanglement is possible.
- The `twinrunner` binary shell is thin by construction: it carries only rendering and input
  translation. Logic bugs cannot hide in the TUI layer; they surface in the core tests.
- The headless/CLI surface (REQ-032, V1) can be implemented as an additional binary crate or a
  `[[bin]]` target in the workspace that depends on `twinrunner-core` directly, without modifying
  the TUI binary or the core library.
- Cross-platform path handling (REQ-NFR-002) is centralized in `twinrunner-core::config` where
  it can be tested without a terminal.

### Negative

- **Workspace overhead.** A two-crate workspace requires maintaining separate `Cargo.toml` files,
  managing shared dependency versions (either via workspace-level `[dependencies]` or manually),
  and understanding crate visibility rules (`pub(crate)` vs. `pub` must be set correctly for each
  symbol the binary needs from the library). For an example project this is a modest but real
  maintenance cost compared to a single-crate layout.
- **Cross-crate refactoring friction.** When a type or module boundary needs to change (e.g.,
  moving a type from `twinrunner-core::model` to `twinrunner-core::build`), the change may ripple
  through the binary crate's imports as well. In a single crate this is a local rename; across
  crates it may break the binary's `use` paths.
- **`pub` surface of `twinrunner-core` is larger than strictly necessary.** Because the binary
  depends on the library, every type the binary needs must be `pub` in the library. This means
  some internal-implementation types that would ideally be `pub(crate)` in a single-crate layout
  must be `pub` to be visible to the binary, potentially encouraging unwanted use of internal
  types by future consumers. Rust's workspace visibility rules do not provide a "pub within the
  workspace but not externally" modifier without additional tooling.
- **Increased cold-compile time.** Cargo compiles library crates and binary crates separately; in
  incremental mode this is a minor cost, but a full clean build compiles `twinrunner-core` first,
  then links `twinrunner`. For a project of this size (not a large monorepo), the impact is
  negligible, but it is structurally higher than a single-crate build.

### Future obligations

- Every `twinrunner-core` module must maintain its no-ratatui / no-crossterm invariant as
  dependencies are updated. A CI check (or a `deny = [...]` in `twinrunner-core/Cargo.toml`) is
  recommended to prevent accidental introduction of terminal dependencies.
- If V1 adds a headless/CLI binary (REQ-032, REQ-NFR-010), it is added as a third crate or a
  second `[[bin]]` in the workspace depending on `twinrunner-core` — not by modifying the TUI
  binary.
- `docs/06-technical-design.md` must document the module layout within `twinrunner-core` and
  the public API surface the binary consumes.

---

## Alternatives Considered

### Option A — Two-crate cargo workspace (`twinrunner-core` lib + `twinrunner` binary) *(chosen)*

Structural separation enforced by the compiler. Chosen — see Decision above.

### Option B — Single binary crate with internal module separation

- **What it is:** one `twinrunner` binary crate with a disciplined internal module structure: a
  `core/` module tree (no ratatui imports allowed by convention) and a `tui/` module tree
  (ratatui + crossterm). Convention and code review enforce the separation; the compiler does not.
- **Why rejected:** the compiler does not enforce module-level dependency constraints within a
  single crate. A `use ratatui::...` in `mod core::nand` compiles silently. Testability of the
  core modules still requires care — `cargo test` in a single binary crate runs tests in a binary
  context, which may require the terminal to be present or mock-able. Most critically, the
  headless/CLI surface (REQ-032, V1) would depend on the entire binary crate including its TUI
  dependencies (ratatui, crossterm), which adds unnecessary compile-time and link-time weight to
  a non-TUI consumer. The structural enforcement of the lib+binary split is the entire point of
  the choice; convention-based enforcement in a single crate is a weaker substitute.
- **Would be right if:** the project had no testability requirement for the core logic in isolation
  and no plans for a headless surface. REQ-NFR-006 and REQ-032 together make this the wrong
  choice.

### Option C — Three or more crates (fine-grained workspace decomposition)

- **What it is:** split the workspace further — e.g., `twinrunner-nand`, `twinrunner-keys`,
  `twinrunner-build`, `twinrunner-flash` as separate library crates, each independently
  publishable and versioned.
- **Why rejected:** fine-grained crate decomposition adds workspace management overhead (version
  alignment, inter-crate `Cargo.toml` dependencies, publish order) for no benefit in the context
  of an example project. The functional modules within `twinrunner-core` (nand, keys, build,
  flash, etc.) are not expected to be consumed independently by external users — the library crate
  is workspace-private. A two-crate split achieves the structural separation that REQ-NFR-006
  requires without the overhead of managing a multi-crate public library ecosystem.
- **Would be right if:** TwinRunner's core modules were intended to be independently published as
  reusable libraries (e.g., if `twinrunner-nand` were a standalone NAND parsing library for the
  Xbox 360 modding community). This is an explicit non-goal in the current scope.

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-NFR-006 | Drives: structural separation is the mechanism that enables terminal-free automated tests of every functional REQ |
| Requirement | REQ-NFR-002 | Constrained by: cross-platform binary is still a single cargo output; the split does not change deployment shape |
| Requirement | REQ-NFR-011 | Constrained by: a panicking worker is isolated to the binary crate; core library has no threading to manage |
| Requirement | REQ-032 | Constrained by: V1 headless surface can depend on twinrunner-core directly without the TUI binary's dependencies |
| Component | `twinrunner-core::nand` | Owned by the library crate; testable without a terminal |
| Component | `twinrunner-core::keys` | Owned by the library crate; testable without a terminal |
| Component | `twinrunner-core::build` | Owned by the library crate; simulator testable without a terminal |
| Component | `twinrunner-core::flash` | Owned by the library crate; simulator testable without a terminal |
| Component | `twinrunner-core::model` | Owned by the library crate; reducer testable without a terminal |
| Component | `twinrunner-core::troubleshoot` | Owned by the library crate; flow advancement testable without a terminal |
| Component | `twinrunner::tui` | Owned by the binary crate; holds ratatui/crossterm imports; tests in this crate may require terminal mocking |
| Component | `twinrunner::worker` | Bridge half in binary crate; worker_api message types in library crate |
| Downstream artifact | `06-technical-design.md` | Must document module layout within twinrunner-core and the public API surface the binary consumes |
| Downstream artifact | `08-test-strategy.md` | Test plan must reflect that primary automated tests run against the library crate without a terminal |
