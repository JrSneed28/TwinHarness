# SLICE-1 / TASK-002 — CLI argument surface + task ingestion + exit code

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-001, REQ-020, REQ-NFR-006
**Slice:** SLICE-1 — Task entry, config resolution & working-root boundary
**Depends on:** SLICE-0 / TASK-001 complete (the `cli`→`agent-run` wiring exists)

---

## Goal

Implement the `cli` argument surface: accept a coding task (positional, `--task`/`-t`, stdin, or
`--task-file`), parse all flags, route `run` vs `allowlist` subcommands, emit `--help` (exit 0)
listing every flag, set the process exit code from the final `RunOutcome` (0 iff succeeded), and emit
a usage hint with a non-zero exit on unknown flags / missing required args.

---

## REQ-IDs

- **REQ-001** — The CLI accepts a coding task as a natural-language string (positional argument
  and/or `--task`/`-t` flag, with stdin/file fallback) and starts an agent run against a target
  repository.
- **REQ-020** — The CLI exits with a process exit code reflecting outcome (0 = task succeeded;
  non-zero = stopped/failed), so it is usable in scripts.
- **REQ-NFR-006** — *Usability:* output is readable; a `--help` documents all flags; misconfiguration
  fails fast with an actionable message.

---

## Relevant Contracts / Interfaces

```
IF-014 — CLI argument surface
autocoder [task] [flags]                              — primary run mode
autocoder allowlist <list|add|remove> [pattern]      — allowlist subcommand (no agent loop; SLICE-9)

Positional:
  task               string [optional] — the Task; if omitted, read from --task / stdin / --task-file
Flags:
  --task <str> / -t  string  [optional] — the Task as a flag
  --task-file <path> string  [optional] — read the Task from a file
  --cwd / --root <p> string  [optional, default: process cwd] — the WorkingRoot
  --model <id>       string  [optional, default: current Claude model]
  --yes / --auto     boolean [optional, default: false] — auto-approve edits AND auto-run all commands
  --max-iterations <n> integer [optional, default: 25]   ; > 0
  --token-budget <n> integer [optional, default: ~1000000]; > 0
  --json             boolean [optional, default: false]
  --config <path>    string  [optional]
  --help             boolean [optional] — usage text, exit 0

Output: stdout = streamed progress + final RunSummary; exit code = 0 iff RunOutcome=succeeded
        (REQ-020, RULE-011, INV-006); non-zero for stopped/failed.
```

Error: unknown flag / missing required arg → usage hint to stderr, non-zero exit (REQ-NFR-006).

---

## Relevant Design Notes

- `cli` is **thin** — it contains no agent logic; it is the composition root that wires dependencies
  and translates `RunOutcome.exitCode` into the process exit code.
- Task ingestion precedence: positional > `--task`/`-t` > `--task-file` > stdin (document the chosen
  order; if none provided in run mode, that is a usage error).
- `--help` must list **every** flag above (the test enumerates them).

---

## Acceptance Test(s)

- `test_REQ001_task_positional_starts_run` — a positional task produces a started `agent-run` with a
  `run-started` transcript entry carrying the task.
- `test_REQ001_task_from_stdin_and_flag` — the task is read from `--task` and from stdin (fallback)
  and starts the run.
- `test_REQ001_unknown_flag_usage_error` — an unknown flag → usage hint to stderr + non-zero exit.
- `test_REQ020_exit_zero_iff_succeeded` — `exitCode == 0` iff `status == "succeeded"`, non-zero for
  stopped/failed (INV-006).
- `test_REQNFR006_help_lists_all_flags` — `--help` exits 0 and documents every flag.

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The CLI surface matches IF-014; any newly-pinned flag behavior promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-001/020/REQ-NFR-006 still map to passing tests).

---

## Out of Scope for This Task

- Config merge precedence and root validation / fail-fast (SLICE-1 / TASK-003).
- The allowlist subcommand body (SLICE-9 / TASK-018) — only route it here.
- The `--json` rendering and final summary content (SLICE-8) — this task only wires `--json` as a
  parsed flag and translates the outcome's exit code.
