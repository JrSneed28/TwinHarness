# BSC-10 Probe — External-Reference Grounding (Axis-B slice-A)

Authored by Lane 3 (worker-tests, slice-A). The matrix-status doc-truth guard
(`tests/axisb-matrix-status.doc-truth.test.ts`) requires this directory to exist;
it holds the real RED→GREEN grounding evidence.

## Contents
- [`evidence.md`](./evidence.md) — the **RED→GREEN** record: a run whose required
  ground kind (`digest-manifest`) is MISSING blocks with `grounding_unverified` under
  forced `TH_BSC10_ENFORCE=1`; providing a grounded receipt satisfying the budget
  allows the gate to PASS.
- `probe.test.ts` — the self-verifying RED→GREEN spec (runs against `src/` via
  vitest; no `dist/` build of the spec required). Force-tracked.
- `independence.test.ts` — the SELF-ATTEST negative-control: an in-process-only
  grounding receipt classifies `ungrounded` (not a silent pass) when the kind is
  required; inert PASS when not required (absence ≠ forgery). Force-tracked.

## The blind spot (BSC-10)

A run can reference external material — a dependency version, an API contract, a
visual design — with no mechanical check that the referenced artifact was actually
inspected. The completion gate clears anyway. The grounding rung closes this by
requiring that a computable evidence record (a digest-manifest, a pinned version, or a
perceptual hash) be minted and externally signed before gate acceptance.

## The ground (consensus spec §R1–§R5)

- **CLAIM** = a work class (`redesign | recreation | integration | migration |
  greenfield+dep | pure-greenfield`) declared or derived from the task context.
- **REFERENT** = a `GroundingReceipt` (discriminated union: `digest-manifest |
  version-pin | visual-hash`) + typed `ConformanceMetric[]` recorded by
  `th grounding record` or the external producer (`scripts/th-receipt-producer.mjs
  --kind grounding` — Slice B).
- The completion gate (`checkProductionReality` → `evaluateGrounding`) resolves
  the required-kind set from the matrix, reads receipts + sibling budget/exception
  stores, recomputes conformance, and blocks when `bsc10EnforcementEnabled()` and
  the verdict is not `grounded-within-budget`.

## RED → GREEN — the lever is the enforcement flag + receipt presence

- **RED (blocks under enforce):** `TH_BSC10_ENFORCE=1` + the required kind (`digest-manifest`)
  is MISSING from `grounding-receipts.jsonl` → gate blocks with `grounding_unverified`
  (reason `missing`).
- **GREEN (passes under enforce):** an honest `GroundingReceipt` with `groundKind:"digest-manifest"`
  + conformance within budget is present → gate PASSES.
- **WARN (non-blocking notice):** `TH_BSC10_ENFORCE` unset/`0` → the gate computes and
  attaches a `grounding?` summary but does not block.

## Independence (Slice B)

The external Ed25519 producer (`scripts/th-receipt-producer.mjs --kind grounding`)
mints receipts the gate accepts as `valid-grounded`; the same bytes forged in-process
⇒ `ungrounded` ⇒ BLOCK. This flips BSC-10 independence `0 → >0`, scoped honestly as
signature-provenance only. The in-process producer produces attribution-only receipts
(`valid`, never `valid-grounded`). Control-flip lives in Slice B.

## Committed suite (keeps `npm run verify` honest)
- `tests/bsc10-unit.test.ts` — U1–U9 unit coverage (schema, classifier, chain, flag).
- `tests/bsc10-integration.test.ts` — I1/I1b/I2/I7 gate-wiring + regression.
- `.omc/audit/probes/bsc10/probe.test.ts` — E1 red→green under forced enforce.
- `.omc/audit/probes/bsc10/independence.test.ts` — E2 self-attest negative control.
