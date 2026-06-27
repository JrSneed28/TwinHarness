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

## Known limitations (disclosed, not silently ignored — review notes 6–8)
- **Sensor determinism under cap-truncation (note 6):** the sensor inherits
  `anchors.ts:scanDirForReqIds`'s file-count / total-bytes caps. If a `tests/` tree
  exceeds those caps the scan TRUNCATES, and the truncated set is `readdirSync`-order
  dependent — so the ground is NOT fully deterministic in the cap-truncated regime. The
  real TwinHarness `tests/` dir is far below the cap (deterministic in practice); a
  cap-robust order-stable partial scan is future work, documented here rather than
  silently assumed away. (Source-of-truth disclosure: `assertion-presence.ts` header,
  KNOWN LIMITATIONS.)
- **No-arg smoke matchers count as NON-trivial (note 7):** an
  `expect(<non-literal>).toBeDefined()` / `.toBeTruthy()` (a no-argument matcher over a
  non-literal subject) is classified NON-trivial — it is neither literal-vs-literal nor a
  tautology. This is a known FALSE-NEGATIVE class of the offender detector (a smoke
  assertion that can technically fail but asserts little), accepted for a
  PRESENCE-not-efficacy sensor; the genuine efficacy grade is the 2b mutation-kill
  receipt. Tightening it is future work.
- **Enforce-flip no-op safety rests on "0 CHECKED REQs", not "0 offenders" (note 8):**
  `tests/bsc2-enforce-simulation.test.ts` proves the enforce default cannot red this repo
  because TwinHarness has NO `docs/01-requirements.md` ⇒ `computeBreakdown` errors ⇒ the
  CHECKED `tested` set is EMPTY ⇒ the gate short-circuits to PASS (`evaluateAssertionPresence`
  returns `null`). The standing guard ALSO reports the raw sensor's assertion-free set so a
  future req file cannot silently arm a latent offender — but the load-bearing fact is the
  empty CHECKED set, which is strictly narrower than (and the reason for) "0 offenders".

## Efficacy is a DISTINCT axis, never a presence pass-override (review HIGH/MEDIUM)
A signature-verified external `MutationKillReceipt` is MODULE-scoped (it proves the suite
KILLS faults for the single source module it names). It is recorded as a distinct
`GateResult.mutationEfficacy` observability signal for that `scope` ONLY — it does **not**
override the presence rung (presence ≠ efficacy; the plan treats 2a/2b as complementary,
never substitutes) and is **never** propagated onto per-REQ presence trust labels. A
*forged* mutation receipt is a hard `mutation_kill_forged` block; the per-REQ offender
block (`assertion_presence_unverified`) and the no-receipt fail-closed
(`assertion_unobserved`) run regardless of any mutation receipt.
