# BSC-8 Probe Evidence — tier↔complexity correspondence (the brief is the sensor)

Axis-B slice-7 NEGATIVE-CONTROL: a run that **declares a tier below the minimum the
brief mechanically requires** is detectable at the completion gate. The receipt's
recomputable ground is `classifyBrief(docs/00-task-brief.md)` (the SAME classifier
`th tier classify` uses) plus the brief digest — **never** a self-asserted tier value
the gate trusts at face.

Reproducible probe spec: [`probe.test.ts`](./probe.test.ts) (runs against `src/` via
vitest — no `dist/` build required). It is self-verifying: the `console.log` lines below
are captured verbatim from a real run, and the `expect`s make it a RED→GREEN pair.

## Scenario

A GREEN-at-final-verification project DECLARING `tier:T0` whose brief
(`docs/00-task-brief.md`) carries a blast-radius flag (`money`). `classifyBrief` is NOT
T0-eligible (the §5 veto forces ≥T1), so the computed-min tier is `T1`. The declared `T0`
is therefore UNDER-DECLARED (`claimed T0 < computed-min T1`). Because `T0` engages no
stages, the closed human-approval required-set is empty and every prior production-reality
rung passes — the BSC-8 tier-correspondence rung is the only remaining lever.

## Constructed RED baseline (BSC-8 is greenfield — no old code to revert)

The RED leg forces the pre-enforcement posture with `TH_BSC8_ENFORCE=0`: the gate COMPUTES
the correspondence verdict (claimed vs computed-min) and attaches a non-blocking NOTICE,
but does NOT block — so the under-declared tier slips through and the run certifies complete.
The GREEN leg is the default (enforcement ON): the SAME sensor re-derives the min-tier from
the brief and BLOCKS.

## Decisive before → after (captured verbatim)

Run at base HEAD `5c8a1df` on branch `feat/axisb-slice7-bsc8`:

```
[RED  OFF] {"res.ok":true,"res.error":null,"res.notice.token":"tier_correspondence_unverified","res.notice.reason":"under_declared"}
[GREEN ON] {"res.ok":false,"res.error":"tier_correspondence_unverified","res.detail.reason":"under_declared","res.detail.computedMinTier":"T1"}
```

Reading the delta:

- **RED (TH_BSC8_ENFORCE=0):** `checkProductionReality` re-derives the min-tier from the
  brief, sees `claimed T0 < min T1`, but enforcement is OFF — so it returns `ok:true` with a
  non-blocking `notice.token: "tier_correspondence_unverified"` (`reason: "under_declared"`).
  **The under-declared tier is OBSERVED but not acted on.**
- **GREEN (default ON):** the SAME recompute, enforcement ON — `checkProductionReality`
  returns `ok:false` with the stable token `tier_correspondence_unverified`,
  `detail.reason: "under_declared"`, `detail.computedMinTier: "T1"`. **The under-declared
  tier is BLOCKED.**

That delta — completes ↔ blocked, gated solely on a min-tier the gate RE-DERIVES from the
brief (never trusts a stored value) — is the BSC-8 negative control.

## Reproduction Result

```
$ cat > vitest.bsc8probe.config.ts <<'EOF'
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [".omc/audit/probes/bsc8/probe.test.ts"],
    environment: "node",
    globalSetup: ["tests/global-setup.ts"],
    pool: "threads",
    testTimeout: 30000,
  },
});
EOF
$ npx vitest run --config vitest.bsc8probe.config.ts --reporter=verbose

 ✓ .omc/audit/probes/bsc8/probe.test.ts > ... > RED leg (TH_BSC8_ENFORCE=0): the run COMPLETES (non-blocking notice) — the under-declared tier slips through
 ✓ .omc/audit/probes/bsc8/probe.test.ts > ... > GREEN leg (enforcement ON, default): the gate BLOCKS — the sensor recomputes the min-tier from the brief

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

(The repo's `vitest.config.ts` scopes `include` to `tests/**`, so the probe spec — which
lives under gitignored `.omc/` — is run via an ephemeral config that includes its path. The
ephemeral config is NOT committed and is removed after the run.)

## Why this is the right ground (pre-mortem #3)

The sensor binds to `classifyBrief(docs/00-task-brief.md)` — the SAME mechanical T0-eligibility
classifier `th tier classify` advises against, lifted to `core/tier-classify.ts` in step-0 — and
the brief digest, recomputed IDENTICALLY at mint and at gate. It does NOT trust the receipt's
stored min-tier (recompute-don't-trust); the receipt is the F8 correspondence artifact, the live
recompute is the verdict. The four enumerated bypass surfaces (under-declared tier, un-rewound
upgrade, stale brief, raw `state set` bypass) each map 1:1 to a committed blocking test in
`tests/bsc8-tier-correspondence.test.ts`.

## Byte-Clean Assertion

The probe asserts BOTH flag states (the fail-open guard): RED leg `res.ok === true` with the
`tier_correspondence_unverified` notice; GREEN leg `res.ok === false` with the same stable token
as a hard block. A reviewer can flip `TH_BSC8_ENFORCE` and reproduce either leg.

## Independence (Done-phase only)

`producer_identity` carries ZERO trust weight in-process (Done-phase only): the receipt proves
the correspondence was RECORDED + is RE-CHECKABLE, NOT that an independent producer minted it.
The independent (un-forgeable) producer is the P4–5 trust-boundary extraction milestone, NOT this
slice. The ledger `independence` for BSC-8 stays `0` accordingly.
