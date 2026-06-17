# TwinHarness Pipeline Stages — Reference Index (part of the TwinHarness orchestrator playbook)

This file is the **index** for the full per-stage design-stage walkthroughs. Each part file
covers a logical group of stages and is read on demand by the Orchestrator when entering those
stages. Every `th` command, §-citation, and behavioral rule in the part files is canonical.

> **Running `th`:** wherever a part file says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## How to navigate

Load the part file for the stage you are entering. Do not load all parts at once — each is
fetched on demand to keep context bounded.

| Part | Stages covered | Load when |
|------|----------------|-----------|
| [pipeline-stages-part1.md](pipeline-stages-part1.md) | Critic loop boilerplate · Brownfield adaptations · Librarian standing service (REQ-PCO-060) · Stage 4 (Scope) · Stage 5 (Stop-gate) · Stage 6 (Domain Model) | Entering Scope, Domain Model, or any stage needing the boilerplate/Librarian reference |
| [pipeline-stages-part2.md](pipeline-stages-part2.md) | Stage 7 (Architecture) with Debate mode (REQ-PCO-043) and standing Red-Team (REQ-PCO-050) · Stage 7b (UI Design) | Entering Architecture or UI Design |
| [pipeline-stages-part3.md](pipeline-stages-part3.md) | Stage 9 (Implementation Planning & Vertical Slicing) with parallelism-optimizer loop (REQ-PCO-030) and soft dependencies (REQ-PCO-070) | Entering the slice-planning stage |
| [pipeline-stages-part4.md](pipeline-stages-part4.md) | Stage 5/ADRs (T3) · Stage 6/Technical Design (T3) · Stage 7/Contracts (T2, T3) · Stage S/Security (T3/blast-radius) · Stage F/Failure Modes (T3/reliability-critical) · Stage 8/Test Strategy (T2, T3) | Entering any downstream design stage after Architecture |

---

## Quick-reference: key REQ-IDs by part

| REQ-ID | Topic | Part |
|--------|-------|------|
| REQ-PCO-060 | Librarian standing service | [Part 1](pipeline-stages-part1.md) |
| REQ-PCO-043 | Debate mode (Reconciler, `th debate`, competing producers) | [Part 2](pipeline-stages-part2.md) |
| REQ-PCO-050 | Standing Red-Team (concurrent adversary, `th collab fragment`) | [Part 2](pipeline-stages-part2.md) |
| REQ-PCO-030 | Parallelism-optimizer loop (`th build plan --advise`) | [Part 3](pipeline-stages-part3.md) |
| REQ-PCO-070 | Soft dependencies (`depends_on_soft`, speculative dispatch) | [Part 3](pipeline-stages-part3.md) |
