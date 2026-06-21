# TwinHarness Pipeline Stages — Part 1: Boilerplate, Brownfield, Librarian, Scope/Stop/Domain (part of the TwinHarness orchestrator playbook)

This file contains stages 4 (Scope), 5 (Stop-gate), and 6 (Domain Model), plus cross-cutting
boilerplate and standing services. It is part of the pipeline-stages reference; see
[pipeline-stages.md](pipeline-stages.md) for the index.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## Critic loop boilerplate (used in every stage)

The producer→Critic mechanic is identical in every design stage:

1. Check `th revise status <mode> --json` → if `escalate: true`, surface open grounded issues to
   the human and stop looping (spec §18 cap reached, default 3 rounds).
2. Critic returns **PASS** (zero grounded defects) → proceed. Zero issues is a valid, celebrated
   terminal state — do not invent defects.
3. Critic returns **FAIL** (≥1 grounded defect) → run `th revise bump <mode>`, route grounded
   defects back to the Spec agent, re-run. Repeat until PASS or escalation.

---

## Brownfield adaptations (`project_mode: "brownfield"`)

When the run adopts an existing codebase (`th init --brownfield`), the pipeline overlays reality
instead of starting clean. Three adaptations apply across the stages below:

- **Inspection step before tiering.** Spawn the **Codebase-Inspector agent**
  (`agents/codebase-inspector.md`, fresh context) first. It maps language/build, modules, public
  APIs, the test framework, and any existing blast-radius surfaces (auth, authz, money,
  data-integrity, migrations), emitting source-anchored `docs/00-existing-codebase-analysis.md`.
  Feed its findings to `th tier classify` / `th tier veto-check` — existing blast-radius code the
  new work touches triggers the §5 veto just like new code. Register it after the Critic passes:
  `th artifact register docs/00-existing-codebase-analysis.md --version 1`.
- **Architecture/contracts as an overlay.** The Spec agent acknowledges existing components by path
  (new vs. reused) and treats existing public APIs as constraints, not blanks. It does not redesign
  working, out-of-scope components.
- **Slice 0 is a characterization test.** The Vertical-Slice agent does not build a fresh walking
  skeleton (the system already boots). Slice 0 becomes an end-to-end **characterization** test that
  pins the adoption seam where new work attaches, with existing components untouched (see Stage 9).

---

## Standing services — Librarian (Phase 6, REQ-PCO-060)

The **Librarian agent (`agents/librarian.md`)** is a **long-lived repo-understanding service**, not
a per-stage agent. The Orchestrator stands it up once and keeps it alive across stages; it is the
single owner of the **repo-map + artifact-summary index**.

- **What it owns.** The Librarian maintains the repo map and the index of artifact summaries, built
  and refreshed via `th repo map`, `th repo relevant`, `th repo impact`, and `th context pack`
  (**prefer the typed `mcp__plugin_twinharness_th__*` MCP tools** for these calls — they return
  structured results and resolve `${CLAUDE_PLUGIN_DIR}` from any worktree; see
  `skills/twinharness/reference/mcp-tools.md`). It does not edit artifacts; it indexes and summarizes them.
- **What it answers.** Any agent (Orchestrator, Spec, Builder, Critic, Debugger, Researcher) can ask
  the Librarian **locate** queries ("where does component X live / which files touch REQ-NNN") and
  **summary** queries ("give me the design context for SLICE-3"). It replies with **compact
  capsules** — a few anchored lines plus file/§ pointers — rather than the full artifacts.
- **Why it exists.** The capsule answer is the mechanism that keeps the **main context from
  reloading big artifacts**: instead of pulling a whole design doc or source tree into context, an
  agent asks the Librarian and gets back just the relevant, anchored slice. This complements the
  §9 Summaries-handoff rule — Summaries are the static handoff currency; the Librarian is the live
  query service over the repo and the index.

The Librarian is read-only with respect to artifacts and code; it never gates a stage and never
substitutes for a Critic or a human gate.

---

## Stage 4 — Scope (T1, T2, T3)

Delegate to the **Spec agent in `scope` mode** with the `templates/02-scope.md` skeleton. The
agent reads the approved requirements Summary, recaps goal and success criteria, proposes an MVP,
asks the user to confirm/remove/add, and separates essentials from future features using the two
pruning questions: *"Required for the first usable version?"* and *"Would the project still solve
the core problem without this?"*

**Critic loop (scope mode).** Route the draft to the **Critic agent in `scope` mode**, fresh
context, same producer→critic mechanic (see above):

- Check `th revise status scope --json` → if `escalate: true`, surface open grounded issues to
  the human and stop (cap reached).
- Critic **PASS** → proceed to scope sign-off. Zero issues is a valid terminal state.
- Critic **FAIL** → run `th revise bump scope`, route grounded defects back to the Spec agent,
  re-run. Repeat until PASS or escalation.

Grounded defects for scope: MVP includes items that fail both pruning questions; Out of Scope
omits items explicitly in requirements; scope decisions lack REQ-ID anchors; Future Scope is
indistinguishable from MVP; Scope Risks not traced to specific requirements.

**Scope sign-off gate (sticky — §8).** Advance state (`th state set current_stage scope`) and
present the human gate via AskUserQuestion. Scope is intent; only a human moves it once signed
off (§10). Do not advance until the human approves.

---

## Stage 5 — Stop-gate

Completion is mechanically gated at every stage: the Stop hook runs `th state verify`, so you
cannot truthfully claim "done" while state is invalid or a blocking drift is open.

---

## Stage 6 — Domain Model (T2, T3)

Skip this stage for Tier 1. For Tier 2 and Tier 3, delegate to the **Spec agent in
`domain-model` mode** with the `templates/03-domain-model.md` skeleton.

**Summaries handoff (§9).** The Spec agent reads the **Summary blocks** of
`docs/01-requirements.md` and `docs/02-scope.md` — not the full documents. Full artifacts are
fetched only if a specific detail cannot be resolved from the summary. This is the default for
every stage from here forward.

The agent proposes an initial model first, explains it in plain language, then refines with the
user. It anchors every entity and rule to REQ-IDs (§11).

**Critic loop (domain-model mode).** Route the draft to the **Critic agent in `domain-model`
mode**, fresh context, same producer→critic mechanic:

- Check `th revise status domain-model --json` → if `escalate: true`, surface open grounded
  issues to the human and stop (cap reached, default 3 rounds).
- Critic **PASS** → proceed. Zero issues is a valid, celebrated terminal state.
- Critic **FAIL** → run `th revise bump domain-model`, route grounded defects back to the Spec
  agent, re-run. Repeat until PASS or escalation.

**Debate mode (Phase 4, REQ-PCO-043 — optional augmentation, Pattern B).** For Domain Model the
Orchestrator may run the stage as a **debate** instead of a single draft, when the design space has
genuine competing shapes worth surfacing:

1. **Competing producers in fresh contexts.** Spawn 2–3 **Spec agents in `domain-model` mode**, each
   in a **fresh, isolated context** (`agents/spec.md` debate-mode addendum). Each produces a
   *competing* model for the same stage; fresh context is the mechanism that surfaces real
   alternatives instead of one anchored line of thinking.
2. **Each output is a blackboard fragment** (not the stage artifact). Initialize once with
   `th collab init --stage domain-model`; each producer writes its position with
   `th collab fragment --stage domain-model --round <round> --name <name> --text <...>`. Fragments
   land under `.twinharness/collab/domain-model/<round>/`. `th collab merge --stage domain-model
   --round <round>` mechanically rejects any round containing a fragment with no REQ-ID anchor (§11
   enforced at the fragment boundary).
3. **Reconciler adjudicates.** Spawn the **Reconciler agent (`agents/reconciler.md`)**: it reads the
   competing fragments (`th collab list --stage domain-model --round <round>`) and merges them into
   one artifact, recording every contested decision in the **debate ledger** —
   `th debate add --topic <...>` per fork, `th debate list` to review, `th debate resolve <DEBATE-NNN>
   --resolution <...>` as each is settled.
4. **Critic gate on the merge.** Route the merged artifact to the **Critic agent in `debate-reconcile`
   mode**, fresh context — it certifies the merge is coherent against the competing inputs and the
   resolved ledger entries (no resolved fork silently dropped or contradicted; every concept still
   REQ-ID-anchored). This runs *in addition to* the normal `domain-model` critic checks.
5. **Human sees only the distilled forks.** Genuine, product-meaningful divergences the Reconciler
   cannot settle on coherence grounds escalate to the human — who sees only the **distilled 1–2
   forks**, not the full debate. **Recorded reconciliations seed ADR drafts** downstream (Stage 5,
   T3). When the divergence is a real domain-model fork, it streams as usual once resolved (§8,
   §14.3 — no standing human gate for domain model otherwise).

When **not** run in debate mode, Domain Model produces a single draft exactly as above; debate mode
is an Orchestrator-selected augmentation, not the default.

**No human gate (§8, §14.3).** The domain model streams. The user may interrupt at any point but
is not required to click approve. Once the Critic passes, register the artifact and advance state:

```
th artifact register docs/03-domain-model.md --version 1
th state set current_stage domain-model
```
