---
description: Inspect the TwinHarness stage pipeline — show the current active stage, describe any stage's contract (produces/criticMode/humanGate/tiers), or list every stage in pipeline order.
argument-hint: current | describe <stage> | list
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Query the TwinHarness stage pipeline for this project.

Live current stage (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" stage current || true`

**Preferred path — typed MCP tools:**

```
mcp__plugin_twinharness_th__th_stage_current  {}
mcp__plugin_twinharness_th__th_stage_describe  { "stage": "<stage-id>" }
mcp__plugin_twinharness_th__th_stage_list  {}
```

**CLI fallback:**

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" stage current
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" stage describe <stage>
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" stage list
```

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `current` | The stage name recorded in `state.json` as the active stage |
| `describe <stage>` | Per-stage contract: artifact produced, Critic mode, human-gate flag, and which tiers engage the stage |
| `list` | Every stage in STAGE_PIPELINE order with its produces/humanGate summary |

## Stage pipeline (canonical order)

The pipeline runs stages sequentially. Each stage produces a doc artifact under `docs/` and
optionally requires a human gate before the Orchestrator advances. Use `th stage list` to see the
full live order (including any new stages added by the current plugin version).

Key contract fields returned by `describe`:

| Field | Meaning |
|-------|---------|
| `produces` | The artifact file this stage writes (e.g. `docs/01-requirements.md`) |
| `criticMode` | The Critic review mode applied after production |
| `humanGate` | `true` when the human must approve before advancing |
| `tiers` | Which tiers (`T0`–`T3`) engage this stage |

## Flags

| Flag | Description |
|------|-------------|
| `--json` | Emit machine-readable JSON on stdout |
| `--cwd <dir>` | Operate against `<dir>` instead of the current directory |
