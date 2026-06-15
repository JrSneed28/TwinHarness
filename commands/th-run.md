---
description: Start or resume a TwinHarness Agentic SDLC run — drive an idea through tier-scaled stages to slice-by-slice build.
argument-hint: <your idea, e.g. "build a CLI todo app">
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*, Task, Agent
---

Start (or resume) a **TwinHarness** orchestration run for: **$ARGUMENTS**

> **Running `th`:** the CLI ships inside this plugin. Wherever instructions say `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`. The Orchestrator should prefer the typed
> `mcp__plugin_twinharness_th__*` MCP tools and fall back to
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` only for verbs not yet exposed as MCP tools (see
> `reference/mcp-tools.md`). A tool that **returns** an error result (e.g. `not_initialized`) is
> working — act on it and keep using the MCP tools; do not switch to the CLI just because a call
> reported "no run yet."

Existing run state, if any (captured before this prompt runs). **"No state.json" / "not initialized"
here is normal for a new project — it is the signal to START a run, not an error to report to the
user.** Use it to decide **resume vs. fresh init**:

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" state status || true`

Follow the `twinharness` skill (the Orchestrator playbook). In brief:

1. **No run yet** (`.twinharness/state.json` absent / the snapshot says "not initialized") → run
   `th init` **yourself** (`th init --brownfield` when building into an existing repo) and drive the
   entire flow below. **Never stop to tell the user to initialize — just do it.** If a run already
   exists, run `th state status` and **resume** from `current_stage`.
2. Classify the tier and blast radius (spec §5). Record it with `th state set` — never hand-edit state.
3. Run the engaged stages for the tier, delegating each artifact to the **Spec agent** (by mode),
   verifying coherence with the **Critic**, and surfacing only the §8 human gates via AskUserQuestion.
4. Keep `state.json` authoritative via the `th` CLI; the Stop-gate hook enforces a valid state before
   any "stage complete" claim.

If the brief is a vague mega-request, **narrow it with targeted questions first** — do not generate a
thin, useless spec (§5, §14.1).
