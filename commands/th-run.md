---
description: Start or resume a TwinHarness Agentic SDLC run — drive an idea through tier-scaled stages to slice-by-slice build.
argument-hint: <your idea, e.g. "build a CLI todo app">
allowed-tools: Bash(node:*), mcp__plugin_twinharness_th__*, Task, Agent
---

Start (or resume) a **TwinHarness** orchestration run for: **$ARGUMENTS**

> **Running `th`:** the CLI ships inside this plugin. Wherever instructions say `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`. The Orchestrator should prefer the typed
> `mcp__plugin_twinharness_th__*` MCP tools and fall back to
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` only for verbs not yet exposed as MCP tools (see
> `reference/mcp-tools.md`).

Existing run state, if any (captured before this prompt runs — use it to decide **resume vs. fresh
init**; an error or "not initialized" here means no run exists yet, so start from `th init`):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" state status`

Follow the `twinharness` skill (the Orchestrator playbook). In brief:

1. If `.twinharness/state.json` exists, run `th state status` and **resume** from `current_stage`.
   Otherwise run `th init`.
2. Classify the tier and blast radius (spec §5). Record it with `th state set` — never hand-edit state.
3. Run the engaged stages for the tier, delegating each artifact to the **Spec agent** (by mode),
   verifying coherence with the **Critic**, and surfacing only the §8 human gates via AskUserQuestion.
4. Keep `state.json` authoritative via the `th` CLI; the Stop-gate hook enforces a valid state before
   any "stage complete" claim.

If the brief is a vague mega-request, **narrow it with targeted questions first** — do not generate a
thin, useless spec (§5, §14.1).
