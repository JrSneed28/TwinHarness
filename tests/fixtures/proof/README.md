# `tests/fixtures/proof/`

Golden inputs for the proof-suite engine tests.

## No simulation of the system under test

The proof engine's contract is **real data, zero simulation**: the harvest tests
do **not** read a hand-faked `state.json` / `gate-ledger.jsonl` / scorecard
payload. Instead they drive the **real spine** (`runInit`, `runDriftAdd`,
`runDecisionAdd`, `runRoute`, `appendLeaseEvent`, `runScorecard`, …) in an
isolated temp project and harvest the genuine artifacts those functions produce.
That keeps the fixtures always-in-sync with the live schema and avoids replaying a
mock of the SUT.

## `proof-calls.jsonl`

The one committed artifact here is the dedicated MCP call trail (C1/A1/A2). Its
real producer is the `mcp-server` `CallTool` handler, which is a **later R7 phase**
(it regenerates `dist/`), so the trail is pinned here as the canonical reference
the harvest **reader** (`readProofCalls`) is tested against. It deliberately
includes:

- multiple distinct tool names (≥ 3),
- an `ok:false` record (the catch-site append, A2),
- a torn/`not-json` line (to prove the reader skips malformed lines, tolerant).
