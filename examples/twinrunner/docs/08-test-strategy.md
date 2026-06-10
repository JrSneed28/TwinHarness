# Test Strategy — TwinRunner

> **Stage 8 — Test Strategy** (spec §15.8). Tiers: T2, T3. Streams; asks the human about
> quality bars only where they are real tradeoffs (coverage targets, performance SLOs).
> Mechanically enforced by `th coverage check`: every MVP REQ-ID must map to ≥1 anchored
> test; every slice in the REQ Coverage Map must have ≥1 passing anchored test; any gap is
> a blocking failure before Stage 9 may proceed.

## Summary

TwinRunner's correctness proof is **unit-heavy on the pure core library** (`twinrunner-core`) with
**integration tests for the worker-channel protocol** and **contract tests for the trait ports**
(`BuildBackend`, `FlashBackend`, `Clock`). The TUI shell is tested via the **state↔render seam**
(REQ-NFR-006): every screen is verified by feeding `Message`s into `model::update` and asserting
the resulting `Model` — no live terminal is ever required. Property-based fuzzing (proptest) covers
the `nand` parser against arbitrary bytes to prove it never panics (THR-003/004). Determinism tests
assert that identical `BuildInputs` / `FlashJob` sequences always produce identical checksums
(RULE-007/008). The 65 negative tests already defined in `08b-failure-edge-cases.md` are the
exhaustive negative/failure-mode layer; positive behavioral tests cover the remaining 44 MVP
REQ-IDs. The project-level Definition of Done is mechanical: `cargo test` green on all crates AND
`th coverage check` exits 0.

- **Test pyramid shape:** unit-heavy (pure core functions dominate) + targeted integration
  (worker channel + filesystem round-trips) + contract (trait ports + FS schemas)
- **Coverage gate:** every MVP REQ-ID maps to ≥1 anchored test (`th coverage check`); target
  ≥85% line coverage on `twinrunner-core`; ≥60% on `twinrunner` (TUI shell is intentionally
  harder to cover headlessly)
- **Slice acceptance signal:** end-to-end behavioral acceptance tests for the slice's capability
  area pass; `th coverage check` green with no new gaps

---

## Test Philosophy

TwinRunner's suite exists to prove three things: that the NAND parse/validate/extract pipeline
is accurate and safe on all inputs (including adversarial bytes), that the simulated backend ports
never leak a real hardware-write path, and that the Elm-style reducer correctly orchestrates all
state transitions regardless of the order events arrive. The core library (`twinrunner-core`) is
**terminal-free and side-effect-isolated**, so unit tests cover the vast majority of functional
behavior without stubs, mocks, or live terminal setup — a direct consequence of the state↔render
separation mandated by REQ-NFR-006. Integration tests prove the worker-thread channel protocol
(the only cross-thread boundary, ADR-002) and filesystem round-trips (the only external-state
boundary). Contract tests prove that the two trait ports (`BuildBackend`, `FlashBackend`) are
satisfied by the simulator adapter and cleanly refused by the no-op stub — the mechanical
enforcement of REQ-NFR-004. Every MVP REQ-ID (§11) maps to at least one named `test_REQ*` anchor
so `th coverage check` can scan the `tests/` tree and declare a gap before any slice is declared
done; no REQ-ID is covered only by human inspection.

---

## Test Levels & Rationale

### Unit Tests

**What is covered:** Pure functions inside `twinrunner-core` — `nand` load/validate/extract,
`keys::CpuKey::parse`, `KeyLibrary` CRUD and search, `build` and `flash` simulator step
sequences, `model::update` reducer for every `Message` variant, `troubleshoot` flow stepper
transitions, `log` append and CPU-key redaction, `config` field-level default fallback.

**Tools:** `cargo test` with Rust's built-in `#[test]` attribute. Tests live in-crate in
`#[cfg(test)]` modules inside `twinrunner-core/src/`.

**What unit tests do NOT cover:** cross-thread message delivery, filesystem persistence (those go
to integration level), terminal rendering (covered via the Model-state seam, not a unit concern).

**Rationale (REQ-NFR-006):** because `twinrunner-core` has zero dependency on ratatui, crossterm,
or any I/O — it is a pure library — nearly every functional REQ is exercisable as a unit test.
This is the primary load-bearing layer of the pyramid; it is fast, deterministic, and does not
require fixture files on disk (fixtures are compiled-in byte arrays for the nand parser).

### Integration Tests

**What is covered:**

1. **Worker channel protocol** — `twinrunner::worker::spawn` creates the background thread;
   `WorkerCommand::Start*` → `WorkerEvent::Started → Progressed* → Completed` delivery over
   `std::sync::mpsc` channels. Tests use a real in-process thread and assert full event sequences
   end-to-end through the channel boundary (IF-013/IF-014 from `07-contracts.md`).
2. **Filesystem round-trips** — `KeyLibrary::load` + `save` + re-`load` against a tempdir:
   proves FS-001 schema atomicity and schema_version gating. `config` create-on-first-run and
   `AppConfig` TOML round-trips against a tempdir. Log file (FS-005) JSON Lines mirror write and
   torn-last-line tolerance.
3. **Full pipeline (load → validate → extract → bind → build → flash)** — exercises all core
   modules in sequence with bundled deterministic fixture bytes; proves that the components
   compose correctly end-to-end at the library level (no TUI involved).

**Tools:** `cargo test` in `tests/` directory of the `twinrunner-core` crate (Rust integration
test convention) and in `tests/` of the `twinrunner` crate for the worker channel integration.
Tempdir provided by the `tempfile` crate for filesystem round-trips.

**Rationale:** The worker-channel boundary (ADR-002) is the only concurrency boundary in the
architecture; it must be integration-tested with a real thread — a unit test cannot expose
dropped-sender races or ordering violations on the mpsc channel. Filesystem round-trips prove
atomicity (temp+rename, INV-001) that unit tests over in-memory state cannot prove.

### Contract Tests

**What is covered:**

1. **`BuildBackend` trait port** — `SimulatorBuildBackend` satisfies the full trait (prepare,
   step-to-completion, deterministic checksum). `RealStubBuildBackend` returns `NotImplemented`
   (ERR-014) and writes nothing. Both exercised against the same trait-caller code path (RULE-006,
   REQ-020, REQ-NFR-004).
2. **`FlashBackend` trait port** — same pattern: `SimulatorFlashBackend` runs a full read/write/
   erase + verify-after-write cycle; `RealStubFlashBackend` returns `NotImplemented` (ERR-014,
   RULE-006, REQ-022, REQ-NFR-004).
3. **`Clock` trait** — `MonotonicClock` (real), `FakeClock` (injectable for determinism tests)
   both satisfy the trait; determinism tests use `FakeClock` to prove no wall-clock enters the
   checksum (ADR-006, REQ-NFR-005).
4. **FS schema round-trips** — `KeyLibrary` (FS-001), key import/export (FS-002), `ConsoleInfo`
   export (FS-003), `AppConfig` (FS-004), log file (FS-005) each serialize → deserialize and
   assert field identity. `schema_version` increment-and-reject tested for FS-001 and FS-002.

**Rationale (§15.7):** the trait ports are the safety-critical abstraction boundary — the entire
claim of REQ-NFR-004 ("no real write path exists") rests on these contracts being correct. Contract
tests verify the claim mechanically, not by inspection. FS schema tests prevent silent
schema-drift between serializer and deserializer across slice boundaries.

**Note:** TwinRunner has no published external HTTP API and no remote consumer-driven contract
surface. The only "published" contracts are the trait ports and file schemas above. There is no
Pact / OpenAPI contract testing layer; correctness is enforced by the Rust type system + the
contract tests described here.

### End-to-End (Acceptance) Tests

Per-slice acceptance tests are detailed in §Per-Slice Acceptance Tests below. The general pattern:

- **Entry point:** call `model::update` (or the worker channel) directly; no live terminal.
- **Scope:** happy-path behavioral assertion PLUS the key error paths anchored to that slice's
  REQ-IDs (many of which are the §08b negative tests). Tests prove the user-demonstrable behavior
  of the slice, not implementation details.
- **"Passing" definition:** the final `Model` (or the delivered `WorkerEvent` sequence) matches the
  asserted shape; `th coverage check` finds all REQ-IDs for the slice's capability area covered.

### Performance Tests

**Grounding REQ:** REQ-NFR-001 — cold start to first interactive frame < 300 ms; UI remains
responsive while simulated operations run.

**Tests:**

1. `test_REQ_NFR001_launch_under_300ms` — time the interval from binary startup to first ratatui
   `draw()` call using a wall-clock measurement in a release build; assert < 300 ms on a developer
   machine. Implemented as a timed integration test in the `twinrunner` binary crate; measured with
   `std::time::Instant`. This does not use criterion (a full benchmark harness is not warranted for
   a single latency SLO on a local tool); a simple `assert!(elapsed < Duration::from_millis(300))`
   in a `#[test]` is sufficient and will not flake on developer hardware.
2. `test_REQ_NFR001_reducer_rejects_concurrent_job` — already defined in §08b; doubles as a
   responsiveness test proving the reducer does not block while a job is active.

**Note on load/throughput testing:** not applicable. TwinRunner is a single-user local binary with
no server, no concurrent users, and no throughput requirement. Adding load tests would be
boilerplate with no grounding REQ-ID.

### Property / Fuzz Tests

**Grounding:** THR-003/THR-004 (threat model) and REQ-NFR-011 (no panic on any data path).

`test_REQ_NFR011_nand_never_panics_on_garbage` is a **proptest** property test: for any
`Vec<u8>` of any length, calling `nand::load` → (if `Ok`) `nand::validate` must not panic. The
`proptest!` macro generates thousands of random byte vectors including adversarial-length inputs;
the test asserts `std::panic::catch_unwind` does not trigger and any error is a typed
`ValidationIssue` or `Error::Io`. This is also the primary automated coverage for THR-003/THR-004
(malformed/random bytes reaching the parser). Tool: `proptest` crate.

### Security Tests

TwinRunner is a single-user local tool with no network surface and no authentication system (the
auth decision was confirmed as non-feature in `07-contracts.md` §Summary). Security tests are
therefore **not a separate layer** — they are embedded in the unit/negative-test layer via the
following anchored tests:

| Threat | Anchored test | Layer |
|--------|--------------|-------|
| THR-002 — CpuKey material in log | `test_REQ_NFR007_log_redacts_cpu_key_not_checksum` | unit |
| THR-003/004 — Parser panic on hostile bytes | `test_REQ_NFR011_nand_never_panics_on_garbage` | property/fuzz |
| RULE-001/INV-001 — Source dump write | `test_REQ035_build_refuses_output_equals_source` | unit |
| REQ-NFR-004 — Real-stub never acts | `test_REQ020_real_build_stub_never_acts`, `test_REQ022_real_flash_stub_never_acts` | contract |

See §08a-security-threat-model.md for the full threat/mitigation/residual-risk breakdown. Every
threat in that document maps to a named test in the REQ→Test Map below.

---

## REQ→Test Map

> This table is the mechanical coverage check read by `th coverage check`. Every MVP REQ-ID
> appears exactly once. REQ-032 and REQ-NFR-010 (V1 — scriptable/headless surface) are excluded.
> Positive/behavioral tests are added where a REQ has only negative coverage from §08b.
> `test_REQ*` names in **bold** are new positive tests added here; the remainder reuse the 65
> negative-test names already declared in `08b-failure-edge-cases.md`.

| REQ-ID | Requirement (short label) | Test name(s) | Test level |
|--------|--------------------------|--------------|------------|
| REQ-001 | NAND dump open + size-class detection | `test_REQ001_load_detects_size_class`, `test_REQ001_load_rejects_unknown_size`, `test_REQ001_load_rejects_truncated_file`, `test_REQ001_load_io_error_surfaced` | unit |
| REQ-002 | Dump structure validation before extraction | `test_REQ002_validate_happy_path_ok`, `test_REQ002_validate_missing_flashconfig`, `test_REQ002_validate_unknown_layout`, `test_REQ002_extract_requires_validated`, `test_REQ002_nand_pipeline_idempotent` | unit |
| REQ-003 | Core console-info extraction (type/serial/ECC) | `test_REQ003_extract_console_type_and_serial`, `test_REQ003_extract_console_type_uncertain_warns` | unit |
| REQ-004 | Bootloader chain extraction (CB/CD/CE/CF/CG) | `test_REQ004_extract_bootloader_chain_versions` | unit |
| REQ-005 | Fuse / FlashConfig extraction | `test_REQ005_extract_fuse_flashconfig_fields` | unit |
| REQ-006 | CPU key extraction and format validation | `test_REQ006_extract_cpu_key_valid`, `test_REQ006_extract_cpu_key_absent_not_guessed` | unit |
| REQ-007 | ECC integrity / NAND data sanity check | `test_REQ007_validate_ecc_passes_clean_fixture`, `test_REQ007_validate_ecc_failure_names_region` | unit |
| REQ-008 | Console-info view + export (text/JSON) | `test_REQ008_console_info_export_json_roundtrip` | unit + integration |
| REQ-009 | Persistent CPU-key library (per-console records) | `test_REQ009_library_persists_across_load_save` | integration |
| REQ-010 | Add / edit / view / delete key records via TUI forms | `test_REQ010_add_edit_delete_records_reducer` | unit |
| REQ-011 | CPU key validation on entry/import | `test_REQ011_cpukey_parse_rejects_malformed`, `test_REQ011_library_skips_unverified_records_on_load`, `test_REQ011_cpukey_parse_accepts_valid_32hex` | unit |
| REQ-012 | Look up / search key library by console ID | `test_REQ012_library_load_missing_returns_empty`, `test_REQ012_library_load_corrupt_does_not_crash`, `test_REQ012_library_schema_version_too_new_refused`, `test_REQ012_library_save_atomic_no_partial`, `test_REQ012_library_survives_crash_no_corruption`, `test_REQ012_library_unknown_console_type_coerced_null`, `test_REQ012_concurrent_library_write_atomic_no_corruption`, `test_REQ012_search_by_serial_returns_matching_records` | unit + integration |
| REQ-013 | Bind CPU key to loaded dump; warn on mismatch | `test_REQ013_bind_surfaces_mismatch_warning`, `test_REQ013_edit_unknown_id_no_mutation`, `test_REQ013_bind_matching_key_to_dump_succeeds` | unit |
| REQ-014 | Import / export key library | `test_REQ014_import_invalid_format_rejected_wholesale`, `test_REQ014_import_skips_bad_record_continues`, `test_REQ014_import_missing_file_surfaced`, `test_REQ014_reimport_skips_existing_ids`, `test_REQ014_export_then_reimport_roundtrip` | unit + integration |
| REQ-015 | Guided build/patch image workflow (simulated) | `test_REQ015_build_prepare_requires_validated_source`, `test_REQ015_build_write_error_leaves_no_partial`, `test_REQ015_build_cancel_leaves_no_partial_artifact`, `test_REQ015_build_crash_no_partial_at_output_path`, `test_REQ015_build_happy_path_steps_to_completion` | unit + integration |
| REQ-016 | Timing file selection in build workflow | `test_REQ016_build_prepare_unknown_timing_file`, `test_REQ016_timing_file_selection_recorded_in_inputs` | unit |
| REQ-017 | ECC file generation via simulated backend | `test_REQ017_build_ecc_output_written_to_path` | integration |
| REQ-018 | XeLL / recovery file generation via simulated backend | `test_REQ018_build_xell_output_written_to_path` | integration |
| REQ-019 | Deterministic progress + verifiable build result | `test_REQ019_build_same_inputs_same_checksum`, `test_REQ019_build_no_step_after_terminal`, `test_REQ019_cancel_no_active_job_is_noop`, `test_REQ019_worker_events_ordered_per_job`, `test_REQ019_flash_cancel_clean_no_device_state`, `test_REQ019_build_progress_0_to_100` | unit + integration |
| REQ-020 | All build ops behind BuildBackend trait; stub is no-op | `test_REQ020_real_build_stub_never_acts`, `test_REQ020_simulator_backend_satisfies_trait` | contract |
| REQ-021 | Flashing workflow: read/write/erase ops via simulated programmer | `test_REQ021_flash_write_requires_image_path`, `test_REQ021_flash_size_class_mismatch_refused`, `test_REQ021_flash_disconnected_programmer_refused`, `test_REQ021_flash_read_write_erase_ops_available` | unit |
| REQ-022 | All flash ops behind FlashBackend trait; real stub never acts | `test_REQ022_real_flash_stub_never_acts`, `test_REQ022_simulator_backend_satisfies_trait` | contract |
| REQ-023 | Flash progress + verify-after-write + success/failure result | `test_REQ023_flash_verify_mismatch_populates_recovery`, `test_REQ023_flash_verify_deterministic_replay`, `test_REQ023_flash_fs_error_terminal_failure`, `test_REQ023_flash_write_must_verify_before_success`, `test_REQ023_flash_write_verify_passes_clean` | unit + integration |
| REQ-024 | Recovery steps shown on flash failure | `test_REQ024_flash_failure_surfaces_recovery_steps` | unit |
| REQ-025 | Guided step-by-step RGH/JTAG setup workflows | `test_REQ025_advance_before_start_refused`, `test_REQ025_load_flows_missing_fixtures_no_crash`, `test_REQ025_setup_flow_steps_ordered_checklist` | unit |
| REQ-026 | Guided RGH/JTAG repair / troubleshooting flows | `test_REQ026_advance_rejects_undeclared_response`, `test_REQ026_troubleshoot_flow_decision_tree_navigates` | unit |
| REQ-027 | All actions written to structured log/history | `test_REQ027_actions_appear_in_action_log` | unit |
| REQ-028 | Full-screen TUI launches with persistent layout | `test_REQ028_model_initial_state_has_layout_fields` | unit |
| REQ-029 | Reusable TUI widgets (panels, dialogs, tables, progress) | `test_REQ029_progress_widget_state_advances` | unit |
| REQ-030 | Keyboard-driven navigation + help screen | `test_REQ030_keyboard_messages_navigate_model` | unit |
| REQ-031 | Live scrollable log/console view | `test_REQ031_log_view_scrolls_in_model` | unit |
| REQ-033 | Config from file + flags + sane defaults | `test_REQ033_config_invalid_field_falls_back_to_default`, `test_REQ033_config_dir_create_failure_uses_defaults`, `test_REQ033_config_reloads_or_defaults_after_restart`, `test_REQ033_restart_starts_fresh_session` | unit + integration |
| REQ-034 | Graceful resize + readable degradation on small terminals | `test_REQ034_tui_too_small_terminal_degraded_screen`, `test_REQ034_tui_resize_relayouts_without_crash` | unit |
| REQ-035 | Operates on copies; source dump never modified | `test_REQ035_build_refuses_output_equals_source`, `test_REQ035_load_opens_source_read_only` | unit |
| REQ-NFR-001 | Fast launch < 300 ms; responsive under simulation | `test_REQ_NFR001_launch_under_300ms`, `test_REQ_NFR001_reducer_rejects_concurrent_job` | integration + unit |
| REQ-NFR-002 | Cross-platform single Rust binary | `test_REQ_NFR002_path_handling_cross_platform` | unit |
| REQ-NFR-003 | Safety + validation first-class; no silent corrupt | `test_REQ_NFR003_invalid_input_rejected_before_operation` | unit |
| REQ-NFR-004 | Simulated-backend safety; no real hardware write | `test_REQ020_real_build_stub_never_acts`, `test_REQ022_real_flash_stub_never_acts` | contract |
| REQ-NFR-005 | Determinism: same inputs → same outputs always | `test_REQ_NFR005_build_determinism_with_fake_clock`, `test_REQ_NFR005_flash_determinism_with_fake_clock` | unit |
| REQ-NFR-006 | Testability: TUI logic testable headless | `test_REQ_NFR006_reducer_rejects_start_precondition`, `test_REQ_NFR006_reducer_only_runs_on_ui_thread` | unit |
| REQ-NFR-007 | Clean structured logging + observability | `test_REQ_NFR007_log_file_unwritable_degrades_in_memory`, `test_REQ_NFR007_log_redacts_cpu_key_not_checksum`, `test_REQ_NFR007_log_file_tolerates_torn_last_line` | unit + integration |
| REQ-NFR-008 | Keyboard-driven, discoverable UX | `test_REQ_NFR008_help_screen_lists_keybindings` | unit |
| REQ-NFR-009 | Terminal accessibility / robustness | `test_REQ034_tui_too_small_terminal_degraded_screen` | unit |
| REQ-NFR-011 | Robust error handling; TUI never crashes | `test_REQ_NFR011_nand_never_panics_on_garbage`, `test_REQ_NFR011_worker_job_panic_becomes_failed_event`, `test_REQ_NFR011_worker_channel_disconnect_no_hang`, `test_REQ_NFR011_reducer_tolerates_stale_worker_event`, `test_REQ_NFR011_double_shutdown_is_noop` | unit + integration + property |

**Verification:** `th coverage check` scans `tests/` for these exact anchors. Any REQ-ID missing
from this table, or whose named test does not exist in the test suite, is a blocking gap.

---

## Per-Slice Acceptance Tests

> Slices are anticipated from the four capability areas (A/B/C/D) plus the TUI shell and a Slice-0
> walking skeleton, aligned with the architecture's component map. Stage 9 (implementation plan)
> will assign exact slice boundaries; tests below are the behavioral signal each anticipated slice
> must produce to be declared done. Every test is end-to-end for the slice's capability — not a
> layer-local unit test. Each is anchored to the REQ-IDs the slice delivers.

### Slice 0 — Walking Skeleton

**Purpose:** Prove the architecture's load-bearing wiring is correct before any domain feature.
The skeleton launches `twinrunner`, the TUI event loop starts, the worker thread spawns, the
`model::update` reducer is reachable, and the app shuts down cleanly.

- `test_slice0_worker_spawns_and_shuts_down_cleanly` — spawn the worker thread, send
  `WorkerCommand::Shutdown`, assert the thread joins without panic. Proves IF-013/IF-014 are
  wired. Anchors: REQ-NFR-011.
- `test_slice0_model_initial_state_constructed` — call `Model::new(config)`, assert the initial
  `Session` is in `Idle` state with an empty `ActionLog` and no active job. Anchors: REQ-028,
  REQ-NFR-006.
- `test_slice0_event_loop_exits_on_quit_message` — send a `Message::Quit` into `model::update`,
  assert the returned `Command` set includes `Command::Quit`. Anchors: REQ-030.

### Slice A — NAND Read + Console-Info Extraction (Area A: REQ-001…008, REQ-035)

**Purpose:** Given a bundled 64 MB fixture, the pipeline load → validate → extract completes and
produces a `ConsoleInfo` with the expected CPU key, console type, bootloader chain, fuse values.

- `test_REQ001_load_detects_size_class` — `nand::load` on the bundled 64 MB fixture returns
  `NandImage { size_class: SizeClass::Mb64 }`. Does NOT assert internal byte details.
- `test_REQ002_validate_happy_path_ok` — `nand::validate` on a clean fixture returns no
  Error-severity `ValidationIssue`. Does NOT assert field values.
- `test_REQ003_extract_console_type_and_serial` — `nand::extract` on the clean fixture produces
  `ConsoleInfo { console_type: <expected>, serial: Some(<expected>) }`. Does NOT assert fuse
  layout internals.
- `test_REQ006_extract_cpu_key_valid` — extracted `ConsoleInfo.cpu_key` matches the expected
  32-hex string from the fixture manifest.
- `test_REQ008_console_info_export_json_roundtrip` — export `ConsoleInfo` to JSON string and
  deserialize back; assert field identity. Proves FS-003 contract.
- `test_REQ035_load_opens_source_read_only` — after `nand::load` + the full pipeline, assert the
  source file's bytes are byte-identical to the fixture (no mutation). Anchors: REQ-035,
  RULE-001.

### Slice B — CPU-Key Library Management (Area B: REQ-009…014)

**Purpose:** A complete add → search → edit → bind → export → reimport cycle works correctly and
survives a simulated process restart (library round-trip through FS-001).

- `test_REQ009_library_persists_across_load_save` — add a key record, save to tempdir, reload;
  assert the record is present with field identity. Proves FS-001 round-trip.
- `test_REQ010_add_edit_delete_records_reducer` — feed `Message::AddKeyRecord`, `Message::EditKeyRecord`,
  `Message::DeleteKeyRecord` into `model::update`; assert Model library changes; assert
  confirmation dialog state on destructive action.
- `test_REQ012_search_by_serial_returns_matching_records` — add three records with distinct
  serials; search by one serial; assert exactly one record returned.
- `test_REQ013_bind_matching_key_to_dump_succeeds` — bind a library record whose serial matches
  the loaded fixture's `ConsoleInfo.serial`; assert `BoundOk` result with no mismatch warnings.
- `test_REQ014_export_then_reimport_roundtrip` — export library to FS-002 format; clear in-memory
  library; reimport from the export file; assert all records present. Proves FS-002 contract.

### Slice C — Build / Patch Workflow (Area C: REQ-015…020)

**Purpose:** The simulated build workflow steps from `Pending` → `Running` → `Succeeded`,
produces a deterministic checksum, writes no partial artifact on cancel, and the real stub
refuses all operations.

- `test_REQ015_build_happy_path_steps_to_completion` — submit a build job to the worker with a
  validated fixture + timing file; drain `WorkerEvent`s; assert final event is
  `WorkerEvent::JobCompleted { outcome: Succeeded }` and the output file exists at `output_path`.
  Anchors: REQ-015, REQ-019.
- `test_REQ019_build_progress_0_to_100` — from the `WorkerEvent::JobProgressed` sequence, assert
  first `pct = 0`, last `pct = 100`, and sequence is monotonically non-decreasing. Anchors:
  REQ-019, REQ-NFR-005.
- `test_REQ_NFR005_build_determinism_with_fake_clock` — run the simulator twice with the same
  `BuildInputs` and a `FakeClock`; assert the two output checksums are byte-identical (RULE-007).
  Anchors: REQ-019, REQ-NFR-005, ADR-006.
- `test_REQ020_simulator_backend_satisfies_trait` — call `prepare` + `step` loop on
  `SimulatorBuildBackend` via the `BuildBackend` trait dyn reference; assert `Succeeded` with a
  non-empty checksum. Anchors: REQ-020, REQ-NFR-004.

### Slice D — Flash Workflow + Guided RGH/JTAG (Area D: REQ-021…027)

**Purpose:** The simulated flash workflow runs a full Write + verify-after-write cycle, reports
deterministic progress, populates recovery steps on failure, and the guided troubleshooting flow
steps through a decision tree.

- `test_REQ023_flash_write_verify_passes_clean` — submit a Write flash job to the worker;
  drain events; assert `Verifying` step appears before `Succeeded`; assert `verify_result` is
  `Ok`. Anchors: REQ-023, REQ-022.
- `test_REQ_NFR005_flash_determinism_with_fake_clock` — run the flash simulator twice with
  identical inputs and `FakeClock`; assert event sequences and verify result are byte-identical
  (RULE-008). Anchors: REQ-NFR-005, ADR-006.
- `test_REQ024_flash_failure_surfaces_recovery_steps` — trigger a simulated verify mismatch;
  assert the terminal `WorkerEvent::JobCompleted` carries a non-empty `recovery_steps` slice.
  Anchors: REQ-024.
- `test_REQ025_setup_flow_steps_ordered_checklist` — call `troubleshoot::load_flows()`, start a
  setup flow, assert the first step is non-empty and `advance(first_response)` transitions to
  `AtStep(1)`. Anchors: REQ-025.
- `test_REQ026_troubleshoot_flow_decision_tree_navigates` — step a repair flow from start through
  a known decision path to a terminal `Done` node; assert the session reaches `Completed` state.
  Anchors: REQ-026.
- `test_REQ027_actions_appear_in_action_log` — run a flash job end-to-end; assert the
  `model.session.action_log` contains entries for `FlashStarted`, `FlashProgressed`, and
  `FlashCompleted`. Anchors: REQ-027, REQ-031.

### Slice Shell — TUI Shell + Navigation + Cross-Cutting (REQ-028…031, REQ-033…035, REQ-NFR-001…009, REQ-NFR-011)

**Purpose:** The TUI shell correctly bridges messages to the reducer, handles resize, degrades
gracefully on small terminals, reads config, and launches within the latency budget.

- `test_REQ028_model_initial_state_has_layout_fields` — assert `Model::new` produces a `Screen`
  with a non-empty navigation surface and a status-footer field. Anchors: REQ-028.
- `test_REQ030_keyboard_messages_navigate_model` — feed `Message::KeyPressed(key)` for the
  documented navigation keys; assert `Model.active_screen` changes as expected. Anchors: REQ-030.
- `test_REQ031_log_view_scrolls_in_model` — append 20 log entries; send `Message::ScrollLog(Down)`
  10 times; assert `model.log_view.offset` = 10. Anchors: REQ-031.
- `test_REQ033_config_invalid_field_falls_back_to_default` — already in §08b negative map;
  doubled as acceptance test for the Shell slice. Anchors: REQ-033.
- `test_REQ034_tui_too_small_terminal_degraded_screen` — set model terminal size to (40, 10)
  below the 80×24 minimum; assert `model.render_mode` = `Degraded`. Anchors: REQ-034,
  REQ-NFR-009.
- `test_REQ_NFR001_launch_under_300ms` — timed integration test in the `twinrunner` binary;
  wall-clock from process start to first `draw()` call; assert < 300 ms in a release build.
  Anchors: REQ-NFR-001.
- `test_REQ_NFR008_help_screen_lists_keybindings` — feed `Message::OpenHelp` into `model::update`;
  assert the help screen model contains at least the navigation keys documented in §REQ-030.
  Anchors: REQ-NFR-008.

---

## Non-Functional Tests

| REQ-NFR-ID | What is measured | Test name | Pass threshold |
|------------|-----------------|-----------|---------------|
| REQ-NFR-001 | Cold start to first interactive frame | `test_REQ_NFR001_launch_under_300ms` | < 300 ms, release build, developer machine |
| REQ-NFR-001 | One-job-at-a-time; no concurrent job leaks | `test_REQ_NFR001_reducer_rejects_concurrent_job` | Reducer returns no `Command::StartJob` on second submit while first is active |
| REQ-NFR-002 | Cross-platform path handling | `test_REQ_NFR002_path_handling_cross_platform` | Paths constructed with `std::path::PathBuf`; no hard-coded separators; test asserts round-trip on the current platform |
| REQ-NFR-003 | All invalid inputs rejected with typed errors before operation | `test_REQ_NFR003_invalid_input_rejected_before_operation` | Aggregated gate: `nand`, `keys`, `build`, `flash` all return typed `ValidationIssue` before any side-effect |
| REQ-NFR-004 | Real backends are no-op stubs; no write path | `test_REQ020_real_build_stub_never_acts`, `test_REQ022_real_flash_stub_never_acts` | Both return `NotImplemented` (ERR-014); no file created; no `Pending` job |
| REQ-NFR-005 | Same inputs → identical checksum (build + flash) | `test_REQ_NFR005_build_determinism_with_fake_clock`, `test_REQ_NFR005_flash_determinism_with_fake_clock` | Checksum bytes are bit-identical across two runs with `FakeClock` |
| REQ-NFR-006 | Reducer is terminal-free and testable headless | `test_REQ_NFR006_reducer_rejects_start_precondition`, `test_REQ_NFR006_reducer_only_runs_on_ui_thread` | All `model::update` calls succeed without a terminal; data-race-free by message-passing design |
| REQ-NFR-007 | CPU-key redacted in log; log degrades gracefully on FS error | `test_REQ_NFR007_log_redacts_cpu_key_not_checksum`, `test_REQ_NFR007_log_file_unwritable_degrades_in_memory`, `test_REQ_NFR007_log_file_tolerates_torn_last_line` | No 32-hex word-boundary match survives in log message; app does not crash on unwritable log file |
| REQ-NFR-008 | Help screen lists documented key bindings | `test_REQ_NFR008_help_screen_lists_keybindings` | Model's help screen state contains ≥ the navigation keys listed in REQ-030 |
| REQ-NFR-009 | Terminal degradation + no crash below 80×24 | `test_REQ034_tui_too_small_terminal_degraded_screen` | `render_mode = Degraded` and no panic at (40, 10) |
| REQ-NFR-011 | No panic on hostile parse input (property test) | `test_REQ_NFR011_nand_never_panics_on_garbage` | 10 000+ proptest cases; zero panics; all results are typed errors |
| REQ-NFR-011 | Worker job panic converted to typed failure; TUI survives | `test_REQ_NFR011_worker_job_panic_becomes_failed_event` | `WorkerEvent::Failed` received; TUI thread is still live; worker thread is not joined into the TUI thread |
| REQ-NFR-011 | Channel disconnect surfaced as job failure; no hang | `test_REQ_NFR011_worker_channel_disconnect_no_hang` | `try_recv` drain observes `Disconnected`; event loop continues; model transitions to `Failed` within one tick |
| THR-002 (security) | CpuKey 32-hex material never in log | `test_REQ_NFR007_log_redacts_cpu_key_not_checksum` | Exact 32-hex word-boundary strings are `REDACTED_CPU_KEY`; 64-hex SHA-256 strings pass through |
| THR-003/004 (security) | Parser never panics on arbitrary bytes | `test_REQ_NFR011_nand_never_panics_on_garbage` | proptest: ∀ `Vec<u8>` ∈ `any::<Vec<u8>>()`, no panic |

---

## Tooling

| Level | Tool | Run command |
|-------|------|-------------|
| Unit (in-crate `#[cfg(test)]`) | Rust built-in `cargo test` | `cargo test -p twinrunner-core` |
| Integration (`tests/*.rs` in both crates) | Rust built-in `cargo test` | `cargo test` (workspace) |
| Contract (trait ports + FS schemas) | Rust built-in `cargo test` | `cargo test -p twinrunner-core --test contracts` |
| Property / Fuzz | `proptest` crate | `cargo test -p twinrunner-core test_REQ_NFR011_nand_never_panics` |
| Performance (launch latency) | `std::time::Instant` in a `#[test]` in `twinrunner` crate | `cargo test -p twinrunner test_REQ_NFR001_launch_under_300ms --release` |
| Coverage instrumentation | `cargo-llvm-cov` | `cargo llvm-cov --workspace --html` |
| Coverage gate | `th coverage check` | `node "C:/Users/bayba/Desktop/TwinHarness/dist/cli.js" --cwd <project> coverage check` |

**Coverage targets:**
- `twinrunner-core` library: **≥ 85% line coverage** (pure library, fully headless, no terminal
  I/O — high coverage is achievable and expected).
- `twinrunner` binary (TUI shell): **≥ 60% line coverage** (the rendering path and crossterm event
  loop are intentionally excluded from the headless test surface; coverage is bounded by the
  Model-state seam).

**Quality-bar note (for human review if desired):** The 85% / 60% split is a sensible default
for this architecture. The only real tradeoff worth flagging is whether the `twinrunner` shell
target should be lower (e.g. 50%) given that the crossterm/ratatui render path is inherently
untestable headlessly. I have chosen 60% as the floor on the expectation that the Model-state
seam (reducer, screen-state transitions, widget-state) is covered, while raw render layout is
not. If you prefer to lock this lower (e.g. 50%) or higher, adjust `th coverage check`'s
threshold for the binary crate accordingly.

**CI gate:** on every pull request and merge-to-main:
1. `cargo test --workspace` — must exit 0 (all tests pass).
2. `cargo llvm-cov --workspace` — coverage report generated.
3. `th coverage check` — must exit 0 (all 44 MVP REQ-IDs mapped to passing tests; no gaps).
   Any gap is a blocking PR failure.

---

## Definition of Done

### Task done

- Its anchored `test_REQ*_*` test(s) pass under `cargo test`.
- No regressions in previously passing tests (workspace-level `cargo test` still green).
- `th coverage check` does not report a new REQ-ID gap introduced by this task.

### Slice done

- All per-slice acceptance tests listed in §Per-Slice Acceptance Tests above pass end-to-end.
- `th coverage check` confirms every REQ-ID assigned to this capability area maps to ≥1 passing
  anchored test in `tests/REQ-TEST-MAP.md` and in the actual `tests/*.rs` source.
- No regressions in any earlier slice (workspace-level `cargo test` green).
- The slice's capability is demonstrable without any manual inspection step — the test output
  is the sole acceptance evidence.

### Project done

- `cargo test --workspace` exits 0 with all tests passing.
- All non-functional thresholds in §Non-Functional Tests are met:
  - `twinrunner-core` line coverage ≥ 85% (from `cargo llvm-cov`).
  - `twinrunner` shell line coverage ≥ 60% (from `cargo llvm-cov`).
  - Launch latency < 300 ms (from `test_REQ_NFR001_launch_under_300ms` in release build).
  - proptest fuzz: 10 000+ cases with zero panics on arbitrary bytes.
- **`th coverage check` exits 0** — all 44 MVP REQ-IDs in `tests/REQ-TEST-MAP.md` are anchored
  to passing `test_REQ*` tests found in the `tests/` tree. This is the authoritative,
  machine-evaluated project-level gate; no human inspection of test names substitutes for it.
- `10-verification-report.md` produced and human-approved (Stage 11).
