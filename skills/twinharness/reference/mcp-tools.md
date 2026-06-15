# TwinHarness MCP Tooling Guideline (part of the TwinHarness orchestrator playbook)

**Purpose.** TwinHarness ships a long-lived MCP server (`th`) that exposes the
coordination / observability / state handlers as **typed** tools named
`mcp__plugin_twinharness_th__*`. This file is the single source every agent
points to for *how* to call `th` — so the routing rule lives in one place
instead of being re-enumerated per agent.

## The canonical rule

**Prefer the typed `mcp__plugin_twinharness_th__*` MCP tools** for every
coordination, observability, and state operation. Fall back to shelling

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>
```

(i.e. `th <args>`) **only** for verbs that are *not* exposed as MCP tools —
e.g. scaffolding (`th init`/`th migrate`), the hook gates
(`th hook stop-gate`/`th hook pretool-gate`), `th anchors scan`,
`th trace render`, `th verify run`, `th slices sync`, `th slice set-status`,
`th artifact register`, `th tier classify`/`veto-check`, `th revise *`,
`th stale`, `th doctor`, etc. When a verb exists as both, the MCP tool wins.

## A returned error result is NOT a broken tool (critical)

When an MCP tool **returns** a structured error — `not_initialized` (no
`state.json` yet), `map_missing` (no repo-map built yet), `slice_not_found`,
etc. — **the tool worked.** It reported a *fact about the project*, exactly as
the equivalent CLI command would (the CLI prints the same message and exits
non-zero). The MCP result carries `isError: true` only because the underlying
command exited non-zero — that is a **domain outcome to act on, not a sign the
MCP server is broken.** Keep using the MCP tools.

The ONLY two reasons to shell the CLI instead of an MCP tool are:

1. **No MCP tool for the verb** — `init`, `migrate`, the `hook` gates,
   `anchors scan`, `trace render`, `verify run`, `tier classify`/`veto-check`,
   `revise *`, `slices sync`, `slice set-status`, `artifact register`, `stale`,
   `doctor`, `coverage report` (the fallback list above).
2. **The server is genuinely unreachable** — the `mcp__plugin_twinharness_th__*`
   tools are not advertised at all, or a call fails at the **transport** level
   (a connection/protocol error), *not* with a domain `isError` result.

A `not_initialized` from `th_state_get` / `th_next` is neither: stay on the MCP
tools. (When there is no run yet, the next mechanical step is `th init` — which
has no MCP tool, so that ONE call is a legitimate CLI use under reason 1; then
resume the MCP tools.)

## Why MCP is preferred

- **Typed, structured results instead of parsing stdout.** Each tool returns a
  human-readable text block *and* a `structuredContent` payload (the handler's
  `data`). No `--json` flag, no fragile stdout munging.
- **Worktree-safe project-root resolution.** The tools auto-resolve
  `${CLAUDE_PROJECT_DIR}` to the stable project root, so a call works
  **unchanged from inside a git worktree** — no `--cwd <main-root>` juggling.
  This is exactly what the parallel-build coordination plane needs (see
  `reference/build-and-verify.md` §21): one shared `.twinharness/`, reached the
  same way from every worktree.
- **One warm process, not a cold spawn per call.** The server is a single
  long-lived process; each MCP call reuses it instead of paying a fresh
  `node dist/cli.js` startup per invocation.

## This tool set GROWS — discover it dynamically

> **Use whatever `mcp__plugin_twinharness_th__*` tools are currently advertised
> by the server; never rely on a hard-coded count or list.** The table below is
> a **NON-EXHAUSTIVE snapshot** of the tools currently available — new tools are
> added over time and appear automatically in the advertised tool set. If a
> coordination/observability/state verb you need is not in the table, check the
> live advertised tools before falling back to the CLI.

## Naming rule

Plugin-bundled MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`.
Here `plugin = twinharness`, `server = th`, so e.g. the next-action oracle is
`mcp__plugin_twinharness_th__th_next`.

## Non-exhaustive snapshot (current tools)

Each row maps the MCP tool → its equivalent `th` CLI subcommand → one-line
purpose. Snapshot only — the live advertised set is authoritative.

### State

| MCP tool | `th` CLI | Purpose |
|---|---|---|
| `mcp__plugin_twinharness_th__th_state_get` | `th state get [path]` | Read state.json, or a single dotted-path value. Read-only. |
| `mcp__plugin_twinharness_th__th_state_set` | `th state set <key> <value>` | Patch one dotted key in state.json (refuses unknown/managed fields and invalidating writes). |

### Coordination

| MCP tool | `th` CLI | Purpose |
|---|---|---|
| `mcp__plugin_twinharness_th__th_drift_add` | `th drift add --layer <derived\|requirement> …` | Append a §10 drift entry; `requirement` is BLOCKING, `derived` auto-applies. |
| `mcp__plugin_twinharness_th__th_build_claim` | `th build claim <SLICE-ID>` | Take a component lease on a slice before spawning its Builder (collision guard). |
| `mcp__plugin_twinharness_th__th_build_release` | `th build release <SLICE-ID>` | Release a slice's component lease after it finishes or blocks. |
| `mcp__plugin_twinharness_th__th_build_sub_claim` | `th build sub-claim <PARENT> <components>` | Open a sub-lease on a subset of a parent slice's components for a scoped sub-Builder. |
| `mcp__plugin_twinharness_th__th_build_sub_release` | `th build sub-release <SUB-ID>` | Release a sub-lease after the sub-Builder finishes or blocks. |

### Observability

| MCP tool | `th` CLI | Purpose |
|---|---|---|
| `mcp__plugin_twinharness_th__th_build_next_wave` | `th build next-wave` | Live wave oracle: slices dispatchable in parallel right now; reports holds/cycles/stalls. Read-only. |
| `mcp__plugin_twinharness_th__th_coverage_check` | `th coverage check` | Hard gate: every MVP REQ-ID maps to ≥1 slice and ≥1 test; lists gaps. Read-only. |
| `mcp__plugin_twinharness_th__th_next` | `th next` | Next-action oracle: the single highest-priority mechanical obligation owed next. Read-only. |
| `mcp__plugin_twinharness_th__th_repo_check` | `th repo check` | Whether the persisted repo-map is stale vs. the working tree. Read-only. |

### Repo-understanding

| MCP tool | `th` CLI | Purpose |
|---|---|---|
| `mcp__plugin_twinharness_th__th_repo_map` | `th repo map` | Scan the project and build the dual repo-map artifacts (writes by default; `write:false` for a dry run). |
| `mcp__plugin_twinharness_th__th_repo_relevant` | `th repo relevant --slice\|--req\|--file\|--query` | Files most relevant to a selector (slice / REQ-ID / file / free text). Read-only. |
| `mcp__plugin_twinharness_th__th_repo_impact` | `th repo impact --file\|--component` | Blast-radius impact of changing a file or component. Read-only. |
| `mcp__plugin_twinharness_th__th_context_pack` | `th context pack [--slice]` | Assemble the §9 handoff bundle (approved-artifact Summary blocks + slice/overlap framing). Read-only. |

### Delegation

| MCP tool | `th` CLI | Purpose |
|---|---|---|
| `mcp__plugin_twinharness_th__th_delegate_plan` | `th delegate plan --intent …` | Context-preservation oracle: delegate vs. keep-main, with a suggested agent. Advisory. |
| `mcp__plugin_twinharness_th__th_delegate_pack` | `th delegate pack --agent …` | Assemble a bounded child-agent handoff (envelope + Delegation Capsule format). Read-only. |
| `mcp__plugin_twinharness_th__th_delegate_check` | `th delegate check --text\|--path` | Validate a returned Delegation Capsule's required sections (presence only). Read-only. |

### Decision

| MCP tool | `th` CLI | Purpose |
|---|---|---|
| `mcp__plugin_twinharness_th__th_route` | `th route --agent <a> --mode <m>` | Advisory §2 model+effort routing for an agent spawn. Read-only; you apply the override. |
| `mcp__plugin_twinharness_th__th_decision_detect` | `th decision detect` | Surface advisory DecisionCandidate[] from on-disk sources. Read-only; never writes. |
| `mcp__plugin_twinharness_th__th_decision_add` | `th decision add --title … --rationale …` | Record one `proposed` decision (mints id + audit trail; never auto-approves). |
| `mcp__plugin_twinharness_th__th_decision_check` | `th decision check` | Fail when any unapproved decision gates the current stage (RULE-007). |
| `mcp__plugin_twinharness_th__th_decision_list` | `th decision list` | Return the reduced decision set, sorted by id. Read-only. |

> See `${CLAUDE_PLUGIN_ROOT}/spec/` and the per-tool descriptions advertised by
> the server (REQ-RU-044 … REQ-RU-052, REQ-408, etc.) for the authoritative
> behavior of each handler.
