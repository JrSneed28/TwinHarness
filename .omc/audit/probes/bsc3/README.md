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

## Independence-control (slice-4b — REAL producer shipped)
The external-signed-vs-forged independence control (an external Ed25519-signed
`DriverDimensionReceipt` ⇒ `valid-grounded`/accepted; the same bytes forged ⇒
`forged`/BLOCK) is proven at the gate in `tests/bsc3-driver-gate.test.ts`. Slice-4b
adds the REAL out-of-process producer (`scripts/th-receipt-producer.mjs --kind driver`)
that mints those receipts, flipping the ledger `independence` from `0` to `>0`:
- [`independence.test.ts`](./independence.test.ts) — the self-verifying ACCEPT↔REJECT
  probe driving the REAL producer (`spawnSync`) + REAL gate; its captured evidence is
  the **Independence control (slice-4b)** section of [`evidence.md`](./evidence.md).

The committed suite carries the same control
(`tests/bsc3-independence-control-flip.test.ts`) plus the producer's byte-for-byte
signature/hash binding (`tests/driver-producer.test.ts`).

Ground rule (pre-mortem #1): every seed dimension binds to a `verify-report.json`
exit artifact — **never** to the `tester-record.json` marker.
