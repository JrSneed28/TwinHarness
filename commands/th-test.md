---
description: Invoke the TwinHarness broad-QA tester agent — launches and drives the real built project end-to-end to verify behavior; the tester selects a driver per project type (CLI/service → stdio, web → claude-in-chrome, tmux optional).
argument-hint: (no arguments — pass a brief goal or focus area as $ARGUMENTS)
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Invoke the TwinHarness broad-QA tester agent for this project: **$ARGUMENTS**

Live state snapshot (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" state status || true`

This command is the human entry point to the **`tester` agent** (`agents/tester.md`). It triggers
on-demand broad-QA against the real built project — not a fixed SDLC stage, but an any-time
quality probe. Pass a brief focus area as `$ARGUMENTS` (e.g. "smoke test the CLI help output",
"verify coverage check gates on a missing REQ") or leave it empty for a full broad-QA pass.

## What the tester does

The tester agent:

1. **Reads `th state status`** and `th route --agent tester` to pick the appropriate model
   (sonnet at T0 → opus at T3; same tier ladder as the builder).
2. **Selects a driver** per project type:
   - **CLI / service** — direct process spawn / stdio capture via Bash
   - **Web app** — `claude-in-chrome` MCP tools (`mcp__claude-in-chrome__*`)
   - **tmux** — optional; used when the process needs a persistent session but not required
3. **Drives the real built project** (`dist/cli.js`, compiled binary, or dev server) — zero mocks,
   zero simulation.
4. **Records findings** to the drift log (`th drift add`) and/or the blackboard
   (`mcp__plugin_twinharness_th__th_collab_fragment`) so they are visible to the Orchestrator.

The tester agent does **not** spawn sub-agents (`Agent` is disallowed in its frontmatter).

## When to use this command

- After a Builder finishes a slice, to verify real behavior before the Critic review.
- At any point to smoke-test the built project (regression probe).
- When `th verify run` passes mechanically but you want a higher-fidelity behavioral check.
- When the Orchestrator surfaces a QA gap during any stage.

## Tester routing

The tester inherits the builder's tier ladder — computed by `th route --agent tester`:

| Tier | Model | Effort |
|------|-------|--------|
| T0 | sonnet | high |
| T1 | opus | medium |
| T2 | opus | high |
| T3 | opus | xhigh |
| component-blast | opus | (at least high) |

## Findings flow

Tester findings go to:
- `mcp__plugin_twinharness_th__th_drift_add` — if a finding contradicts a requirement or scope decision (BLOCKING)
- `mcp__plugin_twinharness_th__th_collab_fragment` — for non-blocking observations on the blackboard

Findings are never auto-resolved by the tester; the Orchestrator or human acts on them via
`/twinharness:th-drift` or `/twinharness:th-escalate`.

## Notes

- The tester requires the project to be **built** (`dist/cli.js` or equivalent) before invoking.
- For web projects, ensure `claude-in-chrome` MCP is available and the dev server is running.
- This is an on-demand agent, not a fixed pipeline stage — it can be invoked at any time.
