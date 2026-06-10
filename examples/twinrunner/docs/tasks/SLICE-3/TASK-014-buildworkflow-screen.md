# SLICE-3 / TASK-014 — BuildWorkflow screen + worker dispatch wired through the reducer

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-015, REQ-016, REQ-019, REQ-020
**Slice:** SLICE-3 — Build / patch image workflow (simulated)
**Depends on:** SLICE-3 / TASK-013 complete

---

## Goal

Wire the three-phase `BuildWorkflow` screen through the reducer and the worker: a `BuildInputs` form
(source/artifact-type/timing-file/output) that dispatches `Command::RunBuild` to the worker on
confirm, a running phase that streams ordered `WorkerEvent` progress + log into the Model, and a
result phase showing the `BuildArtifact` (path, size class, deterministic checksum) with a
"source not modified" note — all behind the `[SIMULATED]` badge.

---

## REQ-IDs

- **REQ-015** — Guided build/patch workflow producing a patched output image; never overwrites the
  source.
- **REQ-016** — Timing-file selection recorded in the build inputs.
- **REQ-019** — Deterministic 0→100% progress + streaming log + verifiable result on completion.
- **REQ-020** — All build ops behind the `BuildBackend` trait; simulator default, real backend
  no-op (the screen surfaces the active backend and never bypasses the port).

---

## Relevant Contracts / Interfaces

**IF-015 reducer arms:** `ConfigureBuild(BuildInputs)` (sets pending inputs); `StartBuild` (checks
RULE-012/RULE-002/RULE-001; **pass** → `Command::RunBuild(prepared_job)` + set active-job slot;
**fail** → write `ValidationIssue` into Model, no command); worker-event folds `JobStarted`,
`JobProgressed{pct}`, `JobLogged{entry}`, `JobCompleted{result}`, `JobFailed{error}`.

**IF-013/IF-014 worker channel:** `Command::RunBuild` → `WorkerCommand::StartBuild(BuildJob)`; the
worker emits ordered `Started → Progress* → (Completed|Failed)`; the loop drains with `try_recv` each
tick. **One job at a time** — a second `StartBuild` while a job is active is refused into the Model.

---

## Relevant Design Notes — wireframes (embed; do not invent layout)

**Phase 1 — BuildInputs form** (`Phase [1 of 3] · Backend: SimulatorBackend [SIMULATED]`): fields
`Source NandImage` (pre-populated from active dump, shown `[64 MB · Jasper · VALID ✓]`), `Artifact
type` radio `(•) ECC image  ( ) XeLL image`, `TimingFile` dropdown from the managed list (each line
`<slug> — <console> · <glitch> · deterministic fixture`), `Output path`; `[B] Build  [Esc] Back`.
Empty state when no dump loaded: `[!] No NandImage loaded — load a dump first ([1] Read NAND)` and
Build disabled. Inline `[ERR]` per field on validation failure (missing timing file, output==source).

**Phase 2 — Running** (`Phase [2 of 3]`): a `ProgressBar` `████░░ 47%`, a `StreamingLogPanel`
scrolling `[ts] INFO build <phase>` lines, `[Esc] Cancel build (will stop job)`.

**Phase 3 — Result** (`Phase [3 of 3]`): `[✓] BUILD SUCCEEDED`; `BuildArtifact` detail `Type · Path
· SizeClass · SHA-256`; `Source dump not modified. Output written to new file only. [✓]`;
`[F] → Flash  [L] View in Logs  [R] New Build  [Esc] Back`. Error state: `[ERR] Build FAILED: <msg>`
+ `[R] Return to inputs` / `[Esc] Dashboard`. **No color-only state** (REQ-NFR-009).

---

## Acceptance Test(s)

- `test_REQ015_build_happy_path_steps_to_completion` — screen-driven `ConfigureBuild` + `StartBuild`
  dispatches to the worker; draining events leaves the Model in the `Succeeded` result state with the
  output file at `output_path`. *(integration)*
- `test_REQ016_timing_file_selection_recorded_in_inputs` — the form's timing-file selection is
  recorded in the dispatched `BuildInputs`. *(unit)*
- `test_REQ019_worker_events_ordered_per_job` — for one job the worker delivers
  `Started → Progress* → (Completed|Failed)` in order over the mpsc channel; the Model folds them in
  order. *(integration)*
- `test_REQ020_simulator_backend_satisfies_trait` — the dispatched job runs via `dyn BuildBackend`
  (simulator) to `Succeeded` with a non-empty checksum. *(contract)*

---

## Definition of Done

- [ ] All acceptance tests pass; the three-phase BuildWorkflow is demonstrable from the keyboard.
- [ ] A second build while one is active is refused (one-job-at-a-time) and surfaced, not crashed.
- [ ] No state communicated by color alone — REQ-NFR-009 honored (`[SIMULATED]`, `[✓]`, `[ERR]`).
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] `th coverage check` does not regress (REQ-015, REQ-016, REQ-019, REQ-020 still map to passing
      tests).

---

## Out of Scope for This Task

- The trait port + `prepare` + `BuildJob::step` internals — SLICE-3 / TASK-012, TASK-013.
- The Dashboard "Last Job" tile — SLICE-5 / TASK-019.
- LogsView rendering of build entries — SLICE-5 / TASK-020 (this task only streams into the Model).
- Flash workflow — SLICE-4.
