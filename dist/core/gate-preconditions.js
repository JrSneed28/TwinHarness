"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkBlockingDrift = checkBlockingDrift;
exports.checkReviseEscalation = checkReviseEscalation;
exports.checkVerifySuite = checkVerifySuite;
exports.checkArtifactDrift = checkArtifactDrift;
exports.checkTierSet = checkTierSet;
exports.checkRepoMap = checkRepoMap;
exports.checkDecisionObligations = checkDecisionObligations;
exports.checkDebate = checkDebate;
exports.checkGoverningArtifact = checkGoverningArtifact;
exports.checkCoverage = checkCoverage;
exports.checkImplementationSettled = checkImplementationSettled;
exports.checkFinalVerification = checkFinalVerification;
exports.canAdvanceStage = canAdvanceStage;
exports.canUnlockImplementation = canUnlockImplementation;
exports.validateTierTransition = validateTierTransition;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const state_schema_1 = require("./state-schema");
const stages_1 = require("./stages");
const health_1 = require("./health");
const coverage_1 = require("./coverage");
const verify_1 = require("./verify");
const decisions_1 = require("./decisions");
const repo_1 = require("../commands/repo");
const PASS = { ok: true };
// ---------------------------------------------------------------------------
// Global rungs (stage-independent) — checked before any stage-specific work, in
// the exact short-circuit order of runNext() (next.ts:96-210 + the NEW debate rung).
// ---------------------------------------------------------------------------
/** Rung a (next.ts:96) — open blocking drift outranks all stage progress. */
function checkBlockingDrift(state) {
    if (state.drift_open_blocking > 0) {
        return { ok: false, error: "blocking_drift_open", detail: { drift_open_blocking: state.drift_open_blocking } };
    }
    return PASS;
}
/** Rung b (next.ts:109) — a revise loop at its cap owes a human escalation. */
function checkReviseEscalation(state) {
    const escalations = (0, health_1.reviseEscalations)(state);
    if (escalations.length > 0) {
        return { ok: false, error: "revise_escalation_open", detail: { escalations } };
    }
    return PASS;
}
/** Rung c (next.ts:124) — a red `th verify run` is a defect owed to the Debugger. */
function checkVerifySuite(paths) {
    const report = (0, verify_1.readVerifyReport)(paths);
    if (report && !report.ok) {
        const failed = report.results.filter((x) => !x.ok).length;
        return { ok: false, error: "verify_suite_failing", detail: { failed } };
    }
    return PASS;
}
/** Rung d (next.ts:138) — a governed artifact changed on disk without re-registration. */
function checkArtifactDrift(paths, state) {
    const changed = (0, health_1.artifactIntegrity)(paths, state).filter((i) => i.status === "changed").map((i) => i.file);
    if (changed.length > 0) {
        return { ok: false, error: "artifact_drift", detail: { changed } };
    }
    return PASS;
}
/** Rung e (next.ts:152) — tier gates every engaged stage. */
function checkTierSet(state) {
    if (state.tier === null) {
        return { ok: false, error: "tier_unclassified", detail: { current_stage: state.current_stage } };
    }
    return PASS;
}
/** Rung f (next.ts:170) — brownfield repo-map freshness before implementation unlock. */
function checkRepoMap(paths, state) {
    if (state.project_mode === "brownfield" && !state.implementation_allowed) {
        const check = (0, repo_1.runRepoCheck)(paths);
        if (check.exitCode !== 0) {
            const absent = check.exitCode === repo_1.REPO_NO_MAP_EXIT;
            const shape = check.data?.shape ?? "stale";
            return { ok: false, error: "repo_map_stale", detail: { absent, shape } };
        }
    }
    return PASS;
}
/** Rung g (next.ts:196) — an unapproved gating decision blocks the stage (RULE-007). */
function checkDecisionObligations(paths, state) {
    const decisions = (0, decisions_1.reduceDecisions)((0, decisions_1.readDecisionEvents)(paths));
    const obligations = (0, decisions_1.gatingObligations)(decisions, state);
    if (obligations.length > 0) {
        const first = obligations[0];
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
function checkDebate(state) {
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
function checkGoverningArtifact(paths, state) {
    const current = (0, stages_1.canonicalizeStage)(state.current_stage);
    const contract = (0, stages_1.stageContract)(current);
    if (contract && contract.produces && !(0, stages_1.isFinalVerification)(current)) {
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
function checkCoverage(paths) {
    const breakdown = (0, coverage_1.computeBreakdown)(paths.root);
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
 * Rung k (next.ts:374) — to advance OUT of the `implementation` stage, every slice
 * must be settled (done|blocked). `th next` surfaces a richer within-stage action
 * (dispatch-wave / await-builders / stalled-build / sync-slices) while building;
 * the security-relevant gate for advancing is simply "all slices settled".
 */
function checkImplementationSettled(state) {
    const prog = (0, health_1.sliceProgress)(state);
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
function checkFinalVerification(paths, state) {
    const prog = (0, health_1.sliceProgress)(state);
    if (!prog.allSettled && prog.total > 0) {
        const open = state.slices.filter((sl) => sl.status !== "done" && sl.status !== "blocked").map((sl) => sl.id);
        return { ok: false, error: "slices_unsettled", detail: { open } };
    }
    const verifyCfg = (0, verify_1.readVerifyConfig)(paths);
    if (verifyCfg.commands.length > 0 && !(0, verify_1.readVerifyReport)(paths)) {
        return { ok: false, error: "verify_suite_never_run", detail: { commands: verifyCfg.commands.length } };
    }
    const cov = checkCoverage(paths);
    if (!cov.ok)
        return cov;
    const contract = (0, stages_1.stageContract)((0, stages_1.canonicalizeStage)(state.current_stage));
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
function stageOrdinal(stage) {
    const canonical = (0, stages_1.canonicalizeStage)(stage);
    return stages_1.STAGE_PIPELINE.findIndex((s) => s.stage === canonical);
}
/** Index of the `implementation-planning` stage in the canonical pipeline. */
const IMPLEMENTATION_PLANNING_ORDINAL = stages_1.STAGE_PIPELINE.findIndex((s) => s.stage === "implementation-planning");
/**
 * The FULL mechanical ladder that must clear before the run advances OUT of the
 * current stage — the EXHAUSTIVE list (AC-B13 reuses it verbatim): global rungs
 * a–h, then the stage-specific rung for the current stage (governing artifact,
 * coverage at implementation-planning, slices settled at implementation, or the
 * final-verification ladder). Evaluated lazily so the short-circuit order — and the
 * cost (the brownfield repo scan only runs when reached) — matches `runNext()`.
 */
function canAdvanceStage(paths, state) {
    let r;
    if (!(r = checkBlockingDrift(state)).ok)
        return r;
    if (!(r = checkReviseEscalation(state)).ok)
        return r;
    if (!(r = checkVerifySuite(paths)).ok)
        return r;
    if (!(r = checkArtifactDrift(paths, state)).ok)
        return r;
    if (!(r = checkTierSet(state)).ok)
        return r;
    if (!(r = checkRepoMap(paths, state)).ok)
        return r;
    if (!(r = checkDecisionObligations(paths, state)).ok)
        return r;
    if (!(r = checkDebate(state)).ok)
        return r;
    const current = (0, stages_1.canonicalizeStage)(state.current_stage);
    if ((0, stages_1.isFinalVerification)(current)) {
        return checkFinalVerification(paths, state);
    }
    if (!(r = checkGoverningArtifact(paths, state)).ok)
        return r;
    if (current === "implementation-planning") {
        if (!(r = checkCoverage(paths)).ok)
            return r;
    }
    if (current === "implementation") {
        if (!(r = checkImplementationSettled(state)).ok)
            return r;
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
function canUnlockImplementation(paths, state) {
    const adv = canAdvanceStage(paths, state);
    if (!adv.ok)
        return adv;
    const cov = checkCoverage(paths);
    if (!cov.ok)
        return cov;
    const ordinal = stageOrdinal(state.current_stage);
    if (ordinal < 0 || ordinal < IMPLEMENTATION_PLANNING_ORDINAL) {
        return {
            ok: false,
            error: "stage_before_implementation_planning",
            detail: { current_stage: (0, stages_1.canonicalizeStage)(state.current_stage) },
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
function validateTierTransition(state, targetTier) {
    if (!state_schema_1.TIERS.includes(targetTier)) {
        return { ok: false, error: "invalid_tier", detail: { targetTier, validTiers: state_schema_1.TIERS } };
    }
    if (state.implementation_allowed === true) {
        return { ok: false, error: "tier_locked_after_unlock", detail: { tier: state.tier } };
    }
    if (state.tier !== null) {
        const curIdx = state_schema_1.TIERS.indexOf(state.tier);
        const tgtIdx = state_schema_1.TIERS.indexOf(targetTier);
        if (tgtIdx < curIdx) {
            return { ok: false, error: "tier_downgrade_human_only", detail: { from: state.tier, to: targetTier } };
        }
    }
    if (targetTier === "T0" && state.blast_radius_flags.length > 0) {
        return { ok: false, error: "t0_blast_radius_veto", detail: { flags: state.blast_radius_flags } };
    }
    return PASS;
}
