---
description: Approve, reject, or supersede a recorded TwinHarness decision — interactive TTY gate that transitions a proposed decision to approved/rejected or marks an approved one superseded; intentionally HUMAN-ONLY and never an MCP tool.
argument-hint: approve <DECISION-ID> [--reject | --supersede <id>] [--as <actor>]
allowed-tools: Bash(node:*), Bash(true)
---

Approve, reject, or supersede a TwinHarness decision for this project.

Live decision list (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" decision list || true`

> ⚠️ **HUMAN-ONLY — This verb is intentionally NOT an MCP tool.**
> `th decision approve` requires an interactive TTY and is gated to human approval only.
> It must never be invoked over MCP or called autonomously by an agent. The Orchestrator surfaces
> a blocking decision via `AskUserQuestion`; the human then runs this CLI command directly.

**CLI (human terminal only):**

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" decision approve <DECISION-ID>
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" decision approve <DECISION-ID> --reject
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" decision approve <DECISION-ID> --supersede <OTHER-ID>
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" decision approve <DECISION-ID> --as "Tech Lead"
```

## Transitions

| Command | Transition |
|---------|-----------|
| `approve <ID>` | `proposed` → `approved`; clears the blocking obligation on the current stage |
| `approve <ID> --reject` | `proposed` → `rejected` |
| `approve <ID> --supersede <id2>` | `approved` → `superseded by <id2>` |

`--reject` and `--supersede` are mutually exclusive.

## Related read-only commands (safe over MCP)

Use these typed MCP tools for non-mutating decision operations:

```
mcp__plugin_twinharness_th__th_decision_detect  {}   # surface advisory decision candidates
mcp__plugin_twinharness_th__th_decision_add     { "title": "...", "rationale": "..." }
mcp__plugin_twinharness_th__th_decision_check   {}   # exit 6 when an unapproved decision gates the stage
mcp__plugin_twinharness_th__th_decision_list    {}   # list decisions with status
```

## Flags

| Flag | Description |
|------|-------------|
| `--reject` | Append a rejected event instead of approved (mutually exclusive with `--supersede`) |
| `--supersede <id>` | Mark this approved decision superseded by `<id>` (mutually exclusive with `--reject`) |
| `--as <actor>` | Approver attribution — attribution only, NOT a security barrier (default: `TH_APPROVAL_ACTOR` env var or `"human"`) |
| `--json` | Emit machine-readable JSON on stdout |
| `--cwd <dir>` | Operate against `<dir>` instead of the current directory |

After approving, run `/twinharness:th-next` to see what obligation the run owes next.
