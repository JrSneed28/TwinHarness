# ADR-004 — Simulated Backend via Trait Ports with No-Op Real Stubs

> **Stage 5 — Architecture Decision Record** (spec §15.5). Streams; only genuinely irreversible
> decisions reach the human (§8). One file per decision; lives in `docs/05-adrs/ADR-NNN-*.md`.
> Each ADR must link to the REQ-IDs and components it serves. Non-technical users receive the
> decision framed as a plain tradeoff.

**Decision summary:** All build/patch image and flash/hardware operations are routed exclusively
through `BuildBackend` and `FlashBackend` Rust trait ports; a deterministic simulator is the only
acting adapter; the real (xeBuild/hardware-write) adapters are explicitly no-op stubs that return
`not-implemented` — chosen as the core safety and determinism model because it is a hard
non-negotiable constraint (no real destructive hardware writes), and because structurally enforcing
it via trait ports rather than runtime guards is the only way to make the guarantee verifiable by
test.

---

## Title / ID

**ADR-004** — Simulated backend via `BuildBackend`/`FlashBackend` trait ports with no-op real
stubs and a deterministic simulator as the sole acting adapter

---

## Status

Accepted

*Date accepted:* 2026-06-10
*Supersedes:* —
*Superseded by:* —

---

## Context

TwinRunner recreates the J-Runner-style Xbox 360 NAND repair workflow. In the real workflow, the
most dangerous operations are:

- **Build/patch:** invoking xeBuild or equivalent to generate a patched NAND image (writes a new
  file; risk: data corruption if the wrong source or wrong build config is used).
- **Flash write:** writing an image to a physical NAND chip via a programmer device (risk:
  bricking the console if the image is wrong, the programmer is mis-configured, or the write is
  interrupted).

As a TwinHarness flagship example, TwinRunner must be **safe to run by anyone without any hardware
or proprietary software**, and must be **deterministic for tests and demos** (REQ-NFR-004,
REQ-NFR-005). This is not a performance preference — it is a hard non-negotiable:

> "No real destructive hardware writes, ever. All flashing/build operations route through the
> backend traits; the real backends are no-op stubs and only the simulator acts."
> — `01-requirements.md`, Non-Negotiables

The architectural question is **how** to enforce this guarantee. Two structural approaches exist:

1. **Trait-port isolation:** define `BuildBackend` and `FlashBackend` as Rust traits; require that
   all build/flash code dispatches through a `&dyn BuildBackend` / `&dyn FlashBackend` reference;
   provide only a deterministic `SimulatorBuildBackend` and `SimulatorFlashBackend` as acting
   adapters; provide `RealStubBuildBackend` / `RealStubFlashBackend` that return
   `Err(NotImplemented)` immediately. The compiler enforces the dispatch path.

2. **Runtime flag / guard:** include real hardware code paths in the binary, gated by a runtime
   flag or environment variable. The "simulator" mode is the default; the "real" mode is
   activated by a flag.

The choice is irreversible because the entire domain (RULE-006, REQ-020, REQ-022, REQ-NFR-004)
is built on the premise that no real hardware path exists and that this is testable by test.
A runtime-guard design would have real implementation code in the binary that could, in principle,
be invoked. Replacing a runtime-guard design with a trait-port design later requires restructuring
every build and flash call site.

Source-dump read-only invariant (RULE-001, REQ-035) is a related structural constraint: the source
path is never opened for writing, and output paths are always distinct user-chosen targets. This is
enforced structurally in `twinrunner-core::nand` and `twinrunner-core::build/flash` rather than
by runtime check.

**Relevant REQ-IDs:** REQ-015, REQ-016, REQ-017, REQ-018, REQ-019, REQ-020, REQ-021, REQ-022,
REQ-023, REQ-024, REQ-035, REQ-NFR-004, REQ-NFR-005, REQ-NFR-006
**Components affected:** `twinrunner-core::build`, `twinrunner-core::flash`, `twinrunner::worker`,
`twinrunner-core::model`

---

## Decision

`twinrunner-core::build` defines the `BuildBackend` trait; `twinrunner-core::flash` defines the
`FlashBackend` trait. Every build and flash operation in the system is dispatched through one of
these traits:

```rust
trait BuildBackend {
    fn run_job(&self, job: BuildJob) -> Result<BuildArtifact, BuildError>;
    // or equivalent stepped/streaming variant
}

trait FlashBackend {
    fn run_operation(&self, op: FlashOperation) -> Result<OperationResult, FlashError>;
}
```

The **only acting adapters** are `SimulatorBuildBackend` and `SimulatorFlashBackend`, which
produce deterministic stepped progress and deterministic output artifacts (checksums, verify
results). The **`RealStubBuildBackend`** and **`RealStubFlashBackend`** return
`Err(BuildError::NotImplemented)` / `Err(FlashError::NotImplemented)` immediately — they contain
no real hardware code.

A dedicated test asserts that the real stub backend never produces a successful result, providing
machine-verifiable evidence of the no-real-write guarantee (RULE-006, REQ-NFR-004).

Source dumps are opened read-only by `twinrunner-core::nand` (RULE-001); all output paths are
distinct from the source path (enforced by a precondition check in `twinrunner-core::model` before
emitting a `Command::RunBuild` or `Command::RunFlash` — RULE-001, REQ-035).

> **Chosen:** `BuildBackend`/`FlashBackend` trait ports with `SimulatorBuildBackend`/
> `SimulatorFlashBackend` as the sole acting adapters and no-op real stubs

*Human gate triggered:* yes — locked by user at project start as a hard constraint; confirmed
accepted 2026-06-10

---

## Consequences

### Positive

- The no-real-hardware-write guarantee is **structurally enforced** rather than runtime-guarded.
  There is no code path that could inadvertently reach real hardware — the real stub returns
  `NotImplemented` immediately, and the simulator does not touch hardware. REQ-NFR-004 is
  verifiable by test: assert the real stub returns `Err(NotImplemented)` for any input.
- The deterministic simulator satisfies REQ-NFR-005 exactly: given the same `BuildJob` or
  `FlashOperation` inputs, the simulator always produces the same stepped progress sequence,
  the same checksum, and the same `OperationResult`. This makes acceptance tests and demos
  reproducible without hardware or network.
- `twinrunner-core::build` and `twinrunner-core::flash` are testable in isolation: a test
  constructs a `SimulatorBuildBackend`, feeds a `BuildJob`, and asserts the output artifact's
  checksum — no thread, no TUI, no hardware (REQ-NFR-006).
- The trait ports establish a clean extension point: a future maintainer can add a real backend
  (if the example is ever extended beyond simulation) by implementing the trait, with zero changes
  to domain logic or the reducer.
- The source-dump read-only invariant (RULE-001, REQ-035) is structurally enforced: `nand` opens
  source paths read-only; `build`/`flash` write only to distinct output paths; the `model` reducer
  enforces output ≠ source before dispatching any Command.

### Negative

- **Not a real workflow.** The simulated build does not produce actual xeBuild-compatible images
  that could be used to flash a real Xbox 360 NAND. The simulated flash does not communicate with
  any programmer hardware. Users who want real NAND manipulation must use J-Runner or equivalent
  — TwinRunner explicitly cannot replace it for real use. This is a fundamental limitation of the
  example, not a bug, but it must be clearly communicated in the TUI to prevent user confusion
  (ARCH-RISK per `04-architecture.md`: "users could assume real-hardware fidelity").
- **Simulator fidelity is permanently bounded.** The deterministic simulator models the workflow
  shape (steps, progress percentages, verify-after-write) but cannot model the timing accuracy,
  partial-write failures, hardware variance, or real error conditions of physical NAND
  programming. Any test passing against the simulator does not prove the workflow would succeed
  on real hardware.
- **The real stub must be maintained.** Every new operation added to the `BuildBackend` or
  `FlashBackend` trait requires a corresponding no-op implementation in the real stub. As the
  trait surface grows, maintaining the stub is an ongoing (if low-cost) obligation.
- **Trait dispatch overhead.** Dynamic dispatch (`&dyn BuildBackend`) adds an indirect function
  call per operation. For a TUI with stepped jobs at most a few hundred steps per session, this
  cost is immeasurable in practice, but it is a structural cost that static dispatch (monomorphic
  generics) would avoid.

### Future obligations

- `docs/06-technical-design.md` must document the `BuildBackend` and `FlashBackend` trait method
  signatures, the stepped/streaming protocol (how the simulator yields intermediate progress), and
  the determinism invariants (which inputs are checksummed, what makes the output deterministic).
- `docs/07-contracts.md` must specify the `BuildBackend` and `FlashBackend` trait interfaces as
  formal contracts, including the error types and the `NotImplemented` stub contract.
- `docs/08-test-strategy.md` must include a dedicated test asserting the real stub never produces
  a successful result (the machine-verifiable REQ-NFR-004 gate).
- If the example is ever extended with a real backend (Future Scope, out of MVP), a new ADR must
  address the safety model change.

---

## Alternatives Considered

### Option A — `BuildBackend`/`FlashBackend` trait ports with no-op real stubs *(chosen)*

Structural enforcement via Rust traits. Chosen — see Decision above.

### Option B — Real xeBuild/hardware integration with a runtime simulation flag

- **What it is:** implement real xeBuild invocation (via subprocess or library call) and real
  NAND programmer communication (USB/serial driver) in the binary, gated by a runtime
  `--simulate` flag. In simulation mode, the flag bypasses the real code path.
- **Why rejected:** this option would require xeBuild (a third-party tool), hardware driver
  dependencies, and potentially proprietary or platform-specific code — directly violating
  "no real artifacts required" (Constraints, `01-requirements.md`). More critically, a runtime
  flag is not structurally enforceable: a developer who accidentally calls the wrong code path
  (or removes the flag check) would have a real destructive write path in the binary. The
  non-negotiable requires structural enforcement, not runtime gating. Additionally, real xeBuild
  integration would require proprietary binaries, breaking the "runs with no real hardware, no
  real xeBuild" constraint.
- **Would be right if:** TwinRunner were intended to be a real production tool (not an example),
  the no-destructive-write guarantee were a runtime policy rather than a structural invariant,
  and all licensing constraints permitted bundling real tools. None of these conditions apply.

### Option C — Direct file writes in build/flash code with no abstraction layer

- **What it is:** build and flash code directly writes output files and (notionally) calls
  hardware APIs without any trait indirection. Simulation is achieved by conditionally writing
  placeholder content.
- **Why rejected:** without a trait abstraction, there is no clean boundary between the simulator
  and a future real implementation, no testable seam for unit-testing the build/flash logic in
  isolation, and no mechanism for the model reducer to dispatch to different adapters. This is a
  degenerate form that violates RULE-006 ("all build/flash ops go through the port") and
  REQ-NFR-006 (testability). The trait port exists specifically to create this testable seam.
- **Would be right if:** TwinRunner had exactly one backend that would never change, no testability
  requirement, and no extension use case. None of these conditions apply.

### Option D — Mock/stub via a testing-only flag (cfg(test))

- **What it is:** production code calls the real backend; `#[cfg(test)]` replaces the backend
  with a mock. The "simulated" mode that users see is a special build configuration.
- **Why rejected:** this inverts the design. The simulator is the **primary user-facing mode**,
  not a test-only substitute. Users interacting with the TUI are always running the simulator;
  the "real" backend is what would be optional (and is, as a no-op stub). Hiding the simulator
  behind `cfg(test)` would mean users cannot run the simulator in a standard binary. Furthermore,
  `cfg(test)` mocks cannot be independently unit-tested — they only exist in test contexts.
- **Would be right if:** the simulator were purely a test-time concern and real hardware
  integration were the only user-facing mode. The inverse is true here.

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-015 | Drives: build/patch workflow routes through BuildBackend trait |
| Requirement | REQ-016 | Drives: timing file selection is an input to the BuildJob dispatched through the port |
| Requirement | REQ-017 | Drives: ECC file generation is a SimulatorBuildBackend output, not a real xeBuild call |
| Requirement | REQ-018 | Drives: XeLL/recovery file generation is a SimulatorBuildBackend output |
| Requirement | REQ-019 | Drives: deterministic build progress comes from the stepped simulator |
| Requirement | REQ-020 | Drives: BuildBackend trait port is the named abstraction; real backend = no-op stub |
| Requirement | REQ-021 | Drives: flash workflow routes through FlashBackend trait |
| Requirement | REQ-022 | Drives: FlashBackend real stub = no-op; simulator is default; no real hardware write |
| Requirement | REQ-023 | Drives: deterministic flash progress + verify-after-write from simulator |
| Requirement | REQ-024 | Constrained by: fixture-backed recovery steps are part of the simulator's FlashFailed response |
| Requirement | REQ-035 | Constrained by: output ≠ source enforced before dispatching any Command through the ports |
| Requirement | REQ-NFR-004 | Drives: no-real-hardware-write guarantee — the structural core of this ADR |
| Requirement | REQ-NFR-005 | Drives: deterministic simulator guarantees identical inputs → identical outputs |
| Requirement | REQ-NFR-006 | Constrained by: trait ports provide the testable seam for simulator-based unit tests |
| Component | `twinrunner-core::build` | Owns BuildBackend trait, SimulatorBuildBackend, RealStubBuildBackend |
| Component | `twinrunner-core::flash` | Owns FlashBackend trait, SimulatorFlashBackend, RealStubFlashBackend |
| Component | `twinrunner::worker` | Affected — dispatches jobs through the trait ports; never calls real backends directly |
| Component | `twinrunner-core::model` | Affected — enforces output ≠ source precondition before emitting build/flash Commands |
| Downstream artifact | `06-technical-design.md` | Must document BuildBackend/FlashBackend trait method signatures and stepping protocol |
| Downstream artifact | `07-contracts.md` | Trait interfaces are formal contracts; error types and NotImplemented stub contract must be specified |
| Downstream artifact | `08-test-strategy.md` | Must include test asserting real stub never produces a successful result (REQ-NFR-004 gate) |
