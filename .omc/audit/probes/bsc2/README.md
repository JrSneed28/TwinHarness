# BSC-2 Probe Evidence — Assertion-Presence (trusted recompute = the sensor)

Authored by Lane D (slice-6). The matrix-status doc-truth guard
(`tests/axisb-matrix-status.doc-truth.test.ts`) requires this directory to exist; it
now holds the real RED→GREEN negative-control evidence.

## Contents
- [`evidence.md`](./evidence.md) — the **slice-6 negative-control** RED→GREEN record:
  a run whose `tested` REQ-001 carries ONLY a trivial assertion
  (`expect(true).toBe(true)`) is **RED** (completes) when enforcement is flag-OFF
  (`TH_BSC2_ENFORCE=0`, presence-trusting) and **GREEN** (blocked,
  `assertion_presence_unverified` naming REQ-001) when flag-ON + the sensor recomputes
  the per-REQ assertion ground from the test bodies. Asserts **both** flag states (the
  fail-open guard).
- [`probe.test.ts`](./probe.test.ts) — the self-verifying, reproducible probe spec the
  evidence is captured from (runs against `src/` via vitest; no `dist/` build required).

## What the rung adds over coverage
`th coverage check` marks a REQ "tested" on anchor presence alone — a REQ-ID token in a
recognized test file. It never inspects the body, so a tautology clears the bar
identically to a real check. The BSC-2 sensor (`src/core/assertion-presence.ts`) is the
missing observer: per REQ-ID it derives, regex/lexer-grade (no AST library — the
`expect(...)` count is a hand-rolled balanced-paren scan; the pinned trivial definition
is hashed INTO the ground), whether the recognized test files carry a NON-TRIVIAL
assertion. The gate (`checkProductionReality` rung 8) enforces on the FRESH recompute,
subtracting only validly-signed, digest-scoped waivers.

## Committed suite (the non-probe proof)
The same controls ship in the committed test suite (which CI runs):
- `tests/bsc2-negative-controls.test.ts` — the FOUR enumerated negative-controls:
  (a) snapshot-stale receipt ⇒ `stale` BLOCK, (b) tested-REQ-with-no-receipt ⇒
  `assertion_unobserved` BLOCK, (c) edit-after-mint ⇒ `target_mismatch` BLOCK, (d) the
  waiver matrix (unsigned / wrong-key / over-broad / digest-mismatched exempt NOTHING;
  a correctly-signed digest-matching waiver DOES exempt → gate PASSes).
- `tests/bsc2-determinism.test.ts` — the P6 binding contract: the ground digest is
  byte-identical under a SHUFFLED `readdirSync` (reversed + rotated injection).
- `tests/assertion-presence-sensor.test.ts` — the sensor unit fixtures (trivial /
  healthy / mixed / unparsed-fail-closed).
- `tests/assertion-presence-concurrency.test.ts` — the hash-chained store under
  concurrent `withStateLock` appends.
- `tests/bsc2-enforce-simulation.test.ts` — the standing enforce-flip precondition (the
  repo's own gate offender set is EMPTY; blast-radius bound documented).

## Independence (slice-2b — deferred to the 2b PR)
The 2a in-process `AssertionPresenceReceipt` is ATTRIBUTION-ONLY (`independence: 0`).
The independently-grounded property is the EXTERNAL Ed25519-signed
`MutationKillReceipt` (a controlled runner proves the suite KILLS injected faults). The
2b control-flip (real producer-signed receipt ACCEPTED ⇒ `valid-grounded`; the same
bytes forged in-process REJECTED ⇒ `forged`/BLOCK) flips the ledger `independence` from
`0` to `>0` — landed in the 2b PR stacked on this one.

Ground rule (Principle 6): the offender verdict is the FRESH recompute of the test
bodies — **never** the receipt's stored ground; the receipt is only the F8
correspondence artifact.
