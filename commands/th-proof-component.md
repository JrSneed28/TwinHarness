---
description: Run a single TwinHarness proof component (1–9) and emit its report card.
argument-hint: <1-9>
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Run TwinHarness proof component **$ARGUMENTS** and emit its report card.

> **Running `th`:** the CLI ships inside this plugin. Wherever instructions say `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`. **Prefer the typed
> `mcp__plugin_twinharness_th__th_proof_component` MCP tool** and fall back to
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" proof component …` for CLI-only verbs.

Current proof scenario list (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" proof scenario list || true`

Invoke the single-component proof — prefer the MCP tool:

```
mcp__plugin_twinharness_th__th_proof_component  {"component": <N>}
```

Fall back to CLI:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" proof component <N>
```

where `<N>` is the component number from `$ARGUMENTS` (1–9):

| # | Component | Proof type |
|---|-----------|-----------|
| 1 | Operational | Live — asserts from harvested real scenario artifacts |
| 2 | Orchestration | Live — asserts from harvested real scenario artifacts |
| 3 | Stress (lock contention + scanner load) | Mechanical — real `execFile`, LLM-free |
| 4 | Performance (scanner / lock / schedule / MCP round-trip) | Mechanical — LLM-free |
| 5 | Dogfood (narrative case studies + outcome stats) | Live — asserts from harvested real scenario artifacts |
| 6 | Failure-injection (fault → safe-fail + exit-code taxonomy) | Mechanical — LLM-free |
| 7 | Security & containment (NAME-SET diff, GATE_OWNED refusal) | Mechanical — LLM-free |
| 8 | Cross-platform parity | Mechanical — LLM-free |
| 9 | Runner + report + coverage matrix surface | Mechanical — LLM-free |

**Components 1, 2, and 5** derive their verdicts **exclusively** from harvested live scenario
artifacts — ensure a live scenario has been run and finished (`proof scenario start` →
proof-runner skill → `proof scenario finish`) before invoking these components.

**Components 3, 4, 6, 7, 8, and 9** are LLM-free mechanical sub-proofs and can run at any time
against the real `dist/cli.js`.

The report card writes under `.twinharness/proof/latest/` and includes the component verdict,
stats, and AI-actionable diagnostics for every failed assertion. For the full 9-component suite,
use `/twinharness:th-proof` instead.
