# TwinHarness Plugin — Implementation Plan

**Status:** APPROVED (plan only) — execution deferred by user (2026-06-09). Consensus: Architect SOUND-WITH-CHANGES → applied; Critic APPROVE (round 1). No source/build/delegation performed.
**Mode:** RALPLAN consensus · `--interactive --deliberate`
**Source spec:** `TwinHarness-Plan.md` (the outline is the requirements/design; this plan is the *build* plan)
**Date:** 2026-06-09

---

## 0. What we are building

TwinHarness is the "Agentic SDLC Orchestrator" described in the outline, packaged as a **Claude Code plugin**. The
deliverable is a distributable plugin (manifest + skills + agents + templates + a small deterministic CLI + hooks)
that drives a vague idea through tier-scaled SDLC stages, producing governing artifacts and slice-by-slice builds.

The outline is treated as the **frozen spec** for *what* TwinHarness does. This document plans *how* to build it.
We self-host TwinHarness's own vertical-slice method to build TwinHarness.

---

## 1. RALPLAN-DR Summary

### Principles (sticky design commitments for the build)
1. **Mechanical truths get code; judgment gets prompts.** State, anchors, hashing, traceability, coverage,
   cascade-staleness are deterministic CLI operations (testable). Tiering/clarification/critique are prompts. This
   is the outline's §11 "instructions are not enforcement" applied to our own build.
2. **Self-host vertical slicing.** Build a walking skeleton first (one stage end-to-end + state spine), then thin
   slices. Never "all agents first, then all stages."
3. **Portability is a feature, not an afterthought** (§19). Pure Claude Code plugin; the only runtime dep is Node
   (already required by the ecosystem); no IDE/cloud lock-in.
4. **The CLI is independently testable.** Every mechanical operation has unit tests with REQ-ID-anchored names —
   so the build verifies the way the product demands products be verified.
5. **Narrow by sequencing, not by deferral.** Scope is locked to full Tier 0–3 in one milestone, so we narrow risk
   through *build order*: Slices 0–6 (the Tier 0/1/2 spine) are hard gates that must be green before Slice 7 (Tier 3
   extras + parallel builds) begins. The milestone is large; the slice gates keep it from being a horizontal blob.

### Decision Drivers (top 3)
1. **Enforcement fidelity vs. build speed** — how much is deterministic code vs. prompt instruction. The outline's
   entire thesis is that prompts don't enforce; honoring it costs build effort.
2. **Greenfield build sequencing** — prove the spine end-to-end early, or build breadth-first.
3. **Mechanical-layer runtime** — Node/TypeScript vs. Python vs. pure-prompt. Affects portability, Windows support,
   and how the plugin ships.

### Viable Options

**Option A — Pure-prompt plugin (markdown only).**
- *Pros:* Fastest; zero runtime deps; maximally portable; pure-native.
- *Cons:* Directly violates §11 — traceability/state/anchors become LLM-maintained and will drift; state.json
  hand-edited by an LLM is fragile; the product's own central thesis is broken in its implementation. **Rejected.**

**Option B — Hybrid: prompt orchestration + deterministic CLI (`th`) for mechanical operations. ★ RECOMMENDED**
- Skills/agents encode the SDLC; a small TypeScript CLI owns `state.json`, drift-log appends, content hashing,
  REQ-anchor scanning, traceability rendering, coverage-map checks, cascade-stale marking; hooks wire the stop-gate.
- *Pros:* Honors §11; deterministic + unit-testable; state integrity guaranteed; the build can be verified the way
  the product prescribes.
- *Cons:* More to build; Node runtime dep; cross-platform care needed (Windows-first user).

**Option C — Full standalone engine + thin plugin shell.**
- State machine + agent invocation reimplemented in code via the Agent SDK; plugin is a wrapper.
- *Pros:* Most robust; runs outside Claude Code.
- *Cons:* Reimplements orchestration Claude Code already gives us; massive scope; contradicts §19 ("the process is
  the product, not a bundled toolchain"). **Rejected as over-engineered.**

**Invalidation rationale:** A and C are documented above as rejected. B is the only option that satisfies Principle 1
(mechanical enforcement) without violating Principle 3 (portability) — A fails the former, C fails the latter.

### Pre-mortem (deliberate mode — 3 failure scenarios)
1. **"The CLI scope balloons into a framework."** The mechanical layer keeps absorbing orchestration logic until
   we've built Option C by accident. → *Mitigation:* a hard CLI surface contract (§5) — the CLI never decides
   *which* stage/agent/tier; it only records and computes. Any "decide" verb is a prompt, not a command.
2. **"The plugin works in our test session but the artifacts/state drift in real use."** The stop-gate or
   state writes aren't actually enforced, so the orchestrator skips them under context pressure. → *Mitigation:*
   a Stop/PreToolUse hook that blocks "stage complete" claims unless `th state verify` passes; Slice 0 proves the
   gate fires.
3. **"Self-hosting stalls — TwinHarness can't build TwinHarness because the spine isn't ready."** We try to use the
   process before the skeleton exists. → *Mitigation:* Slice 0 is built **by hand** (not via TwinHarness); only
   after Slice 0 + state CLI are green do we optionally self-host later slices. Self-hosting is a validation bonus,
   never a build dependency.
4. **"Over-building before the spine is proven."** Because scope is locked to full Tier 0–3 in one milestone, the
   temptation is to build Tier 3 stages (security, failure-modes, parallel builds) before the Tier 0/1/2 spine is
   demonstrably working — recreating the horizontal-blob failure the product exists to prevent. → *Mitigation:*
   Slices 0–6 are **hard gates** (each slice's acceptance tests green) before Slice 7 starts; the §4 vertical order
   is contractually binding even though everything ships in one milestone, so the deliverable degrades gracefully
   if Tier 3 slips.

### Expanded Test Plan (deliberate mode)
- **Unit (CLI core):** state read/write/verify, content hashing determinism, REQ-anchor scanner (find `REQ-\d+`
  across docs/tests/code), traceability renderer, coverage-map gap detector, cascade-stale marker, drift-log
  append/parse. Test names carry REQ-IDs from the outline (e.g. `test_REQ_state_idempotent_resume`).
- **Integration:** skill→agent→artifact→state for one stage; Critic revise-loop cap (3 → escalate); tier
  classifier on fixture briefs (Tier 0 classifier all-5-conditions, blast-radius veto cases).
- **End-to-end (per slice acceptance, self-hosted fixtures):** run a tiny Tier-1 brief ("build a CLI todo") through
  requirements→scope→slice→build→verify against a golden artifact set; assert state transitions + traceability view.
  Plus a **Tier-3 golden fixture** (blast-radius brief) that drives the `adr`/`technical-design`/`security`/
  `failure-modes` stages and the parallel-build serialization check (Slice 7 acceptance).
- **Observability:** every CLI command emits a structured log line; `th state status` renders current tier, stage,
  open blocking drift, revise-loop counts; a `--json` mode for all commands so hooks/tests parse deterministically.
- **Failure/negative:** blast-radius brief (auth) must refuse Tier 0; requirement-contradiction drift must produce
  a BLOCKING escalation, not auto-apply; partial artifact write must be replaced not duplicated on resume.

---

## 2. Target plugin architecture (deliverable)

```
twinharness/                         (plugin root / repo root)
  .claude-plugin/
    plugin.json                      # manifest: skills, agents, commands, mcpServers(none yet), hooks
  skills/
    twinharness/SKILL.md             # Orchestrator entrypoint (controller). /twinharness <idea>
    th-status/SKILL.md               # render state + traceability on demand (optional, can be a command)
  agents/
    orchestrator.md                  # tier/blast-radius classify, routing, gates, state ownership
    spec.md                          # modal: requirements|scope|domain-model|architecture|adr|
                                     #        technical-design|contracts|test-strategy|security|failure-modes
    vertical-slice.md                # fresh-context slice decomposition
    builder.md                       # write code+tests, run checks, drift write-back
    critic.md                        # modal: requirements|architecture|slice|code-review|... fresh context
  commands/
    twinharness.md                   # /twinharness — start/resume orchestration
    th-status.md                     # /th-status — state + traceability view
    th-drift.md                      # /th-drift — review/ratify async derived-layer drift
    th-escalate.md                   # surface blocking escalations
  templates/                         # artifact skeletons the Spec agent fills (Summary block + sections)
    00-project-summary.md  01-requirements.md  02-scope.md  03-domain-model.md
    04-architecture.md  05-adr.md  06-technical-design.md  07-contracts.md
    08-test-strategy.md  08a-security-threat-model.md  08b-failure-edge-cases.md
    09-implementation-plan.md  10-verification-report.md  task-file.md  drift-log.md
  bin/ (or src/ + dist/)
    th                               # deterministic CLI (TypeScript, compiled) — the mechanical layer
  hooks/
    hooks.json                       # Stop/PreToolUse gate wiring -> `th state verify`
  src/                               # CLI source (TypeScript)
  tests/                             # CLI unit/integration + golden e2e fixtures
  package.json  tsconfig.json  README.md
```

### Mapping outline concepts → plugin parts
| Outline concept | Built as |
|---|---|
| Orchestrator (§6.1) | `twinharness` SKILL + `orchestrator` agent; owns state via `th` CLI |
| Spec agent + modes (§6.2) | one `spec.md` agent, mode passed as arg; one template per mode |
| Vertical Slice agent (§6.3) | `vertical-slice.md` (real agent, fresh context) |
| Builder (§6.4) | `builder.md` (write/test tools) |
| Critic + modes (§6.5, §7) | one `critic.md`, mode arg, fresh context, grounded-critique rules, 3-round cap |
| Tier model + Tier-0 classifier (§5) | classifier prompt in orchestrator + advisory `th tier classify`; blast-radius **veto is mechanical** via `th tier veto-check` (exit-code gate) |
| State.json (§18) | `th state` subcommands; schema from §18 |
| Drift log (§10) | `th drift add`/`list`; append-only `drift-log.md` |
| REQ-ID anchors + tests-as-contract (§11) | `th anchors scan`, test-name convention, CI-style check |
| On-demand traceability (§17) | `th trace render` — scans anchors, never a stored matrix |
| Cascade re-verification (§18) | `th state stale --since <hash>` marks downstream |
| Human gates vs interrupt (§8) | orchestrator gate prompts + AskUserQuestion at the 5 hard gates |

---

## 3. CLI surface contract (`th`) — the mechanical layer

The CLI **records and computes; it never decides**. Every command is deterministic and has `--json`.

- `th init` — scaffold `docs/`, `.agentic-sdlc/state.json`, `drift-log.md`.
- `th state get|set|status|verify` — read/patch/render/validate state.json (schema-checked).
- `th artifact register <file> --version N` — content-hash + record approved artifact.
- `th anchors scan [--reqs|--tests|--code]` — find/validate `REQ-\d+` anchors across the tree.
- `th trace render` — render the on-demand traceability view (REQ → design → contract → slice/task → test → code).
- `th coverage check` — assert every MVP REQ-ID maps to ≥1 slice and ≥1 test; report gaps.
- `th drift add|list` — append/parse drift-log entries; flags blocking vs derived.
- `th stale --since <hash>` — diff an upstream summary, mark downstream artifacts stale.
- `th tier classify <brief.json>` — **advisory** tier suggestion + detected blast-radius flags (the
  human/orchestrator still decides the *tier number*; this is judgment).
- `th tier veto-check <brief.json>` — **mechanical, not advisory.** Returns a hard fail (non-zero exit + `--json`
  `{"blocked":true,"flags":[...]}`) when any blast-radius flag (auth, authorization, data integrity, money/billing,
  migrations) is present, forbidding Tier 0. This is a *mechanical truth* (outline §5 veto), so it is enforced as an
  exit-code gate wired into the Stop/PreToolUse hook alongside `th state verify` — never left to a prompt to honor.

**Boundary rule (pre-mortem #1 mitigation):** no `th` verb may select a stage, spawn an agent, or advance the
workflow. Those are prompt/orchestrator responsibilities. The one safety exception is the *veto floor*: `veto-check`
does not pick a tier, it only forbids Tier 0 when a blast-radius flag is present — enforcing a floor, not deciding.

---

## 4. Build sequence — self-hosted vertical slices

**Slice 0 — Walking skeleton (built by hand).** plugin.json + minimal `twinharness` SKILL that runs a Tier-1 path:
requirements stage (Spec agent, template) → write `01-requirements.md` → `th init` + `th state set` → human gate via
AskUserQuestion → stop. Proves the spine: skill → agent → artifact → state → gate. CLI has `init`, `state get/set`.
*Acceptance:* invoking `/twinharness "build a CLI todo"` produces a requirements artifact, a valid state.json at
stage `requirements`, and fires the human approval gate. Stop-gate hook blocks premature "done".

**Slice 1 — Critic loop + grounded-critique discipline.** Add `critic.md` (requirements mode), producer→critic
revise loop, 3-round cap → escalate, zero-issues-is-pass. *Acceptance:* a deliberately incoherent requirements
draft yields ≥1 grounded defect, revises, passes; a forced-conflict draft escalates at round 3.

**Slice 2 — Scope stage + tier classifier + Tier-0 bypass + blast-radius veto.** Spec `scope` mode, second human
gate, `th tier classify`. *Acceptance:* trivial brief → Tier 0 (no docs); auth brief → veto to ≥Tier 1; normal brief
→ Tier 2.

**Slice 3 — Architecture + domain model stages (Tier 2 path) + summaries handoff.** Spec `domain-model` +
`architecture` modes (streams, no gate except the 1–2 irreversible calls), summary-block convention, link-out
master index. *Acceptance:* Tier-2 brief reaches an architecture artifact; downstream stages consume summaries only.

**Slice 4 — Vertical Slice agent + Stage 9 plan + coverage map.** `vertical-slice.md`, `09-implementation-plan.md`,
`th coverage check`, slice-mode Critic. *Acceptance:* a design yields ordered slices with a true Slice 0 walking
skeleton and full MVP REQ coverage; slice-Critic rejects a disguised horizontal layer.

**Slice 5 — Builder + tests-as-contract + bidirectional drift.** `builder.md`, REQ-anchored tests, `th anchors
scan`, `th drift add`, derived-drift auto-write-back vs requirement-drift blocking escalation. *Acceptance:* a slice
builds with passing anchored tests; a simulated derived discovery auto-updates a doc + logs; a requirement
contradiction blocks + escalates.

**Slice 6 — Final verification + on-demand traceability + cascade re-verify.** `10-verification-report.md`,
`th trace render`, `th stale`. *Acceptance:* traceability view renders from anchors; bumping an upstream artifact
marks downstream stale and re-runs Critic only against the diff.

**Slice 7 — Tier 3 extras (in this milestone, built last).** ADRs, detailed technical design, security threat-model
stage, failure-modes stage, parallel disjoint-slice builds. Graduated stages + anti-boilerplate Critic modes.
*Acceptance (end-to-end, mechanically checkable, matching the other slices):*
(a) a **Tier-3 golden-fixture e2e brief** (e.g. a brief carrying a blast-radius flag) drives the `adr` →
`technical-design` → `security` → `failure-modes` stages and produces `05-adrs/`, `06-technical-design.md`,
`08a-security-threat-model.md`, `08b-failure-edge-cases.md`; the **anti-boilerplate Critic** (security/failure modes)
**rejects** a fixture threat/failure that has no component/boundary anchor (outline §15.S/§15.F) and **passes** an
anchored one; `th coverage check` confirms each abuse case / failure mode maps to a negative test;
(b) a **parallel-build test** asserts `th` (via the per-slice `components` field, outline §16) **serializes** two
slices with overlapping components and **permits** two disjoint ones.

---

## 5. Scope — DECIDED: full Tier 0–3 in one pass

**User decisions (2026-06-09):** runtime = **TypeScript/Node**; scope = **full Tier 0–3 in one milestone**;
distribution = **local skill install first** (marketplace packaging deferred).

**In scope (Slices 0–7, all required for the milestone):** Tier 0 bypass + classifier + blast-radius veto; Tier 1/2/3
stage pipelines; all 5 agents; the complete Spec mode set including `adr`, `technical-design`, `security`,
`failure-modes`; mechanical CLI spine; Critic loop (all modes, anti-boilerplate for security/failure); bidirectional
drift; on-demand traceability; cascade re-verify; resume-after-crash; parallel disjoint-slice builds.

**Sequencing note (full scope ≠ no order):** even building everything, the slices are still built in the §4 order so
the spine is proven before breadth. Slice 7 (Tier 3 extras + parallel builds) is now *in this milestone*, not
deferred — it is the last slice, not a later release. This raises milestone size and the pre-mortem #4 risk
(over-building before the spine is proven); mitigated by keeping Slice 0 hand-built and gating Slices 1–6 green
before Slice 7.

**Distribution:** iterate as a local plugin/skill under the repo; `.claude-plugin/marketplace.json` and publishing
flow are deferred (not in this milestone).

**Out of scope / Future:** the four §21 open questions (drift-review UX, slice-granularity heuristics, brownfield
slicing, parallel-merge protocol) are tracked as research items, not milestone blockers.

---

## 6. Test strategy (build verification)
- CLI: vitest unit suite, REQ-anchored names, deterministic (hashing fixed, no clock in hashes).
- Agents/skills: golden-fixture e2e — small Tier-1 and Tier-2 briefs, plus a Tier-3 blast-radius brief (driving the
  `adr`/`technical-design`/`security`/`failure-modes` stages and the parallel-build serialization check), with
  expected artifact/state outcomes.
- Hooks: a test that the stop-gate blocks a fabricated "stage complete" when `th state verify` fails.
- Per-slice acceptance criteria above are the Definition of Done; a slice is done when its anchored tests pass.

---

## 7. Risks & mitigations
| Risk | Mitigation |
|---|---|
| CLI scope creep into a framework | Hard CLI boundary contract (§3); "decide" verbs forbidden |
| Windows path/shell issues | CLI is cross-platform Node; tests run on win32; avoid bash-only hooks |
| Prompt enforcement silently skipped | Mechanical stop-gate hook + `th state verify` |
| Over-building Tier 3 before spine proven (pre-mortem #4) | Slices 0–6 are hard gates (acceptance-green) before Slice 7 begins; §4 order is binding |
| Blast-radius prompt override (Principle 1 gap) | `th tier veto-check` exit-code gate in the hook; veto is code, not instruction |
| Self-hosting deadlock | Slice 0 built by hand; self-hosting optional |

---

## 8. ADR — finalized

- **Decision:** Build TwinHarness as a hybrid Claude Code plugin — prompt orchestration (5 agents + Spec/Critic
  modes) + a deterministic **TypeScript** `th` CLI for all mechanical enforcement (Option B). Scope = full Tier 0–3
  in one milestone, built in the §4 vertical-slice order with Slices 0–6 as hard gates before Slice 7. Distribution =
  local skill install first.
- **Drivers:** mechanical-enforcement mandate (outline §11); portability (§19); testable build verification.
- **Alternatives considered:** A (pure-prompt — fails §11, state/traceability drift); C (standalone engine — fails
  §19 portability, reimplements Claude Code orchestration, over-scoped).
- **Why chosen:** only B satisfies mechanical enforcement *and* portability simultaneously; the blast-radius veto is
  promoted to a `th tier veto-check` exit-code gate so the one safety-critical decision is code, not instruction.
- **Consequences:** Node runtime dependency; a `th` CLI surface to maintain and unit-test; a policed CLI/prompt
  boundary (CLI records & computes, never decides). Negative: more upfront build than pure-prompt; large single
  milestone, mitigated by binding slice-gate order (pre-mortem #4).
- **Follow-ups:** the four §21 research items (drift-review UX, slice-granularity heuristics, brownfield slicing,
  parallel-merge protocol); marketplace packaging after local iteration proves the plugin.

---

## Resolved fork points (user decisions, 2026-06-09)
1. **Mechanical-layer runtime** → **TypeScript/Node** (Option B confirmed).
2. **Scope boundary** → **Full Tier 0–3 in one milestone**, narrowed by binding §4 slice order + hard Slice 0–6 gates.
3. **Distribution** → **Local skill install first**; marketplace packaging deferred.
