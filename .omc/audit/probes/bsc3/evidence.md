# BSC-3 Probe Evidence — VerificationDriver (trusted runner = the sensor)

Axis-B slice-4a NEGATIVE-CONTROL: a run that **claims a verification dimension it
did not observe** is detectable at the completion gate. The receipt's recomputable
ground is `verify-report.json`'s per-command exit results — **never**
`tester-record.json` (binding there would reproduce BSC-3 inside its own fix).

Reproducible probe spec: [`probe.test.ts`](./probe.test.ts) (runs against `src/`
via vitest — no `dist/` build required). It is self-verifying: the `console.log`
lines below are captured verbatim from a real run, and the `expect`s make it a
RED→GREEN pair.

## Scenario

A project whose **entire** final-verification ladder is GREEN (slices settled,
coverage clean, verification report registered, live-QA Tester record attached, the
closed human-approval required-set satisfied, no `dist/` simulation). The ONLY
remaining lever is the BSC-3 verification-driver rung.

1. The runner writes `verify-report.json` observing all three seed dimensions
   (`tests-executed`, `typecheck`, `build`) and mints an honest in-process
   `DriverDimensionReceipt` recording them.
2. The report is then re-written so it **no longer observes `build`** — i.e. the
   receipt now CLAIMS a dimension the current artifact does not evidence. This is
   the claim-without-observation: a verification dimension a trusted runner never
   (re-)exercised.

The SAME fixture is then evaluated under both enforcement-flag states; only the flag
differs between the two legs.

## Constructed RED baseline (BSC-3 is greenfield — no old code to revert)

BSC-3 is a new rung, so the RED is constructed by turning the rung OFF (the
claim-trusting world the rung exists to close), exactly the fail-open the
`TH_BSC3_ENFORCE` flag must guard.

| Leg | `TH_BSC3_ENFORCE` | Behavior |
|-----|-------------------|----------|
| **RED** | `0` (claim-trusting / OFF) | the unverified claim **completes** (gate `ok:true`, soft NOTICE only) |
| **GREEN** | unset → ON (default) | the artifact-checking sensor recomputes the ground from `verify-report.json` and **BLOCKS** |

## Decisive before → after (captured verbatim)

Run at HEAD `9b02261` on branch `feat/axisb-slice4a-bsc3-driver`:

```
[RED  OFF] {"res.ok":true,"res.error":null,"res.notice.token":"driver_dimension_unverified","res.notice.reason":"unobserved","build.observed":false}
[GREEN ON] {"res.ok":false,"res.error":"driver_dimension_unverified","res.detail.reason":"unobserved","build.observed":false}
```

Reading the delta:

- **RED (OFF):** `checkProductionReality` returns `ok:true` — the run would be
  certified complete. The anomaly is OBSERVED (`build.observed:false`) and surfaced
  as a non-blocking `notice` (token `driver_dimension_unverified`, reason
  `unobserved`), but enforcement does not act. **A claim of an unexercised
  verification dimension slips through.**
- **GREEN (ON):** the SAME claim, same fixture — `checkProductionReality` returns
  `ok:false` with the stable token `driver_dimension_unverified` and
  `detail.reason:"unobserved"`. The sensor re-read `verify-report.json`, found
  `build` no longer observed, and **blocked completion.**

`build.observed:false` in BOTH legs proves observation is unconditional (the flag
governs ENFORCEMENT only, never the sensor) — so the OFF leg is a genuine fail-open
demonstration, not a blind spot.

## Reproduction Result

```
$ cat > /tmp/vitest.probe.config.ts <<'EOF'
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [".omc/audit/probes/bsc3/probe.test.ts"],
    environment: "node",
    globalSetup: ["tests/global-setup.ts"],
    pool: "threads",
    testTimeout: 30000,
  },
});
EOF
$ npx vitest run --config /tmp/vitest.probe.config.ts --reporter=verbose

 ✓ .omc/audit/probes/bsc3/probe.test.ts > ... > RED leg (TH_BSC3_ENFORCE=0): the run COMPLETES (non-blocking notice) — the unverified claim slips through
 ✓ .omc/audit/probes/bsc3/probe.test.ts > ... > GREEN leg (enforcement ON, default): the gate BLOCKS — the sensor recomputes the ground

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

(The repo's `vitest.config.ts` scopes `include` to `tests/**`, so the probe spec —
which lives under gitignored `.omc/` — is run via an ephemeral config that includes
its path. The ephemeral config is NOT committed.)

## Why this is the right ground (pre-mortem #1)

Every seed dimension binds to a `verify-report.json` exit artifact, which the gate
re-reads and re-derives at validation time (the F8 "diffable ground" lesson). The
block fires because the recorded dimension is no longer derivable from the current
report — not because of any self-declared field. Binding to `tester-record.json`
(an agent-supplied MARKER) was explicitly avoided.

## Byte-Clean Assertion

This probe touches NO tracked source: it builds an isolated temp project under the
OS tmpdir and tears it down in `afterEach`. The probe spec + this evidence live
under `.omc/audit/probes/bsc3/`, which is gitignored (local tooling state, not part
of the plugin deliverable) — the same posture as the BSC-4 probe evidence.

## Independence (>0) — proven in the test suite, not here

The 4b external-signed-vs-forged independence control ships in 4a's trust logic and
is proven at the gate in `tests/bsc3-driver-gate.test.ts` (an external Ed25519-signed
`DriverDimensionReceipt` ⇒ `valid-grounded` / accepted; the same bytes with a broken
or wrong-key signature, still claiming external ⇒ `forged` / BLOCK). The end-to-end
out-of-process producer is Lane C (4b), deferred this run.
