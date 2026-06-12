# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- **Schema versioning + `th migrate`:** `state.json` now carries an optional `schema_version` (stamped by `th init`; legacy files are treated as v1). `th migrate` upgrades a legacy/old file forward and refuses to downgrade one written by a newer `th`.
- **`th doctor`:** self-diagnostic for environment and project health (Node version, plugin layout, state validity, schema currency, stale state-lock, open blocking drift, audit-ledger size). Exit non-zero only on a hard failure.
- **`th context estimate`:** approximates the prompt-surface token cost (~4 chars/token) across skill/agent/command files and flags any over Claude Code's ~500-line / ~5,000-token guidance — visibility for the context-budget work (F7).
- **`th stage current|describe|list`:** a mechanical per-stage contract (produces / Critic mode / human-gate) derived from the pipeline table, so the orchestrator can re-derive a stage's obligations without depending on the prose playbook surviving the context window (F7).
- **`th manifest export`:** a deterministic run snapshot aggregating state, drift entries, and the gate ledger into one stable JSON (ledger timestamps dropped) for review, diffing, archival, or golden-fixture assertions.
- **Published JSON Schemas:** `schemas/state.schema.json` and `schemas/brief.schema.json` (draft-07) for editor validation, kept in sync with the hand-rolled validators by `tests/schemas.test.ts` (no runtime JSON-schema dependency added).
- **`SECURITY.md`** (threat model: gates bind only a compliant agent, Bash bypass, global hook firing, prompt injection, path containment) and **`CONTRIBUTING.md`** (the committed-`dist/` invariant, plugin-packaging invariants, dev loop).

### Changed

- **Right-sized the orchestrator playbook (F7):** `skills/twinharness/SKILL.md` (854 → ~210 lines) and `agents/critic.md` (797 → ~110 lines) were split into a lean always-loaded core plus on-demand reference files under `skills/twinharness/reference/` (`pipeline-stages.md`, `build-and-verify.md`, `critic-modes.md`). The cores now fit inside Claude Code's ~500-line / ~5,000-token post-compaction re-attach window, so long runs no longer lose the tail of the playbook; the lean files point to the reference files, which load only when a given stage/mode is active. No behavioral content was dropped (relocated verbatim); `tests/prompt-references.test.ts` enforces the size limits and reference-link integrity.
- Plugin/marketplace/package author metadata set to a real maintainer (`JrSneed28`) instead of the `TwinHarness` placeholder.

### Security

- **Path-traversal containment (S1):** `th artifact register`, `th coverage check` (`--reqs/--plan/--tests/--scope`), and `th tier classify|veto-check` now reject file/brief paths that resolve outside the project root (new `resolveWithinRoot` helper) instead of reading and content-hashing arbitrary files like `../../etc/hostname`.
- **Prototype-pollution guard (S3):** `th state set` refuses dotted keys containing `__proto__`, `prototype`, or `constructor` segments (e.g. `revise_loop_counts.__proto__.x`) before any assignment runs.
- **Bash-write defense-in-depth (F8):** a second `PreToolUse` matcher (`Bash`) heuristically catches obvious shell writes (`> file`, `>>`, `tee`, `dd of=`, `sed -i`) into in-root implementation paths during Phase A (pre-implementation). Conservative and fail-open — it never gates Bash in Phase B and allows anything it can't clearly parse; it narrows, but does not close, the documented Bash bypass.

### Added

- **Gate-mutation audit ledger (F5):** an append-only `.twinharness/gate-ledger.jsonl` records every gate-relevant state change (`implementation_allowed`, `tier`, `blast_radius_flags`, `write_gate`, `drift_open_blocking`) and blocking-drift open/resolve, with timestamps. The gates only bind a compliant agent; this makes overrides auditable after the fact. Observability only — it never blocks a mutation and makes no provenance claim (the CLI cannot tell who invoked it).

### Fixed

- **Invalid slice status in the orchestrator playbook (F1):** `SKILL.md` and `agents/orchestrator.md` instructed `th slice set-status <SLICE-ID> complete`, but `complete` is not a valid status (`pending|in-progress|done|blocked`) and the CLI rejected it — leaving the slice un-advanced and the Phase-B write-gate flagging it. Corrected to `done`. A new `tests/prompt-contract.test.ts` scans the prompts and fails if any documented `set-status` value is not a real status.
- **Test-anchor convention could not match the REQ-ID extractor (F2):** the documented `test_REQ001_<slug>` naming has no hyphen, so the `REQ-[A-Z0-9]…` extractor (and therefore `th anchors scan` / `th coverage check`) never matched it. `agents/builder.md` and `SKILL.md` now require the canonical hyphenated anchor (`REQ-001`, `REQ-NFR-002`) in the test description/comment, with a descriptive function name for readability. New `tests/anchor-convention.test.ts` pins the round-trip.
- **NotebookEdit writes bypassed the write-gate (F3):** the PreToolUse gate matched `NotebookEdit` but read only `tool_input.file_path`; NotebookEdit passes `notebook_path`, so notebook writes were always allowed. The gate now falls back to `notebook_path`. New pretool-gate tests cover the Phase-A notebook case and the doc-path allow case.
- **Lost updates under parallel builds (F10):** every `th` invocation is a separate process, and parallel Builders doing concurrent `drift add` / `slice set-status` / `artifact register` / `state set` could lose a read-modify-write — a dropped requirement-layer `drift add` would leave the stop-gate able to pass a run it should block. State mutations now run under a cross-process advisory lock (`withStateLock`, atomic `mkdir` on `<stateDir>/.state.lock`, with timeout and stale-lock stealing). New `tests/concurrency.test.ts` spawns 20 parallel `drift add` processes and asserts no increment or DRIFT-id is lost; CI now builds before testing so the test exercises the shipped CLI.

### Changed

- **Removed the dead `MultiEdit` matcher token (F4):** MultiEdit was removed from Claude Code in 2.0; the PreToolUse matcher is now `Write|Edit|NotebookEdit`.
- **Calibrated over-stated enforcement language (F5/F8):** the README and `spec/write-gate-design.md` no longer describe the write-gate as "physically enforced" / code that "cannot" be bypassed. Both gates are strong defaults on the Write/Edit path; Bash-mediated writes (`echo >`, `sed -i`) are explicitly out of scope, and the orchestrating agent can set state fields directly.

### Added

- **Continuous integration:** `.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --exit-code dist/` on every push and pull request — enforcing the committed-`dist/` invariant on PRs (previously checked only by a unit test).

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
