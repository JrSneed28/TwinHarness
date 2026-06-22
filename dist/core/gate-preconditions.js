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
exports.checkFinalVerification = checkFinalVerification;
exports.checkProductionReality = checkProductionReality;
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
    return PASS;
}
/**
 * Rung m (NEW — SG3 P2-C, audit C-05..C-08) — the PRODUCTION-REALITY rung. A run may
 * not be certified complete while its user-visible production path still depends on
 * unresolved simulated behavior. FOUR sub-checks, each a DISTINCT stable error token
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
 */
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
    // `th sim scan`, so scan and gate agree. Capped walk (never throws).
    const scan = (0, sim_1.scanForSimulationHits)(paths);
    const unledgered = (0, sim_1.computeUnledgeredDistHitsReceiptAware)(paths, entries, scan.distHits);
    if (unledgered.length > 0) {
        return {
            ok: false,
            error: "unledgered_simulation_in_dist",
            detail: { hits: unledgered.slice(0, 20), total: unledgered.length },
        };
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
