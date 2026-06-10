# Technical Design — TwinRunner

> **Stage 6 — Detailed Technical Design** (spec §15.6). Streams; asks the human only where a
> behavior choice is product-meaningful. Reads the Summary blocks from `04-architecture.md`,
> `03-domain-model.md`, and the `05-adrs/` list (ADR-001…006) by default; fetches full artifacts
> only when a detail cannot be resolved from the Summary (§9). Deliberately **stops where code is
> clearer than prose** — trivial components are named and skipped. Component designs are anchored
> to REQ-IDs from `01-requirements.md` (§11). The ADRs and domain RULEs are honored, not
> re-decided.

## Summary

This design specifies the internal behavior the architecture left abstract for the components a
Builder would otherwise have to guess. The deepest is **`nand`** — a fixture-backed, deterministic
parse/validate/extract pipeline whose byte-range reads, size detection, ConsoleType determination,
ECC sanity checks, and explicit-absent CPU-key handling are spelled out concretely (accuracy is
bounded to the bundled fixtures — ARCH-RISK-003). The two simulators (**`build`**, **`flash`**) are
specified as deterministic stepped state machines with an exact, wall-clock-free checksum input set
(ADR-006). The **`worker` channel protocol** and the **`model` reducer** are specified as the
concurrency/ordering and orchestration contracts the architecture deferred (ADR-002, ADR-003).
**`keys`**, **`troubleshoot`**, **`log`+redaction**, and the **determinism mechanics** (injectable
clock) round out the set. Trivial components (`error`, `config`, plus the pure data entities)
are deliberately skipped with one-line reasons. No product-meaningful behavior choice is left
unsettled by the ADRs/RULEs; all Open Design Questions carry safe defaults that do not change
user-visible behavior or preserved data.

- **Components designed:** `nand` (parse/validate/extract pipeline) · `build` (deterministic build
  simulator + checksum) · `flash` (deterministic flash simulator + verify-after-write + recovery) ·
  `worker` (UI↔worker channel protocol + event-loop drain + cancellation/shutdown) · `model`
  (Message/Command reducer + precondition enforcement + screen-nav state) · `keys` (CpuKey
  validation + library load/save + bind/mismatch + import/export) · `troubleshoot` (fixture-backed
  flow stepper) · `log` (append-only ActionLog + CPU-key redaction) · `clock`/determinism
  mechanics (injectable time, no time in checksums).
- **Key algorithms / state machines:** NAND parse pipeline + `NandImage` lifecycle ·
  deterministic step-count progress engine · build checksum input set (sha256 over a canonical,
  clock-free byte set) · `BuildJob` lifecycle · `FlashJob` lifecycle incl. `Verifying` ·
  verify-after-write compare · worker message protocol + per-tick non-blocking drain ·
  `update(model, msg) -> (model, Vec<Command>)` contract · `KeyRecord` lifecycle ·
  `TroubleshootingFlow` session stepper · CPU-key log-redaction.
- **Human-approved behavior choices:** none in this stage. The two irreversible style decisions
  (concurrency backbone, app-state pattern) were already human-accepted in Stage 4 (2026-06-10) and
  are honored here, not re-decided. No new product-meaningful choice surfaced; all ODQs below carry
  defaults that preserve user-visible behavior and data.

---

## Component Designs

### Deliberately skipped (trivial — named per §15.6)

- **`error`** — a `thiserror`-style enum plus a `ValidationIssue { severity, code, target, message }`
  struct. Pure data + variant taxonomy; no non-trivial behavior. The *rule* that an Error-severity
  issue blocks dependent operations (RULE-002/003) is enforced by the *callers* (`nand`, `model`),
  designed below — not by `error` itself.
- **`config`** — `AppConfig` resolution is a fixed precedence merge: built-in defaults → config file
  (serde) → environment/flags, then platform-dir discovery + create-on-first-run. The only thing a
  Builder must not guess is the precedence order (defaults < file < env/flags) and "missing/invalid
  field falls back to default, never aborts startup" (REQ-033). Stated; no further design.
- **Pure data entities** (`ConsoleInfo`, `BootloaderChain`/`Bootloader`, `FuseSet`, `BuildArtifact`,
  `OperationResult`, `Programmer`, `AppConfig`) — value/record types with no branching behavior of
  their own. Their constraints live in `03-domain-model.md` Attributes; no algorithmic design.

---

### `nand` — parse / validate / extract (the deepest component)

**Realizes:** REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-007, REQ-008, REQ-035,
REQ-NFR-003, REQ-NFR-005, REQ-NFR-011.
**Purpose (one sentence):** Open a dump file read-only, detect its `SizeClass` by length, validate
structure and ECC per region, and extract a `ConsoleInfo`, advancing the `NandImage` lifecycle and
reporting any failure as a region-named `ValidationIssue` — never silently advancing a bad dump.

Because real Xbox 360 NAND parsing is intricate and this is a **simulated example**, the parse model
is a **concrete, documented, fixture-backed reader**: it reads a small, fixed set of byte ranges and
marker structures that the bundled fixtures are authored to contain. Accuracy is **bounded to the
bundled fixtures** (ARCH-RISK-003); any field the model cannot reliably derive from those ranges is
reported **explicit-absent**, never guessed.

**Entry point(s):** `load(path) -> Result<NandImage /*Unvalidated*/, Error>` (read-only open + size
detect); `validate(&mut NandImage) -> Result<(), Vec<ValidationIssue>>` (structure + ECC);
`extract(&NandImage /*Validated*/) -> Result<ConsoleInfo, Vec<ValidationIssue>>`.
**Exit point(s):** a `NandImage` whose `validation_status` reflects the lifecycle; a `ConsoleInfo`
on success; a non-empty `Vec<ValidationIssue>` (Error-severity, each with a named `target` region)
on failure. Emits `DumpLoaded`/`DumpLoadFailed`/`ValidationStarted`/`ValidationPassed`/
`ValidationFailed`/`ConsoleInfoExtracted`/`CpuKeyAbsent` domain events (via the caller).
**Invariants maintained:**
- The source file is opened **read-only** and never written, truncated, or deleted (RULE-001/REQ-035).
- `validation_status` only ever advances **Unvalidated → Validating → Validated|Invalid →
  Extracted**; `extract` refuses any image not in `Validated` (RULE-002).
- An image with ≥1 Error-severity issue is `Invalid` and can **never** reach `Extracted` (RULE-003).
- `ConsoleInfo.cpu_key` is a present-or-explicit-`Absent` value; the absent case is a distinct
  variant, never an empty/zeroed key (RULE-010).

The concrete parse model (byte ranges, size detection, ConsoleType determination, ECC check) is
specified in **Key Algorithms / Workflows → "NAND parse pipeline"** below.

### `build` — BuildBackend port + deterministic simulator

**Realizes:** REQ-015, REQ-016, REQ-017, REQ-018, REQ-019, REQ-020, REQ-035, REQ-NFR-004,
REQ-NFR-005.
**Purpose (one sentence):** Validate `BuildInputs`, step a `BuildJob` through deterministic phases
emitting 0→100% progress, and produce a `BuildArtifact` at a new path with a **deterministic
checksum** computed from a clock-free canonical byte set.

The acting adapter is `SimulatorBuildBackend` (the only one that writes); `RealStubBuildBackend`
returns `Error::NotImplemented` and writes nothing (RULE-006). Job execution is **driven by the
worker thread**, one step at a time; `build` itself exposes a *steppable* job so the worker controls
pacing and the engine stays testable headless.

**Entry point(s):** `BuildBackend::prepare(inputs) -> Result<BuildJob /*Pending*/, Vec<ValidationIssue>>`
(precondition check); `BuildJob::step(&mut self, clock: &dyn Clock) -> StepOutcome` (advance one
phase, returns progress/log/terminal).
**Exit point(s):** a sequence of `StepOutcome::Progress { pct, log }` then exactly one
`StepOutcome::Done(BuildArtifact)` or `StepOutcome::Failed(error)`. On success, a file at
`inputs.output_path` plus a `BuildArtifact { output_path, artifact_type, size_class, checksum }`.
**Invariants maintained:**
- `inputs.output_path != inputs.source_image_path` is checked in `prepare` and refused before any
  byte is written (RULE-001/REQ-035).
- `prepare` refuses unless the source `NandImage` is `Validated` or `Extracted` and the
  `timing_file_id` resolves to a known shipped `TimingFile` (RULE-012).
- Identical `BuildInputs` → identical `BuildArtifact.checksum`, every run (RULE-007). The checksum
  input set **excludes** wall-clock/time/random (ADR-006).
- The artifact is written **only** through the simulator adapter; the stub never produces output
  (RULE-006/REQ-NFR-004).

### `flash` — FlashBackend port + deterministic simulator + verify-after-write

**Realizes:** REQ-021, REQ-022, REQ-023, REQ-024, REQ-027, REQ-NFR-004, REQ-NFR-005.
**Purpose (one sentence):** Step a `FlashJob` for a Read/Write/Erase `FlashOperation` against the
simulated `Programmer`, and for Write run a deterministic verify-after-write that compares the
written image bytes against the intended image, populating fixture-backed `RecoveryStep`s on failure.

`SimulatorFlashBackend` is the only acting adapter; `RealStubFlashBackend` returns
`Error::NotImplemented` (the real-write path **does not exist** — RULE-006/REQ-NFR-004).

**Entry point(s):** `FlashBackend::prepare(op, programmer, image_path?) -> Result<FlashJob /*Pending*/, Vec<ValidationIssue>>`;
`FlashJob::step(&mut self, clock: &dyn Clock) -> StepOutcome`.
**Exit point(s):** progress/log step outcomes; for Write, a `Verifying` phase then `VerifyResult`;
terminal `Succeeded` or `Failed { recovery_steps }`. Emits the `Flash*` domain events.
**Invariants maintained:**
- Write requires a non-absent `image_path` (RULE-012); Read/Erase require none.
- Lifecycle is **Pending → Running → (Verifying for Write) → Succeeded|Failed**; a Write never
  reports `Succeeded` without passing `Verifying` (REQ-023).
- Same `FlashOperation` + same input bytes → identical progress sequence, verify result, and log
  (RULE-008); no wall-clock in any of these (ADR-006).
- A `Failed` job carries a **non-empty, ordered, fixture-backed** `RecoveryStep` list; a `Succeeded`
  job carries none (REQ-024).

### `worker` — background thread + channel protocol (honors ADR-002)

**Realizes:** REQ-019, REQ-023, REQ-NFR-001, REQ-NFR-005, REQ-NFR-011.
**Purpose (one sentence):** Run `BuildJob`/`FlashJob` stepping off the render thread on one
dedicated worker thread, exchanging typed `Command`s and `Event`s with the UI over `std::sync::mpsc`
channels so the event loop never blocks and a failing job never crashes the UI.

The job *logic* (the simulators) lives in core and is pure/testable; only the threading and channel
plumbing live here. The exact message protocol, the non-blocking per-tick drain, one-job-at-a-time
enforcement, cancellation, and clean shutdown/join are specified in **Concurrency / Ordering /
Idempotency** below — that is the spec the architecture deferred.

**Entry point(s):** `spawn(rx: Receiver<WorkerCommand>, tx: Sender<WorkerEvent>) -> JoinHandle`;
UI sends `WorkerCommand`, drains `WorkerEvent`.
**Exit point(s):** `WorkerEvent`s streamed to the UI; the thread joins cleanly on `Shutdown`.
**Invariants maintained:** at most one job runs at a time (REQ scope MVP); the reducer is never
called from the worker thread; a panicking/erroring job is converted to a `Failed` event, never
propagated as a thread panic that takes down the UI (REQ-NFR-011).

### `model` — centralized Model + `update` reducer (honors ADR-003)

**Realizes:** REQ-NFR-006, REQ-NFR-011, and the orchestration of every functional REQ (it sequences
load → validate → extract → operations and enforces the precondition RULEs centrally).
**Purpose (one sentence):** Hold the single `Session`/Model and apply `Message`s through a **pure,
synchronous** `update(model, msg) -> (model, Vec<Command>)` reducer that produces the next Model and
side-effect commands, enforcing domain preconditions at the orchestration seam so no screen can
launch an operation against an unvalidated image.

This is the engine's testable core (REQ-NFR-006): feed `Message`s, assert on the resulting Model and
emitted `Command`s, no terminal required. Worker `Event`s are folded in as `Message`s. Long-running
work is **only ever** dispatched as a `Command::RunBuild`/`Command::RunFlash` to the worker — never
executed inline in the reducer. The `Message`/`Command` shape and the screen/navigation state for
the Direction-C dashboard + command-palette + full-screen views are specified in **Key Algorithms /
Workflows → "Reducer contract"** below (kept to the contract a Builder needs, not the whole match).

**Entry point(s):** `update(Model, Message) -> (Model, Vec<Command>)`.
**Exit point(s):** the next `Model` plus zero or more `Command`s for the shell/worker to execute.
**Invariants maintained:**
- The reducer is **pure** (no I/O, no terminal, no wall-clock except via an injected clock passed in
  the `Message` payload) and total (every `Message` is handled or explicitly ignored).
- Precondition RULEs are enforced **here**, once: no `StartBuild`/`StartFlash` is turned into a
  `RunBuild`/`RunFlash` command unless the image is `Validated`/`Extracted` and (build) the timing
  file is known (RULE-002/012); on violation the reducer produces a user-facing `ValidationIssue` in
  the Model, not a command.
- Exactly one active job tracked at a time; a second `Start*` while a job is active is rejected into
  the Model as a notice, not dispatched.

### `keys` — CpuKey validation + KeyLibrary + bind/mismatch + import/export

**Realizes:** REQ-009, REQ-010, REQ-011, REQ-012, REQ-013, REQ-014, REQ-NFR-003.
**Purpose (one sentence):** Validate CpuKey format, persist/load the `KeyLibrary`, manage
`KeyRecord` CRUD/search, bind a record to the active dump with a surfaced mismatch warning, and
import/export records — persisting only `ValidatedFormat` records.

**Entry point(s):** `CpuKey::parse(s) -> Result<CpuKey, ValidationIssue>` (exactly 32 hex chars,
case-insensitive); `KeyLibrary::load(path)` / `save(path)`; `add/edit/delete/search`;
`bind(record, &ConsoleInfo) -> BindOutcome`; `import(path)` / `export(path, selection)`.
**Exit point(s):** a persisted library file; `BindOutcome::Bound` or
`BindOutcome::BoundWithMismatchWarning { reasons }`; import counts (imported/skipped).
**Invariants maintained:**
- A `KeyRecord` is persisted **only** in `ValidatedFormat` (RULE-014); a key failing `CpuKey::parse`
  is rejected and the record is neither created nor saved (RULE-004).
- `bind` **always** compares `console_type`/`console_serial` against the loaded `ConsoleInfo` and, on
  conflict, returns `BoundWithMismatchWarning` so the UI surfaces it; binding is **never** silently
  accepted without the warning being available to surface (RULE-005).
- Raw key material never enters a `LogEntry` payload (redaction is `log`'s job; `keys` passes keys
  only through redaction-aware logging — see `log`).
- `KeyRecord` lifecycle: **Unverified → ValidatedFormat → BoundToDump**; unbind/session-end →
  `ValidatedFormat`. Binding is session-scoped (DQ-004 default).

### `troubleshoot` — fixture-backed guided-flow stepper

**Realizes:** REQ-025, REQ-026.
**Purpose (one sentence):** Load finite, fixture-backed `TroubleshootingFlow` decision trees and
drive a session that advances/branches on user responses and can step back, with no dynamic
generation.

**Entry point(s):** `load_flows() -> Vec<TroubleshootingFlow>` (bundled fixtures);
`FlowSession::start(flow)`; `advance(response) -> StepResult`; `back() -> StepResult`;
`abandon()`.
**Exit point(s):** the current `TroubleshootingStep` (or terminal), and a session-lifecycle event.
**Invariants maintained:**
- The flow graph is **finite and fixture-backed**; every step is reachable from `start_step_id`, and
  every non-terminal step has ≥1 response leading to another step or a terminal (RULE-013). No step
  is ever synthesized at runtime.
- Session lifecycle: **NotStarted → AtStep → (AtStep)* → Completed|Abandoned**. `advance` only ever
  follows an edge **declared** in the current step's `responses`; an undeclared response is rejected.
- `back()` walks a bounded visited-stack; it never advances past a terminal.

### `log` — append-only ActionLog + CPU-key redaction

**Realizes:** REQ-027, REQ-031, REQ-NFR-007 (and the security-flagged redaction → `08a`).
**Purpose (one sentence):** Append immutable, timestamped, structured `LogEntry` records to the
session `ActionLog` (optionally mirrored to a file), **redacting any CPU-key-shaped material** out of
messages and payloads before the entry is written.

**Entry point(s):** `ActionLog::append(level, operation, message, payload)` — runs redaction, then
appends; `mirror_to_file(entry)` when `AppConfig.log_file_path` is set.
**Exit point(s):** an immutable `LogEntry` in the ordered `ActionLog`; optionally a line appended to
the log file.
**Invariants maintained:**
- The `ActionLog` is **append-only and immutable**: no entry is ever edited, removed, or reordered
  (RULE-011).
- **No raw CPU-key material** ever lands in a `LogEntry.message`, `LogEntry.payload`, or the log file
  — redaction runs unconditionally on every append (security invariant, → `08a`). The redaction
  algorithm is specified in **Key Algorithms / Workflows → "CPU-key log redaction"** below.
- Timestamps come from the **injected clock**; they are display/audit only and never feed a checksum
  (ADR-006 / ARCH-RISK-005).

### `clock` / determinism mechanics (honors ADR-006)

**Realizes:** REQ-NFR-005 (and protects RULE-007/008).
**Purpose (one sentence):** Provide an **injectable `Clock` port** so all timestamps and any
randomness enter the system through a seam that tests can pin, and enforce the rule that
time/random **never** participate in checksums or progress sequences.

**Entry point(s):** `trait Clock { fn now(&self) -> Timestamp; }` with `SystemClock` (production) and
`FixedClock`/`SeededClock` (tests). Passed explicitly into `step`, `append`, and any `Message`
constructor that needs a timestamp.
**Exit point(s):** a `Timestamp` value, used only for `LogEntry`/`*_at` fields.
**Invariants maintained:**
- Checksum inputs (`build`) and progress/verify sequences (`build`/`flash`) are computed from a
  **canonical, deterministic byte/field set that contains no clock value and no RNG output**
  (ADR-006 / RULE-007 / RULE-008).
- Progress is **step-count-driven** (pct = `step_index * 100 / step_count`), not wall-clock-driven,
  so it is identical on a fast and a slow machine (REQ-NFR-005).

---

## Key Algorithms / Workflows

### NAND parse pipeline (load → validate → extract)

**Owned by:** `twinrunner-core::nand`
**Realizes:** REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-007, REQ-008.

This is a **fixture-backed, deterministic** reader. The byte offsets below are the *example's*
documented layout that the bundled fixtures are authored to satisfy; they are **not** a claim of
full Xbox-360-NAND fidelity (ARCH-RISK-003). Fields outside this set are reported absent.

**Phase 1 — `load(path)` (size detection, read-only):**

1. Open `path` **read-only** (RULE-001). On open error → `Error::Io`, emit `DumpLoadFailed`, stop.
2. Read the file length. Match it **exactly** against the four `SizeClass` byte counts
   (16/64/256/512 MB = 16,777,216 / 67,108,864 / 268,435,456 / 536,870,912). Any other length →
   `ValidationIssue { Error, UnknownSize, target: "file length", … }`, emit `DumpLoadFailed`, stop
   (RULE-009). **Validation does not proceed for unrecognized sizes.**
3. Read bytes into `raw_bytes`; construct `NandImage { source_path, size_class, raw_bytes,
   validation_status: Unvalidated }`. Emit `DumpLoaded`.

**Phase 2 — `validate(&mut image)` (structure + ECC; sets `Validating` then `Validated`/`Invalid`):**

1. Set `validation_status = Validating`; emit `ValidationStarted`. Collect issues in a `Vec`.
2. **FlashConfig presence:** read the 4-byte `FlashConfig` at the documented offset for this
   `SizeClass`. If it is the zero/sentinel value or fails the documented bit-pattern check →
   `ValidationIssue { Error, MissingFlashConfig, target: "FlashConfig" }` (REQ-002/005).
3. **Region map / layout sanity:** resolve the `NandLayout` from `SizeClass` + `FlashConfig.ecc_type`.
   If the FlashConfig-implied `ecc_type`/`page_size` is not one of the known layouts →
   `ValidationIssue { Error, UnknownLayout, target: "NandLayout" }`.
4. **ECC / sanity check, per region:** for each documented region (bootloader region, fuse region,
   keyvault region) walk its page/spare-area pairs and recompute the simulated ECC check value over
   each page; compare to the stored spare-area value. The **first** failing region produces
   `ValidationIssue { Error, EccFailure, target: "<region name>" }` (REQ-007) — the issue **names the
   failing region**, never a generic "corrupt".
5. If any Error-severity issue was collected → `validation_status = Invalid`, emit `ValidationFailed`,
   return `Err(issues)`. **Never advance to `Validated`/`Extracted`** (RULE-002/003). Else
   `validation_status = Validated`, emit `ValidationPassed`, return `Ok(())`.

**Phase 3 — `extract(&image)` (Validated → ConsoleInfo; sets `Extracted`):**

1. Precondition: `image.validation_status == Validated`, else return
   `Err(ValidationIssue { Error, NotValidated, … })` (RULE-002).
2. **ConsoleType determination** (documented, fixture-backed): read the FlashConfig value and the
   CB-version marker at the documented bootloader offset. Map `(FlashConfig pattern, CB version
   range)` to a `ConsoleType` (Xenon/Zephyr/Falcon/Jasper/Trinity/Corona) via a fixed lookup table.
   If neither marker resolves a known generation → `ConsoleType` is reported, but with a Warning
   `ValidationIssue { Warning, ConsoleTypeUncertain, … }` rather than a guess (the type field falls
   back to the closest size-class-implied default and is flagged uncertain).
3. **Serial:** read the documented serial offset; if the bytes are printable ASCII of the expected
   length → `serial = Present(s)`, else `serial = Absent` (REQ-003). Never fabricate.
4. **Bootloader chain:** walk CB/CD/CE/CF/CG at their documented offsets; for each, read a presence
   marker and a version field. Present stages become `Bootloader { stage, version, present: true }`;
   missing stages become `present: false` (REQ-004). At least CB must be present, else a Warning.
5. **FuseSet:** read the fuse region into `fuse_lines` (one hex string per documented fuse line) and
   derive `security_state` from the fuse pattern via a documented table (REQ-005).
6. **CPU key:** read the documented keyvault/CPU-key region. If the bytes form a derivable 32-hex-char
   key per the documented rule → `cpu_key = Present(CpuKey)`. If the region is zeroed, masked, or the
   key cannot be derived → `cpu_key = Absent` and emit `CpuKeyAbsent` (RULE-010). **Never** return a
   zeroed/default key.
7. Build `ConsoleInfo`, set `validation_status = Extracted`, emit `ConsoleInfoExtracted`. Export
   (REQ-008) serializes this `ConsoleInfo` to text/JSON at a user-chosen path via serde.

**Edge cases:** zero-length / truncated file (Phase 1 reject); length matches a `SizeClass` but
content is garbage (Phase 2 FlashConfig/ECC reject → `Invalid`, region named); FlashConfig present
but layout unknown (Phase 2 `UnknownLayout`); CPU-key region zeroed (Phase 3 `Absent`, not error);
ConsoleType markers ambiguous (Warning + flagged-uncertain default). **Every** failure is a typed
issue, never a panic (REQ-NFR-011).
**Complexity / cost:** O(n) single pass over `raw_bytes` for ECC; bounded by the largest fixture
(512 MB) but example fixtures are small (64 MB primary). No allocation beyond the loaded buffer +
issue list.

### Deterministic step-count progress engine (shared by `build` and `flash`)

**Owned by:** `twinrunner-core::build`, `twinrunner-core::flash`
**Realizes:** REQ-019, REQ-023, REQ-NFR-005.

1. Each job declares a fixed ordered list of `phases` (e.g. build: `[Prepare, PatchRegions,
   ComputeEcc, WriteOutput, Checksum]`). `step_count = phases.len()` (or a fixed sub-step total).
2. `step()` advances `step_index += 1`, computes `pct = step_index * 100 / step_count`, emits
   `StepOutcome::Progress { pct, log: <phase-named entry> }`. Progress is **purely a function of
   step_index** — no sleep, no wall-clock (REQ-NFR-005). The worker controls real-time pacing if any
   visible delay is desired; the *sequence* is identical regardless.
3. After the final phase, the job computes its terminal result (artifact+checksum for build;
   verify+result for flash) and emits `Done`/`Failed`.

**Edge cases:** cancellation between steps (worker stops calling `step`; job is dropped, partial
output for build is *not* left at the final path — see build write-ordering below).
**Complexity / cost:** O(step_count); constant per step.

### Build checksum input set (deterministic, clock-free)

**Owned by:** `twinrunner-core::build`
**Realizes:** REQ-019, RULE-007, ADR-006.

The `BuildArtifact.checksum` is **sha256** over a single canonical byte buffer assembled, in this
exact order, from **inputs only**:

1. `source_image_path` **file contents** (the raw source dump bytes) — the actual input, not the path
   string.
2. `timing_file_id` UTF-8 bytes, then the resolved `TimingFile.content` bytes (fixture-backed,
   stable).
3. `artifact_type` discriminant byte (`EccFile=0x01`, `XeLLImage=0x02`).
4. The simulator's **deterministic transform constant** (a fixed version tag for the simulation
   algorithm, so a deliberate algorithm change is a visible checksum change).

**Excluded from the buffer (ADR-006 / ARCH-RISK-005):** wall-clock time, `started_at`/`completed_at`,
any `LogEntry.timestamp`, any RNG, the output path string, and the job `id` (UUID). Therefore
identical `BuildInputs` → identical `checksum`, on any machine, every run (RULE-007). The same
canonical buffer (without step 1's full file, using only the verified-image bytes) backs the flash
verify comparison so determinism holds there too (RULE-008).

**Edge cases:** two builds with different output paths but identical inputs → **same** checksum (path
is excluded) — correct and intended. **Build output write-ordering (atomicity):** the simulator
writes to a temporary file alongside the output path, computes the checksum, then renames into place
on success; a cancellation/failure leaves **no** partial file at the final output path and **never**
touches the source (RULE-001).

### Flash verify-after-write compare

**Owned by:** `twinrunner-core::flash`
**Realizes:** REQ-023.

For a Write `FlashJob`: after the simulated write phase the job enters `Verifying`, then compares the
**written-image bytes** (what the simulator "wrote" to the simulated Programmer) against the
**intended image bytes** (the input). Comparison is a byte-length check then a streaming equality
check. Equal → `VerifyResult::Pass` → `Succeeded` (emit `FlashVerified`/`FlashCompleted`). Unequal,
or an induced-fixture failure → `VerifyResult::Fail { first_diff_offset }` → `Failed` with the
fixture-backed `RecoveryStep` list populated (REQ-024). Read/Erase skip `Verifying` entirely.

### Reducer contract — `update(model, msg) -> (model, Vec<Command>)`

**Owned by:** `twinrunner-core::model`
**Realizes:** REQ-NFR-006, REQ-NFR-011, and orchestration of all functional REQs.

This specifies the **contract**, not the full match (code is clearer than prose for the body).

**`Message` (the input alphabet)** groups into:
- **User-intent messages** (from the keymap): `Navigate(Screen)`, `OpenCommandPalette`,
  `RunPaletteCommand(id)`, `LoadDump(path)`, `RequestValidate`, `RequestExtract`,
  `ExportConsoleInfo(path)`, key-library CRUD/search/bind/import/export intents,
  `ConfigureBuild(BuildInputs)`, `StartBuild`, `ConfigureFlash(op, image?)`, `StartFlash`,
  `CancelJob`, troubleshooting `StartFlow/Respond/Back/Abandon`, `Resize(w,h)`, `Quit`.
- **Worker-event messages** (folded from `WorkerEvent`, see Concurrency): `JobStarted`,
  `JobProgressed { pct }`, `JobLogged { entry }`, `JobCompleted { result }`, `JobFailed { error }`.

**`Command` (the output alphabet — side effects the shell/worker execute):**
`RunBuild(BuildJob)`, `RunFlash(FlashJob)`, `CancelWorkerJob`, `WriteFile { path, bytes }`
(exports / library save), `Redraw` (implicit), `ShutdownWorker`. The reducer **emits** these;
it never performs them.

**Folding rules:**
1. `LoadDump(path)` → command-less; reducer calls `nand::load` *result is delivered as a follow-up
   message* — to keep the reducer pure, file I/O is modeled as a `Command::ReadDump(path)` whose
   result returns as a `DumpLoaded(NandImage)` / `DumpLoadFailed(issue)` message. (The reducer never
   blocks on I/O.)
2. `StartBuild` → reducer checks RULE-012/RULE-002/RULE-001 against the Model. **Pass** → push
   `Command::RunBuild(prepared_job)` and set the active-job slot. **Fail** → no command; write the
   `ValidationIssue` into the Model for the UI to show.
3. `StartFlash` → analogous (RULE-012 for Write image path).
4. Worker `JobProgressed/JobLogged/JobCompleted/JobFailed` → update the active job's state/progress/
   log in the Model; on terminal, clear the active-job slot and record the `OperationResult`.
   `JobLogged` entries are appended via `log` (redaction applies).
5. A second `StartBuild`/`StartFlash` while `active_job.is_some()` → rejected into the Model as a
   "one job at a time" notice; **no** command (concurrency precondition).

**Screen / navigation state** (Direction-C dashboard + command-palette + full-screen views):
- `Model.screen: Screen` enum — `Dashboard` (the Direction-C home: status tiles + recent log +
  active-job strip), `ConsoleInfo`, `KeyLibrary`, `Build`, `Flash`, `Troubleshoot`, `Log`, `Help`.
- `Model.palette: Option<PaletteState>` — when `Some`, the command palette overlays the current
  screen; `RunPaletteCommand(id)` maps a palette entry to a normal `Message` and closes the palette.
- `Model.focus` and per-screen view-state (selected row, form field, scroll offset) live in a
  `ScreenState` sub-enum keyed by `screen`. Navigation (`Navigate`, palette) only mutates
  screen/focus/scroll — it **never** triggers a domain operation, so navigation is always safe even
  with no dump loaded.

**Edge cases:** `Message` arriving for a screen that is not active (e.g. a stale worker event after
the user navigated away) is still folded into the Model's job slot (job state is screen-independent)
and shown on the dashboard's active-job strip; navigation never drops worker events.
**Complexity / cost:** O(1) per message except list-search/filter (O(n) over records), which is fine
for the local single-user library size.

### CPU-key log redaction

**Owned by:** `twinrunner-core::log`
**Realizes:** REQ-NFR-007, security (→ `08a`).

On **every** `append`, before the entry is stored or mirrored, run redaction over `message` and over
every string value in `payload`:
1. Replace any substring matching the CPU-key shape — a run of **exactly 32 hexadecimal characters**
   (`[0-9a-fA-F]{32}`, with a word boundary so it does not clip inside a longer hex blob like a
   checksum) — with the fixed token `REDACTED_CPU_KEY`.
2. Structured payload fields **known** to carry key material (a `cpu_key` keyed value) are redacted by
   key name regardless of shape, as defense-in-depth (covers a malformed-but-sensitive value).
3. The redacted entry is what gets appended and mirrored; the original key string is never persisted.

**Edge cases:** a legitimate non-key 32-hex value (a SHA-256 is **64** hex chars, so it does not
match; a CRC is shorter) — the 32-char-exact boundary avoids redacting checksums. A key embedded in a
longer error string is still caught by the regex pass.
**Complexity / cost:** O(len(message)) regex scan per entry; negligible.

---

## State Machines

### `NandImage` Validation Lifecycle

**Realizes:** REQ-001, REQ-002, REQ-007. **Defined in domain model:** yes — `03-domain-model.md`
§State Models.

| From state | Event / action | Guard | To state | Side effect |
|---|---|---|---|---|
| `Unvalidated` | `validate()` | — | `Validating` | emit `ValidationStarted` |
| `Validating` | checks complete, no Error issues | all structure+ECC pass | `Validated` | emit `ValidationPassed` |
| `Validating` | checks complete, ≥1 Error issue | any Error-severity issue | `Invalid` | emit `ValidationFailed`, region named |
| `Validated` | `extract()` | status == Validated | `Extracted` | emit `ConsoleInfoExtracted` (or `CpuKeyAbsent`) |
| `Invalid` | `load(replacement)` | — | `Unvalidated` (new image) | previous image discarded; source untouched |

**Terminal states:** `Extracted` (terminal in session). **Invalid transitions:** `extract()` from
`Unvalidated`/`Validating`/`Invalid` → rejected with `ValidationIssue { Error, NotValidated }`
(RULE-002/003); the image is **never** silently advanced.

### `BuildJob` Lifecycle

**Realizes:** REQ-015, REQ-019. **Defined in domain model:** yes.

| From state | Event / action | Guard | To state | Side effect |
|---|---|---|---|---|
| (create) | `prepare(inputs)` | image Validated/Extracted, timing known, out≠src (RULE-001/012) | `Pending` | emit `BuildJobCreated` |
| `Pending` | worker `step()` (first) | user confirmed → `RunBuild` dispatched | `Running` | emit `BuildStarted`, pct=0 |
| `Running` | `step()` (progress) | not final phase | `Running` | emit `BuildProgressed { pct }` |
| `Running` | final phase ok | checksum computed | `Succeeded` | rename temp→output; emit `BuildCompleted { artifact }` |
| `Running` | error / cancel | — | `Failed` | emit `BuildFailed`; no file at output path |
| `Failed` | `prepare(new inputs)` | — | `Pending` (new job) | retry is a new job |

**Terminal states:** `Succeeded`, `Failed`. **Invalid transitions:** `prepare` that fails a guard
never reaches `Pending` (returns issues); `Running` is reachable **only** via the worker after a
`RunBuild` command — never inline in the reducer.

### `FlashJob` Lifecycle (incl. `Verifying`)

**Realizes:** REQ-021, REQ-023, REQ-024. **Defined in domain model:** yes.

| From state | Event / action | Guard | To state | Side effect |
|---|---|---|---|---|
| (create) | `prepare(op, image?)` | Write ⇒ image_path present (RULE-012) | `Pending` | emit `FlashJobCreated` |
| `Pending` | worker `step()` (first) | user confirmed → `RunFlash` | `Running` | emit `FlashStarted`, pct=0 |
| `Running` | `step()` (progress) | not final phase | `Running` | emit `FlashProgressed { pct }` |
| `Running` | write phase done | op == Write | `Verifying` | emit `FlashVerifying` |
| `Running` | op done | op == Read \| Erase | `Succeeded` | emit `FlashCompleted` |
| `Verifying` | verify pass | written == intended | `Succeeded` | emit `FlashVerified`, `FlashCompleted` |
| `Verifying` | verify fail | mismatch / induced | `Failed` | populate `RecoveryStep`s; emit `FlashFailed`, `RecoverySuggested` |
| `Running` | error | — | `Failed` | populate `RecoveryStep`s; emit `FlashFailed` |

**Terminal states:** `Succeeded`, `Failed`. **Invalid transitions:** a Write reaching `Succeeded`
**without** passing through `Verifying` is forbidden (REQ-023); a `Succeeded` job must carry an empty
`recovery_steps`, a `Failed` job a non-empty one (REQ-024).

### `KeyRecord` Lifecycle

**Realizes:** REQ-011, REQ-013. **Defined in domain model:** yes.

| From state | Event / action | Guard | To state | Side effect |
|---|---|---|---|---|
| (add) | `CpuKey::parse(s)` ok | exactly 32 hex (RULE-004) | `ValidatedFormat` | record may be persisted (RULE-014) |
| (add) | `CpuKey::parse(s)` fail | not 32 hex | (rejected) | `ValidationIssue`; record not created |
| `ValidatedFormat` | `bind(&ConsoleInfo)` | — | `BoundToDump` | `Bound` or `BoundWithMismatchWarning` (RULE-005); emit `KeyBoundToDump` |
| `BoundToDump` | unbind / session end | — | `ValidatedFormat` | binding is session-scoped (DQ-004) |
| `ValidatedFormat` | edit + re-check | re-parse on key edit | `ValidatedFormat` | emit `KeyRecordUpdated` |

**Terminal states:** none within a session (records persist as `ValidatedFormat`). **Invalid
transitions:** persisting an `Unverified` record is forbidden (RULE-014); binding without surfacing a
detected mismatch is forbidden (RULE-005).

### `TroubleshootingFlow` Session Lifecycle

**Realizes:** REQ-025, REQ-026. **Defined in domain model:** yes.

| From state | Event / action | Guard | To state | Side effect |
|---|---|---|---|---|
| `NotStarted` | `start()` | flow loaded | `AtStep(start_step_id)` | emit `TroubleshootingFlowStarted` |
| `AtStep` | `advance(response)` | response ∈ current step's declared responses (RULE-013) | `AtStep(next)` | emit `TroubleshootingStepAdvanced` |
| `AtStep` | `advance(response)` | response leads to terminal | `Completed` | emit `TroubleshootingFlowCompleted` |
| `AtStep` | `back()` | visited-stack non-empty | `AtStep(prev)` | pop visited stack |
| `AtStep` | `abandon()` / navigate away | — | `Abandoned` | emit `TroubleshootingFlowAbandoned` |

**Terminal states:** `Completed`, `Abandoned`. **Invalid transitions:** an `advance(response)` whose
response is **not** declared on the current step is rejected (RULE-013 — no dynamic edges).

---

## Error Handling

| Component | Error condition | Owner of handling | Response / recovery | Exposed to caller? |
|---|---|---|---|---|
| `nand` | File length ≠ any `SizeClass` | `nand` | `ValidationIssue { Error, UnknownSize }`; emit `DumpLoadFailed`; stop before validation (RULE-009) | yes (typed) |
| `nand` | FlashConfig absent/malformed | `nand` | `ValidationIssue { Error, MissingFlashConfig, target:"FlashConfig" }`; image `Invalid` | yes |
| `nand` | ECC fails on a region | `nand` | `ValidationIssue { Error, EccFailure, target:"<region>" }`; image `Invalid`; extraction blocked (RULE-003) | yes |
| `nand` | CPU key not derivable | `nand` | `cpu_key = Absent` (RULE-010); emit `CpuKeyAbsent`; **not** an error | yes (as state) |
| `nand` | Malformed/hostile binary mid-parse | `nand` | Typed `Error`/issue, **never panic**; UI stays safe (REQ-NFR-011) | yes |
| `keys` | CpuKey not 32 hex | `keys` | `ValidationIssue { Error, InvalidKeyFormat }`; record not created/persisted (RULE-004/014) | yes |
| `keys` | Key↔dump identity mismatch on bind | `keys` | `BoundWithMismatchWarning { reasons }`; UI must surface before accept (RULE-005) | yes |
| `keys` | Library file missing/corrupt at load | `keys` | Fall back to **empty library** + Warning issue; do not crash (REQ-NFR-011) | yes |
| `build` | `output_path == source_path` | `build` (in `prepare`) | Refuse before any write (RULE-001); `ValidationIssue { Error, OutputEqualsSource }` | yes |
| `build` | Source not Validated / timing unknown | `build` (in `prepare`) | Refuse; `ValidationIssue` (RULE-012); no `Pending` job | yes |
| `build` | Write/checksum failure mid-job | `build` | Job → `Failed`; temp file removed; **no** file at output path; source untouched | yes (as `Failed` event) |
| `flash` | Write without image path | `flash` (in `prepare`) | Refuse; `ValidationIssue` (RULE-012) | yes |
| `flash` | Verify mismatch / induced failure | `flash` | Job → `Failed`; populate fixture-backed `RecoveryStep`s (REQ-024) | yes (as `Failed` event) |
| `worker` | Job panics/errors on bg thread | `worker` | Catch → convert to `WorkerEvent::JobFailed`; UI never crashes (REQ-NFR-011) | yes (as event) |
| `model` | `Start*` precondition violation | `model` | No `Command`; write `ValidationIssue` into Model for UI display | yes (in Model) |
| `model` | `Start*` while a job is active | `model` | Reject into Model as "one job at a time" notice; no command | yes (in Model) |
| `troubleshoot` | Undeclared response on a step | `troubleshoot` | Reject; stay `AtStep` (RULE-013) | yes |
| `tui` | Terminal below min size / resize | `tui` (binary) | Re-layout; show "terminal too small" message; no crash (REQ-034/NFR-009) | n/a (UI) |
| `config` | Config file missing/invalid field | `config` | Per-field fallback to default; never abort startup (REQ-033) | no (silently defaulted + logged) |

**Error propagation model:** Core uses **typed `Result<T, Error>` and `Vec<ValidationIssue>`**
(`thiserror`-style) — **no panics on any data-driven path** (REQ-NFR-011). Operation failures within
a job become **`WorkerEvent::*Failed` → `Message`** and are folded into the Model as an
`OperationResult::Failure` (with `RecoveryStep`s for flash) — they never unwind across the thread
boundary. The binary shell uses `anyhow` only at the `main` top level for context; the internal/UI
boundary is: typed core errors → user-facing `ValidationIssue`/`OperationResult` in the Model →
rendered message + key hint. A failing operation **always** returns the user to a safe, navigable
state (REQ-NFR-011).

---

## Concurrency / Ordering / Idempotency

The system is **single-threaded for all domain logic** plus **exactly one background worker thread**
for job stepping (ADR-002). There are no other threads, no shared mutable domain state across
threads, and no async runtime.

### Worker message protocol (the spec the architecture deferred)

**UI → worker (`WorkerCommand`):**
- `StartBuild(BuildJob)` — begin stepping a prepared build job.
- `StartFlash(FlashJob)` — begin stepping a prepared flash job.
- `Cancel` — request cancellation of the in-flight job at the next step boundary.
- `Shutdown` — stop the loop and let the thread return for join.

**Worker → UI (`WorkerEvent`):**
- `Started { job_id }` — the worker accepted and began the job.
- `Progress { job_id, pct }` — one step advanced (monotonic non-decreasing pct).
- `Log { job_id, entry }` — a structured `LogEntry` produced by the job (already redaction-safe;
  `log` redacts on append in the Model).
- `Completed { job_id, result }` — terminal success (`BuildArtifact` / verify `Pass`).
- `Failed { job_id, error, recovery_steps? }` — terminal failure (recovery steps for flash).

**Per-tick non-blocking drain (event loop in `tui`, honors REQ-NFR-001):**

1. Poll crossterm input with a **short timeout** (e.g. 16–50 ms); translate any key event to a
   `Message` via the keymap.
2. **Drain** the worker→UI channel with **`try_recv` in a loop until `Empty`** — never `recv()`
   (which would block). Each `WorkerEvent` becomes a `Message`.
3. Call the pure `model.update` once per message, in arrival order, accumulating `Command`s.
4. Dispatch `Command`s: worker commands go over the UI→worker channel (`send`, non-blocking enough —
   bounded protocol); file writes go through core synchronously (small files).
5. Render the current Model. The loop **never blocks** on the worker; if no input and no events, the
   short input-poll timeout bounds the idle spin.

**Worker thread loop:**
1. Block on `rx.recv()` for the **next command** when idle (this *is* allowed to block — it is the
   worker, not the UI).
2. On `StartBuild`/`StartFlash`: set the active job; loop calling `job.step(clock)`, sending a
   `Progress`/`Log` event per step. Between steps, `try_recv` for a `Cancel`/`Shutdown` so
   cancellation is honored at the **next step boundary** (not mid-step — steps are small and atomic).
3. On terminal step: send `Completed`/`Failed`, clear the active job, return to (1).
4. On `Cancel`: stop stepping, drop the partial job (build temp file removed; source untouched), send
   a `Failed { error: Cancelled }` so the UI clears its active-job slot deterministically.
5. On `Shutdown`: finish/abort the current step boundary, break the loop, return so the UI can
   `join()` the handle cleanly.

### Concurrency constraints

- **`worker`** — **at most one job in flight at a time** (MVP). Enforced two ways: (a) the `model`
  reducer refuses a second `Start*` while `active_job.is_some()`; (b) the worker holds a single
  active-job slot and ignores a `Start*` arriving while busy (defense in depth). A second job is a
  user-visible "one job at a time" notice, never a queue (queueing is out of MVP scope).
- **`model` reducer** — **runs only on the UI thread**, single-threaded, never invoked from the
  worker. This is what makes the reducer's purity safe (no locks needed on the Model).
- **`keys` library file / `log` file** — written only from the UI thread (file writes are reducer
  `Command`s executed by the shell), so there is **no concurrent writer** to either file.

### Ordering constraints

- **`worker` events for a single job** — `Started` precedes any `Progress`, `Progress` pct is
  **monotonic non-decreasing**, and `Completed`/`Failed` is the **last** event for that `job_id`.
  Guaranteed by single-threaded stepping over one mpsc channel (FIFO).
- **`ActionLog`** — entries are appended in the order their `Message`s are folded; since the drain
  processes worker events in channel FIFO order and the reducer is sequential, log order matches
  execution order (RULE-011 append-only).

### Idempotency

- **Build (same `BuildInputs`)** — **idempotent in result**: identical inputs always yield an
  identical `BuildArtifact.checksum` (RULE-007). Re-running writes a (byte-identical) file; the
  source is never touched. Output path differing does not change the checksum (path excluded).
- **Flash verify** — **idempotent**: same operation + same input bytes yields the same verify result
  and progress sequence every run (RULE-008).
- **`Cancel` / `Shutdown`** — idempotent: a `Cancel` with no active job, or a second `Shutdown`, is a
  no-op (the worker has no active slot / is already returning).
- **NAND `load`/`validate`/`extract`** — pure functions of the input bytes; re-running on the same
  file yields the same result and same issues. No side effect except the read-only open.

---

## Invariants

- **INV-001** — The **source dump file is never written, truncated, or deleted** by any operation;
  every output is a new file at a distinct user-chosen path. — enforced by: `nand` (read-only open),
  `build`/`flash` (temp-write + rename to output, `output != source` guard) — anchors: REQ-035,
  RULE-001. *(blast-radius: data integrity)*
- **INV-002** — A `NandImage` reaches `Extracted` **only** through `Unvalidated → Validating →
  Validated → Extracted`; an `Invalid`/`Unvalidated` image is **never** silently extracted, and the
  failing ECC region is always named. — enforced by: `nand`, `model` (precondition seam) — anchors:
  REQ-002, REQ-007, RULE-002/003.
- **INV-003** — A `CpuKey` value in the system has **always passed** the exactly-32-hex format check;
  an underivable CPU key is the explicit `Absent` variant, **never** a zeroed/guessed key. — enforced
  by: `keys` (`CpuKey::parse`), `nand` (extract) — anchors: REQ-006, REQ-011, RULE-004/010/014.
- **INV-004** — Every build/flash operation **flows through the port** (`BuildBackend`/
  `FlashBackend`); the simulator is the only adapter that produces output, and the real stub
  **never** writes or acts. — enforced by: `build`, `flash` (structural — only the simulator adapter
  writes) — anchors: REQ-020, REQ-022, REQ-NFR-004, RULE-006. *(blast-radius: safety)*
- **INV-005** — **No wall-clock time and no RNG ever participates in a `BuildArtifact.checksum` or a
  progress/verify sequence**; time enters only via the injected `Clock` and only into display/audit
  fields. — enforced by: `build`, `flash`, `clock`, `log` — anchors: REQ-NFR-005, RULE-007/008,
  ADR-006.
- **INV-006** — The `ActionLog` is **append-only and immutable**, and **no raw CPU-key material**
  ever appears in a `LogEntry` or the log file. — enforced by: `log` (append-only + unconditional
  redaction) — anchors: REQ-027, REQ-NFR-007, RULE-011 (+ `08a` security).
- **INV-007** — At most **one job is in flight at a time**; worker events for a job are ordered
  `Started → Progress* → (Completed|Failed)` with monotonic pct, and a failing job **never** crashes
  the UI. — enforced by: `model` (single-active-slot) + `worker` (single-thread FIFO, panic→Failed)
  — anchors: REQ-NFR-001, REQ-NFR-011.
- **INV-008** — The `model.update` reducer is **pure and synchronous**: no terminal I/O, no blocking
  file I/O, no wall-clock except via injected values; long-running work leaves the reducer only as a
  `Command`. — enforced by: `model` — anchors: REQ-NFR-006.
- **INV-009** — Every `TroubleshootingFlow` is **finite and fixture-backed**; `advance` follows only
  declared edges, and every step is reachable from `start_step_id`. — enforced by: `troubleshoot`
  (load-time validation + edge-only advance) — anchors: REQ-026, RULE-013.

---

## Open Design Questions

> None of the below changes user-visible behavior or which data is preserved; each carries a safe
> default already implied by the architecture/domain RULEs. **No item requires a human gate** — the
> two irreversible style decisions were settled in Stage 4 (2026-06-10).

- **ODQ-001** — *Cancellation granularity.* Cancellation is honored at the **next step boundary**
  (steps are small and atomic), not mid-step. — blocking: **no** — owner: `worker`/`build`/`flash`
  — consequence if deferred: none; finer-grained mid-step cancellation is unnecessary because steps
  are bounded and deterministic. **Default: step-boundary cancellation.**
- **ODQ-002** — *Build output atomicity mechanism.* Default is **temp-file write + atomic rename**
  into the output path on success, so a cancel/failure leaves no partial artifact (protects RULE-001
  observability). — blocking: **no** — owner: `build` — consequence if deferred: a non-atomic
  direct-write would risk a partial file at the output path on failure (still never the source).
  **Default: temp + rename.**
- **ODQ-003** — *ConsoleType uncertainty surfacing.* When the documented markers are ambiguous, the
  default is to **report the closest size-class-implied `ConsoleType` plus a Warning
  `ConsoleTypeUncertain` issue**, rather than `Absent` (a console always has *a* type; only the
  precise generation may be uncertain in this simulated parser — ARCH-RISK-003). — blocking: **no**
  — owner: `nand` — consequence if deferred: choosing `Absent` instead would under-report; the
  default is more useful and still honest (the uncertainty is flagged). **Default: best-guess +
  Warning flag.**
- **ODQ-004** — *Redaction token shape.* Default redaction token is the fixed string
  `REDACTED_CPU_KEY` and the match is **exactly** 32 hex chars with word boundaries (so 64-char
  SHA-256 checksums and shorter CRCs are not redacted). — blocking: **no** — owner: `log` —
  consequence if deferred: a looser pattern could over-redact checksums in logs; the exact-32
  boundary avoids that. **Default: exact-32 + boundary, fixed token.** (Carried to `08a` for review.)
