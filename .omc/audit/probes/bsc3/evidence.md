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

---

# Independence control (slice-4b) — REAL producer ↔ in-process forgery

Slice-4b adds the missing piece: a REAL out-of-process signed producer
(`scripts/th-receipt-producer.mjs --kind driver`) and an end-to-end probe driving it
against the REAL gate. This honestly flips the BSC-3 ledger `independence` from `0`
to `>0`: a producer-signed external receipt is ACCEPTED (`valid-grounded`) while the
SAME receipt forged on the in-process surface (a different key, the closest the
in-process agent can get without the private key) is REJECTED (`forged`).

Reproducible probe spec: [`independence.test.ts`](./independence.test.ts) (runs
against `src/` via vitest; the producer it spawns imports committed `dist/`). It is
self-verifying: the `console.log` lines below are captured verbatim, and the `expect`s
make it an ACCEPT↔REJECT pair.

## Scenario

The SAME GREEN-at-final-verification fixture as the 4a negative control (slices
settled, coverage clean, report registered, Tester record attached, the closed
human-approval required-set satisfied, `verify-report.json` observing all three seed
dimensions). The ONLY lever is the BSC-3 driver rung's TRUST label.

| Leg | How the external line is signed | Gate verdict |
|-----|---------------------------------|--------------|
| **ACCEPT** | the REAL producer holds the Ed25519 PRIVATE key (K1) and signs out-of-process | `valid-grounded` ⇒ `checkProductionReality` **PASSES** |
| **REJECT** | the same bytes forged in-process with a DIFFERENT key (K2) — no access to K1's private key | `forged` ⇒ `checkProductionReality` **BLOCKS** (`driver_dimension_unverified` / reason `forged`) |

## Decisive accept → reject (captured verbatim)

Run at HEAD `105fbaa` on branch `dev`:

```
[ACCEPT real] {"producer.status":0,"gate.ok":true,"gate.error":null,"trustLabels":["valid-grounded","valid-grounded","valid-grounded"]}
[REJECT forged] {"gate.ok":false,"gate.error":"driver_dimension_unverified","gate.detail.reason":"forged","trustLabels":["forged","forged","forged"]}
```

Reading the delta:

- **ACCEPT (real):** the out-of-process producer (exit `0`) signed the receipt with
  the private key; `checkProductionReality` re-derives the ground, VERIFIES the
  signature against the loaded public key, and returns `ok:true` with every dimension
  `trustLabel:"valid-grounded"`. **The grounded label is reachable ONLY via a
  signature the in-process surface cannot mint.**
- **REJECT (forged):** the SAME bytes, same fixture, signed with a key the verifier
  does not hold — `checkProductionReality` returns `ok:false` with the stable token
  `driver_dimension_unverified` and `detail.reason:"forged"`; every dimension
  `trustLabel:"forged"`. **A forgery the in-process agent CAN produce is blocked.**

That delta — accepted ↔ rejected, gated solely on a key the in-process surface does
not hold — IS independence property `>0`.

## Reproduction Result

```
$ cat > vitest.bsc3indep.config.ts <<'EOF'
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [".omc/audit/probes/bsc3/independence.test.ts"],
    environment: "node",
    globalSetup: ["tests/global-setup.ts"],
    pool: "threads",
    testTimeout: 30000,
  },
});
EOF
$ npx vitest run --config vitest.bsc3indep.config.ts --reporter=verbose

 ✓ .omc/audit/probes/bsc3/independence.test.ts > ... > ACCEPT: the REAL producer's external-signed receipt ⇒ valid-grounded ⇒ gate PASSES
 ✓ .omc/audit/probes/bsc3/independence.test.ts > ... > REJECT: the SAME bytes forged in-process with a DIFFERENT key ⇒ forged ⇒ gate BLOCKS

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

(The ephemeral config lives at the repo root so `vitest/config` resolves against
`node_modules`; it is NOT committed and is removed after the run. The probe spec lives
under gitignored `.omc/`, which the repo `vitest.config.ts` does not include.)

The same accept↔reject is asserted in the committed suite
(`tests/bsc3-independence-control-flip.test.ts`) and the producer's signature/hash
binding is proven byte-for-byte in `tests/driver-producer.test.ts`.
