# BSC-9 probe evidence — captured RED→GREEN→PASS + independence control-flip

Captured from `npx vitest run` over `.omc/audit/probes/bsc9/*.test.ts` (ephemeral config,
`testTimeout: 30000`). All 5 tests pass: the 3 probe legs + the 2 independence arms.

## Readiness leg — RED (enforcement off) → GREEN (enforcement on) → PASS (with receipt)

A green-at-final-verification project whose interview is REQUIRED and asserted READY
(`confidence 0.95 ≥ cutoff 0.8`) but carries NO backing `InterviewReadinessReceipt`.

```
[RED  OFF] {"res.ok":true,"res.error":null,"res.notice.token":"bsc9_unverified","readinessStatus":"absent"}
[GREEN ON] {"res.ok":false,"res.error":"bsc9_unverified","readinessStatus":"absent"}
[PASS recpt] {"res.ok":true,"res.error":null}
```

- **RED** (`TH_BSC9_ENFORCE=0`): the gate observes the ungrounded readiness but does NOT block —
  it surfaces a non-blocking `bsc9_unverified` NOTICE (`readinessStatus: absent`). The run would be
  certified complete on a self-asserted readiness.
- **GREEN** (default, enforcement ON): the gate BLOCKS with `bsc9_unverified`
  (`readinessStatus: absent`) — readiness asserted without a backing receipt.
- **PASS** (a backing in-process receipt minted, faithful projection fixtures): the gate PASSES —
  proving the GREEN block is the receipt's absence, not an unrelated lever (non-vacuous).

## Independence control-flip — external-signed accepted ↔ in-process-forged rejected

Both arms share the identical fixture, refId, and readiness ground; only the signature provenance
differs (a verifying signature from the real key K1 vs a non-verifying one from a wrong key K2).

```
[ACCEPT real] {"validated.status":"valid-grounded","gate.ok":true,"gate.error":null}
[REJECT forge] {"validated.status":"forged","gate.ok":false,"gate.error":"bsc9_unverified","readinessStatus":"forged"}
```

- **ARM A** — an external readiness receipt signed by the REAL key K1 (the verifier holds K1's
  public key) verifies ⇒ `valid-grounded` ⇒ the gate PASSES.
- **ARM B** — the SAME bytes forged in-process with a DIFFERENT key K2 does NOT verify ⇒ `forged`
  ⇒ the gate BLOCKS with `bsc9_unverified` (`readinessStatus: forged`).

The `valid-grounded` label is reachable ONLY via a signature the in-process surface cannot forge —
that delta IS the independence property (a NUMBER > 0). SIGNATURE-PROVENANCE only: the scored
judgment stays agent-authored, so this proves the receipt was not forged in-process, NOT that the
judgment is independent. Done-phase; Done-final deferred to P4–5.

## Projection oracle (suite-resident, `tests/mcp-cli-parity.test.ts`)

The real `toToolResult` matches the core `referenceProjection` contract over every committed
twin-call fixture, and the gate-time oracle finds ZERO infidelities on the shipped set. The seeded
infidelities (dropped data field, flipped `isError`, altered `exitCode`) are caught in
`tests/bsc9-negative-controls.test.ts` (control b), including a gate-level block when a committed
fixture carries a seeded infidelity.
