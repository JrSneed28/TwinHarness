# BSC-10 Probe Evidence — External-Reference Grounding (Slice B)

Axis-B slice-B INDEPENDENCE CONTROL-FLIP: an external Ed25519-signed grounding receipt
produced by `scripts/th-receipt-producer.mjs --kind grounding` classifies `valid-grounded`
and the gate PASSES; the same bytes forged in-process (wrong key / unsigned) classify
`forged`/`ungrounded` and the gate BLOCKS. This flips BSC-10 independence `0 → >0`.

## Scenarios

### E3 — control-flip independence

A fully-green project whose BSC-10 grounding rung is the only lever.

**ARM A (real, accepted):** An in-test ephemeral Ed25519 keypair is written to a temp
keyfile. The real external producer (`scripts/th-receipt-producer.mjs --kind grounding`)
is invoked via `spawnSync` with `TH_RECEIPT_PRIVATE_KEYFILE` pointing at it. The producer
mints an external-signed grounding receipt into `external-grounding-receipts.jsonl`.
`readGroundingValidated` classifies the receipt `trustLabel:"valid-grounded"`. The gate
passes with `ok:true`.

**ARM B (forged, rejected):** The same receipt but signed with a wrong key (K2 while the
verifier holds K1) — `readGroundingValidated` ignores the unverifiable line ⇒ the kind
is absent ⇒ gate blocks with `grounding_unverified` / reason `missing` (version-pin is a
deterministic kind, blocked by `bsc10KindEnforced`).

### E4 — 3-party budget authority + canonical match

A producer-signed budget entry is written to `grounding-budgets.jsonl`. The gate's
`validGroundingBudgets` must verify the signature using `groundingBudgetCanonicalText`.
**Integration check:** the producer uses `JSON.stringify` over a fixed-insertion-order
object; the gate uses `siblingCanonicalText` with `GROUNDING_BUDGET_CANONICAL_FIELD_ORDER`.
Both produce the same bytes (insertion order matches the field order constant, and
`snapshot_coord` is built `{gitHead, treeDigest}` which already matches `SNAPSHOT_FIELD_ORDER`).
Result: **PASS — canonicals match**.

An unsigned budget (signature absent) ⇒ `validGroundingBudgets` returns empty ⇒ exempts
NOTHING (M4 fail-closed).

### I3 — chain_mismatch

A BSC-3 driver receipt carrying a `manifest_digest` that DISAGREES with the input-grounding
manifest digest ⇒ `evaluateGrounding` detects `chain_mismatch` ⇒ gate blocks under enforce.
Absent threading (pre-BSC-10 receipt, no `manifest_digest` field) ⇒ back-compat PASS.

### M-1 — tamper-block flag-gated behavior

A tampered in-process grounding chain blocks under `TH_BSC10_ENFORCE=1` (ENFORCE mode)
with `grounding_unverified`/`tampered`. Under WARN default (flag unset), a tampered chain
is non-blocking (`ok:true`) — intentional Slice-A design. These two cases live in
`tests/bsc10-integration.test.ts` M-1 describe block (:493 ENFORCE-blocks, :518 WARN-non-blocking)
and are not covered in `bsc10-slice-b.test.ts`. An empty store stays inert (absence ≠ forgery).

## Before (RED — missing required kind under enforce)

```
[RED  missing] ok:false  error:"grounding_unverified"  reason:"missing"  kind:"version-pin"
```

Gate result: `ok: false`, `error: "grounding_unverified"`, `detail.reason: "missing"`.
The run would be certified incomplete — the gate correctly blocks on the ungrounded reference.

## After (GREEN — external-signed receipt within budget)

```
[GREEN grounded] ok:true  trustLabel:"valid-grounded"  conformance:"within-budget"
```

Gate result: `ok: true`. The external-signed grounding receipt (producer-signed, not
in-process-minted) satisfies the required kind — the independence property is now >0.

## Independence (Slice B)

The external Ed25519 producer (`scripts/th-receipt-producer.mjs --kind grounding`) is
the ONLY surface that can produce `valid-grounded` receipts. The in-process surface holds
no private key (`receipt-signing.ts` is verify-only). A wrong-key or unsigned receipt
classifies `ungrounded` and the gate blocks. Honest scope: signature-provenance only —
the producer proves the receipt was not forged in-process, not that the referent content
is independently audited.

Budget authority is 3-party: the producer signs the threshold; the agent cannot alter it
without the private key. An unsigned budget exempts NOTHING (M4).

## Per-kind enforce (Slice B, M2)

Only deterministic kinds (`digest-manifest`, `version-pin`) are in `ENFORCED_GROUND_KINDS`.
`visual-hash` stays WARN until Slice C lands pinned-renderer measurement. A visual-hash-only
offender set produces `ok:true + advisory notice`, not a block.

## Negative controls

- `independence.test.ts` (existing): in-process-only receipt ⇒ `ungrounded` when required.
- `bsc10-slice-b.test.ts` E3 ARM B: wrong-key/no-key ⇒ ungrounded ⇒ gate blocks.
- `bsc10-slice-b.test.ts` M4: unsigned budget ⇒ validGroundingBudgets empty ⇒ over-budget still blocks.
- `bsc10-integration.test.ts` M-1 (:493/:518): tampered chain blocks under ENFORCE; non-blocking under WARN (flag-gated, intentional Slice-A design).

## Slice C (C4a/b/c/d) — evidence-spine close + visual/a11y enforce-flip

Live probe (`slice-c-neg-controls.test.ts`, gitignored per the bsc10 probe precedent — this
file is the force-tracked record). Coverage in `tests/bsc10-slice-c.test.ts` (27 tests):

- **C4a — `grounding_bound` opt-in (resolves the unsatisfiable manifest_digest-presence model).**
  A per-receipt `grounding_bound?: boolean` on BSC-1/3/7 receipts, in each signed canonical order
  before `manifest_digest`, omit-when-absent ⇒ byte-identical (I7g). Gate `hasUnboundGroundingReceipt`
  bumps `manifest_digest_absent` ⇒ BLOCK under enforce when `grounding_bound && !manifest_digest`
  (I7b); absent/false ⇒ PASS (I7e legacy, neg-4 grandfathered). Positive control I7f
  (grounding_bound + matching manifest_digest ⇒ PASS).
- **C4b — BSC-7 conformance precondition.** The approval β-acceptance leg consumes the hoisted
  grounding verdict: a present-but-over-budget/unobserved required ground BLOCKS acceptance in the
  same leg (I2a/I2b/I2c), and the observed-vs-budget `toleranceDiff` is surfaced in `res.grounding`.
- **C4c — observed-vs-signed-budget threshold for tolerance kinds (closes deferred MED-1).** The gate
  RECOMPUTES `observed > signed_threshold` (C4c-c: a receipt self-reporting `within-budget` at
  observed=200 > threshold=100 is overridden to over-budget by the gate's own arithmetic);
  unobserved/unpinned under enforce fail-closed (I8b). Deterministic — no renderer/axe.
- **C4d — visual-hash enforce-flip.** `ENFORCED_GROUND_KINDS` gains `visual-hash` (a11y rides within
  it). Flag-aware tests (`bsc10KindEnforced("visual-hash")`) are green in BOTH flag states; the flip
  is a revertable unit. Enforce-sim: the real project declares no grounding receipts ⇒ 0 unwaived
  offenders.

DEFERRED (Done-final / follow-up): real renderer/axe toolchain measurement in the producer/CI;
P4-5 trust-boundary extraction (require-grounded, chain-sealed migration markers).
