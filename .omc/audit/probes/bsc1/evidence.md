# BSC-1 Probe Evidence — Realization Receipt (the slice-completion grounding row)

> **Supersedes** the original deep-interview probe (the "UI design has no realization gate"
> note). That note framed BSC-1 around an unanchorable UI deliverable; consensus planning
> (`.omc/plans/twinharness-axisb-slice5-bsc1-realization-plan.md` §0) re-grounded BSC-1 on the
> **slice-done-claim → in-source-anchor-digest** correspondence. This file records the
> red→green for that shipped ground.

Authored by Lane 4 (worker-tests, slice-5). The matrix-status doc-truth guard
(`tests/axisb-matrix-status.doc-truth.test.ts`) requires this directory to exist and hold the
real red→green evidence.

## The blind spot (BSC-1)

A slice can be marked `done` while a REQ-ID it owns has **no bound, reachable, digest-fresh
source anchor** — "done" is asserted with no correspondence to realized code, and the
completion gate clears anyway.

## The ground (consensus §0.2 — an independent, time-separated claim surface)

- **CLAIM** = `SliceState.status === "done"` (authored at the slice→done transition).
- **REFERENT** = a digest-bound anchor in a non-plan source file, recorded by
  `th realize <REQ-ID> --artifact <path>` (a *different* act, at a *different* time, than the
  done-claim — co-authoring them would be self-grounding, the rejected v2 ground).
- The completion gate (`checkProductionReality` → `checkRealization`) ranges over every REQ-ID
  owned by a `done` slice and BLOCKS when the claim exists but a fresh, reachable referent does
  not.

## RED → GREEN — the lever is the migration marker

Pre-existing `done`-slice REQ-IDs are **grandfathered** via an idempotent `legacy` backfill so
the regime does not red every in-flight run. The hole this leaves — and the fix — is exactly
what the probe demonstrates:

- **RED (passes-today):** *before* the `.realization-receipts-migration` marker is stamped, a
  done-slice REQ with no receipt grandfathers to `legacy` and the gate PASSES.
- **GREEN (blocks-after-fix):** *after* the marker is stamped with an EMPTY baseline, that REQ
  is a **post-regime** obligation (not grandfathered) → `absent` → the gate BLOCKS with the
  stable token `realization_unverified`.
- **CLEAR:** `th realize` mints a digest-fresh referent → the gate PASSES again (the fix is
  satisfiable, not a permanent wall).

## Transcript — through the REAL `th` CLI (`dist/cli.js`)

Reproduce with `node .omc/audit/probes/bsc1/probe.cjs` from the repo root (the script builds a
temp project, clears every prerequisite rung — tier, Tester, verify-report, the FULL required
human-approval set — through the real typed CLI verbs, so the ONLY lever between RED and GREEN
is the realization migration marker).

```
########## BSC-1 PROBE — REAL th CLI (dist/cli.js) ##########
required human approvals: ["requirements","scope","architecture","ux-design","ui-design","final-verification"]

===== RED (passes-today): done-slice REQ-001, NO realization receipt, NO migration marker =====
marker present: false
$ th gate production-reality
exit: 0
Production-reality gate clear: no unretired user-visible simulation, verify green, Tester record attached, no unledgered simulation in dist/.

===== GREEN (blocks-after-fix): same project, migration marker stamped (empty baseline) =====
marker present: true
$ th gate production-reality
exit: 1
Production-reality gate BLOCKS (realization_unverified).

===== CLEAR (fix satisfiable): th realize REQ-001 --artifact src/commands/a.ts =====
$ th realize REQ-001 --artifact src/commands/a.ts → exit 0
$ th gate production-reality
exit: 0
Production-reality gate clear: no unretired user-visible simulation, verify green, Tester record attached, no unledgered simulation in dist/.
```

### The GREEN-leg structured block (gate `detail`)

The same GREEN leg, read as the gate's structured result (`checkProductionReality`):

```json
{
 "ok": false,
 "error": "realization_unverified",
 "detail": {
  "failures": [ { "reqId": "REQ-001", "status": "absent", "owningSlices": ["SLICE-0"] } ],
  "total": 1,
  "statuses": ["absent"]
 }
}
```

## Self-verifying spec

[`probe.test.ts`](./probe.test.ts) is the self-verifying RED→GREEN→CLEAR triple (runs against
`src/` via vitest, no `dist/` build of the spec required). It asserts the RED leg PASSES
(pre-migration grandfather), the GREEN leg BLOCKS with `realization_unverified`/`absent`, and
the CLEAR leg PASSES after `th realize`.

Run:
```
# self-verifying spec (src/, vitest):
npx vitest run .omc/audit/probes/bsc1/probe.test.ts   # via an ephemeral config including this path
# CLI transcript (dist/, real binary):
node .omc/audit/probes/bsc1/probe.cjs
```

## Six enumerated negative-controls + independence (committed suite)

The full adversarial layer lives in the committed test suite (`tests/`), keeping `npm run
verify` honest on every runner:

- `tests/bsc1-negative-controls.test.ts` — the six controls, each BLOCKing with
  `realization_unverified`: **(a)** absent, **(b)** stale/forged `referent.digest`
  (`target_mismatch`/`stale`), **(c)** `target_missing`, **(d)** in-process-forged external
  claim (`forged`), **(e)** delta-over-coverage (coverage GREEN on the SAME REQ-ID, yet
  realization BLOCKs — coverage gates `!planned||!tested` and never hashes the anchor), **(f)**
  fail-open name-fidelity guard (a done-slice REQ under a `null`-component file is REPORTED
  `unresolved`, never silently dropped). Each block is paired with a non-vacuous positive twin.
- `tests/bsc1-independence-control-flip.test.ts` — the 1b independence control-flip: the REAL
  external Ed25519 producer (`scripts/th-receipt-producer.mjs --kind realization`) ⇒
  `valid-grounded` ⇒ gate PASSES; the SAME bytes forged in-process with a different key ⇒
  `forged` ⇒ gate BLOCKS. Independence **> 0**, scoped honestly as **signature-provenance
  only** (the referent anchor stays agent-authored).
- `tests/bsc1-realization-concurrency.test.ts` — N parallel `withStateLock`-wrapped appends
  land with no lost update + an intact hash chain; readers never see a torn line; a stale lock
  is stolen, not wedged.

## Byte-clean assertion

Running the probe mutates **no** tracked source: `git diff --name-only -- src/ dist/ agents/
templates/ schemas/` is empty after a probe run (the probe operates entirely in an OS temp
dir).
