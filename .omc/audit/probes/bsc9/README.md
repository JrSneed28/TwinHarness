# BSC-9 probe — `toToolResult` projection oracle + interview-readiness receipt

Axis-B slice-7 / BSC-9. Closes the MCP projection-parity + readiness-from-scores blind spots to
**Done-phase**.

## The two blind spots

1. **Projection (the only authentic CLI↔MCP divergence surface).** Every MCP tool closure delegates
   to the same `run*` handler the CLI dispatches to (guarded by `tests/mcp-cli-parity.test.ts`'s
   REQ-PCO-070 thinness check), so there is no divergent *execution* path. The one real divergence
   is the **projection** — `toToolResult` (`src/mcp-server.ts`) mapping a `CommandResult` onto the
   MCP `CallToolResult`. A projection that drops/alters `ok` / the numeric `exitCode` / the `data`
   payload is otherwise silent.

2. **Readiness (readiness-from-scores).** The soft interview gate's `interviewReady`
   (`src/commands/interview.ts`) is **self-asserted**: it re-reads the interview store and returns
   `confidence >= cutoff`, with no correspondence artifact. A run can flip `ready` by editing the
   store.

## The fix

- **`src/core/projection-oracle.ts`** — a pure, SDK-free reference projector (`referenceProjection`)
  + fidelity predicate (`projectionFidelity`) + a committed **twin-call fixture set**
  (`projection-fixtures.json`). The parity test pins the real `toToolResult` to this contract; the
  gate re-runs the fixtures and blocks on any infidelity.
- **`src/core/interview-readiness.ts`** — a schema-registered `InterviewReadinessReceipt` (the
  recomputable `{confidence, cutoff, ready}` ground over the interview-store digest + snapshot
  coordinate), minted under `withStateLock` when `th interview record` reaches readiness, validated
  at gate time (`readReadinessReceiptValidated`).
- **`src/core/gate-preconditions.ts`** — one `ProductionRealityRung` (`bsc9-projection-readiness`)
  registered in `PRODUCTION_REALITY_RUNGS`. Blocks with `bsc9_unverified` when (i) the projection
  oracle finds an infidelity, or (ii) an asserted readiness has no backing valid receipt /
  sub-cutoff confidence. Flag-gated by `bsc9EnforcementEnabled()` (`src/core/bsc9-flag.ts`,
  `TH_BSC9_ENFORCE`, defaults ON).

## Independence (Done-phase only)

`producer_identity` carries **zero** in-process trust weight (audit breadcrumb only). The genuine
un-forgeable property is **signature-provenance** independence via the external Ed25519 producer:
`independence.test.ts` flips an external-signed readiness receipt (`valid-grounded` ⇒ accept) against
the same bytes forged in-process with a wrong key (`forged` ⇒ block). The scored judgment is still
agent-authored, so this proves the receipt was not forged in-process — NOT that the judgment is
independent. Done-final is deferred to P4–5.

## Files

- `probe.test.ts` — RED (`TH_BSC9_ENFORCE=0`, non-blocking notice) → GREEN (default, blocks) →
  PASS (with a backing receipt), through the real gate + real sensor.
- `independence.test.ts` — external-signed-accepted ↔ in-process-forged-rejected.
- `projection-fixtures.json` — the committed twin-call fixture set (faithful by construction;
  projected via the real `toToolResult`).
- `evidence.md` — captured RED→GREEN console output.

The 4 enumerated negative-controls (a–d) live in `tests/bsc9-negative-controls.test.ts`; the receipt
ledger concurrency/durability suite in `tests/bsc9-readiness-concurrency.test.ts`; the projection
oracle parity extension in `tests/mcp-cli-parity.test.ts`.

## Run

```bash
# probe (gitignored under .omc/, run explicitly via an ephemeral config that sets testTimeout)
npx vitest run --config <(echo 'export default { test: { include: [".omc/audit/probes/bsc9/*.test.ts"], testTimeout: 30000 } }') 
# suite-resident tests
npx vitest run tests/bsc9-negative-controls.test.ts tests/bsc9-readiness-concurrency.test.ts tests/mcp-cli-parity.test.ts
```
