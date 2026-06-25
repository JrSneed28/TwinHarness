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
  engagedStagesFor,
  isFinalVerification,
  stageContract,
  STAGE_PIPELINE,
} from "./stages";
import { artifactIntegrity, reviseEscalations, sliceProgress, type ReviseEscalation } from "./health";
import { computeBreakdown } from "./coverage";
import { loadVerifyConfig, readVerifyReport, readVerifyReportValidated } from "./verify";
import { gatingObligations, reduceDecisions, readDecisionEvents } from "./decisions";
import { runRepoCheckCached, repoMapPartialMarker, REPO_NO_MAP_EXIT } from "../commands/repo";
import { interviewReady } from "../commands/interview";
import { readSimulationLedger, scanForSimulationHits, simEntryBlocksProductionReality, computeUnledgeredDistHitsReceiptAware, uncoveredAfterExceptions, SimulationLedgerCorruptError } from "../commands/sim";
import { testerRecordPresent } from "./tester";
import {
  collectTerminalEntities,
  readReceiptValidated,
  readTierCorrespondenceReceipts,
  verifyTierCorrespondenceChain,
  computeBriefDigest,
  TASK_BRIEF_RELPATH,
  type TierCorrespondenceReceipt,
} from "./receipts";
import { loadBriefFromFile } from "./brief";
import { classifyBrief } from "./tier-classify";
import { bsc8EnforcementEnabled } from "./bsc8-flag";
import { readApprovalValidated, readApprovalReceipts, readExternalApprovals, isHumanGateStage } from "./approvals";
import { readRealizationReceipts, readExternalRealizationReceipts } from "./realization";
import {
  type DriverDimensionReceipt,
  readDriverReceipts,
  readExternalDriverReceipts,
  verifyDriverChain,
  validateDriverReceiptContent,
  driverCanonicalText,
  SEED_DIMENSION_NAMES,
} from "./verification-driver";
import { loadExternalPublicKey, externalKeyId, verifyCanonical } from "./receipt-signing";
import { bsc3EnforcementEnabled } from "./bsc3-flag";
import { realizationEnforcementEnabled } from "./bsc1-flag";
import { bsc2EnforcementEnabled } from "./bsc2-flag";
import { bsc9EnforcementEnabled } from "./bsc9-flag";
import {
  type ReadinessValidationStatus,
  readReadinessReceiptValidated,
  readinessRefId,
} from "./interview-readiness";
import { type ProjectionInfidelity, loadProjectionFixtures, runProjectionOracle } from "./projection-oracle";
import {
  type AssertionReqSummary,
  type AssertionContentStatus,
  computeAssertionPresenceGround,
  assertionGroundDigest,
  readAssertionPresenceReceipts,
  verifyAssertionPresenceChain,
  validateAssertionPresenceContent,
  validWaivedReqs,
  readMutationKillValidated,
} from "./assertion-presence";
import {
  type RealizationValidationStatus,
  ownedReqsForDoneSlices,
  unresolvedDoneSliceReqs,
  loadRepoMapForRealization,
  readRealizationReceiptValidated,
  ensureRealizationMigrationOpportunistic,
} from "./realization";
import {
  type GroundKind,
  type GroundingReceipt,
  type GroundingBudget,
  type ToleranceMetricVerdict,
  requiredGroundKindsForWorkClass,
  readGroundingValidated,
  validateGroundingContent,
  validGroundingExemptions,
  groundingExemptionKey,
  validGroundingBudgets,
  toleranceThresholdVerdicts,
} from "./grounding";
import { bsc10EnforcementEnabled, bsc10KindEnforced } from "./bsc10-flag";

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
  /**
   * A NON-blocking structured warning surfaced by a rung that PASSED (`ok:true`) but
   * observed a soft anomaly the operator should see. Used by the WARN-phase of a
   * not-yet-enforced rung (BSC-7 human-approval, Axis-B slice-3a): it carries the same
   * `{ token, detail }` shape a block would, so the warn→enforce flip is a one-line
   * change (move the payload from `notice` into `error`/`detail` and set `ok:false`),
   * and so the warning is observable on the result without weakening the gate.
   */
  notice?: { token: string; detail?: Record<string, unknown> };
  /**
   * BSC-3 / Axis-B slice-4a — the per-dimension verification-driver observation +
   * trust-label summary `checkProductionReality` computes for the final-verification run.
   * The Integrator (I1) renders this in `th gate production-reality` output + the MCP twin
   * WITHOUT adding logic: this rung COMPUTES `observed` (the dimension is evidenced by the
   * current `verify-report.json`) and `trustLabel` (derived PURELY from signature
   * verification — `valid` in-process attested, `valid-grounded` external-signature-
   * verified, `forged` claims-external-but-fails-verify), and the renderer just surfaces it.
   * Present on the final-verification result whether the rung PASSED or BLOCKED (and
   * whether or not enforcement is flag-enabled), so the trust posture is always visible.
   */
  dimensions?: DriverDimensionSummary[];
  /**
   * BSC-2 / Axis-B slice-6 — the per-REQ assertion-PRESENCE observability summary the
   * assertion rung computes for the final-verification run (the I1 hook, mirroring how
   * `dimensions?` rides on the result). For each `tested` REQ-ID it reports the non-trivial
   * assertion count, whether it is assertion-free (an offender), its `trustLabel` (derived
   * from the trust source — see {@link AssertionTrustLabel}), and whether a valid signed
   * waiver exempts it. Seed-order deterministic (sorted by `reqId`). Attached on PASS, on
   * BLOCK, and in WARN — so the assertion posture is always visible. Seeds the BSC-5
   * dimension-set view.
   */
  assertionPresence?: AssertionPresenceSummary[];
  /**
   * BSC-2 / Axis-B slice-6 (2b) — the module-scoped mutation-kill EFFICACY signal, a DISTINCT
   * observability axis from the per-REQ presence summary. A signature-verified external
   * MutationKillReceipt proves a controlled runner's suite KILLS injected faults — but ONLY for
   * the single source module it names (`scope`). It is NOT REQ-scoped, so it NEVER propagates
   * onto per-REQ presence `trustLabel`s and NEVER overrides the presence rung (presence ≠
   * efficacy — the plan treats 2a/2b as COMPLEMENTARY, never substitutes; review HIGH). This
   * field records the efficacy spike for its `scope` for the I1 hook only. `forged` is NOT
   * carried here — a forged receipt is a hard `mutation_kill_forged` block on the result.
   */
  mutationEfficacy?: MutationEfficacySignal;
  /**
   * BSC-10 / Axis-B slice-BSC10a — the per-required-ground-kind external-reference grounding
   * summary the grounding rung computes for the final-verification run (the observability hook,
   * mirroring how `dimensions?`/`assertionPresence?` ride on the result). For each REQUIRED
   * ground-kind it reports whether it is grounded, its conformance status vs budget, its
   * `trustLabel` (`valid` in-process attested / `valid-grounded` external-signature-verified),
   * whether a signed exception covers it, and the cross-check-mismatch flag. Attached on PASS,
   * on BLOCK, and in WARN — so the grounding posture is always visible. The verdict is computed
   * ONCE (hoisted before the human-approval leg) and the SAME verdict is folded here without a
   * recompute (Principle 1: single live recompute, consumed — never attached-but-stale).
   */
  grounding?: GroundingSummary[];
}

/**
 * BSC-10 trust label for one required ground-kind's posture, derived PURELY from the grounding
 * TRUST SOURCE (never a self-asserted field):
 *  - `valid`          — an in-process grounding receipt grounds this kind. The in-process producer
 *                       is agent-mintable, so this is ATTRIBUTION-ONLY.
 *  - `valid-grounded` — an EXTERNAL grounding receipt whose Ed25519 signature verifies (the
 *                       in-process surface cannot forge it). The STRONGER form.
 *  - `ungrounded`     — the required kind has no trusted receipt (absent, or an unverifiable
 *                       external claim). Absence ≠ forgery — there is deliberately NO `forged`
 *                       per-kind label in slice-BSC10a.
 */
export type GroundingTrustLabel = "valid" | "valid-grounded" | "ungrounded";

/** One required ground-kind's grounding observation + trust label, for the observability hook. */
export interface GroundingSummary {
  /** The required ground-kind this summary grounds. */
  groundKind: GroundKind;
  /** True iff a trusted receipt (in-process or external-verified) grounds this kind. */
  grounded: boolean;
  /** The grounding trust label (see {@link GroundingTrustLabel}). */
  trustLabel: GroundingTrustLabel;
  /**
   * The conformance status for this ground (`within-budget` / `over-budget` / `unobserved` /
   * `missing` / `chain_mismatch`). `missing` when the required kind has no trusted receipt;
   * `chain_mismatch` when a `digest-manifest` ground is trusted but a threaded BSC-1/3/7
   * `manifest_digest` disagrees with it (the evidence-spine offender — observable here even when
   * `digest-manifest` was not in the required-set); otherwise the receipt's content verdict. The
   * fail-closed axis the gate blocks on under enforce.
   */
  conformance: "within-budget" | "over-budget" | "unobserved" | "missing" | "chain_mismatch";
  /** True iff a valid signed exception suspends this ground's budget (Slice-B; always false in slice-A). */
  exceptionCovered: boolean;
  /**
   * BSC-10 / Slice C (C4b/C4c) — the per-tolerance-metric observed-vs-SIGNED-budget diff for a
   * `visual-hash` ground, so a human sees the threshold breach at the approval. Absent on the
   * deterministic kinds (`digest-manifest`/`version-pin` are binary exact-equality with no
   * tolerance band) and on a `visual-hash` ground with no tolerance metric. Each entry carries the
   * gate's OWN arithmetic verdict (`observed` vs the signed `threshold`), NOT the receipt's
   * self-reported status. `threshold:null` ⇒ `unobserved` (stubbed) or `unpinned` (no signed budget).
   */
  toleranceDiff?: {
    metric: "version" | "api" | "visual" | "a11y";
    observed: number | "unobserved";
    threshold: number | null;
    status: "within-budget" | "over-budget" | "unobserved" | "unpinned";
  }[];
}

/**
 * BSC-2 trust label for one REQ's assertion-PRESENCE posture, derived PURELY from the presence
 * TRUST SOURCE (never from a self-asserted field, and never from the module-scoped mutation
 * receipt — mirrors {@link DriverTrustLabel}):
 *  - `valid`             — an in-process assertion-presence receipt grounds this REQ. The
 *                          in-process producer is agent-mintable, so this is ATTRIBUTION-ONLY
 *                          (presence is sensed, but the producer carries zero trust weight).
 *  - `attested-presence` — a non-trivial assertion is observed for this REQ from the fresh
 *                          recompute (the sensed PRESENCE fact). NEVER an efficacy claim.
 *
 * There is deliberately NO `valid-grounded` here: efficacy is a MODULE-scoped property carried
 * SEPARATELY by {@link MutationEfficacySignal}, never a per-REQ presence label (review HIGH/MEDIUM).
 */
export type AssertionTrustLabel = "valid" | "attested-presence";

/** One REQ's assertion-presence observation + trust label, for the observability hook (I1). */
export interface AssertionPresenceSummary {
  /** The `tested` REQ-ID this summary grounds. */
  reqId: string;
  /** Non-trivial (cannot-be-tautological) `expect(...)` assertions observed for this REQ. */
  nonTrivialAssertions: number;
  /** True iff `nonTrivialAssertions === 0` — the per-REQ offender predicate. */
  assertionFree: boolean;
  /** The presence trust label (see {@link AssertionTrustLabel}) — NEVER an efficacy claim. */
  trustLabel: AssertionTrustLabel;
  /** True iff a valid signed waiver exempts this REQ from the offender block. */
  waived: boolean;
}

/**
 * The module-scoped mutation-kill efficacy signal (BSC-2 2b) — a signature-verified external
 * MutationKillReceipt's proven efficacy for the SINGLE source module it names. A DISTINCT
 * observability axis (never a per-REQ presence label, never a presence-rung pass-override).
 */
export interface MutationEfficacySignal {
  /** Always `"valid-grounded"` — only a signature-verified receipt produces this signal. */
  status: "valid-grounded";
  /** The single source module the controlled runner mutated (e.g. `"src/core/hash.ts"`). */
  scope: string;
  /** The receipt's kill score (`mutants_killed / mutants_generated`, 0..1). */
  score: number;
}

/**
 * BSC-3 trust label for a driver-dimension receipt, derived PURELY from SIGNATURE
 * VERIFICATION — NEVER from a self-asserted `producer_kind` field:
 *  - `valid`          — an in-process attested receipt whose content re-derives clean
 *                       (no signature claim). `producer_identity` carries ZERO trust weight.
 *  - `valid-grounded` — an EXTERNAL receipt whose Ed25519 signature verifies against the
 *                       loaded external public key (the in-process surface cannot forge it).
 *  - `forged`         — a receipt that CLAIMS external/signed (carries a signature/key_id)
 *                       but whose signature FAILS verification (key absent, wrong key, or
 *                       tampered/replayed bytes). The unprovable independence claim BLOCKS.
 */
export type DriverTrustLabel = "valid" | "valid-grounded" | "forged";

/** One observed driver dimension + its trust label, for the observability hook (I1). */
export interface DriverDimensionSummary {
  /** The dimension name (a seed dimension this run recorded as observed). */
  name: string;
  /** True iff the current `verify-report.json` still evidences this dimension. */
  observed: boolean;
  /** The trust label derived from signature verification (see {@link DriverTrustLabel}). */
  trustLabel: DriverTrustLabel;
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

/**
 * Rung f (next.ts:170) — brownfield repo-map freshness before implementation unlock.
 *
 * P4-10: uses the cached freshness check so this hot gate path does not re-hash the
 * whole tree on every `th next` / unlock attempt.
 *
 * P4-5: a PARTIAL map (a capped/incomplete scan) is no longer silently treated as
 * fresh. A brownfield unlock rests on the repo-map being a TRUSTWORTHY picture of the
 * codebase; an incomplete scan means whole regions of the repo were never seen, so
 * unlocking implementation on it is exactly the "silent partial" failure #5 warns
 * about. We therefore BLOCK unlock on a partial map (distinct `repo_map_partial`
 * code, so the operator is told to raise the caps and re-scan rather than chase a
 * phantom staleness diff). Staleness (added/removed/modified/absent) still blocks via
 * `repo_map_stale` as before.
 */
export function checkRepoMap(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  if (state.project_mode === "brownfield" && !state.implementation_allowed) {
    // P4-5 — a PARTIAL (capped) map is incomplete: whole regions of the repo were
    // never seen, so unlocking on it repeats the silent-partial failure #5. This is
    // checked FIRST and independently of staleness — a partial map's drift diff (a
    // default-cap re-scan would flag the unscanned files as "added") is a red herring;
    // the real fix is to raise the caps and complete the scan, which `repo_map_partial`
    // tells the operator to do. The partial marker is read from the PERSISTED map (the
    // deterministic `capHit`), not from a re-scan, so it is cheap and cap-agnostic.
    const marker = repoMapPartialMarker(paths);
    if (marker.partial) {
      return { ok: false, error: "repo_map_partial", detail: { capHit: marker.capHit } };
    }
    // Otherwise enforce freshness (added/removed/modified/absent) via the cached check
    // (P4-10) so this hot gate path does not re-hash the whole tree on every attempt.
    const check = runRepoCheckCached(paths);
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
 * Rung (NEW — BSC-7 / Axis-B slice-3a, WARN PHASE) — the human-approval stage-advance
 * rung. `humanGate` was a declarative-only flag with ZERO predicate consumers (pure
 * gate theater): this is the missing sensor. It fires when advancing OUT of a
 * `humanGate` stage — that stage must carry a `valid`/`valid-grounded`/`legacy`
 * approval bound to the current snapshot + governing-artifact digest
 * ({@link readApprovalValidated}).
 *
 * WARN PHASE (this commit, slice-3a C-1): the rung is registered + invoked but blocks
 * NOTHING — it ALWAYS returns `ok:true`. When the approval is missing/invalid it
 * attaches a NON-blocking {@link GateResult.notice} carrying the stable token
 * `human_approval_unverified` plus `{ stage, status }`, so the soft anomaly is
 * observable on the result without reding any fixture that previously advanced freely.
 *
 * WARN→ENFORCE SEAM (slice-3a C-3): the flip to a hard block is a ONE-LINE change at
 * the marked return below — swap the `notice` payload into `error`/`detail` and set
 * `ok:false`. The completion rung (C-2) reuses the SAME token over the closed
 * required-set; this advance rung gates only the single stage being crossed.
 */
export function checkHumanApprovalAdvance(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  const current = canonicalizeStage(state.current_stage);
  // Only applies when advancing OUT of a humanGate stage (mirrors rungAppliesAtStage's
  // arm). A non-humanGate current stage carries no approval obligation.
  if (!isHumanGateStage(current)) return PASS;

  const validated = readApprovalValidated(paths, current);
  // Accept set: a `valid` (in-process attested), `valid-grounded` (external keyed,
  // slice-3b), or `legacy` (grandfathered) approval clears the rung. Anything else —
  // absent / stale / target_missing / target_mismatch / forged / tampered — is a
  // missing/invalid approval.
  if (
    validated.status === "valid" ||
    validated.status === "valid-grounded" ||
    validated.status === "legacy"
  ) {
    return PASS;
  }

  // ENFORCE PHASE (slice-3a C-3) — advancing OUT of a humanGate stage without a
  // snapshot+governing-artifact-digest-bound approval is a hard block. The warn baseline
  // (e1de8fd) attached the SAME token as a non-blocking `notice`; this is the one-line
  // warn→enforce flip (move the payload into `error`/`detail` and set `ok:false`), so a
  // reviewer can `git revert` this commit and land back on the green warn state. The
  // {ok:false, error, detail} field shape mirrors the sibling blocking rungs in this file
  // (e.g. checkGoverningArtifact / the BSC-4 terminal rung in checkProductionReality).
  return {
    ok: false,
    error: "human_approval_unverified",
    detail: { stage: current, status: validated.status },
  };
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
  // R-23: read through loadVerifyConfig (NOT readVerifyConfig) so a present-but-
  // CORRUPT verify.json fails CLOSED. readVerifyConfig collapses a corrupt config to
  // `{ commands: [] }`, which made the `verify_suite_never_run` rung skip (length 0)
  // and the final-verification gate PASS on an unreadable config — the same fail-OPEN
  // that `runVerifyRun` already refuses. A corrupt config is now its own failing rung.
  const verifyLoaded = loadVerifyConfig(paths);
  if (verifyLoaded.status === "corrupt") {
    return { ok: false, error: "verify_config_corrupt", detail: {} };
  }
  const verifyCfg = verifyLoaded.config;
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
  // SG3 P2-C (enforce) — the production-reality rung: at final-verification, a run may
  // not be certified complete while a user-visible production path depends on unresolved
  // simulation / verify is red / no Tester record / dist carries unledgered simulation.
  const pr = checkProductionReality(paths, state);
  if (!pr.ok) return pr;
  // Propagate the PASS result (not a bare PASS) so the BSC-3 `dimensions` trust-label
  // summary (and any non-blocking `notice`) checkProductionReality attaches rides up to
  // `canCompleteRun`/`th next` for the I1 observability hook.
  return pr;
}

/**
 * Rung m (NEW — SG3 P2-C, audit C-05..C-08) — the PRODUCTION-REALITY rung. A run may
 * not be certified complete while its user-visible production path still depends on
 * unresolved simulated behavior. SEVEN sub-checks, each a DISTINCT stable error token
 * (the order is the short-circuit order; the first failing one is returned):
 *
 *   1. `simulation_unretired`         — a non-retired simulation ledger entry maps to
 *                                       a user-visible path (`blocksProductionReality`).
 *   2. `production_verify_not_green`  — the last `th verify run` is not green (or a
 *                                       configured suite was never run / the config is
 *                                       corrupt) — production-targeted commands must pass.
 *   3. `tester_record_missing`        — no live-QA Tester run record is attached
 *                                       (`tester.ts` — the audit's mandatory live QA).
 *   4. `unledgered_simulation_in_dist`— `dist/` carries simulation patterns
 *                                       (mock/fake/stub/…) with no active ledger entry.
 *   5. `scan_coverage_incomplete`     — the two-tier dist scan could not deep-inspect
 *                                       some enumerated `dist/` path (file_limit /
 *                                       aggregate_limit / watchdog / read_error) and it
 *                                       is not exonerated by a valid external-signed
 *                                       exception ack (BSC-6 — fail closed on the scan's
 *                                       own incompleteness; recomputed fresh every run).
 *   6. `human_approval_unverified`    — (BSC-7 / Axis-B slice-3a) some stage in the
 *                                       CLOSED required-set (`requiredHumanGateStages`:
 *                                       humanGate ∩ engaged ∩ ordinal-≤-current) lacks a
 *                                       `valid`/`valid-grounded`/`legacy` approval bound
 *                                       to the current snapshot + governing-artifact
 *                                       digest (`absent`/`stale`/`target_*`/`forged`/
 *                                       `tampered`). Re-validated FRESH; the L1 backstop
 *                                       the `--emergency`/`state set` jump cannot route
 *                                       around (the jumped-over gate is engaged-and-not-
 *                                       future ⇒ required).
 *   7. `grounding_unverified`         — (BSC-10 / Axis-B slice-BSC10a) a REQUIRED external-
 *                                       reference ground-kind (per the work-class matrix +
 *                                       the UX-surface force-rule) is `missing` /
 *                                       `over_budget` / `unobserved` and not exonerated.
 *                                       WARN-first (`bsc10EnforcementEnabled()`, default OFF
 *                                       in slice-BSC10a): the verdict is hoisted once before
 *                                       the BSC-7 approval leg (a present-but-unconformant
 *                                       ground also blocks approval ACCEPTANCE, PCC-1) and
 *                                       re-used by a thin summary rung — never recomputed.
 *
 * Two further fail-closed tokens are NOT sub-checks of the production path but guard the
 * rung's own inputs: `terminal_receipt_unverified` (BSC-4 terminal-flip grounding — every
 * in-force drift-resolution/decision-approval must carry a valid/legacy receipt) and
 * `simulation_ledger_corrupt` (an unreadable ledger fails closed). Together the rung can
 * emit NINE distinct stable tokens; the seven above are the production-reality sub-checks.
 *
 * This is the mechanical form of the audit's required invariant — a COMPLETION gate.
 * It is now COMPOSED into `checkFinalVerification` (and, via it, `canAdvanceStage`'s
 * final-stage branch) plus `canUnlockImplementation`. Because production reality is a
 * CERTIFY-COMPLETION condition, the rung ONLY enforces at the completion boundary
 * (`final-verification`): at any earlier stage there is no built `dist/` and no Tester
 * record yet, so it returns PASS — exactly the stage-aware shape `checkInterview` uses
 * to gate only the front of the pipeline. This keeps the composed if-lines a no-op for
 * every non-final run (no spurious obligation-ladder churn) while making the
 * final-verification gate refuse a fake-backed "complete".
 *
 * `th gate production-reality` is a PURE READER of this predicate; the MCP gate tools
 * (`th_stage_advance`/`th_implementation_unlock`) inherit it FREE through the composed
 * ladder, so a blocked `th next` and a blocked MCP gate tool return the IDENTICAL token.
 *
 * A corrupt simulation ledger fails CLOSED with `simulation_ledger_corrupt` (the same
 * fail-closed posture `checkFinalVerification` takes on a corrupt verify config).
 *
 * BSC-3 / Axis-B slice-4a — the SEVENTH production-reality sub-check (the
 * verification-driver dimension grounding) is composed LAST, governed by the
 * `bsc3EnforcementEnabled()` rollout flag (defaults ON). See {@link evaluateDriverDimensions}
 * for the verdict logic and {@link checkDriverDimensions} for the enforcement+observability
 * wiring. It can emit the stable token `driver_dimension_unverified`.
 */
/**
 * True iff a driver-dimension receipt CLAIMS to be external/signed — i.e. it carries
 * EITHER a `signature` trailer OR a `key_id`. Such a receipt MUST prove itself with a
 * verifying Ed25519 signature; a claim that fails verification is `forged` (BSC-3 B2/B4).
 * A receipt with neither field is an in-process attested receipt (no external claim).
 */
function driverReceiptClaimsExternal(r: DriverDimensionReceipt): boolean {
  return typeof r.signature === "string" || typeof r.key_id === "string";
}

/**
 * The verification-driver verdict for the current run (BSC-3 B1–B4). The classification
 * mirrors the receipts/approvals precedence EXACTLY: an EXTERNAL claim is decisive and
 * must prove itself by signature; otherwise the in-process attested path applies; and the
 * ABSENCE of any receipt is grandfathered as in-process attested (`valid`, allowed) —
 * NEVER `forged` (ABSENCE ≠ FORGERY, so 4a stays green on forks/local where the CI key is
 * absent and on legacy pre-receipt runs).
 *
 *  - `blocked:"chain"`         — the driver chain (in-process or external) does not verify
 *                                (`verifyDriverChain` not ok) → tamper → BLOCK.
 *  - `blocked:"forged"`        — a receipt CLAIMS external/signed but its signature FAILS
 *                                verification (key absent/wrong, or tampered/replayed) →
 *                                the unprovable independence claim BLOCKS.
 *  - `blocked:"unobserved"`    — the selected receipt's recorded ground no longer
 *                                re-derives from `verify-report.json`
 *                                (`validateDriverReceiptContent` →
 *                                `dimension_unobserved`/`evidence_missing`) → a claimed
 *                                dimension that does not correspond to a real run → BLOCK.
 *  - `ok:true`                 — accepted: a `valid` in-process attested receipt whose
 *                                content re-derives clean, a `valid-grounded` external
 *                                receipt whose signature verifies, OR no receipt at all
 *                                (grandfathered in-process attested).
 *
 * In every outcome `dimensions` carries the per-dimension `{name, observed, trustLabel}`
 * summary for the observability hook (I1) — computed even when blocked, even when
 * enforcement is disabled, so the trust posture is always visible.
 */
type DriverVerdict =
  | { ok: true; dimensions: DriverDimensionSummary[] }
  | {
      ok: false;
      reason: "chain" | "forged" | "unobserved";
      dimensions: DriverDimensionSummary[];
      detail: Record<string, unknown>;
    };

/**
 * Build the per-dimension observability summary for a selected receipt under a single
 * trust label. `observed` is re-derived against `verify-report.json` via the shared
 * {@link validateDriverReceiptContent} ground (a recorded dimension the current report no
 * longer evidences reads `observed:false`). The seed-name order is preserved so the
 * rendered list is deterministic.
 */
function summarizeDriverDimensions(
  paths: ProjectPaths,
  receipt: DriverDimensionReceipt,
  trustLabel: DriverTrustLabel,
): DriverDimensionSummary[] {
  const content = validateDriverReceiptContent(paths, receipt);
  const unobserved = new Set(content.unobservedDimensions ?? []);
  // `evidence_missing` invalidates the whole ground — no recorded dimension re-derives.
  const evidenceMissing = content.status === "evidence_missing";
  const recorded = receipt.dimensions.map((d) => d.name);
  const ordered = [
    ...SEED_DIMENSION_NAMES.filter((n) => recorded.includes(n)),
    ...recorded.filter((n) => !SEED_DIMENSION_NAMES.includes(n)),
  ];
  return ordered.map((name) => ({
    name,
    observed: !evidenceMissing && !unobserved.has(name),
    trustLabel,
  }));
}

/**
 * Verify a driver receipt's Ed25519 signature against the loaded external public key —
 * the SOLE basis for the `valid-grounded` trust label (BSC-3 B2). Mirrors
 * `approvals.verifyExternalApproval` / `receipts.readReceiptValidated` EXACTLY: load the
 * verifier's public key ({@link loadExternalPublicKey}, env `TH_RECEIPT_PUBLIC_KEYFILE`);
 * with NO key (the default fork/local/test path) verification is impossible ⇒ `false` ⇒ a
 * receipt that claimed external classifies `forged`. The candidate's `key_id` must match
 * {@link externalKeyId} of the loaded key, then {@link verifyCanonical} the `signature`
 * over the receipt's canonical text with the `recordHash`/`signature` trailers stripped
 * ({@link driverCanonicalText} drops `recordHash`; we also drop `signature`). The crypto
 * is REUSED, never reinvented.
 */
function driverSignatureVerifies(receipt: DriverDimensionReceipt): boolean {
  const publicKey = loadExternalPublicKey();
  if (publicKey === null) return false;
  if (typeof receipt.signature !== "string") return false;
  if (receipt.key_id !== externalKeyId(publicKey)) return false;
  const { recordHash: _rh, signature: _sig, ...signedView } = receipt;
  return verifyCanonical(driverCanonicalText(signedView), receipt.signature, publicKey);
}

/**
 * Evaluate the verification-driver dimension grounding for the current run (BSC-3 B1–B4),
 * reading BOTH the in-process store (`readDriverReceipts`) and the external store
 * (`readExternalDriverReceipts`). The verdict drives BOTH enforcement (when the flag is
 * on) AND the always-computed observability summary; see {@link DriverVerdict}.
 *
 * Order (fail-closed, mirroring readReceiptValidated):
 *   0. Tamper walk BOTH chains first ({@link verifyDriverChain}). A broken chain ⇒
 *      `blocked:"chain"` (no receipt from a tampered store can be trusted).
 *   1. An EXTERNAL claim is DECISIVE: gather every external-store receipt that claims
 *      external/signed; the LAST whose signature verifies (file order, so a re-mint wins)
 *      ⇒ `valid-grounded` and is run through the content check. If an external claim exists
 *      but NONE verifies ⇒ `forged` ⇒ BLOCK (never downgraded to the in-process verdict).
 *   2. Else the in-process path: the LATEST in-process receipt (file order). A line that
 *      CLAIMS external/signed in the in-process store is still held to the signature bar
 *      (`forged` if it does not verify) — the trust label keys on the claim, not the store.
 *   3. ABSENCE: no receipt anywhere ⇒ grandfathered in-process attested (`valid`, allowed,
 *      EMPTY dimensions) — NEVER `forged`.
 *
 * For the SELECTED receipt the content ground is re-derived ({@link validateDriverReceiptContent}):
 * `dimension_unobserved`/`evidence_missing` ⇒ `blocked:"unobserved"`. A `stale` content
 * status is NON-blocking here (the snapshot-staleness block is owned by the verify-report
 * and terminal/approval rungs; a re-run at a new HEAD mints a fresh driver receipt, and a
 * stale driver receipt simply is not the current run's receipt — blocking on it would red
 * an otherwise-clean re-run). The receipt's dimensions still summarize for observability.
 */
function evaluateDriverDimensions(paths: ProjectPaths): DriverVerdict {
  const inProcess = readDriverReceipts(paths);
  const external = readExternalDriverReceipts(paths);

  // 0. Tamper walk BOTH chains before trusting any line from them.
  const inChain = verifyDriverChain(inProcess);
  if (!inChain.ok) {
    return { ok: false, reason: "chain", dimensions: [], detail: { store: "in-process", brokenAt: inChain.brokenAt, chainReason: inChain.reason } };
  }
  const exChain = verifyDriverChain(external);
  if (!exChain.ok) {
    return { ok: false, reason: "chain", dimensions: [], detail: { store: "external", brokenAt: exChain.brokenAt, chainReason: exChain.reason } };
  }

  // 1. EXTERNAL claim is decisive. Gather every external-store receipt that claims
  //    external/signed; the LAST whose signature verifies wins (file order ⇒ re-mint wins).
  const externalClaims = external.filter(driverReceiptClaimsExternal);
  if (externalClaims.length > 0) {
    let verified: DriverDimensionReceipt | undefined;
    for (const cand of externalClaims) {
      if (driverSignatureVerifies(cand)) verified = cand;
    }
    if (verified) {
      const dims = summarizeDriverDimensions(paths, verified, "valid-grounded");
      const content = validateDriverReceiptContent(paths, verified);
      if (content.status === "dimension_unobserved" || content.status === "evidence_missing") {
        return { ok: false, reason: "unobserved", dimensions: dims, detail: { trustLabel: "valid-grounded", contentStatus: content.status, ...(content.unobservedDimensions ? { unobservedDimensions: content.unobservedDimensions } : {}) } };
      }
      return { ok: true, dimensions: dims };
    }
    // External claim present but no signature verifies ⇒ forged ⇒ BLOCK.
    const forged = externalClaims[externalClaims.length - 1]!;
    return { ok: false, reason: "forged", dimensions: summarizeDriverDimensions(paths, forged, "forged"), detail: { trustLabel: "forged", store: "external", key_id: forged.key_id ?? null } };
  }

  // 2. In-process path. The LATEST in-process receipt; a line that CLAIMS external/signed
  //    in this store is still held to the signature bar (forged if it does not verify).
  const latest = inProcess.length > 0 ? inProcess[inProcess.length - 1]! : undefined;
  if (latest) {
    if (driverReceiptClaimsExternal(latest)) {
      if (driverSignatureVerifies(latest)) {
        const dims = summarizeDriverDimensions(paths, latest, "valid-grounded");
        const content = validateDriverReceiptContent(paths, latest);
        if (content.status === "dimension_unobserved" || content.status === "evidence_missing") {
          return { ok: false, reason: "unobserved", dimensions: dims, detail: { trustLabel: "valid-grounded", contentStatus: content.status, ...(content.unobservedDimensions ? { unobservedDimensions: content.unobservedDimensions } : {}) } };
        }
        return { ok: true, dimensions: dims };
      }
      const forged = latest;
      return { ok: false, reason: "forged", dimensions: summarizeDriverDimensions(paths, forged, "forged"), detail: { trustLabel: "forged", store: "in-process", key_id: forged.key_id ?? null } };
    }
    // In-process attested receipt (no external claim) ⇒ trust label `valid`.
    const dims = summarizeDriverDimensions(paths, latest, "valid");
    const content = validateDriverReceiptContent(paths, latest);
    if (content.status === "dimension_unobserved" || content.status === "evidence_missing") {
      return { ok: false, reason: "unobserved", dimensions: dims, detail: { trustLabel: "valid", contentStatus: content.status, ...(content.unobservedDimensions ? { unobservedDimensions: content.unobservedDimensions } : {}) } };
    }
    return { ok: true, dimensions: dims };
  }

  // 3. ABSENCE ≠ FORGERY: no receipt anywhere ⇒ grandfathered in-process attested.
  return { ok: true, dimensions: [] };
}

/**
 * The BSC-3 driver-dimension sub-check (Axis-B slice-4a) — the SEVENTH production-reality
 * sub-check, composed LAST inside {@link checkProductionReality}. It ALWAYS computes the
 * verification-driver verdict (so the per-dimension trust-label `dimensions` summary is
 * available on the result for the observability hook, I1), then BLOCKS on a failing verdict
 * ONLY when enforcement is enabled ({@link bsc3EnforcementEnabled}, defaults ON).
 *
 * When enforcement is OFF the rung still attaches `dimensions` and returns PASS (the
 * rollout flag governs ENFORCEMENT only — never observation). When ON, a failing verdict
 * returns the stable token `driver_dimension_unverified` with the verdict's `reason`
 * (`chain`/`forged`/`unobserved`) + detail, AND still carries `dimensions` so the block is
 * fully diagnosable. The PASS result carries `dimensions` too.
 */
function checkDriverDimensions(paths: ProjectPaths): GateResult {
  const verdict = evaluateDriverDimensions(paths);
  // A clean PASS with NO observed dimensions (the grandfathered/absence case) carries an
  // EMPTY summary, which conveys nothing — so return a BARE PASS to preserve the prior
  // `{ ok: true }` gate contract every downstream rung composes. Only attach `dimensions`
  // when there is something to observe (the observability hook still fires for any
  // non-empty summary).
  if (verdict.ok) return verdict.dimensions.length === 0 ? PASS : { ok: true, dimensions: verdict.dimensions };
  if (!bsc3EnforcementEnabled()) {
    // Flag OFF: observe but do not block. Surface the would-be block as a non-blocking
    // notice so the warn posture is visible without weakening the gate.
    return {
      ok: true,
      dimensions: verdict.dimensions,
      notice: { token: "driver_dimension_unverified", detail: { reason: verdict.reason, ...verdict.detail } },
    };
  }
  return {
    ok: false,
    error: "driver_dimension_unverified",
    detail: { reason: verdict.reason, ...verdict.detail },
    dimensions: verdict.dimensions,
  };
}

/**
 * One failing REQ-ID in the BSC-1 realization rung + why it failed (observability). The
 * gate COLLECTS ALL failures (no first-only early return), so a renderer can list every
 * unbacked done-slice REQ at once.
 */
export interface RealizationFailure {
  /** The REQ-ID owned by a `done` slice whose realization receipt is absent/invalid. */
  reqId: string;
  /**
   * The validation status (`absent`/`tampered`/`target_missing`/`target_mismatch`/`stale`/
   * `forged`), OR `"unresolved"` for the fail-closed name-fidelity case (a done-slice REQ
   * carried by an unowned-in-map file — control 11f).
   */
  status: RealizationValidationStatus | "unresolved";
  /** The owning done slice(s), when known (absent for the `unresolved` fail-closed case). */
  owningSlices?: string[];
}

/**
 * The BSC-1 realization sub-check (Axis-B slice-5) — the EIGHTH production-reality
 * sub-check, composed LAST inside {@link checkProductionReality}. A run may not be certified
 * complete while a REQ-ID owned by a `done` slice lacks a valid, reachable, digest-fresh
 * realization referent.
 *
 * GROUND (consensus §0.2): the CLAIM is `SliceState.status==="done"` (authored
 * independently, at a different time, than the referent); the REFERENT is a digest-bound
 * source anchor recorded by `th realize`. The enumerator ranges over REQ-IDs owned by
 * `done` slices (INDEPENDENT of receipt presence, so "absent receipt blocks" is reachable),
 * recomputes the referent digest from the CACHED repo-map ({@link loadRepoMapForRealization}),
 * COLLECTS ALL failures, and blocks on absent/stale/forged/target_missing/target_mismatch/
 * tampered. A done-slice REQ that the ownership join cannot place under a known component is
 * REPORTED as `unresolved` and blocks (fail-closed name-fidelity guard, control 11f).
 *
 * Governed by `realizationEnforcementEnabled()` (defaults ON): the verdict is ALWAYS
 * computed (so the would-be block is surfaced as a non-blocking `notice` when enforcement is
 * off), but it BLOCKS with `realization_unverified` only when enforcement is on. The
 * repo-map is loaded once; an absent map means no owned REQs to enforce (the brownfield
 * `checkRepoMap` rung already owns repo-map freshness — we do not double-block here).
 */
function checkRealization(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  // FAIL-OPEN CLOSURE (team-fix #8): stamp the grandfather baseline the FIRST time the gate
  // observes a `done` slice, regardless of how that slice became done. Without this, a `done`
  // slice reached via `--emergency state set` / an imported state never stamps the marker
  // (the slice→done CLI trigger is the only other writer), so readRealizationReceiptValidated
  // grandfathers EVERY REQ as `legacy` and this rung silently never enforces. The opportunistic
  // stamp is self-locking + fail-soft (never throws into the gate) and is a one-time write.
  ensureRealizationMigrationOpportunistic(paths);

  const map = loadRepoMapForRealization(paths);
  if (map === null) return PASS; // no map ⇒ no owned-REQ obligation (freshness owned elsewhere)

  const failures: RealizationFailure[] = [];

  // Fail-closed name-fidelity guard (control 11f): a done-slice REQ the join cannot place
  // under a known component is reported, never silently dropped ("unobserved ≠ clean").
  for (const reqId of unresolvedDoneSliceReqs(map, state)) {
    failures.push({ reqId, status: "unresolved" });
  }

  // The enumerator: every REQ owned by a `done` slice must carry a valid, digest-fresh
  // realization referent. ACCEPT set: `valid` (in-process attested), `valid-grounded`
  // (external keyed + verified), `legacy` (grandfathered). Everything else BLOCKS.
  for (const owned of ownedReqsForDoneSlices(map, state)) {
    const v = readRealizationReceiptValidated(paths, owned.reqId);
    if (v.status !== "valid" && v.status !== "valid-grounded" && v.status !== "legacy") {
      failures.push({ reqId: owned.reqId, status: v.status, owningSlices: owned.owningSlices });
    }
  }

  if (failures.length === 0) return PASS;

  const detail: Record<string, unknown> = {
    failures: failures.slice(0, 20),
    total: failures.length,
    statuses: [...new Set(failures.map((f) => f.status))].sort(),
  };
  if (!realizationEnforcementEnabled()) {
    // Flag OFF: observe but do not block. Surface the would-be block as a non-blocking notice.
    return { ok: true, notice: { token: "realization_unverified", detail } };
  }
  return { ok: false, error: "realization_unverified", detail };
}

/**
 * The verdict of the BSC-2 assertion-presence sub-check, computed ONCE and used for BOTH the
 * enforcement decision AND the always-attached observability summary. `summary` is the per-REQ
 * I1 hook (seed-order deterministic). `mutationEfficacy` is the OPTIONAL module-scoped efficacy
 * signal (2b) — a DISTINCT observability axis that never gates the presence verdict (review
 * HIGH). When `ok:false` the `reason`/`detail` describe the block.
 */
type AssertionVerdict =
  | { ok: true; summary: AssertionPresenceSummary[]; mutationEfficacy?: MutationEfficacySignal }
  | {
      ok: false;
      reason: "assertion_presence_unverified" | "assertion_unobserved" | "mutation_kill_forged";
      summary: AssertionPresenceSummary[];
      detail: Record<string, unknown>;
      mutationEfficacy?: MutationEfficacySignal;
    };

/**
 * Evaluate the BSC-2 assertion-presence grounding for the current run (recompute-don't-trust +
 * fail-closed + F8 grounding). The verdict drives BOTH enforcement (when the flag is on) AND the
 * always-computed observability summary; see {@link AssertionVerdict}.
 *
 * Order:
 *   1. The CHECKED `tested` REQ set comes from `computeBreakdown`. No req file ⇒ PASS (the
 *      coverage rung owns that). No tested REQ ⇒ PASS (nothing to attest).
 *   2. MutationKill EFFICACY axis (2b) — a DISTINCT observability axis, NEVER a presence
 *      pass-override (review HIGH; presence ≠ efficacy — the plan treats 2a/2b as
 *      COMPLEMENTARY, never substitutes): `readMutationKillValidated` → `forged` ⇒ BLOCK
 *      `mutation_kill_forged` (an unprovable controlled-runner claim blocks — mirrors the
 *      driver `forged` path); `valid-grounded` ⇒ record the MODULE-scoped {@link
 *      MutationEfficacySignal} for the receipt's `scope` ONLY (observability) and CONTINUE to
 *      the presence checks — it does NOT excuse any REQ's presence gap and is NOT propagated
 *      onto per-REQ trust labels; `absent` ⇒ no-op (the common 2a path).
 *   3. Receipt correspondence (F8): read the in-process AssertionPresenceReceipt store; a
 *      tampered chain ⇒ BLOCK `assertion_presence_unverified` (reason `chain`). The LATEST
 *      receipt is selected. NO receipt at all ⇒ fail-closed `assertion_unobserved` (there ARE
 *      tested REQs but no recorded correspondence). A receipt's `target_mismatch`/`stale`
 *      content status ⇒ BLOCK `assertion_presence_unverified`. This runs ALWAYS, regardless of
 *      any mutation receipt.
 *   4. Offenders = recompute the ground FRESH; the offenders are the checked-tested REQs whose
 *      recomputed summary has `assertionFree===true` (recompute — do NOT trust the receipt's
 *      stored ground for the offender decision: the receipt is the correspondence artifact, the
 *      live recompute is the verdict). Subtract validly-WAIVED REQs. This runs ALWAYS.
 *   5. Verdict: no remaining offenders + receipt correspondence OK ⇒ PASS. Else BLOCK
 *      `assertion_presence_unverified` naming the offenders + content status. The module-scoped
 *      `mutationEfficacy` signal rides on EVERY outcome for the I1 hook.
 *
 * The `summary` is ALWAYS computed (every checked-tested REQ, sorted by reqId) so the I1 hook
 * fires on PASS / WARN / BLOCK. Trust labeling (honesty): a 2a-only REQ is `valid`
 * (receipt-grounded) or `attested-presence` (presence sensed) — there is NO `valid-grounded`
 * per-REQ presence label; module-scoped efficacy is carried separately by `mutationEfficacy`.
 */
function evaluateAssertionPresence(paths: ProjectPaths): AssertionVerdict | null {
  const bd = computeBreakdown(paths.root);
  if ("error" in bd) return null; // no req file ⇒ the coverage rung owns that; nothing to attest
  const checkedTested = new Set(bd.rows.filter((r) => r.tested).map((r) => r.req));
  if (checkedTested.size === 0) return null; // no tested REQ ⇒ nothing to attest

  // The efficacy axis (2b) — a DISTINCT observability axis, NEVER a presence pass-override
  // (review HIGH; presence ≠ efficacy). A forged controlled-runner claim BLOCKS; a verified one
  // records a MODULE-scoped efficacy signal for its `scope` only; absence is a no-op.
  const mutation = readMutationKillValidated(paths);
  const mutationEfficacy: MutationEfficacySignal | undefined =
    mutation.status === "valid-grounded" && mutation.receipt
      ? { status: "valid-grounded", scope: mutation.receipt.ground.scope, score: mutation.receipt.ground.score }
      : undefined;

  // Recompute the ground FRESH — the verdict is the live recompute, never the receipt's stored
  // ground (mirrors the BSC-6 recompute-don't-trust lesson). Build a per-REQ lookup for the
  // checked-tested set so the offender decision + the observability summary share one source.
  const ground = computeAssertionPresenceGround(paths);
  const byReq = new Map<string, AssertionReqSummary>(ground.map((s) => [s.reqId, s]));
  const waived = validWaivedReqs(paths);

  // The always-computed observability summary (seed-order deterministic). A checked-tested REQ
  // with no recomputed summary (anchored only in a non-test file, etc.) is treated as
  // assertion-free with zero non-trivial assertions (fail-closed: unobserved ≠ asserted).
  // PRESENCE trust label ONLY — the module-scoped mutation efficacy NEVER lands on a per-REQ
  // presence label (review HIGH/MEDIUM): `attested-presence` when a non-trivial assertion is
  // sensed, else `valid` (in-process receipt attribution only).
  const summary: AssertionPresenceSummary[] = [...checkedTested]
    .sort()
    .map((reqId): AssertionPresenceSummary => {
      const s = byReq.get(reqId);
      const nonTrivialAssertions = s ? s.nonTrivialAssertions : 0;
      const assertionFree = s ? s.assertionFree : true;
      const isWaived = waived.has(reqId);
      const trustLabel: AssertionTrustLabel = !assertionFree ? "attested-presence" : "valid";
      return { reqId, nonTrivialAssertions, assertionFree, trustLabel, waived: isWaived };
    });

  // 2. Efficacy axis: a forged controlled-runner claim BLOCKS (unprovable independence claim).
  // A `valid-grounded` receipt does NOT short-circuit — it is recorded as `mutationEfficacy`
  // (module-scoped observability) and we CONTINUE to the presence checks below (presence ≠
  // efficacy; the module-scoped efficacy spike cannot excuse an unrelated REQ's presence gap).
  if (mutation.status === "forged") {
    return {
      ok: false,
      reason: "mutation_kill_forged",
      summary,
      detail: { scope: mutation.receipt?.ground.scope ?? null, key_id: mutation.receipt?.key_id ?? null },
    };
  }

  // 3. Receipt correspondence (F8). Runs ALWAYS, regardless of any mutation receipt. A tampered
  // chain is fail-closed.
  const receipts = readAssertionPresenceReceipts(paths);
  const chain = verifyAssertionPresenceChain(receipts);
  if (!chain.ok) {
    return {
      ok: false,
      reason: "assertion_presence_unverified",
      summary,
      mutationEfficacy,
      detail: { contentStatus: "chain", brokenAt: chain.brokenAt, chainReason: chain.reason },
    };
  }
  const latest = receipts.length > 0 ? receipts[receipts.length - 1]! : undefined;
  if (latest === undefined) {
    // There ARE tested REQs but NO recorded correspondence ⇒ fail-closed unobserved.
    return {
      ok: false,
      reason: "assertion_unobserved",
      summary,
      mutationEfficacy,
      detail: { contentStatus: "assertion_unobserved" as AssertionContentStatus, tested: checkedTested.size },
    };
  }
  const content = validateAssertionPresenceContent(paths, latest);
  if (content.status === "target_mismatch" || content.status === "stale") {
    return {
      ok: false,
      reason: "assertion_presence_unverified",
      summary,
      mutationEfficacy,
      detail: {
        contentStatus: content.status,
        ...(content.staleReasons ? { staleReasons: content.staleReasons } : {}),
      },
    };
  }

  // 4. Offenders = checked-tested REQs that are assertion-free in the FRESH recompute, minus
  //    validly-waived REQs. Runs ALWAYS — a module-scoped mutation efficacy spike does NOT
  //    excuse an unrelated REQ's presence gap (review HIGH; presence ≠ efficacy).
  const offenders = [...checkedTested]
    .filter((reqId) => {
      const s = byReq.get(reqId);
      const assertionFree = s ? s.assertionFree : true;
      return assertionFree && !waived.has(reqId);
    })
    .sort();

  if (offenders.length === 0) return { ok: true, summary, mutationEfficacy };
  return {
    ok: false,
    reason: "assertion_presence_unverified",
    summary,
    mutationEfficacy,
    detail: { contentStatus: content.status, offenders: offenders.slice(0, 20), total: offenders.length },
  };
}

/**
 * The BSC-2 assertion-presence sub-check (Axis-B slice-6) — the NINTH production-reality
 * sub-check, composed LAST inside {@link checkProductionReality} (after realization). A run may
 * not be certified complete while a `tested` REQ-ID lacks a NON-TRIVIAL assertion (the
 * completion gate counts a REQ "tested" on anchor presence alone; a test file with no
 * cannot-fail-free assertion clears that bar — BSC-2). It ALWAYS computes the per-REQ
 * observability summary (the I1 hook), then BLOCKS on a failing verdict ONLY when enforcement
 * is enabled ({@link bsc2EnforcementEnabled} — WARN-first, defaults OFF in commit 1 / ON in
 * commit 2).
 *
 * When the verdict is null (no req file / no tested REQ) ⇒ bare PASS. When the verdict PASSES
 * with NO actionable summary anomaly the result still carries `assertionPresence` (the I1 hook
 * fires for any non-empty summary); a fully-empty summary degrades to a bare PASS to preserve
 * the `{ ok: true }` contract every downstream rung composes. When enforcement is OFF and the
 * verdict fails, the would-be block rides up as a non-blocking `notice` (warn posture) WITH the
 * summary. When ON, a failing verdict returns the stable token (`assertion_presence_unverified`
 * / `assertion_unobserved` / `mutation_kill_forged`) WITH the summary so the block is diagnosable.
 */
function checkAssertionPresence(paths: ProjectPaths): GateResult {
  const verdict = evaluateAssertionPresence(paths);
  if (verdict === null) return PASS; // no req file / no tested REQ ⇒ nothing to attest
  if (verdict.ok) {
    // Attach observability on PASS only when there is a NOTEWORTHY signal — any offender (an
    // assertion-free REQ), any validly-waived REQ, or a module-scoped mutation efficacy signal.
    // A fully-clean, all-`attested-presence` run with no efficacy signal degrades to the shared
    // bare `PASS` so the `{ ok: true }` contract every downstream rung composes is preserved
    // (mirrors checkDriverDimensions' empty-summary bare-PASS). On BLOCK/WARN they always ride.
    const noteworthy =
      verdict.summary.some((s) => s.assertionFree || s.waived) || verdict.mutationEfficacy !== undefined;
    if (!noteworthy) return PASS;
    const res: GateResult = { ok: true, assertionPresence: verdict.summary };
    if (verdict.mutationEfficacy) res.mutationEfficacy = verdict.mutationEfficacy;
    return res;
  }
  if (!bsc2EnforcementEnabled()) {
    // Flag OFF (WARN): observe but do not block. Surface the would-be block as a non-blocking
    // notice + the summary so the warn posture is visible without weakening the gate.
    const res: GateResult = {
      ok: true,
      assertionPresence: verdict.summary,
      notice: { token: verdict.reason, detail: verdict.detail },
    };
    if (verdict.mutationEfficacy) res.mutationEfficacy = verdict.mutationEfficacy;
    return res;
  }
  const res: GateResult = {
    ok: false,
    error: verdict.reason,
    detail: verdict.detail,
    assertionPresence: verdict.summary,
  };
  if (verdict.mutationEfficacy) res.mutationEfficacy = verdict.mutationEfficacy;
  return res;
}

/**
 * The 5-state verdict of the BSC-10 external-reference grounding sub-check (Axis-B slice-BSC10a),
 * computed ONCE and consumed by BOTH the split human-approval ACCEPTANCE leg AND the always-
 * attached observability summary among the reality rungs (Principle 1: single live recompute):
 *  - `not-required` — no grounding receipt declares a ground-bearing work-class ⇒ the required-set
 *                     is empty ⇒ inert PASS (not forgery). The `summary` is empty.
 *  - `grounded`     — every required ground-kind has a trusted, within-budget receipt ⇒ PASS.
 *  - `missing`      — a required ground-kind has no trusted receipt ⇒ FAIL (token `missing`).
 *  - `over-budget`  — a required kind is grounded but its conformance is `over-budget` ⇒ FAIL.
 *  - `unobserved`   — a required kind is grounded but a conformance metric is `unobserved` ⇒ FAIL
 *                     (the stubbed visual/a11y measurement is fail-closed — never a silent pass).
 *  - `tampered`     — the NON-EMPTY in-process grounding chain does not verify ⇒ FAIL, fail-closed
 *                     ("a tampered chain trusts NOTHING from it" — detection MUST have a gate
 *                     consequence). An EMPTY store verifies (`{ok:true}`) so absence stays inert
 *                     (absence ≠ forgery). This reason carries NO `offenders`/`required` (the
 *                     required-set can't be trusted from a tampered store).
 *  - `chain_mismatch` — (Slice B, SEPARATE from `tampered`) a `manifest_digest` threaded through a
 *                     shipped BSC-1 realization / BSC-3 driver / BSC-7 approval receipt DISAGREES
 *                     with the grounding receipt's own `digest-manifest` manifest digest. The
 *                     evidence-spine is supposed to thread the SAME signed-manifest digest end to
 *                     end (input-grounding ⇄ downstream realization/verification/approval); a
 *                     divergence means the approval/realization was bound to a DIFFERENT reference
 *                     than the one that was grounded ⇒ FAIL. Absent threading (additive-optional,
 *                     omit-when-absent) ⇒ NO mismatch (back-compat PASS — pre-BSC-10 receipts).
 *                     `offenders` carries `["digest-manifest"]` (the manifest-bearing kind) so the
 *                     per-kind enforce-flip ({@link bsc10KindEnforced}) treats it as a DETERMINISTIC
 *                     block in Slice B.
 *  - `manifest_digest_absent` — (Slice C / C4a) a governing BSC-1/3/7 receipt OPTED IN to the
 *                     evidence-spine (`grounding_bound === true`) but carries NO `manifest_digest` —
 *                     it declared participation yet never bound itself to the signed EvidenceManifest.
 *                     The per-receipt opt-in is the TRIGGER, so an UNENROLLED receipt (the field
 *                     absent/false) is byte-identical back-compat PASS (absence ≠ forgery — shipped
 *                     BSC-1/3/4 probes stay GREEN). Offender `["digest-manifest"]` (the manifest-
 *                     bearing kind), so {@link bsc10KindEnforced} gates it as DETERMINISTIC. This
 *                     COMPLEMENTS `chain_mismatch`: that catches a threaded digest that DISAGREES;
 *                     this catches an enrolled receipt that threaded NOTHING.
 *
 * The `summary` (one entry per REQUIRED ground-kind) is ALWAYS computed so the observability hook
 * fires on PASS / WARN / BLOCK. `crossCheckFlag` carries the `"class-cross-check-mismatch"`
 * literal up to the gate detail when a declared≠derived class conflict was surfaced. `tampered` /
 * `chain_mismatch` are `detail.reason` VALUES (via the top-level `grounding_unverified` token), NOT
 * new top-level stable tokens — the gate token-count docstrings are unaffected.
 */
type GroundingReason =
  | "missing"
  | "over_budget"
  | "unobserved"
  | "tampered"
  | "chain_mismatch"
  | "manifest_digest_absent";
type GroundingVerdict =
  | { ok: true; required: GroundKind[]; summary: GroundingSummary[]; crossCheckFlag?: "class-cross-check-mismatch" }
  | {
      ok: false;
      reason: GroundingReason;
      required: GroundKind[];
      summary: GroundingSummary[];
      offenders: GroundKind[];
      crossCheckFlag?: "class-cross-check-mismatch";
    };

/**
 * Map a grounding receipt's content-validation status to the per-kind conformance + offender
 * verdict precedence (fail-closed, `unobserved` outranks `over-budget`): a trusted receipt whose
 * content is `unobserved` ⇒ `unobserved`; `over-budget`/`stale` ⇒ `over_budget` (a diverged
 * snapshot is treated as a budget failure for the grounding axis); else `within-budget`.
 *
 * SIGNED-BUDGET THRESHOLD COMPARISON IS NOT YET CONSUMED (MED-1, deferred to Slice C). The
 * over-budget verdict here comes from the receipt's OWN externally-signed `conformance[].status`;
 * the signed budget THRESHOLD (`validGroundingBudgets`) is validated for AUTHENTICITY (3-party
 * authority, E4) but its `threshold` is NEVER compared against the metric's `observed` value yet.
 * This is correct sequencing: budgets express TOLERANCES, meaningful only for the runner-sensitive
 * kinds (visual perceptual-diff, a11y scan-count) that Slice C actually measures. The Slice-B
 * deterministic kinds (`digest-manifest`, `version-pin`) are binary match/no-match, so the signed
 * receipt status fully decides them. Observed-vs-threshold evaluation lands in Slice C alongside
 * the tolerance-based visual/a11y measurement.
 */
function groundingConformanceOf(
  paths: ProjectPaths,
  receipt: GroundingReceipt,
): "within-budget" | "over-budget" | "unobserved" {
  const v = validateGroundingContent(paths, receipt);
  if (v.status === "unobserved") return "unobserved";
  if (v.status === "over-budget" || v.status === "stale" || v.status === "target_mismatch") return "over-budget";
  return "within-budget";
}

/**
 * Combine the receipt's OWN content verdict (`selfConformance`) with the INDEPENDENT gate-side
 * tolerance-threshold verdicts (C4c) and return the WORST — fail-closed, NEVER the laxer of the
 * two, so a generous self-reported `status` cannot mask a breached signed budget. Precedence:
 * `unobserved` (unmeasured / unpinned-tolerance — cannot be gated as passing) > `over-budget`
 * (measured but out of tolerance) > `within-budget`. A tolerance `unpinned` (observed but NO signed
 * budget) collapses to `unobserved` — it is the same "cannot be confirmed within tolerance" fail-
 * closed class. An EMPTY `tolerance` (deterministic kind, or a visual-hash with no tolerance
 * metric) leaves `selfConformance` unchanged (the Slice-B posture for the deterministic kinds).
 */
function worseGroundingConformance(
  selfConformance: "within-budget" | "over-budget" | "unobserved",
  tolerance: ToleranceMetricVerdict[],
): "within-budget" | "over-budget" | "unobserved" {
  const rank = { unobserved: 2, "over-budget": 1, "within-budget": 0 } as const;
  let worst: "within-budget" | "over-budget" | "unobserved" = selfConformance;
  const consider = (c: "within-budget" | "over-budget" | "unobserved"): void => {
    if (rank[c] > rank[worst]) worst = c;
  };
  for (const t of tolerance) {
    // `unpinned` (observed but no signed tolerance) and `unobserved` (stub) are BOTH the fail-closed
    // "cannot be gated as passing" class ⇒ collapse to `unobserved`; `over-budget` stays over-budget.
    if (t.status === "unobserved" || t.status === "unpinned") consider("unobserved");
    else if (t.status === "over-budget") consider("over-budget");
  }
  return worst;
}

/**
 * The grounding-side manifest digest the evidence-spine threads — the `manifestDigest` of the
 * trusted `digest-manifest` ground (in-process `valid` or external `valid-grounded`). `null` when
 * no `digest-manifest` ground is trusted (nothing to thread against ⇒ no `chain_mismatch` is
 * possible). This is the AUTHORITATIVE digest the BSC-1/3/7 threaded `manifest_digest` must match.
 */
function groundingManifestDigest(validated: ReturnType<typeof readGroundingValidated>): string | null {
  const entry = validated.byKind.get("digest-manifest");
  if (entry === undefined) return null;
  const ground = entry.receipt.ground;
  return ground.groundKind === "digest-manifest" ? ground.manifestDigest : null;
}

/**
 * Every `manifest_digest` threaded through the shipped BSC-1 realization / BSC-3 driver / BSC-7
 * approval receipts (in-process + external stores), de-duplicated. `manifest_digest` is ADDITIVE-
 * OPTIONAL (omit-when-absent), so a pre-BSC-10 receipt contributes NOTHING and the set is empty ⇒
 * back-compat (no `chain_mismatch`). The field is signature/hash-bound on each receipt (a swapped
 * digest breaks that receipt's own `recordHash`/signature — but this reader does NOT itself verify
 * those chains/signatures (and the contributing rungs may be in WARN), so a threaded value is NOT
 * proven authentic here. That is SAFE because the cross-check is FAIL-CLOSED-ONLY: a disagreeing
 * digest can only force a `chain_mismatch` BLOCK, never a pass. The deliberate trade-off is that a
 * file-writer without the key can inject a bogus external `manifest_digest` to provoke a spurious
 * block (a denial-of-completion, consistent with the system's block-on-suspicion posture) — it can
 * NEVER suppress a real mismatch. Read tolerantly (the readers never throw).
 */
function threadedManifestDigests(paths: ProjectPaths): Set<string> {
  const digests = new Set<string>();
  const add = (d: string | undefined): void => {
    if (typeof d === "string" && d !== "") digests.add(d);
  };
  for (const r of readRealizationReceipts(paths)) add(r.manifest_digest);
  for (const r of readExternalRealizationReceipts(paths)) add(r.manifest_digest);
  for (const r of readDriverReceipts(paths)) add(r.manifest_digest);
  for (const r of readExternalDriverReceipts(paths)) add(r.manifest_digest);
  for (const r of readApprovalReceipts(paths)) add(r.manifest_digest);
  for (const r of readExternalApprovals(paths)) add(r.manifest_digest);
  return digests;
}

/**
 * BSC-10 (C4a) — true iff ANY governing BSC-1 realization / BSC-3 driver / BSC-7 approval receipt
 * (in-process + external stores) is ENROLLED in the evidence-spine (`grounding_bound === true`) yet
 * carries NO usable `manifest_digest` — the OPT-IN says "I participate in the spine" but the receipt
 * never bound itself to the signed EvidenceManifest. This is the C4a `manifest_digest_absent` block
 * condition. The opt-in is the per-receipt TRIGGER (resolving the prior unsatisfiable model): a
 * receipt that does NOT set `grounding_bound` (the back-compat / grandfathered path) is byte-
 * identical and NEVER an offender — so shipped BSC-1/3/4 probes + unenrolled fixtures stay green
 * (absence ≠ forgery). `grounding_bound` is signature/hash-bound on each receipt (it is IN the
 * canonical field order), so a flipped flag breaks that receipt's OWN `recordHash`/signature; here
 * the grounding rung just consumes the declared opt-in. Read tolerantly (the readers never throw).
 *
 * SCOPE (review-fix): this is consumed inside `evaluateGrounding`, which returns null (fully inert)
 * BEFORE this check when NO grounding work-class is declared. So an enrolled-but-unbound receipt is
 * only caught when the run ALSO declares a grounding work-class — C4a enforces CONSISTENCY (you may
 * not claim `grounding_bound` and bind no digest), NOT COVERAGE (nothing forces a receipt to opt in;
 * only the external producer sets `grounding_bound`). An empty OR whitespace-only `manifest_digest`
 * counts as unbound — a junk digest must not satisfy the binding.
 */
function hasUnboundGroundingReceipt(paths: ProjectPaths): boolean {
  const unbound = (r: { grounding_bound?: boolean; manifest_digest?: string }): boolean =>
    r.grounding_bound === true && (typeof r.manifest_digest !== "string" || r.manifest_digest.trim() === "");
  return (
    readRealizationReceipts(paths).some(unbound) ||
    readExternalRealizationReceipts(paths).some(unbound) ||
    readDriverReceipts(paths).some(unbound) ||
    readExternalDriverReceipts(paths).some(unbound) ||
    readApprovalReceipts(paths).some(unbound) ||
    readExternalApprovals(paths).some(unbound)
  );
}

/**
 * Evaluate the BSC-10 external-reference grounding for the current run (recompute-don't-trust +
 * fail-closed). The DECLARED work-class is read FRESH from the in-process grounding receipts (each
 * receipt declares the `workClass` it was minted for); the required ground-kinds are recomputed
 * from the fixed matrix + the `has_ui` UX-surface force-rule (a `has_ui` run forces `visual-hash`).
 * For each required kind the LATEST trusted receipt (in-process `valid` / external `valid-grounded`)
 * is resolved via {@link readGroundingValidated} and its conformance re-derived. A required kind
 * with no trusted receipt ⇒ `missing`; an over-budget/stale one ⇒ `over_budget`; an unobserved one
 * ⇒ `unobserved`; a threaded BSC-1/3/7 `manifest_digest` that disagrees ⇒ `chain_mismatch`
 * (Slice B). A required kind whose `(workClass, groundKind)` axis is covered by a validly-Ed25519-
 * signed exception is EXEMPTED (not an offender; `exceptionCovered:true`) — M4 fail-closed: an
 * unsigned/wrong-key/tampered exception exempts NOTHING. Returns `null` when there is no declared
 * work-class at all (nothing to ground).
 */
function evaluateGrounding(paths: ProjectPaths, state: TwinHarnessState): GroundingVerdict | null {
  const validated = readGroundingValidated(paths);

  // M-1 fail-CLOSED on tamper (BEFORE deriving the declared classes). A tampered chain makes
  // `readGroundingValidated` drop ALL receipts from that store ("a tampered chain trusts NOTHING
  // from it"), which would otherwise empty `byKind`, yield no declared class, and slip a
  // required-and-missing run from FAIL to inert PASS — a fail-OPEN. Detection MUST have a gate
  // consequence: block with the top-level `grounding_unverified` token + `detail.reason:"tampered"`.
  // BOTH chains are covered symmetrically (Slice B closed the external-chain asymmetry): a
  // broken/reordered/duplicated EXTERNAL chain blocks here too, so a file-writer cannot silently
  // drop a stale-resurfaced external grounding down to an undetected `missing`. An EMPTY store
  // verifies (`verifyGroundingChain([])` ⇒ `{ok:true}`), so absence is NEVER blocked here (absence ≠
  // forgery); only a NON-EMPTY broken chain blocks. Under WARN (flag default-OFF) `checkGrounding`
  // downgrades this to a non-blocking notice (flag-gated, like the in-process M-1 posture).
  if (validated.inProcessChainOk === false || validated.externalChainOk === false) {
    return { ok: false, reason: "tampered", required: [], summary: [], offenders: [] };
  }

  // The DECLARED work-classes across the trusted receipts (recompute-don't-trust: the receipt is
  // the work-class CLAIM, the matrix is the verdict). No receipt ⇒ no declared class ⇒ nothing to
  // ground (the not-required inert path — absence ≠ forgery).
  const declaredClasses = [
    ...new Set([...validated.byKind.values()].map((e) => e.receipt.workClass)),
  ].sort();
  if (declaredClasses.length === 0) return null;

  // `has_ui` is the observable UX-surface signal; `has_ui !== false` (default true) forces a
  // visual-hash ground per the force-rule (a screen surface is grounded visually). The union of
  // the required-sets across every declared class is the closed required-set for the run.
  const surfaces = state.has_ui !== false ? ["ui"] : [];
  const requiredSet = new Set<GroundKind>();
  let crossCheckFlag: "class-cross-check-mismatch" | undefined;
  for (const wc of declaredClasses) {
    // GATE-LEVEL DECLARED-vs-DERIVED CROSS-CHECK IS NOT YET WIRED (still inert after Slice B, like
    // the carve-out store). `requiredGroundKindsForWorkClass` is called WITHOUT a third
    // `derivedClass` argument, so `req.crossCheckFlag` is structurally always `undefined` on this
    // path — the declared-vs-derived (BSC-8-style) cross-check has NO input source yet (no receipt
    // carries an evidence-derived class; Slice B added the producer + chain enforcement + sibling-
    // store consumption, NOT a derived-class field — that adoption lands later, with the Slice-C
    // stage-obligation prompts). This loop is therefore a UNION over the DECLARED classes, NOT the
    // declared-vs-derived cross-check; the `crossCheckFlag`/`detail.crossCheck` plumbing below stays
    // reserved-but-unreachable until a derived class is threaded in. The classifier's cross-check
    // rule itself is exercised directly by the unit suite (U6).
    const req = requiredGroundKindsForWorkClass(wc, surfaces);
    for (const k of req.required) requiredSet.add(k);
    if (req.crossCheckFlag) crossCheckFlag = req.crossCheckFlag;
  }
  const required = [...requiredSet].sort();
  if (required.length === 0) return null; // pure-greenfield-only declared ⇒ inert

  // Signed exemptions (Slice B / M4): the validly-Ed25519-signed `(workClass, groundKind)` axes the
  // external producer suspended (the I5 SignedException path). An UNSIGNED / wrong-key / tampered
  // exception exempts NOTHING (fail-closed — verified inside `validGroundingExemptions`); with no
  // public key loaded (default fork/local/test) the map is empty and the gate enforces fully. A
  // required kind is `exceptionCovered` iff ANY declared class has a matching signed exemption.
  const exemptions = validGroundingExemptions(paths);
  const isExempt = (kind: GroundKind): boolean =>
    declaredClasses.some((wc) => exemptions.has(groundingExemptionKey(wc, kind)));

  // C4c — the validly-signed conformance BUDGETS, resolved ONCE per run (3-party authority: an
  // agent cannot self-issue a passing budget). Drives the INDEPENDENT observed-vs-threshold
  // comparison for the runner-sensitive TOLERANCE kind (`visual-hash`): the gate computes
  // `observed > signed_threshold` with its OWN arithmetic rather than trusting the receipt's self-
  // reported `status` (the deferred MED-1). Empty (no key / no budgets) ⇒ a required tolerance kind
  // is `unpinned` (fail-closed under enforce); the deterministic kinds are unaffected.
  const validBudgets = validGroundingBudgets(paths);

  const summary: GroundingSummary[] = [];
  const offenders: GroundKind[] = [];
  let worstReason: GroundingReason | null = null;
  // Fail-closed precedence (highest names the block): `chain_mismatch` (the evidence-spine is bound
  // to a DIFFERENT reference than the one grounded — the most specific spine defect) >
  // `manifest_digest_absent` (C4a: an ENROLLED receipt bound NOTHING — a less-specific spine defect
  // than a disagreement) > `missing` (the ground was never even checked) > `unobserved` (checked but
  // unmeasured) > `over_budget` (measured but out of tolerance). `tampered` is early-handled above.
  const bump = (r: GroundingReason): void => {
    const rank = {
      chain_mismatch: 5,
      manifest_digest_absent: 4,
      missing: 3,
      unobserved: 2,
      over_budget: 1,
      tampered: 0,
    } as const;
    if (worstReason === null || rank[r] > rank[worstReason]) worstReason = r;
  };

  for (const kind of required) {
    const exemptCovered = isExempt(kind);
    const entry = validated.byKind.get(kind);
    if (entry === undefined) {
      // A missing ground is exempted ONLY by a validly-signed exception for its axis (e.g.
      // `reference-unreachable`); otherwise it is the hardest offender.
      summary.push({ groundKind: kind, grounded: false, trustLabel: "ungrounded", conformance: "missing", exceptionCovered: exemptCovered });
      if (!exemptCovered) {
        offenders.push(kind);
        bump("missing");
      }
      continue;
    }
    // The receipt's OWN content verdict (self-reported conformance status + snapshot staleness).
    const selfConformance = groundingConformanceOf(paths, entry.receipt);
    // C4c — the INDEPENDENT gate-side tolerance verdict for a `visual-hash` ground: `observed >
    // signed_threshold` computed by the gate's OWN arithmetic (recompute-don't-trust), so a generous
    // self-reported `status` cannot undercut a breached signed budget. Empty for the deterministic
    // kinds (no tolerance band) and for a visual-hash ground with no tolerance metric. The WORST of
    // (self-reported, independent-threshold) decides the kind — fail-closed, never the laxer of the two.
    const tolerance = toleranceThresholdVerdicts(entry.receipt, validBudgets);
    let conformance = worseGroundingConformance(selfConformance, tolerance);
    // C4c fail-closed (review-fix, sec HIGH): a required `visual-hash` ground MUST carry a measured
    // tolerance metric. An empty / tolerance-free conformance list classifies `valid` in
    // `validateGroundingContent` and yields an EMPTY `tolerance`, so a producer that simply OMITS the
    // perceptual-diff / a11y measurement would otherwise slip through as `within-budget` even under the
    // C4d enforce-flip. Recompute-don't-trust: no `visual`/`a11y` tolerance verdict for a visual-hash
    // ground ⇒ `unobserved` (never a silent pass — "unobserved ≠ clean").
    if (kind === "visual-hash" && tolerance.length === 0) conformance = "unobserved";
    const summaryRow: GroundingSummary = {
      groundKind: kind,
      grounded: true,
      trustLabel: entry.trustLabel,
      conformance,
      exceptionCovered: exemptCovered,
    };
    // C4b — surface the observed-vs-budget diff per tolerance metric so a human sees the breach at
    // approval (only on a `visual-hash` ground carrying tolerance metrics; absent otherwise).
    if (tolerance.length > 0) summaryRow.toleranceDiff = tolerance;
    summary.push(summaryRow);
    // A validly-signed exception suspends this ground's budget ⇒ an over-budget / unobserved kind is
    // no longer an offender (M4: only a SIGNED exception can do this; unsigned exempts NOTHING).
    if (exemptCovered) continue;
    if (conformance === "unobserved") {
      offenders.push(kind);
      bump("unobserved");
    } else if (conformance === "over-budget") {
      offenders.push(kind);
      bump("over_budget");
    }
  }

  // Evidence-spine continuity (Slice B / I3): a `manifest_digest` threaded through a BSC-1/3/7
  // receipt that DISAGREES with the input-grounding manifest digest is a `chain_mismatch` FAIL. Only
  // computable when a `digest-manifest` ground is trusted (the authoritative digest) AND at least
  // one receipt threads a value (absent ⇒ additive-optional back-compat PASS). The offender is the
  // manifest-bearing `digest-manifest` kind, so the per-kind enforce-flip treats it as deterministic.
  const manifestDigest = groundingManifestDigest(validated);
  if (manifestDigest !== null) {
    const threaded = threadedManifestDigests(paths);
    const mismatched = [...threaded].some((d) => d !== manifestDigest);
    if (mismatched) {
      if (!offenders.includes("digest-manifest")) offenders.push("digest-manifest");
      // LOW-1 observability: make the chain_mismatch offender visible in `res.grounding`. The
      // `digest-manifest` ground IS trusted (manifestDigest !== null), so reflect its trust label.
      // chain_mismatch can fire even when `digest-manifest` was NOT in the required-set (the summary
      // loop above only iterates `required`), so UPDATE an existing row if present, else PUSH a new
      // one — never leave the blocking offender absent from the summary.
      const entry = validated.byKind.get("digest-manifest");
      const existing = summary.find((s) => s.groundKind === "digest-manifest");
      if (existing) {
        existing.conformance = "chain_mismatch";
      } else {
        summary.push({
          groundKind: "digest-manifest",
          grounded: true,
          trustLabel: entry?.trustLabel ?? "valid",
          conformance: "chain_mismatch",
          exceptionCovered: false,
        });
      }
      bump("chain_mismatch");
    }
  }

  // Evidence-spine BINDING OPT-IN (Slice C / C4a): a governing BSC-1/3/7 receipt that ENROLLED in
  // the spine (`grounding_bound === true`) but bound NO `manifest_digest` is a `manifest_digest_absent`
  // FAIL. The per-receipt opt-in is the trigger (an unenrolled receipt is byte-identical back-compat
  // PASS), so this NEVER fires on the shipped probes / unenrolled fixtures. The offender is the
  // manifest-bearing `digest-manifest` kind so {@link bsc10KindEnforced} gates it as deterministic.
  // It is computed only after a required-set exists (a `null` no-class run returned earlier), so it
  // does not fabricate a block on a not-required run.
  if (hasUnboundGroundingReceipt(paths)) {
    if (!offenders.includes("digest-manifest")) offenders.push("digest-manifest");
    bump("manifest_digest_absent");
  }

  if (worstReason === null) {
    return crossCheckFlag ? { ok: true, required, summary, crossCheckFlag } : { ok: true, required, summary };
  }
  return crossCheckFlag
    ? { ok: false, reason: worstReason, required, summary, offenders, crossCheckFlag }
    : { ok: false, reason: worstReason, required, summary, offenders };
}

/**
 * Build the gate detail for a failing grounding verdict (the stable `grounding_unverified` block):
 * the worst reason, the offending kinds, and the cross-check-mismatch flag when present.
 */
function groundingDetail(verdict: Extract<GroundingVerdict, { ok: false }>): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    reason: verdict.reason,
    offenders: verdict.offenders,
    required: verdict.required,
  };
  if (verdict.crossCheckFlag) detail.crossCheck = verdict.crossCheckFlag;
  return detail;
}

/**
 * Whether a FAILING grounding verdict actually BLOCKS this run. A failing verdict blocks iff:
 *  - `tampered` — the NON-EMPTY in-process grounding chain does not verify (M-1 fail-closed). This is
 *    FLAG-GATED on the MASTER switch ({@link bsc10EnforcementEnabled}), NOT per-kind: it is a
 *    structural integrity violation with no per-kind attribution, so the deterministic/runner-
 *    sensitive split does not apply. This MATCHES the shipped Slice-A M-1 posture — Slice A
 *    deliberately blocks tamper ONLY under enforce and emits a non-blocking notice under WARN (the
 *    M-1 fix was silent-inert-PASS → visible, not WARN-blocking; under WARN the grounding rung
 *    blocks nothing anyway, so flag-gated tampered is not a hole). An EMPTY store verifies upstream,
 *    so absence stays inert (absence ≠ forgery) and never reaches here; OR
 *  - ANY offending ground-kind is enforce-PROMOTED for the slice ({@link bsc10KindEnforced} — the
 *    deterministic `digest-manifest`/`version-pin` in Slice B; this also gates the new Slice-B
 *    `chain_mismatch` reason, whose offender is `digest-manifest`, per plan I3). A `visual-hash`-ONLY
 *    offender set stays WARN even under the master switch (its enforce-flip is Slice C), so a
 *    deterministic failure BLOCKS while a runner-sensitive one rides as a non-blocking `notice` in
 *    the SAME run.
 */
function groundingVerdictBlocks(verdict: Extract<GroundingVerdict, { ok: false }>): boolean {
  if (verdict.reason === "tampered") return bsc10EnforcementEnabled(); // M-1: flag-gated (Slice-A posture)
  return verdict.offenders.some((kind) => bsc10KindEnforced(kind));
}

/**
 * The BSC-10 external-reference grounding sub-check (Axis-B slice-BSC10a) — the NINTH production-
 * reality sub-check, a THIN summary rung composed among the reality rungs (after assertion-
 * presence). It does NOT recompute: it CONSUMES the verdict already hoisted before the human-
 * approval leg (Principle 1), folding `grounding?` onto the result exactly like `dimensions?`/
 * `assertionPresence?`. It ALWAYS attaches the per-required-kind summary, then BLOCKS on a failing
 * verdict ONLY when the PER-KIND enforce-flip promotes it ({@link groundingVerdictBlocks} — Slice B
 * promotes the DETERMINISTIC `digest-manifest`/`version-pin` kinds while `visual-hash` stays WARN).
 * When the verdict does NOT block (WARN — master switch off, or a `visual-hash`-only offender set in
 * Slice B) it rides as a non-blocking `notice` with the same `grounding_unverified` token + the
 * summary; when it blocks it returns the stable token. A `null` verdict (no declared work-class /
 * empty required-set) ⇒ bare PASS (not-required inert).
 */
function checkGrounding(verdict: GroundingVerdict | null): GateResult {
  if (verdict === null) return PASS; // not-required ⇒ inert (absence ≠ forgery)
  if (verdict.ok) {
    // Attach the summary on PASS only when there is a noteworthy signal (any required kind, or a
    // surfaced cross-check mismatch); otherwise degrade to the bare PASS the gate contract expects.
    if (verdict.summary.length === 0 && verdict.crossCheckFlag === undefined) return PASS;
    return { ok: true, grounding: verdict.summary };
  }
  const detail = groundingDetail(verdict);
  if (!groundingVerdictBlocks(verdict)) {
    // Per-kind WARN (master switch off, OR a runner-sensitive `visual-hash`-only offender set in
    // Slice B): observe but do not block. Surface the would-be block as a non-blocking notice + the
    // summary so the warn posture is visible without weakening the gate.
    return { ok: true, grounding: verdict.summary, notice: { token: "grounding_unverified", detail } };
  }
  return { ok: false, error: "grounding_unverified", detail, grounding: verdict.summary };
}

// ---------------------------------------------------------------------------
// BSC-8 / Axis-B slice-7 — tier-correspondence + stage-invalidation enforcement
// ---------------------------------------------------------------------------

/**
 * The minimum tier the brief mechanically requires, derived PURELY from `classifyBrief`
 * (the lifted `core/tier-classify.ts` sensor both `th tier classify` and the gate share):
 *  - `T0` when the brief is T0-eligible (every T0 condition holds AND no blast-radius veto).
 *  - `T1` otherwise — a single failed T0 condition, OR any blast-radius flag (the §5 veto),
 *    forces ≥T1. The gate never asserts a min ABOVE T1 (T2/T3 are advisory human calls, not
 *    a mechanical floor), so the floor is exactly the T0-eligibility boundary.
 *
 * This is the SAME classifier the producer used at mint, so the recomputed min-tier is
 * identical at mint + gate (the F8 correspondence lesson).
 */
function computeMinTierFromBrief(root: string): { minTier: Tier; briefPresent: boolean } {
  const briefFile = path.resolve(root, TASK_BRIEF_RELPATH);
  const loaded = loadBriefFromFile(briefFile);
  // No brief / invalid brief is NON-DISCRIMINATING: there is no mechanical floor to enforce,
  // so the min-tier is the permissive `T0` (a run with no brief cannot be under-declared).
  if (!loaded.ok || !loaded.brief) return { minTier: "T0", briefPresent: false };
  const { tier0_eligible } = classifyBrief(loaded.brief);
  return { minTier: tier0_eligible ? "T0" : "T1", briefPresent: true };
}

/**
 * The stage-invalidation ground (BSC-8 negative-control b): for the CURRENT claimed tier,
 * every engaged stage with an artifact (`produces !== ""`) that sits at-or-before the
 * current stage in the pipeline MUST have its governing artifact REGISTERED. A tier upgrade
 * that was NOT rewound (`tierUpgradeBackfillStage` is the producer-side rewind; this is the
 * gate-enforcement side) silently SKIPS every newly-engaged stage — so that stage's artifact
 * is absent/unregistered. Returns the FIRST such un-rewound (newly-engaged-but-skipped)
 * stage id, or `null` when every engaged-and-passed artifact stage is satisfied.
 *
 * This is self-contained + recomputable from `state` alone (no receipt history): the
 * signature of an un-rewound upgrade is exactly a passed engaged stage whose artifact was
 * never produced. `final-verification` itself is excluded (its report is owned by
 * `checkFinalVerification`); the implementation/documentation stages carry no artifact.
 */
function unrewoundUpgradeStage(state: TwinHarnessState): string | null {
  const currentOrdinal = STAGE_PIPELINE.findIndex(
    (s) => s.stage === canonicalizeStage(state.current_stage),
  );
  if (currentOrdinal < 0) return null; // pre-pipeline ⇒ nothing passed ⇒ nothing skipped
  const engaged = new Set(engagedStagesFor(state).map((s) => s.stage));
  for (let i = 0; i < currentOrdinal; i++) {
    const contract = STAGE_PIPELINE[i]!;
    if (!engaged.has(contract.stage)) continue; // not engaged by this tier — N/A
    if (contract.produces === "") continue; // no governing artifact (implementation/docs)
    const produced = contract.produces.replace(/\/$/, "");
    const registered = state.approved_artifacts.some((a) => a.file === produced);
    if (!registered) return contract.stage;
  }
  return null;
}

/**
 * The BSC-8 tier-correspondence verdict for the current run. The receipt is the F8
 * correspondence artifact; the LIVE recompute is the verdict (recompute-don't-trust). The
 * order is fail-closed, mirroring the sibling receipt rungs:
 *
 *   1. Tamper walk the chain (`verifyTierCorrespondenceChain`) — a broken chain ⇒
 *      `blocked:"tampered"` (no line from a tampered store can be trusted).
 *   2. Under-declared tier: `claimedTier < computedMinTier` (by `TIERS` ordinal) ⇒
 *      `blocked:"under_declared"`. The claimed tier is `state.tier`; the min-tier is
 *      re-derived FRESH from the brief, NOT trusted from the receipt's stored value.
 *   3. Un-rewound upgrade: a newly-engaged-but-skipped artifact stage ⇒
 *      `blocked:"stage_unrewound"` (the gate-enforcement side of `tierUpgradeBackfillStage`).
 *   4. Stale brief: the run carries a tier-correspondence receipt whose recorded
 *      `brief_digest` no longer matches the recomputed digest ⇒ `blocked:"stale_brief"`
 *      (the brief was edited after attestation). A run with NO receipt is NOT stale-blocked
 *      here (absence is the no-receipt case, grandfathered like the sibling rungs); a null
 *      digest on either side is non-discriminating.
 *   5. Else ⇒ `ok:true`.
 *
 * `state.tier === null` is NOT this rung's concern (the `tier_unclassified` rung owns it);
 * a null tier returns `ok:true` here so the dedicated rung remains the single owner.
 */
type TierCorrespondenceVerdict =
  | { ok: true; claimedTier: string | null; computedMinTier: Tier }
  | {
      ok: false;
      reason: "tampered" | "under_declared" | "stage_unrewound" | "stale_brief";
      claimedTier: string | null;
      computedMinTier: Tier;
      detail: Record<string, unknown>;
    };

function evaluateTierCorrespondence(
  paths: ProjectPaths,
  state: TwinHarnessState,
): TierCorrespondenceVerdict {
  const { minTier } = computeMinTierFromBrief(paths.root);
  const claimedTier = state.tier;

  // 0. Tamper walk the chain before trusting any line from it.
  const receipts = readTierCorrespondenceReceipts(paths);
  if (!verifyTierCorrespondenceChain(receipts).ok) {
    return {
      ok: false,
      reason: "tampered",
      claimedTier,
      computedMinTier: minTier,
      detail: {},
    };
  }

  // tier === null is the tier_unclassified rung's concern, not this one.
  if (claimedTier === null) {
    return { ok: true, claimedTier, computedMinTier: minTier };
  }

  // The LATEST non-legacy receipt is the run's correspondence artifact (the upgrade witness
  // for the stage-invalidation check + the stale-brief artifact). A legacy backfill stamp is
  // grandfathered (no witness).
  const latest: TierCorrespondenceReceipt | undefined =
    receipts.length > 0 ? receipts[receipts.length - 1] : undefined;
  const witness = latest && latest.legacy !== true ? latest : undefined;

  // 1. Under-declared tier: claimed < computed-min (by TIERS ordinal). Negative-control (a):
  //    a `--emergency tier:T0` over a brief whose signals force ≥T1 blocks here.
  const claimedIdx = TIERS.indexOf(claimedTier);
  const minIdx = TIERS.indexOf(minTier);
  if (claimedIdx >= 0 && minIdx >= 0 && claimedIdx < minIdx) {
    return {
      ok: false,
      reason: "under_declared",
      claimedTier,
      computedMinTier: minTier,
      detail: { claimedTier, computedMinTier: minTier },
    };
  }

  // 2. Un-rewound tier upgrade: a newly-engaged-but-skipped artifact stage WITH a receipt-
  //    derived upgrade WITNESS. Negative-control (b): a T0→T2 upgrade that did not rewind
  //    current_stage blocks until rewound. The live recompute (`unrewoundUpgradeStage`) finds a
  //    passed engaged artifact stage that is not registered; the WITNESS distinguishes an
  //    un-rewound bypass from (i) a legitimate upgrade whose rewind backfilled it — the gate must
  //    NOT re-block the legitimate post-upgrade registration window, `checkGoverningArtifact`
  //    owns that as the run re-advances — and (ii) a grandfathered run that minted no receipt at
  //    all (ABSENCE ≠ BYPASS, mirroring the sibling rungs' legacy/absent handling, so an existing
  //    green fixture / pre-BSC-8 run is never reded). Block ONLY when a witness receipt EXISTS and
  //    proves no rewind covered the skip:
  //      - the witness's `claimed_tier` is BELOW the live tier (an upgrade happened AFTER the last
  //        recorded tier without a fresh re-mint — the raw `state set tier --emergency` jump that
  //        skips both the rewind and the mint), OR
  //      - the witness's mint stage sits AT-OR-AFTER the skip (the recorded tier IS the live tier
  //        but its rewind never moved the pointer back to the newly-engaged stage).
  //    A complete absence of receipts (`witness === undefined`) is grandfathered ⇒ no block.
  const skipped = unrewoundUpgradeStage(state);
  if (skipped !== null && witness !== undefined) {
    const skippedOrdinal = STAGE_PIPELINE.findIndex((s) => s.stage === skipped);
    const witnessTierIdx = TIERS.indexOf(witness.claimed_tier as Tier);
    // An upgrade reached the live tier without a fresh receipt for it (witness tier < live tier).
    const upgradeWithoutRemint = witnessTierIdx >= 0 && claimedIdx >= 0 && witnessTierIdx < claimedIdx;
    const mintOrdinal =
      witness.current_stage_at_mint !== undefined
        ? STAGE_PIPELINE.findIndex((s) => s.stage === canonicalizeStage(witness.current_stage_at_mint!))
        : -1;
    // The recorded tier IS the live tier but its rewind never covered the skip.
    const rewindAbsent = witness.claimed_tier === claimedTier && mintOrdinal >= skippedOrdinal;
    if (upgradeWithoutRemint || rewindAbsent) {
      return {
        ok: false,
        reason: "stage_unrewound",
        claimedTier,
        computedMinTier: minTier,
        detail: {
          stage: skipped,
          claimedTier,
          witness: upgradeWithoutRemint ? "upgrade_without_remint" : "rewind_absent",
        },
      };
    }
  }

  // 3. Stale brief: a recorded receipt whose brief_digest diverged from the recompute.
  //    Negative-control (c): the brief changed after attestation. A null digest on either
  //    side is non-discriminating.
  if (witness) {
    const currentDigest = computeBriefDigest(paths.root);
    if (
      witness.brief_digest !== null &&
      currentDigest !== null &&
      witness.brief_digest !== currentDigest
    ) {
      return {
        ok: false,
        reason: "stale_brief",
        claimedTier,
        computedMinTier: minTier,
        detail: { recordedDigest: witness.brief_digest, currentDigest },
      };
    }
  }

  return { ok: true, claimedTier, computedMinTier: minTier };
}

/**
 * The BSC-8 tier-correspondence sub-check (Axis-B slice-7) — a production-reality rung
 * composed among the gating tail (before the BSC-10 grounding summary/fold). It ALWAYS
 * computes the verdict (so the claimed/computed-min correspondence is observable), then
 * BLOCKS on a failing verdict ONLY when enforcement is enabled ({@link bsc8EnforcementEnabled},
 * defaults ON). When enforcement is OFF a failing verdict rides as a non-blocking `notice`
 * (the ship-dark WARN posture), never weakening the gate. Emits the stable token
 * `tier_correspondence_unverified` with the verdict's `reason`
 * (`tampered`/`under_declared`/`stage_unrewound`/`stale_brief`) + detail.
 */
function checkTierCorrespondence(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  const verdict = evaluateTierCorrespondence(paths, state);
  if (verdict.ok) return PASS;
  if (!bsc8EnforcementEnabled()) {
    // Flag OFF (ship-dark): observe but do not block. Surface the would-be block as a
    // non-blocking notice so the warn posture is visible without weakening the gate.
    return {
      ok: true,
      notice: {
        token: "tier_correspondence_unverified",
        detail: { reason: verdict.reason, ...verdict.detail },
      },
    };
  }
  return {
    ok: false,
    error: "tier_correspondence_unverified",
    detail: { reason: verdict.reason, ...verdict.detail },
  };
}

/** `<root>/.omc/audit/probes/bsc9/projection-fixtures.json` — the committed twin-call fixtures. */
function projectionFixturesPath(paths: ProjectPaths): string {
  return path.join(paths.root, ".omc", "audit", "probes", "bsc9", "projection-fixtures.json");
}

/**
 * The BSC-9 sub-check (Axis-B slice-7) — the production-reality rung grounding the MCP
 * `toToolResult` projection AND the interview-readiness claim. Two independent block conditions:
 *
 *  (i) PROJECTION ORACLE — load the committed twin-call fixture set and run the projection
 *      oracle ({@link runProjectionOracle}). Any infidelity (a `toToolResult` projection that
 *      drops/alters `ok`/`exitCode`/`data`) BLOCKS. A missing/malformed fixture set is
 *      NOT-APPLICABLE (a downstream project that ships no MCP tools has nothing to project) →
 *      no oracle block, mirroring the realization rung's "no repo-map ⇒ grandfathered PASS".
 *
 *  (ii) READINESS — when an interview is REQUIRED and ASSERTED ready (`interviewReady`), the
 *      readiness MUST ride a backing {@link InterviewReadinessReceipt} that validates: a
 *      `valid`/`valid-grounded`/`legacy` status passes; `absent` (readiness with no receipt),
 *      `not-ready` (sub-cutoff), `forged`, `tampered`, `store_missing`/`store_mismatch`/`stale`
 *      all BLOCK. Readiness NOT asserted ⇒ nothing to ground (PASS).
 *
 * Governed by {@link bsc9EnforcementEnabled} (defaults ON, WARN-flippable via `TH_BSC9_ENFORCE`):
 * the verdict is ALWAYS computed (so the would-be block surfaces as a non-blocking `notice` when
 * enforcement is off), but it BLOCKS with the stable token only when enforcement is on.
 */
function checkBsc9(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  // (i) Projection oracle over the committed fixture set (not-applicable when absent).
  const fixtures = loadProjectionFixtures(projectionFixturesPath(paths));
  const infidelities: ProjectionInfidelity[] = fixtures ? runProjectionOracle(fixtures) : [];

  // (ii) Readiness grounding — only when an interview is required AND asserted ready.
  let readinessStatus: ReadinessValidationStatus | null = null;
  if (interviewRequired(state) && interviewReady(paths)) {
    readinessStatus = readReadinessReceiptValidated(paths, readinessRefId(paths)).status;
  }
  const readinessAccepted =
    readinessStatus === null ||
    readinessStatus === "valid" ||
    readinessStatus === "valid-grounded" ||
    readinessStatus === "legacy";

  if (infidelities.length === 0 && readinessAccepted) return PASS;

  const detail = {
    ...(infidelities.length > 0 ? { projectionInfidelities: infidelities } : {}),
    ...(readinessStatus !== null && !readinessAccepted ? { readinessStatus } : {}),
  };
  // WARN→ENFORCE: when enforcement is OFF, surface the verdict as a non-blocking notice.
  if (!bsc9EnforcementEnabled()) {
    return { ok: true, notice: { token: "bsc9_unverified", detail } };
  }
  return { ok: false, error: "bsc9_unverified", detail };
}

/**
 * The shared context threaded through every {@link ProductionRealityRung}. It carries
 * the cross-rung state the old monolithic body held in function-local `const`s, so the
 * exact hoist + fold + cross-dependency semantics survive the dispatch refactor:
 *
 *   - `entries` — the simulation ledger, READ ONCE by the sim-unretired rung and REUSED
 *     by the unledgered-dist rung (`computeUnledgeredDistHitsReceiptAware`), exactly as
 *     the old single-read did.
 *   - `scan` — the two-tier `dist/` scan, COMPUTED ONCE by the unledgered-dist rung and
 *     REUSED by the scan-coverage rung (`scan.unobserved`).
 *   - `groundingVerdict` / `groundingBlocksAcceptance` — the HOISTED BSC-10 verdict
 *     (Principle 1: a single live recompute) consumed by BOTH the 1c approval-ACCEPTANCE
 *     leg AND the thin BSC-10 grounding summary rung. The hoist rung computes these once,
 *     before the approval rung, preserving the original control flow.
 *   - `captured` — the driver / realization / assertion / grounding rung RESULTS, so the
 *     post-loop fold reproduces the exact `merged` observability roll-up (driver
 *     `dimensions` rides every later block; the fold picks first-non-empty `notice`).
 */
interface ProductionRealityCtx {
  entries: ReturnType<typeof readSimulationLedger>;
  scan: ReturnType<typeof scanForSimulationHits> | null;
  groundingVerdict: GroundingVerdict | null;
  groundingBlocksAcceptance: boolean;
  captured: {
    driver?: GateResult;
    realization?: GateResult;
    assertion?: GateResult;
    grounding?: GateResult;
    /** BSC-8 — the tier-correspondence rung result, so its WARN-phase `notice` rides the fold. */
    tierCorrespondence?: GateResult;
    bsc9?: GateResult;
  };
}

/**
 * One enumerable production-reality rung. The dispatch loop runs each `check` in order;
 * a non-null return is a TERMINAL early-return (block OR the rung's own pass-with-detail),
 * exactly mirroring the old hand-woven `return` sites. A `null` return means "this rung
 * did not terminate — continue to the next" (used by pure side-effecting rungs like the
 * grounding hoist, and by the gating rungs on their happy path). The shared `ctx` is the
 * SAME object across the whole sweep, so cross-rung state (hoisted verdict, reused scan,
 * captured results) is preserved without any change in evaluation order.
 *
 * Later Axis-B lanes append exactly ONE `ProductionRealityRung` + one registry entry —
 * the seam that makes per-lane rung additions genuinely additive (consensus plan §7).
 */
interface ProductionRealityRung {
  id: string;
  check: (paths: ProjectPaths, state: TwinHarnessState, ctx: ProductionRealityCtx) => GateResult | null;
}

/**
 * The ordered production-reality rung registry — the LITERAL execution list iterated by
 * {@link checkProductionReality}. Order here IS runtime order; every rung is enumerable
 * for observability (consensus plan §8). Each entry's body is the verbatim logic the old
 * monolithic `checkProductionReality` ran inline at the same ordinal; only the call-site
 * weaving moved into this list. The hoist (`bsc10-grounding-hoist`) sits between the
 * terminal-receipt rung and the human-approval rung exactly as before, and the gating
 * rungs (driver/realization/assertion/grounding) record their result into `ctx.captured`
 * so the post-loop fold reproduces the original `merged` roll-up.
 */
export const PRODUCTION_REALITY_RUNGS: readonly ProductionRealityRung[] = [
  {
    // 1. A user-visible simulation still blocks. BSC-4 receipt-aware: an entry blocks
    // when it is active+user-visible+simulated (the original rule) OR when it is marked
    // `retired` but that retirement is NOT grounded by a valid/legacy sim-retire receipt
    // (a retire-by-attestation with no source replacement — no double-exoneration). The
    // SAME `simEntryBlocksProductionReality` predicate backs `th sim`, so reporting agrees.
    id: "simulation-unretired",
    check: (paths, _state, ctx) => {
      const blocking = ctx.entries.filter((e) => simEntryBlocksProductionReality(paths, e));
      if (blocking.length > 0) {
        return {
          ok: false,
          error: "simulation_unretired",
          detail: { ids: blocking.map((e) => e.id), classifications: blocking.map((e) => e.classification) },
        };
      }
      return null;
    },
  },
  {
    // 1b. Terminal-flip grounding (BSC-4). Every drift-resolution and decision-approval
    // in force must carry a VALID (or grandfathered-`legacy`) TerminalTransitionReceipt.
    // A resolve/approve done via a bypass (no receipt) — or whose recorded source target
    // was deleted (`target_missing`) / changed (`target_mismatch`), or whose snapshot is
    // forged/stale (`stale`) — is ungrounded and blocks. `sim-retire` grounding is owned
    // by rung 1 (excluded here to avoid a duplicate token). Pre-upgrade projects carry no
    // migration marker, so an absent receipt classifies `legacy` and this is a NO-OP until
    // the receipt regime is active — it never reds an existing complete run.
    id: "terminal-receipt",
    check: (paths) => {
      for (const ent of collectTerminalEntities(paths)) {
        if (ent.kind === "sim-retire") continue; // owned by rung 1's receipt-aware blocker
        const v = readReceiptValidated(paths, ent.kind, ent.refId);
        // Accept set (slice-1b): `valid` (in-process attested), `valid-grounded` (external
        // keyed receipt that verified), or `legacy` (grandfathered). A `forged` external
        // claim — and the existing absent/target_missing/target_mismatch/stale — BLOCK.
        if (v.status !== "valid" && v.status !== "valid-grounded" && v.status !== "legacy") {
          return {
            ok: false,
            error: "terminal_receipt_unverified",
            detail: {
              kind: ent.kind,
              refId: ent.refId,
              status: v.status,
              ...(v.staleReasons ? { staleReasons: v.staleReasons } : {}),
            },
          };
        }
      }
      return null;
    },
  },
  {
    // 1b-grounding. HOIST the BSC-10 external-reference grounding verdict (Axis-B slice-BSC10a,
    // C1/PCC-1). It is computed ONCE here — BEFORE the human-approval leg — because it depends ONLY
    // on the grounding receipts + sibling stores + the matrix (NO dependency on verify/tester/dist/
    // scan/driver/realization/assertion), so it can be resolved first with no ordering hazard. The
    // SAME verdict is consumed by (i) the SPLIT approval-ACCEPTANCE leg just below and (ii) the thin
    // grounding summary rung among the reality rungs — a single live recompute, never attached-but-
    // stale (Principle 1). A late standalone rung after the reality rungs could never inform the 1c
    // approval leg, which early-`return`s on the happy path — so hoist-evaluate-once is the only
    // sound control flow. This rung does not terminate (returns null): it only populates `ctx`.
    id: "bsc10-grounding-hoist",
    check: (paths, state, ctx) => {
      ctx.groundingVerdict = evaluateGrounding(paths, state);
      // A PRESENT-but-UNCONFORMANT ground (grounded, but `over_budget`/`unobserved` — NOT a `missing`
      // ground, NOT a cross-receipt `chain_mismatch`) is the conformance precondition the BSC-7 approval
      // ACCEPTANCE leg consumes: an approval cannot be ACCEPTED while the reference it was supposed to be
      // approved against is itself unconformant. `missing`/`chain_mismatch`/`tampered` are excluded here
      // (each is the grounding rung's OWN block, not an approval-acceptance failure) so the tokens stay
      // disjoint. Gated on the PER-KIND enforce-flip ({@link groundingVerdictBlocks}): a deterministic
      // `digest-manifest`/`version-pin` unconformance blocks acceptance in Slice B, while a runner-
      // sensitive `visual-hash`-only unconformance stays WARN (does not block) until Slice C.
      ctx.groundingBlocksAcceptance =
        ctx.groundingVerdict !== null &&
        ctx.groundingVerdict.ok === false &&
        (ctx.groundingVerdict.reason === "over_budget" || ctx.groundingVerdict.reason === "unobserved") &&
        groundingVerdictBlocks(ctx.groundingVerdict);
      return null;
    },
  },
  {
    // 1c. Human-approval grounding over the CLOSED required-set (BSC-7 / Axis-B slice-3a,
    // R1) — the COMPLETION rung, the L1 backstop. `humanGate` was a declarative-only flag
    // with ZERO predicate consumers (pure gate theater); this re-validates that EVERY
    // engaged-and-not-future humanGate stage carries an approval bound to the current
    // snapshot + governing-artifact digest. The required-set is recomputed FRESH from
    // `requiredHumanGateStages` (humanGate ∩ engagedStagesFor ∩ ordinal-≤-current) — we do
    // NOT trust a persisted "approved" summary (the BSC-6 recompute-don't-trust lesson:
    // presence is the sensed fact). Modeled EXACTLY on the BSC-4 terminal-flip rung above:
    // for each required stage, `readApprovalValidated` → accept `valid`/`valid-grounded`/
    // `legacy`, BLOCK on `absent`/`stale`/`target_missing`/`target_mismatch`/`forged`/
    // `tampered` with the stable token `human_approval_unverified`. Because `engagedStagesFor`
    // is UI-aware, a `has_ui===false` run does NOT require `ux-design`/`ui-design` (N/A, not
    // `absent`-blocked); a lower-tier run does not require `security`/`contracts` when not
    // engaged. This is the backstop the `--emergency`/`state set` jump cannot route around:
    // jumping `current_stage` to `final-verification` makes every engaged gate ordinal-≤-
    // current ⇒ required, so the jumped-over stage is re-checked here. The block names the
    // offending `{stage, status}` (a bounded list — the FIRST failing required stage).
    //
    // PCC-1 SPLIT (slice-BSC10a): leg (α) approval-EXISTENCE is the unchanged status check below;
    // leg (β) approval-ACCEPTANCE additionally refuses to ACCEPT an otherwise-present approval while
    // `groundingBlocksAcceptance` (a present-but-unconformant BSC-10 ground under enforce). So an
    // approval that EXISTS but whose reference is unconformant blocks with `grounding_unverified`,
    // the conformance precondition consumed INSIDE the 1c leg — never bypassed.
    id: "human-approval",
    check: (paths, state, ctx) => {
      for (const stage of requiredHumanGateStages(state)) {
        const a = readApprovalValidated(paths, stage);
        // Leg (α) — approval EXISTENCE: an absent/stale/forged/tampered approval blocks as before.
        if (a.status !== "valid" && a.status !== "valid-grounded" && a.status !== "legacy") {
          return {
            ok: false,
            error: "human_approval_unverified",
            detail: {
              stage,
              status: a.status,
              ...(a.staleReasons ? { staleReasons: a.staleReasons } : {}),
            },
          };
        }
        // Leg (β) — approval ACCEPTANCE: the approval EXISTS, but a present-but-unconformant BSC-10
        // ground means the reference it authorizes is itself unconformant ⇒ the approval cannot be
        // ACCEPTED (the conformance precondition is consumed here, not bypassed). Slice-BSC10a only:
        // gated on the enforce flag (default OFF ⇒ this leg is inert in the WARN commit).
        if (ctx.groundingBlocksAcceptance) {
          const v = ctx.groundingVerdict as Extract<GroundingVerdict, { ok: false }>;
          return {
            ok: false,
            error: "grounding_unverified",
            detail: { stage, ...groundingDetail(v) },
            grounding: v.summary,
          };
        }
      }
      return null;
    },
  },
  {
    // 2. The verify suite must be green against production-targeted commands, AND the
    // report must be a CURRENT-binding report (F2/R-30 — not a legacy bare report, not a
    // stale/copied one). The validated reader classifies the report; only a `valid` GREEN
    // report passes. A corrupt config still blocks (fail-closed). One stable token
    // (`production_verify_not_green`) with a `reason` detail naming the divergence.
    id: "production-verify",
    check: (paths) => {
      const verifyLoaded = loadVerifyConfig(paths);
      if (verifyLoaded.status === "corrupt") {
        return { ok: false, error: "production_verify_not_green", detail: { reason: "config_corrupt" } };
      }
      const verifyCfg = verifyLoaded.config;
      if (verifyCfg.commands.length > 0) {
        const validated = readVerifyReportValidated(paths);
        if (validated.status === "absent") {
          return { ok: false, error: "production_verify_not_green", detail: { reason: "never_run", commands: verifyCfg.commands.length } };
        }
        if (validated.status !== "valid") {
          // legacy / stale / corrupt report → the green claim cannot be trusted for the
          // current snapshot. Re-run `th verify run` to seal a fresh bound envelope.
          return { ok: false, error: "production_verify_not_green", detail: { reason: validated.status, ...(validated.staleReasons ? { staleReasons: validated.staleReasons } : {}) } };
        }
        if (!validated.report!.ok) {
          const failed = validated.report!.results.filter((x) => !x.ok).length;
          return { ok: false, error: "production_verify_not_green", detail: { reason: "failing", failed } };
        }
      }
      return null;
    },
  },
  {
    // 3. A live-QA Tester run record must be attached (audit C-08).
    id: "tester-record",
    check: (paths) => {
      if (!testerRecordPresent(paths)) {
        return { ok: false, error: "tester_record_missing", detail: {} };
      }
      return null;
    },
  },
  {
    // 4. dist/ must not carry unledgered simulation patterns. A dist hit is "ledgered"
    // only when an ACTIVE simulation entry DECLARES that specific hit — matched
    // PER-DEPENDENCY (audit P1), so a single unrelated, non-user-visible entry no longer
    // blanket-suppresses every dist hit. The SAME `computeUnledgeredDistHits` join backs
    // `th sim scan`, so scan and gate agree. The two-tier scan never throws. The scan is
    // COMPUTED ONCE here and STASHED on `ctx` for the scan-coverage rung to reuse.
    id: "unledgered-dist",
    check: (paths, _state, ctx) => {
      ctx.scan = scanForSimulationHits(paths);
      const unledgered = computeUnledgeredDistHitsReceiptAware(paths, ctx.entries, ctx.scan.distHits);
      if (unledgered.length > 0) {
        return {
          ok: false,
          error: "unledgered_simulation_in_dist",
          detail: { hits: unledgered.slice(0, 20), total: unledgered.length },
        };
      }
      return null;
    },
  },
  {
    // 5. (BSC-6 / Axis-B slice-2) SCAN-COVERAGE COMPLETENESS — fail closed on the scan's
    // OWN incompleteness, INDEPENDENT of and ADDITIONAL to the unledgered-token check
    // above. The two-tier scan enumerated + streaming-hashed every `dist/` path; any path
    // it could not deep-inspect (per-file / aggregate / watchdog / read error) is
    // `unobserved` (≠ clean). This rung RECOMPUTES that set fresh every run (it MUST NOT
    // read `scan-completeness.jsonl` to decide — trusting a persisted "complete" summary is
    // the exact bug class BSC-6 is) and BLOCKS with the stable token `scan_coverage_incomplete`
    // when any `unobserved` path is not exonerated by a valid external-signed exception ack.
    // The SAME `uncoveredAfterExceptions` residual backs `th sim scan`, so scan and gate
    // agree (control e). This closes the proven RED of `.omc/audit/probes/new-a-scancap/`:
    // a >2 MB token-bearing file is now either deep-inspected (→ unledgered block) or
    // `unobserved{file_limit}` (→ this block), never silently skipped. Consumes the same
    // `scan` the unledgered-dist rung stashed on `ctx` (single scan per run, as before).
    id: "scan-coverage",
    check: (paths, _state, ctx) => {
      const uncovered = uncoveredAfterExceptions(paths, ctx.scan!.unobserved);
      if (uncovered.length > 0) {
        return {
          ok: false,
          error: "scan_coverage_incomplete",
          detail: {
            unobserved: uncovered.slice(0, 20).map((u) => ({ path: u.path, reason: u.reason })),
            total: uncovered.length,
            reasons: [...new Set(uncovered.map((u) => u.reason))].sort(),
          },
        };
      }
      return null;
    },
  },
  {
    // 6. (BSC-3 / Axis-B slice-4a) VERIFICATION-DRIVER DIMENSION GROUNDING — composed LAST.
    // A run may not be certified complete on a verify-report that merely says "ok" with NO
    // record of WHICH verification dimensions a trusted runner actually EXERCISED. The
    // verification-driver receipt is the SENSOR; this re-derives its ground from
    // `verify-report.json` and enforces by SIGNATURE-derived trust label (valid / valid-
    // grounded / forged). ABSENCE ≠ FORGERY: a run with no driver receipt is grandfathered
    // (in-process attested, allowed). Governed by `bsc3EnforcementEnabled()` (defaults ON):
    // the verdict is ALWAYS computed (so `dimensions` summarizes the trust posture for the
    // I1 observability hook), but it BLOCKS with `driver_dimension_unverified` only when
    // enforcement is on. The `dimensions` summary rides on the result whether PASS or BLOCK.
    // The result is CAPTURED on `ctx` so later rungs' blocks and the final fold can carry
    // the driver `dimensions` summary forward (the cross-rung observability dependency).
    id: "driver-dimensions",
    check: (paths, _state, ctx) => {
      const driver = checkDriverDimensions(paths);
      ctx.captured.driver = driver;
      if (!driver.ok) return driver;
      return null;
    },
  },
  {
    // 7. (BSC-1 / Axis-B slice-5) REALIZATION-RECEIPT GROUNDING — composed LAST. A run may not
    // be certified complete while a REQ-ID owned by a `done` slice lacks a valid, reachable,
    // digest-fresh realization referent. The CLAIM (`SliceState.status==="done"`) is authored
    // independently of the REFERENT (recorded by `th realize`); this enumerates done-slice
    // REQ-IDs from the cached repo-map, recomputes each referent digest, COLLECTS ALL failures,
    // and blocks on absent/stale/forged/target_*/tampered/unresolved. ABSENCE is grandfathered
    // (`legacy`) until the migration marker is stamped, so this is a NO-OP on pre-upgrade
    // projects. Governed by `realizationEnforcementEnabled()` (defaults ON).
    id: "realization",
    check: (paths, state, ctx) => {
      const realization = checkRealization(paths, state);
      ctx.captured.realization = realization;
      if (!realization.ok) {
        // Preserve the driver `dimensions` summary on the realization block so the trust posture
        // stays visible alongside the realization failure.
        const driver = ctx.captured.driver;
        return driver?.dimensions ? { ...realization, dimensions: driver.dimensions } : realization;
      }
      return null;
    },
  },
  {
    // 8. (BSC-2 / Axis-B slice-6) ASSERTION-PRESENCE GROUNDING — composed LAST (after realization).
    // A run may not be certified complete while a `tested` REQ-ID lacks a NON-TRIVIAL assertion:
    // the coverage gate counts a REQ "tested" on anchor presence alone, so a test file with no
    // cannot-fail-free assertion clears that bar (BSC-2). This recomputes the per-REQ
    // assertion-presence ground FRESH, requires an F8-bound in-process AssertionPresenceReceipt
    // for correspondence, subtracts validly-WAIVED REQs, and BLOCKS on a forged MutationKillReceipt.
    // A signature-verified external MutationKillReceipt is recorded as a DISTINCT module-scoped
    // `mutationEfficacy` observability signal — it does NOT override the presence rung (presence ≠
    // efficacy; review HIGH). Governed by `bsc2EnforcementEnabled()` (WARN-first): the verdict is
    // ALWAYS computed (so `assertionPresence` summarizes the per-REQ posture for the I1 hook), but
    // it BLOCKS with `assertion_presence_unverified` / `assertion_unobserved` / `mutation_kill_forged`
    // only when enforcement is on. The summary rides on the result whether PASS or BLOCK.
    id: "assertion-presence",
    check: (paths, _state, ctx) => {
      const assertion = checkAssertionPresence(paths);
      ctx.captured.assertion = assertion;
      if (!assertion.ok) {
        // Preserve the upstream driver `dimensions` summary on the assertion block so the full trust
        // posture stays visible alongside the assertion failure (assertion already carries its own
        // `assertionPresence` + `mutationEfficacy`).
        const driver = ctx.captured.driver;
        return driver?.dimensions ? { ...assertion, dimensions: driver.dimensions } : assertion;
      }
      return null;
    },
  },
  {
    // 8b. (BSC-8 / Axis-B slice-7) TIER-CORRESPONDENCE + STAGE-INVALIDATION — composed among the
    // gating tail, before the BSC-10 grounding summary/fold (merge-order discipline). A run may not
    // be certified complete while its declared `tier` does not correspond to the work: the claimed
    // tier is UNDER-DECLARED vs the brief's mechanically-computed min-tier (`classifyBrief`), a tier
    // upgrade left a newly-engaged stage un-rewound (skipped artifact), or the brief was edited after
    // attestation (stale digest). `tier` stays GATE_OWNED (raw `state set tier` reject preserved in
    // commands/state.ts); the rewind logic (`tierUpgradeBackfillStage`) already FIRES on the producer
    // side — this is the GATE-ENFORCEMENT side only. Governed by `bsc8EnforcementEnabled()` (defaults
    // ON): the verdict is ALWAYS computed, but it BLOCKS with `tier_correspondence_unverified` only
    // when enforcement is on; OFF ⇒ a non-blocking `notice` (ship-dark WARN). The result is captured
    // on `ctx.captured.tierCorrespondence` so the WARN-phase `notice` rides the post-loop fold (the
    // last in the notice-precedence chain), mirroring the sibling gating rungs.
    id: "tier-correspondence",
    check: (paths, state, ctx) => {
      const tierCorr = checkTierCorrespondence(paths, state);
      ctx.captured.tierCorrespondence = tierCorr;
      if (!tierCorr.ok) return tierCorr;
      return null;
    },
  },
  {
    // 9. (BSC-10 / Axis-B slice-BSC10a) EXTERNAL-REFERENCE GROUNDING — a THIN summary rung composed
    // among the reality rungs. It does NOT recompute: it CONSUMES the `groundingVerdict` already
    // HOISTED before the 1c approval leg (Principle 1 — single live recompute), folding `grounding?`
    // onto the result exactly like `dimensions?`/`assertionPresence?`. The `missing` reason blocks
    // HERE (a required input-ground never checked); the present-but-unconformant (`over_budget`/
    // `unobserved`) reasons already gated the approval-ACCEPTANCE leg above. Governed by
    // `bsc10EnforcementEnabled()` (slice-BSC10a is the WARN commit, default OFF): the verdict is
    // ALWAYS computed (so `grounding` summarizes the posture for the I1 hook), but it BLOCKS with
    // `grounding_unverified` only when enforcement is on; OFF ⇒ a non-blocking `notice` + summary.
    id: "bsc10-grounding-summary",
    check: (_paths, _state, ctx) => {
      const grounding = checkGrounding(ctx.groundingVerdict);
      ctx.captured.grounding = grounding;
      if (!grounding.ok) {
        // Preserve the upstream driver `dimensions` summary on the grounding block so the full trust
        // posture stays visible (grounding already carries its own `grounding` summary).
        const driver = ctx.captured.driver;
        return driver?.dimensions ? { ...grounding, dimensions: driver.dimensions } : grounding;
      }
      return null;
    },
  },
  {
    // 10. (BSC-9 / Axis-B slice-7) MCP `toToolResult` PROJECTION ORACLE + INTERVIEW-READINESS.
    // The ONLY authentic CLI↔MCP divergence surface is the PROJECTION (every tool closure
    // delegates to the same `run*` handler the CLI does, guarded by REQ-PCO-070), so this rung
    // (a) runs the projection oracle over the committed twin-call fixture set — a projection that
    // drops/alters ok/exitCode/data BLOCKS — and (b) grounds the soft interview gate's
    // `interviewReady` claim: an asserted readiness must ride a backing InterviewReadinessReceipt
    // (a no-receipt / sub-cutoff / forged / tampered / stale readiness BLOCKS). Governed by
    // `bsc9EnforcementEnabled()` (defaults ON): the verdict is ALWAYS computed (a WARN `notice`
    // when enforcement is off), but it BLOCKS with `bsc9_unverified` only when enforcement is on.
    // Self-contained: it does not read or write `ctx` (no cross-rung dependency).
    id: "bsc9-projection-readiness",
    check: (paths, state, ctx) => {
      const bsc9 = checkBsc9(paths, state);
      ctx.captured.bsc9 = bsc9;
      // A hard block (enforcement on) early-returns; the WARN `notice` (enforcement off) is
      // folded onto the final PASS via `ctx.captured.bsc9`, mirroring the other gating rungs.
      return bsc9.ok ? null : bsc9;
    },
  },
];

export function checkProductionReality(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  // Stage-aware: production reality is a CERTIFY-COMPLETION condition, so it only
  // enforces at the completion boundary (final-verification). Earlier stages have no
  // built dist/ / Tester record yet — gating them would be nonsensical and would red
  // every in-flight run's obligation ladder. Mirrors checkInterview's front-gate shape.
  if (!isFinalVerification(state.current_stage)) return PASS;

  // Read the simulation ledger ONCE up front (it backs both the sim-unretired rung and
  // the unledgered-dist rung). A corrupt ledger is the fail-closed front block — it must
  // precede every rung, exactly as the old inline body's first read did.
  let entries;
  try {
    entries = readSimulationLedger(paths);
  } catch (e) {
    if (e instanceof SimulationLedgerCorruptError) {
      return { ok: false, error: "simulation_ledger_corrupt", detail: {} };
    }
    throw e;
  }

  // The shared context threaded through the rung sweep — the same object the old
  // function-local `const`s lived in. `RUNGS` iterate in order; the FIRST non-null return
  // is the terminal result (an early-return block, identical to the old hand-woven returns).
  const ctx: ProductionRealityCtx = {
    entries,
    scan: null,
    groundingVerdict: null,
    groundingBlocksAcceptance: false,
    captured: {},
  };
  for (const rung of PRODUCTION_REALITY_RUNGS) {
    const r = rung.check(paths, state, ctx);
    if (r !== null) return r;
  }

  // All rungs passed: fold the optional observability fields up onto ONE result so a single
  // PASS carries the driver `dimensions`, the assertion `assertionPresence`, the module-scoped
  // `mutationEfficacy`, the BSC-10 `grounding`, and at most one warn-phase `notice` (driver wins,
  // then realization, then assertion, then grounding — first non-empty). Reads the rung results
  // captured on `ctx` during the sweep, reproducing the original `merged` roll-up verbatim.
  const driver = ctx.captured.driver;
  const realization = ctx.captured.realization;
  const assertion = ctx.captured.assertion;
  const grounding = ctx.captured.grounding;
  const tierCorrespondence = ctx.captured.tierCorrespondence;
  const merged: GateResult = { ok: true };
  const dimensions = driver?.dimensions ?? assertion?.dimensions;
  if (dimensions) merged.dimensions = dimensions;
  if (assertion?.assertionPresence) merged.assertionPresence = assertion.assertionPresence;
  if (assertion?.mutationEfficacy) merged.mutationEfficacy = assertion.mutationEfficacy;
  if (grounding?.grounding) merged.grounding = grounding.grounding;
  // BSC-9 (slice-7): the bsc9 rung's WARN `notice` (enforcement off) folds in LAST in the
  // precedence chain, so a would-be projection/readiness block stays visible without blocking.
  const bsc9 = ctx.captured.bsc9;
  const notice =
    driver?.notice ??
    realization?.notice ??
    assertion?.notice ??
    grounding?.notice ??
    tierCorrespondence?.notice ??
    bsc9?.notice;
  if (notice) merged.notice = notice;
  // Degrade to the shared bare PASS when nothing was observed, preserving `{ ok: true }`.
  return merged.dimensions ||
    merged.assertionPresence ||
    merged.mutationEfficacy ||
    merged.grounding ||
    merged.notice
    ? merged
    : PASS;
}

// ---------------------------------------------------------------------------
// Composed gate predicates — consumed by both `th next` and the typed MCP tools.
// ---------------------------------------------------------------------------

/** Pipeline ordinal of a (canonicalized) stage, or -1 for a pre-pipeline stage. */
function stageOrdinal(stage: string): number {
  const canonical = canonicalizeStage(stage);
  return STAGE_PIPELINE.findIndex((s) => s.stage === canonical);
}

/**
 * The CLOSED human-approval required-set for `state` (BSC-7 / Axis-B slice-3a, R1) —
 * every `humanGate` stage that is engaged-and-not-future: `S.humanGate === true &&
 * S ∈ engagedStagesFor(state) && stageOrdinal(S) ≤ stageOrdinal(state.current_stage)`.
 *
 * This is the ONE traversal both the completion rung (the L1 backstop) and the
 * advance rung reason over (resolves open-decision §11.2 by extraction). It COMPOSES
 * the two existing primitives — `engagedStagesFor` (UI-aware: drops `ux-design`/
 * `ui-design` when `has_ui === false`, so those are N/A not `absent`-blocked) and
 * `stageOrdinal` — and invents no new pipeline walk.
 *
 * "engaged-and-not-future" is the only COMPUTABLE required-set: `TwinHarnessState`
 * carries no stage-crossing ledger, so "crossed-only" is unimplementable. The
 * ordinal-≤-current half makes a not-yet-reached gate (e.g. `final-verification` while
 * mid-pipeline) un-required, while every gate at or behind the current stage IS
 * required — which is exactly why the `--emergency`/`state set` jump to
 * `final-verification` cannot route around the completion check (all engaged gates then
 * have ordinal ≤ current ⇒ all are required).
 */
export function requiredHumanGateStages(
  state: Pick<TwinHarnessState, "tier" | "has_ui" | "current_stage">,
): string[] {
  const currentOrdinal = stageOrdinal(state.current_stage);
  return engagedStagesFor(state)
    .filter((s) => s.humanGate && stageOrdinal(s.stage) <= currentOrdinal)
    .map((s) => s.stage);
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

// ---------------------------------------------------------------------------
// Rung registry (R-29, Item 3) — the SINGLE machine-enumerable list of every rung
// `canAdvanceStage` runs, each classified into exactly ONE completion bucket. Both
// `canAdvanceStage` (the forward-progress ladder) and `canCompleteRun` (the
// completion re-selection) ITERATE this registry — it is the ACTUAL execution list,
// not a hand-mirrored copy. A future rung added to `canAdvanceStage` MUST be added
// here too (there is no other place that runs it), and the partition-exhaustiveness
// test (`gate-precondition-partition.test.ts`) asserts every registry entry carries
// a known bucket — so an unclassified rung fails LOUDLY rather than silently
// defaulting into (or out of) the completion gate.
// ---------------------------------------------------------------------------

/**
 * The completion-relevance bucket of a `canAdvanceStage` rung (Item 3):
 *   - `always-run`   — a HUMAN-reconciliation obligation that blocks completion at
 *                      ANY stage (drift, revise-escalation, decisions, debate).
 *   - `forward-only` — a forward-PROGRESS rung that gates advancing to the NEXT
 *                      stage but is NOT a completion condition at a non-final stage
 *                      (verify-suite, artifact-drift, tier, interview, repo-map,
 *                      governing-artifact, stage-coverage, impl-settled). Completion
 *                      at a non-final stage PASSes these (a mid-build turn-end is not
 *                      a "claim done").
 *   - `final`        — the final-verification completion ladder
 *                      (`checkFinalVerification`), the STRICT trio + report gate that
 *                      is the verify AUTHORITY at the completion boundary.
 */
export type CompletionBucket = "always-run" | "forward-only" | "final";

/** A scope tag describing WHERE in `canAdvanceStage` a rung runs (for the loop + the test). */
export type RungScope =
  | "global" // one of the 9 stage-independent rungs, run in order for every stage
  | "stage:non-final-artifact" // checkGoverningArtifact — non-final stage branch
  | "stage:implementation-planning" // checkCoverage — only at implementation-planning
  | "stage:implementation" // checkImplementationSettled — only at implementation
  | "stage:human-approval-advance" // checkHumanApprovalAdvance — only when advancing OUT of a humanGate stage
  | "stage:final"; // checkFinalVerification — the final-verification branch

/** One enumerable rung: its stable id, its completion bucket, its scope, and its predicate. */
export interface RungSpec {
  id: string;
  bucket: CompletionBucket;
  scope: RungScope;
  run: (paths: ProjectPaths, state: TwinHarnessState) => GateResult;
}

/**
 * The 9 GLOBAL rungs in `canAdvanceStage`'s exact short-circuit order. The loop in
 * `canAdvanceStage` iterates THIS array, so the order here IS the runtime order
 * (next.ts's ladder is pinned to it by next-characterization). Each is classified:
 * the four HUMAN-reconciliation obligations are `always-run`; the rest are
 * `forward-only`.
 */
const GLOBAL_RUNGS: readonly RungSpec[] = [
  { id: "checkBlockingDrift", bucket: "always-run", scope: "global", run: (_p, s) => checkBlockingDrift(s) },
  { id: "checkReviseEscalation", bucket: "always-run", scope: "global", run: (_p, s) => checkReviseEscalation(s) },
  { id: "checkVerifySuite", bucket: "forward-only", scope: "global", run: (p) => checkVerifySuite(p) },
  { id: "checkArtifactDrift", bucket: "forward-only", scope: "global", run: (p, s) => checkArtifactDrift(p, s) },
  { id: "checkTierSet", bucket: "forward-only", scope: "global", run: (_p, s) => checkTierSet(s) },
  { id: "checkInterview", bucket: "forward-only", scope: "global", run: (p, s) => checkInterview(p, s) },
  { id: "checkRepoMap", bucket: "forward-only", scope: "global", run: (p, s) => checkRepoMap(p, s) },
  { id: "checkDecisionObligations", bucket: "always-run", scope: "global", run: (p, s) => checkDecisionObligations(p, s) },
  { id: "checkDebate", bucket: "always-run", scope: "global", run: (_p, s) => checkDebate(s) },
];

/**
 * The STAGE-specific rungs (the branch after the globals). Each is gated by the
 * current stage at runtime; here they are enumerated + classified so the
 * exhaustiveness test sees the COMPLETE rung set. `checkFinalVerification` is the
 * sole `final` rung (the verify AUTHORITY at completion — Item 5); the rest are
 * `forward-only` (they gate advancing OUT of a non-final stage, not completion).
 */
const STAGE_RUNGS: readonly RungSpec[] = [
  { id: "checkGoverningArtifact", bucket: "forward-only", scope: "stage:non-final-artifact", run: (p, s) => checkGoverningArtifact(p, s) },
  { id: "checkCoverage", bucket: "forward-only", scope: "stage:implementation-planning", run: (p) => checkCoverage(p) },
  { id: "checkImplementationSettled", bucket: "forward-only", scope: "stage:implementation", run: (_p, s) => checkImplementationSettled(s) },
  // BSC-7 / Axis-B slice-3a — the human-approval advance rung. `forward-only`: it gates
  // advancing OUT of a humanGate stage (a per-stage forward-progress block), NOT
  // completion. Completion enforcement over the CLOSED required-set is the separate C-2
  // rung composed inside checkFinalVerification (`final`), so this entry must NOT be
  // `final` or it would double-gate at the completion boundary.
  { id: "checkHumanApprovalAdvance", bucket: "forward-only", scope: "stage:human-approval-advance", run: (p, s) => checkHumanApprovalAdvance(p, s) },
  { id: "checkFinalVerification", bucket: "final", scope: "stage:final", run: (p, s) => checkFinalVerification(p, s) },
];

/**
 * The COMPLETE, machine-enumerable rung registry — every rung `canAdvanceStage`
 * runs, in (global-then-stage) order. This is the LITERAL execution list: BOTH
 * `canAdvanceStage` and `canCompleteRun` iterate it and invoke each entry's `run`
 * closure (a rung cannot be run from anywhere else), and `th next`'s ladder is pinned
 * to this order by next-characterization. The partition-exhaustiveness test
 * introspects it (every entry has a valid bucket) and, by wrapping the `run` closures,
 * proves every rung `canAdvanceStage` invokes is a registry entry — so a future rung
 * added without a bucket fails LOUDLY.
 */
export const CAN_ADVANCE_RUNGS: readonly RungSpec[] = [...GLOBAL_RUNGS, ...STAGE_RUNGS];

/**
 * Does a registry rung APPLY at `stage`? Globals always apply; the stage rungs apply
 * only at their stage. This is the single stage-gating predicate `canAdvanceStage`
 * uses to drive the registry, so the stage-branch logic lives in ONE place the
 * exhaustiveness test can see.
 */
function rungAppliesAtStage(rung: RungSpec, stage: string): boolean {
  switch (rung.scope) {
    case "global":
      return true;
    case "stage:non-final-artifact":
      return !isFinalVerification(stage);
    case "stage:implementation-planning":
      return stage === "implementation-planning";
    case "stage:implementation":
      return stage === "implementation";
    case "stage:human-approval-advance":
      // Applies when advancing OUT of a humanGate stage — i.e. the CURRENT stage is one
      // of the 8 humanGate stages (the per-stage approval obligation is owed by the stage
      // being crossed). Mirrors checkHumanApprovalAdvance's own guard.
      return isHumanGateStage(canonicalizeStage(stage));
    case "stage:final":
      return isFinalVerification(stage);
  }
}

/**
 * The FULL mechanical ladder that must clear before the run advances OUT of the
 * current stage — the EXHAUSTIVE list (AC-B13 reuses it verbatim): global rungs
 * a–h, then the stage-specific rung for the current stage (governing artifact,
 * coverage at implementation-planning, slices settled at implementation, or the
 * final-verification ladder). Evaluated lazily so the short-circuit order — and the
 * cost (the brownfield repo scan only runs when reached) — matches `runNext()`.
 *
 * R-29: this ITERATES `CAN_ADVANCE_RUNGS` and runs each entry whose scope applies to
 * the current stage, in registry order — the registry is the execution list, not a
 * hand-mirror. A rung can never be in the registry but skipped here, nor run here but
 * missing from the registry. (The final-verification branch is a single `final` rung
 * — `checkFinalVerification` — which composes the production-reality rung LAST,
 * matching `th next`'s render order.)
 */
export function canAdvanceStage(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  const current = canonicalizeStage(state.current_stage);
  for (const rung of CAN_ADVANCE_RUNGS) {
    if (!rungAppliesAtStage(rung, current)) continue;
    const r = rung.run(paths, state);
    if (!r.ok) return r;
  }
  return PASS;
}

/**
 * May the run be certified COMPLETE (turn-end / "claim done") RIGHT NOW? (R-29.)
 *
 * This is a RE-SELECTION of `canAdvanceStage`'s rungs, NOT a verbatim alias.
 * `canAdvanceStage` answers "may the run advance to the NEXT stage?" — a
 * forward-progress question. Completion is a DIFFERENT question: a mid-build turn-end
 * is NOT a claim that the run is done, so the forward-PROGRESS rungs (verify-suite,
 * artifact-drift, tier, interview, repo-map, governing-artifact, stage-coverage,
 * impl-settled) must NOT block a non-final Stop — blocking on them would wedge every
 * legitimate mid-build pause. What MUST still block at any stage are the HUMAN
 * reconciliation obligations (`always-run`): an open blocking drift / debate / revise
 * escalation / gating decision is owed to a human regardless of stage.
 *
 * Composition (the registry's buckets drive it):
 *   1. Run every `always-run` rung (drift, revise, decisions, debate) — block on any.
 *   2. At final-verification: return `checkFinalVerification` — the STRICT completion
 *      ladder (slices → verify_config_corrupt → verify_suite_never_run → coverage →
 *      report → production-reality).
 *   3. At a non-final stage: PASS (the forward-only rungs do not gate completion).
 *
 * VERIFY-AUTHORITY PIN (Item 5): at final-verification the verify authority is
 * `checkFinalVerification` (which blocks on verify_config_corrupt + verify_suite_
 * never_run + red), NOT `checkVerifySuite` (which PASSes never-run + corrupt-config
 * and blocks only on an existing-red report). Routing the final verify check through
 * the weaker `checkVerifySuite` would silently DROP the never-run + corrupt-config
 * blocks — an F1-class weakening. So the final branch composes `checkFinalVerification`
 * directly; `checkVerifySuite` is classified `forward-only` and is INERT at completion.
 * (`checkProductionReality` is self-gated to final-verification and composed inside
 * `checkFinalVerification`, so it is never reached at a non-final stage.)
 */
export function canCompleteRun(paths: ProjectPaths, state: TwinHarnessState): GateResult {
  // 1. Always-run human-reconciliation obligations, in registry order.
  for (const rung of GLOBAL_RUNGS) {
    if (rung.bucket !== "always-run") continue;
    const r = rung.run(paths, state);
    if (!r.ok) return r;
  }
  // 2. At the completion boundary, the strict final-verification ladder is authority.
  if (isFinalVerification(state.current_stage)) {
    return checkFinalVerification(paths, state);
  }
  // 3. Non-final: the forward-only rungs do not gate completion (a mid-build turn-end
  //    is not a "claim done"), so completion PASSes.
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
  // SG3 P2-C (enforce) — production-reality is part of the unlock composition too
  // (stage-aware: a no-op until final-verification, so it never blocks the normal
  // implementation-planning unlock; it holds if unlock is attempted at the final stage).
  const pr = checkProductionReality(paths, state);
  if (!pr.ok) return pr;
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
