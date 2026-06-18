/**
 * Shared gate-precondition helpers — the SINGLE source of truth for "may the run
 * advance / unlock implementation / change tier?" (consensus plan Phase 2 Step 5,
 * Principle 2, AC-B13/B14/B15).
 *
 * Each rung's PREDICATE is extracted here, separated from the `emit(...)` message
 * rendering that stays in `th next` (`src/commands/next.ts`). Both `th next` (the
 * human oracle) AND the typed MCP gate-transition tools (`th_stage_advance`,
 * `th_implementation_unlock`, `th_tier_record`) consume THESE functions, so they
 * can never drift apart about what "ready" means.
 *
 * SECURITY FRAMING (plan Principle 2, pre-mortem #3): `validateState` enforces only
 * the T0/blast-radius veto, so the typed tools are the FIRST machine-enforced gate
 * ladder — every gap here is a real escalation surface with no schema backstop.
 * `canUnlockImplementation` MUST therefore be a COMPOSITION of `canAdvanceStage`'s
 * full ladder + the unlock tail, never a weaker coverage-only subset.
 *
 * Each helper returns a {@link GateResult}: `{ ok }` on pass, or
 * `{ ok:false, error:<stable code>, detail? }` for the FIRST failing rung in
 * `runNext()` order. `error` is a STABLE machine token (mirrors live in the tool
 * refusals and the per-tool tests — do NOT rename without updating both).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { TIERS, type Tier, type TwinHarnessState } from "./state-schema";
import {
  canonicalizeStage,
  isFinalVerification,
  stageContract,
  STAGE_PIPELINE,
} from "./stages";
import { artifactIntegrity, reviseEscalations, sliceProgress, type ReviseEscalation } from "./health";
import { computeBreakdown } from "./coverage";
import { readVerifyConfig, readVerifyReport } from "./verify";
import { gatingObligations, reduceDecisions, readDecisionEvents } from "./decisions";
import { runRepoCheck, REPO_NO_MAP_EXIT } from "../commands/repo";
import { interviewReady } from "../commands/interview";

/**
 * Result of a precondition check. `ok:true` ⇒ the rung passes. `ok:false` carries
 * a STABLE `error` code (the first failing rung) plus optional `detail` the caller
 * uses to render a message / structured refusal.
 */
export interface GateResult {
  ok: boolean;
  /** Stable machine token for the failing rung (absent when `ok`). */
  error?: string;
  /** Structured context for the failing rung (absent when `ok`). */
  detail?: Record<string, unknown>;
}

const PASS: GateResult = { ok: true };

// ---------------------------------------------------------------------------
// Global rungs (stage-independent) — checked before any stage-specific work, in
// the exact short-circuit order of runNext() (next.ts:96-210 + the NEW debate rung).
// ---------------------------------------------------------------------------

/** Rung a (next.ts:96) — open blocking drift outranks all stage progress. */
export function checkBlockingDrift(state: TwinHarnessState): GateResult {
  if (state.drift_open_blocking > 0) {
    return { ok: false, error: "blocking_drift_open", detail: { drift_open_blocking: state.drift_open_blocking } };
  }
  return PASS;
}

/** Rung b (next.ts:109) — a revise loop at its cap owes a human escalation. */
export function checkReviseEscalation(state: TwinHarnessState): GateResult {
  const escalations = reviseEscalations(state);
  if (escalations.length > 0) {
    return { ok: false, error: "revise_escalation_open", detail: { escalations } };
  }
  return PASS;
}

/** Rung c (next.ts:124) — a red `th verify run` is a defect owed to the Debugger. */
export function checkVerifySuite(paths: ProjectPaths): GateResult {
  const report = readVerifyReport(paths);
  if (report && !report.ok) {
    const failed = report.results.filter((x) => !x.ok).length;
    return { ok: false, error: "verify_suite_failing", detail: { failed } };
  }
  return PASS;
}

/** Rung d (next.ts:138) — a governed artifact changed on disk without re-registration. */
export function checkArtifactDrift(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  const changed = artifactIntegrity(paths, state).filter((i) => i.status === "changed").map((i) => i.file);
  if (changed.length > 0) {
    return { ok: false, error: "artifact_drift", detail: { changed } };
  }
  return PASS;
}

/** Rung e (next.ts:152) — tier gates every engaged stage. */
export function checkTierSet(state: TwinHarnessState): GateResult {
  if (state.tier === null) {
    return { ok: false, error: "tier_unclassified", detail: { current_stage: state.current_stage } };
  }
  return PASS;
}

/** Rung f (next.ts:170) — brownfield repo-map freshness before implementation unlock. */
export function checkRepoMap(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  if (state.project_mode === "brownfield" && !state.implementation_allowed) {
    const check = runRepoCheck(paths);
    if (check.exitCode !== 0) {
      const absent = check.exitCode === REPO_NO_MAP_EXIT;
      const shape = (check.data as { shape?: string } | undefined)?.shape ?? "stale";
      return { ok: false, error: "repo_map_stale", detail: { absent, shape } };
    }
  }
  return PASS;
}

/** Rung g (next.ts:196) — an unapproved gating decision blocks the stage (RULE-007). */
export function checkDecisionObligations(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  const decisions = reduceDecisions(readDecisionEvents(paths));
  const obligations = gatingObligations(decisions, state);
  if (obligations.length > 0) {
    const first = obligations[0]!;
    const title = decisions.find((d) => d.id === first.decisionId)?.title ?? "";
    return {
      ok: false,
      error: "decision_obligation_open",
      detail: { decisionId: first.decisionId, blockedStage: first.blockedStage, title },
    };
  }
  return PASS;
}

/**
 * Rung h (NEW) — an open BLOCKING debate is a Pattern-B reconciliation obligation
 * the stop-gate already refuses completion on (`src/commands/hook.ts:65`) but
 * `runNext()` historically never checked. Adding this rung CLOSES that pre-existing
 * oracle/stop-gate divergence (Architect 1d/#2, AC-B15) and intentionally changes
 * `th next`'s debate-blocked output. Absent counter ⇒ 0.
 */
export function checkDebate(state: TwinHarnessState): GateResult {
  const n = state.debate_open_blocking ?? 0;
  if (n > 0) {
    return { ok: false, error: "debate_open_blocking", detail: { debate_open_blocking: n } };
  }
  return PASS;
}

// ---------------------------------------------------------------------------
// Stage-specific rungs.
// ---------------------------------------------------------------------------

/**
 * Rung i (next.ts:222-249) — the CURRENT non-final stage's governing artifact must
 * be produced AND registered. `validateState` does NOT backstop this, so omitting
 * it is a stage-advance bypass (Critic MAJOR). Returns `artifact_not_produced` when
 * the artifact is missing on disk, `artifact_not_registered` when it exists but is
 * not yet a governed (hash-recorded) artifact.
 */
export function checkGoverningArtifact(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  const current = canonicalizeStage(state.current_stage);
  const contract = stageContract(current);
  if (contract && contract.produces && !isFinalVerification(current)) {
    const produced = contract.produces.replace(/\/$/, "");
    const registered = state.approved_artifacts.some((a) => a.file === produced);
    if (!registered) {
      const exists = fs.existsSync(path.resolve(paths.root, produced));
      if (!exists) {
        return { ok: false, error: "artifact_not_produced", detail: { stage: current, produces: contract.produces } };
      }
      return { ok: false, error: "artifact_not_registered", detail: { stage: current, file: produced } };
    }
  }
  return PASS;
}

/**
 * Rung j (next.ts:252 / coverageBlocker) — the coverage gate. Returns
 * `reqs_file_missing` when the requirements file is absent (coverage cannot be
 * computed), `coverage_failing` when ≥1 checked REQ-ID lacks a slice and/or a test.
 * `detail` carries everything the `fix-coverage` message needs so the renderer in
 * `next.ts` is a thin projection of THIS predicate (no duplicate coverage logic).
 */
export function checkCoverage(paths: ProjectPaths): GateResult {
  const breakdown = computeBreakdown(paths.root);
  if ("error" in breakdown) {
    return { ok: false, error: "reqs_file_missing", detail: { error: breakdown.error, reqsFile: breakdown.reqsFile } };
  }
  const gaps = breakdown.rows
    .filter((row) => !row.planned || !row.tested)
    .map((g) => ({ req: g.req, inSlice: g.planned, inTest: g.tested }));
  if (gaps.length > 0) {
    return { ok: false, error: "coverage_failing", detail: { gaps } };
  }
  return PASS;
}

/**
 * SINGLE shared predicate (audit finding #2): does this project owe implementation
 * slices? True for a "code" delivery (the default — absent `delivery_mode` ⇒ "code"),
 * false for "no-code" / "documentation-only". BOTH `checkImplementationSettled` (the
 * gate) AND `th next` (the oracle, via the `sync-slices` branch) consume THIS one
 * predicate, so they can never disagree about whether an EMPTY slice set during the
 * `implementation` stage is valid.
 */
export function implementationRequiresSlices(state: Pick<TwinHarnessState, "delivery_mode">): boolean {
  return (state.delivery_mode ?? "code") === "code";
}

/**
 * Rung k (next.ts:374) — to advance OUT of the `implementation` stage, every slice
 * must be settled (done|blocked). `th next` surfaces a richer within-stage action
 * (dispatch-wave / await-builders / stalled-build / sync-slices) while building;
 * the security-relevant gate for advancing is simply "all slices settled".
 */
export function checkImplementationSettled(state: TwinHarnessState): GateResult {
  const prog = sliceProgress(state);
  // An EMPTY slice set during `implementation` is INVALID for a CODE project (finding
  // #2): with `delivery_mode` "code" the stage owes ≥1 slice, so zero slices is an
  // unsynced plan — NOT a vacuous pass. The gate and `th next` agree here via the
  // shared `implementationRequiresSlices` predicate. For no-code/documentation-only an
  // empty set stays vacuously settled (mirrors checkFinalVerification's prog.total>0 floor).
  if (prog.total === 0) {
    if (implementationRequiresSlices(state)) {
      return { ok: false, error: "no_slices_defined", detail: { delivery_mode: state.delivery_mode ?? "code" } };
    }
    return PASS;
  }
  if (!prog.allSettled) {
    return {
      ok: false,
      error: "slices_unsettled",
      detail: { total: prog.total, pending: prog.pending, inProgress: prog.inProgress },
    };
  }
  return PASS;
}

/**
 * Rung l (next.ts:258-314) — the final-verification ladder, returning the FIRST
 * failing sub-rung in order: slices unsettled → verify suite never run → coverage
 * failing → report not produced/registered. When every gate clears, the only thing
 * left is the human correctness sign-off (which the CLI cannot certify), so this
 * returns `ok` — there is no further stage to advance to.
 */
export function checkFinalVerification(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  const prog = sliceProgress(state);
  if (!prog.allSettled && prog.total > 0) {
    const open = state.slices.filter((sl) => sl.status !== "done" && sl.status !== "blocked").map((sl) => sl.id);
    return { ok: false, error: "slices_unsettled", detail: { open } };
  }
  const verifyCfg = readVerifyConfig(paths);
  if (verifyCfg.commands.length > 0 && !readVerifyReport(paths)) {
    return { ok: false, error: "verify_suite_never_run", detail: { commands: verifyCfg.commands.length } };
  }
  const cov = checkCoverage(paths);
  if (!cov.ok) return cov;
  const contract = stageContract(canonicalizeStage(state.current_stage));
  if (contract && contract.produces) {
    const produced = contract.produces.replace(/\/$/, "");
    const registered = state.approved_artifacts.some((a) => a.file === produced);
    if (!registered) {
      const exists = fs.existsSync(path.resolve(paths.root, produced));
      return exists
        ? { ok: false, error: "report_not_registered", detail: { file: produced } }
        : { ok: false, error: "report_not_produced", detail: { produces: produced } };
    }
  }
  return PASS;
}

// ---------------------------------------------------------------------------
// Composed gate predicates — consumed by both `th next` and the typed MCP tools.
// ---------------------------------------------------------------------------

/** Pipeline ordinal of a (canonicalized) stage, or -1 for a pre-pipeline stage. */
function stageOrdinal(stage: string): number {
  const canonical = canonicalizeStage(stage);
  return STAGE_PIPELINE.findIndex((s) => s.stage === canonical);
}

/** Index of the `implementation-planning` stage in the canonical pipeline. */
const IMPLEMENTATION_PLANNING_ORDINAL = STAGE_PIPELINE.findIndex((s) => s.stage === "implementation-planning");

/** Index of the `requirements` stage — the soft interview gate's boundary (finding #14). */
const REQUIREMENTS_ORDINAL = STAGE_PIPELINE.findIndex((s) => s.stage === "requirements");

/**
 * Whether a clarity interview is REQUIRED before advancing past `requirements`
 * (audit finding #14, soft gate). An explicit `interview_required` boolean wins;
 * absent ⇒ COMPUTED from tier: required for T2/T3, not for T0/T1/unclassified.
 */
export function interviewRequired(state: Pick<TwinHarnessState, "interview_required" | "tier">): boolean {
  if (typeof state.interview_required === "boolean") return state.interview_required;
  return state.tier === "T2" || state.tier === "T3";
}

/**
 * SOFT interview gate (audit finding #14). While an interview is required
 * (`interviewRequired`) AND not yet ready (`interviewReady`), the run may not advance
 * PAST `requirements`: it is refused at every stage up to and including `requirements`
 * (`th next` renders this as a `complete-interview` action). Stages already past
 * requirements are never blocked — the interview only gates the FRONT of the pipeline,
 * which keeps it a soft, front-loaded gate rather than a hard stop everywhere.
 */
export function checkInterview(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  if (!interviewRequired(state)) return PASS;
  if (interviewReady(paths)) return PASS;
  const ordinal = stageOrdinal(state.current_stage);
  // Pre-pipeline (ordinal -1, e.g. "init") and `requirements` itself are at/before the
  // gate point; anything later is already past it and must not be re-blocked.
  if (ordinal < 0 || ordinal <= REQUIREMENTS_ORDINAL) {
    return { ok: false, error: "interview_incomplete", detail: { current_stage: canonicalizeStage(state.current_stage) } };
  }
  return PASS;
}

/**
 * The FULL mechanical ladder that must clear before the run advances OUT of the
 * current stage — the EXHAUSTIVE list (AC-B13 reuses it verbatim): global rungs
 * a–h, then the stage-specific rung for the current stage (governing artifact,
 * coverage at implementation-planning, slices settled at implementation, or the
 * final-verification ladder). Evaluated lazily so the short-circuit order — and the
 * cost (the brownfield repo scan only runs when reached) — matches `runNext()`.
 */
export function canAdvanceStage(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  let r: GateResult;
  if (!(r = checkBlockingDrift(state)).ok) return r;
  if (!(r = checkReviseEscalation(state)).ok) return r;
  if (!(r = checkVerifySuite(paths)).ok) return r;
  if (!(r = checkArtifactDrift(paths, state)).ok) return r;
  if (!(r = checkTierSet(state)).ok) return r;
  if (!(r = checkInterview(paths, state)).ok) return r;
  if (!(r = checkRepoMap(paths, state)).ok) return r;
  if (!(r = checkDecisionObligations(paths, state)).ok) return r;
  if (!(r = checkDebate(state)).ok) return r;

  const current = canonicalizeStage(state.current_stage);
  if (isFinalVerification(current)) {
    return checkFinalVerification(paths, state);
  }
  if (!(r = checkGoverningArtifact(paths, state)).ok) return r;
  if (current === "implementation-planning") {
    if (!(r = checkCoverage(paths)).ok) return r;
  }
  if (current === "implementation") {
    if (!(r = checkImplementationSettled(state)).ok) return r;
  }
  return PASS;
}

/**
 * May implementation be unlocked? COMPOSITION (NOT a weaker subset — Principle 2,
 * Architect 1c, AC-B13): the FULL `canAdvanceStage` ladder PLUS the unlock tail —
 * coverage passes AND `current_stage` is at least `implementation-planning`. The
 * ladder already checks coverage when at implementation-planning; the explicit tail
 * coverage check guarantees it holds even if the current stage is LATER than
 * implementation-planning (where the ladder would not re-check it).
 */
export function canUnlockImplementation(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  const adv = canAdvanceStage(paths, state);
  if (!adv.ok) return adv;
  const cov = checkCoverage(paths);
  if (!cov.ok) return cov;
  const ordinal = stageOrdinal(state.current_stage);
  if (ordinal < 0 || ordinal < IMPLEMENTATION_PLANNING_ORDINAL) {
    return {
      ok: false,
      error: "stage_before_implementation_planning",
      detail: { current_stage: canonicalizeStage(state.current_stage) },
    };
  }
  return PASS;
}

/**
 * Validate a tier (re-)classification over MCP (AC-B14, Architect #3, driver 1).
 * Refusals, in order:
 *   - `invalid_tier`            — target is not a known tier.
 *   - `tier_locked_after_unlock`— `implementation_allowed===true` freezes the tier.
 *   - `tier_downgrade_human_only`— a DOWNWARD re-classification of an already-set
 *     tier (by `TIERS` ordinal, e.g. T3→T1) shrinks engaged stages and is a
 *     review-dodge vector; refused over MCP. Set-from-`null` and UPGRADES are allowed.
 *   - `t0_blast_radius_veto`    — target `T0` with any blast-radius flag present (§5).
 */
export function validateTierTransition(state: TwinHarnessState, targetTier: string): GateResult {
  if (!(TIERS as readonly string[]).includes(targetTier)) {
    return { ok: false, error: "invalid_tier", detail: { targetTier, validTiers: TIERS } };
  }
  if (state.implementation_allowed === true) {
    return { ok: false, error: "tier_locked_after_unlock", detail: { tier: state.tier } };
  }
  if (state.tier !== null) {
    const curIdx = TIERS.indexOf(state.tier);
    const tgtIdx = TIERS.indexOf(targetTier as Tier);
    if (tgtIdx < curIdx) {
      return { ok: false, error: "tier_downgrade_human_only", detail: { from: state.tier, to: targetTier } };
    }
  }
  if (targetTier === "T0" && state.blast_radius_flags.length > 0) {
    return { ok: false, error: "t0_blast_radius_veto", detail: { flags: state.blast_radius_flags } };
  }
  return PASS;
}

export type { ReviseEscalation };
