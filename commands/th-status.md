---
description: Show the current TwinHarness state — tier, stage, gates, slices, and open drift.
argument-hint: (no arguments)
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Render the current TwinHarness state for this project.

Live state (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" state status || true`

To refresh the state during this turn, **prefer the typed
`mcp__plugin_twinharness_th__th_state_get` MCP tool** (typed + worktree-safe) and summarize the fields
below; fall back to the CLI only for verbs not exposed as MCP tools (see `reference/mcp-tools.md`). The
CLI renders the same snapshot if you'd rather not read raw state:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" state status
```

Then summarize for the user: the current **tier** and **stage**, whether implementation is allowed,
any **blast-radius flags**, the count of **open blocking drift** escalations, approved artifacts, and
per-slice status. If `th state status` reports the project is not initialized, tell the user to run
`/twinharness:th-run <idea>` (or `th init`) first.
