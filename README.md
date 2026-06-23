# TwinHarness

A Claude Code plugin that runs a vague software idea through requirements, design, and slice-by-slice implementation — with verification gates at every step. It is backed by a deterministic TypeScript CLI (`th`) that owns state, hashing, traceability, coverage, and a completion gate, so progress can't be faked by prompt text.

> **You are reading the `dev` branch.** This is the development/preview channel, currently **ahead of the last release (`v0.7.0`, tagged on `main`)**. The published `0.7.0` does **not** include the changes here, and no new release has been cut from `dev` yet. Install the `@dev` channel (below) to run this code. Expect breaking changes before 1.0 \u2014 interfaces may still move.

---

## What it is

TwinHarness is an agentic SDLC orchestrator. It coordinates 16 specialized agents — a core pipeline (Orchestrator, Spec, Critic, Vertical-Slice, Builder, Test-Author, UX/UI-Designer, Doc-Writer, Merge-Coordinator, Reconciler, Red-Team, Librarian) plus on-demand Researcher, Debugger, Codebase-Inspector, and Tester — behind a zero-dependency `th` CLI that handles every mechanical operation.

Three things make it different from asking an agent to build something directly:

- **Artifacts govern, they don't decorate.** Each stage produces a document that downstream stages are mechanically checked against; when reality diverges during the build, the document updates — in both directions.
- **Process scales with risk, not ceremony.** A trivial change bypasses the pipeline (Tier 0); work touching auth, money, or migrations gets the strictest treatment — and that floor is enforced by code, not by promises.
- **Mechanical truths live in code.** State, hashing, coverage, drift, and the completion gate sit in a tested CLI, not in prompt text a model could misremember.

**Who it's for:** Claude Code users who want spec-driven, gated development instead of one-shot vibe-coding, and who need traceability from requirements to code.

---

## Getting started

**Prerequisites:** Claude Code ≥ 1.0.0 and Node ≥ 20 on PATH. On older Node, `th` exits immediately with an upgrade pointer — install Node 20+ via [nvm](https://github.com/nvm-sh/nvm) (`nvm install 20`) or [nodejs.org](https://nodejs.org/).

### Install — dev / preview channel

You're on `dev`, so install the `@dev` marketplace to run this code. It ships as its own marketplace (`twinharness-dev`) and coexists side-by-side with the stable channel.

```
/plugin marketplace add JrSneed28/TwinHarness@dev
/plugin install twinharness@twinharness-dev
```

A **local clone checked out on `dev`** registers the same way (the marketplace name still resolves to `twinharness-dev`):

```
/plugin marketplace add C:\path\to\TwinHarness
/plugin install twinharness@twinharness-dev
```

The plugin name is always `twinharness`; only the marketplace differs (`@twinharness-dev` vs `@twinharness`), which is what lets both channels coexist.

<details>
<summary>Stable channel (released v0.7.0) — lags this code</summary>

The released build tracks `main` and is behind the `dev` code above.

```
/plugin marketplace add JrSneed28/TwinHarness
/plugin install twinharness@twinharness
```

Throwaway trial without installing: `claude --plugin-dir C:\path\to\TwinHarness`
</details>

### First run

Open Claude Code in the directory where you want the software built (an empty directory is fine):

```
/twinharness:th-run build a CLI tool that tracks my reading list
```

### Slash commands

TwinHarness ships **16 slash commands** — 4 to drive a run, plus 12 thin wrappers over the most-used `th` verbs.

| Command | What it does |
|---|---|
| `/twinharness:th-run [--interview] [--cutoff <0..1>] <idea>` | Start a new run, or resume one (it picks up from `state.json`) |
| `/twinharness:th-status` | Tier, current stage, gates, slices, open drift — at a glance |
| `/twinharness:th-drift` | Review the drift log; decide blocked escalations |
| `/twinharness:th-escalate` | Everything currently waiting on a human decision |

`--interview` opens a confidence-scored Socratic loop that sharpens the brief before tier classification (default cutoff 0.80). Inspection/verb wrappers: `th-init`, `th-doctor`, `th-next`, `th-scorecard`, `th-stage`, `th-verify`, `th-coverage`, `th-tier`, `th-route`, `th-repo`, `th-test`, and `th-decision-approve` (the human-only decision gate). Full flag reference in [USAGE.md](./USAGE.md).

### Run the tests (from a clone)

```
npm install
npm test
```

---

## What a run looks like

After `/twinharness:th-run <idea>` (see [First run](#first-run)), here's roughly what happens:

1. **Scaffolding.** The Orchestrator initializes `docs/`, `.twinharness/state.json`, and `drift-log.md` in your project.
2. **Requirements.** A Spec agent drafts requirements, assigns REQ-IDs, and asks only the questions that matter; a fresh-context Critic reviews the draft.
3. **Your first gate.** You approve the requirements or request changes. Once you sign off, they're sticky — only you can reopen them.
4. **Tier classification.** The project is sized Tier 0–3. Trivial → Tier 0 bypass; risky blast-radius work → Tier 3 with more gates and more expensive models.
5. **Design stages stream.** Domain model, architecture, contracts, security/failure analysis, and test strategy run with Critic reviews without interrupting you — except for genuinely irreversible or blast-radius choices (e.g. monolith vs. services, the auth scheme). UI projects get two ordered stages — 4a (UX) then 4b (UI) — each presenting 2–3 directions to pick from.
6. **Vertical slices, then build.** A fresh-context agent decomposes the design into thin end-to-end slices. Builders implement them one-by-one (in conflict-free parallel waves when independent), tests included, with a Critic after each.
7. **Documentation.** A Doc-Writer generates tier-appropriate docs (Critic-reviewed; no human gate).
8. **Verification.** A final report separates what the Critic can certify (coherence) from what only tests and you can certify (correctness). You sign off.

### Architecture

```mermaid
flowchart TD
    Idea([User idea]) --> Orch[Orchestrator skill]

    Orch --> Tier{Tier classify}
    Tier -- T0 bypass --> Build
    Tier -- T1-T3 --> Spec

    Spec[Spec agent] --> CriticSpec[Critic — fresh context]
    CriticSpec -- FAIL --> Spec
    CriticSpec -- PASS --> HumanGate{Human gate<br/>requirements/scope}
    HumanGate --> DesignStages

    subgraph DesignStages[Design stages — stream with Critic reviews]
        direction LR
        D1[Domain model] --> D2[Architecture]
        D2 --> D3a[UX design 4a<br/>conditional · gated]
        D3a --> D3b[UI design 4b<br/>conditional · gated]
        D3b --> D4[Contracts / security / test strategy]
    end

    DesignStages --> VS[Vertical-slice agent<br/>fresh context]
    VS --> Build

    subgraph Build[Build — parallel waves]
        direction LR
        B1[Builder slice 1] & B2[Builder slice 2] --> B3[Builder slice N]
    end

    Build --> DocWriter[Doc-Writer agent]
    DocWriter --> Verify[Verification report]
    Verify --> SignOff([Human sign-off])

    CLI["th CLI — mechanical spine<br/>state.json · hashes · REQ anchors<br/>coverage · drift log · blast-radius veto"]
    StopHook[Stop hook — blocks done<br/>while state invalid, drift open,<br/>or final-verify slices unfinished]

    CLI -. gates .-> Orch
    CLI -. gates .-> Build
    StopHook -. enforces .-> Verify
```

---

## Non-Goals

Naming what it isn't keeps the promise honest:

- **Not a general autonomous agent.** It won't pick your auth scheme, database, or any blast-radius decision — the model proposes, you decide. Those gates are enforced by code.
- **Not a one-shot vibe-coding tool.** Want a throwaway script with no spec, gates, or traceability? Use a bare agent. TwinHarness trades speed for governance.
- **Not a CI system, test runner, or build tool.** It records and gates on *your* project's verify commands; it doesn't replace your test framework, linter, or CI.
- **Not an IDE pair-programmer.** It's a pipeline orchestrator, not inline autocomplete or chat-in-editor.
- **Not a sandbox.** The write-gate and human gates bind a *compliant* agent inside Claude Code; they're guardrails, not a security boundary against a hostile process (see [SECURITY.md](./SECURITY.md)).
- **Not a model or hosted service.** Prompt orchestration plus a zero-dependency local CLI — nothing leaves your machine unless you ask it to.

---

## How it compares

| Tool | One-line difference |
|---|---|
| **Aider** | A fast in-terminal edit/commit pair-programmer; TwinHarness is a multi-stage SDLC pipeline with requirements, gates, and REQ-ID traceability before any code is written. |
| **OpenHands** (ex-OpenDevin) | A general autonomous-agent runtime that executes broadly; TwinHarness deliberately *constrains* autonomy with human gates and a code-enforced completion check. |
| **GitHub Spec Kit** | Scaffolds a spec-driven workflow as docs/templates; TwinHarness makes the spec *mechanically governing* — coverage, drift, and the Stop hook enforce it, not convention. |
| **BMAD-Method** | A prompt/agent methodology you assemble; TwinHarness ships the agent-team idea *with* a deterministic CLI that holds state, hashes, and gates. |
| **Prompt packs** | Text a model can misremember; TwinHarness moves the mechanical truths into a tested CLI so they cannot drift. |

---

## Features

Features split into a **Core** spine every run uses and **Advanced** machinery that is **OFF by default**, activating only at **tier ≥ T2** or when a run is already doing **parallel authorship**. So sub-Builders, collaboration, and debate are not "always on" — they are tier-gated capabilities. `th tier features` shows exactly what's active; the matching MCP tools return a structured `tier_locked` refusal until the threshold is met.

**Core (every run):** Tier scaling with Tier-0 bypass · code-enforced blast-radius floor (`th tier veto-check`) · fresh-context Critic reviews with capped revise loops · REQ-ID traceability (`th anchors scan`, `th trace render`) · bidirectional drift log · vertical slices scheduled into conflict-free parallel waves · a Stop hook that blocks "done" while state is invalid or blocking drift is open · a configurable, fail-open PreToolUse write-gate · a gate-mutation audit ledger · on-demand Researcher and Debugger agents · self-diagnostics (`th doctor`, `th next`, `th coverage`, `th manifest export`) · conditional UX (4a) + UI (4b) stages · tier-scaled docs · automatic model routing · brownfield mode (`th init --brownfield`) · a full **79-tool MCP surface** at parity with the CLI.

**Advanced (opt-in — tier ≥ T2 or parallel authorship):** coordinated safe parallel builds with cross-process locking and dynamic component leases · a multi-writer coordination plane (`th collab`, `th debate`, section/sub leases) · decision governance (`th decision …`) with a hash-chained, tamper-evident audit trail and a human-only TTY approval gate that aborts in any agent or CI context.

Full per-feature detail is in [USAGE.md](./USAGE.md).

---

## The `th` CLI

`th` is a zero-dependency TypeScript CLI that owns every mechanical operation in a run. It records and computes — it never decides which stage, agent, or tier runs; those are the Orchestrator's calls. All commands accept `--json`.

Command groups: `init` · `state` · `tier` · `artifact` · `coverage` · `verify` · `slices`/`slice` · `build` (plan / next-wave / leases) · `debug` · `anchors`/`trace`/`stale` · `drift` · `revise` · `hook` · `stage` · `doctor` · `next` · `preview` · `scorecard` · `telemetry` · `manifest` · `context` · `delegate` · `migrate` · `repo` (map / relevant / impact / check) · `decision` · advanced coordination (`collab`, `debate`, artifact & sub leases). Full reference in [USAGE.md](./USAGE.md) Part 3.

A deterministic **repo-understanding layer** (`th repo map|relevant|impact|check`, plus matching MCP tools) gives brownfield runs a mechanical spine for adopting an existing codebase. It treats all repository content as untrusted data: discovered build/test commands are recorded as inert strings and never executed (see [SECURITY.md](./SECURITY.md)).

---

## Status

**On the `dev` branch:** ahead of the released `v0.7.0` (tagged on `main`); the published build does not include this work, and no release has been cut from `dev`.

**What works today:**

- Full T0\u2013T3 pipeline, all 16 agents, all stages.
- `th` CLI with **2,000+ tests** covering CLI behavior, plugin-packaging integrity, security containment (path traversal, proto-pollution), the repo-understanding layer, decision governance (hash-chain tamper detection, TTY barrier), brownfield tiering, and the full 79-tool MCP surface.
- CI runs typecheck, build, a dist-sync assertion, and the full suite on every push/PR across Linux/macOS/Windows \u2014 with 1 POSIX-only permission test in `tests/concurrency.test.ts` intentionally skipped on Windows and covered on Linux/macOS CI.
- Validated Claude Code plugin packaging (`claude plugin validate` + `--plugin-dir` load).
- PreToolUse write-gate, gate-mutation audit ledger, managed drift counter, schema-versioned state with `th migrate`, and context-budgeted prompts (always-loaded files fit Claude Code's ~500-line / ~5k-token guidance).

**Not yet done:**

- **Limited real-world mileage** — exercised internally, not yet validated across a broad range of real projects.
- **No release cut from `dev`** — the version is still `0.7.0`; expect breaking changes (artifact schemas, state fields, CLI flags) before 1.0.

---

## Repository structure

```
.claude-plugin/   plugin manifest and marketplace.json
.github/          CI (typecheck, build, dist-sync assertion, full test suite)
agents/           16 agent prompt files (lean cores; detail in skills/twinharness/reference/)
commands/         16 slash command definitions (4 run commands + 12 th-* verb wrappers)
dist/             compiled CLI — ships in git (no build step at install time)
hooks/            hook wiring (hooks.json → th hook stop-gate / pretool-gate)
schemas/          published JSON Schemas for state.json and brief.json
skills/           twinharness/SKILL.md (lean Orchestrator core) + reference/ (on-demand detail)
spec/             design spec (TwinHarness-Plan.md) and the write-gate design
src/              TypeScript source for the th CLI
templates/        artifact skeletons for each SDLC stage
tests/            REQ-anchored vitest suite
```

The agents and skill are the brains; `src`/`dist` is the mechanical spine; `templates/` are the artifact skeletons; `hooks/` is the completion gate. Deeper docs live in [USAGE.md](./USAGE.md) and [spec/](./spec/).

---

## Contributing

```
git clone https://github.com/JrSneed28/TwinHarness.git
cd TwinHarness
npm install
npm run build
npm test
```

`dist/` ships in git because plugin installs copy the repo as-is with no build step. If you change anything in `src/`, run `npm run build` and commit `dist/` together with the source — `tests/plugin-manifest.test.ts` enforces this and CI asserts `git diff --exit-code dist/` on every push. Full contributor guide in [CONTRIBUTING.md](./CONTRIBUTING.md); threat model in [SECURITY.md](./SECURITY.md).

Issues and pull requests welcome: [github.com/JrSneed28/TwinHarness/issues](https://github.com/JrSneed28/TwinHarness/issues).

---

## License

MIT

---

## Links

- [USAGE.md](./USAGE.md) — full usage guide, from install through advanced CLI reference
- [CHANGELOG.md](./CHANGELOG.md) — version history
- [SECURITY.md](./SECURITY.md) — threat model, trust boundaries, vulnerability reporting
- [CONTRIBUTING.md](./CONTRIBUTING.md) — dev setup and packaging invariants
- [spec/TwinHarness-Plan.md](./spec/TwinHarness-Plan.md) — design spec
- [GitHub issues](https://github.com/JrSneed28/TwinHarness/issues)

---

[![version](https://img.shields.io/badge/version-0.7.0-blue)](CHANGELOG.md) [![branch](https://img.shields.io/badge/branch-dev%20(ahead)-orange)](#status) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE) ![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7c3aed) ![node](https://img.shields.io/badge/node-%E2%89%A5%2020-339933)
