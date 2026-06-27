# Architecture

How TwinHarness is built, and why it is built that way. This page is conceptual and
standalone — you can read it without having run anything. For the operational view
of these mechanisms, see [advanced.md](./advanced.md); for the full specification,
see [spec/TwinHarness-Plan.md](../../spec/TwinHarness-Plan.md) and
[USAGE.md](../../USAGE.md).

## The central split: prompts orchestrate, code enforces

TwinHarness is two cooperating halves with a deliberate division of labor:

- **The prompt-orchestration layer** — a lead **Orchestrator** skill plus **17**
  specialized agents (`agents/*.md`: Spec, UX/UI-Designer, Vertical-Slice, Builder,
  Critic, Doc-Writer, Tester, Debugger, …). These make *judgments*: what the
  requirements mean, which architecture fits, whether a draft is coherent. Judgment
  is what language models are good at, so it lives in prompts.
- **The deterministic `th` CLI** (`src/cli.ts`, compiled to `dist/`) — a zero-runtime-
  dependency TypeScript tool that **records and computes; it never decides.** State,
  content hashing, REQ-ID traceability, coverage gates, the drift log, and the
  completion gate live here, behind a test suite. Mechanical truth is code the model
  cannot "forget" or rationalize away.

The governing rule that decides which half owns a thing:

> The irreversible, taste-driven, high-blast-radius layer — requirements, scope, and
> anything touching security, money, data integrity, or migrations — gets **human
> gates**. Everything else flows.

The same surface is exposed two ways at parity: as the `th` CLI and as an 81-tool MCP
server (`src/mcp-server.ts`, bundled separately). Agents prefer the typed MCP tools;
humans and CI use the CLI. Parity between them is itself enforced by tests.

## How artifacts govern

A TwinHarness run is a chain of **artifacts** — governing documents in `docs/`
(`01-requirements.md`, `02-scope.md`, `04-architecture.md`, …), each produced from a
template skeleton. Artifacts *govern* rather than decorate: downstream stages are
mechanically checked against them.

### Summary blocks keep context small
Every artifact opens with a compact **Summary block**. Downstream agents read the
Summary, not the whole document — full text is fetched only when a detail cannot be
resolved from the summary. This is the core context-economy mechanism: handoffs stay
small even as the artifact set grows.

### REQ-IDs make traceability computable
Requirements assign stable **REQ-IDs** (`REQ-001`, `REQ-NFR-002`). Every downstream
entity — component, contract, slice, test, code file — **anchors** back to a REQ-ID.
Because anchoring is textual and mechanical, traceability and coverage become
*computable*: `th coverage check` and `th trace render` scan the anchors rather than
trusting a narrative. See
[Artifacts, Summary blocks, and REQ-IDs](../../USAGE.md#artifacts-summary-blocks-and-req-ids).

### State, hashing & cascade staleness
When an artifact is approved it is **registered**: `th artifact register`
content-hashes the file and records `{file, version, hash}` in
`.twinharness/state.json`. Those hashes are the basis for **cascade staleness** — if
an upstream artifact changes, `th stale` computes exactly which downstream artifacts
the change invalidates, so the Critic re-verifies only what actually moved. State
itself is a single JSON document validated by `th state verify`; gate-owned fields
can only be mutated through typed gate commands, never hand-edited. See
[Cascade re-verification](../../USAGE.md#cascade-re-verification-upstream-artifact-changed).

## Bidirectional drift: documents stay honest

Reality diverges from the plan during a build. TwinHarness resolves this with
**bidirectional drift** instead of pretending the docs were perfect:

- **Derived-layer drift** (design/architecture/contracts disagree with reality): the
  Builder wires in reality, updates the doc *in the same change*, logs it, and keeps
  building. You ratify these asynchronously.
- **Requirement/scope drift** (reality contradicts what you signed off): the build
  **stops** and waits for your decision.

The source-of-truth rule: **code wins on behavior; requirements win on intent.** This
is what makes the artifacts trustworthy after a build, not just before one. See
[The build: vertical slices, waves, and drift](../../USAGE.md#the-build-vertical-slices-waves-and-drift).

## The hooks: enforcement at the harness boundary

Three Claude Code hooks turn policy into something the session physically cannot skip.
They are fail-open by design: with no `.twinharness/state.json`, every hook is inert,
so non-TwinHarness projects are completely unaffected.

- **Stop hook (`th hook stop-gate`)** — fires when Claude tries to end its turn. It
  blocks "done" while state is invalid, a blocking requirement-drift is open, or
  (at `final-verification`) slices are unbuilt or the verify suite is missing/red. It
  blocks at most once per stop sequence to avoid spinning the model.
- **SubagentStop hook** — the same discipline applied when a spawned agent tries to
  finish, so a sub-agent cannot declare success past an open gate.
- **PreToolUse hook (`th hook pretool-gate`)** — the **write-gate**. Before every
  `Write`/`Edit`/`NotebookEdit` (and, as defense-in-depth, obvious `Bash`-mediated
  writes) it blocks implementation files from being written before the pre-build
  gates clear, and polices slice/component boundaries during the build.

Hook wiring lives in `hooks/hooks.json`. See [The stop-gate](../../USAGE.md#the-stop-gate),
[The write-gate](../../USAGE.md#the-write-gate), and [The hooks](../../USAGE.md#the-hooks).

## The repo-understanding layer

For brownfield work TwinHarness needs to understand an existing codebase, not just
generate a new one. The `th repo` layer (`src/core/repo-map/`) builds a structural
map and answers targeted questions: `th repo relevant` finds the slices/REQ-IDs/files
touching a query, and `th repo impact` computes the blast radius of changing a file
or component. This feeds tiering and slice planning so the process is grounded in
what is actually there. See
[Repo-understanding layer](../../USAGE.md#repo-understanding-layer-th-repo).

## Where the source lives

| Concern | Source |
|---|---|
| CLI entry & verbs | `src/cli.ts`, `src/commands/*` |
| Mechanical primitives | `src/core/*` (state-store, hash, anchors, coverage, drift-log, decisions, routing, stages, repo-map) |
| MCP surface | `src/mcp-server.ts` (bundled separately) |
| Agent prompts | `agents/*.md` |
| Slash commands | `commands/*.md` |
| Hooks, schemas, templates | `hooks/`, `schemas/`, `templates/` |

`dist/` is **committed** — the plugin installs by marketplace copy with no build step.
See the [Repository layout](../../USAGE.md#repository-layout) and
[Developing the plugin itself](../../USAGE.md#developing-the-plugin-itself) sections,
and `../../CONTRIBUTING.md` for the contributor workflow.

## See also

- [advanced.md](./advanced.md) — the operational view: tier scaling, the gate ladder,
  coverage/drift, parallel build coordination, and the MCP surface.
- [cli-reference.md](./cli-reference.md) — the command surface tour.
- [spec/TwinHarness-Plan.md](../../spec/TwinHarness-Plan.md) — the full specification.
- [USAGE.md Part 2](../../USAGE.md#part-2--understanding-a-run) — understanding a run
  end to end.
