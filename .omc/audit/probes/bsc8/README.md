# BSC-8 Probe — tier↔complexity correspondence (the brief is the sensor)

Axis-B slice-7 NEGATIVE-CONTROL: a run that **declares a tier below the minimum the
brief mechanically requires** (or jumps past a newly-engaged stage on an un-rewound
upgrade, or carries a brief edited after attestation) is detectable at the completion
gate. The receipt's recomputable ground is `classifyBrief(docs/00-task-brief.md)` (the
SAME classifier `th tier classify` uses, lifted to `core/tier-classify.ts`) plus the brief
digest — **never** a self-asserted tier the gate trusts at face.

Reproducible probe spec: [`probe.test.ts`](./probe.test.ts) (runs against `src/` via
vitest — no `dist/` build required). It is self-verifying: the `console.log` lines in
[`evidence.md`](./evidence.md) are captured verbatim from a real run, and the `expect`s
make it a RED→GREEN pair.

## Contents

- [`evidence.md`](./evidence.md) — the negative-control red→green record: a run that
  *declares* `tier:T0` over a brief whose blast-radius veto forces ≥T1 is **RED** (completes)
  when enforcement is flag-OFF (`TH_BSC8_ENFORCE=0`, claim-trusting) and **GREEN** (blocked)
  when flag-ON + the brief-classifying sensor recomputes the min-tier from the brief. Asserts
  **both** flag states (the fail-open guard).
- [`probe.test.ts`](./probe.test.ts) — the self-verifying, reproducible probe spec the
  evidence is captured from (runs against `src/` via vitest; no `dist/` build required).

## The four enumerated bypass surfaces (each a 1:1 committed blocking test)

The probe demonstrates surface **(a)**; all four are committed blocking tests in
`tests/bsc8-tier-correspondence.test.ts`:

- **(a) under-declared tier** — `tier:T0` over a brief whose signals force ≥T1 →
  blocked (`tier_correspondence_unverified` / `under_declared`). *(this probe)*
- **(b) un-rewound upgrade** — a T0→T2 upgrade that did not rewind `current_stage` left a
  newly-engaged stage skipped → blocked (`stage_unrewound`) until the stage's artifact is
  registered. The upgrade is witnessed by the receipt's `current_stage_at_mint` (a legitimate
  `th tier record` rewinds and re-mints; a raw `--emergency` jump does neither).
- **(c) stale brief** — the brief changed after the correspondence receipt was minted →
  blocked (`stale_brief`) on the digest divergence.
- **(d) raw `state set tier` bypass** — `tier` is GATE_OWNED; a raw `th state set tier`
  without `--emergency` is refused at the source (regression guard).

## Enforcement flag

The rung is gated by `TH_BSC8_ENFORCE` (mirrors `bsc3-flag.ts`): unset / `1` / `true` ⇒
**ENFORCE** (blocks); `0` / `false` ⇒ **ship-dark** (a non-blocking `notice`, never a block).
The compiled default is ENFORCE — the probe forces the RED leg with `TH_BSC8_ENFORCE=0`.

## Independence (Done-phase only)

`producer_identity` carries ZERO trust weight in-process. The receipt proves the
correspondence was RECORDED + is RE-CHECKABLE, NOT that an independent producer minted it;
the independent producer is the P4–5 extraction milestone. The ledger `independence` for
BSC-8 stays `0`.
