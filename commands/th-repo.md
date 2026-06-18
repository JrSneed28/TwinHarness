---
description: Build, check, and query the TwinHarness repo map — scan the repo structure (map), check freshness (check), find precision context for a slice/req/file (relevant), or estimate edit blast radius (impact).
argument-hint: map [--format <summary|json|md>] | check | relevant --slice <ID> | impact --file <path>
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Scan, check, and query the TwinHarness repo map for this project.

Live repo map freshness (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" repo check || true`

**Preferred path — typed MCP tools:**

```
mcp__plugin_twinharness_th__th_repo_map      {}
mcp__plugin_twinharness_th__th_repo_check    {}
mcp__plugin_twinharness_th__th_repo_relevant { "slice": "<SLICE-ID>" }
mcp__plugin_twinharness_th__th_repo_impact   { "file": "<path>" }
```

**CLI fallback:**

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" repo map [--write|--no-write] [--format <summary|json|md>]
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" repo check
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" repo relevant (--slice <ID> | --req <REQ-ID> | --file <path> | --query <kw>) [--maxResults <n>] [--format <slice|req|file|json>]
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" repo impact (--file <path> | --component <name|path>) [--format <file|json>]
```

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `map` | Scan the repo; write `.twinharness/repo-map.json` + `docs/00-repo-map.md` (writes by default; use `--no-write` for dry preview) |
| `check` | Report whether `.twinharness/repo-map.json` is fresh vs the working tree (exit 0 fresh / 4 stale / 5 no-map / 1 parse-fail) |
| `relevant` | Precision context: read-first/related/tests/risks for a selector (reads persisted map; requires exactly one of `--slice`, `--req`, `--file`, `--query`) |
| `impact` | Pre-edit blast-radius: impacted components, tests, features, risk flags (reads persisted map; requires exactly one of `--file`, `--component`) |

`repo check` is a lightweight freshness probe — the Orchestrator calls it before any repo-aware
operation to verify the map is not stale. `repo map` re-scans and persists when stale.

## Map → check → use pattern

```
# 1. Build or refresh the map (once per session or after significant edits):
th repo map

# 2. Confirm fresh before high-context operations:
th repo check      # exits 0 = fresh, 4 = stale

# 3. Precision context for a slice:
th repo relevant --slice SLICE-007

# 4. Blast-radius before editing a file:
th repo impact --file src/core/routing.ts
```

## Flags

| Flag | Description |
|------|-------------|
| `--write` | *(map)* Write artifacts (default when running bare `th repo map`) |
| `--no-write` | *(map)* Dry/preview: build in memory, write nothing |
| `--format <f>` | *(map)* Text rendering: `summary` (default) \| `json` \| `md`; *(relevant)* `slice` \| `req` \| `file` \| `json` |
| `--slice <ID>` | *(relevant)* Selector: slice ID |
| `--req <REQ-ID>` | *(relevant)* Selector: requirement ID |
| `--file <path>` | *(relevant / impact)* Selector: file path |
| `--query <kw>` | *(relevant)* Selector: keyword/phrase |
| `--maxResults <n>` | *(relevant)* Cap on combined emitted items (default 20; ≤ 0 = default) |
| `--component <n>` | *(impact)* Selector: component name or path |
| `--json` | Emit machine-readable JSON on stdout |
| `--cwd <dir>` | Operate against `<dir>` instead of the current directory |
