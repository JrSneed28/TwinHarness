---
description: Scaffold a new TwinHarness run — creates docs/, .twinharness/state.json, and drift-log.md; idempotent via MCP (returns already_initialized rather than clobbering an existing run).
argument-hint: [--brownfield]
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Initialize TwinHarness in the current project directory.

Live state check (captured before this prompt runs — "not initialized" is the normal signal to proceed):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" state status || true`

**Preferred path — MCP tool (idempotent; never clobbers existing state):**

```
mcp__plugin_twinharness_th__th_init  {}
mcp__plugin_twinharness_th__th_init  { "brownfield": true }
```

Returns `already_initialized` when a run already exists — **do not re-init over a live project**.
`th_init` never accepts a `force` parameter; destructive re-init stays CLI/human-only.

**CLI fallback:**

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" init [--brownfield]
```

> **`--force` is CLI/human-only.** Destructive re-init (wipes `state.json`) is never exposed over
> MCP. Use it only from a terminal when you intentionally want to reset a project.

## Flags

| Flag | Description |
|------|-------------|
| `--brownfield` | Scaffold a brownfield run (`project_mode=brownfield`; adopting an existing codebase) |
| `--force` | *(CLI only — never MCP)* Reset existing `state.json`; wipes all state |
| `--json` | Emit machine-readable JSON on stdout |
| `--cwd <dir>` | Operate against `<dir>` instead of the current directory |

After init, run `/twinharness:th-run <idea>` (or call `mcp__plugin_twinharness_th__th_state_get`)
to begin the SDLC flow.
