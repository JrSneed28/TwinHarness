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
exports.CAN_ADVANCE_RUNGS = void 0;
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
exports.implementationRequiresSlices = implementationRequiresSlices;
exports.checkImplementationSettled = checkImplementationSettled;
exports.checkHumanApprovalAdvance = checkHumanApprovalAdvance;
exports.checkFinalVerification = checkFinalVerification;
exports.checkProductionReality = checkProductionReality;
exports.requiredHumanGateStages = requiredHumanGateStages;
exports.interviewRequired = interviewRequired;
exports.checkInterview = checkInterview;
exports.canAdvanceStage = canAdvanceStage;
exports.canCompleteRun = canCompleteRun;
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
const interview_1 = require("../commands/interview");
const sim_1 = require("../commands/sim");
const tester_1 = require("./tester");
const receipts_1 = require("./receipts");
const approvals_1 = require("./approvals");
const verification_driver_1 = require("./verification-driver");
const receipt_signing_1 = require("./receipt-signing");
const bsc3_flag_1 = require("./bsc3-flag");
const bsc1_flag_1 = require("./bsc1-flag");
const realization_1 = require("./realization");
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
function checkRepoMap(paths, state) {
    if (state.project_mode === "brownfield" && !state.implementation_allowed) {
        // P4-5 — a PARTIAL (capped) map is incomplete: whole regions of the repo were
        // never seen, so unlocking on it repeats the silent-partial failure #5. This is
        // checked FIRST and independently of staleness — a partial map's drift diff (a
        // default-cap re-scan would flag the unscanned files as "added") is a red herring;
        // the real fix is to raise the caps and complete the scan, which `repo_map_partial`
        // tells the operator to do. The partial marker is read from the PERSISTED map (the
        // deterministic `capHit`), not from a re-scan, so it is cheap and cap-agnostic.
        const marker = (0, repo_1.repoMapPartialMarker)(paths);
        if (marker.partial) {
            return { ok: false, error: "repo_map_partial", detail: { capHit: marker.capHit } };
        }
        // Otherwise enforce freshness (added/removed/modified/absent) via the cached check
        // (P4-10) so this hot gate path does not re-hash the whole tree on every attempt.
        const check = (0, repo_1.runRepoCheckCached)(paths);
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
 * SINGLE shared predicate (audit finding #2): does this project owe implementation
 * slices? True for a "code" delivery (the default — absent `delivery_mode` ⇒ "code"),
 * false for "no-code" / "documentation-only". BOTH `checkImplementationSettled` (the
 * gate) AND `th next` (the oracle, via the `sync-slices` branch) consume THIS one
 * predicate, so they can never disagree about whether an EMPTY slice set during the
 * `implementation` stage is valid.
 */
function implementationRequiresSlices(state) {
    return (state.delivery_mode ?? "code") === "code";
}
/**
 * Rung k (next.ts:374) — to advance OUT of the `implementation` stage, every slice
 * must be settled (done|blocked). `th next` surfaces a richer within-stage action
 * (dispatch-wave / await-builders / stalled-build / sync-slices) while building;
 * the security-relevant gate for advancing is simply "all slices settled".
 */
function checkImplementationSettled(state) {
    const prog = (0, health_1.sliceProgress)(state);
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
function checkHumanApprovalAdvance(paths, state) {
    const current = (0, stages_1.canonicalizeStage)(state.current_stage);
    // Only applies when advancing OUT of a humanGate stage (mirrors rungAppliesAtStage's
    // arm). A non-humanGate current stage carries no approval obligation.
    if (!(0, approvals_1.isHumanGateStage)(current))
        return PASS;
    const validated = (0, approvals_1.readApprovalValidated)(paths, current);
    // Accept set: a `valid` (in-process attested), `valid-grounded` (external keyed,
    // slice-3b), or `legacy` (grandfathered) approval clears the rung. Anything else —
    // absent / stale / target_missing / target_mismatch / forged / tampered — is a
    // missing/invalid approval.
    if (validated.status === "valid" ||
        validated.status === "valid-grounded" ||
        validated.status === "legacy") {
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
function checkFinalVerification(paths, state) {
    const prog = (0, health_1.sliceProgress)(state);
    if (!prog.allSettled && prog.total > 0) {
        const open = state.slices.filter((sl) => sl.status !== "done" && sl.status !== "blocked").map((sl) => sl.id);
        return { ok: false, error: "slices_unsettled", detail: { open } };
    }
    // R-23: read through loadVerifyConfig (NOT readVerifyConfig) so a present-but-
    // CORRUPT verify.json fails CLOSED. readVerifyConfig collapses a corrupt config to
    // `{ commands: [] }`, which made the `verify_suite_never_run` rung skip (length 0)
    // and the final-verification gate PASS on an unreadable config — the same fail-OPEN
    // that `runVerifyRun` already refuses. A corrupt config is now its own failing rung.
    const verifyLoaded = (0, verify_1.loadVerifyConfig)(paths);
    if (verifyLoaded.status === "corrupt") {
        return { ok: false, error: "verify_config_corrupt", detail: {} };
    }
    const verifyCfg = verifyLoaded.config;
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
    // SG3 P2-C (enforce) — the production-reality rung: at final-verification, a run may
    // not be certified complete while a user-visible production path depends on unresolved
    // simulation / verify is red / no Tester record / dist carries unledgered simulation.
    const pr = checkProductionReality(paths, state);
    if (!pr.ok)
        return pr;
    // Propagate the PASS result (not a bare PASS) so the BSC-3 `dimensions` trust-label
    // summary (and any non-blocking `notice`) checkProductionReality attaches rides up to
    // `canCompleteRun`/`th next` for the I1 observability hook.
    return pr;
}
/**
 * Rung m (NEW — SG3 P2-C, audit C-05..C-08) — the PRODUCTION-REALITY rung. A run may
 * not be certified complete while its user-visible production path still depends on
 * unresolved simulated behavior. SIX sub-checks, each a DISTINCT stable error token
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
 *
 * Two further fail-closed tokens are NOT sub-checks of the production path but guard the
 * rung's own inputs: `terminal_receipt_unverified` (BSC-4 terminal-flip grounding — every
 * in-force drift-resolution/decision-approval must carry a valid/legacy receipt) and
 * `simulation_ledger_corrupt` (an unreadable ledger fails closed). Together the rung can
 * emit EIGHT distinct stable tokens; the six above are the production-reality sub-checks.
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
function driverReceiptClaimsExternal(r) {
    return typeof r.signature === "string" || typeof r.key_id === "string";
}
/**
 * Build the per-dimension observability summary for a selected receipt under a single
 * trust label. `observed` is re-derived against `verify-report.json` via the shared
 * {@link validateDriverReceiptContent} ground (a recorded dimension the current report no
 * longer evidences reads `observed:false`). The seed-name order is preserved so the
 * rendered list is deterministic.
 */
function summarizeDriverDimensions(paths, receipt, trustLabel) {
    const content = (0, verification_driver_1.validateDriverReceiptContent)(paths, receipt);
    const unobserved = new Set(content.unobservedDimensions ?? []);
    // `evidence_missing` invalidates the whole ground — no recorded dimension re-derives.
    const evidenceMissing = content.status === "evidence_missing";
    const recorded = receipt.dimensions.map((d) => d.name);
    const ordered = [
        ...verification_driver_1.SEED_DIMENSION_NAMES.filter((n) => recorded.includes(n)),
        ...recorded.filter((n) => !verification_driver_1.SEED_DIMENSION_NAMES.includes(n)),
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
function driverSignatureVerifies(receipt) {
    const publicKey = (0, receipt_signing_1.loadExternalPublicKey)();
    if (publicKey === null)
        return false;
    if (typeof receipt.signature !== "string")
        return false;
    if (receipt.key_id !== (0, receipt_signing_1.externalKeyId)(publicKey))
        return false;
    const { recordHash: _rh, signature: _sig, ...signedView } = receipt;
    return (0, receipt_signing_1.verifyCanonical)((0, verification_driver_1.driverCanonicalText)(signedView), receipt.signature, publicKey);
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
function evaluateDriverDimensions(paths) {
    const inProcess = (0, verification_driver_1.readDriverReceipts)(paths);
    const external = (0, verification_driver_1.readExternalDriverReceipts)(paths);
    // 0. Tamper walk BOTH chains before trusting any line from them.
    const inChain = (0, verification_driver_1.verifyDriverChain)(inProcess);
    if (!inChain.ok) {
        return { ok: false, reason: "chain", dimensions: [], detail: { store: "in-process", brokenAt: inChain.brokenAt, chainReason: inChain.reason } };
    }
    const exChain = (0, verification_driver_1.verifyDriverChain)(external);
    if (!exChain.ok) {
        return { ok: false, reason: "chain", dimensions: [], detail: { store: "external", brokenAt: exChain.brokenAt, chainReason: exChain.reason } };
    }
    // 1. EXTERNAL claim is decisive. Gather every external-store receipt that claims
    //    external/signed; the LAST whose signature verifies wins (file order ⇒ re-mint wins).
    const externalClaims = external.filter(driverReceiptClaimsExternal);
    if (externalClaims.length > 0) {
        let verified;
        for (const cand of externalClaims) {
            if (driverSignatureVerifies(cand))
                verified = cand;
        }
        if (verified) {
            const dims = summarizeDriverDimensions(paths, verified, "valid-grounded");
            const content = (0, verification_driver_1.validateDriverReceiptContent)(paths, verified);
            if (content.status === "dimension_unobserved" || content.status === "evidence_missing") {
                return { ok: false, reason: "unobserved", dimensions: dims, detail: { trustLabel: "valid-grounded", contentStatus: content.status, ...(content.unobservedDimensions ? { unobservedDimensions: content.unobservedDimensions } : {}) } };
            }
            return { ok: true, dimensions: dims };
        }
        // External claim present but no signature verifies ⇒ forged ⇒ BLOCK.
        const forged = externalClaims[externalClaims.length - 1];
        return { ok: false, reason: "forged", dimensions: summarizeDriverDimensions(paths, forged, "forged"), detail: { trustLabel: "forged", store: "external", key_id: forged.key_id ?? null } };
    }
    // 2. In-process path. The LATEST in-process receipt; a line that CLAIMS external/signed
    //    in this store is still held to the signature bar (forged if it does not verify).
    const latest = inProcess.length > 0 ? inProcess[inProcess.length - 1] : undefined;
    if (latest) {
        if (driverReceiptClaimsExternal(latest)) {
            if (driverSignatureVerifies(latest)) {
                const dims = summarizeDriverDimensions(paths, latest, "valid-grounded");
                const content = (0, verification_driver_1.validateDriverReceiptContent)(paths, latest);
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
        const content = (0, verification_driver_1.validateDriverReceiptContent)(paths, latest);
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
function checkDriverDimensions(paths) {
    const verdict = evaluateDriverDimensions(paths);
    // A clean PASS with NO observed dimensions (the grandfathered/absence case) carries an
    // EMPTY summary, which conveys nothing — so return a BARE PASS to preserve the prior
    // `{ ok: true }` gate contract every downstream rung composes. Only attach `dimensions`
    // when there is something to observe (the observability hook still fires for any
    // non-empty summary).
    if (verdict.ok)
        return verdict.dimensions.length === 0 ? PASS : { ok: true, dimensions: verdict.dimensions };
    if (!(0, bsc3_flag_1.bsc3EnforcementEnabled)()) {
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
function checkRealization(paths, state) {
    const map = (0, realization_1.loadRepoMapForRealization)(paths);
    if (map === null)
        return PASS; // no map ⇒ no owned-REQ obligation (freshness owned elsewhere)
    const failures = [];
    // Fail-closed name-fidelity guard (control 11f): a done-slice REQ the join cannot place
    // under a known component is reported, never silently dropped ("unobserved ≠ clean").
    for (const reqId of (0, realization_1.unresolvedDoneSliceReqs)(map, state)) {
        failures.push({ reqId, status: "unresolved" });
    }
    // The enumerator: every REQ owned by a `done` slice must carry a valid, digest-fresh
    // realization referent. ACCEPT set: `valid` (in-process attested), `valid-grounded`
    // (external keyed + verified), `legacy` (grandfathered). Everything else BLOCKS.
    for (const owned of (0, realization_1.ownedReqsForDoneSlices)(map, state)) {
        const v = (0, realization_1.readRealizationReceiptValidated)(paths, owned.reqId);
        if (v.status !== "valid" && v.status !== "valid-grounded" && v.status !== "legacy") {
            failures.push({ reqId: owned.reqId, status: v.status, owningSlices: owned.owningSlices });
        }
    }
    if (failures.length === 0)
        return PASS;
    const detail = {
        failures: failures.slice(0, 20),
        total: failures.length,
        statuses: [...new Set(failures.map((f) => f.status))].sort(),
    };
    if (!(0, bsc1_flag_1.realizationEnforcementEnabled)()) {
        // Flag OFF: observe but do not block. Surface the would-be block as a non-blocking notice.
        return { ok: true, notice: { token: "realization_unverified", detail } };
    }
    return { ok: false, error: "realization_unverified", detail };
}
function checkProductionReality(paths, state) {
    // Stage-aware: production reality is a CERTIFY-COMPLETION condition, so it only
    // enforces at the completion boundary (final-verification). Earlier stages have no
    // built dist/ / Tester record yet — gating them would be nonsensical and would red
    // every in-flight run's obligation ladder. Mirrors checkInterview's front-gate shape.
    if (!(0, stages_1.isFinalVerification)(state.current_stage))
        return PASS;
    // 1. A user-visible simulation still blocks. BSC-4 receipt-aware: an entry blocks
    // when it is active+user-visible+simulated (the original rule) OR when it is marked
    // `retired` but that retirement is NOT grounded by a valid/legacy sim-retire receipt
    // (a retire-by-attestation with no source replacement — no double-exoneration). The
    // SAME `simEntryBlocksProductionReality` predicate backs `th sim`, so reporting agrees.
    let entries;
    try {
        entries = (0, sim_1.readSimulationLedger)(paths);
    }
    catch (e) {
        if (e instanceof sim_1.SimulationLedgerCorruptError) {
            return { ok: false, error: "simulation_ledger_corrupt", detail: {} };
        }
        throw e;
    }
    const blocking = entries.filter((e) => (0, sim_1.simEntryBlocksProductionReality)(paths, e));
    if (blocking.length > 0) {
        return {
            ok: false,
            error: "simulation_unretired",
            detail: { ids: blocking.map((e) => e.id), classifications: blocking.map((e) => e.classification) },
        };
    }
    // 1b. Terminal-flip grounding (BSC-4). Every drift-resolution and decision-approval
    // in force must carry a VALID (or grandfathered-`legacy`) TerminalTransitionReceipt.
    // A resolve/approve done via a bypass (no receipt) — or whose recorded source target
    // was deleted (`target_missing`) / changed (`target_mismatch`), or whose snapshot is
    // forged/stale (`stale`) — is ungrounded and blocks. `sim-retire` grounding is owned
    // by rung 1 (excluded here to avoid a duplicate token). Pre-upgrade projects carry no
    // migration marker, so an absent receipt classifies `legacy` and this is a NO-OP until
    // the receipt regime is active — it never reds an existing complete run.
    for (const ent of (0, receipts_1.collectTerminalEntities)(paths)) {
        if (ent.kind === "sim-retire")
            continue; // owned by rung 1's receipt-aware blocker
        const v = (0, receipts_1.readReceiptValidated)(paths, ent.kind, ent.refId);
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
    for (const stage of requiredHumanGateStages(state)) {
        const a = (0, approvals_1.readApprovalValidated)(paths, stage);
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
    }
    // 2. The verify suite must be green against production-targeted commands, AND the
    // report must be a CURRENT-binding report (F2/R-30 — not a legacy bare report, not a
    // stale/copied one). The validated reader classifies the report; only a `valid` GREEN
    // report passes. A corrupt config still blocks (fail-closed). One stable token
    // (`production_verify_not_green`) with a `reason` detail naming the divergence.
    const verifyLoaded = (0, verify_1.loadVerifyConfig)(paths);
    if (verifyLoaded.status === "corrupt") {
        return { ok: false, error: "production_verify_not_green", detail: { reason: "config_corrupt" } };
    }
    const verifyCfg = verifyLoaded.config;
    if (verifyCfg.commands.length > 0) {
        const validated = (0, verify_1.readVerifyReportValidated)(paths);
        if (validated.status === "absent") {
            return { ok: false, error: "production_verify_not_green", detail: { reason: "never_run", commands: verifyCfg.commands.length } };
        }
        if (validated.status !== "valid") {
            // legacy / stale / corrupt report → the green claim cannot be trusted for the
            // current snapshot. Re-run `th verify run` to seal a fresh bound envelope.
            return { ok: false, error: "production_verify_not_green", detail: { reason: validated.status, ...(validated.staleReasons ? { staleReasons: validated.staleReasons } : {}) } };
        }
        if (!validated.report.ok) {
            const failed = validated.report.results.filter((x) => !x.ok).length;
            return { ok: false, error: "production_verify_not_green", detail: { reason: "failing", failed } };
        }
    }
    // 3. A live-QA Tester run record must be attached (audit C-08).
    if (!(0, tester_1.testerRecordPresent)(paths)) {
        return { ok: false, error: "tester_record_missing", detail: {} };
    }
    // 4. dist/ must not carry unledgered simulation patterns. A dist hit is "ledgered"
    // only when an ACTIVE simulation entry DECLARES that specific hit — matched
    // PER-DEPENDENCY (audit P1), so a single unrelated, non-user-visible entry no longer
    // blanket-suppresses every dist hit. The SAME `computeUnledgeredDistHits` join backs
    // `th sim scan`, so scan and gate agree. The two-tier scan never throws.
    const scan = (0, sim_1.scanForSimulationHits)(paths);
    const unledgered = (0, sim_1.computeUnledgeredDistHitsReceiptAware)(paths, entries, scan.distHits);
    if (unledgered.length > 0) {
        return {
            ok: false,
            error: "unledgered_simulation_in_dist",
            detail: { hits: unledgered.slice(0, 20), total: unledgered.length },
        };
    }
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
    // `unobserved{file_limit}` (→ this block), never silently skipped.
    const uncovered = (0, sim_1.uncoveredAfterExceptions)(paths, scan.unobserved);
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
    const driver = checkDriverDimensions(paths);
    if (!driver.ok)
        return driver;
    // 7. (BSC-1 / Axis-B slice-5) REALIZATION-RECEIPT GROUNDING — composed LAST. A run may not
    // be certified complete while a REQ-ID owned by a `done` slice lacks a valid, reachable,
    // digest-fresh realization referent. The CLAIM (`SliceState.status==="done"`) is authored
    // independently of the REFERENT (recorded by `th realize`); this enumerates done-slice
    // REQ-IDs from the cached repo-map, recomputes each referent digest, COLLECTS ALL failures,
    // and blocks on absent/stale/forged/target_*/tampered/unresolved. ABSENCE is grandfathered
    // (`legacy`) until the migration marker is stamped, so this is a NO-OP on pre-upgrade
    // projects. Governed by `realizationEnforcementEnabled()` (defaults ON).
    const realization = checkRealization(paths, state);
    if (!realization.ok) {
        // Preserve the driver `dimensions` summary on the realization block so the trust posture
        // stays visible alongside the realization failure.
        return driver.dimensions ? { ...realization, dimensions: driver.dimensions } : realization;
    }
    // Both passed: ride the driver result up (it carries `dimensions`/`notice`); fold in any
    // realization warn-phase notice (flag OFF) without clobbering a driver notice.
    if (realization.notice && !driver.notice)
        return { ...driver, notice: realization.notice };
    return driver;
}
// ---------------------------------------------------------------------------
// Composed gate predicates — consumed by both `th next` and the typed MCP tools.
// ---------------------------------------------------------------------------
/** Pipeline ordinal of a (canonicalized) stage, or -1 for a pre-pipeline stage. */
function stageOrdinal(stage) {
    const canonical = (0, stages_1.canonicalizeStage)(stage);
    return stages_1.STAGE_PIPELINE.findIndex((s) => s.stage === canonical);
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
function requiredHumanGateStages(state) {
    const currentOrdinal = stageOrdinal(state.current_stage);
    return (0, stages_1.engagedStagesFor)(state)
        .filter((s) => s.humanGate && stageOrdinal(s.stage) <= currentOrdinal)
        .map((s) => s.stage);
}
/** Index of the `implementation-planning` stage in the canonical pipeline. */
const IMPLEMENTATION_PLANNING_ORDINAL = stages_1.STAGE_PIPELINE.findIndex((s) => s.stage === "implementation-planning");
/** Index of the `requirements` stage — the soft interview gate's boundary (finding #14). */
const REQUIREMENTS_ORDINAL = stages_1.STAGE_PIPELINE.findIndex((s) => s.stage === "requirements");
/**
 * Whether a clarity interview is REQUIRED before advancing past `requirements`
 * (audit finding #14, soft gate). An explicit `interview_required` boolean wins;
 * absent ⇒ COMPUTED from tier: required for T2/T3, not for T0/T1/unclassified.
 */
function interviewRequired(state) {
    if (typeof state.interview_required === "boolean")
        return state.interview_required;
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
function checkInterview(paths, state) {
    if (!interviewRequired(state))
        return PASS;
    if ((0, interview_1.interviewReady)(paths))
        return PASS;
    const ordinal = stageOrdinal(state.current_stage);
    // Pre-pipeline (ordinal -1, e.g. "init") and `requirements` itself are at/before the
    // gate point; anything later is already past it and must not be re-blocked.
    if (ordinal < 0 || ordinal <= REQUIREMENTS_ORDINAL) {
        return { ok: false, error: "interview_incomplete", detail: { current_stage: (0, stages_1.canonicalizeStage)(state.current_stage) } };
    }
    return PASS;
}
/**
 * The 9 GLOBAL rungs in `canAdvanceStage`'s exact short-circuit order. The loop in
 * `canAdvanceStage` iterates THIS array, so the order here IS the runtime order
 * (next.ts's ladder is pinned to it by next-characterization). Each is classified:
 * the four HUMAN-reconciliation obligations are `always-run`; the rest are
 * `forward-only`.
 */
const GLOBAL_RUNGS = [
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
const STAGE_RUNGS = [
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
exports.CAN_ADVANCE_RUNGS = [...GLOBAL_RUNGS, ...STAGE_RUNGS];
/**
 * Does a registry rung APPLY at `stage`? Globals always apply; the stage rungs apply
 * only at their stage. This is the single stage-gating predicate `canAdvanceStage`
 * uses to drive the registry, so the stage-branch logic lives in ONE place the
 * exhaustiveness test can see.
 */
function rungAppliesAtStage(rung, stage) {
    switch (rung.scope) {
        case "global":
            return true;
        case "stage:non-final-artifact":
            return !(0, stages_1.isFinalVerification)(stage);
        case "stage:implementation-planning":
            return stage === "implementation-planning";
        case "stage:implementation":
            return stage === "implementation";
        case "stage:human-approval-advance":
            // Applies when advancing OUT of a humanGate stage — i.e. the CURRENT stage is one
            // of the 8 humanGate stages (the per-stage approval obligation is owed by the stage
            // being crossed). Mirrors checkHumanApprovalAdvance's own guard.
            return (0, approvals_1.isHumanGateStage)((0, stages_1.canonicalizeStage)(stage));
        case "stage:final":
            return (0, stages_1.isFinalVerification)(stage);
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
function canAdvanceStage(paths, state) {
    const current = (0, stages_1.canonicalizeStage)(state.current_stage);
    for (const rung of exports.CAN_ADVANCE_RUNGS) {
        if (!rungAppliesAtStage(rung, current))
            continue;
        const r = rung.run(paths, state);
        if (!r.ok)
            return r;
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
function canCompleteRun(paths, state) {
    // 1. Always-run human-reconciliation obligations, in registry order.
    for (const rung of GLOBAL_RUNGS) {
        if (rung.bucket !== "always-run")
            continue;
        const r = rung.run(paths, state);
        if (!r.ok)
            return r;
    }
    // 2. At the completion boundary, the strict final-verification ladder is authority.
    if ((0, stages_1.isFinalVerification)(state.current_stage)) {
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
function canUnlockImplementation(paths, state) {
    const adv = canAdvanceStage(paths, state);
    if (!adv.ok)
        return adv;
    const cov = checkCoverage(paths);
    if (!cov.ok)
        return cov;
    // SG3 P2-C (enforce) — production-reality is part of the unlock composition too
    // (stage-aware: a no-op until final-verification, so it never blocks the normal
    // implementation-planning unlock; it holds if unlock is attempted at the final stage).
    const pr = checkProductionReality(paths, state);
    if (!pr.ok)
        return pr;
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
