# SLICE-5 / TASK-021 — ConfigSettings + AppConfig resolution (FS-004) + cross-platform paths

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-033, REQ-NFR-002
**Slice:** SLICE-5 — TUI shell & cross-cutting behavior
**Depends on:** SLICE-5 / TASK-020 complete

---

## Goal

Complete `AppConfig` resolution (defaults → TOML file → env/flags) with platform config/data/log
directory discovery and first-run creation, per-field fallback that never aborts startup, and the
`ConfigSettings` editor screen — with all path handling done via `PathBuf` so the binary is
genuinely cross-platform.

---

## REQ-IDs

- **REQ-033** — Read configuration (data/library locations, default paths, backend selection, log
  verbosity) from a config file and/or flags/environment, with sane defaults so it runs out of the
  box.
- **REQ-NFR-002** — Cross-platform single Rust binary: path handling/file I/O account for
  Windows/Linux/macOS differences.

---

## Relevant Contracts / Interfaces

**FS-004 — AppConfig file schema** (TOML; no `schema_version` — config file, not data file):

```
library_path  = String  [default: platform data dir + "/twinrunner/keys.json"]
output_dir    = String  [default: current working directory]
build_backend = String  [default: "Simulator"]  // "Simulator" | "RealStub"
flash_backend = String  [default: "Simulator"]  // "Simulator" | "RealStub"
log_verbosity = String  [default: "Info"]        // "Info" | "Warning" | "Error"
log_file_path = String  [default: absent]        // absent = no file logging

// Unknown keys ignored (forward-compatible). Invalid value → per-field default + Warning at startup;
// NEVER abort startup (REQ-033). Invalid-UTF-8 path → treated as absent.
```

**`AppConfig::load`** resolves defaults, then the TOML file, then env/flags. Directory discovery uses
a platform-dirs convention (`directories`/`dirs`); config/data/log dirs are created on first run.

---

## Relevant Design Notes — wireframe (embed; do not invent)

**`ConfigSettings`** (anchors REQ-033, REQ-NFR-002): form fields `KeyLibrary path`, `Default output
directory`, `BuildBackend` dropdown (`Simulator (default)` / `RealBackend = no-op stub — not impl.`),
`FlashBackend` dropdown (same), `Log verbosity` (`Info`/`Warning`/`Error`); `[S] Save  [R] Reset to
defaults  [Esc] Back`. Empty state: fields populated with `[default]`-labeled defaults. Error state:
`[ERR] Could not save config: <msg>. Check file permissions at <path>.` (inline; values preserved).

**Cross-platform paths (REQ-NFR-002):** construct every path with `std::path::PathBuf`; no hard-coded
`/` or `\`. Default `library_path`/`output_dir`/`log_file_path` come from the platform dirs.

---

## Acceptance Test(s)

- `test_REQ033_config_invalid_field_falls_back_to_default` — `AppConfig::load` with an invalid field
  value → per-field fallback to default; startup not aborted. *(unit)*
- `test_REQ033_config_dir_create_failure_uses_defaults` — config dir creation fails (permission
  denied on tempdir) → in-memory defaults used; no startup abort. *(integration)*
- `test_REQ033_config_reloads_or_defaults_after_restart` — write a valid config to tempdir; a new
  `AppConfig::load` reads it; a missing config falls back to defaults without panic. *(integration)*
- `test_REQ033_restart_starts_fresh_session` — `Model::new(config)` always starts with an empty
  `Session`; no state leaks from a previous session in the same process. *(unit)*
- `test_REQ_NFR002_path_handling_cross_platform` — all paths constructed via `PathBuf`; no
  hard-coded separator; round-trip on the current platform. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass; ConfigSettings edits resolve and persist; defaults work out of the
      box on a fresh run.
- [ ] No hard-coded path separators anywhere in the resolved paths (REQ-NFR-002).
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it matches FS-004 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-033, REQ-NFR-002 still map to passing tests).

---

## Out of Scope for This Task

- LogsView + logging internals — SLICE-5 / TASK-020 (this task only configures verbosity/file path).
- Widget layer / Dashboard / palette — SLICE-5 / TASK-019.
- Resize/Help/launch-latency — SLICE-5 / TASK-022.
- Backend *behavior* (Simulator vs RealStub) — SLICE-3/D (this task only selects which is configured).
