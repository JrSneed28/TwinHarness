---
description: Print the next mechanical obligation this TwinHarness run owes — the highest-priority owed action across gates, drift, decisions, and stage progression (oracle; never mutates state).
argument-hint: [--explain]
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Show the next mechanical obligation for this TwinHarness run.

Live next-action (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" next || true`

**Preferred path — typed MCP tool:**

```
mcp__plugin_twinharness_th__th_next  {}
```

**CLI fallback (with WHY explanation):**

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" next --explain
```

`th next` is a pure read-only oracle — it computes and prints, never mutates `state.json`. The
Orchestrator uses its output to decide what to drive next without risking a state desync.

## Priority order

`th next` checks these blocking conditions in order and emits the first one that applies:

1. **State invalid** — `state.json` fails schema validation; run `th state verify` first.
2. **Open blocking drift** — `drift_open_blocking > 0`; a requirement/scope contradiction is
   awaiting a human decision (see `/twinharness:th-drift`).
3. **Open blocking debate** — an unresolved BLOCKING debate gates the current stage.
4. **Unapproved decision** — `th decision check` exits 6; an open decision blocks stage advancement.
5. **Revise-loop at cap** — a stage's revise count hit the cap (default 3) with issues still open;
   human escalation required (see `/twinharness:th-escalate`).
6. **Stage advancement** — the next stage in the pipeline the run should enter or complete.

## Flags

| Flag | Description |
|------|-------------|
| `--explain` | Add a WHY string: the reason this obligation is the highest-priority one |
| `--json` | Emit machine-readable JSON on stdout |
| `--cwd <dir>` | Operate against `<dir>` instead of the current directory |

If `th next` is blocked on a human gate, surface it with `/twinharness:th-escalate`. If the
project is not initialized, `th next` reports "not initialized" — run `/twinharness:th-init` first.
