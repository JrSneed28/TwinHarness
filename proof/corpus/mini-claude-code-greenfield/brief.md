# Brief: `minicc` — a mini agentic coding system (greenfield)

## Summary
Build a *mini Claude Code* — a small but real agentic coding assistant that, given
a natural-language task, **reads a target codebase**, **makes changes across
multiple files**, **runs the project's tests**, and **delivers the work as a git
commit**. It drives this through an agent loop and surfaces everything in a
**colored terminal UI (TUI)** whose layout echoes the real Claude Code: a header,
a scrolling work/transcript pane that renders tool calls and their results with
color, and a status line. The agent "shows its work" as it goes.

Greenfield: built from scratch. Stack is intentionally left to the architecture
stage to choose (the brief is stack-neutral).

## Tier hint
T2 — medium complexity. Several cooperating subsystems (codebase reader, multi-file
editor, test-runner wrapper, git committer, an agent loop that sequences them, and
a TUI render layer) plus an end-to-end test of the loop. Deliberately *mini*: the
agent loop may be driven by a deterministic/pluggable planner so the core is unit-
and integration-testable without a live LLM call in the test suite.

## Functional requirements
- **Codebase reader**: scan a target directory and produce a file map (paths +
  language/size) and return the contents of a requested set of files; respects an
  ignore list (e.g. `.git`, `node_modules`/`dist`/`__pycache__`).
- **Multi-file editor**: apply a structured set of edits (create / overwrite /
  string-replace) across one or more files atomically — either all edits apply or
  none do — and report what changed.
- **Test runner**: invoke the target project's configured test command as a
  subprocess, capture stdout/stderr and exit code, and classify pass/fail.
- **Git committer**: stage the changed files and create a commit with a generated
  message; report the resulting commit hash. No-ops cleanly when nothing changed.
- **Agent loop**: given a task string, sequence read → plan → edit → run tests →
  (on green) commit, with a bounded retry on a failing test run. The planner is a
  pluggable interface so a deterministic fake planner can drive the loop in tests;
  an LLM-backed planner is the production implementation.
- **TUI**: a colored terminal UI resembling Claude Code's layout — a header bar, a
  scrolling transcript pane that renders each tool call (read / edit / run / commit)
  and its result with distinct colors, and a status/footer line. Pure render/format
  functions are separated from terminal I/O so they are unit-testable.

## Non-functional
- Multi-file edits are atomic (no partial-apply corruption on failure).
- The agent loop and every subsystem except the LLM-backed planner are fully
  testable without network access (deterministic fake planner + a temp git repo
  fixture).
- TUI rendering logic (line formatting, color selection, transcript layout) is
  separated from raw terminal writes so it can be asserted in tests.

## Acceptance criteria
See `meta.json` — codebase read + atomic multi-file edit + subprocess test runner +
git commit + a sequenced agent loop + a colored Claude-Code-style TUI, with unit +
integration + end-to-end tests covering the read→edit→test→commit lifecycle.
