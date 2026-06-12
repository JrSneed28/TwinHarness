# TwinHarness

**Turns "build me X" into working, tested software** by forcing the idea through requirements, scope, design, and slice-by-slice implementation with verification gates — as a Claude Code plugin.

> **Early development notice.** TwinHarness is at v0.3.x. The pipeline has been exercised end-to-end and ships 254 passing tests, but it has limited real-world mileage and interfaces may change before 1.0. Expect breaking changes. Use it, push its limits, file issues — just don't bet a production release on it yet.

---

## What it is

TwinHarness is a Claude Code plugin: an agentic SDLC orchestrator that takes a vague software idea and produces working, tested software through a disciplined pipeline. It coordinates 7 specialized agents — Orchestrator, Spec, Critic, Vertical-Slice, Builder, UI-Designer, Doc-Writer — and backs them with a deterministic TypeScript CLI (`th`) that handles every mechanical operation: state, content hashing, REQ-ID traceability, coverage gates, the drift log, and a Stop hook that blocks Claude from claiming "done" while state is invalid or a blocking discovery is open.

Three things make it different from asking an agent to build something directly:

- **Artifacts govern; they don't decorate.** Every stage produces a document that downstream stages are mechanically checked against. When reality diverges during the build, the document updates — in both directions.
- **The process scales with risk, not ceremony.** A trivial change bypasses everything (Tier 0). A project touching auth, money, or migrations gets the strictest treatment, and that floor is enforced by code, not by promises.
- **Mechanical truths are code.** State, hashing, coverage, drift counts, and the completion gate live in a tested CLI — not in prompt text a model could misremember.

**Who it's for:** Claude Code users who want spec-driven, gated development instead of one-shot vibe-coding; people burned by agents that build the wrong thing or claim "done" when they aren't; teams that need traceability from requirements to code.

---

## What a run looks like

Start with:

```
/twinharness:th-run build a CLI tool that tracks my reading list
```

Then, roughly:

1. **Scaffolding.** The Orchestrator initializes `docs/`, `.twinharness/state.json`, and `drift-log.md` in your project directory.
2. **Requirements.** A Spec agent drafts requirements, assigns REQ-IDs, and asks you only the questions that matter. A fresh-context Critic reviews the draft.
3. **Your first gate.** You see the requirements and are asked to approve or request changes. Once you sign off, requirements are sticky — only you can reopen them.
4. **Tier classification.** The Orchestrator sizes the project (Tier 0–3). Trivial → Tier 0 bypass. Risky blast-radius work → Tier 3 with more gates and more expensive models.
5. **Design stages stream.** Domain model, architecture, contracts, security/failure analysis, and test strategy run with Critic reviews but without interrupting you — except for genuinely irreversible choices (e.g. monolith vs. services) and blast-radius decisions (e.g. the auth scheme). If your project has a UI, the UI-Designer presents 2–3 design directions and asks you to pick one.
6. **Vertical slices, then build.** A fresh-context agent decomposes the design into thin end-to-end slices. Builders implement them one-by-one (in conflict-free parallel waves when slices are independent), tests included, with a Critic after each.
7. **Documentation.** A Doc-Writer agent generates tier-appropriate docs. Critic-reviewed; no human gate.
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
        D2 --> D3[UI design<br/>conditional]
        D3 --> D4[Contracts / security / test strategy]
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
    StopHook[Stop hook — blocks done<br/>while state invalid or drift open]

    CLI -. gates .-> Orch
    CLI -. gates .-> Build
    StopHook -. enforces .-> Verify
```

---

## Getting started

**Prerequisites:** Claude Code; Node >= 18 on PATH.

### Install

The repo is its own single-plugin marketplace. From a local clone:

```
/plugin marketplace add C:\path\to\TwinHarness
/plugin install twinharness@twinharness
```

From GitHub directly:

```
/plugin marketplace add JrSneed28/TwinHarness
/plugin install twinharness@twinharness
```

For a throwaway trial without installing:

```
claude --plugin-dir C:\path\to\TwinHarness
```

The plugin installs at user scope and is available in every project.

### First run

Open Claude Code in the directory where you want the software built (an empty directory is fine):

```
/twinharness:th-run build a CLI tool that tracks my reading list
```

### Slash commands

| Command | What it does |
|---|---|
| `/twinharness:th-run <idea>` | Start a new run, or resume an interrupted one (it picks up from `state.json`) |
| `/twinharness:th-status` | Tier, current stage, gates, slices, open drift — at a glance |
| `/twinharness:th-drift` | Review the drift log: skim auto-applied doc updates, decide blocked escalations |
| `/twinharness:th-escalate` | Show everything currently waiting on a human decision |

### Run the test suite (from a clone)

```
npm install
npm test
```

The full guide — tiers, stages, the Critic loop, drift, gates, and the complete CLI reference — is in [USAGE.md](./USAGE.md).

---

## Features

- **Tier scaling with Tier-0 bypass.** Trivial changes skip the full pipeline. The Orchestrator classifies the project before running any stages, and communicates exactly which stages will run.
- **Blast-radius floor.** Projects touching auth, money, migrations, or data integrity can never skip process — this floor is enforced by the `th tier veto-check` command, not by prompt instructions.
- **Fresh-context Critic reviews with capped revise loops.** Each major artifact is reviewed in an independent context to avoid anchoring bias. Revise loops are capped (default 3 rounds) and escalate to a human if the cap is reached.
- **REQ-ID traceability.** Every requirement gets a stable ID (`REQ-001`, `REQ-002`, …) that anchors to slices, tests, and source code. `th anchors scan` maps the full picture; `th trace render` produces the traceability view on demand without maintaining a stored matrix.
- **Bidirectional drift log.** Discoveries during the build flow back into the governing artifacts. Non-blocking changes auto-apply; requirement-layer changes increment a counter that the Stop hook reads to refuse premature completion.
- **Vertical slices with a walking skeleton.** Each slice is a thin, end-to-end capability. `th build plan` schedules slices into conflict-free parallel waves: disjoint component sets run in the same wave, overlapping components serialize to prevent drift races.
- **Stop hook.** Claude is blocked by default from claiming completion while `state.json` is invalid or a blocking drift entry is open. The gate is code (`th hook stop-gate`), not a prompt reminder.
- **PreToolUse write-gate.** Blocks the standard Write/Edit path by default — before the pre-build gates clear and across slice-component boundaries during the build. Note: Bash-mediated writes (`echo >`, `sed -i`) are out of scope for this hook (see `spec/write-gate-design.md`). The gate is fail-open (non-TwinHarness projects are completely unaffected), configurable (`ask` / `deny` / `off`, default `ask`), and one click to allow in a manual session.
- **Conditional UI-design stage.** Present only when the project has a user interface. The UI-Designer presents 2–3 distinct design directions and asks you to pick one before streaming the detailed design.
- **Tier-scaled documentation.** T1 gets a readme; T2 adds a user guide and API reference; T3 gets the full suite. A Critic reviews the docs; no human gate required.
- **Automatic model routing.** Cheap models handle routine work; expensive ones (Opus) handle high-risk stages, blast-radius reviews, and the Orchestrator. Haiku handles trivial summarization. The full routing policy is in `skills/twinharness/SKILL.md`.

---

## The `th` CLI

`th` is a zero-dependency TypeScript CLI that owns every mechanical operation in a TwinHarness run. It records and computes — it never decides which stage, agent, or tier runs. Those are the Orchestrator's calls.

| Command group | Purpose |
|---|---|
| `th init` | Scaffold `docs/`, `.twinharness/state.json`, `drift-log.md` |
| `th state get\|set\|status\|verify` | Read, patch, snapshot, or validate `state.json` |
| `th tier classify\|veto-check` | Advisory tier eligibility check; mechanical blast-radius veto (exit 3) |
| `th artifact register\|list` | Content-hash and record approved artifacts |
| `th coverage check` | Verify every MVP REQ-ID maps to at least one slice and one test |
| `th slices sync` / `th slice set-status` | Upsert slices from the implementation plan; update status |
| `th build plan` | Schedule slices into conflict-free parallel build waves |
| `th anchors scan` / `th trace render` / `th stale` | Map REQ anchors, render traceability, compute cascade-stale set |
| `th drift add\|list\|resolve` | Append, list, and resolve bidirectional drift entries |
| `th revise bump\|status\|reset` | Manage revise-loop counts and escalation |
| `th hook stop-gate` | Emit the Claude Code Stop-hook decision |
| `th hook pretool-gate` | Emit the Claude Code PreToolUse-hook decision (write-gate) |

All commands accept `--json` for machine-readable output. The full reference is in [USAGE.md](./USAGE.md) Part 3.

---

## Status

**What works today:**

- Full T0–T3 pipeline, all 7 agents, all stages.
- `th` CLI with passing tests covering CLI behavior and plugin-packaging integrity.
- Validated Claude Code plugin packaging (`claude plugin validate` + `--plugin-dir` load pass).
- PreToolUse write-gate: blocks the Write/Edit path by default before gates clear and across slice-component boundaries during the build; Bash-mediated writes are out of scope (v0.3.0).
- A complete worked example: `examples/autocoder/` — a T3 run producing an autocoder CLI tool, 11 slices, Stage 11 verified and human-signed.

**Not yet done:**

- **Limited real-world mileage.** The pipeline has been exercised on internal examples but not yet validated across a broad range of real projects.
- **Breaking changes before 1.0.** Artifact schemas, state fields, and CLI flags may change.

---

## Repository structure

```
.claude-plugin/   plugin manifest and marketplace.json
agents/           7 agent prompt files
commands/         4 slash command definitions
dist/             compiled CLI — ships in git (no build step at install time)
hooks/            Stop hook wiring (hooks.json → th hook stop-gate)
skills/           twinharness/SKILL.md — full Orchestrator playbook
spec/             design spec (TwinHarness-Plan.md) and roadmap items (write-gate-design.md)
src/              TypeScript source for the th CLI
templates/        artifact skeletons for each SDLC stage
tests/            REQ-anchored vitest suite
examples/         complete worked example (autocoder T3 run)
```

The agents and skill are the brains; `src/dist` is the mechanical spine; `templates/` are the artifact skeletons; `hooks/` is the completion gate. Deeper documentation lives in [USAGE.md](./USAGE.md) and [spec/](./spec/).

---

## Contributing

```
git clone https://github.com/JrSneed28/TwinHarness.git
cd TwinHarness
npm install
npm run build
npm test
```

`dist/` ships in git because plugin installs copy the repo as-is with no build step. If you change anything in `src/`, run `npm run build` and commit `dist/` together with the source — `tests/plugin-manifest.test.ts` enforces this mechanically.

Issues and pull requests are welcome: [github.com/JrSneed28/TwinHarness/issues](https://github.com/JrSneed28/TwinHarness/issues).

---

## License

MIT

---

## Links

- [USAGE.md](./USAGE.md) — full usage guide, from install through advanced CLI reference
- [CHANGELOG.md](./CHANGELOG.md) — version history
- [spec/TwinHarness-Plan.md](./spec/TwinHarness-Plan.md) — design spec
- [spec/write-gate-design.md](./spec/write-gate-design.md) — PreToolUse write-gate design (implemented in v0.3.0)
- [GitHub issues](https://github.com/JrSneed28/TwinHarness/issues)

---

[![version](https://img.shields.io/badge/version-0.3.0-blue)](CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE) ![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7c3aed) ![node](https://img.shields.io/badge/node-%E2%89%A5%2018-339933)
