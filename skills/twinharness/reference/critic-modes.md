# TwinHarness Critic Modes — Reference Index (part of the TwinHarness orchestrator playbook)

The full per-mode grounded-defect checklists for the Critic agent live in the three files below. When
you are the Critic and need your mode's detailed checklist, find the mode here and open the linked file.

> **Running `th`:** wherever this document says `th <args>`, run
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <args>`.

---

## Specification & Scope Modes → [critic-modes-spec.md](critic-modes-spec.md)

- **`requirements`** (`docs/01-requirements.md`) — internal consistency, REQ-ID assignment, success measures, bounded goal, users identified.
- **`scope`** (`docs/02-scope.md`) — MVP pruning, REQ-ID traceability, scope/future distinction, no contradictions, user-confirmed decisions.
- **`domain-model`** (`docs/03-domain-model.md`) — entity coverage, relationship consistency, domain rules, glossary alignment, REQ-ID anchoring.
- **`architecture`** (`docs/04-architecture.md`) — grounded coherence (not technology preference): REQ coverage, scope fit, domain reflection, clean responsibilities/boundaries, risks.

## Implementation Planning & Build Modes → [critic-modes-build.md](critic-modes-build.md)

- **`slice`** (`docs/09-implementation-plan.md`) — each slice vertical, user-visible, testable, ordered for integration; all MVP REQ-IDs covered; Slice 0 a genuine walking skeleton.
- **`code-review`** (completed slice code) — contract fidelity, test anchoring, test substance (not tautologies), drift documentation, derived-doc updates, no silent requirement contradictions.
- **`final-verification`** (`docs/10-verification-report.md`) — coherence-vs-correctness separated, REQ-ID traceability, coverage checks, internal consistency.

## Design, Risk, Docs & Debug Modes → [critic-modes-design.md](critic-modes-design.md)

- **`contracts`** (`docs/07-contracts.md`) — every contract REQ-anchored, error cases enumerated, domain-model alignment, no producer/consumer conflicts, versioning.
- **`test-strategy`** (`docs/08-test-strategy.md`) — no REQ-ID without a test, behavior not tautologies, failure modes have negative tests, slice acceptance tests end-to-end, mechanical DoD.
- **`adr`** (`docs/05-adrs/`) — significant costly-to-reverse decisions, honest consequences, genuine alternatives, consistency with architecture/requirements, linked REQ-IDs, current status.
- **`technical-design`** (`docs/06-technical-design.md`) — designs support REQ-IDs, respect invariants/contracts, concurrency/failure handling where implied, no over/under-specification, complete state machines.
- **`security`** (`docs/08a-security-threat-model.md`) — ANTI-BOILERPLATE: every threat anchored to a specific component/boundary/flow; mitigation-to-threat mapping; auth consistent with contracts; high-risk flows covered.
- **`failure-modes`** (`docs/08b-failure-edge-cases.md`) — ANTI-BOILERPLATE: every failure mode names a specific component/flow; behavior consistent with contracts/invariants; critical-flow handling; idempotency; negative tests.
- **`documentation`** (README/guides/API reference) — ANTI-BOILERPLATE on prose: every feature anchored to a REQ-ID/contract; implementation matches docs; all contracts documented; no generic filler.
- **`ux-design`** (`docs/04a-ux-design.md`) — every persona/journey/flow serves ≥1 REQ-ID; MVP user-facing REQ-IDs mapped; bounded flows; IA covers requirements; assumptions surfaced; domain vocabulary.
- **`ui-design`** (`docs/04b-ui-design.md`) — every screen serves ≥1 REQ-ID; MVP coverage; bounded flows; empty/loading/error states; domain vocabulary; no out-of-scope screens; accessibility present; concrete design tokens.
- **`research`** (`docs/00-research/`) — every claim cited to a real reachable source with date; no fabricated sources; opinion vs. fact; recency noted; findings anchored to REQ-IDs.
- **`debug-review`** (Debugger Evidence Report + `debug-log.md`) — root cause anchored to file:line/captured evidence; real reproduction command; discriminating experiments; fix in component boundary; requirement contradictions opened as blocking drift.

---

## File lookup by phase

| Phase | Modes | File |
|-------|-------|------|
| Requirements → Scope → Domain → Architecture | `requirements` `scope` `domain-model` `architecture` | [critic-modes-spec.md](critic-modes-spec.md) |
| Slicing → Building → Final Verification | `slice` `code-review` `final-verification` | [critic-modes-build.md](critic-modes-build.md) |
| Design Details → Risk → Docs → Debug | `contracts` `test-strategy` `adr` `technical-design` `security` `failure-modes` `documentation` `ux-design` `ui-design` `research` `debug-review` | [critic-modes-design.md](critic-modes-design.md) |
