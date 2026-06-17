---
description: Run the full TwinHarness Operational Proof Suite — all 9 components, dual-format report, enforced coverage matrix.
argument-hint: [--self-test] [--brief <corpus-id>]
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*, Task, Agent
---

Run the **TwinHarness Operational Proof Suite** for: **$ARGUMENTS**

> **Running `th`:** the CLI ships inside this plugin. Wherever instructions say `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`. The Orchestrator should **prefer the typed
> `mcp__plugin_twinharness_th__th_proof_*` MCP tools** (structured results, worktree-safe) and fall
> back to `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" proof …` only for verbs not yet exposed as MCP
> tools (scenario lifecycle — `proof scenario start / finish / list` — is CLI-only).

Current proof scenario list (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" proof scenario list || true`

**Governing axis:** every live scenario runs against the **real compiled `dist/cli.js`** and the
**real Orchestrator→sub-agent full pipeline** — zero mocks, zero simulation. Scenario SUT state
lives **outside the repo** in an OS temp root; `CLAUDE_PROJECT_DIR` routes every in-session MCP
call to that root (C2 isolation — never the developer's real `.twinharness`). Live scenarios run
**serialized** — one `CLAUDE_PROJECT_DIR` active at a time; never run concurrent live pipelines.
The final report lands under `.twinharness/proof/<ISO-ts>/` + `latest/`.

### Preferred path — one-shot MCP tool

Invoke the full-suite proof run (drives corpus, lifecycle, harvest, sub-proofs, coverage matrix,
regression, and report):

```
mcp__plugin_twinharness_th__th_proof_run
```

Pass `{"selfTest": true}` for the deterministic self-test mode (zero tokens, mechanical
reachability only — **never** a live verdict for components 1, 2, or 5).

Fall back to CLI: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" proof run`

### Step-by-step workflow (for `--brief <id>` or debugging)

For each brief `<id>` in the proof corpus — run **one at a time, serially**:

1. **Start the isolated scenario** (CLI-only):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" proof scenario start --brief <id>
   ```

   Scaffolds a temp root **outside any ancestor `.twinharness`** (`th init`, telemetry enabled,
   baseline snapshot), then **prints the `scenarioRoot` path** to stdout.

2. **Export `CLAUDE_PROJECT_DIR`** to the printed root:

   ```bash
   export CLAUDE_PROJECT_DIR=<scenarioRoot>
   ```

   This is the C2 isolation lever: the in-session plugin MCP server reads `CLAUDE_PROJECT_DIR`
   per call, routing all writes to the scenario root instead of the developer's real state. If
   MCP calls land in the repo's `.twinharness` instead, use `--cwd <scenarioRoot>` on CLI
   invocations as the fallback isolation path.

3. **Drive the real pipeline** — invoke the **`twinharness-proof` proof-runner skill** with
   `CLAUDE_PROJECT_DIR` set. The skill runs the real Orchestrator→sub-agent full pipeline for
   this brief and returns when the live run is complete.

4. **Finish the scenario** (CLI-only):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" proof scenario finish --brief <id>
   ```

   Marks the scenario complete; real artifacts (`state.json`, `gate-ledger.jsonl`,
   `telemetry.jsonl`, `proof-calls.jsonl`) remain in the scenario root for harvest.

5. **Mechanical sub-proofs** per component — prefer the MCP tool:

   ```
   mcp__plugin_twinharness_th__th_proof_component  {"component": N}
   ```

   Fall back to: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" proof component <N>`

   Components 3, 4, 6, 7, 8 are LLM-free mechanical sub-proofs. Components 1, 2, 5 harvest and
   assert from the live artifacts produced above. Run all components before emitting the report.

6. **Emit the report**:

   ```
   mcp__plugin_twinharness_th__th_proof_report
   ```

   Fall back to: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" proof report`

   Writes to `.twinharness/proof/<ISO-ts>/` + `latest/`: `report.json`, `report.jsonl`,
   `report.md`, per-component cards, coverage matrix, regression deltas, AI-actionable
   diagnostics. **The run fails if any subsystem, MCP tool, or gate goes unexercised.**

**Invariants to uphold:** components 1/2/5 verdicts derive **only** from harvested live artifacts
(never the `--self-test` loop). The MCP-tool coverage dimension derives from the **dedicated
`proof-calls.jsonl` trail** — never `telemetry.jsonl` and never the self-test loop. Only
deterministic mechanical metrics gate regression (M4); live wall-clock/token are reported as a
non-gating trend. Unset or restore `CLAUDE_PROJECT_DIR` after each scenario before starting the next.
