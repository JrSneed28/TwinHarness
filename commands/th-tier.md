---
description: Classify a project brief's tier and blast-radius flags, or run the mechanical veto gate — advises T0 eligibility (classify) or exits 3 when any blast flag forbids T0 (veto-check).
argument-hint: classify <brief.json> | veto-check <brief.json>
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Classify a project brief's tier or run the veto gate for this project.

Live state snapshot (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" state status || true`

**Preferred path — typed MCP tools:**

```
mcp__plugin_twinharness_th__th_tier_classify   { "briefFile": "<brief.json>" }
mcp__plugin_twinharness_th__th_tier_veto_check { "briefFile": "<brief.json>" }
```

**CLI fallback:**

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" tier classify <brief.json>
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" tier veto-check <brief.json>
```

Both subcommands require a `<brief.json>` argument — a JSON file describing the project brief
(idea, scope, and known blast-radius signals).

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `classify <brief.json>` | **Advisory** — detects blast-radius flags and advises T0 eligibility; exit 0 always (read-only advisory) |
| `veto-check <brief.json>` | **Mechanical gate** — exits 3 when any blast-radius flag mechanically forbids T0; exit 0 means T0 is permitted |

`classify` is the Orchestrator's advisory view (use after `th init`). `veto-check` is the hard gate
called before committing to T0.

## Tier ladder

| Tier | Meaning |
|------|---------|
| T0 | Isolated, low-blast — sonnet/high for builders |
| T1 | Moderate blast — opus/medium for builders |
| T2 | High blast — opus/high for builders |
| T3 | Maximum blast — opus/xhigh for builders |

## Blast-radius flags

`classify` detects flags such as `component_blast`, `cross_tier`, `schema_change`,
`public_api_change`, etc. Any flag that appears in the veto list causes `veto-check` to exit 3.

## Flags

| Flag | Description |
|------|-------------|
| `--json` | Emit machine-readable JSON on stdout |
| `--cwd <dir>` | Operate against `<dir>` instead of the current directory |

After classification, record the tier with `mcp__plugin_twinharness_th__th_state_set` (key
`tier`, value `T0`–`T3`).
