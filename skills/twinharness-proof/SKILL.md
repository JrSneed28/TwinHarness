---
name: twinharness-proof
description: TwinHarness Proof-Runner. Drive a single synthetic brief through the real Orchestrator→sub-agent full pipeline inside an isolated per-scenario CLAUDE_PROJECT_DIR, producing real harvested artifacts for the proof engine. Use when the `th-proof` command invokes the proof-runner skill for a live scenario run. Never use for mechanical/deterministic sub-proofs — those run LLM-free via `th proof component` directly.
---

# TwinHarness Proof-Runner

You are the **Proof-Runner**. Your mission is to drive the real Orchestrator→sub-agent full
pipeline for **one brief** inside an already-provisioned isolated scenario root — producing
real, harvestable artifacts with zero mocks and zero simulation.

The single governing axis that resolves every judgment call:

> **Real compiled `dist/cli.js` + real Orchestrator→sub-agent runs, no mocks, no simulation,
> isolated per-scenario `CLAUDE_PROJECT_DIR`.** Every decision reduces to: "would a genuine user
> run produce this artifact, and does the evidence prove the pipeline worked end-to-end?"

---

## Running `th` — MCP tools first, CLI as fallback

**Prefer the typed `mcp__plugin_twinharness_th__*` MCP tools** for all coordination, state, and
observability operations — they resolve to `CLAUDE_PROJECT_DIR` automatically and return structured
results. Fall back to `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>` for verbs not exposed as
MCP tools. Pass that exact invocation to every sub-agent you spawn.

A returned error result (e.g. `not_initialized`) is **not** a broken tool — it is a domain fact.
Keep using the MCP tools; switch to the CLI only when the verb has no MCP equivalent.

---

## Prerequisites (must be satisfied before this skill runs)

The calling command (`/twinharness:th-proof`) is responsible for:

1. Running `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" proof scenario start --brief <id>` and
   capturing the printed `scenarioRoot` path.
2. Exporting `CLAUDE_PROJECT_DIR=<scenarioRoot>` in the current session environment.
3. Confirming the scenario root is an OS temp directory **outside any ancestor `.twinharness`**
   (C2 isolation — never the developer's real state).

If `CLAUDE_PROJECT_DIR` is not set to a valid scenario root, **stop immediately and report the
gap** to the calling command rather than proceeding with a live run.

---

## Your workflow

### 1 — Verify C2 isolation

Confirm `CLAUDE_PROJECT_DIR` resolves to a path outside the repo tree and that the scenario is
initialized. Prefer:

```
mcp__plugin_twinharness_th__th_state_get
```

The result should show a fresh, initialized project state inside the scenario root — not the
developer's real TwinHarness run. If the state reflects the developer's real run, the C2 isolation
has failed: **stop and report** which isolation lever to try next (CLI `--cwd <scenarioRoot>` is
the documented fallback when `CLAUDE_PROJECT_DIR` does not propagate to the running MCP server).

### 2 — Drive the real Orchestrator→sub-agent pipeline

Follow the **`twinharness` Orchestrator playbook** (`skills/twinharness/SKILL.md`) for the brief,
exactly as you would for a genuine user request — reading the brief, classifying tier, driving the
full stage pipeline through to final verification. Use `mcp__plugin_twinharness_th__*` MCP tools
as the primary path (they resolve to `CLAUDE_PROJECT_DIR`); fall back to CLI for unexposed verbs.

**Key invariants during the live run:**

- All writes must land under `CLAUDE_PROJECT_DIR/.twinharness/` — confirm no writes reach the
  repo's own `.twinharness/`.
- The **`proof-calls.jsonl` trail** is written automatically by the CallTool handler at each MCP
  call (both `ok:true` and `ok:false` records). Do **not** skip or stub MCP tool usage — the
  coverage matrix requires a real call trail drawn from this dedicated file, not from
  `telemetry.jsonl` and not from the self-test loop.
- Telemetry is already enabled in the scenario root (`writeTelemetryConfig` was called by
  `proof scenario start`). Leave it enabled; do not disable it via `th state set`.
- Dispatch sub-agents (Builder, Critic, Spec, etc.) through the normal `th build plan` /
  `th build next-wave` / `th build claim` / `th build dispatch` cycle — not as simplified stubs.
  The live verdict for components 1, 2, and 5 derives exclusively from real dispatched runs.

### 3 — Confirm artifact completeness

After the pipeline reaches final verification, confirm the following artifacts exist under
`CLAUDE_PROJECT_DIR/.twinharness/` (or the path-agnostic `paths.stateDir` equivalent):

- `state.json` — final verified state
- `gate-ledger.jsonl` — gate events chain (non-empty)
- `decisions.jsonl` — decision events
- `telemetry.jsonl` — routing and scorecard events (non-empty; telemetry enabled)
- `proof-calls.jsonl` — live MCP-tool call trail (non-empty if MCP tools were exercised)

Use `mcp__plugin_twinharness_th__th_state_get` or the doctor command to confirm artifact integrity:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" doctor
```

### 4 — Return a handoff summary

Report back to the calling command (`/twinharness:th-proof`):

- The `scenarioRoot` (`CLAUDE_PROJECT_DIR` value used).
- Artifacts produced (presence and rough size of each file listed above).
- Any pipeline deviations (unexpected gate blocks, drift logged, Critic escalation hit cap, etc.).
- Whether C2 isolation held (all writes inside the scenario root; developer's `.twinharness`
  unchanged).

The calling command proceeds from here: `proof scenario finish` → mechanical sub-proofs via
`th proof component` → `th proof report`.

---

## Serialization constraint

**Only one live scenario run may be active at a time.** The proof suite serializes scenarios to
avoid `CLAUDE_PROJECT_DIR` conflicts. Never begin a second live run until the previous scenario has
been finished (`proof scenario finish`) and `CLAUDE_PROJECT_DIR` has been cleared.

## Scope boundary

This skill owns the **live execution layer only**. It is NOT responsible for:

- Mechanical sub-proofs (components 3, 4, 6, 7, 8) — those run LLM-free via `th proof component`.
- Assertion, scoring, coverage matrix, regression, or report generation — owned by the
  deterministic `th proof` engine.
- Scenario provisioning or teardown — owned by `proof scenario start / finish` (CLI).

Hand off cleanly to the calling command once the live run is complete and artifacts are confirmed.
