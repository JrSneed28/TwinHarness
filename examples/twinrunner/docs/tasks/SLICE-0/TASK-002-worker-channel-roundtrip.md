# SLICE-0 / TASK-002 — Worker thread + mpsc channel protocol round-trip

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-NFR-001, REQ-NFR-011
**Slice:** SLICE-0 — Walking Skeleton
**Depends on:** SLICE-0 / TASK-001 complete

---

## Goal

Implement `twinrunner::worker::spawn` — a single background thread bridged to the UI by two
`std::sync::mpsc` channels — and prove a trivial command round-trips: the worker accepts a
`WorkerCommand::Shutdown` and the thread joins without panic. This is the only cross-thread
boundary in the system; this task wires it (no job execution yet).

---

## REQ-IDs

- **REQ-NFR-001** — Fast launch / responsiveness: the UI remains responsive while simulated
  operations run (long work runs off the render thread). *(This task establishes the off-thread
  worker the responsiveness budget relies on.)*
- **REQ-NFR-011** — Robust error handling: a failing operation never crashes the TUI; it returns
  the user to a safe state (a panicking worker job is caught and converted to a typed event; a
  second shutdown is a no-op).

---

## Relevant Contracts / Interfaces

**IF-013 — `worker::spawn` + `WorkerCommand` channel (UI → worker):**

```rust
fn spawn(
    rx: Receiver<WorkerCommand>,
    tx: Sender<WorkerEvent>,
    clock: Box<dyn Clock + Send>,
) -> JoinHandle<()>

enum WorkerCommand {
    StartBuild(BuildJob),   // payload type stubbed in SLICE-0; real use in SLICE-3
    StartFlash(FlashJob),   // payload type stubbed in SLICE-0; real use in SLICE-4
    Cancel,                 // idempotent: ignored if no job is active
    Shutdown,               // terminates the loop; idempotent — second Shutdown is a no-op
}
```

**IF-014 — `WorkerEvent` channel (worker → UI):** drained per-tick with `try_recv`.

```rust
enum WorkerEvent {
    Started   { job_id: String },
    Progress  { job_id: String, pct: u8 },
    Log       { job_id: String, entry: LogEntry },
    Completed { job_id: String, result: OperationResult },
    Failed    { job_id: String, error: ValidationIssue, recovery_steps: Vec<RecoveryStep> },
}
```

Delivery semantics: exactly-once, ordered, in-process FIFO mpsc. UI uses non-blocking `send`;
consumer drains with `try_recv` in a loop each tick (non-blocking — REQ-NFR-001).

---

## Relevant Design Notes

- **One worker thread, one job at a time** (INV-007). The worker holds a single active-job slot as
  defense-in-depth; `Cancel`/`Shutdown` are idempotent. In SLICE-0 the loop need only handle the
  `Shutdown`/`Cancel` no-op arms and the channel plumbing; `StartBuild`/`StartFlash` arms become
  real in SLICE-3/D.
- **Panic containment (REQ-NFR-011):** wrap job execution in `catch_unwind` so a panicking job
  becomes `WorkerEvent::Failed` rather than killing the thread. The full panic→Failed conversion is
  exercised in SLICE-4/TASK-016; here, ensure the loop structure supports it and that
  `Shutdown`-after-exit is a clean no-op.
- **Clock is injected** (`Box<dyn Clock + Send>`) so determinism tests can pass a `FixedClock`.

---

## Acceptance Test(s)

- `test_slice0_worker_spawns_and_shuts_down_cleanly` — spawn the worker, send
  `WorkerCommand::Shutdown`, assert the thread `join()`s without panic. Proves IF-013/IF-014 are
  wired. *(integration)*
- `test_REQ_NFR011_double_shutdown_is_noop` — send `WorkerCommand::Shutdown` twice; the second is a
  no-op; the worker loop exits cleanly once. *(unit)*

---

## Definition of Done

- [ ] Both acceptance tests pass; the worker spawns, round-trips a command, and joins cleanly.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here (`WorkerCommand`/`WorkerEvent` enums), it matches IF-013/IF-014
      in `07-contracts.md` (no drift).
- [ ] `th coverage check` does not regress.

---

## Out of Scope for This Task

- Actual `BuildJob`/`FlashJob` stepping on the worker — SLICE-3 / TASK-013, SLICE-4 / TASK-016.
- Folding `WorkerEvent`s into `Message`s in the reducer beyond the shutdown path — SLICE-3/D.
- The crossterm event loop that owns the channels at runtime — SLICE-0 / TASK-003.
- Worker-panic→Failed and channel-disconnect behavioral assertions — SLICE-4 / TASK-016, SLICE-5.
