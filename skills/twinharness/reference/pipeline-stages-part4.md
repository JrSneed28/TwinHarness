# TwinHarness Pipeline Stages — Part 4: Downstream Stages (ADRs through Test Strategy) (part of the TwinHarness orchestrator playbook)

This file contains the downstream stages that follow Architecture in the engaged pipeline:
Stage 5 (ADRs, T3), Stage 6 (Technical Design, T3), Stage 7 (Contracts, T2/T3),
Stage S (Security, T3/blast-radius), Stage F (Failure Modes, T3/reliability-critical),
and Stage 8 (Test Strategy, T2/T3). It is part of the pipeline-stages reference; see
[pipeline-stages.md](pipeline-stages.md) for the index.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## Downstream stages — complete tier pipeline

After Architecture, the engaged stages that follow depend on the chosen tier. All stage sequences
below are defined by spec §5/§13; the numbered stages match the full pipeline table (§13).

---

### Stage 5 — Architecture Decision Records (T3 only) → `docs/05-adrs/`

Skip this stage for T1 and T2. For T3, delegate to the **Spec agent in `adr` mode** with the
`templates/05-adr.md` skeleton (§15.5).

The agent scans the architecture and the human-gated style choices for decisions that are
significant and costly to reverse, drafts one ADR per decision, and links every ADR to the REQ-IDs
and components it serves. Streams; only genuinely irreversible decisions reach the human (§8).

**Critic loop (adr mode).** Route the draft to the **Critic agent in `adr` mode**, fresh context,
same producer→critic mechanic:

- Check `th revise status adr --json` → if `escalate: true`, surface open grounded issues to the
  human and stop (cap reached, default 3 rounds).
- Critic **PASS** → proceed to artifact registration. Zero issues is a valid, celebrated terminal
  state.
- Critic **FAIL** → run `th revise bump adr`, route grounded defects back to the Spec agent,
  re-run. Repeat until PASS or escalation.

Once the Critic passes, register and advance state:

```
th artifact register docs/05-adrs/ --version 1
th state set current_stage adrs
```

---

### Stage 6 — Detailed Technical Design (T3 only) → `06-technical-design.md`

Skip this stage for T1 and T2. For T3, delegate to the **Spec agent in `technical-design` mode**
with the `templates/06-technical-design.md` skeleton (§15.6).

The agent specifies internal behavior the architecture left abstract: workflows, algorithms, state
machines, error handling, concurrency, retries, idempotency. It stops where code is clearer than
prose. Streams; asks the human only where a behavior choice is product-meaningful.

**Standing red-team applies here too (Phase 5, REQ-PCO-050).** This is one of the downstream design
stages the **Red-Team agent (`agents/red-team.md`)** runs CONCURRENTLY against (see the standing
red-team note under Stage 7 — Architecture). Component-anchored attacks it posts to the blackboard
(`th collab fragment`) against the detailed-design fragments must be answered (anchored mitigation)
or converted to drift/debate. The human security gate at Stage S is unchanged and never streamed.

**Summaries handoff (§9).** The Spec agent reads Summary blocks of `docs/01-requirements.md`,
`docs/04-architecture.md`, and any ADRs in `docs/05-adrs/`. Full artifacts fetched only on demand.

**Critic loop (technical-design mode).** Route the draft to the **Critic agent in
`technical-design` mode**, fresh context:

- Check `th revise status technical-design --json` → if `escalate: true`, surface open grounded
  issues to the human and stop.
- Critic **PASS** → proceed to artifact registration.
- Critic **FAIL** → run `th revise bump technical-design`, route grounded defects back to the Spec
  agent, re-run. Repeat until PASS or escalation.

Once the Critic passes, register and advance state:

```
th artifact register docs/06-technical-design.md --version 1
th state set current_stage technical-design
```

---

### Stage 7 — Contracts (T2, T3) → `07-contracts.md`

Skip this stage for T1. For T2 and T3, delegate to the **Spec agent in `contracts` mode** with
the `templates/07-contracts.md` skeleton (§15.7).

**Summaries handoff (§9).** The Spec agent reads Summary blocks of `docs/01-requirements.md`,
`docs/04-architecture.md`, `docs/03-domain-model.md` (T2/T3), and (for T3)
`docs/06-technical-design.md`. Full artifacts fetched only on demand.

The agent derives contracts from architecture + domain model: each interface's
inputs/outputs/errors, typed and constrained schemas, event shapes, versioning expectations,
anchored to REQ-IDs and slices. Streams; surfaces product-affecting choices to the human.

**Standing red-team applies here too (Phase 5, REQ-PCO-050).** Contracts is one of the downstream
design stages the **Red-Team agent (`agents/red-team.md`)** runs CONCURRENTLY against (see the
standing red-team note under Stage 7 — Architecture). Component-anchored attacks it posts to the
blackboard (`th collab fragment`) against in-flight contract fragments — e.g. an interface that
leaks a trust boundary, an unvalidated input shape, a missing authz check on a typed endpoint —
must be answered with an anchored mitigation or converted to a drift/debate entry. This runs
alongside (not instead of) the auth human gate below and the Stage S human security gate, both of
which are unchanged and never streamed.

**Auth decisions are blast-radius — human gate required (§8, §15.7).** If any auth scheme
(authentication or authorization model, token structure, permission boundaries) surfaces as a
contract choice, it must go to a **AskUserQuestion** gate before proceeding. Do not assume; do not
auto-select an auth model.

**Critic loop (contracts mode).** Route the draft to the **Critic agent in `contracts` mode**,
fresh context:

- Check `th revise status contracts --json` → if `escalate: true`, surface open grounded issues to
  the human and stop (cap reached).
- Critic **PASS** → proceed to artifact registration. Zero issues is a valid terminal state.
- Critic **FAIL** → run `th revise bump contracts`, route grounded defects back to the Spec agent,
  re-run. Repeat until PASS or escalation.

Once the Critic passes and any auth gates are cleared, register and advance state:

```
th artifact register docs/07-contracts.md --version 1
th state set current_stage contracts
```

---

### Stage S — Security & Threat Modeling (T3 / any blast-radius project) → `08a-security-threat-model.md`

**Default (T1/T2):** Security is a folded section inside `docs/04-architecture.md`. Do not
produce a standalone artifact unless the project is T3 or carries a blast-radius flag.

**Graduated stage (T3 / blast-radius):** for projects handling auth, money, sensitive data, or
migrations, this section graduates to its own stage and file. Delegate to the **Spec agent in
`security` mode** with the `templates/08a-security-threat-model.md` skeleton (§15.S).

**Summaries handoff (§9).** The Spec agent reads Summary blocks of `docs/04-architecture.md`,
`docs/07-contracts.md`, and `docs/03-domain-model.md`. Full artifacts fetched only on demand.

The agent identifies assets and trust boundaries, enumerates grounded threats at each boundary,
defines the authn/authz model, lists abuse cases, and maps concrete mitigations to components and
REQ-IDs. **Anti-boilerplate rule (§15.S):** every threat must point at a specific component,
boundary, or data flow in this system; generic checklist items with no anchor are discarded and
the Critic will reject them.

**Standing red-team feeds this stage (Phase 5, REQ-PCO-050).** The **Red-Team agent
(`agents/red-team.md`)** has been running CONCURRENTLY against Architecture/Technical-Design/
Contracts (see the standing red-team note under Stage 7). The grounded, component-anchored attacks
it posted to the blackboard (`th collab fragment`) are inputs to this threat model: every
unanswered attack is either a threat to enumerate here (anchored to its component/boundary, per the
anti-boilerplate rule above) or a resolved mitigation to record. The standing red-team accelerates
and grounds the security artifact; it does **not** alter the gate below.

**Human gate on the security model and every auth decision (§8, §15.S — blast-radius).**
Surface the completed security model to the human via **AskUserQuestion** before proceeding.
Any auth decision (authentication flows, authorization model, trust boundaries) is blast-radius
and must have explicit human approval. Do not stream past auth without a gate. **This human gate is
unchanged by the standing red-team and is NEVER streamed** — the concurrent adversary informs the
model, but only a human signs off on the security model and auth decisions (§8).

**Critic loop (security mode).** Route the draft to the **Critic agent in `security` mode**,
fresh context:

- Check `th revise status security --json` → if `escalate: true`, surface open grounded issues to
  the human and stop (cap reached).
- Critic **PASS** → proceed to human gate (required — see above). Zero issues is a valid terminal
  state.
- Critic **FAIL** → run `th revise bump security`, route grounded defects back to the Spec agent,
  re-run. Repeat until PASS or escalation.

After human approval, register and advance state:

```
th artifact register docs/08a-security-threat-model.md --version 1
th state set current_stage security
```

---

### Stage F — Failure Modes & Edge Cases (T3 / reliability-critical) → `08b-failure-edge-cases.md`

**Default (T1/T2):** Failure modes is a folded section inside `docs/04-architecture.md`. Do not
produce a standalone artifact unless the project is T3 or reliability-critical.

**Graduated stage (T3 / reliability-critical):** for systems requiring formal failure-mode
design, this section graduates to its own stage and file. Delegate to the **Spec agent in
`failure-modes` mode** with the `templates/08b-failure-edge-cases.md` skeleton (§15.F).

**Summaries handoff (§9).** The Spec agent reads Summary blocks of `docs/04-architecture.md`,
`docs/06-technical-design.md` (T3), and `docs/07-contracts.md`. Full artifacts fetched only on
demand.

The agent walks each component and boundary for failure scenarios and defines expected behavior
(fail-closed/open, retry/backoff, idempotency, compensation), anchoring each to negative tests in
the test strategy. **Anti-boilerplate rule (§15.F):** each failure mode is tied to a specific
component or flow; generic "handle errors gracefully" entries are discarded.

**Standing red-team feeds this stage too (Phase 5, REQ-PCO-050).** Failure-Modes is one of the
downstream design stages the **Red-Team agent (`agents/red-team.md`)** runs CONCURRENTLY against
(see the standing red-team note under Stage 7 — Architecture). The grounded, component-anchored
attacks it posts to the blackboard (`th collab fragment`) against the in-flight design — an abuse
that drives a component to a data-loss state, a missing fail-closed path on a boundary — are inputs
here: each unanswered attack is either a failure mode to enumerate (anchored to its component/flow,
per the anti-boilerplate rule above) or a resolved mitigation to record, or it converts to a
`th drift add` / `th debate add` entry. The concurrent adversary grounds the failure model; it does
not move the data-loss-tradeoff human gate below, and the security model's human gate (Stage S) is
unchanged and never streamed.

Streams. Escalates where a failure-handling choice involves a data-loss tradeoff — that is
blast-radius and requires a human gate (§8).

**Critic loop (failure-modes mode).** Route the draft to the **Critic agent in `failure-modes`
mode**, fresh context:

- Check `th revise status failure-modes --json` → if `escalate: true`, surface open grounded
  issues to the human and stop (cap reached).
- Critic **PASS** → proceed to artifact registration. Zero issues is a valid terminal state.
- Critic **FAIL** → run `th revise bump failure-modes`, route grounded defects back to the Spec
  agent, re-run. Repeat until PASS or escalation.

Register and advance state:

```
th artifact register docs/08b-failure-edge-cases.md --version 1
th state set current_stage failure-modes
```

---

### Stage 8 — Test Strategy (T2, T3) → `08-test-strategy.md`

Skip this stage for T1. For T2 and T3, delegate to the **Spec agent in `test-strategy` mode**
with the `templates/08-test-strategy.md` skeleton (§15.8).

**Summaries handoff (§9).** The Spec agent reads Summary blocks of `docs/01-requirements.md`,
`docs/07-contracts.md`, and (for T3) `docs/08b-failure-edge-cases.md`. Full artifacts fetched only
on demand.

The agent defines the test pyramid, assigns each REQ-ID at least one verifying test, and defines
per-slice acceptance tests. It specifies what "done" means mechanically. Streams; asks the human
about quality bars only where they are real tradeoffs (coverage targets, performance SLOs).

**Critic loop (test-strategy mode).** Route the draft to the **Critic agent in `test-strategy`
mode**, fresh context:

- Check `th revise status test-strategy --json` → if `escalate: true`, surface open grounded
  issues to the human and stop (cap reached).
- Critic **PASS** → proceed to artifact registration. Zero issues is a valid terminal state.
- Critic **FAIL** → run `th revise bump test-strategy`, route grounded defects back to the Spec
  agent, re-run. Repeat until PASS or escalation.

Register and advance state:

```
th artifact register docs/08-test-strategy.md --version 1
th state set current_stage test-strategy
```
