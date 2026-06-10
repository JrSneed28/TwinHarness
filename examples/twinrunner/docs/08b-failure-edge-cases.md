# Failure Modes & Edge-Case Design — TwinRunner

> **Stage F — Failure Modes & Edge-Case Design** (spec §15.F). Tier 3 / reliability-critical.
> GRADUATES from the folded `04-architecture.md` §Failure-Modes section because TwinRunner carries
> **data-integrity exposure** (the read-only source-dump invariant RULE-001/INV-001) and a
> **safety guarantee** (no real hardware write, RULE-006/INV-004). Streams; no human gate is
> required — TwinRunner's data-loss posture is **already settled by design**: copy-only on every
> output (RULE-001), atomic temp-file + rename on every persistent write (INV-001), and a fully
> simulated backend with **no real device state to recover** (REQ-NFR-004). Every failure mode below
> is anchored to a named component or named data flow from `04-architecture.md` /
> `06-technical-design.md` and reuses the contract error codes ERR-001…026 from `07-contracts.md`.

## Summary

TwinRunner is **filesystem-only and fully offline** — there is no network and no external service,
so the classic "dependency outage" surface here is the **local filesystem** and the **in-process
background worker thread**, not a remote API. The highest-risk components are `twinrunner-core::nand`
(it parses **untrusted binary** and must never panic — REQ-NFR-011) and the `build`/`flash`
simulators plus the `worker` bridge (a job that fails or panics must never crash the TUI). The
default failure posture is **fail-closed and typed**: every data-driven failure is a
`ValidationIssue` (ERR-001…026) or a terminal `WorkerEvent::Failed`, never a panic and never a
silent advance of a bad dump (RULE-002/003). The two persistent writers (`keys` library file FS-001,
`config` FS-004, `log` file FS-005, `build` output FS-006) use **temp-file + atomic rename** so an
interrupted write never corrupts the existing file. The source dump is opened **read-only** and is
never a write target (INV-001). Every failure mode in this document carries a named negative test in
§Negative-Tests Map.

- **Highest-risk component:** `twinrunner-core::nand` (untrusted-binary parse — must fail-closed, never panic) and the `worker` bridge (a failing job must never take down the TUI).
- **Default failure posture:** **fail-closed + typed** — every data-driven failure is a `ValidationIssue`/`WorkerEvent::Failed`; no panics on any data path (REQ-NFR-011); no silent advance of a bad dump (RULE-002/003).
- **Idempotency scope:** `nand::load/validate/extract`, `build` (same `BuildInputs` → same checksum, RULE-007), and `flash` verify (RULE-008) are idempotent by construction. Key import is id-deduped (existing id skipped). `WorkerCommand::Cancel`/`Shutdown` are idempotent no-ops. Build/flash **submission** is guarded non-idempotent (one-job-at-a-time).
- **Negative-test count:** **65** negative tests anchored in §Negative-Tests Map; **0** failure modes are tested manually only (the deterministic core is fully mechanically testable headless — REQ-NFR-006).

---

## Failure Catalog (per component/flow)

> Every entry names a component label from `04-architecture.md` or a data flow (Flow 1 / Flow 2 from
> §Data Flow) and maps to a negative test `test_REQ<###>_<slug>`. No entry is generic boilerplate.

### `twinrunner-core::nand` (parse / validate / extract — untrusted binary)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-001 | File length matches no `SizeClass` (zero-length / truncated / oversized / odd size) | Fail-closed: `ValidationIssue { Error, UnknownSize, target:"file length" }` (ERR-001); emit `DumpLoadFailed`; **do not proceed to `validate`** (RULE-009) | `test_REQ001_load_rejects_unknown_size` |
| FAIL-002 | OS open/read error (not found, permission denied) on `load` | `Error::Io` (ERR-026); surface path; allow retry; no `NandImage` created | `test_REQ001_load_io_error_surfaced` |
| FAIL-003 | Length matches a `SizeClass` but `FlashConfig` block absent/garbage | `ValidationIssue { Error, MissingFlashConfig, target:"FlashConfig" }` (ERR-002); image → `Invalid`; extraction blocked (RULE-002/003) | `test_REQ002_validate_missing_flashconfig` |
| FAIL-004 | FlashConfig present but implied ecc_type/page_size matches no known layout | `ValidationIssue { Error, UnknownLayout, target:"NandLayout" }` (ERR-003); image → `Invalid` | `test_REQ002_validate_unknown_layout` |
| FAIL-005 | ECC check fails on a region (bootloader / fuse / keyvault) | First failing region → `ValidationIssue { Error, EccFailure, target:"<region name>" }` (ERR-004); image → `Invalid`; **region is named**, never generic "corrupt" (RULE-003) | `test_REQ007_validate_ecc_failure_names_region` |
| FAIL-006 | `extract` called on an image not in `Validated` state | `ValidationIssue { Error, NotValidated }` (ERR-005); extraction refused (RULE-002); image never silently advanced | `test_REQ002_extract_requires_validated` |
| FAIL-007 | CPU-key region zeroed / masked / underivable | `cpu_key = Absent` (RULE-010); emit `CpuKeyAbsent`; **not an error**; never a zeroed/guessed key (INV-003) | `test_REQ006_extract_cpu_key_absent_not_guessed` |
| FAIL-008 | ConsoleType markers ambiguous | Non-blocking `ValidationIssue { Warning, ConsoleTypeUncertain }` (ERR-006); `console_type_certain=false`; size-class default used; extraction not blocked | `test_REQ003_extract_console_type_uncertain_warns` |
| FAIL-009 | Hostile/garbage bytes anywhere in the parse pipeline | Typed issue, **never a panic**; UI stays in a safe navigable state (REQ-NFR-011) | `test_REQ_NFR011_nand_never_panics_on_garbage` |

### `twinrunner-core::keys` (CpuKey + KeyLibrary + bind + import/export)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-010 | `CpuKey::parse` on non-32-hex / wrong-length / non-hex string | `ValidationIssue { Error, InvalidKeyFormat, target:"cpu_key" }` (ERR-007); record **not** created/persisted (RULE-004/014) | `test_REQ011_cpukey_parse_rejects_malformed` |
| FAIL-011 | KeyLibrary file (FS-001) missing on load (first run) | `ValidationIssue { Warning, LibraryMissing }` (ERR-008); return **empty** `KeyLibrary`; do not crash | `test_REQ012_library_load_missing_returns_empty` |
| FAIL-012 | KeyLibrary file exists but is not valid JSON / corrupt | `ValidationIssue { Warning, LibraryCorrupt }` (ERR-009); return empty library + surface warning; do not crash (REQ-NFR-011) | `test_REQ012_library_load_corrupt_does_not_crash` |
| FAIL-013 | KeyLibrary/import `schema_version` exceeds supported | `ValidationIssue { Error, SchemaVersionTooNew }` (ERR-010); refuse to load (no silent truncation); advise upgrade | `test_REQ012_library_schema_version_too_new_refused` |
| FAIL-014 | `bind` where KeyRecord identity conflicts with extracted `ConsoleInfo` | `BoundWithMismatchWarning { reasons }` (success, not error); UI must surface before accept; never silently bound (RULE-005) | `test_REQ013_bind_surfaces_mismatch_warning` |
| FAIL-015 | `edit`/`delete` for an id that does not exist | `ValidationIssue { Error, RecordNotFound, target:id }` (ERR-011); no mutation | `test_REQ013_edit_unknown_id_no_mutation` |
| FAIL-016 | KeyLibrary `save` interrupted mid-write (process killed) | Temp-file + atomic rename: existing FS-001 file is **either the last fully-committed version or unchanged** — never a half-written corrupt file (INV-001) | `test_REQ012_library_save_atomic_no_partial` |

### `twinrunner-core::build` (BuildBackend port + simulator)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-017 | `RealStubBuildBackend::prepare` called | `ValidationIssue { Error, NotImplemented }` (ERR-014); writes nothing; job not started (RULE-006/INV-004) | `test_REQ020_real_build_stub_never_acts` |
| FAIL-018 | `prepare` with source image not Validated/Extracted | `ValidationIssue { Error, ImageNotValidated }` (ERR-015); no `Pending` job (RULE-012) | `test_REQ015_build_prepare_requires_validated_source` |
| FAIL-019 | `prepare` with unknown `timing_file_id` | `ValidationIssue { Error, UnknownTimingFile }` (ERR-016); no job (RULE-012) | `test_REQ016_build_prepare_unknown_timing_file` |
| FAIL-020 | `output_path == source_image_path` | `ValidationIssue { Error, OutputEqualsSource }` (ERR-017); refused before any byte written (RULE-001/INV-001) | `test_REQ035_build_refuses_output_equals_source` |
| FAIL-021 | Filesystem write/rename fails mid build `step` (disk full / unwritable / permission denied) | `StepOutcome::Failed(WriteError)` (ERR-018); temp file removed; **no** file at output path; source untouched (INV-001) | `test_REQ015_build_write_error_leaves_no_partial` |

### `twinrunner-core::flash` (FlashBackend port + simulator + verify)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-022 | `RealStubFlashBackend::prepare` called | `ValidationIssue { Error, NotImplemented }` (ERR-014); real-write path does not exist (RULE-006/INV-004/REQ-NFR-004) | `test_REQ022_real_flash_stub_never_acts` |
| FAIL-023 | Write op with `image_path = None` | `ValidationIssue { Error, ImagePathRequired }` (ERR-020); no job (RULE-012) | `test_REQ021_flash_write_requires_image_path` |
| FAIL-024 | Programmer capacity != image SizeClass (Write) | `ValidationIssue { Error, SizeClassMismatch }` (ERR-021); no job | `test_REQ021_flash_size_class_mismatch_refused` |
| FAIL-025 | Programmer not in Connected state | `ValidationIssue { Error, ProgrammerDisconnected }` (ERR-022); no job | `test_REQ021_flash_disconnected_programmer_refused` |
| FAIL-026 | Verify-after-write: written bytes != intended bytes (or induced fixture) | `StepOutcome::Failed { VerifyMismatch }` (ERR-023) → `Failed` with **non-empty fixture-backed `RecoveryStep`s** (REQ-024); a Write never reaches `Succeeded` without passing `Verifying` (REQ-023) | `test_REQ023_flash_verify_mismatch_populates_recovery` |

### `twinrunner::worker` (background thread + channel bridge) — the in-process "dependency"

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-027 | A job panics / errors on the background worker thread | Worker **catches** the panic, converts to terminal `WorkerEvent::Failed { error, recovery_steps }`; the panic never unwinds across the thread boundary; the TUI never crashes (REQ-NFR-011) | `test_REQ_NFR011_worker_job_panic_becomes_failed_event` |
| FAIL-028 | Worker thread channel disconnects (sender/receiver dropped) mid-job | The `tui` per-tick `try_recv` drain observes `Disconnected`; surfaces it as a terminal job failure and **does not hang** the event loop (REQ-NFR-001/011) | `test_REQ_NFR011_worker_channel_disconnect_no_hang` |

### `twinrunner-core::model` (reducer / orchestration seam)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-029 | `StartBuild`/`StartFlash` precondition violation (RULE-002/012) | No `Command`; write `ValidationIssue` into `Model.pending_issues` for UI display; reducer stays pure | `test_REQ_NFR006_reducer_rejects_start_precondition` |
| FAIL-030 | Second `Start*` while a job is already active | Rejected into Model as a "one job at a time" notice; **no** command dispatched (INV-007) | `test_REQ_NFR001_reducer_rejects_concurrent_job` |
| FAIL-031 | A stale `WorkerEvent` (`JobProgressed`/`JobCompleted`) for a job no longer active arrives after navigation | Folded into the Model job slot (job state is screen-independent); never dropped, never panics; no invalid transition applied | `test_REQ_NFR011_reducer_tolerates_stale_worker_event` |

### `twinrunner-core::troubleshoot` (fixture-backed flow stepper)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-032 | `advance(response)` with a response **not declared** on the current step | `ValidationIssue { Error, UndeclaredResponse }` (ERR-024); session stays `AtStep`; no dynamic edge created (RULE-013) | `test_REQ026_advance_rejects_undeclared_response` |
| FAIL-033 | `advance`/`back` called before `start` | `ValidationIssue { Error, SessionNotStarted }` (ERR-025); do not advance | `test_REQ025_advance_before_start_refused` |
| FAIL-034 | Bundled flow fixtures missing/unloadable at `load_flows()` | Return empty `Vec` + logged error; session simply offers no flows; no crash | `test_REQ025_load_flows_missing_fixtures_no_crash` |

### `twinrunner-core::log` (append-only ActionLog + file mirror)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-035 | Log file (FS-005) mirror write fails (unwritable / disk full / permission denied) | **Degrade to in-memory `ActionLog` only** + a Warning entry; file-logging failure is **never fatal** (REQ-NFR-007/011); the app does not crash | `test_REQ_NFR007_log_file_unwritable_degrades_in_memory` |
| FAIL-036 | Raw 32-hex CPU-key material present in a log `message`/`payload` | Redacted to `REDACTED_CPU_KEY` **before** store/mirror; a 64-hex SHA-256 / shorter CRC is **not** redacted (exact-32 word-boundary match, INV-006) | `test_REQ_NFR007_log_redacts_cpu_key_not_checksum` |

### `twinrunner-core::config` (AppConfig)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-037 | Config file (FS-004) missing / invalid field value / invalid UTF-8 path | Per-field fallback to default; create dirs on first run; **never abort startup** (REQ-033) | `test_REQ033_config_invalid_field_falls_back_to_default` |

### `twinrunner::tui` (shell / event loop / render)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-038 | Terminal smaller than the minimum (below 80×24) | Render the "terminal too small" degraded screen instead of laying out widgets; **no crash** (REQ-034/REQ-NFR-009) | `test_REQ034_tui_too_small_terminal_degraded_screen` |
| FAIL-039 | Resize event mid-render | Fold `Resize(w,h)` into the reducer, recompute layout-affecting state, re-render; no panic, no torn frame | `test_REQ034_tui_resize_relayouts_without_crash` |

---

## Invalid Input

> Per **untrusted** boundary, the exact defined response. The only untrusted inputs in TwinRunner are
> **file content** (dump files, key-import files, library/config files on disk) — there is no network
> and the local user/keyboard is trusted. Each row reuses a contract error code.

| Component | Invalid input class | Expected behavior | Negative test anchor |
|-----------|--------------------|--------------------|---------------------|
| `twinrunner-core::nand` (`load`) | File length ≠ any of {16,64,256,512}MB exact byte counts | Reject with `UnknownSize` (ERR-001); do not advance to `validate` (RULE-009) | `test_REQ001_load_rejects_unknown_size` |
| `twinrunner-core::nand` (`load`) | Zero-length / truncated file | Length mismatch path → `UnknownSize` (ERR-001); no `NandImage` | `test_REQ001_load_rejects_truncated_file` |
| `twinrunner-core::nand` (`validate`) | Correct size, garbage content (no FlashConfig) | `MissingFlashConfig` (ERR-002); image `Invalid`; extraction blocked | `test_REQ002_validate_missing_flashconfig` |
| `twinrunner-core::nand` (`validate`) | Correct size, FlashConfig present, ECC corrupt in a region | `EccFailure` naming the region (ERR-004); image `Invalid` (RULE-003) | `test_REQ007_validate_ecc_failure_names_region` |
| `twinrunner-core::keys` (`CpuKey::parse`) | Not 32 chars / non-hex / wrong length | `InvalidKeyFormat` (ERR-007); record not created (RULE-004) | `test_REQ011_cpukey_parse_rejects_malformed` |
| `twinrunner-core::keys` (`import`) | Import file not valid JSON / schema_version unknown | `InvalidImportFormat` (ERR-013); **entire import rejected**; library unchanged | `test_REQ014_import_invalid_format_rejected_wholesale` |
| `twinrunner-core::keys` (`import`) | Individual record's `cpu_key` fails format check | **Per-record** skip with `Warning, InvalidKeyFormat` (ERR-007); import continues; counts in `ImportResult.skipped` | `test_REQ014_import_skips_bad_record_continues` |
| `twinrunner-core::keys` (`import`) | Import file does not exist | `FileNotFound` (ERR-012); allow retry; library unchanged | `test_REQ014_import_missing_file_surfaced` |
| `twinrunner-core::config` (`load`) | Invalid field value (e.g. `build_backend="Unknown"`) | Field-level fallback to default + startup Warning; never abort (REQ-033) | `test_REQ033_config_invalid_field_falls_back_to_default` |

---

## Duplicates/Idempotency

> For each replayable operation: whether it is idempotent and the enforcement. TwinRunner's
> determinism rules (RULE-007/008) make the core idempotent **by construction**; the only guarded
> non-idempotent operation is job submission (one-job-at-a-time).

| Operation | Component | Idempotent? | Enforcement mechanism | Negative test anchor |
|-----------|-----------|------------|----------------------|---------------------|
| Re-run build with same `BuildInputs` | `twinrunner-core::build` | **Yes** | Same canonical clock-free input set → identical `checksum` every run (RULE-007); path excluded from checksum; source never touched | `test_REQ019_build_same_inputs_same_checksum` |
| Re-run flash verify with same op + bytes | `twinrunner-core::flash` | **Yes** | Same progress sequence, verify result, log every run (RULE-008); no wall-clock in the sequence (ADR-006) | `test_REQ023_flash_verify_deterministic_replay` |
| Re-run `nand::load/validate/extract` on same file | `twinrunner-core::nand` | **Yes** | Pure function of input bytes; read-only open is the only side effect | `test_REQ002_nand_pipeline_idempotent` |
| Re-import the same key-export file (FS-002) | `twinrunner-core::keys` | **Yes (id-deduped)** | Records whose `id` already exists in the library are **skipped** (no overwrite); on a fresh import `updated_at` is set to `created_at` per FS-002 round-trip rule | `test_REQ014_reimport_skips_existing_ids` |
| Submit a second build/flash while one is active | `twinrunner-core::model` + `twinrunner::worker` | **No — guarded** | (a) reducer refuses a second `Start*` while `active_job.is_some()`; (b) worker holds a single active-job slot and ignores a `Start*` while busy (defense in depth, INV-007) | `test_REQ_NFR001_reducer_rejects_concurrent_job` |
| `WorkerCommand::Cancel` with no active job | `twinrunner::worker` | **Yes** | No-op when the active slot is empty | `test_REQ019_cancel_no_active_job_is_noop` |
| `WorkerCommand::Shutdown` sent twice | `twinrunner::worker` | **Yes** | Second `Shutdown` after the loop exits is a no-op | `test_REQ_NFR011_double_shutdown_is_noop` |

---

## Partial Failure

> Multi-step operations where step N succeeds and N+1 fails. TwinRunner has **no distributed
> writes** (single process, local FS), so partial failure is **mid-job interruption** of a build /
> flash and **mid-write interruption** of a persistent file. The invariant in every case: the source
> dump is untouched (INV-001) and no half-written persistent file survives (atomic temp+rename).

| Operation | Failure point | Recovery strategy | Invariants preserved | Negative test anchor |
|-----------|--------------|-------------------|---------------------|---------------------|
| `build` job stepped by `worker` | Cancel or error between steps, before final rename | Drop the partial job; the simulator writes to a **temp file** and only renames into the output path on success — a cancel/failure removes the temp file and leaves **no** file at `output_path` | Source dump byte-identical (INV-001); output path has no partial artifact; retry is a brand-new job | `test_REQ015_build_cancel_leaves_no_partial_artifact` |
| `build` job final write/rename | Rename to `output_path` fails (FS error) | `StepOutcome::Failed(WriteError)` (ERR-018); temp removed | No partial at `output_path`; source untouched | `test_REQ015_build_write_error_leaves_no_partial` |
| `flash` Write job stepped by `worker` | Cancel between steps before `Verifying` | Terminal `Failed { Cancelled }` (ERR-019); recovery_steps may be empty (clean cancel, not a device failure) — simulated, **no real device state** to roll back | `Programmer` is simulated; no persistent side effect; UI clears active-job slot | `test_REQ019_flash_cancel_clean_no_device_state` |
| `keys::save` (FS-001) | Process killed mid-write | Temp-file + atomic rename: existing library file is the last fully-committed version or unchanged | FS-001 never corrupt/half-written (INV-001) | `test_REQ012_library_save_atomic_no_partial` |
| `config` create-on-first-run + `log` file mirror | Process killed mid-write | `config` uses atomic write; `log` file (FS-005, JSON Lines) tolerates a **trailing incomplete line** on read (skip the last line if not valid JSON) | Existing config never corrupt; log readers skip the torn last line | `test_REQ_NFR007_log_file_tolerates_torn_last_line` |

---

## Dependency Outage

> **There is no network and no external service** (REQ-NFR-005). The only "dependencies" that can
> become unavailable are the **local filesystem** and the **in-process worker thread**. This section
> is framed accordingly — disk-full / unwritable / permission-denied, and worker-thread death.

| Dependency | Component that depends on it | Outage behavior | Detection / policy | Negative test anchor |
|------------|-----------------------------|-----------------|--------------------|---------------------|
| Filesystem — `build` output path | `twinrunner-core::build` | **Fail-closed:** `StepOutcome::Failed(WriteError)` (ERR-018); temp removed; no partial; source intact | Write/rename returns an OS error; treated as terminal job failure; **no retry loop** (a single local user can fix the path and re-run) | `test_REQ015_build_write_error_leaves_no_partial` |
| Filesystem — `flash` (simulated output / read) | `twinrunner-core::flash` | **Fail-closed:** terminal `Failed`; fixture-backed recovery steps surfaced where the op warrants them | OS error on the simulated write/read path | `test_REQ023_flash_fs_error_terminal_failure` |
| Filesystem — KeyLibrary file (FS-001) | `twinrunner-core::keys` | **Load:** missing → empty library (ERR-008); corrupt → empty + Warning (ERR-009). **Save:** I/O error (ERR-026) surfaced; **in-memory library unchanged** | Detected on open/parse; save failure does not lose in-memory state | `test_REQ012_library_load_corrupt_does_not_crash` |
| Filesystem — log file (FS-005) | `twinrunner-core::log` | **Degrade, do not fail:** drop to in-memory `ActionLog` + a Warning entry; **never crash** (REQ-NFR-007/011) | Mirror write error caught; file logging is best-effort | `test_REQ_NFR007_log_file_unwritable_degrades_in_memory` |
| Filesystem — config dir on first run | `twinrunner-core::config` | Create dirs on first run; if creation fails, fall back to defaults / in-memory; never abort startup (REQ-033) | Dir-create error caught at startup | `test_REQ033_config_dir_create_failure_uses_defaults` |
| In-process worker thread | `twinrunner::worker` / `twinrunner::tui` | Worker **panic** caught → terminal `WorkerEvent::Failed` (REQ-NFR-011). Channel **disconnect** detected by the per-tick `try_recv` drain → surfaced as job failure; the event loop **does not hang** (REQ-NFR-001) | Panic boundary inside the worker loop; `try_recv` returns `Disconnected` | `test_REQ_NFR011_worker_job_panic_becomes_failed_event` |

---

## Crash/Restart Recovery

> What is durable vs. lost on a process restart, and the invariant that must hold afterward. Because
> all risky operations are **simulated** (REQ-NFR-004), there is **no real device or in-flight
> hardware state** to recover — an interrupted job simply vanishes, which is acceptable and safe.

| Component | In-flight state (lost on crash) | Durability guarantee | Recovery action on restart | Negative test anchor |
|-----------|--------------------------------|---------------------|---------------------------|---------------------|
| `twinrunner-core::model` (`Session`) | The whole in-memory `Session`: active `NandImage`, in-flight `BuildJob`/`FlashJob`, `ActionLog`, job history (DQ-003: jobs are session-scoped) | None — `Session` is intentionally session-scoped | Fresh `Session`; user re-loads a dump and re-runs any job. No partial artifact exists (atomic build write). **Safe — simulated, no device state** | `test_REQ033_restart_starts_fresh_session` |
| `twinrunner-core::keys` (`KeyLibrary`) | None — library is persisted on **every** mutating op, not at exit | FS-001 written atomically (temp+rename) on every add/edit/delete/import | Re-read FS-001 at startup; **invariant: the file is either the last fully-committed library or the prior one — never a corrupt partial** (INV-001) | `test_REQ012_library_survives_crash_no_corruption` |
| `twinrunner-core::config` (`AppConfig`) | None — config is read-only at startup | FS-004 (TOML) is user-owned; written atomically if created | Re-read FS-004 (or defaults if missing/invalid); never blocks startup (REQ-033) | `test_REQ033_config_reloads_or_defaults_after_restart` |
| `twinrunner-core::log` (`ActionLog`) | In-memory `ActionLog` lost (session-scoped, DQ-001); only the optional FS-005 file mirror is durable | FS-005 is append-only JSON Lines | New session starts an empty `ActionLog`; FS-005 file readers tolerate a torn trailing line (skip if not valid JSON) | `test_REQ_NFR007_log_file_tolerates_torn_last_line` |
| `twinrunner-core::build` (output artifact) | An in-flight build's temp file | Final artifact only renamed into place on success (INV-001) | On restart, any orphaned temp file is not the output path; the source is intact; user re-runs (deterministic → byte-identical, RULE-007) | `test_REQ015_build_crash_no_partial_at_output_path` |

---

## Race Conditions

> The architecture's primary race-avoidance design is **message-passing with no shared mutable
> domain state** across threads (ADR-002/003): the `model` reducer runs **only** on the UI thread,
> the `worker` runs all job stepping, and they communicate solely over `std::sync::mpsc` channels.
> This is stated below as the resolution for the cross-thread race. The remaining named race is two
> TwinRunner instances editing the same KeyLibrary file.

| Race scenario | Components involved | Guard mechanism | Failure mode if guard absent | Negative test anchor |
|---------------|--------------------|-----------------|-----------------------------|---------------------|
| UI thread vs. worker thread touching shared state | `twinrunner-core::model`, `twinrunner::worker` | **No shared mutable state** — message-passing only (ADR-002/003); the reducer is never called from the worker; the Model needs no locks. This is the primary race-avoidance design | Data race / torn Model reads — **structurally impossible** by the message-passing design | `test_REQ_NFR006_reducer_only_runs_on_ui_thread` |
| Double-submit of a build/flash (rapid key presses) | `twinrunner-core::model`, `twinrunner::worker` | One-job-at-a-time: reducer refuses a second `Start*` while a job is active; worker ignores a `Start*` while its slot is full (INV-007) | Two jobs running, interleaved output, ambiguous active-job state | `test_REQ_NFR001_reducer_rejects_concurrent_job` |
| **Two TwinRunner instances editing the same KeyLibrary file (FS-001)** | `twinrunner-core::keys` (two processes) | **Resolution: last-write-wins, accepted as benign/residual.** Each process writes the full library atomically (temp+rename), so the file is **never corrupted** — the loser's edits are simply overwritten by the later atomic write. No file locking in MVP (single-user local tool; concurrent instances are an unusual case). See §Residual Risks RES-001 | Without atomic rename, an interleaved write could corrupt FS-001 — **prevented** by the atomic-rename guard even though edits may be lost | `test_REQ012_concurrent_library_write_atomic_no_corruption` |
| Worker event ordering for one job | `twinrunner::worker`, `twinrunner::tui` | Single-writer FIFO mpsc: `Started → Progress* → (Completed\|Failed)`, monotonic pct, terminal is last (INV-007) | Out-of-order progress, terminal-before-progress, lost completion | `test_REQ019_worker_events_ordered_per_job` |

---

## Unexpected States

> For each state machine in `06-technical-design.md` (`NandImage`, `BuildJob`, `FlashJob`,
> `KeyRecord`, `TroubleshootingFlow`), plus the TUI render surface: an invalid transition, a stale
> event, or a corrupt persisted value is **detected, logged, and fails closed — never a panic**
> (REQ-NFR-011).

| Unexpected state | Detected by | Detection point (`<component-label>`) | Recovery action | Negative test anchor |
|-----------------|-------------|---------------------------------------|-----------------|---------------------|
| `extract` attempted from `Unvalidated`/`Validating`/`Invalid` (`NandImage` invalid transition) | State-guard precondition | `twinrunner-core::nand` / `twinrunner-core::model` | Refuse with `NotValidated` (ERR-005); image never silently advanced (RULE-002/003) | `test_REQ002_extract_requires_validated` |
| A `WorkerEvent` arrives for a `job_id` that is not the active job (stale terminal/progress after navigation) | Job-id check in the reducer | `twinrunner-core::model` | Fold into the job slot if it is the tracked job; otherwise ignore the stale event; **never apply an invalid transition, never panic** | `test_REQ_NFR011_reducer_tolerates_stale_worker_event` |
| `BuildJob` reaching a non-terminal step after `Succeeded`/`Failed` | Terminal-state guard | `twinrunner-core::build` | Reject further `step()` after terminal; exactly one terminal outcome (INV-007) | `test_REQ019_build_no_step_after_terminal` |
| `FlashJob` Write reaching `Succeeded` **without** passing `Verifying` | Lifecycle guard | `twinrunner-core::flash` | Forbidden transition — a Write must pass `Verifying` (REQ-023); enforced in the state machine | `test_REQ023_flash_write_must_verify_before_success` |
| `KeyRecord` persisted while not `ValidatedFormat` (corrupt/unverified) | Persist-time guard | `twinrunner-core::keys` | Refuse to persist non-`ValidatedFormat` records (RULE-014); on load, records failing the 32-hex check are skipped with a Warning | `test_REQ011_library_skips_unverified_records_on_load` |
| Corrupt persisted enum in FS-001 (e.g. unknown `console_type` string) | Schema validation on load | `twinrunner-core::keys` | Coerce unknown `console_type` to null + Warning; do not crash (FS-001 validation rules) | `test_REQ012_library_unknown_console_type_coerced_null` |
| `TroubleshootingFlow` `advance` to an undeclared edge (graph violation) | Declared-response check | `twinrunner-core::troubleshoot` | `UndeclaredResponse` (ERR-024); stay `AtStep`; no dynamic edge (RULE-013) | `test_REQ026_advance_rejects_undeclared_response` |
| Terminal below minimum size / resize mid-render (impossible-to-lay-out state) | Size check in the render path | `twinrunner::tui` | Render "terminal too small" degraded screen; re-layout on resize; no crash (REQ-034/REQ-NFR-009) | `test_REQ034_tui_too_small_terminal_degraded_screen` |

---

## Negative-Tests Map

> Consolidated map of every negative test in this document. These names follow the
> `test_REQ<###>_<slug>` convention so `th coverage check` and `08-test-strategy.md` can scan for
> them. **0** failure modes are tested manually only — the deterministic core is fully mechanically
> testable headless (REQ-NFR-006). **65** distinct negative tests cover the 39 Failure Catalog entries
> plus the per-section invalid-input, idempotency, partial-failure, dependency-outage, crash/restart,
> race, and unexpected-state rows; every test name in this table is unique.

| Test name | Failure mode (FAIL-ID) | Component / flow | REQ-ID |
|-----------|----------------------|-----------------|--------|
| `test_REQ001_load_rejects_unknown_size` | FAIL-001 | `twinrunner-core::nand` | REQ-001 |
| `test_REQ001_load_rejects_truncated_file` | FAIL-001 | `twinrunner-core::nand` | REQ-001 |
| `test_REQ001_load_io_error_surfaced` | FAIL-002 | `twinrunner-core::nand` | REQ-001 |
| `test_REQ002_validate_missing_flashconfig` | FAIL-003 | `twinrunner-core::nand` | REQ-002 |
| `test_REQ002_validate_unknown_layout` | FAIL-004 | `twinrunner-core::nand` | REQ-002 |
| `test_REQ007_validate_ecc_failure_names_region` | FAIL-005 | `twinrunner-core::nand` | REQ-007 |
| `test_REQ002_extract_requires_validated` | FAIL-006 / unexpected-state | `twinrunner-core::nand` / `model` | REQ-002 |
| `test_REQ006_extract_cpu_key_absent_not_guessed` | FAIL-007 | `twinrunner-core::nand` | REQ-006 |
| `test_REQ003_extract_console_type_uncertain_warns` | FAIL-008 | `twinrunner-core::nand` | REQ-003 |
| `test_REQ_NFR011_nand_never_panics_on_garbage` | FAIL-009 | `twinrunner-core::nand` | REQ-NFR-011 |
| `test_REQ002_nand_pipeline_idempotent` | idempotency | `twinrunner-core::nand` | REQ-002 |
| `test_REQ011_cpukey_parse_rejects_malformed` | FAIL-010 | `twinrunner-core::keys` | REQ-011 |
| `test_REQ012_library_load_missing_returns_empty` | FAIL-011 | `twinrunner-core::keys` | REQ-012 |
| `test_REQ012_library_load_corrupt_does_not_crash` | FAIL-012 | `twinrunner-core::keys` | REQ-012 |
| `test_REQ012_library_schema_version_too_new_refused` | FAIL-013 | `twinrunner-core::keys` | REQ-012 |
| `test_REQ013_bind_surfaces_mismatch_warning` | FAIL-014 | `twinrunner-core::keys` | REQ-013 |
| `test_REQ013_edit_unknown_id_no_mutation` | FAIL-015 | `twinrunner-core::keys` | REQ-013 |
| `test_REQ012_library_save_atomic_no_partial` | FAIL-016 / partial-failure | `twinrunner-core::keys` | REQ-012 |
| `test_REQ012_library_survives_crash_no_corruption` | crash/restart | `twinrunner-core::keys` | REQ-012 |
| `test_REQ012_library_unknown_console_type_coerced_null` | unexpected-state | `twinrunner-core::keys` | REQ-012 |
| `test_REQ011_library_skips_unverified_records_on_load` | unexpected-state | `twinrunner-core::keys` | REQ-011 |
| `test_REQ014_import_invalid_format_rejected_wholesale` | invalid-input | `twinrunner-core::keys` | REQ-014 |
| `test_REQ014_import_skips_bad_record_continues` | invalid-input | `twinrunner-core::keys` | REQ-014 |
| `test_REQ014_import_missing_file_surfaced` | invalid-input | `twinrunner-core::keys` | REQ-014 |
| `test_REQ014_reimport_skips_existing_ids` | idempotency | `twinrunner-core::keys` | REQ-014 |
| `test_REQ012_concurrent_library_write_atomic_no_corruption` | race RES-001 | `twinrunner-core::keys` | REQ-012 |
| `test_REQ020_real_build_stub_never_acts` | FAIL-017 | `twinrunner-core::build` | REQ-020 |
| `test_REQ015_build_prepare_requires_validated_source` | FAIL-018 | `twinrunner-core::build` | REQ-015 |
| `test_REQ016_build_prepare_unknown_timing_file` | FAIL-019 | `twinrunner-core::build` | REQ-016 |
| `test_REQ035_build_refuses_output_equals_source` | FAIL-020 | `twinrunner-core::build` | REQ-035 |
| `test_REQ015_build_write_error_leaves_no_partial` | FAIL-021 / partial / outage | `twinrunner-core::build` | REQ-015 |
| `test_REQ015_build_cancel_leaves_no_partial_artifact` | partial-failure | `twinrunner-core::build` | REQ-015 |
| `test_REQ015_build_crash_no_partial_at_output_path` | crash/restart | `twinrunner-core::build` | REQ-015 |
| `test_REQ019_build_same_inputs_same_checksum` | idempotency | `twinrunner-core::build` | REQ-019 |
| `test_REQ019_build_no_step_after_terminal` | unexpected-state | `twinrunner-core::build` | REQ-019 |
| `test_REQ022_real_flash_stub_never_acts` | FAIL-022 | `twinrunner-core::flash` | REQ-022 |
| `test_REQ021_flash_write_requires_image_path` | FAIL-023 | `twinrunner-core::flash` | REQ-021 |
| `test_REQ021_flash_size_class_mismatch_refused` | FAIL-024 | `twinrunner-core::flash` | REQ-021 |
| `test_REQ021_flash_disconnected_programmer_refused` | FAIL-025 | `twinrunner-core::flash` | REQ-021 |
| `test_REQ023_flash_verify_mismatch_populates_recovery` | FAIL-026 | `twinrunner-core::flash` | REQ-023 |
| `test_REQ023_flash_verify_deterministic_replay` | idempotency | `twinrunner-core::flash` | REQ-023 |
| `test_REQ023_flash_fs_error_terminal_failure` | outage | `twinrunner-core::flash` | REQ-023 |
| `test_REQ019_flash_cancel_clean_no_device_state` | partial-failure | `twinrunner-core::flash` | REQ-019 |
| `test_REQ023_flash_write_must_verify_before_success` | unexpected-state | `twinrunner-core::flash` | REQ-023 |
| `test_REQ_NFR011_worker_job_panic_becomes_failed_event` | FAIL-027 / outage | `twinrunner::worker` | REQ-NFR-011 |
| `test_REQ_NFR011_worker_channel_disconnect_no_hang` | FAIL-028 | `twinrunner::worker` / `tui` | REQ-NFR-011 |
| `test_REQ_NFR001_reducer_rejects_concurrent_job` | FAIL-030 / idempotency / race | `twinrunner-core::model` / `worker` | REQ-NFR-001 |
| `test_REQ019_cancel_no_active_job_is_noop` | idempotency | `twinrunner::worker` | REQ-019 |
| `test_REQ_NFR011_double_shutdown_is_noop` | idempotency | `twinrunner::worker` | REQ-NFR-011 |
| `test_REQ019_worker_events_ordered_per_job` | race / ordering | `twinrunner::worker` / `tui` | REQ-019 |
| `test_REQ_NFR006_reducer_rejects_start_precondition` | FAIL-029 | `twinrunner-core::model` | REQ-NFR-006 |
| `test_REQ_NFR011_reducer_tolerates_stale_worker_event` | FAIL-031 / unexpected-state | `twinrunner-core::model` | REQ-NFR-011 |
| `test_REQ_NFR006_reducer_only_runs_on_ui_thread` | race | `twinrunner-core::model` / `worker` | REQ-NFR-006 |
| `test_REQ026_advance_rejects_undeclared_response` | FAIL-032 / unexpected-state | `twinrunner-core::troubleshoot` | REQ-026 |
| `test_REQ025_advance_before_start_refused` | FAIL-033 | `twinrunner-core::troubleshoot` | REQ-025 |
| `test_REQ025_load_flows_missing_fixtures_no_crash` | FAIL-034 | `twinrunner-core::troubleshoot` | REQ-025 |
| `test_REQ_NFR007_log_file_unwritable_degrades_in_memory` | FAIL-035 / outage | `twinrunner-core::log` | REQ-NFR-007 |
| `test_REQ_NFR007_log_redacts_cpu_key_not_checksum` | FAIL-036 | `twinrunner-core::log` | REQ-NFR-007 |
| `test_REQ_NFR007_log_file_tolerates_torn_last_line` | partial / crash | `twinrunner-core::log` | REQ-NFR-007 |
| `test_REQ033_config_invalid_field_falls_back_to_default` | FAIL-037 / invalid-input | `twinrunner-core::config` | REQ-033 |
| `test_REQ033_config_dir_create_failure_uses_defaults` | outage | `twinrunner-core::config` | REQ-033 |
| `test_REQ033_config_reloads_or_defaults_after_restart` | crash/restart | `twinrunner-core::config` | REQ-033 |
| `test_REQ033_restart_starts_fresh_session` | crash/restart | `twinrunner-core::model` | REQ-033 |
| `test_REQ034_tui_too_small_terminal_degraded_screen` | FAIL-038 / unexpected-state | `twinrunner::tui` | REQ-034 |
| `test_REQ034_tui_resize_relayouts_without_crash` | FAIL-039 | `twinrunner::tui` | REQ-034 |

---

## Residual Risks

> Failure modes accepted without a hard guard, with explicit rationale. These are the **only**
> places where TwinRunner does not fully prevent a failure — each is a deliberate, low-impact choice
> for a single-user local tool, and **none is a data-loss tradeoff requiring a human gate** (the
> data-loss posture is settled: copy-only RULE-001, atomic writes INV-001, simulated backend).

- **RES-001 — Two TwinRunner instances editing the same KeyLibrary file (FS-001): last-write-wins.**
  Concurrent instances are an unusual case for a single-user local tool, and there is **no file
  locking in MVP**. The chosen resolution is **last-write-wins, accepted as benign**: because each
  process writes the full library **atomically** (temp + rename), the file is **never corrupted** —
  the only consequence is that the later writer's snapshot overwrites the earlier one's edits. This
  is not a corruption risk (the atomic-rename guard prevents that) and not a hardware-safety risk;
  it is at worst a lost-edit in a rare multi-instance scenario. Mitigation if it ever matters
  (Future Scope): an mtime/advisory-lock check before save, or a `last_modified` reconcile prompt.
  Anchored test: `test_REQ012_concurrent_library_write_atomic_no_corruption` proves no corruption
  under interleaved atomic writes.

- **RES-002 — Build/flash artifact accuracy is bounded to the bundled fixtures (ARCH-RISK-003).**
  The `nand` parser and the simulators are deterministic against the documented example layout, not
  full Xbox-360 fidelity. A real-world dump outside the fixture corpus may be reported with a
  `ConsoleTypeUncertain` Warning or absent fields rather than rejected. Accepted because this is a
  **simulated example tool**; the failure mode is honest under-reporting (flagged uncertain), never
  a silent wrong claim. No data-loss; no human gate.

- **RES-003 — `log` file mirror is best-effort.** If FS-005 becomes unwritable mid-session, log
  lines for that window exist only in the in-memory `ActionLog` and are lost on exit (the in-memory
  log is session-scoped, DQ-001). Accepted because file logging is opt-in and explicitly best-effort
  (REQ-NFR-007); the alternative (failing the operation on a log-write error) would violate
  REQ-NFR-011. No human gate.

**Data-loss tradeoff requiring a human gate: NONE.** TwinRunner's data-loss posture is fully settled
by design — copy-only outputs (RULE-001/INV-001), atomic temp+rename on every persistent write, and
a simulated backend with no real device state to lose. The only "lost data" path is RES-001's rare
multi-instance lost-edit, which is benign (no corruption) and listed as residual, not gated.
