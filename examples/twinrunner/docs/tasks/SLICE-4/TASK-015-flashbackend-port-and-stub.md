# SLICE-4 / TASK-015 — `FlashBackend` port + Simulator + RealStub + prepare preconditions

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-021, REQ-022, REQ-NFR-004
**Slice:** SLICE-4 — Flash workflow + guided RGH/JTAG troubleshooting (simulated)
**Depends on:** SLICE-0 complete · SLICE-1 complete (flash source image + ConsoleType)

---

## Goal

Define the `FlashBackend` trait port and its two implementations — `SimulatorFlashBackend` (the only
acting adapter) and `RealStubFlashBackend` (unconditional no-op) — and implement `prepare(op,
programmer, image_path)` for Read/Write/Erase with its preconditions. The real stub never acts; no
real destructive write to physical hardware is possible.

---

## REQ-IDs

- **REQ-021** — Flashing workflow offers read/write/erase against a simulated programmer; the
  operation, target, and image are clearly shown before execution.
- **REQ-022** — Every flashing operation runs behind the `FlashBackend` trait/port with the
  simulator as default; the real hardware backend is a no-op stub; the app never performs a real
  destructive write to physical hardware.
- **REQ-NFR-004** — Simulated-backend safety: real backends are no-op stubs; no code path performs a
  real hardware write; verifiable by test.

---

## Relevant Contracts / Interfaces

**IF-011 — `FlashBackend` trait port:**

```rust
trait FlashBackend {
    fn prepare(&self, op: FlashOperation, programmer: Programmer, image_path: Option<&Path>)
        -> Result<FlashJob, Vec<ValidationIssue>>;
}
FlashOperation = Read | Write | Erase
Programmer { id: String, connection_state: Connected, capacity: SizeClass }
FlashJob { id, operation, programmer_id, image_path: Option<String>, backend_kind,
           state: Pending, progress_pct: 0, log_entries: [], verify_result: None,
           recovery_steps: [], started_at: None, completed_at: None }

Errors (Err(Vec<ValidationIssue { Error, .. }>)):
  NotImplemented        — RealStubFlashBackend::prepare called (ERR-014, RULE-006)
  ImagePathRequired     — Write with image_path = None (ERR-020, RULE-012)
  SizeClassMismatch     — programmer.capacity != image SizeClass (ERR-021)
  ProgrammerDisconnected— programmer not Connected (ERR-022)
```

**Implementations:** `SimulatorFlashBackend` is the only acting adapter (stepping in TASK-016).
`RealStubFlashBackend::prepare` returns `NotImplemented` unconditionally — no real write path reachable.

---

## Relevant Design Notes

- **Port is the only path (INV-004 / RULE-006):** every flash op flows through `FlashBackend`; the
  simulator is the only acting adapter, the stub is no-op. The entire REQ-NFR-004 claim ("no real
  write path exists") rests on this — asserted by contract test, not inspection.
- **Preparation has no side effects:** `prepare` returns a `Pending` job; nothing is "written" until
  the worker calls `step()` (TASK-016).
- **Write preconditions:** Write requires `image_path = Some`, a `Connected` programmer, and
  `programmer.capacity` matching the image `SizeClass`. Read/Erase do not require an image path.

---

## Acceptance Test(s)

- `test_REQ021_flash_read_write_erase_ops_available` — `prepare` accepts `Read`, `Write`, `Erase`;
  each produces a valid `FlashJob`. *(unit)*
- `test_REQ021_flash_write_requires_image_path` — Write with `image_path = None` →
  `ImagePathRequired` (ERR-020); no job. *(unit)*
- `test_REQ021_flash_size_class_mismatch_refused` — programmer capacity ≠ image `SizeClass` →
  `SizeClassMismatch` (ERR-021); no job. *(unit)*
- `test_REQ021_flash_disconnected_programmer_refused` — programmer not `Connected` →
  `ProgrammerDisconnected` (ERR-022); no job. *(unit)*
- `test_REQ022_simulator_backend_satisfies_trait` — `SimulatorFlashBackend` via `dyn FlashBackend`
  → `prepare` succeeds (the full Write+Verify cycle completes in TASK-016). *(contract)*
- `test_REQ022_real_flash_stub_never_acts` — `RealStubFlashBackend::prepare` → `NotImplemented`
  (ERR-014); no real write path reachable. *(contract)*

---

## Definition of Done

- [ ] All acceptance tests pass.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it matches IF-011 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-021, REQ-022, REQ-NFR-004 still map to passing
      tests).

---

## Out of Scope for This Task

- `FlashJob::step` (progress / verify-after-write / recovery) — SLICE-4 / TASK-016.
- Troubleshooting flows — SLICE-4 / TASK-017.
- The FlashWorkflow screen — SLICE-4 / TASK-018.
- The BuildBackend port — SLICE-3 / TASK-012.
