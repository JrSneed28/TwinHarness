# Implementation Plan — TwinRunner

> **Stage 9 — Implementation Planning & Vertical Slicing** (spec §15.9). Produced by the
> Vertical Slice Agent in a **fresh context**, uncontaminated by layer-by-layer design thinking
> (§6.3). Tier T3 — full detail. Streams; surfaces slice ordering to the human only where
> sequencing has product implications. Verified by Critic in **slice mode** (fresh context: is
> each slice truly vertical? all MVP REQ-IDs covered? Slice 0 a genuine skeleton?) and by
> **`th coverage check`** (mechanical: every MVP REQ-ID maps to ≥1 slice and ≥1 anchored test).

## Summary

TwinRunner decomposes into **6 slices**: a walking skeleton (Slice 0) followed by five
capability slices aligned to the four functional areas plus the cross-cutting TUI shell. Slice 0
stands up the cargo workspace (`twinrunner-core` lib + `twinrunner` bin) and proves the one
load-bearing integration boundary — the crossterm event loop spawns the background `worker`
thread, a trivial command round-trips UI→worker→UI over `std::sync::mpsc`, a `Message` flows
through the pure `model::update` reducer, and the worker joins cleanly on shutdown. Each
subsequent slice is **vertical** (interface→logic→data end-to-end for one user-visible
capability) and ends in a demonstrable, test-gated state: read a NAND dump and view console
info (SLICE-1); manage the CPU-key library (SLICE-2); run a simulated build (SLICE-3); run a
simulated flash + guided troubleshooting (SLICE-4); and the dashboard/palette/help/logs/config
shell that makes all of it keyboard-navigable (SLICE-5). Every risky operation routes through the
`BuildBackend`/`FlashBackend` ports whose real backends are no-op stubs, so no real-hardware-write
path ever exists.

- **Slice count:** 6 slices (Slice 0 + 5 feature slices: SLICE-1, SLICE-2, SLICE-3, SLICE-4, SLICE-5)
- **Walking skeleton proves:** the TUI event loop ↔ background `worker` thread ↔ pure
  `model::update` reducer integration round-trips over `std::sync::mpsc` and shuts down cleanly
  (IF-013/IF-014/IF-015 wired end-to-end across the only cross-thread boundary).
- **First user-visible capability:** SLICE-1 — load a bundled 64 MB NAND dump fixture, validate
  it, and display extracted `ConsoleInfo` (console type, serial, bootloader chain, fuses, CPU key).
- **All MVP REQ-IDs covered:** yes — all 44 MVP REQ-IDs appear in the Coverage Map below
  (REQ-001…031, REQ-033, REQ-034, REQ-035, REQ-NFR-001…009, REQ-NFR-011). REQ-032 and
  REQ-NFR-010 (V1 headless surface) are intentionally excluded.

---

## Slicing Summary

The decomposition is **vertical by capability area**, mirroring the architecture's component map
and the Stage 8 per-slice acceptance tests. The governing principle: each slice adds **one
user-observable capability** and touches every layer that capability needs — from the `tui`
screen, through the `model` reducer orchestration, into the owning core module (`nand`/`keys`/
`build`/`flash`/`troubleshoot`), and out to its `log`/`config`/`error`/filesystem dependencies.
No slice is a horizontal layer; "implement the data model" or "build all the widgets" are not
slices here.

Ordering is driven by **data dependency and demonstrability**. Slice 0 is the unconditional
prerequisite — nothing builds against an unproven worker/reducer/event-loop spine. **SLICE-1 is
first** because the loaded-and-extracted `ConsoleInfo` is the anchor that SLICE-2 (key bind /
mismatch warning, REQ-013), SLICE-3 (validated source for build, RULE-012), and SLICE-4 (flash
source image + console-scoped troubleshooting, REQ-026) all consume; ordering SLICE-1 early
satisfies REQ-001…008 and REQ-035 (the read-only invariant) before any operation that could touch a
dump. **SLICE-2** follows because key binding (REQ-013) needs SLICE-1's `ConsoleInfo` and because
the key library is small, self-contained, and de-risks the FS-001/FS-002 schema round-trips early.
**SLICE-3 and SLICE-4** are the two simulated-backend workflows; both depend on SLICE-1's validated
image but are otherwise capability-independent. **SLICE-5 (shell) is last** because the dashboard
tiles, command palette, help screen, logs view, and config editor are most valuable once there are
real capabilities behind them to navigate to — but the *minimal* navigation/keymap/screen-routing
each earlier slice needs is delivered within that slice's own `tui` work (a thin screen + its keymap
entries), and SLICE-5 completes the cross-cutting shell (palette, help, resize/too-small, logs
filter, config editor, no-color-only) and the cross-cutting NFRs that ride on it.

**Cross-cutting NFRs are realized within the slices that exercise them**, and mapped to those
slices in the Coverage Map: REQ-NFR-003 (validation-first) lands in SLICE-1 and SLICE-2 where
untrusted input enters; REQ-NFR-004 (no real-hardware-write) and REQ-NFR-005 (determinism) land in
SLICE-3 and SLICE-4 where the ports and simulators live; REQ-NFR-011 (robust error handling, never
crash) lands in SLICE-0, SLICE-1, SLICE-3, and SLICE-4 where typed failures and worker-panic
recovery are proven.

**Anti-horizontal rule:** every slice below is vertical — it touches the full stack end-to-end for
its capability. Pure horizontal-layer slices ("implement all database models") are not valid and
will be rejected by the Critic and by `th coverage check`.

---

## Slice 0 — Walking Skeleton

**Goal:** prove that the architecture's integration boundaries wire together correctly before any
real feature logic is added. The walking skeleton does almost nothing functionally — it exists to
surface wiring failures early, not to deliver user value. It is the **first slice built, always.**

This is a genuine walking skeleton (not "just the data model", not "scaffolding with no integration
test"): it sets up the **cargo workspace** (`twinrunner-core` library crate + `twinrunner` binary
crate) and exercises **every significant architectural boundary in one round-trip**:

- **Path:** `main` (binary) → `config` resolves a minimal `AppConfig` → construct the initial
  `Model`/`Session` via `Model::new(config)` → spawn the background **`worker`** thread and wire
  the `std::sync::mpsc` UI↔worker channels (IF-013/IF-014) → enter the crossterm raw-mode /
  ratatui alternate-screen event loop → render the first Dashboard frame (a placeholder) → a
  trivial command round-trips UI→worker→UI (send `WorkerCommand::Shutdown`, observe the thread
  return) → a `Message::Quit` flows through the pure `model::update` reducer and yields
  `Command::ShutdownWorker` → the shell signals the worker, **joins** the thread, leaves raw mode
  / alternate screen, and exits cleanly.
- **Components touched (end-to-end):** `twinrunner-core::config`, `twinrunner-core::model`, `twinrunner-core::log`, `twinrunner-core::error`, `twinrunner-core::clock`, `twinrunner::worker`, `twinrunner::tui`
  — interface (tui event loop) → logic (reducer) → cross-thread boundary (worker channel) →
  shutdown. This is the spine; it touches every layer the system has.
- **Observable output proving integration:** the binary launches to a first interactive frame,
  the worker thread spawns and joins without panic, and a `Message::Quit` produces a
  `Command::ShutdownWorker` — all asserted headlessly without a live terminal (REQ-NFR-006).
- **REQ-IDs satisfied:** REQ-028 (full — initial Model has a navigation surface + status footer),
  REQ-NFR-006 (full — reducer reachable headlessly), REQ-NFR-011 (partial — clean worker
  spawn/join, double-shutdown no-op), REQ-030 (partial — `Quit` message handled), REQ-NFR-001
  (partial — single-binary launch path exists). *(Single-binary form factor per REQ-NFR-002 is
  established structurally here; the launch-latency budget itself is gated in SLICE-5.)*
- **Anchored acceptance tests (from Stage 8 / `tests/REQ-TEST-MAP.md`):**
  - `test_slice0_worker_spawns_and_shuts_down_cleanly` — spawn the worker, send
    `WorkerCommand::Shutdown`, assert the thread joins without panic (IF-013/IF-014 wired).
  - `test_slice0_model_initial_state_constructed` — `Model::new(config)` yields a `Session` in
    `Idle` with an empty `ActionLog` and no active job.
  - `test_slice0_event_loop_exits_on_quit_message` — `Message::Quit` into `model::update` returns a
    `Command` set including `Command::ShutdownWorker`.
  - `test_REQ_NFR011_double_shutdown_is_noop` — a second `WorkerCommand::Shutdown` is a no-op; the
    worker loop exits cleanly once.
  - `test_REQ028_model_initial_state_has_layout_fields` — initial Model has a non-empty navigation
    surface and a status-footer field; session is `Idle`.
- **Dependencies & order:** none — built first; prerequisite for all feature slices.
- **Definition of done:** the five anchored tests above pass; `cargo build --workspace` succeeds
  producing the single binary; `th state verify` clean; `th coverage check` does not regress; any
  required Critic PASS recorded.

---

## Slice List (ordered)

Order below is the build order. SLICE-1 is built first after Slice 0; SLICE-5 last. Each slice is
independently demonstrable and test-gated before the next begins. (SLICE-3 and SLICE-4 are
parallel-eligible with each other — see Build Order & Dependencies.)

---

### SLICE-1 — Read NAND & console info

- **REQ-IDs satisfied:**
  - Full: REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-007, REQ-008, REQ-035
  - Partial: REQ-NFR-003 *(validation-first for the NAND input path; key-input portion in
    SLICE-2)*, REQ-NFR-005 *(deterministic parse pipeline; simulator determinism in SLICE-3/SLICE-4)*,
    REQ-NFR-011 *(typed parse errors + no-panic-on-garbage; worker-failure portion in SLICE-3/SLICE-4)*
- **User-demonstrable capability:** A user opens a bundled 64 MB NAND dump fixture, TwinRunner
  validates its structure and ECC, and displays the extracted `ConsoleInfo` — console/motherboard
  type, serial, CB/CD/CE/CF/CG bootloader chain, fuse set, ECC/layout type, and the CPU key (or an
  explicit "not present") — in the `ConsoleInfoView`, with a one-keystroke export to a JSON report;
  a malformed/oversized file is rejected with a named, actionable error and the source bytes are
  provably unchanged.
- **Components touched (end-to-end):** `twinrunner-core::nand`, `twinrunner-core::model`, `twinrunner-core::log`, `twinrunner-core::error`, `twinrunner-core::clock`, `twinrunner::tui`
  — `tui` screens: `ReadNand`, `ConsoleInfoView`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ001_load_detects_size_class`
  - `test_REQ001_load_rejects_unknown_size`
  - `test_REQ002_validate_happy_path_ok`
  - `test_REQ002_validate_missing_flashconfig`
  - `test_REQ002_extract_requires_validated`
  - `test_REQ003_extract_console_type_and_serial`
  - `test_REQ004_extract_bootloader_chain_versions`
  - `test_REQ005_extract_fuse_flashconfig_fields`
  - `test_REQ006_extract_cpu_key_valid`
  - `test_REQ006_extract_cpu_key_absent_not_guessed`
  - `test_REQ007_validate_ecc_passes_clean_fixture`
  - `test_REQ007_validate_ecc_failure_names_region`
  - `test_REQ008_console_info_export_json_roundtrip`
  - `test_REQ035_load_opens_source_read_only`
  - `test_REQ_NFR011_nand_never_panics_on_garbage` (property)
- **Dependencies & order:** requires SLICE-0 complete (worker/reducer/event-loop spine + `config`/
  `log`/`error`/`clock`). Built first among feature slices because its `ConsoleInfo` is the anchor
  consumed by B (bind), C (validated build source), and D (flash source + console-scoped flows).
- **Definition of done:** all anchored tests above pass; `th state verify` clean; `th coverage
  check` confirms REQ-001…008 + REQ-035 map to this slice with ≥1 passing test each; no regression
  in Slice 0.

---

### SLICE-2 — CPU-key library management

- **REQ-IDs satisfied:**
  - Full: REQ-009, REQ-010, REQ-011, REQ-012, REQ-013, REQ-014
  - Partial: REQ-NFR-003 *(validation-first for key entry/import; NAND portion in SLICE-1)*
- **User-demonstrable capability:** A user manages a persistent CPU-key library from the
  `KeyLibrary` screen — add/edit/view/delete `KeyRecord`s through the `KeyRecordDialog` (with
  32-hex format validation that rejects malformed keys inline and a confirm on delete), search/
  filter by console identifier, bind a record to the active dump (with a visible mismatch warning
  when the record's console identity differs from the loaded `ConsoleInfo`), and import/export the
  library to a documented file; records survive a restart (FS-001 round-trip).
- **Components touched (end-to-end):** `twinrunner-core::keys`, `twinrunner-core::model`, `twinrunner-core::config`, `twinrunner-core::log`, `twinrunner-core::error`, `twinrunner::tui`
  — `tui` screens: `KeyLibrary`, `KeyRecordDialog`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ009_library_persists_across_load_save`
  - `test_REQ010_add_edit_delete_records_reducer`
  - `test_REQ011_cpukey_parse_accepts_valid_32hex`
  - `test_REQ011_cpukey_parse_rejects_malformed`
  - `test_REQ012_search_by_serial_returns_matching_records`
  - `test_REQ012_library_load_missing_returns_empty`
  - `test_REQ012_library_load_corrupt_does_not_crash`
  - `test_REQ013_bind_matching_key_to_dump_succeeds`
  - `test_REQ013_bind_surfaces_mismatch_warning`
  - `test_REQ013_edit_unknown_id_no_mutation`
  - `test_REQ014_export_then_reimport_roundtrip`
  - `test_REQ014_import_invalid_format_rejected_wholesale`
  - `test_REQ014_import_skips_bad_record_continues`
  - `test_REQ_NFR003_invalid_input_rejected_before_operation`
- **Dependencies & order:** requires SLICE-0 (model/log/config spine) and SLICE-1 (binding needs
  the loaded `ConsoleInfo` from `nand::extract` for the mismatch-warning path, REQ-013).
- **Definition of done:** all anchored tests above pass; `th state verify` clean; `th coverage
  check` confirms REQ-009…014 map to this slice with ≥1 passing test each; no regression in earlier
  slices.

---

### SLICE-3 — Build / patch image workflow (simulated)

- **REQ-IDs satisfied:**
  - Full: REQ-015, REQ-016, REQ-017, REQ-018, REQ-019, REQ-020
  - Partial: REQ-035 *(output ≠ source enforced for build; load read-only proven in SLICE-1)*,
    REQ-NFR-004 *(BuildBackend port + RealStub no-op; flash port in SLICE-4)*, REQ-NFR-005
    *(build determinism; flash determinism in SLICE-4)*, REQ-NFR-011 *(build-job failure surfaced
    without crash; flash/worker-panic in SLICE-4)*, REQ-027 *(build actions logged; flash/full
    history in SLICE-4)*
- **User-demonstrable capability:** From the `BuildWorkflow` screen a user configures `BuildInputs`
  (validated source dump pre-populated from the active image, an artifact type — ECC image or XeLL
  image — a `TimingFile` selected from a managed list, and an output path), presses Build, and
  watches a deterministic 0→100% progress bar with a streaming log run on the background worker;
  on completion the `BuildArtifact` result shows the output path, size class, and a deterministic
  sha256 checksum (same inputs → same checksum), the source dump is provably unmodified, and the
  real build backend refuses to act (no-op stub).
- **Components touched (end-to-end):** `twinrunner-core::build`, `twinrunner-core::clock`, `twinrunner-core::model`, `twinrunner-core::log`, `twinrunner-core::error`, `twinrunner::worker`, `twinrunner::tui`
  — `tui` screen: `BuildWorkflow`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ015_build_happy_path_steps_to_completion`
  - `test_REQ015_build_prepare_requires_validated_source`
  - `test_REQ015_build_write_error_leaves_no_partial`
  - `test_REQ015_build_cancel_leaves_no_partial_artifact`
  - `test_REQ016_timing_file_selection_recorded_in_inputs`
  - `test_REQ016_build_prepare_unknown_timing_file`
  - `test_REQ017_build_ecc_output_written_to_path`
  - `test_REQ018_build_xell_output_written_to_path`
  - `test_REQ019_build_progress_0_to_100`
  - `test_REQ019_build_same_inputs_same_checksum`
  - `test_REQ019_worker_events_ordered_per_job`
  - `test_REQ020_simulator_backend_satisfies_trait`
  - `test_REQ020_real_build_stub_never_acts`
  - `test_REQ035_build_refuses_output_equals_source`
  - `test_REQ_NFR005_build_determinism_with_fake_clock`
- **Dependencies & order:** requires SLICE-0 (worker channel + reducer) and SLICE-1 (a `Validated`/
  `Extracted` source image — RULE-012 build precondition). Parallel-eligible with SLICE-4 *only* if
  built on disjoint worktrees with care: both share `worker`, `model`, `log`, `clock` (see Build
  Order — serialized by default).
- **Definition of done:** all anchored tests above pass; `th state verify` clean; `th coverage
  check` confirms REQ-015…020 map to this slice with ≥1 passing test each; no regression in earlier
  slices.

---

### SLICE-4 — Flash workflow + guided RGH/JTAG troubleshooting (simulated)

- **REQ-IDs satisfied:**
  - Full: REQ-021, REQ-022, REQ-023, REQ-024, REQ-025, REQ-026, REQ-027, REQ-031
  - Partial: REQ-035 *(flash writes to a copy, never the source; load read-only in SLICE-1)*,
    REQ-NFR-004 *(FlashBackend port + RealStub no-op; build port in SLICE-3)*, REQ-NFR-005
    *(flash determinism; build determinism in SLICE-3)*, REQ-NFR-011 *(worker-panic and
    channel-disconnect recovery; parse no-panic in SLICE-1)*
- **User-demonstrable capability:** From the `FlashWorkflow` screen a user selects a `FlashOperation`
  (Read / Write / Erase) against the simulated programmer, confirms the target before execution, and
  runs it on the background worker with a deterministic 0→100% progress bar and live log; a Write
  passes through a simulated verify-after-write step (Verifying → Succeeded on match), an induced
  failure surfaces ordered recovery steps, and every action is written to the structured
  `ActionLog`. Separately, from `TroubleshootFlow` a user steps through a finite, fixture-backed
  RGH/JTAG setup checklist and a repair decision-tree wizard scoped to the detected console type.
- **Components touched (end-to-end):** `twinrunner-core::flash`, `twinrunner-core::troubleshoot`, `twinrunner-core::clock`, `twinrunner-core::model`, `twinrunner-core::log`, `twinrunner-core::error`, `twinrunner::worker`, `twinrunner::tui`
  — `tui` screens: `FlashWorkflow`, `TroubleshootFlow`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ021_flash_read_write_erase_ops_available`
  - `test_REQ021_flash_write_requires_image_path`
  - `test_REQ021_flash_size_class_mismatch_refused`
  - `test_REQ021_flash_disconnected_programmer_refused`
  - `test_REQ022_simulator_backend_satisfies_trait`
  - `test_REQ022_real_flash_stub_never_acts`
  - `test_REQ023_flash_write_verify_passes_clean`
  - `test_REQ023_flash_verify_mismatch_populates_recovery`
  - `test_REQ023_flash_write_must_verify_before_success`
  - `test_REQ024_flash_failure_surfaces_recovery_steps`
  - `test_REQ025_setup_flow_steps_ordered_checklist`
  - `test_REQ025_advance_before_start_refused`
  - `test_REQ025_load_flows_missing_fixtures_no_crash`
  - `test_REQ026_troubleshoot_flow_decision_tree_navigates`
  - `test_REQ026_advance_rejects_undeclared_response`
  - `test_REQ027_actions_appear_in_action_log`
  - `test_REQ_NFR005_flash_determinism_with_fake_clock`
  - `test_REQ_NFR011_worker_job_panic_becomes_failed_event`
  - `test_REQ_NFR011_worker_channel_disconnect_no_hang`
- **Dependencies & order:** requires SLICE-0 (worker channel + reducer) and SLICE-1 (flash source
  image + detected `ConsoleType` for console-scoped troubleshooting flows). Parallel-eligible with
  SLICE-3 subject to the shared-component caveat (see Build Order).
- **Definition of done:** all anchored tests above pass; `th state verify` clean; `th coverage
  check` confirms REQ-021…027 + REQ-031 map to this slice with ≥1 passing test each; no regression
  in earlier slices.

---

### SLICE-5 — TUI shell & cross-cutting behavior

- **REQ-IDs satisfied:**
  - Full: REQ-029, REQ-030, REQ-033, REQ-034, REQ-NFR-001, REQ-NFR-002, REQ-NFR-007, REQ-NFR-008,
    REQ-NFR-009
  - Partial: REQ-028 *(Dashboard + palette overlay complete the shell whose skeleton lands in
    Slice 0)*, REQ-031 *(LogsView UI completes the live-log surface whose `ActionLog` plumbing lands
    in SLICE-4)*
- **User-demonstrable capability:** TwinRunner presents the Direction-C **Dashboard** of five
  focusable status tiles, a Ctrl-P **command palette** fuzzy launcher, a Help/keybindings screen
  (F1), a live scrollable **LogsView** with severity filter and export, and a **ConfigSettings**
  editor (library path, output dir, backend selection, log verbosity) — all keyboard-navigable via
  three independent paths (tiles, number shortcuts, palette), launching to a first interactive
  frame in under 300 ms, resizing without crashing, showing a readable "terminal too small" message
  below 80×24, and never relying on color alone (every state carries a glyph/label).
- **Components touched (end-to-end):** `twinrunner::tui`, `twinrunner-core::config`, `twinrunner-core::log`, `twinrunner-core::model`, `twinrunner-core::error`
  — `tui` scope: Dashboard, CommandPalette, HelpScreen, LogsView, ConfigSettings screens + the
  reusable widget/focus/keymap layer + resize handling
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ029_progress_widget_state_advances`
  - `test_REQ030_keyboard_messages_navigate_model`
  - `test_REQ031_log_view_scrolls_in_model`
  - `test_REQ033_config_invalid_field_falls_back_to_default`
  - `test_REQ033_config_dir_create_failure_uses_defaults`
  - `test_REQ033_config_reloads_or_defaults_after_restart`
  - `test_REQ033_restart_starts_fresh_session`
  - `test_REQ034_tui_too_small_terminal_degraded_screen`
  - `test_REQ034_tui_resize_relayouts_without_crash`
  - `test_REQ_NFR001_launch_under_300ms`
  - `test_REQ_NFR001_reducer_rejects_concurrent_job`
  - `test_REQ_NFR002_path_handling_cross_platform`
  - `test_REQ_NFR007_log_redacts_cpu_key_not_checksum`
  - `test_REQ_NFR007_log_file_unwritable_degrades_in_memory`
  - `test_REQ_NFR007_log_file_tolerates_torn_last_line`
  - `test_REQ_NFR008_help_screen_lists_keybindings`
  - `test_REQ_NFR006_reducer_rejects_start_precondition`
  - `test_REQ_NFR006_reducer_only_runs_on_ui_thread`
  - `test_REQ_NFR011_reducer_tolerates_stale_worker_event`
- **Dependencies & order:** requires SLICE-0 (shell spine) and benefits from SLICE-1…SLICE-4 being
  present so the dashboard tiles, palette commands, and logs view have real state to display. Built
  **last**.
- **Definition of done:** all anchored tests above pass; `th state verify` clean; `th coverage
  check` confirms REQ-029, REQ-030, REQ-033, REQ-034, REQ-NFR-001/002/007/008/009 map to this slice
  with ≥1 passing test each; no regression in earlier slices.

---

## REQ Coverage Map

This table is the mechanical coverage check read by `th coverage check`. Every one of the 44 MVP
REQ-IDs appears with ≥1 covering slice and an anchored test exists for it in
`tests/REQ-TEST-MAP.md`. REQ-032 and REQ-NFR-010 (V1 — scriptable/headless surface) are
**excluded**.

| REQ-ID | Requirement (short label) | Covered by slice(s) | Coverage type |
|--------|--------------------------|---------------------|---------------|
| REQ-001 | NAND dump open + size-class detection | SLICE-1 | Full |
| REQ-002 | Dump structure validation before extraction | SLICE-1 | Full |
| REQ-003 | Core console-info extraction (type/serial/ECC) | SLICE-1 | Full |
| REQ-004 | Bootloader chain extraction (CB/CD/CE/CF/CG) | SLICE-1 | Full |
| REQ-005 | Fuse / FlashConfig extraction | SLICE-1 | Full |
| REQ-006 | CPU key extraction and format validation | SLICE-1 | Full |
| REQ-007 | ECC integrity / NAND data sanity check | SLICE-1 | Full |
| REQ-008 | Console-info view + export (text/JSON) | SLICE-1 | Full |
| REQ-009 | Persistent CPU-key library (per-console records) | SLICE-2 | Full |
| REQ-010 | Add / edit / view / delete key records via TUI forms | SLICE-2 | Full |
| REQ-011 | CPU key validation on entry/import | SLICE-2 | Full |
| REQ-012 | Look up / search key library by console ID | SLICE-2 | Full |
| REQ-013 | Bind CPU key to loaded dump; warn on mismatch | SLICE-2 | Full |
| REQ-014 | Import / export key library | SLICE-2 | Full |
| REQ-015 | Guided build/patch image workflow (simulated) | SLICE-3 | Full |
| REQ-016 | Timing file selection in build workflow | SLICE-3 | Full |
| REQ-017 | ECC file generation via simulated backend | SLICE-3 | Full |
| REQ-018 | XeLL / recovery file generation via simulated backend | SLICE-3 | Full |
| REQ-019 | Deterministic progress + verifiable build result | SLICE-3 | Full |
| REQ-020 | All build ops behind BuildBackend trait; stub is no-op | SLICE-3 | Full |
| REQ-021 | Flashing workflow: read/write/erase via simulated programmer | SLICE-4 | Full |
| REQ-022 | All flash ops behind FlashBackend trait; real stub never acts | SLICE-4 | Full |
| REQ-023 | Flash progress + verify-after-write + success/failure result | SLICE-4 | Full |
| REQ-024 | Recovery steps shown on flash failure | SLICE-4 | Full |
| REQ-025 | Guided step-by-step RGH/JTAG setup workflows | SLICE-4 | Full |
| REQ-026 | Guided RGH/JTAG repair / troubleshooting flows | SLICE-4 | Full |
| REQ-027 | All actions written to structured log/history | SLICE-4 (full), SLICE-3 (partial) | Full |
| REQ-028 | Full-screen TUI launches with persistent layout | SLICE-0 (partial), SLICE-5 (full) | Partial → Full |
| REQ-029 | Reusable TUI widgets (panels, dialogs, tables, progress) | SLICE-5 | Full |
| REQ-030 | Keyboard-driven navigation + help screen | SLICE-0 (partial), SLICE-5 (full) | Partial → Full |
| REQ-031 | Live scrollable log/console view | SLICE-4 (partial), SLICE-5 (full) | Partial → Full |
| REQ-033 | Config from file + flags + sane defaults | SLICE-5 | Full |
| REQ-034 | Graceful resize + readable degradation on small terminals | SLICE-5 | Full |
| REQ-035 | Operates on copies; source dump never modified | SLICE-1 (full), SLICE-3 (partial), SLICE-4 (partial) | Full |
| REQ-NFR-001 | Fast launch < 300 ms; responsive under simulation | SLICE-5 | Full |
| REQ-NFR-002 | Cross-platform single Rust binary | SLICE-5 (full), SLICE-0 (structural) | Full |
| REQ-NFR-003 | Safety + validation first-class; no silent corrupt | SLICE-1 (partial), SLICE-2 (full) | Full |
| REQ-NFR-004 | Simulated-backend safety; no real hardware write | SLICE-3 (build port), SLICE-4 (flash port) | Full |
| REQ-NFR-005 | Determinism: same inputs → same outputs always | SLICE-3 (build), SLICE-4 (flash) | Full |
| REQ-NFR-006 | Testability: TUI logic testable headless | SLICE-0 (partial), SLICE-5 (full) | Full |
| REQ-NFR-007 | Clean structured logging + observability | SLICE-5 | Full |
| REQ-NFR-008 | Keyboard-driven, discoverable UX | SLICE-5 | Full |
| REQ-NFR-009 | Terminal accessibility / robustness | SLICE-5 | Full |
| REQ-NFR-011 | Robust error handling; TUI never crashes | SLICE-0 (partial), SLICE-1 (partial), SLICE-3 (partial), SLICE-4 (full) | Full |

**Verification:** `th coverage check` confirms the above mechanically. All 44 MVP REQ-IDs are
present; REQ-032 and REQ-NFR-010 are excluded as V1. Any REQ-ID missing from this table or lacking
an anchored test in `tests/REQ-TEST-MAP.md` is a blocking gap.

---

## Per-Slice Tasks & Task Files

Each task gets a stable ID (`SLICE-N / TASK-MMM`) and a self-contained task file under
`docs/tasks/SLICE-N/`. The Builder reads one task file at a time plus the relevant artifact
Summaries — not the whole corpus (§9). Tasks within a slice are sequential, each delivering a
verifiable sub-state.

### Tasks for SLICE-0

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-0 / TASK-001 | Cargo workspace + core foundation modules (config/error/clock/log/model skeleton) | REQ-028, REQ-NFR-002, REQ-NFR-006 | `docs/tasks/SLICE-0/TASK-001-workspace-and-core-foundation.md` |
| SLICE-0 / TASK-002 | Worker thread + mpsc channel protocol round-trip | REQ-NFR-001, REQ-NFR-011 | `docs/tasks/SLICE-0/TASK-002-worker-channel-roundtrip.md` |
| SLICE-0 / TASK-003 | TUI event loop + reducer wiring + clean shutdown | REQ-028, REQ-030, REQ-NFR-006, REQ-NFR-011 | `docs/tasks/SLICE-0/TASK-003-event-loop-and-shutdown.md` |

### Tasks for SLICE-1

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-1 / TASK-004 | `nand::load` — read-only open + size-class detection | REQ-001, REQ-035 | `docs/tasks/SLICE-1/TASK-004-nand-load-size-class.md` |
| SLICE-1 / TASK-005 | `nand::validate` — structure + ECC, fail-closed with named region | REQ-002, REQ-007, REQ-NFR-003, REQ-NFR-011 | `docs/tasks/SLICE-1/TASK-005-nand-validate-structure-ecc.md` |
| SLICE-1 / TASK-006 | `nand::extract` + ConsoleInfo JSON export (FS-003) | REQ-003, REQ-004, REQ-005, REQ-006, REQ-008 | `docs/tasks/SLICE-1/TASK-006-nand-extract-and-export.md` |
| SLICE-1 / TASK-007 | ReadNand + ConsoleInfoView screens wired through the reducer | REQ-001, REQ-002, REQ-007, REQ-008, REQ-035 | `docs/tasks/SLICE-1/TASK-007-readnand-consoleinfo-screens.md` |

### Tasks for SLICE-2

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-2 / TASK-008 | `CpuKey::parse` + KeyLibrary persistence (FS-001 load/save) | REQ-009, REQ-011, REQ-012 | `docs/tasks/SLICE-2/TASK-008-cpukey-and-library-persistence.md` |
| SLICE-2 / TASK-009 | KeyRecord CRUD + search + bind-with-mismatch-warning | REQ-010, REQ-012, REQ-013 | `docs/tasks/SLICE-2/TASK-009-crud-search-bind.md` |
| SLICE-2 / TASK-010 | Import / export (FS-002) | REQ-014 | `docs/tasks/SLICE-2/TASK-010-import-export.md` |
| SLICE-2 / TASK-011 | KeyLibrary + KeyRecordDialog screens wired through the reducer | REQ-009, REQ-010, REQ-011, REQ-013, REQ-NFR-003 | `docs/tasks/SLICE-2/TASK-011-keylibrary-screens.md` |

### Tasks for SLICE-3

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-3 / TASK-012 | `BuildBackend` port + Simulator + RealStub + prepare preconditions | REQ-015, REQ-016, REQ-020, REQ-035, REQ-NFR-004 | `docs/tasks/SLICE-3/TASK-012-buildbackend-port-and-stub.md` |
| SLICE-3 / TASK-013 | `BuildJob::step` — deterministic progress + checksum + ECC/XeLL output | REQ-017, REQ-018, REQ-019, REQ-NFR-005 | `docs/tasks/SLICE-3/TASK-013-buildjob-step-determinism.md` |
| SLICE-3 / TASK-014 | BuildWorkflow screen + worker dispatch wired through the reducer | REQ-015, REQ-016, REQ-019, REQ-020 | `docs/tasks/SLICE-3/TASK-014-buildworkflow-screen.md` |

### Tasks for SLICE-4

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-4 / TASK-015 | `FlashBackend` port + Simulator + RealStub + prepare preconditions | REQ-021, REQ-022, REQ-NFR-004 | `docs/tasks/SLICE-4/TASK-015-flashbackend-port-and-stub.md` |
| SLICE-4 / TASK-016 | `FlashJob::step` — progress + verify-after-write + recovery steps | REQ-023, REQ-024, REQ-NFR-005, REQ-NFR-011 | `docs/tasks/SLICE-4/TASK-016-flashjob-step-verify-recovery.md` |
| SLICE-4 / TASK-017 | Troubleshoot fixture-backed flow stepper (setup + repair) | REQ-025, REQ-026 | `docs/tasks/SLICE-4/TASK-017-troubleshoot-flow-stepper.md` |
| SLICE-4 / TASK-018 | FlashWorkflow + TroubleshootFlow screens + ActionLog history | REQ-021, REQ-023, REQ-024, REQ-027, REQ-031 | `docs/tasks/SLICE-4/TASK-018-flash-troubleshoot-screens.md` |

### Tasks for SLICE-5

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-5 / TASK-019 | Reusable widget/focus/keymap layer + Dashboard + Command Palette | REQ-028, REQ-029, REQ-030, REQ-NFR-008 | `docs/tasks/SLICE-5/TASK-019-widgets-dashboard-palette.md` |
| SLICE-5 / TASK-020 | LogsView + structured logging + CPU-key redaction + log file (FS-005) | REQ-031, REQ-NFR-007 | `docs/tasks/SLICE-5/TASK-020-logsview-and-logging.md` |
| SLICE-5 / TASK-021 | ConfigSettings + AppConfig resolution (FS-004) + cross-platform paths | REQ-033, REQ-NFR-002 | `docs/tasks/SLICE-5/TASK-021-config-and-paths.md` |
| SLICE-5 / TASK-022 | Resize / too-small handling + Help screen + launch-latency budget | REQ-030, REQ-034, REQ-NFR-001, REQ-NFR-009 | `docs/tasks/SLICE-5/TASK-022-resize-help-launch-latency.md` |

---

## Build Order & Dependencies

Ordered build sequence. The §16 rule: two slices may build concurrently only if their
"Components touched" sets are **completely disjoint**.

1. **SLICE-0** — Walking Skeleton *(prerequisite for all; must complete before any feature slice;
   establishes `worker` channel, `model` reducer, `tui` event loop, `config`/`log`/`error`/`clock`)*
2. **SLICE-1** — Read NAND & console info *(sequential after SLICE-0; establishes the loaded/
   validated/extracted `ConsoleInfo` that SLICE-2, SLICE-3, and SLICE-4 depend on)*
3. **SLICE-2** — CPU-key library *(sequential after SLICE-1; bind needs SLICE-1's `ConsoleInfo`;
   shares `model`/`log`/`config`/`error`/`tui` with SLICE-1)*
4. **SLICE-3** — Build/patch (simulated) *(sequential after SLICE-1; needs a `Validated` source
   image)*
5. **SLICE-4** — Flash + guided troubleshooting (simulated) *(sequential after SLICE-1; needs flash
   source + detected `ConsoleType`)*
6. **SLICE-5** — TUI shell & cross-cutting *(sequential, built last; completes the shell over the
   capabilities SLICE-1…SLICE-4)*

**Parallel-eligible pairs / groups:**

| Slices | Basis for parallel eligibility |
|--------|-------------------------------|
| *(none fully disjoint)* | Every feature slice writes to the shared core modules `twinrunner-core::model` (reducer messages/commands) and `twinrunner-core::log`, and to the shared binary module `twinrunner::tui` (a new screen + keymap entries). Under the strict §16 disjoint-set rule, no two feature slices are fully parallel-eligible. **The closest-to-parallel pair is SLICE-3 + SLICE-4:** their *core domain* modules are disjoint (`build` vs `flash`+`troubleshoot`), so the bulk of each slice's logic can be implemented concurrently; only the shared `model` reducer arms, `worker` job-dispatch arms, `log`, `clock`, and `tui` screen-routing touch points must be serialized (or merged carefully). If the Orchestrator chooses to run SLICE-3 and SLICE-4 concurrently, it must serialize the `model`/`worker`/`tui` integration tasks (SLICE-3/TASK-014 and SLICE-4/TASK-018) and may parallelize the port/step domain tasks (SLICE-3/TASK-012,013 with SLICE-4/TASK-015,016,017). |

**Serialized pairs:**

| Slices | Reason for serialization |
|--------|--------------------------|
| SLICE-0 → SLICE-1 | SLICE-1 builds on the worker/reducer/event-loop spine and the `config`/`log`/`error`/`clock` modules SLICE-0 establishes. |
| SLICE-1 → SLICE-2 | Bind-with-mismatch-warning (REQ-013) consumes SLICE-1's extracted `ConsoleInfo`; both touch `model`/`log`/`config`/`error`/`tui`. |
| SLICE-1 → SLICE-3 | Build precondition (RULE-012) requires a `Validated`/`Extracted` source image from SLICE-1. |
| SLICE-1 → SLICE-4 | Flash source image + console-scoped troubleshooting flows (REQ-026) need SLICE-1's `ConsoleInfo`/`ConsoleType`. |
| SLICE-3 ↔ SLICE-4 | Both touch `twinrunner::worker` (job dispatch), `twinrunner-core::model` (Start*/Job* reducer arms), `twinrunner-core::log`, `twinrunner-core::clock`, `twinrunner::tui` (screen routing). Concurrent writes to these risk merge conflict and a drift race — serialize the shared-component integration tasks. |
| SLICE-2/SLICE-3/SLICE-4 → SLICE-5 | The shell (dashboard tiles, palette commands, logs view) is most coherent once the capabilities it surfaces exist; SLICE-5 also touches `model`/`log`/`config`/`tui` shared with all earlier slices. |

---

## Slice Verification Notes

Checklist the Critic verifies in slice mode (fresh context, coherence only). Pre-existing
acknowledged points are noted.

- [ ] Every slice is vertical: it touches the full stack end-to-end for its capability (interface
      `tui` → orchestration `model` → owning core module → `log`/`error`/filesystem). No pure
      horizontal-layer slice is present.
- [ ] Every slice delivers a user-demonstrable, independently testable capability (SLICE-1: view
      console info; SLICE-2: manage keys; SLICE-3: build artifact; SLICE-4: flash + troubleshoot;
      SLICE-5: navigate shell).
- [ ] Slice 0 is a genuine walking skeleton: it stands up the workspace and exercises every
      architectural boundary (event loop ↔ worker ↔ reducer ↔ shutdown) in one round-trip with an
      integration acceptance test, delivering no substantial feature.
- [ ] The ordering produces a working, demonstrable system after every slice (SLICE-1 read-only is
      safe before any mutating op; SLICE-3/SLICE-4 depend on SLICE-1's validated image; SLICE-5
      completes the shell last).
- [ ] All 44 MVP REQ-IDs from `01-requirements.md`/`02-scope.md` appear in the REQ Coverage Map;
      REQ-032 and REQ-NFR-010 (V1) are correctly excluded.
- [ ] Every slice in the Coverage Map has ≥1 anchored acceptance test reusing the exact
      `test_REQ*_<slug>` names from `tests/REQ-TEST-MAP.md`.
- [ ] `th coverage check` passes with zero gaps on the coverage map above.
- [ ] Component labels in "Components touched" match the canonical labels in `04-architecture.md`
      (`twinrunner-core::{nand,keys,build,flash,troubleshoot,model,log,config,error,clock}`,
      `twinrunner::{worker,tui}`).
- [ ] Parallel-eligibility analysis is explicit: under strict §16 no two feature slices are fully
      disjoint; SLICE-3 + SLICE-4 is the closest pair and is serialized on its shared
      `model`/`worker`/`log`/`clock`/`tui` touch points.
- [ ] No task file is missing for any task listed in Per-Slice Tasks above (22 task files across 6
      slices).

**Ordering note surfaced to the Orchestrator (no product-gating decision required):** The build
order (SLICE-1 → SLICE-2 → {SLICE-3, SLICE-4} → SLICE-5) is dictated by data dependency, not
go-to-market choice — SLICE-1's `ConsoleInfo` is a hard prerequisite for SLICE-2/SLICE-3/SLICE-4, so
there is no alternative ordering with different product implications to escalate. The only genuine
*concurrency* opportunity (run SLICE-3 and SLICE-4 in parallel) is a build-throughput decision, not
a product-demo-order decision; it is recorded above for the Orchestrator's scheduling, with the
shared-component serialization constraints made explicit.
