# TwinHarness Pipeline Stages — Part 2: Architecture & UI Design (part of the TwinHarness orchestrator playbook)

This file contains Stage 7 (Architecture) and Stage 7b (UI Design), including Debate mode
(Phase 4, REQ-PCO-043) and the standing Red-Team (Phase 5, REQ-PCO-050). It is part of the
pipeline-stages reference; see [pipeline-stages.md](pipeline-stages.md) for the index.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## Stage 7 — Architecture (T1 light, T2, T3)

Delegate to the **Spec agent in `architecture` mode** with the `templates/04-architecture.md`
skeleton.

**Summaries handoff (§9).** The Spec agent reads the **Summary blocks** of
`docs/01-requirements.md`, `docs/02-scope.md`, and (if it exists) `docs/03-domain-model.md`.
Full artifacts fetched only on demand.

The agent defines major components, responsibilities, data flow, runtime flow, system boundaries,
external dependencies, and deployment shape. It folds a **Security** section and a
**Failure-Modes** section into the artifact for Tier 1/2 (these graduate to standalone stages in
Tier 3 — §15.S, §15.F). It anchors every component and decision to REQ-IDs (§11).

**Irreversible decisions gate (§8, §14.4).** The bulk of the architecture streams. The agent
surfaces **only the 1–2 genuinely irreversible style decisions** (e.g. sync vs. async backbone,
monolith vs. service split, data-store category) as explicit choices via **AskUserQuestion**.
These are the only blocking gates in this stage. Do not add gates for decisions the user can
change cheaply.

**Critic loop (architecture mode).** Route the draft to the **Critic agent in `architecture`
mode**, fresh context:

- Check `th revise status architecture --json` → if `escalate: true`, surface open grounded
  issues to the human and stop.
- Critic **PASS** → proceed to artifact registration.
- Critic **FAIL** → run `th revise bump architecture`, route grounded defects back to the Spec
  agent, re-run. Repeat until PASS or escalation.

**Debate mode (Phase 4, REQ-PCO-043 — optional augmentation, Pattern B).** Architecture is the other
stage that may run as a **debate** rather than a single draft — it is the highest-leverage stage for
surfacing genuinely competing structures (e.g. monolith vs. service split, sync vs. async backbone)
before the irreversible-decision gates:

1. **Competing producers in fresh contexts.** Spawn 2–3 **Spec agents in `architecture` mode**, each
   in a **fresh, isolated context** (`agents/spec.md` debate-mode addendum). Each produces a
   *competing* architecture for the same stage; independent fresh-context designs surface real
   structural alternatives rather than one anchored design.
2. **Each output is a blackboard fragment** (not the stage artifact). `th collab init --stage
   architecture` once, then each producer writes
   `th collab fragment --stage architecture --round <round> --name <name> --text <...>`. Fragments
   land under `.twinharness/collab/architecture/<round>/`; `th collab merge --stage architecture
   --round <round>` rejects any round with an unanchored fragment (§11 at the fragment boundary).
3. **Reconciler adjudicates.** The **Reconciler agent (`agents/reconciler.md`)** reads the competing
   fragments (`th collab list --stage architecture --round <round>`) and merges them into one
   artifact, recording each contested decision in the **debate ledger** — `th debate add --topic
   <...>` per fork, `th debate list`, `th debate resolve <DEBATE-NNN> --resolution <...>`.
4. **Critic gate on the merge.** Route the merged artifact to the **Critic agent in `debate-reconcile`
   mode**, fresh context, in addition to the normal `architecture` critic checks: it certifies the
   merge is coherent against the competing inputs and the resolved ledger entries, with every
   component still REQ-ID-anchored and no resolved fork silently dropped or contradicted.
5. **Human sees only the distilled forks.** A real, product-meaningful structural divergence the
   Reconciler cannot settle on coherence grounds escalates to the **irreversible-decision human gate**
   above — but the human sees only the **distilled 1–2 forks**, not the full debate. **Recorded
   reconciliations seed ADR drafts** (Stage 5, T3): each resolved ledger entry maps to a candidate
   ADR for the decision it settled.

When **not** run in debate mode, Architecture produces a single draft exactly as above; debate mode
is an Orchestrator-selected augmentation, not the default.

**Standing red-team (Phase 5, REQ-PCO-050).** From the moment the Architecture/Technical-Design/
Contracts stages open, the Orchestrator runs the **Red-Team agent (`agents/red-team.md`)**
CONCURRENTLY with these downstream design stages — it is not a serial gate that waits for a draft
to finish. The Red-Team agent reads the in-flight design fragments and posts **grounded,
component-anchored attacks** to the blackboard as fragments (`th collab fragment`): each attack
names a specific component, boundary, or data flow and an abuse/break it enables — never a generic
checklist item (same anti-boilerplate bar as §15.S). The design agents on these stages must
**answer each posted attack** (mitigation anchored to a component + REQ-ID) or **convert it** into
a `th drift add` entry or a `th debate add` ledger fork when it exposes a real design fork. This is
a continuous adversary running alongside design, not a one-shot review. **The human gate on the
security model is unchanged and is never streamed** — the standing red-team feeds the design and the
security artifact, but it does not move or bypass the blast-radius human gate at Stage S; that gate
still requires explicit human approval (§8, §15.S).

Once the Critic passes and the human has answered any irreversible-decision gates, register and
advance state:

```
th artifact register docs/04-architecture.md --version 1
th state set current_stage architecture
```

**Artifact registration.** After every stage's artifact is approved and registered, its content
hash and version are recorded in `.twinharness/state.json` under `approved_artifacts`. Downstream
stages use this record to detect staleness (`th stale --artifact <file>` — §18).

---

## Stage 7b — UI Design (conditional: only when the project has a user interface)

Skip this stage for projects without a user interface (CLIs, background services, pure API
libraries). For any project with a web UI, mobile UI, desktop UI, or rich TUI, engage Stage 4b
after Architecture is approved and before Contracts/Test Strategy.

Delegate to the **UX/UI Designer agent (`agents/ux-ui-designer.md`) in a FRESH CONTEXT** (§6.3
rationale: user-centered design is contaminated by backend-architecture thinking; fresh context
produces cleaner, user-centered results). The agent runs Stage 4a UX (research/journeys/IA/flows
→ `docs/04a-ux-design.md`) first, then Stage 4b UI (visual/wireframes → `docs/04b-ui-design.md`).

**Human gate on design direction (taste-driven — §2).** The UX/UI Designer presents 2–3 distinct
design directions to the human via `AskUserQuestion` with the `preview` field containing ASCII
mockups side by side. Do not proceed until the human selects a direction. After direction
sign-off, the detailed design streams.

**Critic loop (ui-design mode).** Route the draft to the **Critic agent in `ui-design` mode**,
fresh context:

- Check `th revise status ui-design --json` → if `escalate: true`, surface open grounded issues
  to the human and stop (cap reached, default 3 rounds).
- Critic **PASS** → proceed to artifact registration. Zero issues is a valid terminal state.
- Critic **FAIL** → run `th revise bump ui-design`, route grounded defects back to the UI
  Designer agent, re-run. Repeat until PASS or escalation.

Once the Critic passes, register and advance state:

```
th artifact register docs/04b-ui-design.md --version 1
th state set current_stage ui-design
```

**No second human gate after direction sign-off** — the Critic gates quality. The Vertical
Slice agent (Stage 9) receives the `docs/04b-ui-design.md` Summary block so slices for
UI-bearing projects reference specific screens and flows.
