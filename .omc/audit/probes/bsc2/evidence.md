# BSC-2 Probe Evidence — Assertion-Presence (the trivially-asserted "tested" REQ)

Axis-B slice-6 NEGATIVE-CONTROL: a run whose test for a `tested` REQ-ID carries ONLY
a TRIVIAL (cannot-fail) assertion is detectable at the completion gate. `th coverage
check` marks a REQ "tested" on anchor presence alone (a REQ-ID token inside a
recognized test file) — it never inspects the test body — so a tautology like
`expect(true).toBe(true)` clears the bar identically to a real check. The BSC-2 rung
adds the missing sensor: it RECOMPUTES, per REQ-ID, whether the recognized test files
carry a NON-TRIVIAL assertion, and the gate enforces on the fresh recompute.

Reproducible probe spec: [`probe.test.ts`](./probe.test.ts) (runs against `src/` via
vitest — no `dist/` build required). It is self-verifying: the `console.log` lines
below are captured verbatim from a real run, and the `expect`s make it a RED→GREEN
pair.

## Scenario

A project whose **entire** final-verification ladder is GREEN (slices settled,
coverage clean, verification report registered, live-QA Tester record attached, the
closed human-approval required-set satisfied, no `dist/` simulation, no repo-map ⇒ the
realization rung passes, no driver receipt ⇒ the driver rung is grandfathered). The
ONLY remaining lever is the BSC-2 assertion-presence rung.

1. REQ-001's ONLY test (`tests/x.test.ts`) anchors the REQ but asserts a tautology:
   `expect(true).toBe(true)`. `th coverage check` reads REQ-001 as `tested`.
2. An honest in-process `AssertionPresenceReceipt` is minted recording that (trivial)
   ground — so the rung reaches the OFFENDER check (not the no-receipt fail-closed
   `assertion_unobserved` path; that case is covered by negative-control (b)).

The SAME fixture is then evaluated under both enforcement-flag states; only the flag
differs between the two legs. The gate recomputes the offender set FRESH from the test
bodies — it does NOT trust the receipt's stored ground for the offender decision (the
receipt is the F8 correspondence artifact, the live recompute is the verdict).

## Constructed RED baseline (BSC-2 is a new rung — no old code to revert)

BSC-2 is a new rung, so the RED is constructed by turning the rung OFF (the
presence-trusting world the rung exists to close), exactly the fail-open the
`TH_BSC2_ENFORCE` flag must guard.

| Leg | `TH_BSC2_ENFORCE` | Behavior |
|-----|-------------------|----------|
| **RED** | `0` (presence-trusting / OFF) | the trivially-asserted REQ **completes** (gate `ok:true`, soft NOTICE only) |
| **GREEN** | unset → ON (default) | the sensor recomputes the per-REQ ground, finds REQ-001 assertion-free, and **BLOCKS** |

## Decisive RED → GREEN (captured verbatim)

Run at HEAD `b10e89e` on branch `feat/axisb-slice6-bsc2-assertion-presence`:

```
[RED  OFF] {"res.ok":true,"res.error":null,"res.notice.token":"assertion_presence_unverified","req001.assertionFree":true,"req001.nonTrivial":0}
[GREEN ON] {"res.ok":false,"res.error":"assertion_presence_unverified","res.detail.offenders":["REQ-001"]}
```

Reading the delta:

- **RED (OFF):** `checkProductionReality` returns `ok:true` — the run would be
  certified complete. The anomaly is OBSERVED (`req001.assertionFree:true`,
  `nonTrivial:0`) and surfaced as a non-blocking `notice` (token
  `assertion_presence_unverified`), but enforcement does not act. **A trivially-
  asserted "tested" REQ slips through.**
- **GREEN (ON):** the SAME fixture — `checkProductionReality` returns `ok:false` with
  the stable token `assertion_presence_unverified` and `detail.offenders:["REQ-001"]`.
  The sensor re-read the test body, found REQ-001 carries zero non-trivial assertions,
  and **blocked completion.**

`req001.assertionFree:true` in the OFF leg with observability still firing proves
observation is unconditional (the flag governs ENFORCEMENT only, never the sensor) —
so the OFF leg is a genuine fail-open demonstration, not a blind spot.

## Reproduction Result

```
$ cat > vitest.bsc2probe.config.ts <<'EOF'
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [".omc/audit/probes/bsc2/probe.test.ts"],
    environment: "node",
    globalSetup: ["tests/global-setup.ts"],
    pool: "threads",
    testTimeout: 30000,
  },
});
EOF
$ npx vitest run --config vitest.bsc2probe.config.ts --reporter=verbose

 ✓ .omc/audit/probes/bsc2/probe.test.ts > ... > RED leg (TH_BSC2_ENFORCE=0): the run COMPLETES (non-blocking notice) — the trivial assertion slips through
 ✓ .omc/audit/probes/bsc2/probe.test.ts > ... > GREEN leg (enforcement ON, default): the gate BLOCKS — the sensor recomputes the offender set

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

(The repo's `vitest.config.ts` scopes `include` to `tests/**`, so the probe spec —
which lives under gitignored `.omc/` — is run via an ephemeral config that includes
its path. The ephemeral config is NOT committed and is removed after the run.)

## Why this is the right ground (Principle 6 — the binding contract)

The sensor is REGEX/LEXER-GRADE: it never imports `typescript` or any AST library; the
`expect(...)` count is a hand-rolled balanced-paren scan, and the pinned trivial
definition is hashed INTO the ground so producer and validator can never drift on what
"asserted" means. The ground is DETERMINISTIC (REQ summaries sorted by `reqId`, each
`testFiles[]` sorted + POSIX-normalized, no clock / no random), so the serialized
ground — and therefore the receipt's `recordHash` — is byte-identical regardless of
`readdirSync` order (proven in `tests/bsc2-determinism.test.ts`). The block fires
because the recomputed ground says REQ-001 is assertion-free — not because of any
self-declared field.

## Byte-Clean Assertion

This probe touches NO tracked source: it builds an isolated temp project under the OS
tmpdir and tears it down in `afterEach`. The probe spec + this evidence live under
`.omc/audit/probes/bsc2/`, which is gitignored (local tooling state, not part of the
plugin deliverable) — the same posture as the BSC-3 / BSC-4 probe evidence. The
committed force-tracked copy keeps fresh CI honest.

## Independence (0 in 2a; >0 lands in 2b)

The 2a in-process `AssertionPresenceReceipt` is ATTRIBUTION-ONLY — the agent can mint
it, so its trust label is `valid`/`attested-presence`, NEVER `valid-grounded`. The
genuine un-forgeable property is the EXTERNAL Ed25519-signed `MutationKillReceipt`
(2b), produced by a controlled runner that proves the suite KILLS injected faults.
2a ships `independence: 0`; the 2b control-flip (an external-signed mutation-kill
receipt ACCEPTED ⇒ `valid-grounded` while the same bytes forged in-process are
REJECTED ⇒ `forged`/BLOCK) flips the ledger `independence` to `>0`. The waiver escape
valve is already external-signed and is proven path/digest-scoped in
`tests/bsc2-negative-controls.test.ts` control (d).
