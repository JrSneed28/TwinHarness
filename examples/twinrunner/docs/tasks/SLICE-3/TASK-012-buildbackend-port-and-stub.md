# SLICE-3 / TASK-012 — `BuildBackend` port + Simulator + RealStub + prepare preconditions

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-015, REQ-016, REQ-020, REQ-035, REQ-NFR-004
**Slice:** SLICE-3 — Build / patch image workflow (simulated)
**Depends on:** SLICE-0 complete · SLICE-1 complete (needs a Validated/Extracted source image)

---

## Goal

Define the `BuildBackend` trait port and its two implementations — `SimulatorBuildBackend` (the only
acting adapter) and `RealStubBuildBackend` (unconditional no-op) — and implement `prepare(inputs)`
with its preconditions: a `Pending` `BuildJob` only when the source image is Validated/Extracted, the
timing file is known, and the output path differs from the source. The real stub never acts; no real
hardware-write path exists.

---

## REQ-IDs

- **REQ-015** — Guided build/patch workflow produces a patched output image via the simulated
  backend, never writing over the source dump.
- **REQ-016** — The build workflow selects a timing file from a managed set and records the selection
  in the build inputs.
- **REQ-020** — All build/patch operations execute behind the `BuildBackend` trait/port; the
  simulator is default; the real backend is a clearly-marked no-op stub.
- **REQ-035** — Always operate on copies / new files; output is a user-chosen path (≠ source).
- **REQ-NFR-004** — Simulated-backend safety: real backends are no-op stubs; no code path performs a
  real destructive write; verifiable by test.

---

## Relevant Contracts / Interfaces

**IF-009 — `BuildBackend` trait port:**

```rust
trait BuildBackend { fn prepare(&self, inputs: BuildInputs) -> Result<BuildJob, Vec<ValidationIssue>>; }

BuildInputs {
  source_image_path: String        // path of a Validated/Extracted NandImage; read-only
  timing_file_id:    String        // slug; must resolve to a known shipped TimingFile
  output_path:       String        // user-chosen; must NOT == source_image_path
  artifact_type:     ArtifactType  // EccFile | XeLLImage
}
BuildJob { id, inputs, backend_kind: Simulator|RealStub, state: Pending, progress_pct: 0,
           log_entries: [], artifact: None, started_at: None, completed_at: None }

Errors (Err(Vec<ValidationIssue { Error, .. }>)):
  NotImplemented     — RealStubBuildBackend::prepare called (ERR-014, RULE-006) → do not start job
  ImageNotValidated  — source not Validated/Extracted (ERR-015, RULE-012)
  UnknownTimingFile  — timing_file_id not in shipped fixtures (ERR-016)
  OutputEqualsSource — output_path == source_image_path (ERR-017, RULE-001) → refuse before any write
```

**Implementations:** `SimulatorBuildBackend` performs all simulation (stepping/writing happens in
TASK-013). `RealStubBuildBackend::prepare` returns `NotImplemented` unconditionally and writes
nothing.

---

## Relevant Design Notes

- **Port is the only path (INV-004 / RULE-006):** every build flows through `BuildBackend`; the
  simulator is the only acting adapter, the stub is no-op. This is the load-bearing safety boundary
  for REQ-NFR-004 — assert it by test, not inspection.
- **Preparation has no side effects:** `prepare` returns a `Pending` job; no file is written until
  the worker calls `step()` (TASK-013).
- **TimingFile registry:** `timing_file_id` resolves against the shipped managed set; record the
  selection in `BuildInputs` (REQ-016). Unknown slug → `UnknownTimingFile`.

---

## Acceptance Test(s)

- `test_REQ015_build_prepare_requires_validated_source` — `prepare` on a non-Validated image →
  `ImageNotValidated` (ERR-015); no `Pending` job. *(unit)*
- `test_REQ016_timing_file_selection_recorded_in_inputs` — `prepare` with a known `timing_file_id`
  records that selection in `BuildInputs`; visible in job metadata. *(unit)*
- `test_REQ016_build_prepare_unknown_timing_file` — `prepare` with an unrecognized `timing_file_id`
  → `UnknownTimingFile` (ERR-016); no job created. *(unit)*
- `test_REQ020_simulator_backend_satisfies_trait` — `SimulatorBuildBackend` via `dyn BuildBackend`
  → `prepare` succeeds (the step loop to `Succeeded` is completed in TASK-013). *(contract)*
- `test_REQ020_real_build_stub_never_acts` — `RealStubBuildBackend::prepare` → `NotImplemented`
  (ERR-014); no file written; no `Pending` job. *(contract)*
- `test_REQ035_build_refuses_output_equals_source` — `output_path == source_image_path` →
  `OutputEqualsSource` (ERR-017); refused before any byte written. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it matches IF-009 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-015, REQ-016, REQ-020, REQ-035, REQ-NFR-004 still
      map to passing tests).

---

## Out of Scope for This Task

- `BuildJob::step` (progress/checksum/output write) — SLICE-3 / TASK-013.
- The BuildWorkflow screen + worker dispatch — SLICE-3 / TASK-014.
- The FlashBackend port — SLICE-4 / TASK-015.
