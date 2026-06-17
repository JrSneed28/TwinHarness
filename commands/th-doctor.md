---
description: Run the TwinHarness self-diagnostic — audits env, state validity, artifact hashes, coverage wiring, slice statuses, and revise-loop health in a single pass.
argument-hint: (no arguments)
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Run the TwinHarness self-diagnostic for this project.

Live state snapshot (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" state status || true`

Invoke the doctor:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" doctor
```

Or with machine-readable output:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" doctor --json
```

`th doctor` is not yet exposed as a typed MCP tool — use the CLI. Prefer
`mcp__plugin_twinharness_th__th_state_get` to read individual state fields before or after running
the doctor (see `reference/mcp-tools.md`).

## What is checked

`th doctor` runs a full run-health audit across six dimensions:

| Dimension | What is checked |
|-----------|----------------|
| **env** | Plugin root, `dist/cli.js` present and executable, Node.js version |
| **state** | `state.json` present, schema-valid, no unknown fields |
| **artifacts** | Registered artifacts have matching content-hash (no silent edits) |
| **coverage** | Every MVP REQ-ID maps to ≥ 1 slice and ≥ 1 test |
| **slices** | No slices stuck in `in-progress` past their expected window |
| **revise loops** | No stage revise-loop count at or above cap (default 3) |

Exit code 0 means all checks pass. Non-zero means at least one dimension failed; the output
identifies which.

## Flags

| Flag | Description |
|------|-------------|
| `--json` | Emit machine-readable JSON on stdout |
| `--cwd <dir>` | Operate against `<dir>` instead of the current directory |

> **Note:** `--strict` is NOT a `th doctor` flag — it belongs to `th anchors scan`.
> `th doctor` takes no command-specific flags; only the global `--json` / `--cwd` apply.

If the doctor reports issues, use `/twinharness:th-escalate` to surface the blocking ones for
human decision, or `/twinharness:th-next` to find the highest-priority mechanical obligation.
