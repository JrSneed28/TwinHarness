# System Architecture — TwinRunner

> **Stage 4 — System Architecture** (spec §14.4). Mostly streams; human gate on the **one or two
> genuinely irreversible style decisions** surfaced as explicit choices (§8) — everything else
> proceeds without blocking approval. Reads Summaries from `01-requirements.md`, `02-scope.md`,
> and `03-domain-model.md` by default; fetches full artifacts only when a detail cannot be
> resolved from the Summary (§9). Recommends sane defaults where the user has no preference.
> Security and Failure Modes are folded sections in Tier 1/2; **in this Tier-3 project they carry a
> short folded summary + a graduation note** pointing at the standalone stages
> `08a-security-threat-model.md` and `08b-failure-edge-cases.md` (§13, spec §15.S, §15.F).

## Summary

TwinRunner is a **layered, single-binary Rust workspace**: a pure, terminal-free **`twinrunner-core`
library crate** (parsing, validation, key library, simulated backends behind ports, troubleshooting
flows, app-state, logging, config) is consumed by a thin **`twinrunner` TUI binary crate** (ratatui +
crossterm event loop, widgets, screens, input). Long-running simulated build/flash jobs run on a
**dedicated background worker thread** and stream progress/log events back to the render loop over
channels, so the TUI stays responsive (REQ-NFR-001). All risky operations route exclusively through
the `BuildBackend` / `FlashBackend` **trait ports**; the deterministic simulator is the only acting
adapter and the real backend is a no-op stub, so no real hardware-write path exists (REQ-020,
REQ-022, REQ-NFR-004). State and rendering are deliberately split via a centralized **Model →
Message → update (reducer)** core so the engine is unit-testable without a terminal (REQ-NFR-006).

- **Architectural style:** Layered monolith — pure core library + thin TUI shell — with a centralized
  Model-Update-View core and a background job worker bridged to the UI by channels. Single cargo
  workspace producing one cross-platform terminal binary.
- **Key components:** `twinrunner-core` (the engine: NAND parse/validate/extract, key library,
  port-gated simulated backends, troubleshooting, app-state, log, config) · the **Job Worker**
  (runs build/flash jobs off the render thread, streams events back) · the `twinrunner` **TUI shell**
  (event loop, widgets, screens, input/keymap, worker↔UI bridge).
- **Irreversible decision(s) — HUMAN-ACCEPTED (§8, signed off 2026-06-10):** (1) **Concurrency backbone** — ACCEPTED:
  dedicated background worker thread(s) + `std::sync::mpsc` channels bridging the crossterm event
  loop (chosen over an async/tokio runtime). (2) **App-state pattern** — ACCEPTED: centralized
  Model + Message/`update` reducer (Elm-style) with immediate-mode rendering (chosen over scattered
  per-widget mutable state). Both were surfaced to the human via AskUserQuestion and are
  **human-signed-off (2026-06-10)** at the recommended defaults.

---

## Inputs Used

| Artifact | Version | Sections consumed |
|---|---|---|
| `01-requirements.md` | v1 | Summary, Functional Requirements (REQ-001…035), Non-Functional Requirements (REQ-NFR-001…011), Constraints, Non-Negotiables |
| `02-scope.md` | v1 | Summary, MVP Scope (44 REQ-IDs, strictly TUI-interactive), V1/Future/Out-of-Scope, User-Confirmed Decisions |
| `03-domain-model.md` | v1 | Summary, Core Entities, Relationships, State Models, Domain Rules (RULE-001…014) |

---

## Architecture Summary

TwinRunner is delivered as a **single cargo workspace with two crates**. `twinrunner-core` is a pure
Rust library with **no dependency on ratatui, crossterm, or any terminal API**; it owns all domain
logic — NAND parsing/validation/extraction, the CPU-key library, the simulated build and flash
backends (behind trait ports), the fixture-backed troubleshooting flows, the centralized app
Model/state, structured logging, configuration, and the typed error taxonomy. The `twinrunner` binary
crate is a thin shell: it owns the crossterm event loop, the ratatui widget/screen layer, input and
keymapping, and the bridge that ferries messages between the UI and the background worker. This split
is the load-bearing choice for **testability (REQ-NFR-006)**: every functional REQ is exercised
against the core library and the deterministic simulator without ever standing up a terminal, and the
TUI shell carries only rendering and input-translation logic.

Two decisions in this stage are genuinely irreversible — "wrong choice now = painful migration later"
— and are surfaced to the human gate rather than chosen silently (§8, §14.4). **First, the concurrency
backbone.** Simulated build/flash jobs are stepped, CPU/IO-bound, and must not block input handling
(REQ-NFR-001). The recommendation is a **dedicated background worker thread plus `std::sync::mpsc`
channels** bridging the synchronous crossterm event loop: no async runtime, simpler reasoning, naturally
deterministic stepping (RULE-007/008), and a clean fit for one-job-at-a-time workloads. The alternative
(a tokio async runtime) buys little here and would color every signature with `async`/`await` and pull
in a runtime — a costly thing to back out of once the codebase is built on it. **Second, the app-state
pattern.** The recommendation is a **centralized Model + Message + `update` reducer** (Elm-style) with
immediate-mode rendering, because it gives a clean state↔render seam that makes the whole engine
testable by feeding messages and asserting on the resulting Model (REQ-NFR-006, REQ-NFR-011). The
alternative — scattered per-widget mutable state — is faster to start but entangles state with
rendering and is extremely expensive to retrofit into a testable reducer later. Both recommendations
are drafted into the component design below and marked **pending the human gate**; the Orchestrator
owns the AskUserQuestion confirmation.

Everything else streams. The risky-operation isolation is not a debatable style choice — it is locked
by constraint and domain rule: every build and flash operation flows through the `BuildBackend` /
`FlashBackend` ports, the simulator is the only acting adapter, and the real backend is a no-op stub
(REQ-020, REQ-022, REQ-NFR-004, RULE-006). The system is **filesystem-only and fully offline** — no
network, no sockets, no telemetry (Out of Scope; REQ-NFR-005). External surfaces are dump files, the
key-library file, the config file, the log file, bundled timing-file/troubleshooting fixtures, and
user-chosen output images. The source-dump read-only invariant (RULE-001/REQ-035) is enforced
structurally: the only component permitted to open the source path opens it read-only, and the only
writers (build, flash-as-copy, export) write to distinct user-chosen output paths.

---

## Major Components

The system decomposes into **one core library crate** (`twinrunner-core`, broken into modules) and
**one TUI binary crate** (`twinrunner`). Components below name the load-bearing modules; the
"components-touched label" is what Stage 9 slice planning uses to detect overlap (§16). The
`twinrunner-core::*` labels live in the library; the `twinrunner::*` labels live in the binary.

### nand (core) — NAND parse / validate / extract

- **Responsibility:** Open a dump file read-only, detect its `SizeClass`, validate structure
  (FlashConfig presence, layout sanity) and ECC integrity per region, and extract `ConsoleInfo`
  (console type, serial, bootloader chain, fuse set, CPU key or explicit-absent).
- **Realizes:** REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-007, REQ-008, REQ-035
  (read-only open), REQ-NFR-003, REQ-NFR-005.
- **Components-touched label:** `twinrunner-core::nand`
- **Notes:** Owns `NandImage`, `NandLayout`, `FlashConfig`, `ConsoleInfo`, `ConsoleType`, `SizeClass`,
  `BootloaderChain`/`Bootloader`, `FuseSet`. Enforces the `NandImage` validation lifecycle
  (Unvalidated → Validating → Validated/Invalid → Extracted) and RULE-002, RULE-003, RULE-009,
  RULE-010. Parsing is deterministic and operates on a known-good bundled-fixture corpus. CPU-key
  *extraction* lives here; CPU-key *storage* belongs to `keys`.

### keys (core) — CPU-key library + validation

- **Responsibility:** Validate CPU-key format (32 hex chars), persist/load the `KeyLibrary` to/from a
  documented file, manage `KeyRecord` CRUD, search/filter, bind a record to the active dump with a
  mismatch warning, and import/export the library.
- **Realizes:** REQ-009, REQ-010, REQ-011, REQ-012, REQ-013, REQ-014, REQ-NFR-003.
- **Components-touched label:** `twinrunner-core::keys`
- **Notes:** Owns `CpuKey`, `KeyRecord`, `KeyLibrary` and the `KeyRecord` lifecycle (Unverified →
  ValidatedFormat → BoundToDump). Enforces RULE-004, RULE-005 (mismatch warning surfaced, never
  silently bound), RULE-014 (only ValidatedFormat records persisted). Library file is plaintext-local
  (JSON/TOML) under a platform config/data dir — encryption-at-rest is Future Scope. This is the
  sensitive-data owner flagged to `08a`.

### build (core) — BuildBackend port + simulator + RealStub

- **Responsibility:** Define the `BuildBackend` trait port and run simulated build/patch jobs through
  it — generate ECC / XeLL artifacts, produce deterministic stepped progress and a deterministic
  checksum, and write outputs only to user-chosen paths.
- **Realizes:** REQ-015, REQ-016, REQ-017, REQ-018, REQ-019, REQ-020, REQ-035, REQ-NFR-004,
  REQ-NFR-005.
- **Components-touched label:** `twinrunner-core::build`
- **Notes:** Owns `BuildJob`, `BuildInputs`, `TimingFile` registry, `BuildArtifact`/`EccFile`/
  `XeLLImage`, the `BuildBackend` trait, the `SimulatorBuildBackend` (only acting adapter), and the
  `RealStubBuildBackend` (no-op). Enforces RULE-006 (no bypass of the port), RULE-007 (determinism),
  RULE-012 (validated source + known timing file required), RULE-001 (output ≠ source). Job execution
  is driven by the worker, not the render thread.

### flash (core) — FlashBackend port + simulator + RealStub

- **Responsibility:** Define the `FlashBackend` trait port and run simulated read/write/erase
  operations against a simulated `Programmer`, including deterministic stepped progress, a simulated
  verify-after-write, and fixture-backed recovery steps on failure.
- **Realizes:** REQ-021, REQ-022, REQ-023, REQ-024, REQ-027 (writes to log), REQ-NFR-004, REQ-NFR-005.
- **Components-touched label:** `twinrunner-core::flash`
- **Notes:** Owns `FlashJob`, `FlashOperation`, `Programmer`, `RecoveryStep`, `OperationResult`,
  `VerifyResult`, the `FlashBackend` trait, the `SimulatorFlashBackend` (only acting adapter), and the
  `RealStubFlashBackend` (no-op). Enforces the `FlashJob` lifecycle (Pending → Running → Verifying →
  Succeeded/Failed), RULE-006, RULE-008 (determinism). The real-write path **does not exist** — the
  stub returns not-implemented.

### troubleshoot (core) — fixture-backed guided flows

- **Responsibility:** Load and drive finite, fixture-backed `TroubleshootingFlow` decision trees
  (setup checklists and repair/diagnostic wizards), advancing steps from user responses and scoping
  flows to the detected `ConsoleType`/`GlitchType` when a dump is loaded.
- **Realizes:** REQ-025, REQ-026.
- **Components-touched label:** `twinrunner-core::troubleshoot`
- **Notes:** Owns `TroubleshootingFlow`, `TroubleshootingStep`, `GlitchType`, the flow session
  lifecycle (NotStarted → AtStep → Completed/Abandoned). Enforces RULE-013 (finite, reachable, no
  dynamic expansion). Flows are bundled fixtures; pre-filtering by `applicable_console_types` is
  allowed (DQ-005 default) but all flows remain browsable.

### model / app-state (core) — centralized Model + update reducer

- **Responsibility:** Hold the single source of truth for the running application (the `Session` and
  its sub-state) and apply `Message`s through a pure `update` reducer that produces the next Model and
  a list of side-effect commands — without touching the terminal.
- **Realizes:** REQ-NFR-006, REQ-NFR-011, and the orchestration of all functional REQs (it sequences
  validation → extraction → operations and enforces precondition rules).
- **Components-touched label:** `twinrunner-core::model`
- **Notes:** Owns `Session`, the navigation/screen state enum, and the `Message`/`Command` types. This
  is the **app-state-pattern decision** (human-accepted 2026-06-10). Enforces cross-cutting preconditions
  (RULE-002, RULE-012) at the orchestration seam so no screen can launch an operation against an
  unvalidated image. The reducer is pure and synchronous; long-running work is dispatched as a
  `Command` to the worker, never executed inline.

### log (core) — structured ActionLog

- **Responsibility:** Produce immutable, timestamped, structured `LogEntry` records, append them to
  the session `ActionLog`, and optionally mirror them to a log file.
- **Realizes:** REQ-027, REQ-031, REQ-NFR-007.
- **Components-touched label:** `twinrunner-core::log`
- **Notes:** Owns `LogEntry`, `ActionLog`, `LogLevel`. Enforces RULE-011 (append-only, immutable). The
  log view in the TUI reads from this; the worker emits log events through it. **Redaction note:** log
  payloads must never carry raw CPU-key material (flagged to `08a`).

### config (core) — AppConfig

- **Responsibility:** Resolve `AppConfig` from defaults, config file, and environment/flags at session
  start; locate the platform config/data/log directories and create them on first run.
- **Realizes:** REQ-033, REQ-NFR-002 (cross-platform path handling).
- **Components-touched label:** `twinrunner-core::config`
- **Notes:** Owns `AppConfig` (library path, output dir, backend selections, log verbosity, log file
  path). Uses a platform-dirs convention; serde + toml/json for the file. Backend selection defaults
  to Simulator.

### error (core) — typed error taxonomy

- **Responsibility:** Define the project-wide typed error and `ValidationIssue` taxonomy so every
  failure is a named, user-facing, recoverable value rather than a panic.
- **Realizes:** REQ-NFR-011, REQ-NFR-003 (validation issues).
- **Components-touched label:** `twinrunner-core::error`
- **Notes:** Owns `ValidationIssue`, `ValidationCode`, `IssueSeverity`, and the crate `Error` enum
  (thiserror-style). Error-severity `ValidationIssue`s block dependent operations (RULE-002/003).
  Cross-cutting; nearly every other module returns these.

### worker — Job Worker (background thread + channel bridge)

- **Responsibility:** Run `BuildJob`/`FlashJob` execution **off the render thread** on a dedicated
  background thread, stepping the simulator and streaming progress/log/result events back to the UI
  over channels so the TUI stays responsive.
- **Realizes:** REQ-019, REQ-023 (live streaming progress), REQ-NFR-001 (responsiveness), REQ-NFR-005
  (deterministic stepping), REQ-NFR-011 (a failing job never crashes the UI).
- **Components-touched label:** `twinrunner::worker` *(bridge half)* / `twinrunner-core::worker_api`
  *(message types)*
- **Notes:** This is the **concurrency-backbone decision** (human-accepted 2026-06-10). Chosen shape:
  one worker thread, `std::sync::mpsc` for UI→worker commands and worker→UI events; the event loop
  polls the worker channel each tick (non-blocking). The job-execution *logic* (the simulators) lives
  in core and is pure/testable; only the threading and channel plumbing live in the binary. One job
  at a time in MVP.

### tui — shell, screens, widgets, input (binary)

- **Responsibility:** Run the crossterm raw-mode event loop; translate key events into `Message`s via
  a documented keymap; render the current Model with ratatui widgets across screens; show the live log
  view, progress views, dialogs, forms, and key hints; handle resize gracefully.
- **Realizes:** REQ-028, REQ-029, REQ-030, REQ-031 (log view), REQ-034, REQ-NFR-008, REQ-NFR-009.
- **Components-touched label:** `twinrunner::tui`
- **Notes:** Owns the event loop, the reusable widget layer (panels, menus, modals, forms, tables,
  progress), the screen/view set (main menu, console-info, key-library, build, flash, troubleshooting,
  log, help), the focus/layout layer, and the keymap. Renders only; it sends `Message`s into the core
  reducer and reads the resulting Model. Resize and too-small-terminal handling live here (REQ-034,
  REQ-NFR-009). No color-only signaling (icons/labels accompany color).

---

## Responsibilities

| Component | Owns | Does NOT own |
|---|---|---|
| `twinrunner-core::nand` | Dump open (read-only), size detection, structure + ECC validation, ConsoleInfo extraction | Key persistence, rendering, job execution, threading |
| `twinrunner-core::keys` | CPU-key validation, KeyLibrary persistence/CRUD/search/bind/import-export | NAND parsing, build/flash execution, rendering |
| `twinrunner-core::build` | BuildBackend port, build simulator, RealStub, artifact + checksum | Flash ops, rendering, the worker thread itself |
| `twinrunner-core::flash` | FlashBackend port, flash simulator, RealStub, verify, recovery steps | Build ops, rendering, the worker thread itself |
| `twinrunner-core::troubleshoot` | Fixture-backed flow loading + step advancement | NAND parsing, persistence, rendering |
| `twinrunner-core::model` | The single Model, Message/Command types, the `update` reducer, precondition enforcement | Terminal I/O, threading, file formats |
| `twinrunner-core::log` | LogEntry/ActionLog, append-only logging, optional file mirror, key-redaction | Where the log is displayed (that is `tui`) |
| `twinrunner-core::config` | AppConfig resolution, directory discovery/creation | Domain logic, rendering |
| `twinrunner-core::error` | ValidationIssue + typed Error taxonomy | Anything domain-specific beyond error shapes |
| `twinrunner::worker` | Off-thread job execution + channel bridge | The simulator logic (that is in core), rendering |
| `twinrunner::tui` | Event loop, widgets, screens, keymap, resize, log view rendering | All domain logic, persistence, job execution |

---

## System Boundaries

TwinRunner is **filesystem-only and fully offline** — there is no network, socket, IPC, or remote
boundary (Out of Scope; REQ-NFR-005). All boundaries are local-file or local-terminal interactions
with a single trusted local user, but **file *content* is treated as untrusted input** because dump
and key-import files may be malformed or hostile and must be validated before use.

- **NAND dump file (input)** — interaction: read-only file open by `nand` from a user-selected path —
  trust: **content untrusted** (validated for size, structure, ECC before any extraction — REQ-001/002/
  007; opened read-only per RULE-001). Parsing untrusted binary is a `08a` threat anchor.
- **Key-library file (input/output)** — interaction: `keys` reads/writes the persistent `KeyLibrary`
  (JSON/TOML) under the config/data dir — trust: **sensitive at rest** (contains the user's own CPU
  keys, plaintext-local; `08a` asset anchor).
- **Key import/export file (input/output)** — interaction: `keys` imports/exports records to a
  user-chosen path — trust: **content untrusted on import** (format + key-format validated — REQ-011/
  014).
- **Config file + environment/flags (input)** — interaction: `config` reads `AppConfig` at startup —
  trust: trusted local user; missing/invalid values fall back to sane defaults (REQ-033).
- **Bundled fixtures (input, read-only)** — interaction: timing files and troubleshooting flows shipped
  with the binary, loaded by `build`/`troubleshoot` — trust: trusted (owned by the example).
- **Output images (output)** — interaction: `build`/`flash` write ECC/XeLL/flash-copy artifacts to
  user-chosen paths — trust: trusted; constrained so output ≠ source (RULE-001).
- **Log file (output)** — interaction: `log` optionally mirrors `ActionLog` to a file — trust: trusted
  local; **must not contain raw key material** (`08a` anchor).
- **Terminal / keyboard (input + output)** — interaction: crossterm raw-mode stdin events and ratatui
  stdout rendering via the `tui` shell — trust: trusted local user.
- **Simulated hardware (NOT a boundary)** — the `Programmer` and the real backend are *simulated /
  stubbed*; there is **no real device, no driver, no physical hardware boundary** (REQ-022,
  REQ-NFR-004).

---

## Data Flow

### Flow 1 — Load dump → validate → extract console info → display

1. **User** selects a dump path in the `tui` shell; the shell emits a `LoadDump(path)` `Message`.
2. `model.update` receives the message, asks `config` for any path defaults, and dispatches the read to
   **`nand`**, which opens the file **read-only** and detects `SizeClass` (rejecting unrecognized sizes
   immediately — RULE-009/REQ-001). On reject it returns a `ValidationIssue`; the Model records a
   `DumpLoadFailed` and the shell shows the error.
3. **`nand`** validates structure (FlashConfig presence, layout) and ECC integrity per region. A
   failing region produces an Error-severity `ValidationIssue`; the `NandImage` becomes `Invalid` and
   extraction is blocked (RULE-002/003/REQ-002/007).
4. On pass, **`nand`** extracts `ConsoleInfo` (type, serial, bootloader chain, fuse set, and CPU key
   *or explicit absent* — RULE-010/REQ-006). The Model transitions the image to `Extracted`.
5. Each step emits structured `LogEntry`s through **`log`** (REQ-027/031). The Model is updated.
6. **`tui`** re-renders the console-info screen (panel/table) from the new Model; the user may export
   it to a text/JSON report (REQ-008), which `nand`/`model` write to a user-chosen path.

### Flow 2 — Start build → run on worker → stream progress → complete

1. **User** configures `BuildInputs` (source dump + selected `TimingFile` + output path + artifact
   type) and confirms in the `tui` shell, which emits a `StartBuild(inputs)` `Message`.
2. `model.update` validates the inputs against preconditions — image is `Validated`/`Extracted`, timing
   file known, output ≠ source (RULE-001/012) — and, if valid, emits a `Command::RunBuild(job)` rather
   than executing inline.
3. The **`worker`** receives the command on its channel, constructs a `BuildJob` bound to the
   `SimulatorBuildBackend` via the **`BuildBackend` port** (RULE-006), and steps it on the background
   thread. Each step sends a `BuildProgressed { pct }` and `LogEntryWritten` event back over the
   worker→UI channel (deterministic stepped sequence — RULE-007/REQ-019).
4. The event loop in `tui` polls the channel each tick (non-blocking), feeds events into `model.update`
   as `Message`s, and re-renders the progress view + live log — the UI stays responsive throughout
   (REQ-NFR-001).
5. On completion the worker emits `BuildCompleted { artifact }` (deterministic checksum) or
   `BuildFailed { error }`. The Model records the terminal `OperationResult`; the source dump is
   byte-for-byte unchanged, output sits at the chosen path (RULE-001/REQ-035).

The **flash flow** (Flow 2 variant) is identical in shape: `StartFlash(op)` →
precondition check → `Command::RunFlash` → `worker` steps the `SimulatorFlashBackend` via the
`FlashBackend` port → progress/log events → `Verifying` (for Write) → `Succeeded` (verify pass) or
`Failed` with fixture-backed `RecoveryStep`s surfaced (REQ-023/024).

---

## Runtime Flow

- **Startup:** `main` (binary) → load `AppConfig` via **`config`** (defaults → file → env/flags;
  create config/data/log dirs on first run) → construct the initial `Model`/`Session` and load the
  persistent `KeyLibrary` via **`keys`** → spawn the **worker** thread and wire the UI↔worker channels
  → enter crossterm raw mode and the ratatui alternate screen → render the first frame. Target: cold
  start to first interactive frame **< 300 ms**, no network (REQ-NFR-001).
- **Event lifecycle (per tick):** the event loop (a) polls crossterm for input with a short timeout and
  translates key events to `Message`s via the keymap; (b) drains the worker→UI channel of any
  job/progress/log events into `Message`s; (c) calls the pure `model.update` reducer once with each
  message, producing the next Model and any `Command`s; (d) dispatches `Command`s (worker commands,
  file writes via core); (e) renders the current Model with ratatui. The reducer never blocks and never
  touches the terminal.
- **Background / async work:** the **worker thread** owns all long-running job stepping. It receives
  `Command::RunBuild`/`RunFlash` over a channel, runs the simulator deterministically, and streams
  `*Progressed` / `LogEntryWritten` / `*Completed` / `*Failed` events back. One job at a time in MVP;
  the worker is the only place threading exists. This maps to the `BuildJob`/`FlashJob` domain state
  models.
- **Resize:** crossterm resize events become `Message`s; the reducer recomputes layout-affecting state
  and the shell re-renders; if the terminal is below a minimum size, a readable "terminal too small"
  message is shown instead of crashing (REQ-034/REQ-NFR-009).
- **Shutdown:** on quit, the shell signals the worker to stop, joins the worker thread, leaves the
  alternate screen and raw mode, and flushes any pending log-file writes. The `KeyLibrary` is already
  persisted on each mutating operation (not only at exit), so a crash does not lose committed records;
  the `ActionLog` is session-scoped (DQ-001 default) unless file logging is enabled.

---

## External Dependencies

All dependencies are **Rust crates** (no services, no network). Names are recommended sane defaults,
not hard constraints — later stages may substitute equivalents.

| Dependency | Purpose | Critical path? | Constraints |
|---|---|---|---|
| `ratatui` | Immediate-mode TUI rendering (widgets, layout) — locked by constraint | yes | Locked stack (REQ-028/029); binary crate only |
| `crossterm` | Cross-platform terminal backend: raw mode, key events, resize — locked | yes | Locked stack; cross-platform (REQ-NFR-002) |
| `serde` + `serde_json` + `toml` | Serialize/deserialize config, key library, JSON/text exports | yes | Documented file format (REQ-014/008/033) |
| `sha2` (or equivalent) | Deterministic checksums for `BuildArtifact` + verify-after-write | yes | Determinism (RULE-007/008, REQ-019/023) |
| `thiserror` | Typed library error definitions in `error` | yes | Drives REQ-NFR-011 typed errors |
| `anyhow` (binary only) | Top-level error context in `main`/shell | no | Binary-side convenience; core uses `thiserror` |
| `directories` (or `dirs`) | Platform config/data/log dir discovery | yes | Cross-platform paths (REQ-NFR-002/033) |
| `uuid` | `KeyRecord`/`BuildJob`/`FlashJob` ids | no | Stable record identity |
| `time`/`chrono` (one) | ISO-8601 timestamps for `LogEntry` | no | Deterministic where it affects checksums (use fixed/seeded time in tests) |

*No async runtime (tokio) is listed — this is deliberate and is the concurrency-backbone decision
pending the human gate. If the human chooses async, `tokio` (or equivalent) would be added here.*

---

## Deployment Shape

- **Target:** a single **cross-platform terminal binary** produced by `cargo build --release` from a
  two-crate workspace (`twinrunner-core` lib + `twinrunner` bin). Runs locally; no installer, no
  service, no container required (REQ-NFR-002).
- **Runtime:** the native Rust binary on Windows, Linux, and macOS terminals. No external runtime, VM,
  or interpreter. Fully offline (REQ-NFR-005).
- **Infrastructure:** none beyond the local filesystem. Config/data/log live under
  platform-appropriate directories (e.g. an OS config dir), discovered by `config` and created on
  first run; all paths overridable via flag/env (REQ-033). Bundled fixtures (timing files,
  troubleshooting flows, sample dumps for tests) ship with the source tree / binary.
- **Scaling model:** single local instance, single user, single session — no horizontal scaling, no
  concurrency beyond the one background worker thread. (Multi-user/hosted is explicitly Out of Scope.)

---

## Security

> **Folded summary + T3 graduation note.** This project is **Tier-3** and handles **sensitive data
> (the user's own CPU keys) and untrusted file parsing**, so the full threat model **graduates to
> its own stage `docs/08a-security-threat-model.md`** (spec §15.S). The summary below lists the
> handful of obvious concerns anchored to real components so the architecture-Critic's "Security
> section present" check is satisfied; it is **not** the complete model.

- **Sensitive data at rest — CPU keys in the `KeyLibrary` file** (`twinrunner-core::keys`). The library
  stores the user's per-console secrets, plaintext-local by example default (encryption-at-rest is
  Future Scope). Boundary: the key-library file. → `08a` asset.
- **Untrusted binary parsing — dump + key-import files** (`twinrunner-core::nand`,
  `twinrunner-core::keys`). Malformed/hostile NAND dumps or import files must be validated (size,
  structure, ECC, key format) before use and must never panic the process (REQ-002/007/011,
  REQ-NFR-003/011). Boundary: file content untrusted. → `08a` threat.
- **Log leakage of key material** (`twinrunner-core::log`). The `ActionLog` and optional log file must
  redact raw CPU-key values out of payloads/messages. → `08a` threat.
- **Source-dump integrity — read-only invariant** (`twinrunner-core::nand`, `build`, `flash`). RULE-001/
  REQ-035: the source dump is opened read-only and never written; all output goes to distinct
  user-chosen paths. This is a data-integrity blast-radius surface. → `08a` + `08b`.
- **No-real-hardware-write guarantee** (`twinrunner-core::build`/`flash` ports). RULE-006/REQ-022/
  REQ-NFR-004: the real backend is a no-op stub; the simulator is the only acting adapter; this is
  asserted by test. → `08a` (safety blast-radius).
- **Authn/authz model:** **none** — single local user, no network, no accounts, no remote boundary.
  There is no authentication surface; the "trust boundary" is local file content, handled by
  validation above. (No auth decision is required at this stage; if `08a` proposes one, it carries the
  blast-radius human gate per §8.)
- **Blast-radius flags:** auth = **no** · money = **no** · data-integrity = **yes** (source-dump
  read-only, key library) · migrations = **no** · safety (hardware-write prevention) = **yes**.

*Full threat model lives in `docs/08a-security-threat-model.md`.*

---

## Failure Modes

> **Folded summary + T3 graduation note.** This project is **Tier-3 / reliability-critical** (safety
> and data-integrity guarantees), so the full failure catalog **graduates to its own stage
> `docs/08b-failure-edge-cases.md`** (spec §15.F). The table below lists the obvious component-anchored
> concerns to satisfy the Critic's "Failure Modes section present" check; it is **not** the complete
> catalog.

| Component / dependency | Failure scenario | Expected behavior | REQ-ID |
|---|---|---|---|
| `twinrunner-core::nand` | Dump size not a recognized `SizeClass` | Reject on load with a clear error; do not proceed to validation | REQ-001 / RULE-009 |
| `twinrunner-core::nand` | Structure/ECC check fails on a region | Mark image `Invalid`, report the failing region, block extraction (fail-closed) | REQ-002/007 / RULE-002/003 |
| `twinrunner-core::nand` | Malformed/hostile binary while parsing | Return typed error, never panic; UI stays in a safe state | REQ-NFR-011 |
| `twinrunner-core::keys` | Malformed CPU key on entry/import | Reject with a clear message; record not created/persisted | REQ-011 / RULE-004/014 |
| `twinrunner-core::keys` | Key↔dump identity mismatch on bind | Surface a visible warning before binding; never silently bind | REQ-013 / RULE-005 |
| `twinrunner-core::keys` | Key-library file missing/corrupt at load | Fall back to an empty library + warning; do not crash | REQ-009 / REQ-NFR-011 |
| `twinrunner-core::build`/`flash` | Output path equals source dump path | Reject before execution (RULE-001 invariant) | REQ-035 / RULE-001 |
| `twinrunner-core::flash` | Simulated flash failure (induced fixture) | Move to `Failed`, populate + surface fixture-backed `RecoveryStep`s | REQ-024 |
| `worker` (`twinrunner::worker`) | Job panics / errors on the background thread | Job → `Failed`; error streamed to UI; UI never crashes; user returns to safe state | REQ-NFR-011 |
| `twinrunner::tui` | Terminal resized / below minimum size | Re-layout without crash; show "terminal too small" message if needed | REQ-034 / REQ-NFR-009 |
| `twinrunner-core::config` | Config file missing/invalid | Use sane defaults; create dirs on first run | REQ-033 |

*Full failure catalog lives in `docs/08b-failure-edge-cases.md`.*

---

## Architecture Risks

- **ARCH-RISK-001** — **Concurrency-backbone lock-in.** Choosing threads+channels vs. async/tokio is
  irreversible-grade: every job signature and the event-loop poll model are built around it. — affects:
  `worker`, `tui` event loop — mitigation: keep all job *logic* in pure core simulators (testable
  regardless of threading) so only the thin bridge is coupled to the choice; surface the decision to
  the human gate (§8). *(Human-accepted 2026-06-10: threads+channels over async/tokio.)*
- **ARCH-RISK-002** — **App-state-pattern lock-in.** A centralized Model/reducer vs. scattered widget
  state is extremely costly to retrofit; testability (REQ-NFR-006) depends on getting it right up
  front. — affects: `model`, `tui` — mitigation: commit to the reducer at the seam now; surface to the
  human gate (§8). *(Human-accepted 2026-06-10: centralized Model-Update-View over scattered widget state.)*
- **ARCH-RISK-003** — **NAND parser domain accuracy.** The Xbox 360 NAND format is intricate; an
  inaccurate `nand` parser could misreport console info. — affects: `twinrunner-core::nand` —
  mitigation: scope parsing to well-documented fields, drive everything off known-good bundled
  fixtures with asserted expected values, report unreliable fields as explicit-absent rather than
  guessing (RULE-010); detailed behavior deferred to Stage 6 / `08b`.
- **ARCH-RISK-004** — **Port-bypass risk.** The no-real-hardware-write guarantee depends on *every*
  build/flash op going through the ports; a stray direct file/hardware call would break the
  non-negotiable. — affects: `build`, `flash` — mitigation: structural enforcement (only the simulator
  adapter writes; the stub is no-op) plus a dedicated test asserting the real backend never acts
  (RULE-006); carried to `08a`.
- **ARCH-RISK-005** — **Determinism leakage via wall-clock/time.** `LogEntry` timestamps or any
  time-based value must not leak into `BuildArtifact` checksums or progress sequences, or RULE-007/008
  break. — affects: `build`, `flash`, `log` — mitigation: keep timestamps out of checksum inputs; use
  fixed/seeded time in determinism tests; deterministic stepped progress independent of wall clock.
- **ARCH-RISK-006** — **Determinism in headless/test exercise without the TUI.** MVP acceptance runs
  against the core engine, not a terminal (REQ-NFR-006); if state/render separation is impure, tests
  become flaky. — affects: `model`, `tui` — mitigation: pure synchronous reducer; the shell holds zero
  domain logic; any internal test-only headless entry point is marked test-only (SCOPE-RISK-003).
- **ARCH-RISK-007** — **CPU-key plaintext storage.** Plaintext-local key library is the accepted
  example default, but it is a real at-rest exposure. — affects: `keys`, `log` — mitigation: documented
  as Future Scope hardening; redact keys from logs; full treatment in `08a`.

---

## Verification Notes

Traced REQ coverage: every MVP functional REQ-ID (REQ-001…031, REQ-033…035) and every MVP non-functional
REQ-ID (REQ-NFR-001…009, REQ-NFR-011) is anchored to at least one named component above. REQ-032 and
REQ-NFR-010 (headless surface) are V1 and intentionally **not** realized by an MVP component
(SCOPE-RISK-003). Every Core Entity from `03-domain-model.md` has an owning component, and every Domain
Rule (RULE-001…014) is enforced by a named component/boundary as noted inline.

**Human-gate decisions (§8) — RESOLVED 2026-06-10 via AskUserQuestion:**
- **IRREVERSIBLE-1 — Concurrency backbone.** ACCEPTED: dedicated worker thread + `std::sync::mpsc`
  channels (chosen over async/tokio).
- **IRREVERSIBLE-2 — App-state pattern.** ACCEPTED: centralized Model + Message/`update` reducer
  (chosen over scattered per-widget state).

- [x] Every MVP REQ-ID from `01-requirements.md` is supported by at least one named component.
- [x] The component set fits within the MVP scope defined in `02-scope.md` (V1 headless surface excluded).
- [x] Every Core Entity from `03-domain-model.md` is handled by at least one named component.
- [x] Component responsibilities are non-overlapping and boundaries are clean (see Responsibilities matrix).
- [x] Domain Rules from `03-domain-model.md` (RULE-001…014) are enforced by a named component or boundary.
- [x] Architecture Risks are noted for any area flagged as thin (parser accuracy, port bypass, determinism).
- [x] Security and Failure Modes sections are present as folded summaries with T3 graduation notes to `08a`/`08b`.
- [x] Irreversible decisions' human-gate sign-off recorded in Summary — **DONE** (both ACCEPTED via AskUserQuestion 2026-06-10).
