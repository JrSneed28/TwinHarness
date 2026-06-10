# Contracts — TwinRunner

> **Stage 7 — Contracts** (spec §15.7). Tiers T2, T3. Streams; surfaces product-affecting
> choices as explicit human decisions (§8). Derives contracts from `04-architecture.md` and
> `03-domain-model.md`; anchors every contract to the REQ-IDs and capability areas that depend
> on it (§11). Each contract is a testable boundary — the test strategy (Stage 8) maps tests
> to these definitions.

## Summary

TwinRunner is a **single-binary, filesystem-only, single-user local application** — there is no
HTTP API, no network, and no authentication or authorization system. The 18 interfaces defined
here are **module/trait boundaries within the Rust workspace** that let independently-built slices
integrate without surprise, plus **6 persisted/exported file schemas** that represent the only
external-filesystem-crossing contracts. The integration pattern is **in-process module contracts
plus one background-thread channel protocol** (`std::sync::mpsc`, one-way typed envelopes).

The two most structurally important boundaries are (1) the **Worker channel protocol** (the typed
`WorkerCommand` / `WorkerEvent` envelopes that cross the render-thread / background-thread
boundary — ADR-002) and (2) the **`BuildBackend` / `FlashBackend` trait ports** that gate every
simulated operation so no real hardware path is reachable (ADR-004). All other interfaces are
Rust module function signatures. The `model::update` reducer is the central orchestration seam;
every screen talks to it and it dispatches to all other modules.

**No authentication or authorization mechanism exists in TwinRunner.** It is a single-user
local tool with no network surface and no multi-user access model. This is an explicit, confirmed
non-feature. There is therefore no auth human gate.

- **Interfaces defined:** 18 module/trait contracts + 6 persisted/exported file schemas = 24 total boundary definitions.
- **Integration pattern:** In-process Rust module APIs + one background-thread mpsc channel protocol + local-filesystem schemas.
- **Auth scheme:** None — single local user, no network, no multi-user access. Confirmed non-feature.
- **Versioning strategy:** All persisted file schemas carry a `schema_version: u32` integer field. Additive-only changes (adding optional fields) do not increment the version. Adding a required field or removing/renaming a field is a breaking change and increments `schema_version`. The loader rejects files whose `schema_version` exceeds the version it understands.
- **Persisted-format default:** JSON (via `serde_json`) for all persisted/exported schemas. The `AppConfig` file uses TOML for human-editability; all other schemas (KeyLibrary, key export, ConsoleInfo export, log file) use JSON with a top-level `schema_version: u32` field.

---

## Interface Index

| ID | Name | Type | Owner component | Consumer(s) | REQ-IDs | Capability area |
|---|---|---|---|---|---|---|
| IF-001 | `nand::load` | Module function | `twinrunner-core::nand` | `twinrunner-core::model`, `twinrunner::tui` | REQ-001, REQ-035 | A |
| IF-002 | `nand::validate` | Module function | `twinrunner-core::nand` | `twinrunner-core::model` | REQ-002, REQ-007 | A |
| IF-003 | `nand::extract` | Module function | `twinrunner-core::nand` | `twinrunner-core::model` | REQ-003, REQ-004, REQ-005, REQ-006, REQ-008 | A |
| IF-004 | `keys::CpuKey::parse` | Module function | `twinrunner-core::keys` | `twinrunner-core::model`, `twinrunner-core::nand` | REQ-011 | B |
| IF-005 | `keys::KeyLibrary::load` / `save` | Module function | `twinrunner-core::keys` | `twinrunner-core::model` | REQ-009, REQ-012 | B |
| IF-006 | `keys::KeyLibrary::add` / `edit` / `delete` / `search` | Module function | `twinrunner-core::keys` | `twinrunner-core::model` | REQ-009, REQ-010, REQ-013 | B |
| IF-007 | `keys::bind` | Module function | `twinrunner-core::keys` | `twinrunner-core::model` | REQ-011, REQ-013 | B |
| IF-008 | `keys::import` / `export` | Module function | `twinrunner-core::keys` | `twinrunner-core::model` | REQ-014 | B |
| IF-009 | `BuildBackend` trait port | Rust trait | `twinrunner-core::build` | `twinrunner::worker` | REQ-015, REQ-016, REQ-017, REQ-018, REQ-019, REQ-020, REQ-NFR-004 | C |
| IF-010 | `BuildJob::step` | Steppable job method | `twinrunner-core::build` | `twinrunner::worker` | REQ-019, REQ-NFR-005 | C |
| IF-011 | `FlashBackend` trait port | Rust trait | `twinrunner-core::flash` | `twinrunner::worker` | REQ-021, REQ-022, REQ-023, REQ-024, REQ-NFR-004 | D |
| IF-012 | `FlashJob::step` | Steppable job method | `twinrunner-core::flash` | `twinrunner::worker` | REQ-023, REQ-024, REQ-NFR-005 | D |
| IF-013 | `worker::spawn` + `WorkerCommand` channel | Channel + thread | `twinrunner::worker` | `twinrunner::tui`, `twinrunner-core::model` | REQ-019, REQ-023, REQ-NFR-001, REQ-NFR-011 | C, D |
| IF-014 | `WorkerEvent` channel (worker → UI) | Channel (mpsc) | `twinrunner::worker` | `twinrunner::tui` | REQ-019, REQ-023, REQ-NFR-001, REQ-NFR-011 | C, D |
| IF-015 | `model::update` reducer | Module function | `twinrunner-core::model` | `twinrunner::tui` | REQ-NFR-006, REQ-NFR-011, all functional REQs | Shell |
| IF-016 | `troubleshoot` flow stepper | Module function | `twinrunner-core::troubleshoot` | `twinrunner-core::model` | REQ-025, REQ-026 | D |
| IF-017 | `log::ActionLog::append` | Module function | `twinrunner-core::log` | `twinrunner-core::model`, `twinrunner::worker` | REQ-027, REQ-031, REQ-NFR-007 | Shell |
| IF-018 | `clock::Clock` trait | Rust trait | `twinrunner-core::clock` | `twinrunner-core::build`, `twinrunner-core::flash`, `twinrunner-core::log` | REQ-NFR-005 | Shell |
| FS-001 | KeyLibrary file schema | JSON file | `twinrunner-core::keys` | `keys` (self, on load) | REQ-009, REQ-012, REQ-014 | B |
| FS-002 | Key import/export file schema | JSON file | `twinrunner-core::keys` | User, `keys` (on import) | REQ-014 | B |
| FS-003 | ConsoleInfo export schema | JSON or text file | `twinrunner-core::nand` | User | REQ-008 | A |
| FS-004 | AppConfig file schema | TOML file | `twinrunner-core::config` | `config` (self, on load) | REQ-033 | Shell |
| FS-005 | Log file schema | JSON Lines file | `twinrunner-core::log` | User, external tools | REQ-027, REQ-NFR-007 | Shell |
| FS-006 | BuildArtifact / output image file | Binary file | `twinrunner-core::build` | User, `flash` | REQ-015, REQ-017, REQ-018 | C |

---

## API / Module Contracts

### IF-001 — `nand::load`

**Type:** Module function
**Owner:** `twinrunner-core::nand`
**Consumers:** `twinrunner-core::model` (via `Command::ReadDump`), `twinrunner::tui` (triggers load via Message)
**Realizes:** REQ-001, REQ-035
**Required by capability areas:** A

#### Input

```
path: String [required] — valid UTF-8 filesystem path; non-empty
```

#### Output (success)

```
NandImage {
  source_path:       String        [required] — canonical filesystem path; read-only reference
  size_class:        SizeClass     [required] — one of { MB16, MB64, MB256, MB512 }
  raw_bytes:         Vec<u8>       [required] — full file contents; in-memory only
  validation_status: ValidationStatus [required] — exactly Unvalidated on success
  loaded_at:         Timestamp     [required] — injected from Clock::now()
}
```

**Preconditions:** The filesystem path exists and the process has read permission.
**Postconditions:** File is closed (not held open); source file is unmodified; `validation_status = Unvalidated`.
**Side effects:** Emits `DumpLoaded` domain event into the caller's event stream on success; `DumpLoadFailed` on any error. The file is opened read-only and immediately closed after reading.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| `Error::Io` | File not found, permission denied, or OS read error | Surface to user with path; allow retry with a different path |
| `ValidationIssue { Error, UnknownSize, target: "file length" }` | File length does not match any SizeClass byte count (RULE-009) | Reject image; surface named size-class error; do not proceed to validate |

---

### IF-002 — `nand::validate`

**Type:** Module function (mutates the `NandImage` validation_status)
**Owner:** `twinrunner-core::nand`
**Consumers:** `twinrunner-core::model`
**Realizes:** REQ-002, REQ-007
**Required by capability areas:** A

#### Input

```
image: &mut NandImage [required] — must be in Unvalidated state
```

#### Output (success)

```
Ok(()) — image.validation_status advanced to Validated; all structure + ECC checks pass
```

**Preconditions:** `image.validation_status == Unvalidated`. Caller must not call `validate` on an already-Validated, Validating, Invalid, or Extracted image.
**Postconditions (success):** `image.validation_status = Validated`; no Error-severity issues exist.
**Postconditions (failure):** `image.validation_status = Invalid`; at least one Error-severity `ValidationIssue` returned with a named `target` region.
**Side effects:** Emits `ValidationStarted` then either `ValidationPassed` or `ValidationFailed` (with named failing region). Does not write to disk.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| `Err(Vec<ValidationIssue>)` with `Error, MissingFlashConfig, target: "FlashConfig"` | FlashConfig block absent or fails bit-pattern check | Set image `Invalid`; surface named error; block extraction (RULE-003) |
| `Err(Vec<ValidationIssue>)` with `Error, UnknownLayout, target: "NandLayout"` | FlashConfig-implied ecc_type/page_size does not match any known layout | Set image `Invalid`; surface; block extraction |
| `Err(Vec<ValidationIssue>)` with `Error, EccFailure, target: "<region name>"` | ECC check fails for the named region (bootloader / fuse / keyvault) | Set image `Invalid`; surface with region name; block extraction |

---

### IF-003 — `nand::extract`

**Type:** Module function
**Owner:** `twinrunner-core::nand`
**Consumers:** `twinrunner-core::model`
**Realizes:** REQ-003, REQ-004, REQ-005, REQ-006, REQ-008
**Required by capability areas:** A

#### Input

```
image: &NandImage [required] — must be in Validated state
```

#### Output (success)

```
ConsoleInfo {
  console_type:      ConsoleType         [required] — Xenon|Zephyr|Falcon|Jasper|Trinity|Corona
  console_type_certain: bool             [required] — false when ConsoleTypeUncertain warning present
  serial:            Option<String>      [required] — Some(s) if readable ASCII; None = Absent (never guessed)
  ecc_type:          EccType             [required] — derived from FlashConfig
  cpu_key:           CpuKeyPresence      [required] — Present(CpuKey) | Absent (RULE-010; never zeroed)
  bootloader_chain:  BootloaderChain     [required] — ordered list; CB must be present
  fuse_set:          FuseSet             [required]
}
```

**Preconditions:** `image.validation_status == Validated`. Any other status produces `Err(ValidationIssue { Error, NotValidated })` — extraction is blocked (RULE-002).
**Postconditions (success):** `image.validation_status = Extracted`; `ConsoleInfo` is immutable; source file untouched.
**Side effects:** Emits `ConsoleInfoExtracted`; emits `CpuKeyAbsent` when `cpu_key = Absent`.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| `Err(ValidationIssue { Error, NotValidated })` | `image.validation_status` is not `Validated` | Surface; instruct user to run validation first (RULE-002) |
| `ValidationIssue { Warning, ConsoleTypeUncertain }` (non-blocking, in Ok result) | FlashConfig pattern + CB version do not uniquely resolve a ConsoleType | Set `console_type_certain = false`; surface warning; display flagged-uncertain type; do not block extraction |

---

### IF-004 — `keys::CpuKey::parse`

**Type:** Module function (constructor / validation gate)
**Owner:** `twinrunner-core::keys`
**Consumers:** `twinrunner-core::model`, `twinrunner-core::nand` (on extract)
**Realizes:** REQ-011
**Required by capability areas:** B

#### Input

```
s: &str [required] — user-supplied or dump-extracted string; any length accepted; invalid ones rejected
```

#### Output (success)

```
CpuKey {
  value: String [required] — exactly 32 hex characters [0-9a-fA-F]; normalized to lowercase on storage
}
```

**Preconditions:** None (this is the validation gate; any string may be passed).
**Postconditions:** Returned `CpuKey` has exactly 32 lowercase hex characters. The raw input string is not retained.
**Side effects:** None.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| `Err(ValidationIssue { Error, InvalidKeyFormat, target: "cpu_key" })` | Input is not exactly 32 hexadecimal characters (RULE-004) | Reject; do not create or persist `KeyRecord`; surface error to user |

---

### IF-005 — `keys::KeyLibrary::load` / `keys::KeyLibrary::save`

**Type:** Module functions (filesystem I/O)
**Owner:** `twinrunner-core::keys`
**Consumers:** `twinrunner-core::model` (via `Command::WriteFile` for save; direct call for load)
**Realizes:** REQ-009, REQ-012
**Required by capability areas:** B

#### Input (load)

```
path: &Path [required] — resolved from AppConfig.library_path; file may not exist (first-run)
```

#### Output (load, success)

```
KeyLibrary {
  storage_path: String     [required]
  records:      Vec<KeyRecord> [required] — zero or more; all must be in ValidatedFormat state
  schema_version: u32      [required] — must be <= current understood version
}
```

#### Input (save)

```
library: &KeyLibrary [required] — must contain only ValidatedFormat records (RULE-014)
path:    &Path       [required] — same as storage_path
```

#### Output (save, success)

```
Ok(()) — file written atomically (write-to-temp + rename)
```

**Preconditions (load):** Path may not exist (empty library is the first-run default). If the file exists, it must be valid JSON.
**Preconditions (save):** All records in the library have passed `CpuKey::parse` (RULE-014). Caller is the UI thread only (no concurrent writers).
**Postconditions (save):** File at `path` contains the full serialized library; no partial write left if the process is interrupted (temp+rename).
**Side effects (load):** None (read-only). **Side effects (save):** Writes or overwrites the library file.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| `Err(ValidationIssue { Warning, LibraryMissing })` (load) | File not found | Return empty `KeyLibrary`; do not crash; log warning (REQ-NFR-011) |
| `Err(ValidationIssue { Warning, LibraryCorrupt })` (load) | File exists but is not valid JSON or `schema_version` > understood | Return empty library + Warning issue; surface to user; do not crash |
| `Err(ValidationIssue { Error, SchemaVersionTooNew })` (load) | `schema_version` in file exceeds current supported version | Surface error; refuse to load (not silently truncate); advise upgrade |
| `Err(Error::Io)` (save) | Filesystem write failed | Surface I/O error; library state in memory is unchanged |

---

### IF-006 — `keys::KeyLibrary::add` / `edit` / `delete` / `search`

**Type:** Module functions (in-memory mutation + triggers save)
**Owner:** `twinrunner-core::keys`
**Consumers:** `twinrunner-core::model`
**Realizes:** REQ-009, REQ-010, REQ-013
**Required by capability areas:** B

#### `add` input

```
cpu_key:        CpuKey        [required] — must have passed CpuKey::parse (RULE-004)
console_serial: Option<String> [optional] — max 32 chars; ASCII printable
console_type:   Option<ConsoleType> [optional] — Xenon|Zephyr|Falcon|Jasper|Trinity|Corona
label:          Option<String> [optional] — max 128 chars; UTF-8
notes:          Option<String> [optional] — max 4096 chars; UTF-8
```

#### `add` output

```
KeyRecord {
  id:             String (UUIDv4)    [required] — system-generated; immutable
  cpu_key:        CpuKey             [required] — ValidatedFormat
  console_serial: Option<String>     [optional]
  console_type:   Option<ConsoleType> [optional]
  label:          Option<String>     [optional]
  notes:          Option<String>     [optional]
  created_at:     Timestamp          [required]
  updated_at:     Timestamp          [required] — equals created_at on creation
}
```

#### `edit` input

```
id:             String (UUIDv4) [required] — must reference an existing KeyRecord
cpu_key:        Option<CpuKey>  [optional] — if provided, must have passed CpuKey::parse
console_serial: Option<String>  [optional]
console_type:   Option<ConsoleType> [optional]
label:          Option<String>  [optional]
notes:          Option<String>  [optional]
```

#### `delete` input

```
id: String (UUIDv4) [required] — must reference an existing KeyRecord
```

#### `search` input

```
query: SearchQuery {
  serial:       Option<String>       [optional] — substring match on console_serial
  console_type: Option<ConsoleType>  [optional] — exact match
  label:        Option<String>       [optional] — substring match on label
}
```

#### `search` output

```
Vec<KeyRecord> — zero or more matching records; ordered by created_at descending
```

**Preconditions (add):** `cpu_key` must have passed `CpuKey::parse`. The library must be loaded.
**Preconditions (edit):** Record with `id` must exist.
**Postconditions (add/edit/delete):** In-memory library mutated; triggers `Command::WriteFile` (save) so the mutation is durable before the function returns control.
**Side effects:** Triggers library save on add/edit/delete. Emits `KeyRecordAdded`/`KeyRecordUpdated`/`KeyRecordDeleted` domain events.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| `Err(ValidationIssue { Error, InvalidKeyFormat })` (add/edit) | `cpu_key` failed format check (RULE-004) | Reject; do not create/update record; surface error |
| `Err(ValidationIssue { Error, RecordNotFound, target: id })` (edit/delete) | No record with the given id | Surface error; no mutation |

---

### IF-007 — `keys::bind`

**Type:** Module function
**Owner:** `twinrunner-core::keys`
**Consumers:** `twinrunner-core::model`
**Realizes:** REQ-011, REQ-013
**Required by capability areas:** B

#### Input

```
record:       &mut KeyRecord [required] — in ValidatedFormat state
console_info: &ConsoleInfo   [required] — the currently-extracted ConsoleInfo
```

#### Output

```
BindOutcome::Bound                                   — no identity conflict
BindOutcome::BoundWithMismatchWarning { reasons: Vec<MismatchReason> }
  — reasons: one or more of { SerialMismatch, ConsoleTypeMismatch }
```

**Preconditions:** `record` is in `ValidatedFormat` state. `console_info` is a valid, extracted `ConsoleInfo`.
**Postconditions:** `record.state = BoundToDump`. The mismatch warning (if any) is present in the return value; it is never suppressed (RULE-005).
**Side effects:** Emits `KeyBoundToDump` (and `KeyMismatchWarning` when applicable). Binding is session-scoped; it does not automatically persist the record.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| No error — `BoundWithMismatchWarning` is a successful return, not an error | Mismatch detected on serial or type | UI must surface the mismatch warning before considering binding accepted (RULE-005); binding may proceed but warning must be shown |

---

### IF-008 — `keys::import` / `keys::export`

**Type:** Module functions (filesystem I/O)
**Owner:** `twinrunner-core::keys`
**Consumers:** `twinrunner-core::model`
**Realizes:** REQ-014
**Required by capability areas:** B

#### `import` input

```
path: &Path [required] — user-chosen import file path (FS-002 schema)
```

#### `import` output

```
ImportResult {
  imported: u32 [required] — count of records successfully imported
  skipped:  u32 [required] — count of records rejected (format invalid or key invalid)
  warnings: Vec<ValidationIssue> [required] — one Warning per skipped record with reason
}
```

#### `export` input

```
path:      &Path           [required] — user-chosen output path; must not equal library_path
selection: ExportSelection [required] — All | ByIds(Vec<String>) — UUIDs of records to export
```

#### `export` output

```
Ok(()) — file written at path per FS-002 schema
```

**Preconditions (import):** File exists and is readable. Each record in the file is validated before import (format check on `cpu_key`). Invalid records are skipped with a Warning, not rejected wholesale.
**Preconditions (export):** Output path must not equal `library_path` (no overwrite of the canonical library).
**Postconditions (import):** Imported records are added to the in-memory library and saved (triggers library save). Skipped records produce Warning issues.
**Postconditions (export):** Output file at `path` contains the exported records per FS-002 schema. Library file is unmodified.
**Side effects (import):** Triggers library save. **Side effects (export):** Writes a new file; does not modify library.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| `Err(ValidationIssue { Error, FileNotFound })` (import) | Path does not exist | Surface; allow retry |
| `Err(ValidationIssue { Error, InvalidImportFormat })` (import) | File is not valid JSON or schema_version not understood | Reject entire import; surface error |
| `Err(ValidationIssue { Warning, InvalidKeyFormat, target: record.id })` (import, per-record) | A record's cpu_key fails format check | Skip that record; import continues; warning added to ImportResult.warnings |
| `Err(Error::Io)` (export) | Filesystem write failed | Surface I/O error; no partial file left |

---

### IF-009 — `BuildBackend` trait port

**Type:** Rust trait (`twinrunner-core::build::BuildBackend`)
**Owner:** `twinrunner-core::build`
**Consumers:** `twinrunner::worker`
**Realizes:** REQ-015, REQ-016, REQ-017, REQ-018, REQ-019, REQ-020, REQ-NFR-004
**Required by capability areas:** C

```rust
trait BuildBackend {
    fn prepare(
        &self,
        inputs: BuildInputs,
    ) -> Result<BuildJob, Vec<ValidationIssue>>;
}
```

#### `prepare` input

```
inputs: BuildInputs {
  source_image_path: String       [required] — path of a Validated/Extracted NandImage; read-only
  timing_file_id:    String       [required] — slug; must resolve to a known shipped TimingFile
  output_path:       String       [required] — user-chosen output path; must not == source_image_path
  artifact_type:     ArtifactType [required] — EccFile | XeLLImage
}
```

#### `prepare` output (success)

```
BuildJob {
  id:           String (UUIDv4) [required]
  inputs:       BuildInputs     [required] — immutable snapshot
  backend_kind: BackendKind     [required] — Simulator | RealStub
  state:        BuildJobState   [required] — exactly Pending on creation
  progress_pct: u8              [required] — 0 on creation; range 0..=100
  log_entries:  Vec<LogEntry>   [required] — empty on creation
  artifact:     Option<BuildArtifact> [required] — None on creation
  started_at:   Option<Timestamp>    [required] — None on creation
  completed_at: Option<Timestamp>    [required] — None on creation
}
```

**Implementations:**
- `SimulatorBuildBackend` — the only acting adapter; performs all simulation; writes artifacts.
- `RealStubBuildBackend` — returns `Err(vec![ValidationIssue { Error, NotImplemented }])` unconditionally and writes nothing (RULE-006).

**Preconditions:** Source image must be `Validated` or `Extracted`. `timing_file_id` must resolve to a shipped `TimingFile`. `output_path != source_image_path` (RULE-001).
**Postconditions:** The returned `BuildJob` is in `Pending` state; no file has been written yet.
**Side effects:** None — preparation only. Writing begins when the worker calls `step()`.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| `Err(vec![ValidationIssue { Error, NotImplemented }])` | `RealStubBuildBackend::prepare` called (RULE-006) | Surface "real backend not implemented"; do not start job |
| `Err(vec![ValidationIssue { Error, ImageNotValidated }])` | Source image is not Validated/Extracted | Surface; instruct user to validate first (RULE-012) |
| `Err(vec![ValidationIssue { Error, UnknownTimingFile }])` | timing_file_id not found in shipped fixtures | Surface; instruct user to select a valid timing file |
| `Err(vec![ValidationIssue { Error, OutputEqualsSource }])` | output_path == source_image_path | Refuse before any write (RULE-001); surface path conflict error |

---

### IF-010 — `BuildJob::step`

**Type:** Method on `BuildJob` (steppable job execution)
**Owner:** `twinrunner-core::build`
**Consumers:** `twinrunner::worker`
**Realizes:** REQ-019, REQ-NFR-005
**Required by capability areas:** C

#### Input

```
clock: &dyn Clock [required] — injectable clock (SystemClock in production; FixedClock in tests)
```

#### Output

```
StepOutcome::Progress { pct: u8, log: LogEntry }
  — pct: 0..=100 (monotonic non-decreasing); log: the phase-named log entry for this step

StepOutcome::Done(BuildArtifact)
  — artifact: { output_path, artifact_type, size_class, checksum }
  — emitted exactly once as the final outcome; file has been written + renamed into place

StepOutcome::Failed(error: ValidationIssue)
  — emitted exactly once as the final outcome; no file at output_path; temp file removed
```

**Preconditions:** Job is in `Pending` or `Running` state (worker manages this).
**Postconditions (Done):** File at `output_path` exists; `BuildArtifact.checksum` is the sha256 of the canonical clock-free input set (RULE-007); `output_path != source_image_path`.
**Postconditions (Failed):** No file at `output_path`; source file untouched (RULE-001).
**Postconditions (Progress):** `pct` is non-decreasing across successive calls; exactly one `Done` or `Failed` follows the last `Progress` — there are no further outcomes after a terminal (INV-007).
**Side effects:** Each `Progress` step emits a `LogEntry`. `Done` renames the temp file into place and emits `BuildCompleted`. `Failed` removes the temp file and emits `BuildFailed`.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| `StepOutcome::Failed(ValidationIssue { Error, WriteError })` | Filesystem write or rename failed mid-job | Treated as terminal; worker sends `WorkerEvent::Failed`; no partial file left |
| `StepOutcome::Failed(ValidationIssue { Error, Cancelled })` | Worker stopped calling `step()` after a `Cancel` command | Worker sends `WorkerEvent::Failed { error: Cancelled }` so UI clears active-job slot |

---

### IF-011 — `FlashBackend` trait port

**Type:** Rust trait (`twinrunner-core::flash::FlashBackend`)
**Owner:** `twinrunner-core::flash`
**Consumers:** `twinrunner::worker`
**Realizes:** REQ-021, REQ-022, REQ-023, REQ-024, REQ-NFR-004
**Required by capability areas:** D

```rust
trait FlashBackend {
    fn prepare(
        &self,
        op: FlashOperation,
        programmer: Programmer,
        image_path: Option<&Path>,
    ) -> Result<FlashJob, Vec<ValidationIssue>>;
}
```

#### `prepare` input

```
op:          FlashOperation      [required] — Read | Write | Erase
programmer:  Programmer          [required] — { id: String, connection_state: Connected, capacity: SizeClass }
image_path:  Option<&Path>       [required for Write; absent for Read/Erase] — path to a BuildArtifact or NandImage
```

#### `prepare` output (success)

```
FlashJob {
  id:             String (UUIDv4)    [required]
  operation:      FlashOperation     [required]
  programmer_id:  String             [required]
  image_path:     Option<String>     [required] — Some for Write; None for Read/Erase
  backend_kind:   BackendKind        [required]
  state:          FlashJobState      [required] — exactly Pending on creation
  progress_pct:   u8                 [required] — 0; range 0..=100
  log_entries:    Vec<LogEntry>      [required] — empty
  verify_result:  Option<VerifyResult> [required] — None on creation
  recovery_steps: Vec<RecoveryStep>  [required] — empty on creation
  started_at:     Option<Timestamp>  [required] — None
  completed_at:   Option<Timestamp>  [required] — None
}
```

**Implementations:**
- `SimulatorFlashBackend` — the only acting adapter.
- `RealStubFlashBackend` — returns `Err(vec![ValidationIssue { Error, NotImplemented }])` unconditionally (RULE-006).

**Preconditions:** For Write: `image_path` must be Some and reference a readable file. Programmer `connection_state` must be `Connected`. For Write: `programmer.capacity` must match the image's `SizeClass`.
**Postconditions:** Returned `FlashJob` is in `Pending` state; no simulated write has occurred.
**Side effects:** None — preparation only.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| `Err(vec![ValidationIssue { Error, NotImplemented }])` | `RealStubFlashBackend::prepare` called (RULE-006) | Surface; do not start job |
| `Err(vec![ValidationIssue { Error, ImagePathRequired }])` | Write operation but `image_path` is None (RULE-012) | Surface; instruct user to select an image |
| `Err(vec![ValidationIssue { Error, SizeClassMismatch }])` | Programmer capacity != image SizeClass | Surface; instruct user to match sizes |
| `Err(vec![ValidationIssue { Error, ProgrammerDisconnected }])` | Programmer is not in Connected state | Surface; advise user to connect device |

---

### IF-012 — `FlashJob::step`

**Type:** Method on `FlashJob`
**Owner:** `twinrunner-core::flash`
**Consumers:** `twinrunner::worker`
**Realizes:** REQ-023, REQ-024, REQ-NFR-005
**Required by capability areas:** D

#### Input

```
clock: &dyn Clock [required]
```

#### Output

```
StepOutcome::Progress { pct: u8, log: LogEntry }
  — pct: 0..=100 monotonic non-decreasing

StepOutcome::Verifying { pct: u8, log: LogEntry }
  — emitted during verify phase (Write only); pct monotonically continues from Running pct

StepOutcome::Done(VerifyResult)   — for Write: Pass (verify passed); for Read/Erase: implicit Pass
StepOutcome::Failed { error: ValidationIssue, recovery_steps: Vec<RecoveryStep> }
  — recovery_steps: non-empty, ordered, fixture-backed; emitted exactly once as final outcome
```

**Lifecycle constraint:** A `Write` `FlashJob` **must** pass through `Verifying` before reaching `Done`; `Done` is never emitted for a Write without a preceding `Verifying` outcome (REQ-023). A `Failed` job carries a non-empty `recovery_steps`; a `Done` job carries an empty one (REQ-024).
**Side effects:** Each step emits a `LogEntry`. `Done` emits `FlashVerified` + `FlashCompleted`. `Failed` emits `FlashFailed` + `RecoverySuggested` with the recovery list.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| `StepOutcome::Failed { error: VerifyMismatch, … }` | Written bytes != intended bytes in verify phase | Terminal; worker sends `WorkerEvent::Failed`; UI shows recovery steps |
| `StepOutcome::Failed { error: Cancelled, … }` | Worker received `Cancel` command between steps | Terminal; recovery_steps may be empty for cancel (not a device failure scenario) |

---

### IF-013 — `worker::spawn` + `WorkerCommand` channel (UI → worker)

**Type:** Thread spawn + `std::sync::mpsc::Sender<WorkerCommand>` (owned by `tui`)
**Owner:** `twinrunner::worker`
**Consumers:** `twinrunner::tui` (sends commands), `twinrunner-core::model` (produces commands; `tui` dispatches them)
**Realizes:** REQ-019, REQ-023, REQ-NFR-001, REQ-NFR-011
**Required by capability areas:** C, D

#### Spawn signature

```rust
fn spawn(
    rx: Receiver<WorkerCommand>,
    tx: Sender<WorkerEvent>,
    clock: Box<dyn Clock + Send>,
) -> JoinHandle<()>
```

#### `WorkerCommand` variants (complete enumeration — extensible only by adding new variants)

```
WorkerCommand::StartBuild(BuildJob)
  — BuildJob: in Pending state; validated by model before dispatch
  — precondition: no other job currently active (enforced by model; second StartBuild rejected)

WorkerCommand::StartFlash(FlashJob)
  — FlashJob: in Pending state; validated by model before dispatch

WorkerCommand::Cancel
  — cancels the in-flight job at the next step boundary
  — idempotent: ignored if no job is active

WorkerCommand::Shutdown
  — terminates the worker loop; allows the thread to return for join()
  — idempotent: a second Shutdown after the loop exits is a no-op
```

**Delivery semantics:** Exactly-once, ordered (in-process FIFO mpsc channel). The UI thread uses non-blocking `send` (the channel is never full in practice for one-job-at-a-time).
**Ordering constraint:** `StartBuild`/`StartFlash` must not be sent while a `WorkerEvent::Started` has been received but `Completed`/`Failed` has not. The `model` reducer enforces this before dispatching; the worker holds a single active-job slot as defense-in-depth.

---

### IF-014 — `WorkerEvent` channel (worker → UI)

**Type:** `std::sync::mpsc::Receiver<WorkerEvent>` (owned by `tui`); drained per-tick with `try_recv`
**Owner:** `twinrunner::worker` (producer)
**Consumers:** `twinrunner::tui` (drains; folds into `Message`s for `model::update`)
**Realizes:** REQ-019, REQ-023, REQ-NFR-001, REQ-NFR-011
**Required by capability areas:** C, D

#### `WorkerEvent` variants (complete enumeration)

```
WorkerEvent::Started { job_id: String }
  — the worker accepted the job and began stepping
  — emitted exactly once per job, before any Progress

WorkerEvent::Progress { job_id: String, pct: u8 }
  — one step advanced; pct: 0..=100; monotonic non-decreasing per job_id
  — zero or more per job

WorkerEvent::Log { job_id: String, entry: LogEntry }
  — a structured log entry produced by the job step
  — entry is redaction-safe (log module redacts before passing to worker events)
  — zero or more per job; interleaved with Progress events

WorkerEvent::Completed { job_id: String, result: OperationResult::Success }
  — terminal success event; exactly one per job; no further events for this job_id
  — result for BuildJob: BuildArtifact { output_path, artifact_type, size_class, checksum }
  — result for FlashJob (Write): VerifyResult::Pass
  — result for FlashJob (Read/Erase): implicit Success

WorkerEvent::Failed { job_id: String, error: ValidationIssue, recovery_steps: Vec<RecoveryStep> }
  — terminal failure event; exactly one per job; no further events for this job_id
  — recovery_steps: non-empty for flash verify failures; may be empty for cancel / build failures
  — a panicking job is caught by the worker and converted to this variant (REQ-NFR-011)
```

**Delivery semantics:** Exactly-once, ordered per `job_id` (in-process FIFO mpsc channel, single-writer worker thread). The consumer drains with `try_recv` in a loop on every tick (non-blocking — REQ-NFR-001).

**Ordering guarantees (per job_id):**
1. `Started` arrives before any `Progress` or `Log` for the same `job_id`.
2. `Progress.pct` is monotonically non-decreasing within a job.
3. Exactly one `Completed` or `Failed` event per job; it is the last event for that `job_id`.
4. The consumer MUST NOT send a new `StartBuild`/`StartFlash` until `Completed`/`Failed` for the current job has been received and folded into the Model.

---

### IF-015 — `model::update` reducer

**Type:** Pure synchronous function
**Owner:** `twinrunner-core::model`
**Consumers:** `twinrunner::tui`
**Realizes:** REQ-NFR-006, REQ-NFR-011, and orchestration of all functional REQs
**Required by capability areas:** Shell (all)

```rust
fn update(model: Model, msg: Message) -> (Model, Vec<Command>)
```

#### `Message` input alphabet (complete enumeration by group)

**User-intent messages (from keymap):**
```
Navigate(Screen)                          — Screen: Dashboard|ConsoleInfo|KeyLibrary|Build|Flash|Troubleshoot|Log|Help|Config
OpenCommandPalette
RunPaletteCommand(id: String)
LoadDump(path: String)                    — triggers Command::ReadDump
RequestValidate                           — triggers validate on active NandImage
RequestExtract                            — triggers extract on validated NandImage
ExportConsoleInfo(path: String)           — triggers Command::WriteFile (ConsoleInfo JSON)
KeyAdd(CpuKey, Option<ConsoleType>, Option<String>, Option<String>)
KeyEdit(id: String, /* field deltas */)
KeyDelete(id: String)
KeySearch(SearchQuery)
KeyBind(id: String)
KeyImport(path: String)
KeyExport(path: String, ExportSelection)
ConfigureBuild(BuildInputs)               — sets pending build inputs in Model
StartBuild                                — model checks preconditions; emits Command::RunBuild or ValidationIssue
ConfigureFlash(FlashOperation, Option<String>)
StartFlash                                — model checks preconditions; emits Command::RunFlash or ValidationIssue
CancelJob                                 — emits Command::CancelWorkerJob if a job is active
TroubleshootStart(flow_id: String)
TroubleshootAdvance(response: String)
TroubleshootBack
TroubleshootAbandon
Resize(w: u16, h: u16)
Quit                                      — emits Command::ShutdownWorker
```

**Worker-event messages (folded from WorkerEvent by tui):**
```
JobStarted { job_id: String }
JobProgressed { job_id: String, pct: u8 }
JobLogged { job_id: String, entry: LogEntry }
JobCompleted { job_id: String, result: OperationResult }
JobFailed { job_id: String, error: ValidationIssue, recovery_steps: Vec<RecoveryStep> }
```

**I/O-result messages (folded from Command results by tui):**
```
DumpLoaded(NandImage)
DumpLoadFailed(ValidationIssue)
```

#### `Command` output alphabet (complete enumeration)

```
Command::ReadDump(path: String)          — tui calls nand::load; result returned as DumpLoaded/DumpLoadFailed
Command::RunBuild(BuildJob)              — tui sends WorkerCommand::StartBuild
Command::RunFlash(FlashJob)             — tui sends WorkerCommand::StartFlash
Command::CancelWorkerJob                 — tui sends WorkerCommand::Cancel
Command::WriteFile { path: String, bytes: Vec<u8> }  — tui writes file (library save, ConsoleInfo export)
Command::ShutdownWorker                  — tui sends WorkerCommand::Shutdown then joins thread
```

**Reducer contract guarantees:**
- **Pure:** no I/O, no terminal reads, no wall-clock access (clock values arrive only in Message payloads).
- **Total:** every `Message` variant is handled (or explicitly ignored with a no-op; no unhandled variants).
- **Precondition enforcement:** `StartBuild`/`StartFlash` are refused (written into Model as `ValidationIssue`) unless the image is `Validated`/`Extracted` and (for build) the timing file is known (RULE-002/012). A second `Start*` while `active_job.is_some()` is refused as "one job at a time" notice.
- **No direct I/O:** long-running work leaves the reducer only as a `Command`; the reducer never blocks.

**Preconditions:** Called only from the UI thread; never called from the worker thread (INV-008).
**Postconditions:** Returns a new `Model` (not mutated in place) + zero or more `Command`s. Model transitions are deterministic given the same `Message` + same prior `Model`.
**Side effects:** None (pure function). Side effects are the caller's responsibility via the returned `Command` list.

#### Error responses (within Model, not as Rust errors)

| Condition | Model mutation | Command emitted |
|---|---|---|
| `StartBuild`/`StartFlash` precondition violation | `ValidationIssue` written into `Model.pending_issues` for UI display | None |
| Second `Start*` while job active | "One job at a time" notice written into Model | None |
| `RunPaletteCommand(id)` for unknown palette id | No-op; palette remains open | None |

---

### IF-016 — `troubleshoot` flow stepper

**Type:** Module functions
**Owner:** `twinrunner-core::troubleshoot`
**Consumers:** `twinrunner-core::model`
**Realizes:** REQ-025, REQ-026
**Required by capability areas:** D

#### Functions

```
load_flows() -> Vec<TroubleshootingFlow>
  — returns all bundled fixture flows; called once at session start
  — output: Vec of TroubleshootingFlow with at least one entry; empty Vec only if fixtures missing (error logged)

FlowSession::start(flow: &TroubleshootingFlow) -> FlowSession
  — creates a new session in NotStarted state; advances to AtStep(start_step_id)
  — emits TroubleshootingFlowStarted

FlowSession::advance(response: String) -> StepResult
  — response: must be in current step's declared responses (RULE-013)
  — output: StepResult::AtStep(TroubleshootingStep) | StepResult::Completed

FlowSession::back() -> StepResult
  — walks one step back on the visited stack; no-op if at start
  — output: StepResult::AtStep(TroubleshootingStep) | StepResult::AtStart

FlowSession::abandon() -> ()
  — terminates session in Abandoned state; emits TroubleshootingFlowAbandoned
```

**Preconditions (advance):** Session is in `AtStep` state. `response` must be one of the current step's declared response keys.
**Postconditions (advance):** Session advances to the next step or to `Completed`; visited stack is updated for back().
**Side effects:** Emits session-lifecycle domain events.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| `Err(ValidationIssue { Error, UndeclaredResponse })` | `advance(response)` where response not in current step's responses (RULE-013) | Reject; session stays `AtStep`; surface "invalid choice" to user |
| `Err(ValidationIssue { Error, SessionNotStarted })` | `advance`/`back` called before `start` | Surface; do not advance |

---

### IF-017 — `log::ActionLog::append`

**Type:** Module function (append-only)
**Owner:** `twinrunner-core::log`
**Consumers:** `twinrunner-core::model`, `twinrunner::worker` (via model messages)
**Realizes:** REQ-027, REQ-031, REQ-NFR-007
**Required by capability areas:** Shell

#### Input

```
level:     LogLevel   [required] — Info | Warning | Error
operation: String     [required] — name of the operation emitting this entry; non-empty; max 128 chars
message:   String     [required] — human-readable; non-empty; max 4096 chars; CPU-key material is redacted before storage
payload:   Option<Map<String, String>> [optional] — structured key-value context; max 20 keys; each key max 64 chars; each value max 512 chars; CPU-key-shaped values redacted
clock:     &dyn Clock [required] — timestamp source
```

#### Output

```
LogEntry {
  timestamp: Timestamp  [required] — from clock.now(); display/audit only; never in checksums
  level:     LogLevel   [required]
  operation: String     [required]
  message:   String     [required] — post-redaction
  payload:   Option<Map<String, String>> [optional] — post-redaction
}
```

**Redaction contract:** Before the entry is stored or mirrored, any substring of exactly 32 hex characters `[0-9a-fA-F]{32}` (word-boundary-anchored so it does not clip SHA-256 or CRC values) is replaced with `REDACTED_CPU_KEY`. Payload fields keyed `cpu_key` are redacted by key name regardless of shape (defense-in-depth). The raw key string is never persisted (INV-006, security → `08a`).
**Preconditions:** Called from the UI thread only (no concurrent writers — INV-006).
**Postconditions:** Entry is appended to the in-memory `ActionLog` in arrival order; if `AppConfig.log_file_path` is set, entry is mirrored to the log file. Entries are never reordered or removed (RULE-011).
**Side effects:** Optional file mirror append; no other side effects.

#### Error responses

| Error type | Condition | Consumer action |
|---|---|---|
| Log-mirror I/O error | Write to log file fails | Log warning (to in-memory log only); continue — file logging failure is not fatal (REQ-NFR-011) |

---

### IF-018 — `clock::Clock` trait

**Type:** Rust trait
**Owner:** `twinrunner-core::clock`
**Consumers:** `twinrunner-core::build`, `twinrunner-core::flash`, `twinrunner-core::log`
**Realizes:** REQ-NFR-005
**Required by capability areas:** Shell

```rust
trait Clock: Send + Sync {
    fn now(&self) -> Timestamp;
}

// Implementations:
// SystemClock  — wraps std::time::SystemTime; used in production
// FixedClock   — returns a pinned Timestamp; used in tests
```

**Contract:** `Timestamp` is an ISO 8601 datetime string (UTC). `Clock::now()` is called only for display/audit fields (`LogEntry.timestamp`, `BuildJob.started_at`, `FlashJob.started_at`). It **must not** be called from within the checksum input set computation or the progress/verify sequence (ADR-006 / INV-005). This is enforced structurally: checksum computation in `build` does not accept a `Clock` parameter, only a fixed canonical byte set.

**Side effects:** None.

#### Error responses

None — `Clock::now()` is infallible; if system time is unavailable, `SystemClock` may return a sentinel value, but this does not affect any non-display behavior.

---

## Data Schemas

All persisted/exported schemas use JSON format (via `serde_json`) except `AppConfig` (TOML). Every schema carries a top-level `schema_version: u32` field. The loader rejects files with a `schema_version` greater than the current supported version.

---

### FS-001 — KeyLibrary File Schema

**Domain entity:** `KeyLibrary` (from `03-domain-model.md`)
**Realizes:** REQ-009, REQ-012, REQ-014
**Used by interfaces:** IF-005, IF-008
**Format:** JSON; one object per file
**File location:** `AppConfig.library_path` (platform data dir default)

```
schema_version:  u32              [required] — current = 1; additive changes do not increment
records:         Array<KeyRecord> [required] — zero or more; ordered by created_at descending
```

**KeyRecord (embedded in FS-001):**

```
id:             String (UUIDv4)       [required] — format: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
cpu_key:        String                [required] [SENSITIVE] — exactly 32 lowercase hex chars [0-9a-f]{32}
console_serial: String | null         [optional] — max 32 chars; ASCII printable; null = Absent
console_type:   String | null         [optional] — one of { "Xenon","Zephyr","Falcon","Jasper","Trinity","Corona" } | null
label:          String | null         [optional] — max 128 chars; UTF-8; null = no label
notes:          String | null         [optional] — max 4096 chars; UTF-8; null = no notes
created_at:     String (ISO 8601 UTC) [required] — immutable
updated_at:     String (ISO 8601 UTC) [required] — updated on any field edit
```

**Validation rules:**
- `cpu_key` must pass the `[0-9a-f]{32}` format check on load; records failing this check are skipped with a `Warning` (not loaded into memory).
- `console_type` must be one of the six known enum values or null; unknown strings are treated as null + Warning.
- No two records in the array may share the same `id`.

---

### FS-002 — Key Import/Export File Schema

**Domain entity:** `KeyRecord` subset export (from `03-domain-model.md`)
**Realizes:** REQ-014
**Used by interfaces:** IF-008
**Format:** JSON; one object per file

```
schema_version:  u32              [required] — current = 1
exported_at:     String (ISO 8601 UTC) [required] — timestamp of the export operation
records:         Array<ExportedKeyRecord> [required] — one or more
```

**ExportedKeyRecord:**

```
id:             String (UUIDv4)       [required]
cpu_key:        String                [required] [SENSITIVE] — exactly 32 lowercase hex chars
console_serial: String | null         [optional] — max 32 chars
console_type:   String | null         [optional] — enum or null
label:          String | null         [optional] — max 128 chars
notes:          String | null         [optional] — max 4096 chars
created_at:     String (ISO 8601 UTC) [required]
```

**Deliberately excluded field — `updated_at`:** The `updated_at` timestamp present in FS-001 `KeyRecord` is intentionally absent from `ExportedKeyRecord`. It reflects local-library edit history (when the record was last edited on the exporting machine) and carries no meaningful identity or key-material information; transporting it across machines would import a timestamp that is foreign to the receiving library's edit timeline. On import into FS-001, the receiving side sets `updated_at = created_at` for each imported record (treating it as freshly added). This is the defined round-trip behavior: `created_at` is preserved (it identifies when the record was first created on the originating machine); `updated_at` is reset to `created_at` on arrival, not silently dropped or left as a stale foreign value.

**Validation rules (import):**
- Per-record: `cpu_key` failing the 32-hex check causes that record to be skipped with a Warning; the import continues.
- Per-record: unknown `console_type` is imported as null + Warning.
- Duplicate `id` within the import file: last occurrence wins (or skip — see `ImportResult.skipped`).
- Records whose `id` already exists in the KeyLibrary are skipped (no overwrite on import).
- On import, `updated_at` is set to `created_at` for each successfully imported record (see exclusion rationale above).

---

### FS-003 — ConsoleInfo Export Schema

**Domain entity:** `ConsoleInfo` (from `03-domain-model.md`)
**Realizes:** REQ-008
**Used by interfaces:** IF-003 (triggers `Command::WriteFile`)
**Format:** JSON; one object per file; text/plain summary available as an alternative rendering

```
schema_version:   u32    [required] — current = 1
exported_at:      String (ISO 8601 UTC) [required]
source_path:      String [required] — canonical path of the source dump file
console_type:     String [required] — one of { "Xenon","Zephyr","Falcon","Jasper","Trinity","Corona" }
console_type_certain: bool [required] — false when ConsoleTypeUncertain warning was present
serial:           String | null [optional] — serial string if readable; null = Absent
ecc_type:         String [required] — e.g. "SmallBlock" | "LargeBlock"
cpu_key:          String | null [optional] [SENSITIVE] — 32 lowercase hex chars if Present; null = Absent
bootloader_chain: Array<BootloaderEntry> [required]
fuse_set:         FuseSetEntry [required]
```

**BootloaderEntry:**

```
stage:   String  [required] — one of { "CB","CD","CE","CF","CG" }
version: String | null [optional] — version string e.g. "17559"; null = stage not present in dump
present: bool    [required]
```

**FuseSetEntry:**

```
fuse_lines:     Array<String>  [required] — each entry: hex string; may be empty if unreadable
security_state: String         [required] — human-readable derived summary
```

**Validation rules:**
- `cpu_key` in export is the raw key value (SENSITIVE); consumers must handle it as sensitive data.
- `bootloader_chain` must contain at least one entry with `stage = "CB"` and `present = true`; if CB is absent, the exporter includes it with `present = false`.

---

### FS-004 — AppConfig File Schema

**Domain entity:** `AppConfig` (from `03-domain-model.md`)
**Realizes:** REQ-033
**Used by interfaces:** `config` module (not in IF index — config is deliberately skipped as trivial per §15.6; its contract is this schema)
**Format:** TOML (human-editable); config file (not data file — no `schema_version` versioning; missing/invalid fields fall back to defaults without a version check)

```
library_path   = String  [optional, default: platform data dir + "/twinrunner/keys.json"]
output_dir     = String  [optional, default: current working directory]
build_backend  = String  [optional, default: "Simulator"] — "Simulator" | "RealStub"
flash_backend  = String  [optional, default: "Simulator"] — "Simulator" | "RealStub"
log_verbosity  = String  [optional, default: "Info"]      — "Info" | "Warning" | "Error"
log_file_path  = String  [optional, default: absent]      — absent = no file logging
```

**Validation rules:**
- Unknown keys are ignored (forward-compatible; a newer config file on an older binary is safe).
- Invalid values (e.g. `build_backend = "Unknown"`) fall back to the default for that field; a Warning is logged at startup. The application never aborts startup due to a config error (REQ-033).
- `library_path` and `log_file_path`, if set, must be valid UTF-8 strings; invalid UTF-8 is treated as absent.

---

### FS-005 — Log File Schema

**Domain entity:** `LogEntry` / `ActionLog` (from `03-domain-model.md`)
**Realizes:** REQ-027, REQ-NFR-007
**Used by interfaces:** IF-017
**Format:** JSON Lines (one `LogEntry` JSON object per line; not a JSON array)
**File location:** `AppConfig.log_file_path` (optional; file logging is off by default)

```
Per line (one LogEntry):
{
  "schema_version": u32              — [required] — current = 1; same version on every line in a file
  "timestamp":      String (ISO 8601 UTC) — [required]
  "level":          String           — [required] — "Info" | "Warning" | "Error"
  "operation":      String           — [required] — max 128 chars
  "message":        String           — [required] — max 4096 chars; CPU-key material is REDACTED_CPU_KEY
  "payload":        Object | null    — [optional] — key-value pairs; values are strings; CPU-key-shaped values redacted
}
```

**Validation rules:**
- CPU-key-shaped strings (`[0-9a-fA-F]{32}`) are replaced with `REDACTED_CPU_KEY` before any line is written (INV-006, security → `08a`).
- Lines are append-only; no line is ever modified or removed (RULE-011).
- Readers of the file must tolerate a trailing incomplete line (process interrupted mid-write) — skip the last line if it is not valid JSON.

---

### FS-006 — BuildArtifact / Output Image File

**Domain entity:** `BuildArtifact` (`EccFile` | `XeLLImage`) (from `03-domain-model.md`)
**Realizes:** REQ-015, REQ-017, REQ-018
**Used by interfaces:** IF-010
**Format:** Binary (opaque byte sequence produced by the simulator)

The output file is a binary image file whose internal structure is simulator-defined. It is not a documented data schema in the JSON sense; its contract is:

```
output_path:   String  [required] — user-chosen path; guaranteed != source_image_path (RULE-001)
artifact_type: String  [required] — "EccFile" | "XeLLImage"
size_class:    String  [required] — "MB16" | "MB64" | "MB256" | "MB512"
checksum:      String  [required] — sha256 hex string; exactly 64 lowercase hex chars; deterministic (RULE-007)
```

These metadata fields are carried in the `BuildArtifact` struct in memory and logged via `ActionLog`; they are not embedded in the binary file itself. The binary file is written atomically (temp + rename); a partial/incomplete file is never left at the final output path (INV-001).

---

## Events

This system uses **in-process domain events** — not a message bus, queue, or pub/sub system. Events are emitted by calling module code and folded into the `ActionLog` and Model state by the caller. Cross-thread events flow through the `WorkerEvent` channel (IF-014). The events below are the complete set of named domain events used for audit, ordering verification, and test assertion.

---

### WorkerEvent::Started

**Producer:** `twinrunner::worker`
**Consumer(s):** `twinrunner::tui` (folds to `Message::JobStarted`)
**Realizes:** REQ-019, REQ-023

**Payload:**
```
job_id: String (UUIDv4) [required] — matches the BuildJob.id or FlashJob.id
```

**Delivery semantics:** Exactly-once per job. In-process ordered mpsc channel.
**Ordering guarantee:** Arrives before any `Progress` or `Log` for the same `job_id`. Guaranteed by single-writer FIFO channel.

---

### WorkerEvent::Progress

**Producer:** `twinrunner::worker`
**Consumer(s):** `twinrunner::tui`
**Realizes:** REQ-019, REQ-023, REQ-NFR-001

**Payload:**
```
job_id: String (UUIDv4) [required]
pct:    u8              [required] — 0..=100; monotonically non-decreasing within a job
```

**Delivery semantics:** Exactly-once per step (zero or more per job). In-process ordered.
**Ordering guarantee:** Monotonic pct within a job_id. Guaranteed by sequential stepping on the single worker thread.

---

### WorkerEvent::Log

**Producer:** `twinrunner::worker`
**Consumer(s):** `twinrunner::tui`
**Realizes:** REQ-027, REQ-031

**Payload:**
```
job_id: String   [required]
entry:  LogEntry [required] — already redaction-safe (RULE on IF-017 applied before emission)
```

**Delivery semantics:** Exactly-once per log-emitting step. In-process ordered.
**Ordering guarantee:** Interleaved with Progress events in step emission order.

---

### WorkerEvent::Completed

**Producer:** `twinrunner::worker`
**Consumer(s):** `twinrunner::tui`
**Realizes:** REQ-019, REQ-023

**Payload:**
```
job_id: String          [required]
result: OperationResult [required]
  — for BuildJob: BuildArtifact { output_path: String, artifact_type: String, size_class: String, checksum: String (64 hex) }
  — for FlashJob Write: VerifyResult::Pass
  — for FlashJob Read/Erase: implicit Success
```

**Delivery semantics:** Exactly-once per job; terminal — no further events for this `job_id` after `Completed`. In-process ordered.

---

### WorkerEvent::Failed

**Producer:** `twinrunner::worker`
**Consumer(s):** `twinrunner::tui`
**Realizes:** REQ-019, REQ-023, REQ-024, REQ-NFR-011

**Payload:**
```
job_id:         String               [required]
error:          ValidationIssue      [required] — named error variant; human-readable message
recovery_steps: Vec<RecoveryStep>    [required] — non-empty for flash verify failures; may be empty for cancel/build failures
```

**Delivery semantics:** Exactly-once per failed job; terminal. Worker panics are caught and converted to this variant (REQ-NFR-011).
**Ordering guarantee:** Arrives after all `Progress` and `Log` events for the job. Guaranteed by sequential stepping.

---

### Domain Events (in-process, non-channel)

The following domain events are emitted in-process by core modules and are used for audit log entries and test assertion, not for cross-component routing. They are listed here for completeness of the event vocabulary.

| Event name | Producer | Trigger | REQ-IDs |
|---|---|---|---|
| `DumpLoaded` | `nand::load` | File opened and bytes read successfully | REQ-001 |
| `DumpLoadFailed` | `nand::load` | File open, read, or size-class error | REQ-001 |
| `ValidationStarted` | `nand::validate` | Validation begins | REQ-002 |
| `ValidationPassed` | `nand::validate` | All structure + ECC checks pass | REQ-002, REQ-007 |
| `ValidationFailed` | `nand::validate` | ≥1 Error-severity issue; named region in payload | REQ-002, REQ-007 |
| `ConsoleInfoExtracted` | `nand::extract` | ConsoleInfo successfully extracted | REQ-003–REQ-008 |
| `CpuKeyAbsent` | `nand::extract` | CPU key region zeroed/undecodable; Absent reported | REQ-006 |
| `BuildJobCreated` | `build::prepare` | BuildJob enters Pending state | REQ-015 |
| `BuildStarted` | `worker` / `build::step` | First step begins; pct=0 | REQ-019 |
| `BuildProgressed` | `build::step` | Progress step; pct updated | REQ-019 |
| `BuildCompleted` | `build::step` | Final step; artifact written | REQ-019 |
| `BuildFailed` | `build::step` | Job failed; no file at output path | REQ-019 |
| `FlashJobCreated` | `flash::prepare` | FlashJob enters Pending state | REQ-021 |
| `FlashStarted` | `flash::step` | First step; pct=0 | REQ-023 |
| `FlashProgressed` | `flash::step` | Progress step | REQ-023 |
| `FlashVerifying` | `flash::step` | Verify phase begins (Write only) | REQ-023 |
| `FlashVerified` | `flash::step` | Verify passed | REQ-023 |
| `FlashCompleted` | `flash::step` | Job succeeded (after Verified for Write) | REQ-023 |
| `FlashFailed` | `flash::step` | Job failed; recovery steps populated | REQ-024 |
| `RecoverySuggested` | `flash::step` | Recovery step list populated on failure | REQ-024 |
| `KeyRecordAdded` | `keys::add` | KeyRecord created | REQ-009 |
| `KeyRecordUpdated` | `keys::edit` | KeyRecord fields edited | REQ-013 |
| `KeyRecordDeleted` | `keys::delete` | KeyRecord removed | REQ-013 |
| `KeyBoundToDump` | `keys::bind` | KeyRecord bound to active NandImage | REQ-011 |
| `KeyMismatchWarning` | `keys::bind` | Bind detected identity conflict | REQ-011 |
| `TroubleshootingFlowStarted` | `troubleshoot::start` | Flow session started | REQ-025 |
| `TroubleshootingStepAdvanced` | `troubleshoot::advance` | Session moved to next step | REQ-025 |
| `TroubleshootingFlowCompleted` | `troubleshoot::advance` | Terminal step reached | REQ-025 |
| `TroubleshootingFlowAbandoned` | `troubleshoot::abandon` | Session abandoned | REQ-026 |

---

## Error Contracts

This system uses **typed Rust `Result<T, E>` and `Vec<ValidationIssue>`** — not HTTP status codes. The table below maps every named error variant that crosses a module boundary to its trigger, the consumer action required, and the relevant interfaces.

**Error envelope (standard shape for all module errors):**

```
ValidationIssue {
  severity:   IssueSeverity  [required] — Error | Warning
  issue_code: ValidationCode [required] — named enum variant (see table below)
  target:     String         [required] — field name, region name, or entity id the issue applies to
  message:    String         [required] — human-readable; actionable guidance
}
```

| Error ID | Code (`ValidationCode`) | Severity | Condition | Consumer action | Interfaces | REQ-IDs |
|---|---|---|---|---|---|---|
| ERR-001 | `UnknownSize` | Error | File length does not match any SizeClass | Reject; surface clear size-class error; do not validate | IF-001 | REQ-001 |
| ERR-002 | `MissingFlashConfig` | Error | FlashConfig block absent or fails bit-pattern check | Mark image Invalid; surface named error; block extraction | IF-002 | REQ-002 |
| ERR-003 | `UnknownLayout` | Error | FlashConfig-implied ecc_type/page_size matches no known layout | Mark image Invalid; surface; block extraction | IF-002 | REQ-002 |
| ERR-004 | `EccFailure` | Error | ECC check fails on a named region (target = region name) | Mark image Invalid; surface with region name; block extraction (RULE-003) | IF-002 | REQ-007 |
| ERR-005 | `NotValidated` | Error | `extract` called on image not in Validated state | Surface; tell user to validate first (RULE-002) | IF-003 | REQ-002 |
| ERR-006 | `ConsoleTypeUncertain` | Warning | ConsoleType markers ambiguous; flagged-uncertain default used | Non-blocking; surface warning; display uncertain type | IF-003 | REQ-003 |
| ERR-007 | `InvalidKeyFormat` | Error | cpu_key is not exactly 32 hex chars (RULE-004) | Reject; do not create/persist record; surface format error | IF-004, IF-005, IF-008 | REQ-011 |
| ERR-008 | `LibraryMissing` | Warning | Library file not found on load | Return empty library; log warning; continue (first-run) | IF-005 | REQ-012 |
| ERR-009 | `LibraryCorrupt` | Warning | Library file exists but is not valid JSON | Return empty library; surface warning; do not crash | IF-005 | REQ-012 |
| ERR-010 | `SchemaVersionTooNew` | Error | Library/import file `schema_version` > supported | Refuse to load; surface error; advise upgrade | IF-005, IF-008 | REQ-012 |
| ERR-011 | `RecordNotFound` | Error | No KeyRecord with the given id (edit/delete) | Surface; no mutation | IF-006 | REQ-013 |
| ERR-012 | `FileNotFound` | Error | Import file path does not exist | Surface; allow retry | IF-008 | REQ-014 |
| ERR-013 | `InvalidImportFormat` | Error | Import file is not valid JSON or schema_version unknown | Reject entire import; surface error | IF-008 | REQ-014 |
| ERR-014 | `NotImplemented` | Error | `RealStub*Backend::prepare` called (RULE-006) | Surface "real backend not implemented"; do not start job | IF-009, IF-011 | REQ-020, REQ-022 |
| ERR-015 | `ImageNotValidated` | Error | BuildBackend::prepare — source image not Validated/Extracted (RULE-012) | Surface; instruct user to validate first | IF-009 | REQ-015 |
| ERR-016 | `UnknownTimingFile` | Error | timing_file_id not in shipped fixtures | Surface; instruct user to select valid timing file | IF-009 | REQ-016 |
| ERR-017 | `OutputEqualsSource` | Error | output_path == source_image_path (RULE-001) | Refuse; surface path conflict | IF-009 | REQ-035 |
| ERR-018 | `WriteError` | Error | Filesystem write/rename failed mid build job | Terminal job failure; no partial file at output path | IF-010 | REQ-015 |
| ERR-019 | `Cancelled` | Error | Job cancelled between steps | Terminal job failure (clean); UI clears active-job slot | IF-010, IF-012 | REQ-019 |
| ERR-020 | `ImagePathRequired` | Error | FlashBackend::prepare Write op but image_path is None (RULE-012) | Surface; instruct user to select image | IF-011 | REQ-021 |
| ERR-021 | `SizeClassMismatch` | Error | Programmer capacity != image SizeClass | Surface; instruct user to match sizes | IF-011 | REQ-021 |
| ERR-022 | `ProgrammerDisconnected` | Error | Programmer is not in Connected state | Surface; advise connect device | IF-011 | REQ-021 |
| ERR-023 | `VerifyMismatch` | Error | Flash write verify: written bytes != intended bytes | Terminal flash failure; UI shows recovery steps (REQ-024) | IF-012 | REQ-023 |
| ERR-024 | `UndeclaredResponse` | Error | `troubleshoot::advance(response)` where response not declared on current step (RULE-013) | Reject; session stays AtStep; surface invalid-choice error | IF-016 | REQ-026 |
| ERR-025 | `SessionNotStarted` | Error | `advance`/`back` called before `start` | Surface; do not advance | IF-016 | REQ-025 |
| ERR-026 | `Io` | Error | File open/read/write OS error (generic) | Surface with path; allow retry where applicable | IF-001, IF-005, IF-008 | REQ-001 |

**No-silent-success guarantee:** Every Error-severity `ValidationIssue` blocks the dependent operation from proceeding (RULE-002/003). No bad-state operation ever silently succeeds (RULE-003). The real backend stubs always return `ERR-014 NotImplemented` — they never silently produce output (RULE-006).

**Auth note:** No authentication or authorization error types exist. This system has no auth layer.

---

## Versioning

TwinRunner has no HTTP API and no network surface. "Versioning" in this system applies exclusively to the **persisted and exported file schemas** (FS-001 through FS-005), because these are the only boundaries that survive process restarts and may be read by a future version of the binary.

- **Strategy:** Integer `schema_version` field at the top level of every JSON schema (FS-001, FS-002, FS-003, FS-005). AppConfig (FS-004) uses TOML and does not carry a schema_version — unknown keys are silently ignored and invalid values fall back to defaults.
- **Current version for all JSON schemas:** `1` (initial release).
- **Additive-change rule (non-breaking):** Adding a new optional field to a schema does NOT increment `schema_version`. The loader must ignore unknown fields (forward-compatible). This is the default `serde` behavior with `#[serde(default)]` on optional fields.
- **Breaking-change rule:** Adding a required field, removing a field, renaming a field, or changing a field's type increments `schema_version`. The loader rejects files with `schema_version > current_supported_version` with `ERR-010 SchemaVersionTooNew`.
- **Downgrade behavior:** A binary reading a file with `schema_version < current` applies migration logic for each version delta (if any). For v1 → v1 there is no migration.
- **Compatibility promise:** FS-001 (KeyLibrary) and FS-002 (key export/import) carry the strongest promise: a file written by version N of TwinRunner must be importable by version N+1 without data loss, unless a breaking schema change occurred (version bumped). The release notes must document any breaking change.
- **Module API versioning:** Module function signatures (IF-001 through IF-018) are internal to the Rust binary. "Versioning" is not meaningful for them — slice compatibility is ensured by the Rust type system and cargo build. Signature changes are caught at compile time.
- **Human-approved versioning decisions:** The choice of JSON + integer `schema_version` for persisted schemas is a design default applied here (product-affecting but reversible and scoped to a single local binary — no human gate required per the prompt).

---

## Consumer / Producer Map

| Interface / Event | Producer | Consumer(s) | REQ-IDs | Capability area | Notes |
|---|---|---|---|---|---|
| IF-001 `nand::load` | `twinrunner-core::nand` | `twinrunner-core::model` (via Command→tui dispatch) | REQ-001, REQ-035 | A | tui triggers via Message; result folded back as DumpLoaded/DumpLoadFailed |
| IF-002 `nand::validate` | `twinrunner-core::nand` | `twinrunner-core::model` | REQ-002, REQ-007 | A | Called via Command from model; result folded into Model |
| IF-003 `nand::extract` | `twinrunner-core::nand` | `twinrunner-core::model` | REQ-003–REQ-008 | A | Precondition: image Validated |
| IF-004 `keys::CpuKey::parse` | `twinrunner-core::keys` | `twinrunner-core::model`, `twinrunner-core::nand` (extract) | REQ-011 | B | All key material passes through this gate before storage |
| IF-005 `keys::load` / `save` | `twinrunner-core::keys` | `twinrunner-core::model` | REQ-009, REQ-012 | B | Save triggered by Command::WriteFile; load at session start |
| IF-006 `keys::CRUD/search` | `twinrunner-core::keys` | `twinrunner-core::model` | REQ-009, REQ-010, REQ-013 | B | All mutations trigger save |
| IF-007 `keys::bind` | `twinrunner-core::keys` | `twinrunner-core::model` | REQ-011, REQ-013 | B | Mismatch warning must be surfaced by tui (RULE-005) |
| IF-008 `keys::import` / `export` | `twinrunner-core::keys` | `twinrunner-core::model` | REQ-014 | B | |
| IF-009 `BuildBackend::prepare` | `twinrunner-core::build` | `twinrunner::worker` | REQ-015–REQ-020, REQ-NFR-004 | C | model validates preconditions then emits Command::RunBuild |
| IF-010 `BuildJob::step` | `twinrunner-core::build` | `twinrunner::worker` | REQ-019, REQ-NFR-005 | C | Worker drives stepping; sends WorkerEvents |
| IF-011 `FlashBackend::prepare` | `twinrunner-core::flash` | `twinrunner::worker` | REQ-021–REQ-024, REQ-NFR-004 | D | model validates then emits Command::RunFlash |
| IF-012 `FlashJob::step` | `twinrunner-core::flash` | `twinrunner::worker` | REQ-023, REQ-024, REQ-NFR-005 | D | Worker drives; Verifying phase mandatory for Write |
| IF-013 `WorkerCommand` channel | `twinrunner::tui` (sender) | `twinrunner::worker` (receiver) | REQ-019, REQ-023, REQ-NFR-001 | C, D | Commands dispatched from model Command list by tui |
| IF-014 `WorkerEvent` channel | `twinrunner::worker` (sender) | `twinrunner::tui` (receiver; folds to Messages) | REQ-019, REQ-023, REQ-NFR-001, REQ-NFR-011 | C, D | Drained per-tick with try_recv; never blocking |
| IF-015 `model::update` | `twinrunner-core::model` | `twinrunner::tui` | REQ-NFR-006, REQ-NFR-011, all functional | Shell | Called once per Message; pure; runs only on UI thread |
| IF-016 `troubleshoot` stepper | `twinrunner-core::troubleshoot` | `twinrunner-core::model` | REQ-025, REQ-026 | D | |
| IF-017 `log::append` | `twinrunner-core::log` | `twinrunner-core::model` | REQ-027, REQ-031, REQ-NFR-007 | Shell | CPU-key redaction on every append; optional file mirror |
| IF-018 `clock::Clock` trait | `twinrunner-core::clock` | `twinrunner-core::build`, `twinrunner-core::flash`, `twinrunner-core::log` | REQ-NFR-005 | Shell | Display/audit only; never in checksums or progress (ADR-006) |
| FS-001 KeyLibrary file | `twinrunner-core::keys` (writer) | `twinrunner-core::keys` (reader on load) | REQ-009, REQ-012, REQ-014 | B | Sensitive at rest (CPU keys) — `08a` asset anchor |
| FS-002 Key import/export file | `twinrunner-core::keys` (export writer) | `keys` (import reader), User | REQ-014 | B | Sensitive (CPU keys) |
| FS-003 ConsoleInfo export | `twinrunner-core::nand` (via Command::WriteFile) | User | REQ-008 | A | Contains cpu_key when Present; sensitive field |
| FS-004 AppConfig file | User / `config` (writer on create) | `twinrunner-core::config` (reader at startup) | REQ-033 | Shell | No schema_version; missing fields fall back to defaults |
| FS-005 Log file | `twinrunner-core::log` (appender) | User, external tools | REQ-027, REQ-NFR-007 | Shell | Append-only JSON Lines; CPU-key material redacted |
| FS-006 BuildArtifact file | `twinrunner-core::build` (simulator writer) | User, `twinrunner-core::flash` (as flash source) | REQ-015, REQ-017, REQ-018 | C | Atomic write (temp + rename); binary |
| `WorkerEvent::Started` | `twinrunner::worker` | `twinrunner::tui` | REQ-019, REQ-023 | C, D | Exactly once per job; before any Progress |
| `WorkerEvent::Progress` | `twinrunner::worker` | `twinrunner::tui` | REQ-019, REQ-023, REQ-NFR-001 | C, D | Monotonic pct; zero or more per job |
| `WorkerEvent::Log` | `twinrunner::worker` | `twinrunner::tui` | REQ-027, REQ-031 | C, D | Redaction-safe entries |
| `WorkerEvent::Completed` | `twinrunner::worker` | `twinrunner::tui` | REQ-019, REQ-023 | C, D | Terminal; exactly one per succeeded job |
| `WorkerEvent::Failed` | `twinrunner::worker` | `twinrunner::tui` | REQ-024, REQ-NFR-011 | C, D | Terminal; includes recovery steps for flash failures; panic-safe |
| Domain events (in-process) | Various core modules | `twinrunner-core::log` / `model` | Various | All | Audit trail; not routed over channels |

**Orphaned-interface check:** All 18 module/trait interfaces and all 6 file schemas appear in both the Interface Index and this map with at least one consumer. No interface is produced but never consumed. The `Clock` trait (IF-018) has three consumers (`build`, `flash`, `log`). The domain events (in-process) are consumed by `log` (for audit) and `model` (for state transitions); they are not orphaned.

**Auth confirmation:** No auth-related interface, event, or schema exists in this system. TwinRunner is a single-user local tool with no network surface. This is explicit and complete.
