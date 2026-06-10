# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.3.0] — 2026-06-10

### Added

- **PreToolUse write-gate** (`th hook pretool-gate`): a `PreToolUse` hook entry in `hooks/hooks.json` with matcher `Write|Edit|MultiEdit|NotebookEdit` intercepts file writes before they reach the filesystem.
  - **Phase A (pre-implementation):** while `implementation_allowed` is false, any write to a non-doc/non-state path fires with configurable semantics — `ask` (default), `deny`, or `off`.
  - **Phase B (mid-build):** once slices exist and implementation is allowed, writes to paths owned by a slice that is not `in-progress` are flagged as a likely component-boundary violation; in-progress slices' paths and unowned paths are always allowed.
  - Optional `write_gate: "ask" | "deny" | "off"` field in `state.json`; absent means `ask`. Configurable via `th state set write_gate ask|deny|off`.
  - `TH_DISABLE_WRITE_GATE=1` environment escape hatch for one-session bypass.
  - Fail-open throughout: no `state.json` → instant allow; invalid state → allow with warning; doc/state paths (`docs/**`, `.twinharness/**`, `.agentic-sdlc/**`, `.claude/**`, `drift-log.md`, root `*.md`, `.gitignore`) → always allowed.
  - Gate reason text names the current stage and the legitimate unlock path; agents are instructed to escalate to the human rather than retry (anti-spin, mirroring stop-gate handling).
  - See `spec/write-gate-design.md` for the full design.

---

## [0.2.0] — 2026-06-10

### Added

- Two new agents (7 total): `doc-writer` (Stage 10.5 — tier-scaled documentation; Critic-reviewed in `documentation` mode; no human gate) and `ui-designer` (Stage 4b — conditional on project having a UI; presents 2–3 design-direction previews via `AskUserQuestion` before detailed design streams; Critic-reviewed in `ui-design` mode).
- `th slices sync [--plan F] [--dry-run] [--remove-missing]` — parse `docs/09-implementation-plan.md` into `state.slices`; statuses preserved on re-sync.
- `th slice set-status <SLICE-ID> <status>` — set a single slice's status.
- `th stale --artifact <file>` — look up a registered artifact by file key before re-registering (safe cascade re-verification entry point).
- `th version` — print the CLI version.
- `--source <s>` flag for `th drift add` — log who added the entry (no longer hardcoded to Builder).
- `--scope <file>` flag for `th coverage check` — override MVP scope file (default `docs/02-scope.md`); coverage now scans tests/ fully recursively across any language and applies an MVP filter from the scope file's `## MVP Scope` section.
- Critic gained `scope`, `documentation`, and `ui-design` modes.
- Model & effort routing policy documented in `SKILL.md` and `agents/orchestrator.md`: sonnet by default; opus where wrong answers are expensive; haiku for trivial recaps.
- `spec/` directory; `spec/TwinHarness-Plan.md` (renamed from repo root) and `spec/build-plan.md`.
- `homepage` and `repository` fields in `.claude-plugin/plugin.json`.

### Changed

- State directory renamed `.agentic-sdlc` → `.twinharness`; automatic legacy fallback means existing projects with `.agentic-sdlc/state.json` keep working without migration.
- `th build plan` is now fed by `th slices sync` (reads `state.slices`, not the raw plan document directly).
- ARTIFACT_PIPELINE order fixed: `07-contracts` → `08a-security` → `08b-failure` → `08-test-strategy` → `09` → `10`.
- Trace render now associates SLICE/TASK tokens per-REQ instead of dumping all tokens on every row.
- `th state set` now rejects unknown top-level keys (exit with `unknown_field` error).
- `th drift resolve` validates the drift ID exists, rejects double-resolves, and only decrements the blocking counter for requirement-layer entries.
- Stage 10.5 Documentation added between implementation and final verification in the full pipeline.
- Stage 4b UI Design added (conditional) between Architecture and Contracts/Test Strategy.

### Fixed

- `th stale --since` documentation clarified: returns ALL registered downstream artifacts of the changed file in pipeline order — it does not diff summaries.
- Protocol docs corrected: cascade re-verification starts with `th stale --artifact` BEFORE re-registering; PreToolUse hook does not exist (Stop hook only).
- `th drift add --source` heading no longer hardcodes "Builder" when `--source` is provided.

### Removed

- `.omc/` directory and all associated ignore rules removed from the repo and `.gitignore`.

---

## [0.1.1] — 2026-06-09

### Added

- `USAGE.md` — full usage guide (install through advanced CLI reference).
- `package-lock.json` version synced to match `package.json` `0.1.1`.

---

## [0.1.0] — initial release

### Added

- Initial plugin: 5 agents (orchestrator, spec, critic, vertical-slice, builder), `th` CLI, Stop hook gate, 8 build slices.
- Core `th` commands: `init`, `state`, `tier`, `artifact`, `coverage`, `build plan`, `anchors`, `trace`, `stale --since`, `drift`, `revise`, `hook stop-gate`.
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` for Claude Code plugin installation.
- REQ-anchored vitest suite covering CLI behavior and plugin-packaging integrity.
