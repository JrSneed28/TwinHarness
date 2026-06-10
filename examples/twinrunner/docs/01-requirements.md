# Requirements — TwinRunner

> **Stage 1 — Requirements Engineering** (spec §14.1). Sticky, human-gated. Assign REQ-IDs here;
> they anchor design, contracts, slices, tasks, and tests downstream (§11).

## Summary

TwinRunner is a Rust-powered, keyboard-driven terminal UI that recreates the *J-Runner with Extras*
Xbox 360 NAND-management / RGH-JTAG repair workflow as a clean, fast, interactive TUI command center.
It reads and validates Xbox 360 NAND dump files (16/64/256/512 MB) and extracts console information
(CPU key, console/motherboard type, serial, fuses, bootloader CB/CD/CE/CF/CG versions, ECC type),
manages a per-console CPU-key library, drives a build/patch image workflow (timing-file selection,
ECC/XeLL generation), and runs a flashing workflow (read/write/erase) with progress, logs, and guided
RGH/JTAG setup & repair troubleshooting. It is a legitimate homebrew / console-repair developer tool
(the original J-Runner with Extras is open source); CPU keys are the user's own per-console secrets.
**All hardware communication and image building/patching run through a Rust trait/port abstraction
backed by a built-in deterministic simulator** — the example never performs a real destructive write
to physical hardware, so it is safe to run by anyone and deterministic for tests and demos.

- **Core goal:** Recreate the J-Runner-style Xbox 360 NAND/RGH-JTAG repair workflow as a polished,
  fast, safe, keyboard-driven Rust TUI whose risky operations (flash, build/patch) are fully
  simulated behind a port abstraction.
- **Primary users:** Xbox 360 console-repair / homebrew hobbyists and technicians working on their
  own consoles' NAND dumps from a cross-platform terminal.
- **Top success measure:** Given a known-good 64 MB NAND dump fixture, TwinRunner parses it and
  extracts CPU key + console type + bootloader versions, and a simulated flash of a 64 MB image
  reports deterministic 0→100% progress with a verifiable result — with every risky operation routed
  through the backend trait whose real (hardware) backend is a no-op stub.

## Goal

A console-repair hobbyist sitting down to recover or RGH/JTAG-mod an Xbox 360 needs to read the
console's NAND, understand what board/bootloaders/fuses it has, find or store its CPU key, prepare a
patched image, and flash it back — today this means juggling the aging J-Runner Windows GUI, scattered
files, and brittle hardware steps, with little validation and easy ways to corrupt a dump. TwinRunner's
goal is to deliver that whole workflow as a **developer-grade terminal command center**: lightweight,
fast to launch, keyboard-driven, scriptable, with strong validation, safe state handling (operate on
copies, never silently corrupt a dump), clear errors, clean structured logs, and step-by-step
troubleshooting for RGH/JTAG setup and repair. Because every risky operation is simulated behind a
trait, the experience and the safety/validation discipline can be demonstrated end-to-end without any
real hardware, real xeBuild, or real bootloader binaries.

## Intended Users

- **Primary — console-repair / homebrew hobbyists.** People modding or repairing their own Xbox 360
  consoles. They are comfortable in a terminal, understand NAND/RGH/JTAG concepts (or want guided
  help), and work with dump files exported from their own hardware. They want speed, safety, clear
  validation, and a workflow that does not let them brick a console by accident. CPU keys they handle
  are their own consoles' secrets.
- **Secondary — repair technicians / shop workflows.** People who process multiple consoles and
  benefit from an organized CPU-key library, per-console records, consistent validation, and clean
  logs they can review or attach to a repair record.
- **Secondary — Rust/TUI developers and the TwinHarness audience.** This is a flagship **example**;
  developers read it to see a real simulated-backend TUI built behind a clean port abstraction. The
  scriptable/headless surface also serves automation-minded users.

This is a locally-run developer tool — a single cross-platform terminal binary, not a hosted service.

## Problem Statement

The reference workflow (read NAND → identify console → manage CPU key → build/patch image → flash →
troubleshoot RGH/JTAG) is powerful but lives in an aging Windows GUI that is heavyweight, Windows-only,
mouse-centric, hard to script, and easy to misuse — a wrong file, a bad key, or an interrupted write
can corrupt a dump or brick a console, and feedback (errors, progress, recovery steps) is often thin.
Hobbyists and technicians need the same capabilities delivered as a fast, cross-platform, keyboard-driven
workspace with first-class validation and safe state handling, where the dangerous parts can be
practiced and demonstrated safely. TwinRunner solves this by recreating the workflow as a polished
ratatui TUI whose flashing and image-building are routed through a deterministic simulator, so the
full experience is available, safe, and testable without touching real hardware.

## Functional Requirements

<Each requirement gets a stable REQ-ID. These IDs are the mechanical anchors. All items below are
must-have behaviors; the Scope stage will partition MVP vs. V1 vs. Future.>

### A. NAND dump read + console-info extraction

- **REQ-001** — TwinRunner opens an Xbox 360 NAND **dump file** from a user-selected path and detects
  its image size class (16 / 64 / 256 / 512 MB), rejecting files whose size does not match a known
  class with a clear error.
- **REQ-002** — On load, TwinRunner **validates dump structure** before extraction: size/length
  checks, recognizable header/FlashConfig presence, and overall layout sanity; structurally invalid
  dumps are reported with an actionable message and are not treated as parseable.
- **REQ-003** — TwinRunner parses the NAND and **extracts core console information**: console /
  motherboard type (e.g. Xenon, Zephyr, Falcon, Jasper, Trinity/Corona class), console serial (where
  present), and the detected ECC/NAND layout type.
- **REQ-004** — TwinRunner extracts and displays **bootloader information** — the CB/CD/CE/CF/CG
  bootloader chain present in the dump and their versions — and surfaces it in a readable view.
- **REQ-005** — TwinRunner reads the **fuse / FlashConfig and security-relevant fields** it can derive
  from the dump (e.g. fuse lines, FlashConfig value) and presents them for inspection.
- **REQ-006** — TwinRunner **extracts (or, where present in the dump, derives) the CPU key** for the
  loaded console and validates its format (length / hex); when a CPU key cannot be derived it says so
  explicitly rather than guessing.
- **REQ-007** — TwinRunner verifies **ECC integrity / NAND data sanity** for the regions it
  understands and reports pass/fail with the specific failing region, never silently passing a corrupt
  dump.
- **REQ-008** — TwinRunner presents extracted console info in a structured, scannable **console-info
  view** (panel/table/form) and can **export** the extracted info (e.g. to a text/JSON report).

### B. CPU-key library management

- **REQ-009** — TwinRunner maintains a persistent **CPU-key library** that stores per-console key
  records (CPU key, console identifier such as serial/type, optional notes/labels) across sessions.
- **REQ-010** — Users can **add, edit, view, and delete** CPU-key records through TUI forms/dialogs,
  with confirmation on destructive actions.
- **REQ-011** — TwinRunner **validates every CPU key** on entry/import (correct length and hex format)
  and rejects malformed keys with a clear message.
- **REQ-012** — Users can **look up / search** the key library by console identifier (serial, type,
  label) and filter the list.
- **REQ-013** — TwinRunner can **bind a CPU key to a loaded dump** (associate the active dump's
  console with a library record), and warns on mismatch (e.g. a key whose console identity does not
  match the loaded dump).
- **REQ-014** — TwinRunner can **import and export** the CPU-key library (and/or individual records)
  in a documented file format for backup and transfer between machines.

### C. Build / patch image workflow (simulated backend)

- **REQ-015** — TwinRunner provides a guided **build/patch image workflow** that takes a loaded dump
  (or selected inputs) plus a chosen target and produces a patched NAND/XeBuild-style output image
  **via the simulated backend** — never writing over the source dump (operates on a copy / new file).
- **REQ-016** — The build workflow lets the user **select a timing file** from a managed set (the
  example ships deterministic placeholder timing files) and records the selection in the build inputs.
- **REQ-017** — TwinRunner can **generate ECC files** (e.g. an ECC-formatted image) for the loaded
  console via the simulated backend and write them to a user-chosen output path.
- **REQ-018** — TwinRunner can **generate XeLL / recovery files** (e.g. an XeLL image) via the
  simulated backend and write them to a user-chosen output path.
- **REQ-019** — The build/patch workflow shows **deterministic progress (0→100%) and a streaming log**
  while running, and on completion reports a **verifiable result** (output path, size class, and a
  deterministic checksum/summary) that the same inputs always reproduce.
- **REQ-020** — All build/patch operations execute behind the **`BuildBackend` trait/port**; the
  built-in simulator backend is the default, and the real (xeBuild/hardware-derived) backend is a
  clearly-marked **no-op / not-implemented stub** that never produces real images.

### D. Flashing workflow + guided RGH/JTAG troubleshooting (simulated backend)

- **REQ-021** — TwinRunner provides a **flashing workflow** offering read / write / erase operations
  against a **simulated programmer** (e.g. a simulated NAND-X / J-Runner-style device), with the
  selected operation, target, and image clearly shown before execution.
- **REQ-022** — Every flashing operation runs behind the **`FlashBackend` trait/port** with the
  built-in **deterministic simulator** as default; the real hardware backend is a **no-op stub** and
  the app **never performs a real destructive write to physical hardware** in this example.
- **REQ-023** — Flashing operations display **deterministic progress (0→100%), a live log, and a clear
  success/failure result**, including a simulated **verify-after-write** step that confirms the written
  (simulated) image matches the intended image.
- **REQ-024** — On a flashing failure (simulated), TwinRunner presents **recovery steps** — what state
  the console/dump is in, what is safe to retry, and how to avoid making it worse — rather than a bare
  error.
- **REQ-025** — TwinRunner provides **guided, step-by-step RGH/JTAG setup workflows**: ordered,
  checklist-style screens that walk the user through the setup path appropriate to their detected
  console/board type, with per-step explanations and confirmations.
- **REQ-026** — TwinRunner provides **guided RGH/JTAG repair / troubleshooting flows**: a
  decision-tree / wizard that, given symptoms (e.g. no boot, glitch failing, bad image), proposes
  diagnosis and next actions, anchored to the console info already extracted.
- **REQ-027** — All flashing and guided-workflow actions write to the **structured log/history** so the
  user can review exactly what was done, in order, after the fact.

### E. TUI shell, navigation & cross-cutting app behavior

- **REQ-028** — TwinRunner launches into an **interactive full-screen TUI** (ratatui + crossterm) with
  a persistent layout: a main menu / navigation surface, content panels, and a status/footer area
  showing context and key hints.
- **REQ-029** — The TUI provides reusable interactive **widgets** — panels, menus, dialogs/modals,
  forms with editable fields, scrollable tables/lists, and progress views — over a thin focus/layout
  layer built on ratatui.
- **REQ-030** — Navigation and all primary actions are **keyboard-driven**: documented key bindings
  move focus between panels/widgets, open menus/dialogs, confirm/cancel, and trigger workflows; a
  help/keybindings screen lists them.
- **REQ-031** — TwinRunner shows a **live, scrollable log/console view** that streams progress and
  events from running operations and persists the session history for review.
- **REQ-032** — TwinRunner offers a **scriptable / headless surface** (CLI subcommands and/or a
  config/script-driven mode) covering core operations — e.g. parse a dump and emit a JSON report, run a
  simulated build or flash non-interactively — so the tool is usable in automation and CI demos.
- **REQ-033** — TwinRunner reads **configuration** (data/library locations, default paths, backend
  selection, log verbosity) from a config file and/or flags/environment, with sane defaults so it runs
  out of the box.
- **REQ-034** — The TUI **resizes gracefully** to the terminal dimensions and degrades readably on
  small/limited terminals (no crash on resize; clear message if the terminal is too small).
- **REQ-035** — TwinRunner **always operates on copies / new files for any output or mutation**:
  loading a dump is read-only with respect to the source file, and builds/flashes write to
  user-chosen output paths, so a source dump is never modified in place.

## Non-Functional Requirements

<Performance, reliability, safety, portability, usability… as REQ-IDs where checkable.>

- **REQ-NFR-001** — **Fast launch / responsiveness:** TwinRunner launches to its interactive TUI
  quickly on a developer machine (target: cold start to first interactive frame **< 300 ms**, no
  network dependency), and the UI remains responsive (input handled smoothly) while simulated
  operations run.
- **REQ-NFR-002** — **Cross-platform:** TwinRunner is a single Rust binary crate (cargo) that builds
  and runs on **Windows, Linux, and macOS** terminals; path handling, file I/O, and terminal behavior
  account for cross-platform differences.
- **REQ-NFR-003** — **Safety & validation first-class:** strong input validation is enforced
  everywhere data enters — CPU-key format (length/hex), dump size/structure, ECC integrity — and
  invalid inputs are rejected with actionable errors before any operation proceeds. No operation can
  silently corrupt a dump (REQ-035).
- **REQ-NFR-004** — **Simulated-backend safety:** all hardware communication and image building/patching
  are confined behind the `FlashBackend` / `BuildBackend` traits; the real backends are no-op stubs
  and **no code path can perform a real destructive write to physical hardware** in this example. This
  is verifiable by test (the real backend is a stub; the simulator is the only acting backend).
- **REQ-NFR-005** — **Determinism:** the simulator backends and all parsing/validation logic are
  deterministic — identical inputs always yield identical progress sequences, results, checksums, and
  logs — so behavior is reproducible for tests and demos without live hardware or network.
- **REQ-NFR-006** — **Testability / implementability:** delivered as real, runnable, tested Rust; every
  functional REQ is verifiable by an automated test (unit/integration) using bundled deterministic
  fixtures (sample dumps, timing files) and the simulator backends; the TUI logic is testable by
  separating state/update from rendering.
- **REQ-NFR-007** — **Clean structured logging & observability:** operations emit structured,
  timestamped log records (level, operation, target, outcome) viewable in the TUI and writable to a log
  file; logs are sufficient to reconstruct what was done and why.
- **REQ-NFR-008** — **Keyboard-driven, discoverable UX:** every primary action is reachable and
  operable from the keyboard with consistent, documented bindings and an in-app help screen; the UI
  surfaces context-appropriate key hints.
- **REQ-NFR-009** — **Terminal accessibility / robustness:** the TUI handles resize without crashing,
  remains usable on common terminal sizes, and avoids reliance on color alone to convey state (icons /
  labels accompany color); it tolerates limited-capability terminals readably.
- **REQ-NFR-010** — **Scriptability robustness:** headless/CLI operations produce machine-readable
  output (e.g. JSON) where appropriate and exit with a non-zero process code on failure, so they are
  usable in scripts and CI.
- **REQ-NFR-011** — **Robust error handling:** parsing/validation/operation failures are surfaced as
  typed, user-facing errors with recovery guidance; a failing operation never crashes the TUI — it
  returns the user to a safe state.

## Constraints

- **Language / form factor:** a **single Rust binary crate** (cargo); a cross-platform interactive
  terminal application — not a GUI, web service, or hosted platform. **(Hard constraint — locked.)**
- **TUI stack:** **ratatui + crossterm** (immediate-mode), with a thin widget / focus / dialog / menu /
  table / progress layer built on top. **(Hard constraint — locked by human.)**
- **Backend realism = SIMULATED:** real NAND **dump-file parsing and validation** are in scope, but
  flashing **hardware communication** and **image building/patching** sit behind Rust trait/port
  abstractions with a built-in **deterministic simulator** backend; real hardware / xeBuild backends
  are **no-op stubs**, clearly marked "not implemented in the example." The app **never** performs a
  real destructive write to physical hardware. **(Hard constraint — locked by human.)**
- **MVP breadth = MAXIMAL:** all four capability areas (A NAND read/extract, B CPU-key library, C
  build/patch, D flashing + guided RGH/JTAG) are in-scope must-haves. **(Locked by human; Scope stage
  partitions the slices.)**
- **No real artifacts required:** the example must run with **no real hardware, no real xeBuild, no
  real bootloader binaries, and no proprietary files** — only bundled deterministic fixtures and the
  simulator. **(Hard constraint.)**
- **Delivery:** this is a flagship **example** that will be built into real, runnable, tested code —
  requirements must be concretely implementable as a simulated-backend Rust TUI, ambitious but
  buildable. Lives under `/examples`. **(Locked.)**

## Non-Negotiables

- **No real destructive hardware writes, ever.** All flashing/build operations route through the
  backend traits; the real backends are no-op stubs and only the simulator acts (REQ-022, REQ-NFR-004).
- **Never silently corrupt or modify a source dump.** Loads are read-only w.r.t. the source; all
  outputs go to copies / user-chosen paths (REQ-035, REQ-NFR-003).
- **Validate before acting.** CPU-key format, dump size/structure, and ECC integrity are validated and
  must pass (or be explicitly acknowledged) before dependent operations proceed (REQ-002, REQ-007,
  REQ-011, REQ-NFR-003).
- **Deterministic and safe to run by anyone.** Simulator backends and parsing are deterministic; the
  example needs no real hardware, network, or proprietary files (REQ-NFR-005, REQ-NFR-006).
- **Legitimate framing only.** The tool is for reading/validating/organizing/repairing a user's **own**
  console NAND; nothing is framed around piracy or DRM circumvention.
- **The TUI never crashes the user into a corrupt state.** Errors and resizes return the user to a safe
  state with guidance (REQ-NFR-009, REQ-NFR-011).

## Risks

- **Domain accuracy of the NAND parser.** The Xbox 360 NAND format (sizes, FlashConfig, bootloader
  chain, fuses, ECC layout) is documented but intricate; an inaccurate parser could misreport console
  info. Mitigated by scoping parsing to well-documented fields, using known-good bundled fixtures, and
  testing extraction against expected values; fields that cannot be reliably derived are reported as
  "unknown" rather than guessed (REQ-006).
- **Scope breadth (maximal MVP).** Four full capability areas is a large surface for an example.
  Mitigated by the simulator (no hardware integration cost), shared trait abstractions, and the Scope
  stage partitioning the slices; risky-but-real concerns (hardware, xeBuild) are explicitly out.
- **Mis-perception of legitimacy.** A 360-modding tool can be misread as piracy tooling. Mitigated by
  explicit framing (own-console repair/homebrew, open-source inspiration, simulated risky ops) and by
  shipping no proprietary or DRM-circumvention content.
- **Over-trusting the simulator.** Because flashing is simulated, users could assume real-hardware
  fidelity. Mitigated by clearly labeling simulated operations and marking real backends as
  not-implemented stubs in-UI and in logs.
- **TUI testability.** Terminal UIs are notoriously hard to test. Mitigated by separating state/update
  logic from rendering (REQ-NFR-006) and testing the logic + simulator deterministically, with the
  headless surface exercising core flows without a live terminal.
- **Cross-platform terminal differences.** Key handling, resize, and rendering vary across terminals/OSes.
  Mitigated by crossterm, graceful resize handling, and avoiding color-only signaling (REQ-NFR-002,
  REQ-NFR-009).
- **CPU-key secret handling.** The library stores the user's own per-console secrets. Mitigated by
  treating them as local user data with validation; storage hardening (e.g. encryption-at-rest) is a
  candidate enhancement recorded as an assumption/future item, not an MVP guarantee.

## Success Criteria

- **NAND extraction (capability):** Given a **known-good 64 MB NAND dump fixture**, TwinRunner parses
  it and correctly extracts console/motherboard type, bootloader chain versions, ECC/layout type, and a
  format-valid CPU key — matching the fixture's expected values in an automated test. The same holds for
  a **16 MB fixture**, and a deliberately **malformed/oversized file is rejected** with a clear error.
- **Validation (safety):** ECC-integrity and structure checks **fail closed** on a corrupted-dump
  fixture (reported with the failing region) and **pass** on the good fixture — proven by automated
  tests; a source dump is byte-for-byte unchanged after being loaded.
- **CPU-key library:** A user can add a console's CPU key, the library **rejects a malformed key** and
  **accepts a valid one**, look-up/search returns the right record, and binding a key to a loaded dump
  **warns on console mismatch** — all covered by tests and demonstrable in the TUI.
- **Simulated build/patch:** A simulated build of a 64 MB image (with a selected timing file) reports
  **deterministic 0→100% progress**, writes an output to a chosen path **without modifying the source**,
  and produces a **deterministic, reproducible result/checksum** — same inputs, same output, verified by
  test. ECC and XeLL file generation likewise produce deterministic outputs.
- **Simulated flash + recovery:** A simulated flash of a 64 MB image reports **deterministic 0→100%
  progress**, runs a **simulated verify-after-write** that passes for a good image, and on an
  induced-failure fixture surfaces **recovery steps**; the **real backend is a no-op stub** (asserted by
  test — only the simulator acts, no real hardware path executes).
- **Backend isolation (non-negotiable):** An automated test proves that **all** flash/build operations
  go through the `FlashBackend` / `BuildBackend` traits and that the real backend implementations are
  no-op stubs — no code path can perform a real hardware write.
- **Guided workflows:** The RGH/JTAG setup workflow advances through ordered, confirmable steps for at
  least one console-class path, and the troubleshooting flow yields a relevant diagnosis/next-action for
  at least one symptom scenario — demonstrable in the TUI and exercised headlessly.
- **TUI & performance:** TwinRunner **launches to an interactive frame in < 300 ms** on a dev machine,
  is fully operable from the keyboard, lists its key bindings in a help screen, and **handles a terminal
  resize without crashing**.
- **Scriptable:** A **headless command parses a dump and emits a valid JSON report**, and a headless
  simulated build/flash runs to completion with a **non-zero exit on induced failure** — usable in CI.
- **Build quality:** All MVP functional REQ-IDs are covered by passing tests; the project **builds and
  runs as a real cross-platform Rust binary** with no real hardware, xeBuild, or proprietary files.

## Assumptions

<Defaults taken where the user expressed no preference (§7). AskUserQuestion is unavailable in this
subagent context; the three big decisions (simulated backend, maximal MVP, ratatui+crossterm) are
locked and treated as hard inputs. The following example-appropriate defaults were chosen so the
Orchestrator need not be blocked; flag any you want changed.>

- **Bundled deterministic fixtures.** The example ships small, synthetic-but-structurally-valid NAND
  dump fixtures (at least a 16 MB and a 64 MB good dump, a corrupted/malformed dump, and an
  induced-flash-failure fixture) plus placeholder timing files — all generated/owned by the example, no
  proprietary data. Fixtures may be reduced/compressed representations as long as parsing/validation and
  the simulator behave deterministically.
- **Simulated console/programmer model.** The simulator emulates a J-Runner-style programmer (NAND-X /
  USB-style device) abstractly; specific real device protocols are not implemented. Progress is a
  deterministic stepped sequence (e.g. fixed block counts) rather than wall-clock timing.
- **CPU-key library storage.** Stored as a local file (e.g. JSON/TOML) under a platform-appropriate
  config/data directory, plaintext by default for the example; encryption-at-rest is a candidate future
  enhancement, not an MVP guarantee. Keys are the user's own console secrets treated as local user data.
- **Console-class coverage.** Console-type detection and guided RGH/JTAG paths cover the well-known
  board classes (Xenon, Zephyr, Falcon, Jasper, Trinity/Corona-class) at the breadth the bundled
  fixtures support; exhaustive coverage of every hardware revision is future scope.
- **Timing-file set.** The example manages a small set of placeholder/deterministic timing files; it
  does not require or ship real RGH timing binaries.
- **Build/patch fidelity.** Generated images (patched NAND, ECC, XeLL) are deterministic
  simulator-produced artifacts with valid size/structure for the example's own round-trip and
  verification — they are NOT real bootable Xbox 360 images and are clearly labeled as simulated.
- **Config & data locations.** Default config/data/log locations follow platform conventions (e.g. an
  OS config dir), overridable via flag/env; the app creates them on first run.
- **Scriptable surface shape.** Headless mode is exposed as CLI subcommands (e.g. `parse`, `build`,
  `flash`, `keys`) that mirror the interactive workflows and emit JSON where a report is produced;
  exact subcommand names are an implementation detail for later stages.
- **Single-session, local, single-user.** No multi-user, networking, sync, or remote features; one
  local user operating on local files.
- **Logging.** Structured logs to both the in-TUI log view and a rotating/append log file under the data
  dir; verbosity configurable. Default level is informational.
- **No telemetry / no network.** The example makes no network calls; it runs fully offline.

## Open Questions

<None are blocking. The three foundational decisions are locked by the human; all remaining ambiguity
was resolved with the example-appropriate defaults recorded under Assumptions. The items below are
non-blocking refinements the Scope and later stages can settle; listed for visibility only.>

- **OQ-1 (non-blocking) — CPU-key storage hardening.** Whether the MVP should add encryption-at-rest /
  OS-keystore integration for the CPU-key library, or keep plaintext-local for the example. Default
  taken: plaintext-local for the example, hardening as future scope. Settle at Scope/Security stage.
- **OQ-2 (non-blocking) — Headless surface depth.** How much of the workflow the scriptable/CLI surface
  must cover for MVP (core parse/build/flash/keys vs. full parity with the TUI). Default taken: core
  operations mirror the main workflows; full parity is future scope. Settle at Scope.
- **OQ-3 (non-blocking) — Console-class & timing breadth.** Exactly which board classes and how many
  timing files the bundled fixtures cover for MVP. Default taken: the well-known classes at fixture
  breadth. Settle at Scope/Domain-Model.
- **OQ-4 (non-blocking) — Patched-image fidelity bar.** How structurally faithful simulated output
  images must be (round-trip-valid for the example vs. closer to real layouts). Default taken:
  deterministic, size/structure-valid for the example's own verification, clearly labeled simulated.
  Settle at Domain-Model/Technical-Design.
