# Scope — Autocoder

> **Stage 2 — Scope Definition** (spec §14.2). Sticky, human-gated. Decides what is built now
> versus later. Once signed off, scope is intent — only a human moves it (§10). Reference REQ-IDs
> throughout so downstream mechanical traceability holds (§11, §17).

## Summary

The Autocoder MVP is the **complete closed agent loop, built for real and proven by tests, with a
durable audit trail and a five-tool effector surface**: a CLI that takes one natural-language task,
runs an Anthropic-SDK-driven loop with five tools (read, list/search, write/edit, run-command, and
apply-patch), shows every mutation as a diff under the human-gated approval policies, runs the
project's tests as the completion signal, iterates until done or a stop condition, records a durable
on-disk run transcript with full observability, and emits a final summary as both human-readable
output and machine-readable `--json` with a correct exit code. It deliberately excludes everything
that is *not* required to demonstrate that loop end-to-end on Node ≥ 18 — no cross-run memory, no
task batching/queueing, no parallel tools, no GUI/TUI, and no unattended-CI auto-yes posture as a
default. **After the 2026-06-09 scope sign-off the MVP now carries ALL 25 functional REQs
(REQ-001…REQ-025) and all 8 NFRs (REQ-NFR-001…008)** — including the durable run-transcript *file*
(REQ-022), its observability guarantee (REQ-NFR-008), the apply-patch tool (REQ-023), the
machine-readable `--json` output (REQ-024), and the full inspect/add/remove allowlist UX (REQ-025).
The key confirmed trade-off: ship a complete, auditable, genuinely-runnable single-task loop with
safety gates on by default, rather than chasing breadth (multi-task, cross-run, parallel) before the
one loop is solid.

- **MVP in one sentence:** A developer runs `autocoder "<task>"` in a repo and the tool autonomously
  plans, edits files (diffs + confirm, whole-file/string-replace **or** apply-patch), runs the
  project's tests, self-corrects across iterations, records a durable transcript, and stops cleanly
  with a summary and exit code — emitted human-readably and as `--json`.
- **Key items confirmed out of scope:** cross-run memory / resumable sessions; multi-task
  batch/queue; parallel tool execution; GUI/TUI; full unattended-CI default posture; multi-provider.
- **Top scope risk:** "five-tool line creep" — going past the confirmed FIVE-tool surface (adding
  AST-aware edits, git ops, package-manager tools) chasing the 70% benchmark instead of making the
  five-tool closed loop solid; and the now-in-MVP transcript/observability layer ballooning beyond
  an append-only run log.

---

## Requirements Summary

This scope governs the approved Autocoder requirements (`docs/01-requirements.md`, REQ-001…REQ-025
and REQ-NFR-001…REQ-NFR-008). **Core goal:** let a developer hand a natural-language coding task to
a CLI that autonomously edits a repository and iterates against its tests until the task is
verifiably complete or it stops. **Primary users:** individual developers running the CLI locally
against a repo, comfortable with a terminal/API key, who want to stay in control (see diffs, approve
risky actions, bound cost). **Top success measure:** ≥ 70% end-to-end completion on a benchmark of
seeded, test-backed tasks (target tests pass, no unrelated regressions) within the default iteration
ceiling, with every change shown as a reviewable diff. Hard constraints are locked: TypeScript /
Node ≥ 18, Anthropic TS SDK + a Claude model, Vitest, CLI form factor, and — critically — the MVP is
**fully built into real, runnable, tested code**, so this scope must be a coherent, shippable subset.
All four blocking decisions are already resolved: confirm-each edits; allowlist-auto-run /
non-allowlisted-confirm commands; read-anywhere + write/exec-in-root; max-iterations 25 + token
budget ≈ 1M. **At the 2026-06-09 scope sign-off the human EXPANDED the MVP**: the durable
run-transcript file (REQ-022) and its observability guarantee (REQ-NFR-008), the apply-patch tool
(REQ-023, a fifth effector), machine-readable `--json` output (REQ-024), and full allowlist
management UX (REQ-025) were all promoted into MVP.

---

## MVP Scope

The minimum set that makes Autocoder useful to its first users **and** demonstrably exercises the
full closed loop (task → context → plan → tool-driven edits → run tests → observe → iterate → stop →
summary). Every item passed both pruning questions ("required for the first usable version?" / "would
the project still solve the core problem without this?"). The loop is not the loop if any of these is
missing.

**Entry & target resolution**
- Accept a natural-language task (positional arg and/or `--task`/`-t`, with stdin/file fallback) and
  start a run — REQ-001
- Resolve and validate the working root (default cwd, `--cwd`/`--root`); the root is the boundary for
  all filesystem operations — REQ-002

**Context & the agent loop**
- Build initial repo context (directory listing, detected project type / test command, key files)
  without loading the whole repo into the prompt — REQ-003
- LLM-driven loop via the Anthropic TS SDK with a Claude model: each iteration sends task + context +
  tool results, receives tool calls or a final answer — REQ-004
- Expose a tool interface to the model and execute tool calls, feeding results back into the loop
  (tool-use / function-calling) — REQ-005

**The five tools (the loop's effectors)**
- Read file (full or bounded range) within the working root — REQ-006
- List / search files (glob and/or text/regex) within the working root — REQ-007
- Write/edit file (whole-file write **and** targeted string-replace) — REQ-008
- Run command (capture exit code, stdout, stderr) in the working root — REQ-009
- Apply-patch (apply a unified-diff patch across one or more files/hunks; confined to the write/exec
  root per REQ-021, gated by the edit-approval policy per REQ-012; malformed/non-applying patches are
  rejected with an actionable error fed back to the model) — REQ-023

**Safety & control (non-negotiable; the reason this tool is trustworthy)**
- Every file-mutating action produces a unified diff shown to the user; no silent writes — REQ-010
- Apply edits to the working tree per the approval mode and persist to disk so later tool calls/runs
  see new state — REQ-011
- Edit-approval mode (default **confirm-each**, `--yes`/`--auto` to auto-apply) — REQ-012
- Command-approval policy: allowlist (detected test/build cmd + safe read-only cmds) auto-runs; every
  non-allowlisted command requires confirmation; `--yes`/`--auto` runs all — REQ-016
- Write/exec confined to the resolved root; reads may range outside it (read-anywhere); escaping
  write/exec targets (traversal, absolute, symlink) rejected before the op — REQ-021

**Completion signal & bounded termination**
- Run the project's tests via run-command, capture results, feed pass/fail back as the primary
  completion signal — REQ-013
- Terminate on a defined stop condition (success / max iterations / budget exhausted / model give-up
  / unrecoverable error) — REQ-014
- Enforce configurable max-iterations (default 25) **and** token/cost budget (default ≈ 1M tokens);
  hitting either ends the run cleanly with a clear reason — REQ-015

**Durable audit trail (now in MVP — data-integrity blast radius)**
- Record a durable on-disk run transcript / log of iterations, tool calls, tool results, and stop
  decisions, available for post-hoc inspection and debugging — REQ-022
- Observability guarantee: the transcript is sufficient to reconstruct what the agent did and why —
  each tool call's inputs/outputs and each stop decision — REQ-NFR-008

**Visibility & scriptable result**
- Stream human-readable progress to the terminal (plan/step, each tool call + outcome, diffs, test
  results) — REQ-017
- Read config from flags, env vars, and an optional config file (API key via `ANTHROPIC_API_KEY`,
  model id, root, approval modes, iteration ceiling, budget, allowlist) — REQ-018
- Emit a final summary on completion (outcome, files changed + diffs/summary, tests run + result,
  iterations used, approximate token/cost) — REQ-019
- Exit code reflects outcome (0 = success; non-zero = stopped/failed) for script use — REQ-020
- Machine-readable `--json` output mode: the final summary (REQ-019) and outcome are emitted as a
  schema-stable JSON object on stdout, parseable by CI/automation, complementing the human stream
  (REQ-017) and the exit code (REQ-020) — REQ-024
- Allowlist-management UX: commands/flags to **inspect, add, and remove** entries in the
  command-approval allowlist (REQ-016), with changes persisting to config (REQ-018) — REQ-025

**Quality bar carried by MVP (non-functional, all MVP-scoped)**
- Real runnable tested code; every MVP functional REQ verifiable by an automated test — REQ-NFR-001
- Deterministic, offline-testable harness (SDK + shell injected behind interfaces) — REQ-NFR-002
- Cost/runaway protection via ceilings with conservative defaults — REQ-NFR-003
- Reliability: bounded-backoff retry on transient LLM errors; failing tool calls returned to the
  model as results, not crashes — REQ-NFR-004
- Safety / least authority (root confinement + approval policies, default posture blocks silent
  mutation and unattended arbitrary commands) — REQ-NFR-005
- Usability: readable output, `--help`, fail-fast on misconfiguration (e.g. missing API key) —
  REQ-NFR-006
- Portability across macOS / Linux / Windows on Node ≥ 18 — REQ-NFR-007
- Observability over the durable run transcript (now MVP; see the Durable audit trail block) —
  REQ-NFR-008

*All eight NFRs (REQ-NFR-001…008) are MVP-scoped after the 2026-06-09 sign-off.*

---

## V1 Scope

> **Post-sign-off note (2026-06-09):** the four items that previously sat here — the durable
> run-transcript file (REQ-022), its observability guarantee (REQ-NFR-008), the full allowlist UX
> (REQ-025), and machine-readable `--json` output (REQ-024) — were all **promoted into MVP** at the
> scope sign-off. V1 is therefore now **intentionally thin**: the big bets remain in Future, and V1
> holds only the lightest, most natural *next increments* that directly extend what MVP now ships. No
> new scope was invented to backfill V1.

Items that genuinely follow MVP as the immediate next increment; each still leaves the core problem
solvable without them.

- **Sharper apply-patch refinements (AST-aware / git-aware patching)** — extends REQ-023 *(MVP ships
  a unified-diff apply-patch tool that closes the loop; AST-aware edits and git-aware patch
  application — three-way merge against the working tree, staging integration — are the natural next
  increment that deepens the already-shipped fifth tool, not a new capability. Distinct from the
  Future "additional tools" bet, which is about new effector categories beyond patching.)*
- **Resumable single-task continuation** — extends REQ-014/REQ-022 *(resume one interrupted run from
  its durable transcript: pick up after a max-iteration/budget stop or a crash, reusing the recorded
  state. This is a single-task continuation built directly on the now-MVP transcript — strictly
  narrower than the Future "cross-run memory / multi-task sessions" bet, and the lightest next step
  that leverages REQ-022.)*

---

## Future Scope

Acknowledged-valuable, explicitly deferred beyond V1; not committed.

- **Cross-run memory / multi-run resumable sessions** — *(future — not committed; persistent memory
  across distinct invocations and a full session model. Distinct from V1's resumable **single-task**
  continuation, which only resumes one interrupted run from its transcript.)*
- **Batch / queue of multiple tasks per invocation** — *(future; Assumptions: "one task per
  invocation … batch/queue of tasks is future scope, not MVP.")*
- **Parallel tool execution** — *(future; Assumptions: "single sequential agent loop … for the MVP.")*
- **Full unattended-CI integration** (auto-yes posture as a first-class supported workflow, beyond
  the scriptable exit-code + `--json` surface that MVP now ships) — *(future; secondary-user need,
  explicitly not an MVP goal.)*
- **Additional effector categories beyond patching** (git operations as first-class tools,
  package-manager actions, language-server/AST-driven refactor tools as new tool types) — *(future;
  the five MVP tools — including apply-patch — are sufficient to close the loop. NB: AST-aware /
  git-aware **refinements of the existing apply-patch tool** are V1, not here; this entry is about
  genuinely new effector categories.)*
- **Multi-provider / multi-model support** beyond Anthropic — *(future; conflicts with the locked
  Anthropic-SDK constraint for MVP.)*

---

## Out of Scope

Things the project will not do; explicit to prevent silent re-inclusion.

- **GUI / TUI / web dashboard** — explicitly excluded *(form-factor constraint: CLI run locally; not
  a GUI, web service, or hosted platform.)*
- **Hosted / multi-tenant service** — explicitly excluded *(requirements: "developer tool used
  locally, not a hosted multi-tenant service.")*
- **Offline operation for live runs** — explicitly excluded *(constraint: requires a valid Anthropic
  API key + network; harness is testable offline, but live runs are not offline.)*
- **Write or command execution outside the working root** — explicitly excluded by design *(REQ-021;
  non-negotiable. Reads outside the root are *allowed* by the read-anywhere decision — that is in
  scope, not out.)*
- **Auto-applying edits / auto-running arbitrary commands by default** — explicitly excluded as a
  default *(REQ-012 confirm-each, REQ-016 non-allowlisted-confirm; `--yes`/`--auto` is an opt-in
  override, never the default posture.)*

---

## Non-Goals

Outcomes the project is not trying to achieve (intent, not just deferral).

- **Be a general autonomous agent** — Autocoder targets well-scoped, test-verifiable coding tasks;
  the 70% target is on seeded, test-backed tasks, not arbitrary open-ended work.
- **Guarantee task success** — the goal is a trustworthy bounded loop, not a 100% solver; failing
  cleanly within ceilings and surfacing diffs is success at the harness level.
- **Replace human code review** — every mutation is a reviewable diff *because* the developer remains
  the approver; the tool augments, it does not bypass, review.
- **Maximize speed / minimize tokens** — correctness anchored to the repo's tests and safety come
  first; performance tuning is not an MVP objective beyond the cost ceiling.

---

## Scope Risks

Each traceable to a REQ-ID or confirmed decision.

- **SCOPE-RISK-001** — *Five-tool line creep.* The confirmed MVP effector surface is exactly FIVE
  tools (read, list/search, write/edit, run-command, apply-patch — REQ-006…REQ-009, REQ-023). Chasing
  the 70% benchmark by going **past** that line — AST-aware edits, git ops, package-manager tools as
  new effectors — before the five-tool loop is solid expands build effort and test surface. Hold the
  line at five; AST/git **refinements of apply-patch** are V1, new effector categories are Future.
  Related: REQ-006…REQ-009, REQ-023, Success Criteria (70%).
- **SCOPE-RISK-002** — *Transcript/observability ballooning.* The durable run transcript and its
  observability guarantee (REQ-022, REQ-NFR-008) are now **in MVP** — so the risk is no longer
  "pressure to pull it in" but the layer **ballooning beyond an append-only run log**: structured
  query/search UIs, log shipping, retention/rotation policies, dashboards. MVP scope is a durable,
  inspectable append-only transcript sufficient to reconstruct the run — nothing more. Related:
  REQ-022, REQ-NFR-008.
- **SCOPE-RISK-003** — *Approval-policy erosion.* Convenience pressure to make `--yes`/`--auto` (or a
  wide allowlist) the default would breach the confirmed safety posture and the data-integrity
  blast-radius flag. Related: REQ-012, REQ-016, REQ-021, REQ-NFR-005 (confirmed decisions OQ-2/OQ-3).
- **SCOPE-RISK-004** — *Benchmark scope inflation.* The 70% success bar invites adding "just one more
  task type" to the benchmark or repo-context features (deeper indexing, embeddings) into MVP.
  Related: REQ-003, Success Criteria.
- **SCOPE-RISK-005** — *Cross-platform tax.* Windows path/shell differences (REQ-NFR-007) can quietly
  expand MVP effort, especially in run-command and root-confinement (REQ-021) — risk of either
  over-scoping platform work or under-testing it. Related: REQ-NFR-007, REQ-009, REQ-021.
- **SCOPE-RISK-006** — *"One task per run" pull toward batch/cross-run sessions.* User demand for
  multi-task queueing or cross-run memory could pull Future-scope items into MVP. (Resumable
  **single-task** continuation is the V1 boundary — only that narrow case, built on the now-MVP
  transcript, is the committed next increment; broader batch/cross-run remains Future.) Related:
  REQ-001, REQ-014, REQ-022 (Assumptions: one-task-per-invocation, no cross-run memory).

---

## User-Confirmed Decisions

> Status: **FINALIZED at the scope sign-off gate (2026-06-09).** All rows below are human-confirmed;
> there are no PROPOSED rows. The 2026-06-09 gate **expanded** the MVP from the earlier four-tool /
> deferred-transcript draft to the five-tool / transcript-in-MVP shape recorded here.

| Decision | Confirmed by | Affects |
|---|---|---|
| MVP = the full closed agent loop, single task per run, carrying **ALL** functional REQs (REQ-001…REQ-025) and all NFRs (REQ-NFR-001…008) | human (scope sign-off, 2026-06-09) | MVP Scope · REQ-001…REQ-025 · REQ-NFR-001…008 |
| The MVP effector surface is **FIVE tools**: read (REQ-006), list/search (REQ-007), write/edit (REQ-008), run-command (REQ-009), and **apply-patch (REQ-023)** | human (scope sign-off, 2026-06-09) | MVP Scope · REQ-006…REQ-009 · REQ-023 |
| **Promote** the durable run-transcript **file** (REQ-022) and its observability guarantee (REQ-NFR-008) **into MVP** — the data-integrity blast radius makes an auditable on-disk transcript core; MVP visibility = streamed progress (REQ-017) + transcript (REQ-022) + final summary (REQ-019) | human (scope sign-off, 2026-06-09) | MVP Scope · REQ-022 · REQ-NFR-008 · REQ-017 · REQ-019 |
| **Promote** machine-readable `--json` output (REQ-024) **into MVP**; MVP scriptability = exit-code contract (REQ-020) + structured `--json` summary (REQ-024) | human (scope sign-off, 2026-06-09) | MVP Scope · REQ-024 · REQ-019 · REQ-020 |
| **Promote** the full allowlist-management UX — inspect / add / remove (REQ-025) — **into MVP** (was "polished allowlist UX = V1"); changes persist to config (REQ-018) | human (scope sign-off, 2026-06-09) | MVP Scope · REQ-025 · REQ-016 · REQ-018 |
| Confirm-each edits + allowlist-auto-run/non-allowlisted-confirm commands + read-anywhere/write-exec-in-root + iterations 25 / token budget ≈ 1M (carried from requirements OQ-1…OQ-4, already human-gated at requirements; re-affirmed at scope sign-off) | human (scope sign-off, 2026-06-09) | MVP Scope · REQ-012 · REQ-016 · REQ-021 · REQ-015 |
| V1 is intentionally thin post-sign-off: only AST/git-aware **refinements of apply-patch** (extends REQ-023) and **resumable single-task continuation** (extends REQ-014/REQ-022); no new scope invented to backfill V1 | human (scope sign-off, 2026-06-09) | V1 Scope · REQ-023 · REQ-014 · REQ-022 |
| Out of scope: GUI/TUI, hosted service, offline live runs, write/exec outside root, auto-yes-by-default. Future (uncommitted): cross-run memory / multi-run sessions, batch/queue, parallel tools, multi-provider, new effector categories beyond patching, full unattended-CI | human (scope sign-off, 2026-06-09) | Out of Scope · Non-Goals · Future Scope |
