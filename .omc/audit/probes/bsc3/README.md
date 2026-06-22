# BSC-3 Probe Evidence — VerificationDriver (trusted runner = the sensor)

Authored by Lane D (slice-4a). The matrix-status doc-truth guard
(`tests/axisb-matrix-status.doc-truth.test.ts`) requires this directory to exist;
it now holds the real red→green negative-control evidence.

## Contents
- [`evidence.md`](./evidence.md) — the **4a negative-control** red→green record: a
  run that *claims* an unobserved seed dimension (`build`) is **RED** (completes)
  when enforcement is flag-OFF (`TH_BSC3_ENFORCE=0`, claim-trusting) and **GREEN**
  (blocked) when flag-ON + the artifact-checking sensor recomputes the ground from
  `verify-report.json`. Asserts **both** flag states (the fail-open guard).
- [`probe.test.ts`](./probe.test.ts) — the self-verifying, reproducible probe spec
  the evidence is captured from (runs against `src/` via vitest; no `dist/` build
  required).

## Independence-control (4b trust logic, shipped in 4a)
The external-signed-vs-forged independence control (an external Ed25519-signed
`DriverDimensionReceipt` ⇒ `valid-grounded`/accepted; the same bytes forged ⇒
`forged`/BLOCK) is proven at the gate in `tests/bsc3-driver-gate.test.ts`. The
out-of-process producer (end-to-end 4b) is Lane C, deferred this run.

Ground rule (pre-mortem #1): every seed dimension binds to a `verify-report.json`
exit artifact — **never** to the `tester-record.json` marker.
