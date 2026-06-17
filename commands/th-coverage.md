---
description: Verify or report TwinHarness REQ-ID coverage — check gates that every MVP REQ maps to ≥1 slice and ≥1 test (hard gate), or report planned/implemented/tested/passing breakdown per REQ-ID.
argument-hint: check | report [--reqs <file>] [--plan <file>] [--tests <dir>] [--scope <file>]
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*
---

Check or report TwinHarness REQ-ID coverage for this project.

Live state snapshot (captured before this prompt runs):

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" state status || true`

**Preferred path — typed MCP tools:**

```
mcp__plugin_twinharness_th__th_coverage_check   {}
mcp__plugin_twinharness_th__th_coverage_report  {}
```

Pass optional overrides as properties (e.g. `{ "reqs": "docs/01-requirements.md" }`).

**CLI fallback:**

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" coverage check [--reqs F] [--plan F] [--tests D] [--scope F]
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" coverage report [--reqs F] [--plan F] [--tests D] [--scope F] [--code D]
```

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `check` | **Hard gate** — verifies every MVP REQ-ID maps to ≥ 1 slice in the plan and ≥ 1 test file; exits non-zero on failure |
| `report` | **Status view** — planned / implemented / tested / passing breakdown per REQ-ID (read-only, no gate) |

`coverage check` is the mechanical coverage gate the Orchestrator runs before stage advancement.
`coverage report` is the detailed diagnostic when the gate is red.

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--reqs <file>` | `docs/01-requirements.md` | Requirements file to scan for REQ-IDs |
| `--plan <file>` | `docs/09-implementation-plan.md` | Implementation plan file (slice → REQ mapping) |
| `--tests <dir>` | `tests` | Tests directory to scan for REQ anchors |
| `--scope <file>` | `docs/02-scope.md` | Scope file for MVP filtering |
| `--code <dir>` | `src` | *(report only)* Source directory scanned for implemented anchors |
| `--json` | — | Emit machine-readable JSON on stdout |
| `--cwd <dir>` | — | Operate against `<dir>` instead of the current directory |

All file/directory flags have sensible defaults — bare `th coverage check` works on any
TwinHarness-initialized project without additional flags.
