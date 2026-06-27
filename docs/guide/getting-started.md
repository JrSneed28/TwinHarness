# Getting started with TwinHarness

This is the shortest path from zero to a first successful TwinHarness run. Read it
top to bottom once; you can drive a full run knowing nothing beyond this page. When
you want more, the [sibling guides](#where-to-go-next) and the canonical
[USAGE.md](../../USAGE.md) go deeper.

## What you are installing

TwinHarness (`th`) is a Claude Code plugin that turns a vague idea ("build me a
reading-list CLI") into working, tested code by driving it through a tier-scaled
SDLC pipeline: requirements → scope → design → a vertical-slice plan → a
slice-by-slice build → docs → final verification. A lead **Orchestrator** agent
runs the show and calls a deterministic `th` CLI for every mechanical truth (state,
hashes, coverage, drift). You mostly answer a handful of gate questions.

## Prerequisites

- **Node ≥ 20** on your `PATH`. The bundled `th` CLI has zero runtime dependencies,
  but the plugin declares `engines.node >= 20`.
- **Claude Code ≥ 1.0.0** — the plugin targets the v1 hook and agent-manifest schema.

Check Node with `node --version`.

## Install

### Stable channel

From a local clone of the repository:

```
/plugin marketplace add C:\path\to\TwinHarness
/plugin install twinharness@twinharness
```

Headless equivalent:

```
claude plugin marketplace add <path>
claude plugin install twinharness@twinharness
```

The plugin installs at **user scope**, so it is available in every project. For a
throwaway test session that does not install anything, use
`claude --plugin-dir <path>`.

### Development / preview channel

The `dev` branch is published as a separate marketplace (`twinharness-dev`) so it
installs side by side with stable. Pin the marketplace to the `dev` ref:

```
/plugin marketplace add JrSneed28/TwinHarness@dev
/plugin install twinharness@twinharness-dev
```

The plugin name stays `twinharness`; only the marketplace ID differs. A local clone
checked out on `dev` also registers as `twinharness-dev`.

## Your first run

Open Claude Code **in the directory where you want the software built** (an empty
directory is fine) and run a single command:

```
/twinharness:th-run build a CLI tool that tracks my reading list
```

You do not type any `th` commands and you do not invoke any agent yourself — the
Orchestrator does all of that. (You can also just ask in prose, e.g. "build me X,
spec-driven, with tests," and Claude invokes the `twinharness` skill automatically.)

### What happens, step by step

1. **Scaffolding.** The Orchestrator runs `th init`, creating `docs/` (the
   artifacts), `.twinharness/state.json` (machine-readable run state — never edit it
   by hand), and `drift-log.md` (the build's discovery journal).
2. **Requirements.** A Spec agent drafts `docs/01-requirements.md`, then asks you
   **only the questions that matter** — it will not interrogate you field by field.
   Each requirement gets a stable `REQ-ID` (`REQ-001`, `REQ-002`, …).
3. **Your first gate** (see below).
4. **Tier classification.** The Orchestrator sizes the project (Tier 0–3) and tells
   you which stages will run. Small idea → few stages; risky idea → more stages and
   more gates.
5. **Design stages stream past you.** You are only *asked* about genuinely
   irreversible choices (e.g. monolith vs. services) and anything blast-radius
   (auth, money, data integrity, migrations). Interrupt any time by just typing.
6. **UX then UI direction** — only when your project has a user interface. You pick
   from 2–3 presented directions.
7. **Slice plan, then build.** The design is decomposed into thin end-to-end
   **vertical slices**; Builders implement them one at a time, tests included, each
   followed by a code-review Critic.
8. **Documentation**, then **Verification**, where you give the final sign-off.

### What your first gate looks like

After the Spec agent drafts requirements, a fresh-context **Critic** reviews the
draft. Once it passes, the Orchestrator surfaces an explicit **approve / revise**
question (via Claude Code's question UI). Choosing *approve* signs off the
requirements; choosing *revise* sends it back with your notes. Requirements and
scope are *sticky* — once you sign off, only you can change them later. This is the
pattern for every human gate: the machine checks coherence, then you decide intent.

### A first successful command you can run yourself

While the run is in progress (or any time after `th init` has scaffolded state),
ask the run where it is:

```
/twinharness:th-status
```

This prints the tier, current stage, gate status, slice progress, and any open
drift. It is read-only and always safe. If it prints a tier and a current stage,
your run is live and healthy — that is your first successful command.

Two more read-only commands worth knowing on day one:

| Command | Answers |
|---|---|
| `/twinharness:th-escalate` | What is currently waiting on **me**? |
| `/twinharness:th-drift` | What did the build discover that changed the docs? |

### `/twinharness:th-run` flags (optional)

`th-run` accepts four optional flags before the idea text. You need none of them for
a first run, but they exist:

| Flag | Default | Effect |
|---|---|---|
| `--interview` | off | Run a confidence-scored Socratic clarifying loop after `th init`, before tiering. |
| `--no-interview` | *(default)* | Skip the scored loop; vague briefs still get lightweight narrowing. |
| `--cutoff <0..1>` | `0.80` | Interview confidence cutoff. |
| `--max-tokens <k>` | tier default | Per-session context budget, in thousands. |

Example:

```
/twinharness:th-run --interview --cutoff 0.9 build a multi-tenant billing service
```

## Resuming

Runs are idempotent to re-enter. If `.twinharness/state.json` exists, running
`/twinharness:th-run` again reads `current_stage` and **resumes there — it never
starts over**. Close the session mid-architecture and pick up days later.

## Where to go next

You now know enough to drive a run. When you want depth:

- [cli-reference.md](./cli-reference.md) — a guided tour of the 16 slash commands and
  the `th` verb groups.
- [architecture.md](./architecture.md) — how the prompt-orchestration and
  deterministic-CLI halves fit together, and how artifacts govern.
- [advanced.md](./advanced.md) — tier scaling, the gate ladder, coverage and drift,
  parallel build coordination, and the MCP surface.
- [USAGE.md](../../USAGE.md) — the canonical, exhaustive guide. Start with its
  [Key concepts in 60 seconds](../../USAGE.md#key-concepts-in-60-seconds) and
  [Part 1 — Getting started](../../USAGE.md#part-1--getting-started).
