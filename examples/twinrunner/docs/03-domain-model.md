# Domain Model — TwinRunner

> **Stage 3 — Domain Modeling** (spec §14.3). Streams; no human gate. Reads the Summaries from
> `01-requirements.md` and `02-scope.md` by default; fetches full artifacts only when a detail
> cannot be resolved from the Summary (§9). Proposes an initial model first, then invites the
> user to confirm, correct, or expand. Where entities realize a specific requirement, anchor them
> to the REQ-ID so traceability holds downstream (§11).

## Summary

TwinRunner's domain is the Xbox 360 NAND management and RGH/JTAG repair workflow. The central
artifact the system works with is a `NandImage` — a raw dump file from a console's NAND chip —
which is loaded, validated, and parsed to extract a `ConsoleInfo` (board type, serial, fuses,
bootloader chain, CPU key). A `KeyLibrary` holds `KeyRecord`s that bind CPU keys to console
identities across sessions. Two job-like entities — `BuildJob` and `FlashJob` — represent
simulated operations on images and a simulated programmer device respectively; both are gated
behind backend port abstractions (no real hardware path exists). A `TroubleshootingFlow`
captures the guided RGH/JTAG decision tree. Structured `LogEntry` records and a per-session
`ActionLog` provide the audit trail for everything that happens. The most important invariant of
the entire domain is that the source dump file is always read-only; every mutation produces a
new artifact at a user-chosen path.

- **Central entity:** `NandImage` — the raw dump file that all four capability areas operate on.
- **Key relationship:** `NandImage` → `ConsoleInfo` (one-to-one, derived by parsing); `KeyRecord`
  may be bound to a `NandImage` to associate a stored CPU key with a loaded dump.
- **Core domain rule:** A source `NandImage` is never mutated in place; all build and flash
  operations write outputs to new user-chosen paths (REQ-035, RULE-001).

---

## Domain Summary

TwinRunner operates in the world of Xbox 360 console repair and homebrew modification. A
technician or hobbyist begins with a raw binary dump of a console's NAND flash chip — a file
that encodes everything about that specific console: its board generation, bootloader chain,
fuse state, ECC layout, and (when present in the dump) its CPU key. The system's job is to
read that file safely, make sense of it, and support a four-stage workflow: parse and validate
the dump, manage a personal library of CPU keys across consoles, build or patch a new image
for flashing, and then simulate the flash operation against that image with guided recovery and
troubleshooting for RGH/JTAG glitch-chip setups.

Because real hardware communication and image building involve irreversible, potentially
brick-causing operations, all such work is modeled as going through a backend port abstraction.
In this system the only acting backend is a deterministic simulator; real hardware backends are
no-op stubs. The domain therefore distinguishes sharply between things the system *knows*
(parsed, validated facts about a dump and a console) and things the system *does* (simulated
operations that always produce verifiable, deterministic results). Safety — never corrupting a
source file, never silently passing a bad dump, never guessing when a CPU key cannot be derived
— is a first-class property baked into the domain rules, not an afterthought.

---

## Core Entities

### NandImage  <!-- REQ-001, REQ-002, REQ-003, REQ-007, REQ-035 -->

A `NandImage` is a binary dump of an Xbox 360 console's NAND flash chip loaded from a file path
on disk. It is the central artifact: every other capability in the system either reads from it,
derives facts about it, or produces a new image derived from it. A `NandImage` carries a detected
size class (16, 64, 256, or 512 MB), a raw byte representation (in memory, during the session),
and a validation status that reflects whether structure and ECC integrity checks have passed. The
source file on disk is always treated as read-only; the domain never allows in-place mutation of
a loaded dump.

### NandLayout  <!-- REQ-002, REQ-003 -->

A `NandLayout` describes the structural organization of a particular NAND image: the ECC type
(e.g. small-block vs. large-block), the page and spare-area geometry, and the region map that
tells the parser where bootloaders, fuse data, and user data live within the binary. Each
recognized `SizeClass` and `ConsoleType` combination implies a specific `NandLayout`; an image
that does not match any known layout is structurally invalid.

### FlashConfig  <!-- REQ-002, REQ-005 -->

A `FlashConfig` is the header/configuration block embedded at a known offset in a NAND image
that identifies the flash chip parameters, ECC mode, and layout. Parsing the `FlashConfig` is
the first step in structure validation: if the block is absent or malformed the dump is rejected
before any extraction proceeds.

### ConsoleInfo  <!-- REQ-003, REQ-004, REQ-005, REQ-006, REQ-008 -->

`ConsoleInfo` is the set of facts the system derives from a successfully validated `NandImage`.
It groups: the detected `ConsoleType` (board generation), console serial (when readable), ECC
type, the full `BootloaderChain`, the `FuseSet`, and the extracted or derived CPU key value (if
present; absence is reported explicitly). It is a derived, read-only value — it is computed from
the dump and never stored back into the source file.

### ConsoleType  <!-- REQ-003 -->

`ConsoleType` is an enumeration of known Xbox 360 motherboard/board generations: Xenon, Zephyr,
Falcon, Jasper, Trinity, Corona. Each type determines the expected NAND layout, bootloader chain
structure, and applicable glitch types. `ConsoleType` is the anchor that drives which
`TroubleshootingFlow` steps are applicable and which timing files are valid for a given `BuildJob`.

### SizeClass  <!-- REQ-001 -->

`SizeClass` is an enumeration of the four recognized NAND image sizes: 16 MB, 64 MB, 256 MB,
512 MB. A file whose byte length does not match one of these values is rejected immediately with
a clear error. `SizeClass` constrains which `NandLayout` and `ConsoleType` combinations are
plausible.

### BootloaderChain  <!-- REQ-004 -->

A `BootloaderChain` is the ordered sequence of bootloader stages embedded in a NAND dump: CB,
CD, CE, CF, and CG (not all are present in every image — the set present depends on `ConsoleType`
and firmware generation). Each stage has a name and a detected version number. The chain is
extracted as a read-only list from a validated image.

### Bootloader  <!-- REQ-004 -->

A `Bootloader` is a single stage in the `BootloaderChain`: one of CB/CD/CE/CF/CG, its version
string, and its presence/absence flag. Versions are displayed in the console-info view and
influence which glitch flows and timing files are relevant.

### FuseSet  <!-- REQ-005 -->

A `FuseSet` represents the fuse lines and security-relevant fields extracted from the NAND dump.
Fuses are one-time-programmable hardware bits burned into the Xbox 360 SoC; their state
indicates the console's security state and CB version line. The domain treats `FuseSet` as an
extracted, read-only fact derived from the dump.

### CpuKey  <!-- REQ-006, REQ-011 -->

A `CpuKey` is a 32-character (128-bit) hexadecimal string that is unique to one Xbox 360 console.
It is the per-console secret used to decrypt bootloaders and keyvault. In the domain a `CpuKey`
is either extracted from a NAND dump or entered/imported by the user. It must always pass format
validation (exactly 32 hex characters, case-insensitive) before it is stored or used; a CPU key
that fails this check is rejected with a clear error.

### KeyRecord  <!-- REQ-009, REQ-010, REQ-011, REQ-013 -->

A `KeyRecord` is one entry in the `KeyLibrary`: it pairs a validated `CpuKey` with a console
identity (serial number and/or `ConsoleType`) and optional user-supplied notes or labels. A
`KeyRecord` may be bound to a specific `NandImage` session (the "active dump") to indicate that
this key is the claimed key for that dump. Binding triggers a mismatch warning if the stored
console identity conflicts with the parsed `ConsoleInfo` from the dump.

### KeyLibrary  <!-- REQ-009, REQ-012, REQ-014 -->

The `KeyLibrary` is the persisted, named collection of all `KeyRecord`s the user has stored
across sessions. It is the only entity in the domain that survives between sessions by default.
It supports lookup/search by console serial, type, or label, and can be imported from and
exported to a documented file format for backup and transfer.

### BuildInputs  <!-- REQ-015, REQ-016 -->

`BuildInputs` is the set of parameters the user supplies to start a `BuildJob`: a reference to
the loaded `NandImage` (or a compatible source), the chosen `TimingFile`, the target output path
for the generated artifact, and the type of artifact to generate (ECC image or XeLL image).
`BuildInputs` is validated before a `BuildJob` is created; a `BuildJob` cannot start without
a structurally valid source and a selected `TimingFile`.

### TimingFile  <!-- REQ-016 -->

A `TimingFile` is a fixture-backed configuration file that specifies glitch-chip timing
parameters for RGH modding. The system ships a finite, deterministic set of timing files;
users select one from a managed list. The timing file name, description, and applicability
constraints (e.g. applicable `ConsoleType` or glitch type) are part of its domain identity.

### BuildJob  <!-- REQ-015, REQ-017, REQ-018, REQ-019, REQ-020 -->

A `BuildJob` is a record of one simulated image-generation or patch operation. It holds its
`BuildInputs`, a reference to the `BuildBackend` port it ran through, a lifecycle state
(Pending → Running → Succeeded / Failed), progress percentage, a streaming log of events, and
the `BuildArtifact` it produced on success. The same `BuildInputs` always yield the same
`BuildArtifact` checksum (determinism rule). A `BuildJob` never overwrites the source dump; its
output is always a new file at the user-specified path.

### BuildArtifact  <!-- REQ-017, REQ-018, REQ-019 -->

A `BuildArtifact` is the output of a completed `BuildJob`: an `EccFile` or an `XeLLImage`
written to a user-chosen output path. It carries the output file path, the artifact type,
a detected `SizeClass`, and a deterministic checksum (e.g. SHA-256 or CRC) that identifies
the output uniquely given the inputs.

### EccFile  <!-- REQ-017 -->

An `EccFile` is a `BuildArtifact` variant: a NAND image formatted with ECC interleaving
suitable for writing to a real flash chip. In this system it is always produced by the
simulator backend.

### XeLLImage  <!-- REQ-018 -->

A `XeLLImage` is a `BuildArtifact` variant: a recovery/XeLL boot image. Like `EccFile` it
is produced exclusively by the simulator backend in this system.

### BuildBackend  <!-- REQ-020, REQ-NFR-004 -->

`BuildBackend` is the domain boundary concept representing the port abstraction through which
all image-building and patching operations flow. The domain recognizes two implementations:
the `SimulatorBackend` (the only acting backend, deterministic) and the `RealBackend` (a
clearly-marked no-op stub that never produces real images). From the domain's perspective,
all `BuildJob`s talk to a `BuildBackend` and never directly to any file-system write path
or external tool.

### FlashOperation  <!-- REQ-021 -->

`FlashOperation` is an enumeration of the three operations the flashing workflow can perform:
Read (read the simulated NAND into an image), Write (write an image to the simulated NAND),
and Erase (erase the simulated NAND or a region of it). Each operation has a clearly
displayed description before the user confirms execution.

### FlashJob  <!-- REQ-021, REQ-022, REQ-023, REQ-024, REQ-027 -->

A `FlashJob` is a record of one simulated flash operation. It holds the selected
`FlashOperation`, the target `Programmer` (simulated device), the image being operated on
(for Write), a lifecycle state (Pending → Running → Verifying → Succeeded / Failed), progress
percentage, a live log, and the verify-after-write result. On failure the `FlashJob` carries
a set of `RecoveryStep`s. Like a `BuildJob`, a `FlashJob` always routes through the
`FlashBackend` port.

### FlashBackend  <!-- REQ-022, REQ-NFR-004 -->

`FlashBackend` is the domain boundary concept for the port abstraction through which all
flashing operations flow. It mirrors `BuildBackend`: the simulator is the only acting
implementation; the real hardware backend is a no-op stub. No code path reachable from
the domain model performs a real destructive write to physical hardware.

### Programmer  <!-- REQ-021, REQ-022 -->

A `Programmer` represents the simulated device (analogous to a physical NAND-X or J-Runner
programmer) that the `FlashBackend` communicates with. In the domain a `Programmer` has an
identifier (e.g. "SimulatedNAND-X"), a connection state, and a current-capacity consistent
with the `NandImage` `SizeClass` being operated on. There is always exactly one `Programmer`
instance active at a time during a `FlashJob`.

### RecoveryStep  <!-- REQ-024 -->

A `RecoveryStep` is one item in a recovery guidance sequence attached to a failed `FlashJob`.
It describes what state the console or dump is in after the failure, what the user can safely
do next, and what to avoid. Recovery steps are ordered and finite; they are fixture-backed and
not generated dynamically.

### TroubleshootingFlow  <!-- REQ-025, REQ-026 -->

A `TroubleshootingFlow` is a named, finite decision tree that guides the user through either
a setup workflow (ordered checklist for initial RGH/JTAG installation) or a repair workflow
(symptom-driven diagnostic). A flow is anchored to a `GlitchType` and optionally to a
`ConsoleType`. It is fixture-backed and finite; there is no open-ended expansion path.

### TroubleshootingStep  <!-- REQ-025, REQ-026 -->

A `TroubleshootingStep` is one node in a `TroubleshootingFlow`: it carries a prompt or
question, an explanation, the set of possible user responses (confirmation, symptom selection,
pass/fail), and the next-step transitions those responses trigger. The user moves through
steps by providing input; the system records which step was reached and what the user confirmed.

### GlitchType  <!-- REQ-025, REQ-026 -->

`GlitchType` is an enumeration of the glitch-chip modding techniques the domain covers:
RGH1, RGH2, RGH3, JTAG. Each `TroubleshootingFlow` is linked to one or more `GlitchType`
values, and which `GlitchType`s are applicable to a console depends on its `ConsoleType` and
bootloader versions.

### LogEntry  <!-- REQ-027, REQ-031, REQ-NFR-007 -->

A `LogEntry` is one structured, timestamped record in the `ActionLog`. It carries: a timestamp,
a severity level (Info / Warning / Error), an operation name, a human-readable message, and an
optional structured payload (e.g. path, checksum, error code). Log entries are immutable once
written.

### ActionLog  <!-- REQ-027, REQ-031, REQ-NFR-007 -->

The `ActionLog` is the ordered, append-only collection of `LogEntry` records for the current
session. It is the observable history of everything TwinRunner has done. The TUI displays it
in a live, scrollable view; it can be written to a log file. Within a session the `ActionLog`
is authoritative; it is not persisted by default across sessions (session boundary is an
open domain question — see DQ-001).

### Session  <!-- REQ-027, REQ-031, REQ-033 -->

A `Session` represents one run of the TwinRunner process. It holds a reference to the active
`NandImage` (if any has been loaded), the `ActionLog` for this run, any in-progress or
completed jobs, and the current `AppConfig`. A `Session` starts when the process launches and
ends when the process exits; stateful entities (the `KeyLibrary`) persist beyond session
boundaries via storage; the `ActionLog` and in-memory images do not.

### AppConfig  <!-- REQ-033 -->

`AppConfig` is the set of user-controllable configuration values: library storage path, default
output directory, active `BuildBackend` and `FlashBackend` selections, log verbosity level,
and any terminal/UI preferences. It is read from a config file and/or environment flags at
session start. Sane defaults allow the application to run without an explicit config file.

### ValidationIssue  <!-- REQ-002, REQ-007, REQ-NFR-003 -->

A `ValidationIssue` is a typed, named error produced during any validation step — dump structure
check, ECC integrity check, CPU-key format check, or build-input check. Each issue carries: a
severity (Error / Warning), an issue code (named enum variant), the specific field or region it
applies to, and a human-readable message with actionable guidance. An Error-severity
`ValidationIssue` blocks the dependent operation from proceeding.

### OperationResult  <!-- REQ-019, REQ-023, REQ-NFR-011 -->

An `OperationResult` is the terminal outcome of a `BuildJob` or `FlashJob`: either a Success
(with artifact reference or verify confirmation) or a Failure (with a typed error and
associated `RecoveryStep`s). It is immutable once the job reaches a terminal state. Progress
percentage and streaming log entries are separate from the result — they are emitted during
the Running state; the result is the final record.

---

## Relationships

- **Session → NandImage** (zero-or-one) — A session holds at most one active loaded dump at a
  time. Loading a new dump replaces the current one (the previous image is discarded from memory;
  the source file is untouched).

- **NandImage → FlashConfig** (one-to-one, derived) — Every loaded `NandImage` has exactly one
  `FlashConfig` parsed from it; absence of a recognizable `FlashConfig` makes the image
  structurally invalid.

- **NandImage → NandLayout** (one-to-one, resolved) — A validated `NandImage` resolves to
  exactly one `NandLayout` based on its `SizeClass` and `FlashConfig`; an unrecognized layout
  makes the image invalid.

- **NandImage → ConsoleInfo** (zero-or-one, derived) — A structurally valid, ECC-passing
  `NandImage` yields exactly one `ConsoleInfo`; an invalid or not-yet-validated image has none.

- **ConsoleInfo → BootloaderChain** (one-to-one) — Every `ConsoleInfo` includes exactly one
  `BootloaderChain`; the chain may contain between one and five `Bootloader` stages depending
  on `ConsoleType` and firmware.

- **BootloaderChain → Bootloader** (one-to-many, ordered) — A chain contains one or more
  `Bootloader` stages in a defined order (CB < CD < CE < CF < CG).

- **ConsoleInfo → FuseSet** (one-to-one, derived) — Every `ConsoleInfo` includes exactly one
  `FuseSet` parsed from the dump's fuse region.

- **ConsoleInfo → CpuKey** (zero-or-one, derived) — A `ConsoleInfo` optionally includes a
  `CpuKey` extracted from the dump; absence is an explicit reported state, not an error.

- **KeyLibrary → KeyRecord** (one-to-many) — The library contains zero or more `KeyRecord`s;
  each `KeyRecord` belongs to exactly one `KeyLibrary`.

- **KeyRecord → CpuKey** (one-to-one) — Each `KeyRecord` holds exactly one validated `CpuKey`.

- **KeyRecord → NandImage** (zero-or-one, optional binding) — A `KeyRecord` may be bound to
  the active session's loaded `NandImage`, indicating the user claims this key belongs to that
  dump. This binding is ephemeral (session-scoped) unless the user persists it in the record's
  notes.

- **BuildJob → BuildInputs** (one-to-one) — Every `BuildJob` is created from exactly one
  `BuildInputs` snapshot; inputs are captured at job creation and do not change once the job
  starts.

- **BuildInputs → NandImage** (one-to-one) — `BuildInputs` references the loaded `NandImage`
  that is the source for the build.

- **BuildInputs → TimingFile** (one-to-one) — `BuildInputs` references exactly one selected
  `TimingFile`.

- **BuildJob → BuildBackend** (one-to-one) — Every `BuildJob` runs through exactly one
  `BuildBackend` instance (simulator or no-op stub).

- **BuildJob → BuildArtifact** (zero-or-one) — A `BuildJob` that succeeds produces exactly one
  `BuildArtifact`; a failed job produces none.

- **FlashJob → FlashOperation** (one-to-one) — Every `FlashJob` is associated with exactly one
  `FlashOperation` (Read / Write / Erase).

- **FlashJob → Programmer** (one-to-one) — Every `FlashJob` targets exactly one `Programmer`
  (the simulated device).

- **FlashJob → FlashBackend** (one-to-one) — Every `FlashJob` runs through exactly one
  `FlashBackend` instance.

- **FlashJob → RecoveryStep** (zero-to-many, ordered) — A failed `FlashJob` carries an ordered
  list of `RecoveryStep`s; a succeeded job carries none.

- **TroubleshootingFlow → TroubleshootingStep** (one-to-many, directed graph) — A flow contains
  one or more steps connected as a finite directed graph (with a designated start step and one or
  more terminal steps).

- **TroubleshootingFlow → GlitchType** (many-to-many) — A single flow may apply to more than
  one `GlitchType`; a given `GlitchType` may be covered by more than one flow (e.g. setup flow
  vs. repair flow for RGH2).

- **TroubleshootingFlow → ConsoleType** (zero-or-one, optional filter) — A flow may be scoped
  to a specific `ConsoleType`; if scoped, it is only offered when the active `ConsoleInfo`
  matches.

- **Session → ActionLog** (one-to-one) — Each session has exactly one `ActionLog` that grows
  throughout the session lifetime.

- **ActionLog → LogEntry** (one-to-many, ordered, append-only) — An `ActionLog` holds an
  ordered sequence of `LogEntry` records; entries are never removed or edited.

- **Session → AppConfig** (one-to-one) — Each session loads exactly one `AppConfig` at startup.

---

## Attributes

### NandImage

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| source_path | File path string | Required; read-only reference; file on disk is never written |
| size_class | SizeClass enum (16/64/256/512 MB) | Required; detected on load; reject if not recognized |
| raw_bytes | Binary blob | In-memory only; loaded from file; never written back to source |
| validation_status | ValidationStatus enum | Initial = Unvalidated; transitions via state model |
| loaded_at | Timestamp | Session-scoped; set when file is opened |

### FlashConfig

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| raw_value | u32 hex | Parsed from known offset; required for valid image |
| ecc_type | EccType enum | Derived from raw_value; must match NandLayout |
| page_size | u16 bytes | Derived from raw_value |

### ConsoleInfo

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| console_type | ConsoleType enum | Required; Xenon/Zephyr/Falcon/Jasper/Trinity/Corona |
| serial | String or Absent | Optional; "Absent" is explicit, not null |
| ecc_type | EccType enum | Required; derived from FlashConfig |
| cpu_key | CpuKey or Absent | Optional; "Absent" is explicit; never guessed |
| bootloader_chain | BootloaderChain | Required; at least CB must be present |
| fuse_set | FuseSet | Required |

### ConsoleType (enum values)

| Value | Board Generation |
|---|---|
| Xenon | Original Xbox 360 (2005) |
| Zephyr | 2007 revision, HDMI added |
| Falcon | 2007 die-shrink |
| Jasper | 2008 65nm, smaller NAND |
| Trinity | 2010 slim |
| Corona | 2011 slim revision |

### SizeClass (enum values)

| Value | Bytes |
|---|---|
| MB16 | 16,777,216 |
| MB64 | 67,108,864 |
| MB256 | 268,435,456 |
| MB512 | 536,870,912 |

### Bootloader

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| stage | BootloaderStage enum (CB/CD/CE/CF/CG) | Required |
| version | String (e.g. "17559") | Required if present; "Absent" if stage not in dump |
| present | Boolean | True if stage exists in the dump |

### FuseSet

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| fuse_lines | Vec of hex strings | One entry per fuse line parsed; may be empty if unreadable |
| security_state | String descriptor | Derived human-readable summary of fuse state |
| raw_region | Binary blob | Raw fuse region bytes for reference |

### CpuKey

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| value | 32-char hex string | Exactly 32 hex chars [0-9a-fA-F]; case-insensitive; required |
| format_valid | Boolean | Must be true before storage or use; false = rejected |

### KeyRecord

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| id | UUID string | System-generated; unique; immutable |
| cpu_key | CpuKey | Required; must be format-valid |
| console_serial | String or Absent | Optional; used for identity matching |
| console_type | ConsoleType or Unknown | Optional; used for mismatch warning |
| label | String | Optional; user-supplied short name |
| notes | String | Optional; user-supplied freeform text |
| created_at | Timestamp | Set on creation; immutable |
| updated_at | Timestamp | Updated on any field edit |

### KeyLibrary

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| storage_path | File path string | Configured via AppConfig; required |
| records | Vec<KeyRecord> | Zero or more; ordered by created_at descending by default |
| format_version | String (semver) | Library file format version; used for import compatibility |

### TimingFile

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| id | String slug | Unique across the shipped set; immutable |
| name | String | Human-readable name |
| description | String | Purpose and applicable hardware |
| applicable_console_types | Vec<ConsoleType> | Empty = applicable to all |
| applicable_glitch_types | Vec<GlitchType> | Empty = applicable to all |
| content | Binary or structured data | Fixture-backed; bundled with the binary |

### BuildInputs

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| source_image_path | File path string | Must reference a validated NandImage; read-only |
| timing_file_id | String slug | Must reference a known TimingFile |
| output_path | File path string | User-chosen; must not equal source_image_path |
| artifact_type | ArtifactType enum (EccFile/XeLLImage) | Required |

### BuildJob

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| id | UUID string | System-generated; unique; immutable |
| inputs | BuildInputs | Snapshot captured at creation; immutable |
| backend_kind | BackendKind enum (Simulator/RealStub) | Required; defaults to Simulator |
| state | BuildJobState enum | Lifecycle state; see state model |
| progress_pct | u8 (0–100) | Updated during Running state |
| log_entries | Vec<LogEntry> | Append-only during execution |
| artifact | BuildArtifact or Absent | Set on Succeeded; absent otherwise |
| started_at | Timestamp or Absent | Set when Running begins |
| completed_at | Timestamp or Absent | Set when terminal state is reached |

### BuildArtifact

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| output_path | File path string | Written by simulator; never source_image_path |
| artifact_type | ArtifactType enum | EccFile or XeLLImage |
| size_class | SizeClass enum | Detected on output |
| checksum | SHA-256 hex string | Deterministic; same inputs → same checksum |

### FlashJob

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| id | UUID string | System-generated; unique; immutable |
| operation | FlashOperation enum (Read/Write/Erase) | Required |
| programmer_id | String | Identifier of the Programmer being targeted |
| image_path | File path or Absent | Required for Write; absent for Read/Erase |
| backend_kind | BackendKind enum | Required; defaults to Simulator |
| state | FlashJobState enum | Lifecycle state; see state model |
| progress_pct | u8 (0–100) | Updated during Running/Verifying states |
| log_entries | Vec<LogEntry> | Append-only during execution |
| verify_result | VerifyResult or Absent | Set after Verifying state; absent if not Write |
| recovery_steps | Vec<RecoveryStep> | Non-empty only on Failed state |
| started_at | Timestamp or Absent | |
| completed_at | Timestamp or Absent | |

### Programmer

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| id | String | E.g. "SimulatedNAND-X"; unique |
| connection_state | ConnectionState enum (Connected/Disconnected) | |
| capacity | SizeClass enum | Must match the NandImage SizeClass for Write |

### TroubleshootingFlow

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| id | String slug | Unique; fixture-backed |
| name | String | Human-readable title |
| flow_type | FlowType enum (Setup/Repair) | Required |
| glitch_types | Vec<GlitchType> | At least one |
| applicable_console_types | Vec<ConsoleType> | Empty = all; scoped when non-empty |
| start_step_id | String | ID of the first TroubleshootingStep |
| steps | Map<String, TroubleshootingStep> | Keyed by step ID; finite |

### TroubleshootingStep

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| id | String | Unique within the flow |
| prompt | String | The question or instruction shown to the user |
| explanation | String | Additional context/guidance text |
| responses | Vec<StepResponse> | At least one; defines transitions |
| is_terminal | Boolean | True if no further steps follow |

### GlitchType (enum values)

| Value | Meaning |
|---|---|
| RGH1 | Reset Glitch Hack v1 (older boards) |
| RGH2 | Reset Glitch Hack v2 (post-2011) |
| RGH3 | Reset Glitch Hack v3 (modern variant) |
| JTAG | JTAG unlock (Xenon/Zephyr only) |

### LogEntry

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| timestamp | ISO 8601 datetime | Set at emission; immutable |
| level | LogLevel enum (Info/Warning/Error) | Required |
| operation | String | Name of the operation emitting the entry |
| message | String | Human-readable; required |
| payload | Structured map or Absent | Optional key-value context (path, code, etc.) |

### AppConfig

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| library_path | File path string | Default: platform-appropriate data dir |
| output_dir | File path string | Default: current working directory |
| build_backend | BackendKind enum | Default: Simulator |
| flash_backend | BackendKind enum | Default: Simulator |
| log_verbosity | LogLevel enum | Default: Info |
| log_file_path | File path or Absent | Optional; absent = no file logging |

### ValidationIssue

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| severity | IssueSeverity enum (Error/Warning) | Required |
| issue_code | ValidationCode enum | Named variant; required |
| target | String | Field name, region name, or path it applies to |
| message | String | Human-readable actionable description |

---

## State Models

### NandImage Validation Lifecycle

A loaded `NandImage` moves through validation states as checks are applied. Extraction only
proceeds from the `Validated` state.

| State | Meaning | Transitions to | Trigger |
|---|---|---|---|
| Unvalidated | Image loaded into memory; no checks run yet | Validating | User or system initiates validation |
| Validating | Structure and ECC checks in progress | Validated, Invalid | Checks complete |
| Validated | All structure + ECC checks passed; ConsoleInfo can be extracted | Extracted | User requests extraction |
| Invalid | One or more Error-severity ValidationIssues found; extraction blocked | Unvalidated | User loads a replacement image |
| Extracted | ConsoleInfo has been derived and is available for display and operations | — (terminal in session) | |

### KeyRecord Lifecycle

| State | Meaning | Transitions to | Trigger |
|---|---|---|---|
| Unverified | Record added with a CPU key that has not yet passed format check | ValidatedFormat | System validates key format on entry |
| ValidatedFormat | CPU key format is confirmed (32 hex chars); record is stored | BoundToDump, ValidatedFormat (edit re-check) | User binds to active dump, or user edits and re-checks |
| BoundToDump | Record is associated with the active session's NandImage | ValidatedFormat | User unbinds, or session ends |

### BuildJob Lifecycle

| State | Meaning | Transitions to | Trigger |
|---|---|---|---|
| Pending | Job created; inputs validated; not yet started | Running | User confirms start |
| Running | Backend is executing; progress 0→100% | Succeeded, Failed | Backend completes or errors |
| Succeeded | BuildArtifact produced; checksum available | — (terminal) | |
| Failed | Operation errored; no artifact produced | Pending (retry with new inputs) | User may create a new BuildJob |

### FlashJob Lifecycle

| State | Meaning | Transitions to | Trigger |
|---|---|---|---|
| Pending | Job created; operation/target shown; awaiting confirmation | Running | User confirms |
| Running | Backend executing the operation; progress 0→100% | Verifying (Write), Succeeded (Read/Erase), Failed | Operation completes or errors |
| Verifying | Write completed; verify-after-write in progress | Succeeded, Failed | Verify check completes |
| Succeeded | Operation confirmed complete; verify passed (if Write) | — (terminal) | |
| Failed | Operation errored or verify failed; RecoverySteps populated | — (terminal; user creates new job to retry) | |

### TroubleshootingFlow Session Lifecycle

| State | Meaning | Transitions to | Trigger |
|---|---|---|---|
| NotStarted | Flow selected but not yet begun | AtStep | User confirms start |
| AtStep | User is viewing and responding to a specific TroubleshootingStep | AtStep, Completed, Abandoned | User provides a response |
| Completed | Flow reached a terminal step | — (terminal) | |
| Abandoned | User exited the flow before completion | — (terminal in this run) | User navigates away |

---

## Domain Rules

- **RULE-001** — A source `NandImage` file is never written, modified, or deleted by any
  operation. All build, flash, and export operations write to new user-chosen output paths.
  A `BuildInputs.output_path` must never equal the `NandImage.source_path`.
  — REQ-035, REQ-NFR-003. ⚠ *blast-radius: data integrity*

- **RULE-002** — A `NandImage` must be in the `Validated` state before `ConsoleInfo` can be
  extracted from it. Any operation that depends on `ConsoleInfo` (key binding, build setup,
  troubleshooting flow launch) must check this precondition and surface a clear error if not met.
  — REQ-002, REQ-007, REQ-NFR-003. ⚠ *blast-radius: data integrity*

- **RULE-003** — An `Invalid` or `Unvalidated` `NandImage` must never be silently advanced to
  `Extracted`. If ECC checks fail for any region, the dump is marked `Invalid` and the specific
  failing region is reported.
  — REQ-007, REQ-NFR-003. ⚠ *blast-radius: data integrity*

- **RULE-004** — A `CpuKey` must pass format validation (exactly 32 hexadecimal characters)
  before it is stored in a `KeyRecord` or used in any operation. A key that fails this check
  is rejected with a clear error; the record is not created or updated.
  — REQ-011, REQ-NFR-003.

- **RULE-005** — When a `KeyRecord` is bound to the active session's `NandImage`, the system
  must compare the `KeyRecord.console_type` and `KeyRecord.console_serial` (where present)
  against the loaded `ConsoleInfo`. A mismatch must produce a visible warning before the
  binding is accepted. The binding is not silently accepted without the warning being surfaced.
  — REQ-013.

- **RULE-006** — Every `BuildJob` and `FlashJob` must route exclusively through the appropriate
  backend port (`BuildBackend` or `FlashBackend`). No operation may bypass the port abstraction
  to call a file-system or hardware API directly. The `RealStub` backend variant must never
  produce real output images or perform real hardware writes; it is a no-op stub.
  — REQ-020, REQ-022, REQ-NFR-004. ⚠ *blast-radius: safety (hardware write prevention)*

- **RULE-007** — Given identical `BuildInputs` (same source image bytes, same `TimingFile`,
  same `ArtifactType`), a `BuildJob` run through the `SimulatorBackend` must always produce a
  `BuildArtifact` with the same checksum. Determinism is a testable invariant.
  — REQ-019, REQ-NFR-005.

- **RULE-008** — Given the same `FlashOperation` and the same input (same image bytes for
  Write), a `FlashJob` run through the `SimulatorBackend` must always produce the same
  progress sequence, verify result, and final log. Determinism is a testable invariant.
  — REQ-023, REQ-NFR-005.

- **RULE-009** — A `NandImage` file whose byte length does not exactly match one of the four
  recognized `SizeClass` values (16 MB, 64 MB, 256 MB, 512 MB) must be rejected immediately
  on load with a clear error. Validation does not proceed for unrecognized sizes.
  — REQ-001.

- **RULE-010** — When the `ConsoleInfo` cannot derive a `CpuKey` from the loaded dump, the
  system must explicitly report the key as absent rather than returning a default or empty
  value. No downstream operation may treat an absent key as a valid key.
  — REQ-006, REQ-NFR-003.

- **RULE-011** — `LogEntry` records are append-only and immutable. Once written to the
  `ActionLog`, an entry cannot be edited, removed, or reordered. The `ActionLog` is the
  authoritative record of session activity.
  — REQ-027, REQ-NFR-007.

- **RULE-012** — A `BuildJob` cannot be started unless its `BuildInputs` reference a `NandImage`
  in the `Validated` or `Extracted` state and a known `TimingFile`. A `FlashJob` Write
  operation cannot be started without a valid image path. Both must show the operation
  parameters clearly to the user before execution is confirmed.
  — REQ-015, REQ-021, REQ-NFR-003.

- **RULE-013** — The `TroubleshootingFlow` tree is finite and fixture-backed. There are no
  dynamically generated steps or unbounded expansions. Every `TroubleshootingStep` in a flow
  must be reachable from the flow's `start_step_id`, and every non-terminal step must have at
  least one response that leads to another step or a terminal step.
  — REQ-026.

- **RULE-014** — A `KeyRecord` may only be stored in the `ValidatedFormat` state. The system
  must not persist a `KeyRecord` whose `CpuKey` has not passed format validation in the current
  write operation.
  — REQ-011.

---

## Domain Events

| Event | Emitted by | REQ-ID | Meaning |
|---|---|---|---|
| DumpLoaded | NandImage | REQ-001 | A NAND dump file was successfully opened and its SizeClass recognized; validation not yet run |
| DumpLoadFailed | Session | REQ-001 | A file could not be opened or its size was not a recognized SizeClass |
| ValidationStarted | NandImage | REQ-002 | Structure and ECC validation has begun for the loaded dump |
| ValidationPassed | NandImage | REQ-002, REQ-007 | All structure and ECC checks passed; image is now Validated |
| ValidationFailed | NandImage | REQ-002, REQ-007 | One or more Error-severity ValidationIssues found; image is Invalid; failing regions reported |
| ConsoleInfoExtracted | ConsoleInfo | REQ-003, REQ-004, REQ-005, REQ-006 | ConsoleInfo (type, serial, bootloaders, fuses, CPU key or absent) has been derived from a Validated image |
| CpuKeyAbsent | ConsoleInfo | REQ-006 | CPU key could not be derived from the dump; explicitly reported as absent |
| ConsoleInfoExported | Session | REQ-008 | ConsoleInfo has been written to a text/JSON file at a user-chosen path |
| KeyRecordCreated | KeyLibrary | REQ-009, REQ-010 | A new KeyRecord with a validated CpuKey was added to the library and persisted |
| KeyRecordUpdated | KeyLibrary | REQ-010 | An existing KeyRecord's fields (label, notes, or key) were edited and persisted |
| KeyRecordDeleted | KeyLibrary | REQ-010 | A KeyRecord was removed from the library after user confirmation |
| KeyImportCompleted | KeyLibrary | REQ-014 | One or more KeyRecords were imported from a file; counts of imported/skipped reported |
| KeyExportCompleted | KeyLibrary | REQ-014 | The library (or a subset) was exported to a file |
| KeyBoundToDump | KeyRecord | REQ-013 | A KeyRecord was bound to the active session's NandImage |
| KeyBindingMismatchWarned | KeyRecord | REQ-013 | A mismatch between KeyRecord console identity and loaded ConsoleInfo was detected and surfaced |
| BuildJobCreated | BuildJob | REQ-015 | A BuildJob was created with validated BuildInputs; awaiting user confirmation |
| BuildStarted | BuildJob | REQ-019 | A BuildJob moved to Running; progress begins at 0% |
| BuildProgressed | BuildJob | REQ-019 | Progress percentage updated during a Running BuildJob |
| BuildCompleted | BuildJob | REQ-019 | BuildJob reached Succeeded; BuildArtifact with checksum is available |
| BuildFailed | BuildJob | REQ-019 | BuildJob reached Failed; error and reason reported |
| FlashJobCreated | FlashJob | REQ-021 | A FlashJob was created; operation and target shown to user before confirmation |
| FlashStarted | FlashJob | REQ-023 | A FlashJob moved to Running; progress begins at 0% |
| FlashProgressed | FlashJob | REQ-023 | Progress percentage updated during a Running FlashJob |
| FlashVerifying | FlashJob | REQ-023 | Write operation complete; verify-after-write step beginning |
| FlashVerified | FlashJob | REQ-023 | Verify-after-write passed; FlashJob moving to Succeeded |
| FlashCompleted | FlashJob | REQ-023 | FlashJob reached Succeeded |
| FlashFailed | FlashJob | REQ-024 | FlashJob reached Failed; RecoverySteps populated and surfaced to user |
| RecoverySuggested | FlashJob | REQ-024 | RecoverySteps are being presented to the user following a FlashFailed event |
| TroubleshootingFlowStarted | TroubleshootingFlow | REQ-025, REQ-026 | A TroubleshootingFlow moved from NotStarted to AtStep (first step presented) |
| TroubleshootingStepAdvanced | TroubleshootingFlow | REQ-025, REQ-026 | User responded to a TroubleshootingStep; flow moved to the next step |
| TroubleshootingFlowCompleted | TroubleshootingFlow | REQ-025, REQ-026 | Flow reached a terminal step; guidance complete |
| TroubleshootingFlowAbandoned | TroubleshootingFlow | REQ-026 | User exited the flow before reaching a terminal step |
| LogEntryWritten | ActionLog | REQ-027, REQ-031 | A structured LogEntry was appended to the ActionLog; visible in the live log view |
| SessionStarted | Session | REQ-033 | TwinRunner process launched; AppConfig loaded; Session initialized |
| SessionEnded | Session | REQ-033 | TwinRunner process exiting; in-memory state discarded; KeyLibrary already persisted |

---

## Glossary

| Term | Definition |
|---|---|
| NAND | The type of flash memory used in the Xbox 360 to store firmware, bootloaders, keyvault, and user data. "NAND dump" means a byte-for-byte copy of the chip's contents saved as a file. |
| Dump / NandImage | A binary file containing the raw contents of an Xbox 360 NAND chip. The terms are used interchangeably; the domain entity is `NandImage`. |
| SizeClass | One of four recognized dump sizes (16 MB, 64 MB, 256 MB, 512 MB). Files not matching these are invalid. |
| FlashConfig | A header block at a known offset in the NAND that describes the flash chip geometry (ECC mode, page size). Its presence and integrity are the first structure-validation gate. |
| ECC | Error-Correcting Code. Xbox 360 NAND chips use ECC in spare-area bytes. The domain validates ECC integrity per region; a failed region marks the image Invalid. |
| NandLayout | The structural map of a NAND image: where regions, bootloaders, and user data live. Determined by SizeClass + FlashConfig. |
| ConsoleType | The Xbox 360 motherboard generation: Xenon, Zephyr, Falcon, Jasper, Trinity, Corona. Drives layout, glitch applicability, and timing file selection. |
| ConsoleInfo | The full set of facts derived by parsing a validated NAND dump: ConsoleType, serial, ECC type, BootloaderChain, FuseSet, CpuKey (or absent notice). |
| BootloaderChain | The ordered sequence of bootloader stages (CB, CD, CE, CF, CG) embedded in a NAND. Not all stages appear in every dump. |
| CB / CD / CE / CF / CG | The five named bootloader stages in the Xbox 360 boot chain. Each has a version number. CB is the primary boot code; later stages are loaded sequentially. |
| FuseSet | The fuse lines in the Xbox 360 SoC that record the console's security state and CB version history. Extracted as read-only facts from the dump. |
| CpuKey | A 128-bit (32 hex char) per-console secret key used to decrypt bootloaders and keyvault. Unique to each console. Never shared or transmitted by this tool. |
| KeyRecord | One entry in the KeyLibrary: a validated CpuKey paired with a console identity (serial/type) and optional user notes. |
| KeyLibrary | The user's persistent, searchable collection of KeyRecords across sessions. |
| TimingFile | A fixture-backed configuration file specifying glitch-chip timing parameters. Ships as part of the example binary; user selects one per build job. |
| BuildJob | A record of one simulated image-generation or patch operation (EccFile or XeLLImage). Always routes through BuildBackend. |
| BuildArtifact | The output of a succeeded BuildJob: a new file (EccFile or XeLLImage) at a user-chosen path, with a deterministic checksum. |
| EccFile | A BuildArtifact variant: a NAND image with ECC formatting applied, suitable for writing to a flash chip. Produced by the simulator only in this example. |
| XeLLImage | A BuildArtifact variant: a XeLL (Xbox Linux Loader) recovery/boot image. Produced by the simulator only in this example. |
| BuildBackend | The port abstraction through which all image-building flows. The SimulatorBackend is the only acting implementation; the RealBackend is a no-op stub. |
| FlashJob | A record of one simulated flash operation (Read / Write / Erase) against a Programmer. Always routes through FlashBackend. |
| FlashOperation | The operation a FlashJob performs: Read, Write, or Erase. |
| FlashBackend | The port abstraction through which all flashing operations flow. Same simulator/stub split as BuildBackend. |
| Programmer | The simulated device (analogous to NAND-X hardware) that FlashBackend communicates with. |
| Verify-after-write | The step following a simulated Write FlashJob that confirms the written data matches the intended image. |
| RGH | Reset Glitch Hack. A technique to exploit a timing vulnerability in the Xbox 360 boot process by glitching the CPU reset line. Variants: RGH1, RGH2, RGH3. |
| JTAG | Joint Test Action Group. An older Xbox 360 exploit applicable only to early boards (Xenon, Zephyr) that bypasses boot security via the debug interface. |
| GlitchType | Enumeration of the supported mod/exploit techniques: RGH1, RGH2, RGH3, JTAG. |
| TroubleshootingFlow | A finite, fixture-backed decision tree guiding the user through RGH/JTAG setup or repair. Anchored to a GlitchType and optionally a ConsoleType. |
| TroubleshootingStep | One node in a TroubleshootingFlow: a prompt, explanation, and set of responses that advance the flow. |
| SimulatorBackend | The only actively executing backend in this example. Deterministic: same inputs always produce same outputs. Never performs real hardware writes. |
| RealStub / RealBackend | A clearly-marked no-op implementation of BuildBackend or FlashBackend that represents where real hardware/xeBuild integration would go. Never produces real output in this example. |
| ActionLog | The append-only, ordered log of LogEntry records for the current session. Displayed in the live log view; optionally written to a file. |
| LogEntry | One structured, timestamped record in the ActionLog: level, operation, message, optional payload. Immutable once written. |
| Session | One run of the TwinRunner process. Holds the active NandImage, ActionLog, in-flight jobs, and AppConfig. Non-persistent across process restarts (except KeyLibrary). |
| AppConfig | User-controllable configuration: library path, output directory, backend selections, log verbosity. Read from file/environment at session start. |
| ValidationIssue | A typed, named error or warning produced during any validation step. Error-severity issues block dependent operations. |
| OperationResult | The terminal outcome record of a BuildJob or FlashJob: Success (with artifact/verify) or Failure (with error and RecoverySteps). |
| Determinism | The invariant that identical inputs always yield identical outputs, progress sequences, and checksums. A core testability guarantee. |
| Port abstraction | The Rust trait/interface pattern used to separate the domain from infrastructure. BuildBackend and FlashBackend are ports; the simulator and real stub are adapters. |
| Copy-only | The domain policy that the system never mutates source files in place; all output goes to new user-chosen paths. |

---

## Open Domain Questions

- **DQ-001** *(non-blocking)* — Should the `ActionLog` be optionally persisted across sessions
  (e.g. appended to a rolling log file by default) in addition to the optional file-write
  feature? The current model treats the in-memory `ActionLog` as session-scoped but allows
  opt-in file logging via `AppConfig.log_file_path`. Assumed default: log file is opt-in;
  no automatic cross-session persistence in the domain model. If the architecture wants
  a persistent log, this entity gains a `persisted` flag and cross-session query capability.

- **DQ-002** *(non-blocking)* — Can a `Session` hold more than one `NandImage` simultaneously
  (e.g. a "source dump" and a "comparison dump" side by side) or is one active dump at a time
  the correct model? The current model allows at most one active `NandImage` per session.
  Assumed default: one active dump at a time; multi-dump comparison is out of scope for MVP.

- **DQ-003** *(non-blocking)* — Should `BuildJob` and `FlashJob` be persisted across sessions
  (a job history the user can review in a future session) or are they in-memory-only? The current
  model treats completed jobs as session-scoped; the `ActionLog` (optionally file-backed) is the
  persistence mechanism for what was done. Assumed default: jobs are in-memory only per session;
  the log file is the durable record.

- **DQ-004** *(non-blocking)* — The `KeyRecord.BoundToDump` state is session-scoped in the
  current model (the binding is not persisted to the library file unless the user explicitly
  notes it). Should binding be persistable — e.g. the library record records the last dump's
  SHA hash for future mismatch detection? Assumed default: binding is session-scoped and
  ephemeral; architecture may choose to add a `last_bound_dump_hash` field to `KeyRecord`
  for cross-session mismatch detection without changing the core domain model.

- **DQ-005** *(non-blocking)* — Should the `TroubleshootingFlow` surface the active
  `ConsoleInfo` (e.g. pre-filtering flows to only those applicable to the detected
  `ConsoleType`) or always show all flows and let the user select? Assumed default: the TUI
  may pre-filter the flow list using `TroubleshootingFlow.applicable_console_types` when a
  validated dump is loaded, but all flows remain accessible if no dump is loaded or if the
  user explicitly browses.
