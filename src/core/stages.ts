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

export interface StageContract {
  /** Canonical stage id, matching the values written to state.current_stage. */
  stage: string;
  /** Tiers that run this stage (subset of T1/T2/T3; T0 bypasses everything). */
  tiers: string[];
  /** The governing artifact this stage produces (or "" for non-artifact stages). */
  produces: string;
  /** The Critic mode that reviews this stage's artifact in fresh context. */
  criticMode: string;
  /** Whether this stage has a blocking human-approval gate (spec §8). */
  humanGate: boolean;
  /** One-line description of the stage's contract. */
  summary: string;
}

/** The engaged-tier pipeline in canonical order (spec §5/§13). */
export const STAGE_PIPELINE: StageContract[] = [
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
export function stageContract(stage: string): StageContract | undefined {
  const key = stage.toLowerCase();
  return STAGE_PIPELINE.find((s) => s.stage === key);
}

/** The engaged stages for a tier, in pipeline order. T0 bypasses everything → []. */
export function engagedStages(tier: string | null): StageContract[] {
  if (!tier || tier === "T0") return [];
  return STAGE_PIPELINE.filter((s) => s.tiers.includes(tier));
}

/**
 * The next engaged stage strictly after `currentStage` for `tier`. Pre-pipeline
 * stages (e.g. "init") map to the first engaged stage. Returns undefined when
 * the current stage is the last engaged stage, or the tier engages nothing.
 */
export function nextStageAfter(currentStage: string, tier: string | null): StageContract | undefined {
  const engaged = engagedStages(tier);
  if (engaged.length === 0) return undefined;
  const key = currentStage.toLowerCase();
  const idx = engaged.findIndex((s) => s.stage === key);
  if (idx < 0) return engaged[0]; // pre-pipeline (init/bypass) → first engaged stage
  return engaged[idx + 1];
}
