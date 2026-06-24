# BSC-5 Probe Evidence — Dimension-Set-Coverage Rung (Axis-B slice-7)

The captured **RED → GREEN** record driven through the REAL gate (`checkProductionReality`), the
REAL committed declared set (`src/core/declared-dimensions.ts`), and the REAL observed
re-derivation (`observedDimensionsFromReport` over `verify-report.json`). The lever is the
enforcement flag `TH_BSC5_ENFORCE`; the blind spot is a **declared-but-unobserved** dimension.

## The blind spot (BSC-5)

Completion clears on a verify-report that says "ok" with NO check that the **declared** required
dimension set was actually **covered**. A run can observe `tests-executed` + `typecheck`, never
build, and still be certified complete — the `build` dimension is *declared required* but never
*observed*.

## The ground (`declared ⊆ observed`, recomputed — never the receipt)

- **DECLARED** = the COMMITTED `DECLARED_DIMENSION_SET` constant (`core/declared-dimensions.ts`,
  Interp A). Narrowing it is a reviewable `src/` + `dist/` diff under CI's committed-`dist/`
  invariant — never a runtime self-attest.
- **OBSERVED** = re-derived at gate time from `verify-report.json` via the SAME
  `observedDimensionsFromReport` the BSC-3 sensor uses (a dimension is observed iff a matching
  command exists AND `ok === true`).
- The gate recomputes BOTH sets + the `declared ⊆ observed` verdict from live inputs; a
  `DimensionSetCoverageReceipt`'s stored `covered`/declared/observed fields are NEVER trusted.

## RED → GREEN — the lever is `TH_BSC5_ENFORCE`

The fixture is GREEN at final-verification on every other rung; its verify-report observes
`tests-executed` + `typecheck` but NOT the declared `build`. No coverage receipt is minted, so the
gate recomputes `declared ⊆ observed` straight from the live constant + live report.

- **RED (`TH_BSC5_ENFORCE=0`, ship-dark):** the gate OBSERVES the coverage gap but does not block —
  a non-blocking NOTICE — so the run would be certified complete with `build` declared-but-unobserved.
- **GREEN (default, enforcement ON):** the gate recomputes `declared ⊄ observed`, finds `build`
  missing, and BLOCKS with the stable token `dimension_set_uncovered`, naming `build` in
  `detail.missing`.

### Captured transcript (verbatim from `probe.test.ts`)

```
[RED  OFF] {"res.ok":true,"res.error":null,"res.notice.token":"dimension_set_uncovered","res.coverage.status":"uncovered","res.coverage.declared":["tests-executed","typecheck","build"],"res.coverage.observed":["tests-executed","typecheck"]}
[GREEN ON] {"res.ok":false,"res.error":"dimension_set_uncovered","res.detail.reason":"uncovered","res.detail.missing":["build"]}
```

## Enumerated negative-controls (consensus plan §5, BSC-5 a–d → 1:1 blocking tests)

All in `tests/bsc5-coverage-gate.test.ts` (+ the committed-artifact guard in
`tests/bsc5-declared-set.guard.test.ts`):

- **(a)** a coverage CLAIM whose report omits the declared `build` command ⇒ `dimension_set_uncovered`
  (`reason: uncovered`, `missing: ["build"]`) — the gate re-derives observed from the live report.
- **(b)** mint a coverage receipt claiming all observed, then STRIP `build` evidence from the report
  ⇒ the gate RE-DERIVES observed, finds it uncovered, blocks (the stored `covered:true` is never
  trusted).
- **(c)** a receipt SELF-ATTESTING all-observed over a report missing `build` ⇒ the gate recomputes
  `declared ⊆ observed` from the live constant + live report, blocks — a self-attested coverage claim
  cannot route around the re-derivation (the receipt's stored verdict is never trusted).
- **(d)** a receipt bound to a DIFFERENT declared-set digest (a narrowed/changed committed set) ⇒
  `declared_set_diverged` block (the runtime tripwire); the committed artifact being the gate's
  single source of truth is pinned by `bsc5-declared-set.guard.test.ts`.

ABSENCE ≠ FORGERY (additive posture, mirroring BSC-1/2/3): a run with NO coverage receipt is
grandfathered (PASS) — the requirement bites on a PRESENT claim, so adding this rung never reds an
in-flight run that has not yet minted a coverage receipt.

## Independence (Done-phase, not Done-final)

`producer_identity` on the `DimensionSetCoverageReceipt` carries ZERO trust weight in-process — an
audit breadcrumb only. The coverage verdict's integrity comes from the gate's live recompute over a
COMMITTED artifact (not from the receipt), and the enforcement is flag-flippable
(`TH_BSC5_ENFORCE`). Independent (out-of-process keyed) grounding is the P4–5 extraction milestone,
deferred — this slice closes BSC-5 to **Done-phase** only.
