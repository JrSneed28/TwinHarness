# BSC-10 Probe — External-Reference Grounding (Axis-B slice-A / slice-B)

The matrix-status doc-truth guard (`tests/axisb-matrix-status.doc-truth.test.ts`) requires
this directory to exist. It holds the RED→GREEN grounding evidence across both slices.

## Contents

- [`evidence.md`](./evidence.md) — the **RED→GREEN** record: Slice-A (missing required kind
  blocks under enforce); Slice-B (external-signed receipt ⇒ `valid-grounded` ⇒ PASS, plus
  independence control-flip + chain_mismatch + M4 fail-closed + M-1 flag-gated tamper behavior).
- `probe.test.ts` — the self-verifying Slice-A RED→GREEN spec (E1: required kind missing ⇒
  block; E2: honest in-process receipt ⇒ PASS). Force-tracked.
- `independence.test.ts` — the self-attest negative control (E2): an in-process-only
  grounding receipt classifies `ungrounded` (not a silent pass) when the kind is required;
  inert PASS when not required (absence ≠ forgery). Force-tracked.

## The blind spot (BSC-10)

A run can reference external material — a dependency version, an API contract, a visual
design — with no mechanical check that the referenced artifact was actually inspected. The
completion gate clears anyway. The grounding rung closes this by requiring that a computable
evidence record (a digest-manifest, a pinned version, or a perceptual hash) be minted and
externally signed before gate acceptance.

## The ground (consensus spec §R1–§R5)

- **CLAIM** = a work class (`redesign | recreation | integration | migration |
  greenfield+dep | pure-greenfield`) declared or derived from the task context.
- **REFERENT** = a `GroundingReceipt` (discriminated union: `digest-manifest |
  version-pin | visual-hash`) + typed `ConformanceMetric[]` recorded by
  `th grounding record` or the external producer (`scripts/th-receipt-producer.mjs
  --kind grounding` — Slice B).
- The completion gate (`checkProductionReality` → `evaluateGrounding`) resolves
  the required-kind set from the matrix, reads receipts + sibling budget/exception
  stores, recomputes conformance, and blocks when the verdict is not `grounded-within-budget`
  and enforcement applies.

## RED → GREEN — the levers

- **RED (blocks under enforce):** `TH_BSC10_ENFORCE=1` + the required kind is MISSING →
  gate blocks with `grounding_unverified` (reason `missing`).
- **GREEN (passes under enforce):** an honest `GroundingReceipt` within budget → PASS.
- **WARN (non-blocking notice):** `TH_BSC10_ENFORCE` unset/`0` → gate computes and attaches
  a `grounding?` summary but does not block. Tampered chain under WARN is also non-blocking
  (intentional Slice-A design; see `bsc10-integration.test.ts` :518).

## Independence (Slice B, >0)

The external Ed25519 producer (`scripts/th-receipt-producer.mjs --kind grounding`) mints
receipts the gate accepts as `valid-grounded`; the same bytes forged in-process ⇒ `ungrounded`
⇒ BLOCK. Control-flip lives in `tests/bsc10-slice-b.test.ts` (E3 — spawnSync over the real
producer, both arms non-vacuous). Honest scope: signature-provenance only. Budget authority is
3-party: the producer signs the threshold (M4 — unsigned exempts NOTHING).

## Per-kind enforce (Slice B, M2)

Only deterministic kinds (`digest-manifest`, `version-pin`) promote to ENFORCE. `visual-hash`
stays WARN until Slice C. A `visual-hash`-only offender set produces `ok:true + advisory notice`.

## Chain_mismatch (Slice B, I3)

A `manifest_digest` threaded through a BSC-1/3/7 receipt that disagrees with the input-grounding
manifest digest ⇒ `chain_mismatch` reason ⇒ FAIL under enforce. Absent threading ⇒ back-compat
PASS (additive-optional field).

## Tamper-block (M-1, flag-gated)

A tampered in-process grounding chain blocks under `TH_BSC10_ENFORCE=1` with
`grounding_unverified`/`tampered`. Under WARN default (flag unset), tampered chain is
non-blocking — intentional Slice-A design. Both legs live in `tests/bsc10-integration.test.ts`
M-1 describe block (:493 ENFORCE-blocks, :518 WARN-non-blocking).

## Committed suites (keep `npm run verify` honest)

- `tests/bsc10-unit.test.ts` — U1–U9 unit coverage (schema, classifier, chain, flag).
  Slice-B refresh: U9 now asserts bsc2-mirror fail-closed polarity (`yes`/`on`/`banana` → true).
- `tests/bsc10-integration.test.ts` — I1/I1b/I2/I7/M-1/WARN gate wiring + regression.
  Slice-B refresh: L-1 now asserts visual-hash-only offender ⇒ ok:true (per-kind WARN).
- `tests/bsc10-external-grounding.test.ts` — `readGroundingValidated` trust path coverage.
- `tests/bsc10-slice-b.test.ts` — Slice-B acceptance: E3 control-flip, E4 3-party budget,
  M4 unsigned-inert, I3 chain_mismatch, I6 per-kind enforce, I7 driver receipt byte-stability,
  U9 env-leg table (27 tests).
- `.omc/audit/probes/bsc10/probe.test.ts` — E1 red→green under forced enforce.
- `.omc/audit/probes/bsc10/independence.test.ts` — E2 self-attest negative control.
