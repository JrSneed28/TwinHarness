---
description: Manage and run the TwinHarness project verify list — add test/check commands, list them, clear the list, or run all of them with a consolidated pass/fail report.
argument-hint: run | add "<command>" | list | clear
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Manage or run the TwinHarness verify command list for this project.

Live verify list (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" verify list || true`

**Preferred path — typed MCP tools** (where exposed):

```
mcp__plugin_twinharness_th__th_verify_run   {}
mcp__plugin_twinharness_th__th_verify_add   { "command": "<shell command>" }
mcp__plugin_twinharness_th__th_verify_list  {}
mcp__plugin_twinharness_th__th_verify_clear {}
```

**CLI fallback:**

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" verify run
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" verify add "<command>"
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" verify list
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" verify clear
```

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `run` | Run every configured verify command in sequence; writes a report; exits 1 on any failure |
| `add "<command>"` | Append a project test/check command to the persisted verify list |
| `list` | Show all configured verify commands |
| `clear` | Remove all configured verify commands |

## Usage pattern

The verify list is the Orchestrator's mechanical test harness for the build phase. Each `add`
appends a shell command (e.g. `npm test`, `npx vitest run`, `cargo test`) that `verify run`
will execute. The Orchestrator calls `verify run` after each slice implementation; exit code 0
confirms the slice is clean.

```
# Typical setup (once per project):
th verify add "npm test"
th verify add "npx tsc --noEmit"

# After each Builder slice:
th verify run   # exits 1 + writes report if any command fails
```

`verify run` writes a report to `.twinharness/verify-report.json` (or stdout with `--json`).

## Flags

| Flag | Description |
|------|-------------|
| `--json` | Emit machine-readable JSON on stdout |
| `--cwd <dir>` | Operate against `<dir>` instead of the current directory |
