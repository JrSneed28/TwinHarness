---
description: Start or resume a TwinHarness Agentic SDLC run — drive an idea through tier-scaled stages to slice-by-slice build.
argument-hint: [--interview] [--no-interview] [--threshold 0.20] <your idea, e.g. "build a CLI todo app">
allowed-tools: Bash(node:*), Bash(true), mcp__plugin_twinharness_th__*, Task, Agent, AskUserQuestion
---

Start (or resume) a **TwinHarness** orchestration run for: **$ARGUMENTS**

> **Running `th`:** the CLI ships inside this plugin. Wherever instructions say `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`. The Orchestrator should prefer the typed
> `mcp__plugin_twinharness_th__*` MCP tools and fall back to
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` only for verbs not yet exposed as MCP tools (see
> `reference/mcp-tools.md`). A tool that **returns** an error result (e.g. `not_initialized`) is
> working — act on it and keep using the MCP tools; do not switch to the CLI just because a call
> reported "no run yet."

Existing run state, if any (captured before this prompt runs). **"No state.json" / "not initialized"
here is normal for a new project — it is the signal to START a run, not an error to report to the
user.** Use it to decide **resume vs. fresh init**:

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" state status || true`

### Flags

- `--interview` — after `th init`, run a full **ambiguity-scored Socratic loop** (below) before
  tiering. This **replaces** the lightweight §14.1 vague-narrowing for this run.
- `--no-interview` *(default)* — skip the scored loop; if the brief is a vague mega-request, apply the
  lightweight §14.1 narrowing instead.
- `--threshold <0..1>` — override the interview gate threshold for this run (default **0.20**). Also
  overridable via the `state.json` field `interview_threshold` (read it with `th_state_get`); a
  `--threshold` flag wins over the state field, which wins over the 0.20 default.

Follow the `twinharness` skill (the Orchestrator playbook). In brief:

1. **No run yet** (`.twinharness/state.json` absent / the snapshot says "not initialized") → run
   `th init` **yourself** (`th init --brownfield` when building into an existing repo) and drive the
   entire flow below. **Never stop to tell the user to initialize — just do it.** If a run already
   exists, run `th state status` and **resume** from `current_stage`.
2. **Interview gate (only when `--interview`).** Immediately **after `th init`** and **before** tier
   classification, run the scored Socratic loop:
   - `th_interview_start { idea: "$ARGUMENTS", threshold? }` → creates `.twinharness/interview.json`.
     Resolve the threshold as flag → state `interview_threshold` → 0.20.
   - Each round: ask the user one sharp clarifying question, then **you (the model) score it** — the
     deterministic `th` layer cannot call an LLM, so YOU supply the scores. Record the round with
     `th_interview_record { question, answer, scores{goal,constraints,criteria}, ambiguity, entities[] }`
     (pass `scores` and `entities` as JSON-encoded strings). **Show the ambiguity score to the user
     each round.**
   - After each round call `th_interview_status {}` → `{ rounds, ambiguity, threshold, ready }`. Stop
     when `ready` (ambiguity ≤ resolved threshold).
   - **Early-exit** is allowed **from round 3 onward** if the user says "good enough" — record a
     warning round noting the early exit. **Hard cap: 20 rounds** — stop and proceed even if not
     `ready`.
   - Then proceed to tier classification + the requirements stage, **seeding from
     `.twinharness/interview.json`** (the captured idea, rounds, and brief).
3. Classify the tier and blast radius (spec §5). Record it with `th state set` — never hand-edit state.
4. Run the engaged stages for the tier, delegating each artifact to the **Spec agent** (by mode),
   verifying coherence with the **Critic**, and surfacing only the §8 human gates via AskUserQuestion.
5. **Build-phase gate (always, immediately before implementation).** Before ANY implementation begins
   — after the design stages are coherence-gated and the slice plan is approved, before the first
   Builder writes code — surface an `AskUserQuestion` with two choices:
   - **"begin now"** → continue building **in this same session**.
   - **"begin in a fresh Claude Code session"** → **pause** and print the EXACT resume command
     `/twinharness:th-run` carrying the project context (e.g. the original brief, so the new session
     re-enters at the build stage from `current_stage`), then **STOP**. "Fresh session" means the user
     opens a **new Claude Code conversation** and runs that command — it is **not** a detached, tmux,
     or background process.

   This is a **§8-style human gate only.** It **MUST NOT** call `th_state_set implementation_allowed`
   (or flip any gate-owned field) — it never touches the gate-owned `implementation_allowed` field;
   the Stop-gate hook and the existing prerequisite gate own that. The build-phase gate only decides
   *where* (this session vs. a fresh one) you begin, never *whether* the gate is satisfied.
5.5. **Documentation-phase gate (after all slices pass code-review Critic).** Do **not** automatically
   generate documentation. Instead, present a **repeatable menu** via `AskUserQuestion`:
   - **[1] Write documentation** — delegate to the Doc-Writer agent (tier-appropriate modes), run the
     per-mode Critic loops, then **return to this menu**.
   - **[2] Run qa-tester** — delegate to the Tester agent (`agents/tester.md`) for a live QA pass,
     then **return to this menu**.
   - **[3] Skip → Final Verification** — advance to Stage 11 now.

   Options **[1]** and **[2]** loop; only **[3]** advances. Full detail in
   `reference/build-and-verify.md` (Stage 10.5).
6. Keep `state.json` authoritative via the `th` CLI; the Stop-gate hook enforces a valid state before
   any "stage complete" claim.

When **not** running `--interview`, if the brief is a vague mega-request, **narrow it with targeted
questions first** — do not generate a thin, useless spec (§5, §14.1). When `--interview` is set, the
scored loop above performs this narrowing instead.
