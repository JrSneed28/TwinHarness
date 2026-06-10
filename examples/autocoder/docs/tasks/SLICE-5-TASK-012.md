# SLICE-5 / TASK-012 — run_command tool + tests-as-signal + exec-cwd confinement

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-009, REQ-013, REQ-021
**Slice:** SLICE-5 — Run commands & tests-as-signal under the command-approval policy
**Depends on:** SLICE-5 / TASK-011 complete (uses `command-runner`, `allowlist`, `approval-gate`)

---

## Goal

Implement the `tool-runcommand` (`run_command`) tool: confine the cwd via
`path-sandbox.checkExecCwd` (reject out-of-root fail-closed), gate the command via
`approval-gate.resolveCommand` against the allowlist, then execute via the `CommandRunner` seam,
capturing `{exitCode,stdout,stderr,timedOut}`; mark a run of the detected test command with
`isTestRun:true` and emit a `tests-run` entry feeding pass/fail back as the **primary completion
signal**; treat a non-zero exit as a **result, not an error**. This completes the **exec half** of
REQ-021's confinement.

---

## REQ-IDs

- **REQ-009** — Tool: **run command** — execute a shell command in the working root and capture exit
  code, stdout, and stderr.
- **REQ-013** — The agent can run the project's tests via the run-command tool, capture the result,
  and feed pass/fail output back into the loop as the primary signal of task completion.
- **REQ-021** — Command execution is confined to the resolved working root; a cwd that escapes the
  root is rejected before the operation.

---

## Relevant Contracts / Interfaces

```
IF-004 run_command — input: { command (string, min 1), cwd? (default WorkingRoot; MUST equal/descend
  root), timeoutMs? (default 120000; 1000..600000) }
  output: { exitCode: integer (non-zero is a RESULT, not an error), stdout, stderr,
            timedOut: boolean, isTestRun: boolean (true when command == detected test command),
            truncated: boolean }
  Errors: PATH_ESCAPE (ERR-001, cwd outside root, fail-closed), APPROVAL_DENIED (ERR-004),
    COMMAND_TIMEOUT (ERR-009, exceeded timeoutMs), COMMAND_FAILED (ERR-010, failed to spawn —
    distinct from a non-zero exit).
  NOTE: a non-zero exit code is NOT an error — it is a status:"ok" ToolResult carrying exitCode
  (ADR-007). A failing test run is a result the agent reasons about.

TranscriptEntry "tests-run" payload: { command, passed: boolean, exitCode: integer }.
IF-010 PathSandbox.checkExecCwd(cwd) → { allowed, canonicalPath, reason?:{code:"PATH_ESCAPE"} }
```

---

## Relevant Design Notes

- Order (RULE-001/005): `checkExecCwd` → `resolveCommand` → `CommandRunner.run`. The runner does no
  policy/confinement (that is done here).
- `isTestRun` is set by comparing `command` to the detected test command from `repo-context`
  (RULE-009); a `tests-run` entry carries `passed` for the completion signal.
- Distinguish `COMMAND_FAILED` (spawn failure) from `COMMAND_TIMEOUT` (killed at timeout) from a plain
  non-zero exit (success result). Commands are NOT deduplicated
  (`test_REQ009_command_not_deduplicated`).

---

## Acceptance Test(s)

- `test_REQ009_runs_command_captures_exit_stdout_stderr` — returns `{exitCode,stdout,stderr,timedOut}`
  via the stubbed `CommandRunner`.
- `test_REQ009_command_timeout` — exceeding `timeoutMs` → `COMMAND_TIMEOUT`.
- `test_REQ009_command_spawn_failure` — spawn failure → `COMMAND_FAILED`.
- `test_REQ009_command_not_deduplicated` — identical commands are not deduplicated.
- `test_REQ013_test_run_marks_isTestRun_completion_signal` — the detected test command sets
  `isTestRun` and a `tests-run` entry with `passed`, fed back as the completion signal.
- `test_REQ013_nonzero_exit_is_result` — a failing test run is a success ToolResult carrying
  `exitCode != 0`.
- `test_REQ021_exec_cwd_escape_rejected` — a cwd outside the root → `PATH_ESCAPE` fail-closed.

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The tool matches IF-004 (+ IF-007/IF-010 use); any newly-pinned detail promoted to
      `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-009/013 still map to passing tests; REQ-021 exec-side
      green).

---

## Out of Scope for This Task

- Apply-patch (SLICE-6 / TASK-013).
- Budget/stop classification when tests pass (SLICE-7) — this task only emits the `tests-run` signal.
- Allowlist management UX (SLICE-9).
