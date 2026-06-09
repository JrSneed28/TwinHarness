# Project Summary — <project name>

> **Orientation document.** This file is the master index for all project artifacts (spec §9,
> §12). It is a **link-out index**, not a concatenation — it points to sub-documents rather than
> reproducing their content. Agents and humans navigate here first, then follow links to the
> relevant leaf. Do not paste full artifact content into this file.

## One-liner

<One sentence: what the project is and what it does for its users.>

---

## How to Read This Project

Every artifact in this project opens with a **`## Summary` block** — a compact, 3–6 sentence
description of what that document contains plus two or three key bullets.

**Why this matters (spec §9):** downstream stages and agents consume Summaries by default and
fetch the full artifact only when a detail cannot be resolved from the Summary. This keeps
context windows small and costs low. When you are an agent reading prior work, read the Summary
first; pull the full document only if you genuinely need a detail the Summary does not cover.

**When a Summary changes, downstream stages may need to re-derive.** The Orchestrator tracks
this via `state.json` (see Artifact Versions below).

---

## Artifact Versions

Artifact versions (v1, v2, …) and content hashes are tracked in `.agentic-sdlc/state.json` via
`th artifact register` — they are **not** duplicated here. Consult `state.json` to check whether
a downstream artifact is still coherent with the version of an upstream document it was derived
from.

---

## Artifact Index

### Core SDLC Artifacts

| File | Stage | Purpose |
|---|---|---|
| [01-requirements.md](01-requirements.md) | Stage 1 — Requirements Engineering | Core goal, intended users, REQ-IDs, constraints, success criteria. **Sticky — human-gated.** |
| [02-scope.md](02-scope.md) | Stage 2 — Scope Definition | MVP vs. V1 vs. future vs. out-of-scope. Confirmed user decisions. **Sticky — human-gated.** |
| [03-domain-model.md](03-domain-model.md) | Stage 3 — Domain Modeling | Entities, relationships, attributes, state models, domain rules, events, glossary. Streams. |
| [04-architecture.md](04-architecture.md) | Stage 4 — System Architecture | Components, responsibilities, boundaries, data/runtime flow, deployment shape. Human gate on irreversible decisions only. |
| [05-adrs/](05-adrs/) | Stage 5 — Architecture Decision Records | One ADR per significant irreversible decision. Each links to REQ-IDs and components. |
| [06-technical-design.md](06-technical-design.md) | Stage 6 — Detailed Technical Design | Internal behavior, algorithms, state machines, error handling, concurrency. |
| [07-contracts.md](07-contracts.md) | Stage 7 — Contracts | API, module, and data-schema interfaces between components. The testable boundary. |
| [08-test-strategy.md](08-test-strategy.md) | Stage 8 — Test Strategy | Test pyramid, REQ→test map, per-slice acceptance tests, definition of done. |
| [09-implementation-plan.md](09-implementation-plan.md) | Stage 9 — Implementation Plan | Ordered vertical slices, walking skeleton, per-slice tasks and self-contained task files. |
| [10-verification-report.md](10-verification-report.md) | Stage 11 — Final Verification | Final checks, rendered traceability view, open items. |
| [drift-log.md](drift-log.md) | Ongoing | Append-only record of implementation discoveries and derived-layer drift (spec §10). |

### Tier-3 Only Artifacts

The following artifacts exist only for **Tier-3 (Complex / Critical)** projects, or any project
carrying blast-radius flags (auth, money, data integrity, migrations). At lower tiers, their
content lives as folded sections inside `04-architecture.md`. When these files exist, the
corresponding sections in `04-architecture.md` become pointers to them.

| File | Purpose |
|---|---|
| [08a-security-threat-model.md](08a-security-threat-model.md) | Full threat model: assets, trust boundaries, threats grounded in this system's actual components, authn/authz model, mitigations. Graduates from the Security section of `04-architecture.md`. |
| [08b-failure-edge-cases.md](08b-failure-edge-cases.md) | Full failure catalog: invalid input, duplicates, partial failure, dependency outage, crash/restart, race conditions. Graduates from the Failure Modes section of `04-architecture.md`. |
