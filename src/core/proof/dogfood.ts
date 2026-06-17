/**
 * Dogfood case studies (plan Step 5 — component 5).
 *
 * Turns one harvested {@link ScenarioArtifacts} snapshot into a narrative
 * {@link CaseStudy} + outcome statistics (end-to-end duration, slices completed,
 * revise loops, drift entries, final coverage, token/cost when telemetry captured
 * them) and asserts the brief's declared acceptance criteria were satisfied and the
 * run reached "working code". The verdict derives ONLY from harvested LIVE
 * artifacts — never the self-test loop.
 *
 * Coverage is computed via `computeBreakdown(scenarioRoot)` (the spine's coverage
 * authority), falling back to the harvested scorecard's coverage block when the
 * scenario sandbox has already been cleaned up (so a report built later still
 * carries coverage) — both yield the same {total,planned,implemented,tested} shape.
 */

import { buildReportCard } from "./assert";
import { computeBreakdown } from "../coverage";
import type {
  Assertion,
  CaseStudy,
  CaseStudyOutcome,
  ProofComponent,
  ReportCard,
  SampleBrief,
  ScenarioArtifacts,
} from "./types";

const C: ProofComponent = "dogfood";

interface CoverageShape {
  total: number;
  planned: number;
  implemented: number;
  tested: number;
}

/** Final coverage via the spine's `computeBreakdown` over the scenario root; null when reqs absent/root gone. */
function coverageFromBreakdown(root: string): CoverageShape | null {
  let result: ReturnType<typeof computeBreakdown>;
  try {
    result = computeBreakdown(root);
  } catch {
    return null;
  }
  if ("error" in result) return null;
  return { total: result.total, planned: result.planned, implemented: result.implemented, tested: result.tested };
}

/** Read the {total,planned,implemented,tested} coverage block from the harvested scorecard. */
function coverageFromScorecard(scorecard: Record<string, unknown> | null): CoverageShape | null {
  const cov = scorecard?.coverage;
  if (typeof cov !== "object" || cov === null) return null;
  const c = cov as Record<string, unknown>;
  if (
    typeof c.total === "number" &&
    typeof c.planned === "number" &&
    typeof c.implemented === "number" &&
    typeof c.tested === "number"
  ) {
    return { total: c.total, planned: c.planned, implemented: c.implemented, tested: c.tested };
  }
  return null;
}

/** End-to-end wall-clock from the min/max timestamp across telemetry / ledger / decisions. */
function durationMsFromArtifacts(a: ScenarioArtifacts): number | null {
  const times: number[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) times.push(t);
    }
  };
  for (const rec of a.telemetry as Array<{ ts?: unknown }>) push(rec.ts);
  for (const e of a.ledger) push(e.ts);
  for (const d of a.decisions) {
    push(d.proposedAt);
    push(d.approvedAt);
  }
  if (times.length < 2) return null;
  return Math.max(...times) - Math.min(...times);
}

/** Sum numeric token/cost fields recorded on telemetry, when a producer captured them. */
function tokenCostFromTelemetry(telemetry: object[]): { tokens: number | null; cost: number | null } {
  let tokens: number | null = null;
  let cost: number | null = null;
  for (const rec of telemetry as Array<{ tokens?: unknown; cost?: unknown }>) {
    if (typeof rec.tokens === "number") tokens = (tokens ?? 0) + rec.tokens;
    if (typeof rec.cost === "number") cost = (cost ?? 0) + rec.cost;
  }
  return { tokens, cost };
}

/** Whether the harvested run structurally reached working code (settled slices, suite not failing). */
function reachedWorkingCode(a: ScenarioArtifacts): boolean {
  const prog = a.sliceProgress;
  if (!prog) return false;
  const suite = a.scorecard?.suite;
  const suiteOk = suite !== "failing";
  return prog.allSettled && prog.done > 0 && suiteOk;
}

/**
 * Whether the brief's acceptance criteria are structurally satisfied: the run
 * reached working code AND — when requirements were authored — the coverage shows
 * at least one verifying test. Acceptance criteria are not mechanically parseable
 * from a harvest, so this is the documented structural proxy (plan §6 / Step 5);
 * the dogfood verdict flags a run that did NOT reach working code.
 */
function acceptanceCriteriaMet(a: ScenarioArtifacts, coverage: CoverageShape | null): boolean {
  if (!reachedWorkingCode(a)) return false;
  if (coverage && coverage.total > 0) return coverage.tested > 0;
  return true;
}

/** Compose the human narrative for the case study. */
function narrate(brief: SampleBrief | undefined, a: ScenarioArtifacts, outcome: CaseStudyOutcome, worked: boolean): string {
  const briefId = brief?.id ?? a.briefId ?? "(unknown brief)";
  const tier = a.state?.tier ?? "(unclassified)";
  const stage = a.state?.current_stage ?? "(unknown stage)";
  const cov = outcome.coverage
    ? `${outcome.coverage.planned}/${outcome.coverage.implemented}/${outcome.coverage.tested} of ${outcome.coverage.total} (planned/impl/tested)`
    : "no requirements authored";
  const dur = outcome.durationMs === null ? "n/a" : `${outcome.durationMs}ms`;
  const models = Object.keys(a.routing.models).length
    ? Object.entries(a.routing.models).map(([m, n]) => `${m}×${n}`).join(", ")
    : "—";
  return [
    `# Dogfood case study — ${briefId}`,
    "",
    `Domain ${brief?.domain ?? "?"} · ${brief?.type ?? "?"} · tier ${tier} · final stage ${stage}.`,
    `Reached working code: ${worked ? "yes" : "no"}.`,
    `Slices: ${outcome.slicesCompleted} completed of ${a.sliceProgress?.total ?? 0}.`,
    `Drift entries: ${outcome.driftEntries}. Coverage: ${cov}.`,
    `Routing: ${a.routing.events} call(s) (${models}). End-to-end: ${dur}.`,
    outcome.tokens !== null && outcome.tokens !== undefined ? `Tokens: ${outcome.tokens}${outcome.cost ? ` (cost ${outcome.cost})` : ""}.` : "Tokens: not captured.",
  ].join("\n");
}

/**
 * Build the dogfood {@link CaseStudy} for a harvested scenario. `brief` supplies the
 * declared acceptance criteria + domain; when absent, identity falls back to
 * `artifacts.briefId`.
 */
export function buildCaseStudy(a: ScenarioArtifacts, brief?: SampleBrief): CaseStudy {
  // Prefer the live `computeBreakdown` over the scenario root; fall back to the
  // already-harvested scorecard coverage when the sandbox is gone.
  const coverage = coverageFromBreakdown(a.scenarioRoot) ?? coverageFromScorecard(a.scorecard);
  const { tokens, cost } = tokenCostFromTelemetry(a.telemetry);
  const outcome: CaseStudyOutcome = {
    durationMs: durationMsFromArtifacts(a),
    slicesCompleted: a.sliceProgress?.done ?? 0,
    reviseLoopCounts: a.state?.revise_loop_counts ?? {},
    driftEntries: a.manifest?.drift_entries.length ?? 0,
    coverage,
    tokens,
    cost,
  };
  const worked = reachedWorkingCode(a);
  return {
    briefId: brief?.id ?? a.briefId ?? "(unknown)",
    narrative: narrate(brief, a, outcome, worked),
    outcome,
    acceptanceCriteriaMet: acceptanceCriteriaMet(a, coverage),
    reachedWorkingCode: worked,
  };
}

/**
 * Assert the dogfood invariants: a case study artifact was produced, the run reached
 * working code, the declared acceptance criteria are (structurally) satisfied, and
 * the brief actually declared criteria to check against.
 */
export function assertDogfood(a: ScenarioArtifacts, brief?: SampleBrief): Assertion[] {
  const cs = buildCaseStudy(a, brief);
  const declared = brief?.acceptanceCriteria.length ?? 0;
  return [
    { name: "case_study_produced", component: C, expected: true, actual: cs.narrative.length > 0, pass: cs.narrative.length > 0 },
    { name: "reached_working_code", component: C, expected: true, actual: cs.reachedWorkingCode, pass: cs.reachedWorkingCode },
    { name: "acceptance_criteria_satisfied", component: C, expected: true, actual: cs.acceptanceCriteriaMet, pass: cs.acceptanceCriteriaMet },
    { name: "acceptance_criteria_declared", component: C, expected: ">=1", actual: declared, pass: declared > 0 },
  ];
}

/** Dogfood report card (component 5), carrying the case study in its stats. */
export function dogfoodCard(a: ScenarioArtifacts, brief?: SampleBrief): ReportCard {
  const cs = buildCaseStudy(a, brief);
  const assertions = assertDogfood(a, brief);
  const stats = {
    caseStudy: cs,
    slicesCompleted: cs.outcome.slicesCompleted,
    driftEntries: cs.outcome.driftEntries,
    coverage: cs.outcome.coverage,
    durationMs: cs.outcome.durationMs,
    reachedWorkingCode: cs.reachedWorkingCode,
    acceptanceCriteriaMet: cs.acceptanceCriteriaMet,
  };
  return buildReportCard("dogfood", assertions, stats);
}
