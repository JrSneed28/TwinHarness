---
description: Compute the advisory model and effort level for an agent spawn — pure lookup against the routing table; the Orchestrator applies the result, never the tool itself.
argument-hint: [--agent <A>] [--mode <M>] [--tier <T>] [--component-blast] [--summarization]
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Compute the advisory model and effort for an agent spawn in this project.

Live state snapshot (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" state status || true`

**Preferred path — typed MCP tool:**

```
mcp__plugin_twinharness_th__th_route  {}
mcp__plugin_twinharness_th__th_route  { "agent": "builder", "tier": "T2" }
mcp__plugin_twinharness_th__th_route  { "agent": "spec", "mode": "architecture" }
mcp__plugin_twinharness_th__th_route  { "agent": "builder", "componentBlast": true }
```

**CLI fallback:**

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" route [--agent A] [--mode M] [--tier T] [--component-blast] [--summarization]
```

`th route` is a pure read-only computation — it never mutates state. The Orchestrator reads
the result and applies it when spawning an agent; it does not call `th_state_set` based on
route output.

## Routing table (summary)

| Agent | Mode / Condition | Model | Effort |
|-------|-----------------|-------|--------|
| `spec` | design mode (architecture, ui-design, ux-design, adrs, contracts, security, failure-modes, technical-design) | opus | high (xhigh on T3+blast) |
| `spec` | other modes | sonnet | medium / high on T3 |
| `builder` / `tester` | T0 | sonnet | high |
| `builder` / `tester` | T1 | opus | medium |
| `builder` / `tester` | T2 | opus | high |
| `builder` / `tester` | T3 | opus | xhigh |
| `critic` | any mode | sonnet | medium |
| any | `--component-blast` | opus | (at least high) |
| any | `--summarization` | haiku | low |

## Flags

| Flag | Description |
|------|-------------|
| `--agent <A>` | Agent role being spawned (e.g. `builder`, `spec`, `critic`, `tester`, `orchestrator`) |
| `--mode <M>` | Critic/spec mode (e.g. `architecture`, `ux-design`, `ui-design`, `security`, `adrs`) |
| `--tier <T>` | Project tier override (`T0`–`T3`; defaults to `state.tier`) |
| `--component-blast` | Signal that this spawn covers multiple components (raises effort) |
| `--summarization` | Signal that this is a summarization task (routes to haiku/low) |
| `--json` | Emit machine-readable JSON on stdout |
| `--cwd <dir>` | Operate against `<dir>` instead of the current directory |
