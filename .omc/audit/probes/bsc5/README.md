# BSC-5 Probe — Dimension-Set-Coverage Rung (Axis-B slice-7, the declared-coverage row)

Closes Axis-B correspondence class **BSC-5** to **Done-phase**: completion asserts that every
dimension in the COMMITTED declared set was OBSERVED by a trusted runner, where *declared* is a
committed source artifact the gate READS (Interp A) and *observed* is re-derived from
`verify-report.json` at gate time.

## The ground (consensus §5)

`declared ⊆ observed`, recomputed PURELY from live inputs at gate time:

- **declared** = `DECLARED_DIMENSION_SET` (`src/core/declared-dimensions.ts`) — a committed `core/`
  constant. Narrowing it is a reviewable `src/` + `dist/` diff under CI's committed-`dist/`
  invariant, never a runtime self-attest. The gate imports it directly; there is no on-disk
  declared-set file an agent could rewrite between mint and gate.
- **observed** = `observedDimensionsFromReport(readVerifyReport(paths))` — the SAME shared
  derivation the BSC-3 sensor uses (a dimension is observed iff a matching command exists AND
  `ok === true`).

The `DimensionSetCoverageReceipt` (`src/core/receipts.ts`) records the declared-set digest +
observed set + verdict as an append-only, SHA-256 hash-chained audit breadcrumb under the state
lock — but the gate NEVER trusts its stored verdict; it recomputes.

## Contents

- [`evidence.md`](./evidence.md) — the **RED → GREEN** record driven through the REAL gate + the
  REAL committed declared set + observed re-derivation, with the verbatim captured `detail`.
- `probe.test.ts` — the self-verifying RED→GREEN spec (runs against `src/` via vitest; no `dist/`
  build of the spec required). Run with an ephemeral config since the repo `vitest.config.ts`
  scopes `include` to `tests/**`:
  `npx vitest run --config <ephemeral>` with `include: [".omc/audit/probes/bsc5/probe.test.ts"]`.

## Delta over BSC-3 (why this is not a re-skin)

BSC-3 records WHICH dimensions a runner observed (the sensor). BSC-5 asserts the DECLARED required
SET is fully covered (the completeness gate over that sensor). BSC-5 consumes the BSC-3
`DriverDimensionReceipt`/observed derivation but adds the missing completeness check, keyed to a
COMMITTED declared set rather than a static matrix.

## Enforcement flag

Gated by `TH_BSC5_ENFORCE` (defaults ON; ship-dark when `=0`/`false`). OFF ⇒ the would-be block is
a non-blocking notice + coverage summary; ON ⇒ it BLOCKS with `dimension_set_uncovered`.

## Independence — Done-phase only

`producer_identity` is a zero-trust audit breadcrumb; the verdict's integrity is the gate's live
recompute over a COMMITTED artifact. Independent out-of-process grounding is the deferred P4–5
extraction. This row is **Done-phase**, NOT Done-final.

## Committed suite (keeps `npm run verify` honest)

- `tests/bsc5-coverage-gate.test.ts` — the gate end-to-end + the four enumerated negative-controls.
- `tests/bsc5-declared-set.guard.test.ts` — the committed declared-set artifact is the gate's source.
- `tests/bsc5-coverage-concurrency.test.ts` — N concurrent `withStateLock` coverage appends, intact chain.
