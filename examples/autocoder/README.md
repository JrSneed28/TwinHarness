# Autocoder — a TwinHarness flagship example

This directory is a **worked example of the TwinHarness Agentic SDLC** (the plugin in this repo). A
deliberately complex one-line brief — *"build a complex agentic AI coding tool"* — was driven from a
vague idea through a full **Tier 3** pipeline (requirements → scope → domain model → architecture →
ADRs → technical design → contracts → security → failure modes → test strategy → vertical-slice plan)
and then **built slice-by-slice to a complete, verified implementation**.

**Autocoder** (the product) is an autonomous coding-agent CLI — a "mini Claude Code": you give it a
natural-language task, it builds repo context, drives an LLM tool-use loop, edits files across a repo
(every mutation shown as a diff and gated by an approval policy), runs the project's tests, observes
the results, and iterates until the task is verifiably done or a stop condition fires. TypeScript /
Node ≥ 18 + Vitest, with the Anthropic SDK and the shell injected behind interfaces for determinism.

## Status: ✅ complete — built and verified (Stage 11)

| | |
|---|---|
| Tier | **T3** (blast-radius: `data-integrity`) |
| Stage | `final-verification` (closed) |
| Slices | **11/11 built** (SLICE-0 skeleton + SLICE-1…10), each fresh-context Critic-reviewed → 0 defects |
| Tests | **128 passing** (Vitest, offline) |
| Coverage | **`th coverage check`: 33/33 REQ-IDs, 0 gaps** (every requirement → ≥1 slice + ≥1 anchored test) |
| Drift | 22 derived-layer entries, all non-blocking and resolved (`drift_open_blocking: 0`) |
| Verification | `docs/10-verification-report.md` — coherence Critic-certified; correctness human-signed |

---

## Setup

```bash
cd examples/autocoder
npm install          # typescript, @types/node, vitest
npm test             # run the full suite (128 tests, fully offline — no API key needed)
npm run typecheck    # tsc --noEmit
npm run build        # compile src/ → dist/ (produces the `autocoder` bin)
```

To run the CLI against a real model you must provide an Anthropic API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # PowerShell: $env:ANTHROPIC_API_KEY = "sk-ant-..."
```

Configuration is resolved with precedence **flags > environment > config file > built-in defaults**
(`IF-017`). The API key is read from the environment only and is **never** written to the transcript,
`--json` output, or disk (verified by `test_REQ018_apikey_never_serialized`).

> **One intentionally-unwired seam.** Per the test strategy's seam-exclusion rule (REQ-NFR-002), the
> example is fully implemented and tested **offline** with the LLM and shell injected behind
> interfaces. The live Anthropic network transport (`createSdkTransport` in `src/llm-client.ts`) is a
> deliberate stub that throws `not_wired` — so `npm test` is the green, deterministic path, and a live
> run requires supplying a real transport (a thin `@anthropic-ai/sdk` call returning the `IF-006`
> shape). Everything else — the loop, retry/backoff, the five tools, the sandbox, the approval
> policy, budgets, the transcript, the reporter — is real, runnable code.

---

## Usage

```
autocoder [task] [flags]                          run an agent task against a repo
autocoder allowlist <list|add|remove> [pattern]   manage the command auto-run allowlist
```

### Run mode

The **task** is the natural-language instruction. It is resolved with precedence
**positional > `--task`/`-t` > `--task-file` > stdin**:

```bash
autocoder "add input validation to the signup handler and make the tests pass"
autocoder --task "refactor utils/date.ts to be timezone-safe" --root ./my-repo
echo "fix the failing snapshot tests" | autocoder
autocoder --task-file ./task.txt --json
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--task`, `-t <str>` | — | the Task as a flag (alternative to the positional) |
| `--task-file <path>` | — | read the Task from a file |
| `--cwd`, `--root <p>` | current dir | the **WorkingRoot** — the boundary for all file writes and command execution |
| `--model <id>` | `claude-sonnet-4-6` | the Claude model id |
| `--yes`, `--auto` | off | auto-approve **edits** AND auto-run **all** commands (otherwise: confirm-each / allowlist-confirm) |
| `--max-iterations <n>` | 25 | hard iteration ceiling (runaway protection) |
| `--token-budget <n>` | ~1,000,000 | hard token ceiling |
| `--json` | off | emit the final `RunSummary` as machine-readable JSON (CI-stable, `IF-016`) |
| `--config <path>` | — | config file path |
| `--help` | — | print usage and exit 0 |

**Exit code reflects the outcome** (`IF-016`, scriptable): `0` iff the run **succeeded**; non-zero for
`stopped` (max-iterations / budget-exhausted / model-give-up / user-abort) or `failed`
(unrecoverable-error).

### Safety model (least authority)

- **Filesystem confinement (`REQ-021`):** writes and command execution are confined to the resolved
  `WorkingRoot`; any target that escapes via traversal, an absolute path, or a symlink is rejected
  **fail-closed**. Reads may go anywhere (read-anywhere), but content read from outside the root can
  never be written back outside it.
- **Edit approval (`REQ-012`):** every mutation produces a unified diff and is gated by the edit
  policy — `confirm-each` by default, `auto` with `--yes`.
- **Command approval (`REQ-016`):** allowlisted commands (token-sequence prefix match) auto-run;
  everything else prompts. Chained/redirected commands (`;`, `&&`, `|`, `>`, `` ` ``, `$(`, …) **never**
  auto-run, even if the head token is allowlisted.
- **Budgets (`REQ-015`):** a pre-turn guard prevents a turn from starting once a ceiling is reached —
  the run is bounded, never aborted mid-flight.

### Allowlist management

Inspect and edit the command auto-run allowlist (no agent loop is started; changes persist to the
config file):

```bash
autocoder allowlist list
autocoder allowlist add "npm test"
autocoder allowlist remove "rm"
```

### Output & audit

- **Human stream** (`REQ-017`): plan/step → each tool call + outcome → diffs → test results.
- **Final summary** (`REQ-019`): outcome, files changed (with diffs), tests result, iterations and
  approximate tokens used.
- **`--json`** (`REQ-024`): the same data as a schema-stable `RunSummary` object (`schemaVersion: "1.0"`).
- **Transcript** (`REQ-022`, `REQ-NFR-008`): an append-only, durable JSONL event log of every
  iteration, tool call, tool result, approval decision, and stop decision — sufficient to reconstruct
  the run.

---

## What's here

- `src/` — the implementation (cli, config, repo-context, agent-run loop, llm-client + retry,
  tool-registry + the five tools, path-sandbox, diff-engine, approval-gate, allowlist, command-runner,
  budget-stop, transcript, reporter).
- `tests/` — 128 anchored tests; every test name embeds the REQ-ID it verifies
  (`test_REQ<###>_<slug>`), so traceability is mechanical (`th anchors scan`, `th trace render`).
- `docs/01-requirements.md` … `docs/09-implementation-plan.md` — the full T3 artifact chain.
- `docs/05-adrs/` — 8 Architecture Decision Records.
- `docs/tasks/` — 19 self-contained Builder task files (SLICE-0 … SLICE-10).
- `docs/10-verification-report.md` — the Stage 11 verification report (coherence vs correctness,
  separated per spec §11).
- `.agentic-sdlc/state.json` — the authoritative run state (tier, stage, approved-artifact hashes,
  slices). Never hand-edited — only via the `th` CLI.
- `drift-log.md` — the bidirectional drift log (22 derived-layer entries from the build).

## How it was produced

Each design stage was drafted by the **Spec / Vertical-Slice agents**, then reviewed for coherence by
the **Critic** in a fresh context. The build ran **slice-by-slice**: a **Builder** implemented each
slice's production code **with** its anchored tests in the same change, then a fresh-context **Critic**
code-review gated the slice. Discoveries were classified by the bidirectional drift loop (§10) —
derived-layer drift (architecture/design/contracts) auto-wrote-back and logged; nothing contradicted a
requirement or scope decision, so no blocking escalation occurred. Requirements, scope, the security
trust model, and the concurrent-write data-loss decision were **human-gated**; the architecture's two
irreversible decisions (native tool-use; append-only JSONL transcript) were recorded as ADRs. State
was kept authoritative throughout via the `th` CLI — never hand-edited.

To re-verify at any time:

```bash
node "../../dist/cli.js" --cwd . coverage check    # 33/33, 0 gaps
node "../../dist/cli.js" --cwd . trace render       # authoritative traceability view (never stored)
npm test                                            # 128 passing
```
