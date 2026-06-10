# ADR-002 — Concurrency Backbone: Dedicated Worker Thread + std::sync::mpsc Channels

> **Stage 5 — Architecture Decision Record** (spec §15.5). Streams; only genuinely irreversible
> decisions reach the human (§8). One file per decision; lives in `docs/05-adrs/ADR-NNN-*.md`.
> Each ADR must link to the REQ-IDs and components it serves. Non-technical users receive the
> decision framed as a plain tradeoff.

**Decision summary:** Long-running simulated build/flash jobs run on a dedicated OS background
thread; the crossterm event loop communicates with it via `std::sync::mpsc` channels — chosen over
an async/tokio runtime because the workload is one-job-at-a-time, the crossterm event loop is
synchronous, and threading avoids coloring every function signature with `async`/`await`, which
would be extremely costly to remove once established across the codebase.

---

## Title / ID

**ADR-002** — Concurrency Backbone: dedicated background worker thread + `std::sync::mpsc` channels
(no async runtime)

---

## Status

Accepted

*Date accepted:* 2026-06-10
*Supersedes:* —
*Superseded by:* —

---

## Context

TwinRunner's simulated build and flash jobs are CPU-stepped, deterministic, potentially long-running
operations (REQ-019, REQ-023, REQ-NFR-005). They must not block input handling — if a job runs on
the render thread, the TUI freezes and stops responding to keyboard events (violating REQ-NFR-001).
A concurrency mechanism is required to move job execution off the event-loop thread.

The choice of concurrency backbone is **irreversible at the architecture level**: if every job
signature is written as `async fn` against a tokio runtime, removing that runtime later means
rewriting every executor, every channel boundary, every join handle — across both the core library
and the binary shell. Similarly, if the architecture commits to synchronous channels and OS
threads, adding an async runtime later requires the same wholesale rewrite. The choice shapes:

- The type of every inter-component communication channel (`std::sync::mpsc` vs. tokio channels).
- Whether the event loop is `loop { ... poll ... }` (synchronous) or `tokio::select!` (async).
- Whether core library simulators are synchronous stepped functions or `async` streams.
- The complexity surface exposed to anyone reading or extending the code.

The additional constraint: crossterm's event polling API (`poll`/`read`) is **synchronous**. An
async event loop wrapping crossterm requires bridging a synchronous I/O source into an async
runtime via `spawn_blocking` or equivalent, adding an extra layer of indirection with no benefit
here — the crossterm source is already the bottleneck.

**Relevant REQ-IDs:** REQ-019, REQ-023, REQ-NFR-001, REQ-NFR-005, REQ-NFR-006, REQ-NFR-011
**Components affected:** `twinrunner::worker`, `twinrunner-core::worker_api`, `twinrunner::tui`,
`twinrunner-core::build`, `twinrunner-core::flash`

---

## Decision

Simulated build/flash job execution runs on a **dedicated background OS thread** (`std::thread::spawn`).
Two `std::sync::mpsc` channels bridge the event loop and the worker:

- **UI → Worker:** `Sender<WorkerCommand>` (carries `RunBuild(job)`, `RunFlash(op)`, `Stop`).
- **Worker → UI:** `Sender<WorkerEvent>` (carries `BuildProgressed`, `FlashProgressed`,
  `LogEntryWritten`, `BuildCompleted`, `BuildFailed`, `FlashCompleted`, `FlashFailed`).

The event loop polls the worker-to-UI channel non-blocking each tick (using `try_recv`), converts
received events into `Message`s, feeds them through `model.update`, and re-renders. No async
runtime is introduced; no function in `twinrunner-core` is marked `async`.

> **Chosen:** dedicated background worker thread + `std::sync::mpsc` channels (synchronous,
> no async runtime / tokio)

The reasoning: the workload is one-job-at-a-time in MVP (a second job cannot start while one is
running), the simulator steps are CPU-bound deterministic computations (not I/O-bound), the
crossterm event source is synchronous, and the per-tick non-blocking channel drain is sufficient to
stream progress at any rate the simulator produces. The concurrency problem here is a producer
(worker) and a consumer (event loop) exchanging typed messages — mpsc is the exact tool for that.
An async runtime would add significant complexity (coloring all signatures, runtime configuration,
async-aware channel types) while solving the same problem no better.

*Human gate triggered:* yes — surfaced to user via AskUserQuestion; approved 2026-06-10 (recommended
default: threads + channels over async/tokio)

---

## Consequences

### Positive

- `twinrunner-core` functions (simulators, reducer, parsers) are synchronous — no `async fn`,
  no `.await`, no `Future` bounds. This keeps the core library readable, universally callable from
  test harnesses without a runtime, and free of executor-specific behavior (REQ-NFR-006).
- The synchronous event loop (`loop { poll_crossterm; drain_channel; update; render }`) is
  straightforward to reason about and audit. Every tick is a linear sequence of deterministic
  steps, supporting REQ-NFR-005.
- A panicking or erroring worker thread is caught at the channel boundary: `recv` or `try_recv`
  returns `Err` when the sender is dropped, and the event loop handles this as a `JobFailed` event
  without crashing the UI (REQ-NFR-011).
- One-job-at-a-time in MVP is naturally enforced: the UI sends a new job command only after the
  current job's terminal event arrives, which is a simple state check in `twinrunner-core::model`.
- Thread + channel overhead is negligible for a one-job-at-a-time workload that executes at most
  a few hundred stepped iterations per session.

### Negative

- **Manual thread and channel lifecycle management.** The binary crate must spawn the thread at
  startup, own the channel endpoints, join the thread on quit, and handle the edge cases of the
  worker completing, panicking, or receiving a `Stop` command while a job is mid-execution. There
  is no runtime-managed executor pool to handle this automatically.
- **One-job-at-a-time is structurally baked in.** If a future version requires concurrent jobs
  (e.g., simultaneous build + flash, or a job queue), the threading model must be redesigned
  (additional worker threads, a channel-per-job protocol, or a thread pool). Migrating to a
  thread-pool or async model at that point would be a significant refactor.
- **`std::sync::mpsc` is not `Select`-capable across multiple channels natively.** If a future
  version needs to multiplex over more than two channels (e.g., a secondary progress source) in a
  single `recv`/`try_recv` call, additional synchronization primitives (crossbeam channels, or a
  wrapper enum) would be needed.
- **No backpressure on the worker→UI channel.** If the simulator emits events faster than the UI
  drains them (unlikely in practice given the tick rate), the channel buffer grows unbounded. A
  bounded channel (crossbeam, or `sync_channel`) would require an explicit buffer-size decision.

### Future obligations

- `docs/06-technical-design.md` must define the worker thread's startup sequence, the
  `WorkerCommand`/`WorkerEvent` message type schemas, the `Stop` handshake protocol, and the
  panic/error recovery path at the channel boundary.
- `docs/07-contracts.md` must specify the `WorkerCommand` and `WorkerEvent` typed interfaces as
  internal module contracts between `twinrunner::worker` and `twinrunner::tui`.
- If V1 introduces concurrent jobs (Future Scope), this ADR must be superseded by a new ADR
  covering the updated concurrency model.

---

## Alternatives Considered

### Option A — Dedicated worker thread + `std::sync::mpsc` *(chosen)*

Synchronous, OS-thread-based. Chosen — see Decision above.

### Option B — async/tokio runtime

- **What it is:** tokio is Rust's dominant async runtime. Under this option, the event loop and
  the simulator would be structured as async tasks; channels would be tokio's `mpsc` (async-aware,
  backpressure-capable); the simulator steps would be `async fn`s that `tokio::time::sleep` or
  yield between steps.
- **Why rejected:** tokio colors every function it touches with `async`/`await` — every simulator
  function in `twinrunner-core::build` and `twinrunner-core::flash`, every channel receive in
  the event loop, and every call site that awaits a job result would become async. Removing a
  tokio runtime from a codebase that has been built on it is one of the most expensive
  refactors in Rust, comparable in scope to changing ownership models. Additionally, crossterm's
  `poll` and `read` are synchronous; bridging them into a tokio task requires `spawn_blocking`,
  adding indirection with no benefit. The workload (one stepped job at a time, synchronous
  crossterm source) does not need the concurrency primitives tokio provides — tokio would solve a
  different problem at a steep ongoing complexity cost.
- **Would be right if:** TwinRunner needed to manage many concurrent I/O-bound tasks (network
  requests, database queries, multiple simultaneous hardware connections), or if crossterm offered
  a native async event stream. For a local, offline, one-job-at-a-time tool, this overhead is
  not justified.

### Option C — Run job steps on the render thread (blocking)

- **What it is:** instead of a worker thread, the simulator runs synchronously on the event-loop
  thread, blocking input handling for the duration of each step.
- **Why rejected:** this directly violates REQ-NFR-001 (UI responsiveness while operations run).
  Even if each step is "fast," a 100-step simulated flash job would freeze the UI for the
  aggregate duration and prevent the user from cancelling, resizing, or reading the live log during
  execution. This option is not a genuine design choice — it is a degenerate form that fails
  a hard requirement.
- **Would be right if:** jobs were guaranteed to complete in a single frame's budget (a few
  milliseconds), which is not the case for a stepped deterministic simulator intended to model
  multi-second flash operations with visible progress.

### Option D — async-std runtime

- **What it is:** async-std is an alternative to tokio that mirrors the standard library's API
  surface with async equivalents.
- **Why rejected:** async-std carries the same `async fn`-coloring cost as tokio and has a
  significantly smaller ecosystem and slower development pace. It would introduce all of tokio's
  costs without tokio's breadth of maintained drivers and utilities. There is no advantage over
  tokio in this context, and both are rejected for the same underlying reasons.
- **Would be right if:** tokio existed but was unavailable under the project's license constraints
  (it is MIT, so this scenario is hypothetical). In any realistic scenario, if an async runtime
  were chosen, tokio would be the correct choice over async-std.

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-019 | Drives: build progress streaming requires off-thread job execution |
| Requirement | REQ-023 | Drives: flash progress + verify-after-write streaming requires off-thread job execution |
| Requirement | REQ-NFR-001 | Drives: UI responsiveness while operations run — the non-negotiable that makes a worker thread mandatory |
| Requirement | REQ-NFR-005 | Constrained by: deterministic stepped progress is implemented as synchronous steps on the worker thread |
| Requirement | REQ-NFR-006 | Constrained by: synchronous core functions are universally testable without a runtime |
| Requirement | REQ-NFR-011 | Constrained by: worker panic/error is isolated to the channel boundary; UI never crashes |
| Component | `twinrunner::worker` | Owns this decision — thread spawn, channel wiring, job dispatch, event streaming |
| Component | `twinrunner-core::worker_api` | Owns the `WorkerCommand`/`WorkerEvent` message types that define the channel contract |
| Component | `twinrunner::tui` | Affected — event loop's tick structure (poll + channel drain + update + render) follows from this decision |
| Component | `twinrunner-core::build` | Affected — `SimulatorBuildBackend` is synchronous; no async fn |
| Component | `twinrunner-core::flash` | Affected — `SimulatorFlashBackend` is synchronous; no async fn |
| Downstream artifact | `06-technical-design.md` | Must specify WorkerCommand/WorkerEvent types, thread lifecycle, panic/Stop handshake |
| Downstream artifact | `07-contracts.md` | Internal worker↔tui channel interface is a module contract |
