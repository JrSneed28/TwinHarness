# SLICE-3 / TASK-013 — `BuildJob::step` — deterministic progress + checksum + ECC/XeLL output

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-017, REQ-018, REQ-019, REQ-NFR-005
**Slice:** SLICE-3 — Build / patch image workflow (simulated)
**Depends on:** SLICE-3 / TASK-012 complete

---

## Goal

Implement `BuildJob::step(clock)` driving the deterministic step-count progress engine: emit
monotonic 0→100% progress with phase-named log entries, write the ECC or XeLL artifact atomically
(temp+rename), and compute a deterministic, clock-free sha256 checksum over the canonical input set —
so identical `BuildInputs` always reproduce the same checksum, and a cancel/failure leaves no partial
file and never touches the source.

---

## REQ-IDs

- **REQ-017** — Generate ECC files via the simulated backend to a user-chosen output path.
- **REQ-018** — Generate XeLL / recovery files via the simulated backend to a user-chosen output
  path.
- **REQ-019** — Show deterministic progress (0→100%) + a streaming log, and on completion report a
  verifiable result (output path, size class, deterministic checksum) reproducible from the same
  inputs.
- **REQ-NFR-005** — Determinism: identical inputs always yield identical progress sequences, results,
  checksums, and logs.

---

## Relevant Contracts / Interfaces

**IF-010 — `BuildJob::step`:**

```
step(clock: &dyn Clock) -> StepOutcome
StepOutcome::Progress { pct: u8, log: LogEntry }   // pct 0..=100 monotonic non-decreasing
StepOutcome::Done(BuildArtifact { output_path, artifact_type, size_class, checksum })  // exactly once; file written+renamed
StepOutcome::Failed(ValidationIssue)               // exactly once; no file at output_path; temp removed

Failed variants: WriteError (fs write/rename failed) · Cancelled (worker stopped stepping after Cancel)
// Postconditions: Done → file exists, checksum = sha256 of canonical clock-free input set (RULE-007), output != source.
//                 Failed → no file at output_path; source untouched (RULE-001/INV-001).
//                 exactly one Done|Failed after the last Progress; no outcomes after terminal (INV-007).
```

**IF-018 — `Clock`:** `clock.now()` is used **only** for display/audit (`started_at`); it **must
not** enter the checksum input set or the progress sequence (ADR-006 / INV-005). Tests inject
`FixedClock`.

**FS-006 — output image:** binary; written atomically (temp+rename); checksum is 64 lowercase hex.

---

## Relevant Design Notes

- **Step-count progress engine** (`06-technical-design`): the job declares a fixed ordered phase list
  (e.g. `[Prepare, PatchRegions, ComputeEcc, WriteOutput, Checksum]`); `step()` advances
  `step_index`, computes `pct = step_index * 100 / step_count`, emits `Progress { pct, log }`.
  Progress is **purely a function of step_index** — no sleep, no wall-clock. After the final phase,
  compute the terminal result and emit `Done`/`Failed`.
- **Checksum input set (clock-free, deterministic)** — sha256 over, in this exact order: (1) the
  **source file contents** (raw dump bytes), (2) `timing_file_id` UTF-8 bytes then the resolved
  `TimingFile.content` bytes, (3) the `artifact_type` discriminant byte (`EccFile=0x01`,
  `XeLLImage=0x02`), (4) a fixed simulator transform-constant. **Excluded:** wall-clock, timestamps,
  RNG, output-path string, job UUID. → identical inputs ⇒ identical checksum on any machine
  (RULE-007). Two builds with different output paths but identical inputs → **same** checksum
  (correct, intended).
- **Atomic write-ordering:** write a temp file alongside the output path, compute the checksum,
  rename into place on success; cancel/failure leaves **no** partial at the final path and never
  touches the source.

---

## Acceptance Test(s)

- `test_REQ015_build_happy_path_steps_to_completion` — submit a build job, drain events; final event
  `JobCompleted { Succeeded }`; output file exists at `output_path`. *(integration)*
- `test_REQ017_build_ecc_output_written_to_path` — simulated ECC build writes a `> 0`-byte file at
  the user-chosen path. *(integration)*
- `test_REQ018_build_xell_output_written_to_path` — simulated XeLL build writes a `> 0`-byte file at
  the user-chosen path. *(integration)*
- `test_REQ019_build_progress_0_to_100` — progress sequence starts at `pct = 0`, ends at `100`,
  monotonically non-decreasing. *(integration)*
- `test_REQ019_build_same_inputs_same_checksum` — two runs with identical `BuildInputs` + `FakeClock`
  → byte-identical checksums (RULE-007). *(unit)*
- `test_REQ015_build_write_error_leaves_no_partial` — induced write failure → no file at
  `output_path`; source byte-identical. *(integration)*
- `test_REQ015_build_cancel_leaves_no_partial_artifact` — cancel mid-steps → no file at
  `output_path`; source untouched. *(integration)*
- `test_REQ_NFR005_build_determinism_with_fake_clock` — two runs, identical inputs + `FakeClock` →
  byte-identical checksums. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass; the checksum is provably clock-free and reproducible.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it matches IF-010 / FS-006 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-017, REQ-018, REQ-019, REQ-NFR-005 still map to
      passing tests).

---

## Out of Scope for This Task

- The trait port + prepare preconditions — SLICE-3 / TASK-012.
- The worker-thread job stepping integration + ordered-events assertion — SLICE-3 / TASK-014.
- The BuildWorkflow screen — SLICE-3 / TASK-014.
