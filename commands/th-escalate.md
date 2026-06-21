---
description: Surface TwinHarness blocking escalations that need a human decision before work can complete.
argument-hint: (no arguments)
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Surface everything currently **blocking** completion of this TwinHarness run (spec §8, §10, §18).

Next mechanical obligation (the run's highest-priority owed action, captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" next || true`

Gather the blocking signals — **prefer the typed `mcp__plugin_twinharness_th__*` MCP tools** and fall
back to the CLI only for verbs not exposed as MCP tools (see `skills/twinharness/reference/mcp-tools.md`):

- **`mcp__plugin_twinharness_th__th_next`** — the next mechanical obligation (same as the `!` snapshot above).
- **`mcp__plugin_twinharness_th__th_state_get`** — tier/stage/gates, `drift_open_blocking`, revise-loop counts, and open questions.
- `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" drift list --json` — drift entries + open blocking count (no MCP tool yet; CLI only).

Then present, in priority order, anything that requires a human decision:

1. **Open blocking drift** (`drift_open_blocking > 0`) — requirement/scope contradictions that paused
   the build (spec §10). Show each `DRIFT-NNN`, its discovery, and what decision is awaited.
2. **Revise-loop escalations** — any stage whose `revise_loop_counts.<mode>` has hit the cap (default
   3) with issues still open (spec §7, §18); the Critic↔producer loop stopped and needs the human.
3. **Open questions** in state that block advancement.

For each, state the decision the human must make and the consequence. If `th hook stop-gate` would
block (invalid state or open blocking drift), say so explicitly. If nothing is blocking, report that
the run has no open escalations.
