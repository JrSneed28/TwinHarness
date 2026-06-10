# TwinRunner MVP Coverage Declaration (test manifest)

> **This map is the test-declaration manifest.** The Builder materializes each row as a real
> `#[test]` in `tests/*.rs` (or in-crate `#[cfg(test)]`) during the owning slice's build.
> Stage 11 re-verifies against the real passing tests before declaring project done.
>
> `th coverage check` scans the `tests/` directory tree for the exact `test_REQ*` names in
> this file. Every MVP requirement (44 total; the two V1-deferred requirements are excluded) must
> have ≥1 anchored test present. A missing anchor is a blocking gap — `th coverage check`
> will exit non-zero and the Stage 9 plan cannot proceed.
>
> **Format:** `| Requirement | test_REQ*_<slug> | level | what it asserts |`
> Multiple tests for one requirement appear as additional rows with the same requirement.

| Requirement | Test name | Level | What it asserts |
|--------|-----------|-------|-----------------|
| REQ-001 | `test_REQ001_load_detects_size_class` | unit | `nand::load` on 64 MB fixture returns `SizeClass::Mb64` |
| REQ-001 | `test_REQ001_load_rejects_unknown_size` | unit | non-standard-length file rejected with `UnknownSize` (ERR-001); no `NandImage` created |
| REQ-001 | `test_REQ001_load_rejects_truncated_file` | unit | zero-length / truncated file hits `UnknownSize` path; no `NandImage` created |
| REQ-001 | `test_REQ001_load_io_error_surfaced` | unit | missing path returns `Error::Io`; retry is allowed; no `NandImage` created |
| REQ-002 | `test_REQ002_validate_happy_path_ok` | unit | `nand::validate` on clean fixture returns no Error-severity `ValidationIssue` |
| REQ-002 | `test_REQ002_validate_missing_flashconfig` | unit | correct-size file with no `FlashConfig` block → `MissingFlashConfig` (ERR-002); image `Invalid` |
| REQ-002 | `test_REQ002_validate_unknown_layout` | unit | `FlashConfig` present but unknown ECC/layout → `UnknownLayout` (ERR-003); image `Invalid` |
| REQ-002 | `test_REQ002_extract_requires_validated` | unit | calling `extract` on `Unvalidated` image → `NotValidated` (ERR-005); extraction refused |
| REQ-002 | `test_REQ002_nand_pipeline_idempotent` | unit | load → validate → extract run twice on same bytes produces identical `ConsoleInfo` |
| REQ-003 | `test_REQ003_extract_console_type_and_serial` | unit | extracted `ConsoleInfo.console_type` and `serial` match fixture manifest expectations |
| REQ-003 | `test_REQ003_extract_console_type_uncertain_warns` | unit | ambiguous console markers → `ConsoleTypeUncertain` Warning; `console_type_certain=false`; extraction not blocked |
| REQ-004 | `test_REQ004_extract_bootloader_chain_versions` | unit | extracted `BootloaderChain` contains expected CB/CD versions from fixture; fields non-empty |
| REQ-005 | `test_REQ005_extract_fuse_flashconfig_fields` | unit | extracted `FuseSet` and `FlashConfig` value match expected fixture values; fields surfaced for inspection |
| REQ-006 | `test_REQ006_extract_cpu_key_valid` | unit | extracted `ConsoleInfo.cpu_key` matches the expected 32-hex string from fixture manifest |
| REQ-006 | `test_REQ006_extract_cpu_key_absent_not_guessed` | unit | zeroed/masked CPU-key region → `cpu_key = Absent`; never a zeroed or guessed key |
| REQ-007 | `test_REQ007_validate_ecc_passes_clean_fixture` | unit | ECC check on clean fixture passes all regions without Error-severity issues |
| REQ-007 | `test_REQ007_validate_ecc_failure_names_region` | unit | ECC failure on a specific region → `EccFailure` names that region; image `Invalid`; not generic "corrupt" |
| REQ-008 | `test_REQ008_console_info_export_json_roundtrip` | unit | `ConsoleInfo` serialized to JSON and deserialized back; all fields identical (FS-003 contract) |
| REQ-009 | `test_REQ009_library_persists_across_load_save` | integration | add key record; `save` to tempdir; `load` from tempdir; record present with field identity (FS-001 round-trip) |
| REQ-010 | `test_REQ010_add_edit_delete_records_reducer` | unit | `Message::AddKeyRecord` / `EditKeyRecord` / `DeleteKeyRecord` into `model::update` correctly mutates `Model.library`; destructive action sets confirmation dialog state |
| REQ-011 | `test_REQ011_cpukey_parse_accepts_valid_32hex` | unit | exactly 32 valid hex chars → `CpuKey::parse` returns `Ok` |
| REQ-011 | `test_REQ011_cpukey_parse_rejects_malformed` | unit | non-32-char / non-hex / wrong-length input → `InvalidKeyFormat` (ERR-007); record not created |
| REQ-011 | `test_REQ011_library_skips_unverified_records_on_load` | unit | record with invalid `cpu_key` value in FS-001 → skipped with Warning on load; library is not empty overall |
| REQ-012 | `test_REQ012_search_by_serial_returns_matching_records` | unit | three records with distinct serials; search by one serial returns exactly one match |
| REQ-012 | `test_REQ012_library_load_missing_returns_empty` | unit | missing FS-001 file → empty `KeyLibrary`; no crash |
| REQ-012 | `test_REQ012_library_load_corrupt_does_not_crash` | unit | non-JSON FS-001 file → empty library + `LibraryCorrupt` Warning; no crash |
| REQ-012 | `test_REQ012_library_schema_version_too_new_refused` | unit | `schema_version` in FS-001 exceeds supported → `SchemaVersionTooNew` (ERR-010); load refused |
| REQ-012 | `test_REQ012_library_save_atomic_no_partial` | integration | simulate process-kill mid-write using tempfile; FS-001 is either last committed version or unchanged; never a corrupt partial |
| REQ-012 | `test_REQ012_library_survives_crash_no_corruption` | integration | write library to tempdir; overwrite with a new session load; assert FS-001 is valid JSON with correct content |
| REQ-012 | `test_REQ012_library_unknown_console_type_coerced_null` | unit | unknown `console_type` string in FS-001 → coerced to `null` + Warning on load; no crash |
| REQ-012 | `test_REQ012_concurrent_library_write_atomic_no_corruption` | integration | two sequential atomic writes (simulating two instances); FS-001 is valid JSON at the end; content is one of the two committed versions |
| REQ-013 | `test_REQ013_bind_matching_key_to_dump_succeeds` | unit | bind library record with matching serial to loaded fixture `ConsoleInfo` → `BoundOk` result; no mismatch warning |
| REQ-013 | `test_REQ013_bind_surfaces_mismatch_warning` | unit | bind record whose serial conflicts with loaded `ConsoleInfo` → `BoundWithMismatchWarning`; UI must surface before accept |
| REQ-013 | `test_REQ013_edit_unknown_id_no_mutation` | unit | `edit` / `delete` for a non-existent ID → `RecordNotFound` (ERR-011); library unchanged |
| REQ-014 | `test_REQ014_export_then_reimport_roundtrip` | integration | export library to FS-002 format; clear library; reimport; all original records present (FS-002 contract) |
| REQ-014 | `test_REQ014_import_invalid_format_rejected_wholesale` | unit | non-JSON import file → `InvalidImportFormat` (ERR-013); entire import rejected; library unchanged |
| REQ-014 | `test_REQ014_import_skips_bad_record_continues` | unit | import file with one bad `cpu_key` record → that record skipped with Warning; rest imported; `ImportResult.skipped = 1` |
| REQ-014 | `test_REQ014_import_missing_file_surfaced` | unit | import from non-existent path → `FileNotFound` (ERR-012); library unchanged; retry allowed |
| REQ-014 | `test_REQ014_reimport_skips_existing_ids` | unit | re-import the same export file; records with existing IDs skipped (no overwrite); duplicate count correct |
| REQ-015 | `test_REQ015_build_happy_path_steps_to_completion` | integration | submit build job to worker; drain events; final event is `JobCompleted { outcome: Succeeded }`; output file exists at `output_path` |
| REQ-015 | `test_REQ015_build_prepare_requires_validated_source` | unit | `prepare` on non-Validated image → `ImageNotValidated` (ERR-015); no `Pending` job |
| REQ-015 | `test_REQ015_build_write_error_leaves_no_partial` | integration | simulate write failure; assert no file at `output_path`; source file byte-identical to before |
| REQ-015 | `test_REQ015_build_cancel_leaves_no_partial_artifact` | integration | cancel job mid-steps; assert no file at `output_path`; source untouched |
| REQ-015 | `test_REQ015_build_crash_no_partial_at_output_path` | integration | simulate abrupt process exit mid-build; assert no partial file at `output_path` on restart inspection |
| REQ-016 | `test_REQ016_timing_file_selection_recorded_in_inputs` | unit | `prepare` with a known `timing_file_id` records that selection in `BuildInputs`; selection visible in job metadata |
| REQ-016 | `test_REQ016_build_prepare_unknown_timing_file` | unit | `prepare` with unrecognized `timing_file_id` → `UnknownTimingFile` (ERR-016); no job created |
| REQ-017 | `test_REQ017_build_ecc_output_written_to_path` | integration | run simulated ECC build job; assert output file exists at user-chosen path; file size > 0 |
| REQ-018 | `test_REQ018_build_xell_output_written_to_path` | integration | run simulated XeLL build job; assert output file exists at user-chosen path; file size > 0 |
| REQ-019 | `test_REQ019_build_progress_0_to_100` | integration | build job `WorkerEvent::JobProgressed` sequence starts at `pct = 0`, ends at `pct = 100`, is monotonically non-decreasing |
| REQ-019 | `test_REQ019_build_same_inputs_same_checksum` | unit | two runs with identical `BuildInputs` and `FakeClock` → byte-identical checksums (RULE-007) |
| REQ-019 | `test_REQ019_build_no_step_after_terminal` | unit | calling `step()` after `Succeeded` or `Failed` state → rejected; no further state transition |
| REQ-019 | `test_REQ019_cancel_no_active_job_is_noop` | unit | `WorkerCommand::Cancel` with no active job → no-op; worker thread continues; no panic |
| REQ-019 | `test_REQ019_flash_cancel_clean_no_device_state` | unit | cancel flash job mid-steps → `Failed { Cancelled }`; no persistent simulated device state left |
| REQ-019 | `test_REQ019_worker_events_ordered_per_job` | integration | for one job, worker delivers `Started → Progress* → (Completed|Failed)` in order over mpsc channel |
| REQ-020 | `test_REQ020_simulator_backend_satisfies_trait` | contract | `SimulatorBuildBackend` called via `dyn BuildBackend` → `prepare` + step loop → `Succeeded` with non-empty checksum |
| REQ-020 | `test_REQ020_real_build_stub_never_acts` | contract | `RealStubBuildBackend::prepare` → `NotImplemented` (ERR-014); no file written; no `Pending` job |
| REQ-021 | `test_REQ021_flash_read_write_erase_ops_available` | unit | `FlashBackend::prepare` accepts `Read`, `Write`, and `Erase` operation variants; each produces a valid `FlashJob` |
| REQ-021 | `test_REQ021_flash_write_requires_image_path` | unit | Write op with `image_path = None` → `ImagePathRequired` (ERR-020); no job |
| REQ-021 | `test_REQ021_flash_size_class_mismatch_refused` | unit | programmer capacity ≠ image `SizeClass` → `SizeClassMismatch` (ERR-021); no job |
| REQ-021 | `test_REQ021_flash_disconnected_programmer_refused` | unit | programmer not in `Connected` state → `ProgrammerDisconnected` (ERR-022); no job |
| REQ-022 | `test_REQ022_simulator_backend_satisfies_trait` | contract | `SimulatorFlashBackend` called via `dyn FlashBackend` → full Write + Verify cycle → `Succeeded` |
| REQ-022 | `test_REQ022_real_flash_stub_never_acts` | contract | `RealStubFlashBackend::prepare` → `NotImplemented` (ERR-014); no real write path reachable |
| REQ-023 | `test_REQ023_flash_write_verify_passes_clean` | integration | Write flash job through worker; `Verifying` step present before `Succeeded`; `verify_result = Ok` |
| REQ-023 | `test_REQ023_flash_verify_mismatch_populates_recovery` | unit | induced verify mismatch → `VerifyMismatch` (ERR-023) → terminal `Failed` with non-empty `recovery_steps` |
| REQ-023 | `test_REQ023_flash_verify_deterministic_replay` | unit | same flash op + `FakeClock` run twice → identical progress sequence and verify result (RULE-008) |
| REQ-023 | `test_REQ023_flash_write_must_verify_before_success` | unit | `FlashJob` Write state machine: transition to `Succeeded` without passing `Verifying` is forbidden |
| REQ-023 | `test_REQ023_flash_fs_error_terminal_failure` | unit | simulated FS error on flash read/write → terminal `Failed`; fixture-backed recovery steps surfaced |
| REQ-024 | `test_REQ024_flash_failure_surfaces_recovery_steps` | unit | terminal `WorkerEvent::JobCompleted` on flash failure carries non-empty `recovery_steps` describing what is safe to retry |
| REQ-025 | `test_REQ025_setup_flow_steps_ordered_checklist` | unit | start an RGH/JTAG setup flow; assert first step is non-empty; `advance(first_response)` transitions to step 1 |
| REQ-025 | `test_REQ025_advance_before_start_refused` | unit | `advance` / `back` before `start` → `SessionNotStarted` (ERR-025); session not advanced |
| REQ-025 | `test_REQ025_load_flows_missing_fixtures_no_crash` | unit | `load_flows()` with missing fixture bundle → empty `Vec`; no crash; no panic |
| REQ-026 | `test_REQ026_troubleshoot_flow_decision_tree_navigates` | unit | step a repair flow through a known decision path to a terminal `Done` node; session reaches `Completed` |
| REQ-026 | `test_REQ026_advance_rejects_undeclared_response` | unit | `advance(response)` with a response not declared on the current step → `UndeclaredResponse` (ERR-024); session stays `AtStep` |
| REQ-027 | `test_REQ027_actions_appear_in_action_log` | unit | after a flash job run through `model::update`, `model.session.action_log` contains `FlashStarted`, `FlashProgressed`, and `FlashCompleted` entries |
| REQ-028 | `test_REQ028_model_initial_state_has_layout_fields` | unit | `Model::new(config)` produces a `Screen` with a non-empty navigation surface and a status-footer field; session is `Idle` |
| REQ-029 | `test_REQ029_progress_widget_state_advances` | unit | `ProgressWidgetState` correctly tracks `pct` increments from 0 to 100 through `model::update` |
| REQ-030 | `test_REQ030_keyboard_messages_navigate_model` | unit | `Message::KeyPressed` for documented navigation keys changes `model.active_screen` as specified by the keymap |
| REQ-031 | `test_REQ031_log_view_scrolls_in_model` | unit | append 20 log entries; send `Message::ScrollLog(Down)` 10 times; `model.log_view.offset = 10` |
| REQ-033 | `test_REQ033_config_invalid_field_falls_back_to_default` | unit | `AppConfig::load` with invalid field value → per-field fallback to default; startup not aborted |
| REQ-033 | `test_REQ033_config_dir_create_failure_uses_defaults` | integration | config dir creation fails (permission-denied on tempdir) → in-memory defaults used; no startup abort |
| REQ-033 | `test_REQ033_config_reloads_or_defaults_after_restart` | integration | write valid config to tempdir; new `AppConfig::load` reads it; missing config falls back to defaults without panic |
| REQ-033 | `test_REQ033_restart_starts_fresh_session` | unit | `Model::new(config)` always starts with an empty `Session`; no state leaks from a previous session in the same process |
| REQ-034 | `test_REQ034_tui_too_small_terminal_degraded_screen` | unit | set terminal size to (40, 10); assert `model.render_mode = Degraded`; no panic |
| REQ-034 | `test_REQ034_tui_resize_relayouts_without_crash` | unit | `Message::Resize(w, h)` folded into reducer; layout recomputed; no panic; `model.terminal_size` updated |
| REQ-035 | `test_REQ035_load_opens_source_read_only` | unit | after full nand pipeline, source fixture bytes are byte-identical; no writes to source path |
| REQ-035 | `test_REQ035_build_refuses_output_equals_source` | unit | `output_path == source_image_path` → `OutputEqualsSource` (ERR-017); refused before any byte written |
| REQ-NFR-001 | `test_REQ_NFR001_launch_under_300ms` | integration | wall-clock from process start to first `draw()` call < 300 ms in release build |
| REQ-NFR-001 | `test_REQ_NFR001_reducer_rejects_concurrent_job` | unit | second `Start*` while job active → no `Command::StartJob` dispatched; reducer returns "one-job-at-a-time" notice |
| REQ-NFR-002 | `test_REQ_NFR002_path_handling_cross_platform` | unit | all paths constructed via `std::path::PathBuf`; no hard-coded separator; round-trip on current platform |
| REQ-NFR-003 | `test_REQ_NFR003_invalid_input_rejected_before_operation` | unit | across `nand`, `keys`, `build`, `flash`: all invalid inputs return typed `ValidationIssue` before any side-effect occurs |
| REQ-NFR-004 | `test_REQ020_real_build_stub_never_acts` | contract | `RealStubBuildBackend` returns `NotImplemented`; no file created; no job started |
| REQ-NFR-004 | `test_REQ022_real_flash_stub_never_acts` | contract | `RealStubFlashBackend` returns `NotImplemented`; no real write path reachable |
| REQ-NFR-005 | `test_REQ_NFR005_build_determinism_with_fake_clock` | unit | two build runs with identical `BuildInputs` + `FakeClock` → byte-identical checksums |
| REQ-NFR-005 | `test_REQ_NFR005_flash_determinism_with_fake_clock` | unit | two flash runs with identical op + `FakeClock` → identical event sequence and verify result |
| REQ-NFR-006 | `test_REQ_NFR006_reducer_rejects_start_precondition` | unit | `StartBuild`/`StartFlash` with unsatisfied precondition → no `Command`; `ValidationIssue` in `Model.pending_issues` |
| REQ-NFR-006 | `test_REQ_NFR006_reducer_only_runs_on_ui_thread` | unit | all `model::update` calls in tests run on the test thread with no shared mutable state across threads; data-race structural proof |
| REQ-NFR-007 | `test_REQ_NFR007_log_redacts_cpu_key_not_checksum` | unit | 32-hex word-boundary string in a log message → `REDACTED_CPU_KEY`; 64-hex SHA-256 string passes through unredacted |
| REQ-NFR-007 | `test_REQ_NFR007_log_file_unwritable_degrades_in_memory` | integration | unwritable log file path → degrade to in-memory `ActionLog` + Warning entry; app does not crash |
| REQ-NFR-007 | `test_REQ_NFR007_log_file_tolerates_torn_last_line` | integration | JSON Lines log file with a torn (incomplete) trailing line → last line skipped on read; prior entries intact |
| REQ-NFR-008 | `test_REQ_NFR008_help_screen_lists_keybindings` | unit | `Message::OpenHelp` → help screen model contains ≥ the navigation key bindings documented in REQ-030 |
| REQ-NFR-009 | `test_REQ034_tui_too_small_terminal_degraded_screen` | unit | terminal size (40, 10) below 80×24 minimum → `render_mode = Degraded`; no crash |
| REQ-NFR-011 | `test_REQ_NFR011_nand_never_panics_on_garbage` | property | proptest: ∀ arbitrary `Vec<u8>`, `nand::load` + `validate` never panics; all errors are typed |
| REQ-NFR-011 | `test_REQ_NFR011_worker_job_panic_becomes_failed_event` | integration | worker job panics → caught; `WorkerEvent::Failed` delivered to UI thread; TUI thread still live |
| REQ-NFR-011 | `test_REQ_NFR011_worker_channel_disconnect_no_hang` | integration | sender dropped mid-job → `try_recv` returns `Disconnected`; event loop continues without hang; model transitions to `Failed` |
| REQ-NFR-011 | `test_REQ_NFR011_reducer_tolerates_stale_worker_event` | unit | `WorkerEvent` for a job no longer active arrives → folded or ignored; no invalid state transition; no panic |
| REQ-NFR-011 | `test_REQ_NFR011_double_shutdown_is_noop` | unit | `WorkerCommand::Shutdown` sent twice → second is a no-op; worker loop exits cleanly once |
