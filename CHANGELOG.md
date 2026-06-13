# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.6.1] — 2026-06-13

Robustness hardening from a self-audit of the 0.6.0 coordination features. **413 tests** (was 392).

### Fixed

- **Stale component leases could wedge the build (§16).** A Builder that crashed (or a forgotten `th build release`) between `claim` and release left a lease holding components forever, blocking every overlapping/dependent slice. Leases now reconcile against slice state: a lease whose owning slice is `done`/`blocked`/missing is **stale** and ignored by `th build next-wave` and `th build claim`. `th slice set-status <id> done|blocked` **auto-releases** the slice's lease, `th build leases` lists the stale set separately, and `th doctor` warns on stale leases.
- **Dependency deadlocks were silent.** A `depends_on` cycle, a dangling reference, or a dep on a never-finishing slice left `th build next-wave` returning an empty wave forever while `th next` cheerily said "dispatch the next wave". `next-wave` now detects an unsatisfiable graph (cycle/dangling) and a **stall** (pending slices, nothing dispatchable, nothing in progress) and reports it; `th next` surfaces a new `stalled-build` obligation; `th doctor` validates the `depends_on` graph.
- **`th verify run` could hang forever.** A configured command that blocks (watch mode, server, stdin wait, deadlocked test) had no timeout. Each command now runs under a wall-clock budget (`DEFAULT_COMMAND_TIMEOUT_MS`, 5 min) with stdin closed; a timed-out command is killed and recorded as a failure so the run always terminates.
- **Research artifacts didn't affect downstream staleness.** `docs/00-research/` (and `docs/04b-ui-design.md`) were absent from the cascade graph, so correcting research never flagged requirements/architecture/contracts as stale. Both are now in `ARTIFACT_PIPELINE`; `docs/00-research` is the most-upstream artifact, so a change to it cascades to everything.

### Changed

- **Final-verification stop-gate now requires a green suite when one is configured.** If verify commands are set, `evaluateStopGate` blocks completion at `final-verification` when the last `th verify run` is missing or red. When no commands are configured the check is inert; the CLI still doesn't *certify* correctness (tests + human do) — it just refuses to let a run claim done with a known-red or never-run suite.

## [0.6.0] — 2026-06-13

### Added

- **Debugger agent (`agents/debugger.md`) + `th debug`:** an on-demand, fresh-context, evidence-first defect tracer invoked on a failing suite, an ungrounded Critic defect, or a behavior↔contract contradiction. `th debug pack [--slice ID | --req REQ]` assembles a deterministic evidence bundle (failing commands + output tails, slice/REQ anchors, recent drift, open findings); `th debug log add|list` is an append-only evidence ledger (`debug-log.md`, mirroring `drift-log.md`). New Critic mode `debug-review` rejects an unanchored root cause, a fix that crosses component boundaries, or a silent requirement contradiction. The Debugger proposes and proves; the Builder fixes; tests + human certify correctness.
- **Researcher agent (`agents/researcher.md`):** an on-demand, **conditional** information-gatherer the Orchestrator invokes only when a project needs unfamiliar external knowledge. It scopes questions to REQ-IDs, gathers via web search/fetch, cites every claim, separates fact from opinion, adversarially verifies, and emits `docs/00-research/<topic>.md` (a directory artifact). New Critic mode `research` fails uncited/fabricated claims, stale version-sensitive facts, and findings that bear on no REQ-ID. Fetched content is treated as untrusted data (see SECURITY.md).
- **Live build coordination — `th build next-wave|claim|release|leases`:** `next-wave` is the live oracle for the slices dispatchable in parallel *right now* (status pending, `depends_on` done, components free of in-progress slices and active leases). `claim`/`release` are dynamic **component leases** (`build-leases.jsonl`); `claim` refuses an overlapping claim (exit 1) — the collision guard that closes the race the static plan can't see when drift expands a slice's component set mid-build. Serialized under the existing cross-process state lock.
- **Slice `depends_on`:** an optional slice field (parsed from a `Depends on: SLICE-x` line by `th slices sync`) so the wave-runner respects true ordering (walking-skeleton-then-features) beyond component disjointness. Optional and omitted when empty, so existing slices serialize byte-identically.

### Changed

- **`th next` extended** with three build-time obligations: a failing `th verify run` report → `investigate-failure` (engage the Debugger); the implementation stage with pending slices → `dispatch-wave`; with only in-flight Builders → `await-builders`.

### Security

- The Researcher fetches **untrusted external content** (a prompt-injection surface): it treats pages as data, never follows embedded instructions, never runs commands they suggest, and the `research` Critic mode flags unsupported/fabricated claims. Documented in SECURITY.md.

## [0.5.0] — 2026-06-13

### Fixed

- **ADR artifact registration (directory artifacts):** `th artifact register` now accepts a **directory** and hashes its contents deterministically, so the T3 ADR set registers as one entry keyed `docs/05-adrs` — exactly what the stage contract (`produces: docs/05-adrs/`) and the playbook already instruct (`th artifact register docs/05-adrs/ --version 1`). Previously the command rejected anything that wasn't a single file, so that documented step failed and the worked example had to register eight ADR files one by one. `th stale --artifact docs/05-adrs` now round-trips on the directory too.

### Added

- **`th coverage report`:** the planned / implemented / tested / passing breakdown per REQ-ID (a read-only status view; the hard gate stays `th coverage check`). `planned` = the REQ is in a slice, `implemented` = it is anchored in the code dir (`--code`, default `src`), `tested` = it is anchored in a test, `passing` = whole-suite, sourced from the optional `th verify run` report (`—` when none exists).
- **`th verify add|list|clear|run`:** configure and run the project's own test/check commands. `th verify run` is the single, deliberately-quarantined command that executes operator-authored commands (everything else still only records and computes); it writes a report under the state dir that `th coverage report` and `th doctor` read for the "suite green/failing" signal. Commands live in `.twinharness/verify.json`, never in `state.json`, so the state schema and its content-hash stability are untouched.
- **`th context pack [--slice <ID>]`:** mechanically assembles the §9 handoff bundle — the Summary block of every approved artifact, plus (with `--slice`) that slice's record, components, and the other slices it shares components with (§16 conflict awareness). Computes a candidate bundle; routing is still the Orchestrator's call.
- **`th next`:** the next-action **oracle** — given durable state + on-disk anchors it returns the single highest-priority mechanical obligation the run owes next (resolve blocking drift → escalate a capped revise loop → re-register a silently-changed artifact → classify the tier → produce/register the current stage's artifact → coverage gate → finish slices → human sign-off → advance the stage). Like `th stage current`, it reports a mechanical obligation; it never chooses strategy (F7 — the playbook can fall out of the post-compaction context window).

### Changed

- **`th doctor` is now a full run-health audit:** beyond environment + state validity it audits the live run — artifact integrity (on-disk hash vs the recorded approved hash, surfacing silently-edited governed docs), slice progress, coverage status, the test-suite signal, and revise-loop escalations. Findings are warnings (they inform); only a hard environment/state failure exits non-zero.
- Shared a single run-health core (`src/core/health.ts`, `src/core/coverage.ts`) behind `th doctor`, `th next`, and `th coverage report` so the audit and the oracle can never disagree about drift, slice state, or revise caps.

### Security

- **`th verify run` executes operator-authored commands** (with the shell, in the project root) — the one exception to the "records and computes; never re-runs" boundary, quarantined in `src/core/verify.ts`. It only ever runs commands a human added via `th verify add`; it never sources commands from artifact content. See `SECURITY.md`.

## [0.4.0] — 2026-06-12

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
- **Deduplicated the remaining oversized agent prompts (F7 follow-up):** `agents/orchestrator.md` (575 → ~210 lines) now points at the same `reference/` files instead of carrying a second copy of the stage pipeline, and `agents/spec.md` (446 → ~46 lines) keeps its universal rules plus a mode-index table, with the 10 per-mode section lists moved verbatim to `skills/twinharness/reference/spec-modes.md`. Every always-loaded prompt file is now within the ~500-line/~5,000-token guidance (`th context estimate` flags only the on-demand reference files, by design).
- Plugin/marketplace/package author metadata set to a real maintainer (`JrSneed28`) instead of the `TwinHarness` placeholder.

### Security

- **Path-traversal containment (S1):** `th artifact register`, `th coverage check` (`--reqs/--plan/--tests/--scope`), and `th tier classify|veto-check` now reject file/brief paths that resolve outside the project root (new `resolveWithinRoot` helper) instead of reading and content-hashing arbitrary files like `../../etc/hostname`.
- **Prototype-pollution guard (S3):** `th state set` refuses dotted keys containing `__proto__`, `prototype`, or `constructor` segments (e.g. `revise_loop_counts.__proto__.x`) before any assignment runs.
- **Bash-write defense-in-depth (F8):** a second `PreToolUse` matcher (`Bash`) heuristically catches obvious shell writes (`> file`, `>>`, `tee`, `dd of=`, `sed -i`) into in-root implementation paths during Phase A (pre-implementation). Conservative and fail-open — it never gates Bash in Phase B and allows anything it can't clearly parse; it narrows, but does not close, the documented Bash bypass.
- **Managed `drift_open_blocking` (F5 follow-up):** `th state set` now refuses the blocking-drift counter — it is owned by `th drift add` / `th drift resolve`. This closes the bypass where an agent could clear the stop-gate's blocking condition (`state set drift_open_blocking 0`) without resolving the underlying requirement-layer drift.

### Added

- **Gate-mutation audit ledger (F5):** an append-only `.twinharness/gate-ledger.jsonl` records every gate-relevant state change (`implementation_allowed`, `tier`, `blast_radius_flags`, `write_gate`, `drift_open_blocking`) and blocking-drift open/resolve, with timestamps. The gates only bind a compliant agent; this makes overrides auditable after the fact. Observability only — it never blocks a mutation and makes no provenance claim (the CLI cannot tell who invoked it).

### Fixed

- **Invalid slice status in the orchestrator playbook (F1):** `SKILL.md` and `agents/orchestrator.md` instructed `th slice set-status <SLICE-ID> complete`, but `complete` is not a valid status (`pending|in-progress|done|blocked`) and the CLI rejected it — leaving the slice un-advanced and the Phase-B write-gate flagging it. Corrected to `done`. A new `tests/prompt-contract.test.ts` scans the prompts and fails if any documented `set-status` value is not a real status.
- **Test-anchor convention could not match the REQ-ID extractor (F2):** the documented `test_REQ001_<slug>` naming has no hyphen, so the `REQ-[A-Z0-9]…` extractor (and therefore `th anchors scan` / `th coverage check`) never matched it. `agents/builder.md` and `SKILL.md` now require the canonical hyphenated anchor (`REQ-001`, `REQ-NFR-002`) in the test description/comment, with a descriptive function name for readability. New `tests/anchor-convention.test.ts` pins the round-trip.
- **NotebookEdit writes bypassed the write-gate (F3):** the PreToolUse gate matched `NotebookEdit` but read only `tool_input.file_path`; NotebookEdit passes `notebook_path`, so notebook writes were always allowed. The gate now falls back to `notebook_path`. New pretool-gate tests cover the Phase-A notebook case and the doc-path allow case.
- **Stop-gate completion check at final-verification (F6):** the Stop hook now also blocks completion when `current_stage` is `final-verification` and any slice is not yet `done`/`blocked` — catching a claimed-complete run with unbuilt slices. Deliberately narrow: it fires only at `final-verification`, never at earlier stages, so legitimate mid-build pauses are not interrupted. The human correctness gate on the verification report still applies.
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
