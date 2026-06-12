"use strict";
/**
 * Static stage-contract table (Phase 3 — "persist a per-stage contract").
 *
 * The orchestrator playbook lives in prose (SKILL.md) and can fall outside the
 * post-compaction context window on long runs (audit F7). This table is the
 * mechanical, always-available answer to "what must the current stage produce,
 * which Critic mode reviews it, and does it need a human gate?" — derivable from
 * `state.current_stage` via `th stage current` without re-reading the playbook.
 *
 * It is descriptive, not prescriptive: the CLI records and computes; the
 * Orchestrator still decides whether a stage runs (plan §3 boundary rule).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STAGE_PIPELINE = void 0;
exports.stageContract = stageContract;
/** The engaged-tier pipeline in canonical order (spec §5/§13). */
exports.STAGE_PIPELINE = [
    { stage: "requirements", tiers: ["T1", "T2", "T3"], produces: "docs/01-requirements.md", criticMode: "requirements", humanGate: true, summary: "Turn the idea into REQ-ID'd intent; sticky human sign-off." },
    { stage: "scope", tiers: ["T1", "T2", "T3"], produces: "docs/02-scope.md", criticMode: "scope", humanGate: true, summary: "MVP vs later; sticky human sign-off." },
    { stage: "domain-model", tiers: ["T2", "T3"], produces: "docs/03-domain-model.md", criticMode: "domain-model", humanGate: false, summary: "Entities and rules anchored to REQ-IDs; streams." },
    { stage: "architecture", tiers: ["T1", "T2", "T3"], produces: "docs/04-architecture.md", criticMode: "architecture", humanGate: true, summary: "Components/data flow; gate only the 1-2 irreversible decisions." },
    { stage: "ui-design", tiers: ["T1", "T2", "T3"], produces: "docs/04b-ui-design.md", criticMode: "ui-design", humanGate: true, summary: "Conditional on a UI; human picks 1 of 2-3 directions." },
    { stage: "adrs", tiers: ["T3"], produces: "docs/05-adrs/", criticMode: "adr", humanGate: false, summary: "One ADR per significant, costly-to-reverse decision; streams." },
    { stage: "technical-design", tiers: ["T3"], produces: "docs/06-technical-design.md", criticMode: "technical-design", humanGate: false, summary: "Internal behaviour the architecture left abstract; streams." },
    { stage: "contracts", tiers: ["T2", "T3"], produces: "docs/07-contracts.md", criticMode: "contracts", humanGate: true, summary: "Interface I/O/errors; auth choices are a blast-radius human gate." },
    { stage: "security", tiers: ["T3"], produces: "docs/08a-security-threat-model.md", criticMode: "security", humanGate: true, summary: "Graduated for T3/blast-radius; security model needs human approval." },
    { stage: "failure-modes", tiers: ["T3"], produces: "docs/08b-failure-edge-cases.md", criticMode: "failure-modes", humanGate: false, summary: "Graduated for T3/reliability-critical; data-loss tradeoffs gate." },
    { stage: "test-strategy", tiers: ["T2", "T3"], produces: "docs/08-test-strategy.md", criticMode: "test-strategy", humanGate: false, summary: "Test pyramid; each REQ-ID gets >=1 verifying test; streams." },
    { stage: "implementation-planning", tiers: ["T1", "T2", "T3"], produces: "docs/09-implementation-plan.md", criticMode: "slice", humanGate: false, summary: "Vertical slices + coverage map; hard gate: th coverage check." },
    { stage: "implementation", tiers: ["T1", "T2", "T3"], produces: "", criticMode: "code-review", humanGate: false, summary: "Build slice-by-slice with tests; Critic code-review per slice; drift loop." },
    { stage: "documentation", tiers: ["T1", "T2", "T3"], produces: "", criticMode: "documentation", humanGate: false, summary: "Tier-scaled docs; Critic-reviewed; no human gate." },
    { stage: "final-verification", tiers: ["T1", "T2", "T3"], produces: "docs/10-verification-report.md", criticMode: "final-verification", humanGate: true, summary: "Coherence (Critic) vs correctness (tests + human); human signs off." },
];
/** Look up a stage contract by id (case-insensitive). */
function stageContract(stage) {
    const key = stage.toLowerCase();
    return exports.STAGE_PIPELINE.find((s) => s.stage === key);
}
