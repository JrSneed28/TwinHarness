# BSC-1 Probe — Realization Receipt (Axis-B slice-5, the slice-completion grounding row)

Authored by Lane 4 (worker-tests, slice-5). The matrix-status doc-truth guard
(`tests/axisb-matrix-status.doc-truth.test.ts`) requires this directory to exist; it holds the
real RED→GREEN realization evidence.

## Contents
- [`evidence.md`](./evidence.md) — the **RED→GREEN→CLEAR** record driven through the REAL
  `th` CLI (`dist/cli.js`): a `done` slice owning REQ-001 with NO realization receipt is
  certifiable-complete TODAY (pre-migration, the absent receipt grandfathers to `legacy`), and
  BLOCKS (`realization_unverified`/`absent`) once the migration marker is stamped with an empty
  baseline. `th realize` then clears it. Includes the GREEN-leg structured gate `detail`.
- `probe.test.ts` — the self-verifying RED→GREEN→CLEAR spec (runs against `src/` via vitest; no
  `dist/` build of the spec required). *Gitignored* per program convention (only `evidence.md`
  / `README.md` are force-tracked).
- `probe.cjs` — the CLI-transcript reproducer (drives `dist/cli.js`). *Gitignored* (same
  convention); the transcript it produces is pasted verbatim into `evidence.md`.

## The ground (consensus §0.2)
- **CLAIM** = `SliceState.status === "done"` (authored at the slice→done transition).
- **REFERENT** = a digest-bound non-plan source anchor recorded by `th realize` (a separate
  act — co-authoring claim + referent would be self-grounding, the rejected v2 ground).
- The completion gate ranges over every REQ owned by a `done` slice and BLOCKS when the claim
  exists but a fresh, reachable, digest-fresh referent does not.

## Delta over coverage (why this is not a re-skin)
Coverage (`th coverage check`) gates on `!planned || !tested` set-membership and **never
hashes the anchor**. Realization adds (i) **digest freshness** of the anchor and (ii)
**coupling to the done-claim** — proven by negative-control **(e)** in
`tests/bsc1-negative-controls.test.ts`, where coverage is GREEN on the SAME REQ-ID yet
realization still BLOCKs.

## Independence (slice-1b) — signature-provenance only
The external Ed25519 producer (`scripts/th-receipt-producer.mjs --kind realization`) mints
receipts the gate accepts as `valid-grounded`; the same bytes forged in-process ⇒ `forged` ⇒
BLOCK. This flips BSC-1 independence `0 → >0`, scoped **honestly** as signature-provenance only
— the referent anchor is still agent-authored. Proven at the gate in
`tests/bsc1-independence-control-flip.test.ts`.

## Committed suite (keeps `npm run verify` honest)
- `tests/bsc1-realization.test.ts` — worker-impl's schema/producer/ownership/grandfather/gate
  pins (15 tests).
- `tests/bsc1-negative-controls.test.ts` — the six enumerated controls + grandfather idempotence.
- `tests/bsc1-independence-control-flip.test.ts` — the external-signed↔forged independence flip.
- `tests/bsc1-realization-concurrency.test.ts` — `withStateLock` durability + lock-steal.

Ground rule: the referent binds to a digest of an in-source anchor via the shared
`computeTargetDigest` — recomputed from the **cached** repo-map at gate time, never a new digest
formula.
