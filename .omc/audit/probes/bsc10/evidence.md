# BSC-10 Probe Evidence — External-Reference Grounding

Axis-B slice-A NEGATIVE-CONTROL: a run whose required external-reference ground kind
(`digest-manifest`) is absent from the grounding receipt store blocks the completion
gate under `TH_BSC10_ENFORCE=1`. `th coverage check` and all earlier rungs clear; the
grounding rung is the only remaining lever.

Reproducible probe spec: [`probe.test.ts`](./probe.test.ts) (runs against `src/` via
vitest — no `dist/` build required). It is self-verifying: the `console.log` lines
below are captured from a real run, and the `expect`s make it a RED→GREEN pair.

## Scenario

A project whose **entire** final-verification ladder is GREEN (slices settled,
coverage clean, verification report registered, Tester record attached, the closed
human-approval required-set satisfied, no repo-map ⇒ realization PASSes, driver
grandfathered, assertion-presence grandfathered). The ONLY remaining lever is the
BSC-10 grounding rung. Work class is `"integration"` (requires `digest-manifest` +
`version-pin`).

1. **RED leg** (`TH_BSC10_ENFORCE=1`, required kind missing): the gate resolves
   `digest-manifest` + `version-pin` as required; no receipt is present; verdict =
   `missing`; gate blocks with `grounding_unverified`.

2. **GREEN leg** (`TH_BSC10_ENFORCE=1`, honest `digest-manifest` receipt present
   within budget): the gate recomputes conformance, finds it within budget, verdict =
   `grounded-within-budget`; gate PASSES.

## Constructed RED baseline

BSC-10 is a new rung, so the RED is constructed by turning enforcement ON with the
required receipt absent (the ungrounded world the rung exists to close), exactly the
fail-open the `TH_BSC10_ENFORCE` flag must guard.

## Before (RED — `TH_BSC10_ENFORCE=1`, missing receipt)

```
[RED  missing] {"res.ok":false,"res.error":"grounding_unverified","res.notice.token":null,"grounding[0].verdict":"missing","grounding[0].groundKind":"digest-manifest"}
```

Gate result: `ok: false`, `error: "grounding_unverified"`, `detail.reason: "missing"`.
The run would be certified incomplete — the gate correctly blocks on the ungrounded reference.

## After (GREEN — `TH_BSC10_ENFORCE=1`, honest receipt within budget)

```
[GREEN grounded] {"res.ok":true,"res.error":null,"res.notice.token":null,"grounding[0].verdict":"grounded-within-budget","grounding[0].groundKind":"digest-manifest"}
```

Gate result: `ok: true`. The honest grounding receipt satisfies the required kind and
the conformance metric is within budget — the run certifies complete.

## Independence note (Slice A)

In Slice A, the grounding receipt is in-process-attributed (`trustLabel: "valid"`, not
`"valid-grounded"`). Slice B wires the external Ed25519 producer (`--kind grounding`)
and flips the label to `"valid-grounded"`, pushing `independence: 0 → >0`.

## Negative controls

See [`independence.test.ts`](./independence.test.ts):

- In-process-only receipt ⇒ `ungrounded` when the kind is **required** (NOT a silent pass).
- No receipt when the kind is **not required** (pure-greenfield) ⇒ inert PASS
  (absence ≠ forgery, mirroring BSC-3 / `receipts.ts` `valid` vs `valid-grounded`).
