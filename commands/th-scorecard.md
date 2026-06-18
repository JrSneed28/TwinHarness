---
description: Display a post-run one-screen summary — tier, coverage matrix, slice progress, test suite state, open drift count, and revise-loop status for the current TwinHarness project.
argument-hint: (no arguments)
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Render the TwinHarness post-run scorecard for this project.

Live state snapshot (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" state status || true`

**Preferred path — typed MCP tool:**

```
mcp__plugin_twinharness_th__th_scorecard  {}
```

**CLI fallback:**

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" scorecard
```

Or with machine-readable output:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" scorecard --json
```

Or a per-stage cost view (token estimate/proxy + wall-clock, aggregated from the local
telemetry log; prints a clear "no data" message and still exits 0 when telemetry is off/empty):

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" scorecard --hotspots
```

## What the scorecard shows

`th scorecard` is a read-only summary view — it computes from current state and never mutates
`state.json`. It aggregates:

| Section | Content |
|---------|---------|
| **Tier** | Classified tier (T0–T3) and blast-radius flags |
| **Coverage** | REQ-ID → slice → test mapping completeness (MVP gate) |
| **Slices** | Count by status: `pending` / `in-progress` / `done` / `blocked` |
| **Test suite** | Last `th verify run` outcome and pass/fail counts |
| **Drift** | Total drift entries, open-blocking count |
| **Revise loops** | Per-stage revise count vs. cap |

Use the scorecard at any point in the run — it reflects the current snapshot, not a final-only view.
For the live next obligation, use `/twinharness:th-next`. For blocking escalations, use
`/twinharness:th-escalate`.

## Flags

| Flag | Description |
|------|-------------|
| `--json` | Emit machine-readable JSON on stdout |
| `--hotspots` | Per-stage token (estimate/proxy) + wall-clock table from the local telemetry log (empty/exit-0 when no telemetry) |
| `--cwd <dir>` | Operate against `<dir>` instead of the current directory |
