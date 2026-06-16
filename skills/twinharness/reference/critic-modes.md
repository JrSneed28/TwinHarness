# TwinHarness Critic Modes — Reference Index (part of the TwinHarness orchestrator playbook)

This directory contains the full per-mode grounded-defect checklists for the Critic agent. When you
are the Critic and need the detailed checklist for your mode, find the mode's section below and
navigate to the appropriate reference document.

Every rule is verbatim from the original agent definition.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## Specification & Scope Modes

The early-stage Critic modes that define the problem space and constraints:

- **`requirements`** — Verify internal consistency, REQ-ID assignment, success measures, and bounded goals in `docs/01-requirements.md`. [→ critic-modes-spec.md](critic-modes-spec.md)
- **`scope`** — Check MVP item pruning, REQ-ID traceability, scope/future-scope distinction, and user-confirmed decisions in `docs/02-scope.md`. [→ critic-modes-spec.md](critic-modes-spec.md)
- **`domain-model`** — Validate entity coverage, relationship consistency, domain rules, glossary alignment, and REQ-ID anchoring in `docs/03-domain-model.md`. [→ critic-modes-spec.md](critic-modes-spec.md)
- **`architecture`** — Certify grounded coherence (not technology preference): REQ coverage, scope fit, domain model reflection, clean responsibilities, explicit boundaries, and risk accounting in `docs/04-architecture.md`. [→ critic-modes-spec.md](critic-modes-spec.md)

---

## Implementation Planning & Build Modes

The slice-planning and build-time Critic modes:

- **`slice`** — Check that each slice is vertical (end-to-end), user-visible, testable, ordered for integration, covers MVP REQ-IDs, and that Slice 0 is a genuine walking skeleton in `docs/09-implementation-plan.md`. [→ critic-modes-build.md](critic-modes-build.md)
- **`code-review`** — Verify contract fidelity, test anchoring, test substance (not tautologies), drift documentation, derived-doc updates, and no silent requirement contradictions for completed slice code. [→ critic-modes-build.md](critic-modes-build.md)
- **`final-verification`** — Certify that the verification report separates coherence (Critic's domain) from correctness (tests + human), with REQ-ID traceability, coverage checks, and internal consistency in `docs/10-verification-report.md`. [→ critic-modes-build.md](critic-modes-build.md)

---

## Design Artifact Modes

The detailed-design Critic modes that specify behavior, interfaces, and risk handling:

- **`contracts`** — Validate that every contract has a REQ-ID anchor, error cases are enumerated, domain-model alignment, no producer-consumer conflicts, and versioning expectations in `docs/07-contracts.md`. [→ critic-modes-design.md](critic-modes-design.md)
- **`test-strategy`** — Ensure no REQ-ID lacks a test, tests assert observable behavior (not tautologies), failure modes have negative tests, slice acceptance tests are end-to-end, and Definition of Done is mechanical in `docs/08-test-strategy.md`. [→ critic-modes-design.md](critic-modes-design.md)
- **`adr`** — Check that each ADR documents a significant, costly-to-reverse decision with honest consequences, genuinely-considered alternatives, consistency with architecture and requirements, linked REQ-IDs, and current status in `docs/05-adrs/`. [→ critic-modes-design.md](critic-modes-design.md)
- **`technical-design`** — Validate that component designs support REQ-IDs, respect domain invariants and contracts, specify concurrency/failure handling where implied, avoid over/under-specification, and complete state machines in `docs/06-technical-design.md`. [→ critic-modes-design.md](critic-modes-design.md)

---

## Risk & Trust Modes

The security, failure-handling, and threat-modeling Critic modes (apply ANTI-BOILERPLATE enforcement):

- **`security`** — Enforce the ANTI-BOILERPLATE rule: every threat MUST be anchored to a specific component, boundary, or data flow from the architecture; no generic checklist items. Verify mitigation-to-threat mapping, auth model consistency with contracts, and high-risk-flow coverage in `docs/08a-security-threat-model.md`. [→ critic-modes-design.md](critic-modes-design.md)
- **`failure-modes`** — Enforce the ANTI-BOILERPLATE rule: every failure mode MUST name a specific component or flow; no generic "handle errors gracefully" entries. Verify behavior consistency with contracts and domain invariants, critical-flow handling, idempotency specification, and negative test coverage in `docs/08b-failure-edge-cases.md`. [→ critic-modes-design.md](critic-modes-design.md)

---

## Documentation, Analysis & Debug Modes

Post-build and investigatory Critic modes:

- **`documentation`** — Enforce ANTI-BOILERPLATE on prose: every documented feature must anchor to a REQ-ID or contract, implementation must match docs, all contracts must be documented, and no generic filler prose in README, guides, API reference. [→ critic-modes-design.md](critic-modes-design.md)
- **`ui-design`** — Verify every screen serves ≥1 REQ-ID, MVP user-facing REQ-IDs map to screens, user flows are bounded, screens define empty/loading/error states, vocabulary matches domain model, and no out-of-scope features in `docs/04b-ui-design.md`. [→ critic-modes-design.md](critic-modes-design.md)
- **`research`** — Demand grounded evidence: every material claim must be cited to a real, reachable source with access date, sources must be verifiable (not hallucinated), opinions separated from fact, version/recency noted on version-sensitive claims, and findings anchored to REQ-IDs in `docs/00-research/`. [→ critic-modes-design.md](critic-modes-design.md)
- **`debug-review`** — Reject narrative; demand proof. Root cause must be anchored to file:line or captured evidence, reproduction must be a real command, hypotheses must carry discriminating experiments, fixes must stay in component boundary, and requirement contradictions must be opened as blocking drift. [→ critic-modes-design.md](critic-modes-design.md)

---

## File Organization

For fast lookup by phase:

| Phase | Modes | File |
|-------|-------|------|
| Requirements → Scope → Domain → Architecture | `requirements` `scope` `domain-model` `architecture` | [critic-modes-spec.md](critic-modes-spec.md) |
| Slicing → Building → Final Verification | `slice` `code-review` `final-verification` | [critic-modes-build.md](critic-modes-build.md) |
| Design Details → Risk → Docs → Debug | `contracts` `test-strategy` `adr` `technical-design` `security` `failure-modes` `documentation` `ui-design` `research` `debug-review` | [critic-modes-design.md](critic-modes-design.md) |
