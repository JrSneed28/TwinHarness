# Requirements — Autocoder

> **Stage 1 — Requirements Engineering** (spec §14.1). Sticky, human-gated. Assign requirement IDs here;
> they anchor design, contracts, slices, tasks, and tests downstream (§11).

## Summary

Autocoder is an autonomous coding-agent CLI — a "mini Claude Code" — that takes a coding task in
plain English and completes it inside a target repository without step-by-step human direction. It
runs an LLM-driven agent loop: it builds context about the repo, plans, calls tools to read, search,
and edit files, runs the project's tests/commands, observes the results, and iterates until the task
is done, a stop condition is hit, or it gives up. It is built for developers who want to delegate
well-scoped, test-verifiable coding tasks and review the result as diffs. It ships as real, runnable,
tested TypeScript/Node software using the Anthropic TypeScript SDK and Vitest.

- **Core goal:** Let a developer hand a natural-language coding task to a CLI that autonomously edits
  a repository and iterates against its tests until the task is verifiably complete or it stops.
- **Primary users:** Software developers running the CLI against a code repository on their machine.
- **Top success measure:** On a benchmark of seeded, test-backed tasks in real repos, Autocoder
  completes ≥ 70% end-to-end (target task's tests pass, no unrelated tests broken) within its default
  iteration ceiling, with every file change presented to the user as a reviewable diff.

## Goal

A developer wants to offload concrete, verifiable coding work — "add input validation to the signup
endpoint and make the new test pass," "fix the failing `parseDate` tests," "refactor `utils.ts` to
remove the deprecated API" — without driving the editor manually. Autocoder accepts such a task in
natural language and acts as an autonomous agent: it forms a plan, uses tools to inspect and modify
the codebase, runs the project's tests to check its own work, reads the output, and keeps iterating
until the task is achieved or a bounded stop condition is reached. The value is delegated, closed-loop
coding where correctness is anchored to the repo's own tests rather than to the model's self-report.

## Intended Users

- **Primary — individual developers.** Engineers working in a local repository who want to delegate a
  well-scoped task and review the outcome. They are comfortable with a terminal, an API key, and
  reading diffs. They expect to stay in control: see what changed, approve risky actions, and trust
  that the agent will not run away with cost or destructive commands.
- **Secondary — automation/CI authors (future-leaning).** People who may wire Autocoder into scripts
  for routine, low-risk changes. The MVP must be scriptable (non-zero exit on failure, machine-readable
  output available) but full unattended CI use is not an MVP goal.

This is a developer tool used locally, not a hosted multi-tenant service.

## Problem Statement

Plain LLM chat can suggest code but cannot reliably *land* a change: it does not see the real
repository, cannot run the tests, and cannot iterate on actual failures. Developers are left
copy-pasting snippets, fixing integration gaps by hand, and re-prompting. What is missing is a tool
that closes the loop — that operates directly on the working tree, exercises the project's real
tests, observes concrete results, and self-corrects — while keeping the developer in control of what
gets written and what gets executed. Autocoder is that closed loop.

## Functional Requirements

<Each requirement gets a stable requirement ID. These IDs are the mechanical anchors.>

- **REQ-001** — The CLI accepts a coding task as a natural-language string (positional argument
  and/or `--task`/`-t` flag, with stdin/file fallback) and starts an agent run against a target
  repository.
- **REQ-002** — The agent resolves and validates a working directory (target repo): defaults to the
  current directory, configurable via `--cwd`/`--root`; the resolved root is the boundary for all
  filesystem operations.
- **REQ-003** — The agent builds initial context about the target repo (e.g., directory listing,
  detected project type / test command, key files) before or during planning, without requiring the
  full repo to be loaded into the prompt.
- **REQ-004** — The agent runs an LLM-driven loop using the Anthropic TypeScript SDK with a Claude
  model: each iteration sends the task, accumulated context, and tool results to the model and
  receives either tool calls or a final answer.
- **REQ-005** — The agent exposes a tool interface to the model and executes the model's tool calls,
  feeding results back into the loop (tool-use / function-calling).
- **REQ-006** — Tool: **read file** — return the contents (or a bounded range) of a file within the
  working root.
- **REQ-007** — Tool: **list / search files** — list directory entries and search file contents
  (glob and/or text/regex search) within the working root.
- **REQ-008** — Tool: **write/edit file** — create a new file or modify an existing file within the
  working root via whole-file write and/or targeted string-replace edit.
- **REQ-009** — Tool: **run command** — execute a shell command (notably the project's test/build
  command) in the working root and capture exit code, stdout, and stderr.
- **REQ-010** — Every file-mutating action produces a unified diff (before → after) that is shown to
  the user; no silent writes.
- **REQ-011** — Edits are applied to the working tree according to the configured approval mode
  (see REQ-012); applied edits are persisted to disk so subsequent tool calls and command runs see
  the new state.
- **REQ-012** — The CLI supports an edit-approval mode controlling whether edits auto-apply or require
  user confirmation (default: confirm-each, overridable by a `--yes`/`--auto` flag — see Assumptions).
- **REQ-013** — The agent can run the project's tests via the run-command tool, capture the result,
  and feed pass/fail output back into the loop as the primary signal of task completion.
- **REQ-014** — The agent loop terminates on a defined stop condition: task success (model declares
  done and/or tests pass), max-iteration ceiling reached, cost/token budget exhausted, explicit
  give-up by the model, or unrecoverable error.
- **REQ-015** — The CLI enforces a configurable maximum iteration count (default ceiling) and a
  configurable token/cost budget; reaching either ends the run cleanly with a clear reason.
- **REQ-016** — Before running any shell command, the agent applies a command-approval safety policy
  (see REQ-NFR-005): commands on a configurable **allowlist auto-run** (the default allowlist includes
  the detected test/build command and common safe read-only commands — e.g. `ls`, `cat`, `grep`,
  `git status`); **every non-allowlisted command requires user confirmation** before execution.
  The allowlist is configurable, and a `--yes`/`--auto` flag may auto-run all commands. *(Human-gated
  decision — OQ-2 resolved: "allowlist auto-runs, wider auto-run surface; non-allowlisted confirm.")*
- **REQ-017** — The CLI streams human-readable progress to the terminal: the current plan/step, each
  tool call and its outcome, diffs, and test results, so the user can follow the agent's reasoning.
- **REQ-018** — The CLI reads configuration from flags, environment variables, and an optional config
  file, including: Anthropic API key (env `ANTHROPIC_API_KEY`), model id, working root, approval modes,
  iteration ceiling, and budget.
- **REQ-019** — On completion the CLI emits a final summary: outcome (success / stopped / failed),
  files changed (with diffs or a diff summary), tests run and their result, iterations used, and
  approximate token/cost usage.
- **REQ-020** — The CLI exits with a process exit code reflecting outcome (0 = task succeeded;
  non-zero = stopped/failed), so it is usable in scripts.
- **REQ-021** — **File mutations (write/edit) and command execution are confined to the resolved
  working root:** any write/exec target that escapes the root (via traversal, absolute path, or
  symlink) is rejected before the operation. **Reads may access paths outside the root** (read-anywhere)
  so the agent can consult shared configs and sibling files. *(Human-gated decision — OQ-3 resolved:
  "read-anywhere, write/exec-in-root.")*
- **REQ-022** — The agent records a run transcript / log of iterations, tool calls, tool results, and
  decisions, available to the user for inspection and debugging after the run.
- **REQ-023** — Tool: **apply-patch** — apply a unified-diff patch (one or more hunks across one or
  more files) to the working tree, confined to the write/exec root (REQ-021) and subject to the
  edit-approval policy (REQ-012). Provides sharper, minimal-footprint edits on large files than
  whole-file write; malformed or non-applying patches are rejected with an actionable error and fed
  back to the model as a tool result. *(Added at scope sign-off, 2026-06-09 — human decision: 5-tool
  MVP surface.)*
- **REQ-024** — The CLI supports a `--json` machine-readable output mode: the final run summary
  (REQ-019) and outcome are emitted as a structured JSON object on stdout (schema-stable, parseable by
  CI/automation), complementing the human-readable stream (REQ-017) and the exit code (REQ-020).
  *(Added at scope sign-off, 2026-06-09 — human decision: structured output in MVP for the CI-author
  user.)*
- **REQ-025** — The CLI provides allowlist-management commands/flags to **inspect, add, and remove**
  entries in the command-approval allowlist (REQ-016), giving the user explicit control over the
  highest-risk surface; changes persist to the config (REQ-018). *(Added at scope sign-off,
  2026-06-09 — human decision: full allowlist UX in MVP.)*

## Non-Functional Requirements

<Performance, reliability, security posture, usability, portability… as requirement IDs where checkable.>

- **REQ-NFR-001** — **Implementability:** the system is delivered as real, runnable, tested code
  (TypeScript/Node ≥ 18, Anthropic TS SDK, Vitest). Every functional REQ above is verifiable by an
  automated test (unit and/or integration, with the LLM and shell boundaries mockable).
- **REQ-NFR-002** — **Determinism of harness:** all non-LLM logic (tool dispatch, path sandboxing,
  diff generation, edit application, loop control, stop conditions, config parsing) is deterministic
  and testable without live network or live model calls; the Anthropic SDK and shell are injected
  behind interfaces so tests can stub them.
- **REQ-NFR-003** — **Cost / runaway protection:** no run can exceed its configured iteration ceiling
  or token/cost budget; absent explicit config, conservative defaults apply so an accidental run
  cannot spend unbounded API credit.
- **REQ-NFR-004** — **Reliability:** transient failures (LLM API errors/timeouts/rate limits) are
  retried with bounded backoff; a failing tool call (e.g., command non-zero exit, file not found)
  is reported back to the model as a result rather than crashing the process.
- **REQ-NFR-005** — **Safety / least authority:** file mutations and command execution are confined
  to the working root (REQ-021), shell execution is gated by the command-approval policy (REQ-016,
  allowlist auto-runs / non-allowlisted confirm), and edits are gated by the edit-approval policy
  (REQ-012, confirm-each by default). Reads may range outside the root by design (OQ-3); the residual
  read-exposure risk is recorded in Risks. The default posture prevents silent disk mutation and
  blocks unattended execution of arbitrary (non-allowlisted) commands.
- **REQ-NFR-006** — **Usability:** output is readable and well-structured (clear progress, colored
  diffs where supported); a `--help` documents all flags; misconfiguration (e.g., missing API key)
  fails fast with an actionable message.
- **REQ-NFR-007** — **Portability:** runs on macOS, Linux, and Windows (Node ≥ 18); path handling and
  command execution account for cross-platform differences.
- **REQ-NFR-008** — **Observability:** the run transcript (REQ-022) is sufficient to reconstruct what
  the agent did and why, including each tool call's inputs and outputs and each stop decision.

## Constraints

- **Language/runtime:** TypeScript on Node.js ≥ 18. **(Hard constraint — locked.)**
- **LLM provider/SDK:** Anthropic TypeScript SDK (`@anthropic-ai/sdk`) driving a Claude model for the
  agent's reasoning and tool-calling. **(Hard constraint — locked.)**
- **Testing:** Vitest is the test framework. **(Hard constraint — locked.)**
- **Delivery:** this is a flagship example that will be FULLY BUILT into real, runnable, tested code
  for all MVP slices — requirements must be concretely implementable, not aspirational. **(Locked.)**
- **External dependency:** requires a valid Anthropic API key and network access to the Anthropic API
  at runtime; offline operation is not supported for live runs (but the harness is testable offline).
- **Form factor:** a command-line tool run locally; not a GUI, web service, or hosted platform.

## Non-Negotiables

- No silent file writes: every mutation is represented as a diff visible to the user (REQ-010).
- File writes and command execution never escape the resolved working root (REQ-021); reads may, by
  the configured read-anywhere policy (OQ-3).
- A run cannot exceed its configured iteration and budget ceilings (REQ-015, REQ-NFR-003).
- The harness (all non-LLM logic) is deterministic and unit-testable without live model/network/shell
  (REQ-NFR-002).
- The agent loop always terminates on a defined stop condition (REQ-014).

## Risks

- **Destructive actions:** the run-command tool can execute arbitrary shell commands; a careless or
  adversarial task could delete data or exfiltrate secrets. Mitigated by the command-approval policy
  and working-root confinement, but residual risk remains (the chosen default posture is the key
  human-gated decision — see Open Questions).
- **Cost runaway:** an agent loop can consume large amounts of API tokens. Mitigated by iteration and
  budget ceilings; default values must be conservative.
- **Capability ceiling:** the agent may fail to complete hard tasks or thrash without converging.
  Bounded by stop conditions; success-rate target (70%) is on seeded, test-backed tasks, not arbitrary
  open-ended work.
- **Bad edits / regressions:** the agent may produce edits that pass the target test but break
  unrelated behavior. Mitigated by running the full/affected test suite and surfacing diffs for review.
- **Path/sandbox escape:** symlinks or path traversal could defeat root confinement on writes/execs
  if validation is weak. Mitigated by REQ-021; must be tested explicitly (negative tests).
- **Read exposure (OQ-3 residual):** the read-anywhere policy lets the agent read files outside the
  root (e.g. secrets, credentials in sibling dirs). Accepted by human decision; mitigated by the fact
  that reads cannot be written back outside the root and the run transcript records every read.
- **Model/tool-protocol drift:** reliance on the Anthropic tool-use API; SDK or model behavior changes
  could break the loop. Mitigated by isolating the SDK behind an interface (REQ-NFR-002).
- **Wrong-thing risk:** the task description may be ambiguous; the agent could confidently do the wrong
  thing. Partially mitigated by showing the plan and diffs before/with applying changes.

## Success Criteria

- **Primary (capability):** On a curated benchmark of seeded, test-backed coding tasks in real
  repositories, Autocoder completes ≥ 70% end-to-end — the task's designated tests pass and no
  previously-passing tests regress — within the default iteration ceiling.
- **Closed loop demonstrated:** For at least one real task, Autocoder is shown to plan, edit files,
  run the project's tests, read a failure, self-correct, and reach passing tests across multiple
  iterations — with all changes presented as diffs.
- **Safety demonstrated:** Filesystem confinement and the command/edit approval policy are proven by
  automated tests, including negative tests that a path-escape attempt is rejected and that a run
  cannot exceed its iteration/budget ceilings.
- **Build quality:** All MVP functional requirement IDs are covered by passing Vitest tests; the project
  builds and runs as a real CLI on Node ≥ 18.
- **Usability:** A new user can install/configure (API key + model) and complete the quickstart task
  from the README without reading source code.

## Assumptions

<Defaults taken where the user expressed no preference (§7). AskUserQuestion is unavailable in this
subagent context; the following safe defaults were taken and the corresponding decisions are surfaced
as Open Questions for the Orchestrator to human-gate.>

- **Edit-approval default (REQ-012):** **confirm-each-edit** is the default — the agent shows a diff
  and asks before writing each file — with a `--yes`/`--auto` flag to auto-apply. Safest posture for a
  tool with disk-write authority.
- **Command-approval default (REQ-016) — HUMAN-CONFIRMED (OQ-2):** a configurable **allowlist
  auto-runs** (default allowlist: detected test/build command + common safe read-only commands such as
  `ls`, `cat`, `grep`, `git status`); **every non-allowlisted command requires confirmation**. A
  `--yes`/`--auto` flag may auto-run everything. Wider auto-run surface than confirm-each, but arbitrary
  and destructive commands remain gated.
- **Filesystem scope default (REQ-002/REQ-021) — HUMAN-CONFIRMED (OQ-3):** **read-anywhere,
  write/exec-in-root** — file mutations and command execution are confined to the resolved working
  root (cwd by default, or `--root <dir>`); reads may access paths outside the root. Escaping
  write/exec paths are rejected.
- **Loop ceiling default (REQ-015):** stop on **max iterations (default ~25) OR a token/cost budget**,
  whichever is hit first; both configurable. Conservative values chosen to prevent runaway spend.
- **Model default (REQ-018):** a current Claude model id is the default, overridable via config/flag;
  the exact model id is a configuration value, not a hard requirement.
- **Edit mechanism (REQ-008):** both whole-file write and targeted string-replace edits are supported;
  string-replace is preferred for large files to keep diffs small.
- **Test detection (REQ-003/REQ-013):** the test command is auto-detected where possible (e.g., from
  `package.json` scripts) and overridable via config; the agent treats the configured test command as
  the completion signal.
- **Scope of "run":** one task per invocation (a single agent run); batch/queue of tasks is future
  scope, not MVP.
- **Concurrency:** a single sequential agent loop (no parallel tool execution) for the MVP.
- **State persistence:** run transcript/logs are written for the current run; cross-run memory or
  resumable sessions are future scope.

## Open Questions

<All four blocking decisions were human-gated at requirements sign-off (2026-06-09) and are now
RESOLVED. No open blocking questions remain.>

- **OQ-1 (edit-approval model — REQ-012): RESOLVED → confirm-each-edit** (agent shows the diff and
  asks before each write; `--yes`/`--auto` overrides to auto-apply).
- **OQ-2 (shell-command safety — REQ-016, REQ-NFR-005): RESOLVED → allowlist auto-runs / non-allowlisted
  confirm** (configurable allowlist of safe commands auto-runs; every other command requires
  confirmation; `--yes`/`--auto` runs all). The highest-risk decision; human-confirmed.
- **OQ-3 (filesystem scope — REQ-002, REQ-021): RESOLVED → read-anywhere, write/exec-in-root** (reads
  may leave the root; writes and command execution are confined to the root; escaping write/exec paths
  rejected). Residual read-exposure risk accepted and recorded in Risks.
- **OQ-4 (loop/cost ceiling — REQ-015, REQ-NFR-003): RESOLVED → iterations + token budget** with
  default values **max-iterations = 25** and **token-budget ≈ 1,000,000 tokens** (input+output, per
  run); whichever limit is hit first ends the run. Both configurable.
