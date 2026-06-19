"use strict";
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
exports.VETO_EXIT_CODE = exports.TIERS = exports.FEATURE_CATALOG = exports.ADVANCED_FEATURES = void 0;
exports.featureSpec = featureSpec;
exports.parallelAuthorshipDetected = parallelAuthorshipDetected;
exports.featureActive = featureActive;
exports.featureActiveForState = featureActiveForState;
exports.runTierFeatures = runTierFeatures;
exports.runTierClassify = runTierClassify;
exports.runTierVetoCheck = runTierVetoCheck;
exports.runTierRecord = runTierRecord;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("../core/paths");
const output_1 = require("../core/output");
const state_schema_1 = require("../core/state-schema");
Object.defineProperty(exports, "TIERS", { enumerable: true, get: function () { return state_schema_1.TIERS; } });
const brief_1 = require("../core/brief");
const log_1 = require("../core/log");
const guards_1 = require("../core/guards");
const state_store_1 = require("../core/state-store");
const repo_1 = require("./repo");
const gate_preconditions_1 = require("../core/gate-preconditions");
const state_1 = require("./state");
/** Every gated feature, in stable catalog order. */
exports.ADVANCED_FEATURES = [
    "collab",
    "debate",
    "section-lease",
    "sub-lease",
];
/**
 * The feature catalog (P5-1). Order is stable so `th tier features` output and the
 * tests that pin it stay deterministic. The minimum tier and the
 * parallel-authorship escape hatch are uniform across every advanced feature
 * (≥T2 OR live parallel authorship), so they live in {@link featureActive} rather
 * than per-entry — keeping the activation rule a single mechanical predicate.
 */
exports.FEATURE_CATALOG = [
    {
        feature: "collab",
        title: "Blackboard collaboration (fragments + reconcile-merge)",
        useWhen: "Use when ≥2 agents author the SAME stage's artifact in parallel and a Reconciler merges their fragments. A single-writer T0/T1 stage never needs it.",
    },
    {
        feature: "debate",
        title: "Debate ledger (competing-producer adjudication)",
        useWhen: "Use when competing producers must argue positions that a human/Reconciler adjudicates before completion (Pattern B). A linear single-author run records no debates.",
    },
    {
        feature: "section-lease",
        title: "Artifact section leases (<file>#<section>)",
        useWhen: "Use when ≥2 agents co-edit DIFFERENT sections of the SAME artifact and must not collide on one section. A lone writer owns the whole file and needs no section lease.",
    },
    {
        feature: "sub-lease",
        title: "Sub-Builder component sub-leases",
        useWhen: "Use when a scoped sub-Builder takes a SUBSET of a parent slice's components in parallel. A single Builder per slice never opens a sub-lease.",
    },
];
/** Lookup the catalog entry for a feature (undefined for an unknown token). */
function featureSpec(feature) {
    return exports.FEATURE_CATALOG.find((f) => f.feature === feature);
}
/** A tier ranks ≥T2 iff it is T2 or T3 (the advanced-coordination floor). */
function tierRankAtLeastT2(tier) {
    return tier === "T2" || tier === "T3";
}
/**
 * Whether a run is ALREADY doing parallel authorship: a live build with more than
 * one slice in flight (in-progress) is concurrent multi-writer work by definition,
 * so the coordination machinery is warranted even if the recorded tier is below
 * T2. This is the "parallel-authorship detection" escape hatch (plan §D2): it
 * never turns features OFF (a high tier still activates them), it only turns them
 * ON when the run's own shape proves it needs them. Conservative: a single
 * in-flight slice (or none) is single-writer and does NOT trip it.
 */
function parallelAuthorshipDetected(state) {
    const inFlight = state.slices.filter((s) => s.status === "in-progress").length;
    return inFlight > 1;
}
/**
 * The activation predicate (P5-1): an advanced feature is active iff the tier is
 * ≥T2 OR the run is already doing parallel authorship. Uniform across every
 * feature in {@link FEATURE_CATALOG} — there is one mechanical rule, not a
 * per-feature matrix — so the gate is easy to reason about and impossible to
 * drift between the `th tier features` view and the MCP runtime gate.
 *
 * CONSERVATIVE DEFAULT: with no parallel authorship, T0/T1 ⇒ OFF, T2/T3 ⇒ ON. An
 * unclassified tier (`null`) is OFF unless parallel authorship is live, so a
 * pre-tier run never silently loads the coordination plane.
 */
function featureActive(_feature, tier, state) {
    return tierRankAtLeastT2(tier) || parallelAuthorshipDetected(state);
}
/**
 * Convenience over {@link featureActive} that reads tier + slices straight off a
 * whole state object — the shape the MCP runtime gate and `th tier features` both
 * already hold. The MCP gate resolves the active tier via this same plain state
 * read (`requireState(paths).state.tier`), NOT a re-classification (plan §P5-2).
 */
function featureActiveForState(feature, state) {
    return featureActive(feature, state.tier, state);
}
/**
 * `th tier features` — render the feature-activation layer for the current run:
 * each advanced feature, whether it is ACTIVE for the resolved tier (+ parallel
 * authorship), and its "use when". Read-only; never mutates state. Tolerant of an
 * absent/invalid state.json — it reports the conservative default (everything OFF
 * for an unclassified, single-writer run) rather than erroring, so an operator can
 * always ask "what is on?".
 */
function runTierFeatures(paths) {
    const r = (0, state_store_1.readState)(paths);
    // Resolve tier + slices from a plain state read; fall back to the conservative
    // default shape (no tier, no slices) when state is absent/invalid so the command
    // always answers.
    const tier = r.state ? r.state.tier : null;
    const slices = r.state ? r.state.slices : [];
    const parallel = parallelAuthorshipDetected({ slices });
    const features = exports.FEATURE_CATALOG.map((spec) => ({
        feature: spec.feature,
        title: spec.title,
        active: featureActive(spec.feature, tier, { slices }),
        useWhen: spec.useWhen,
    }));
    (0, log_1.structuredLog)({ cmd: "tier features", tier: tier ?? "unclassified", parallel });
    const tierLabel = tier ?? "unclassified";
    const lines = [
        `Feature activation (tier ${tierLabel}${parallel ? ", parallel authorship LIVE" : ""}):`,
        "Advanced coordination is OFF by default; it activates at tier ≥T2 or when >1 slice is in flight.",
        "",
    ];
    for (const f of features) {
        lines.push(`  [${f.active ? "ON " : "off"}] ${f.feature} — ${f.title}`);
        lines.push(`        use when: ${f.useWhen}`);
    }
    return (0, output_1.success)({
        data: { tier: tierLabel, parallel_authorship: parallel, features },
        human: lines.join("\n"),
    });
}
/**
 * `th tier` — the Tier-0 classifier (spec §5).
 *
 * Two surfaces with deliberately different contracts (build plan §3):
 * - `classify` is **advisory** — it computes the five Tier-0 conditions and the
 *   blast-radius veto but never picks T1/T2/T3 (that is judgment, plan §3
 *   boundary rule). It never hard-fails (exit 0).
 * - `veto-check` is **mechanical** — a hard exit-code gate (exit 3) when any
 *   blast-radius flag is present, forbidding Tier 0. This is a *mechanical
 *   truth* (spec §5 veto), wired into the hook alongside `th state verify`.
 *
 * The veto floor is also a schema invariant (state-schema.ts), so even a
 * hand-edited `tier: "T0"` with a flag is mechanically refused.
 */
/** Exit code for a blast-radius veto (distinct from the generic failure 1). */
exports.VETO_EXIT_CODE = 3;
/**
 * Brownfield prerequisite check (REQ-301..305, IF-007).
 *
 * Returns `{ ok: true, missing: [] }` immediately for any non-brownfield run
 * (including absent/unreadable state.json). Only when `project_mode ===
 * "brownfield"` does it check for the two required artifacts.
 *
 * Short-circuit guarantee (REQ-304, REQ-305): greenfield and uninitialized
 * projects are byte-identical to pre-epic behavior — this helper changes nothing
 * for them (no side-effects, no output change, no exit-code change).
 */
function brownfieldPrerequisite(paths) {
    // Anchor: REQ-305
    // Read state; tolerate absent or unreadable state.json (falls through as greenfield).
    const stateResult = (0, state_store_1.readState)(paths);
    if (!stateResult.state || stateResult.state.project_mode !== "brownfield") {
        // REQ-304: short-circuit — greenfield / uninitialized path, nothing changes.
        return { ok: true, missing: [], stale: [] };
    }
    // Brownfield run: both prerequisite artifacts must be PRESENT, and the repo-map
    // must additionally be FRESH (REQ-301). A map that has drifted from the working
    // tree grounds tiering/planning on an outdated understanding, so it is as
    // disqualifying as an absent one. Freshness is delegated to the single
    // `th repo check` oracle (`runRepoCheck`) — no duplicate hashing here.
    const repoMapPath = path.join(paths.stateDir, "repo-map.json");
    const repoMapRel = path.relative(paths.root, repoMapPath).replace(/\\/g, "/");
    const codebaseAnalysisPath = path.join(paths.docsDir, "00-existing-codebase-analysis.md");
    const missing = [];
    const stale = [];
    // Anchor: REQ-301 — repo-map EXISTENCE *and* FRESHNESS via runRepoCheck.
    const check = (0, repo_1.runRepoCheck)(paths);
    if (check.exitCode === repo_1.REPO_NO_MAP_EXIT) {
        // Absent map → unchanged outcome (canonical relative path, contract IF-007).
        missing.push(repoMapRel);
    }
    else if (check.exitCode !== 0) {
        // REPO_STALE_EXIT (4: drifted / no-hashes) or 1 (unparseable): the map no
        // longer reflects the tree, so it cannot ground tiering decisions.
        stale.push(repoMapRel);
    }
    if (!fs.existsSync(codebaseAnalysisPath)) {
        const rel = path.relative(paths.root, codebaseAnalysisPath).replace(/\\/g, "/");
        missing.push(rel);
    }
    if (missing.length > 0 || stale.length > 0) {
        // Anchor: REQ-302
        return { ok: false, missing, stale };
    }
    return { ok: true, missing: [], stale: [] };
}
function briefLoadFailure(briefPath, issues) {
    return (0, output_1.failure)({
        human: `Could not load brief "${briefPath}":\n${(0, guards_1.formatIssues)(issues)}`,
        data: { error: "invalid_brief", issues },
    });
}
/** The five Tier-0 conditions plus the veto, computed mechanically (spec §5). */
function classifyBrief(brief) {
    const reasons = [];
    if (!brief.single_file_or_local)
        reasons.push("not a single file / tightly local area");
    if (brief.changes_public_interface)
        reasons.push("changes a public interface, schema, or contract");
    if (brief.adds_dependency)
        reasons.push("adds a new dependency");
    if (!brief.obvious_testable_answer)
        reasons.push("no obvious, testable correct answer");
    const blocked_by_veto = brief.blast_radius_flags.length > 0;
    if (blocked_by_veto) {
        reasons.push(`blast-radius flag(s) force ≥T1 (§5 veto): ${brief.blast_radius_flags.join(", ")}`);
    }
    const tier0_eligible = brief.single_file_or_local &&
        !brief.changes_public_interface &&
        !brief.adds_dependency &&
        brief.obvious_testable_answer &&
        brief.blast_radius_flags.length === 0;
    return { tier0_eligible, blocked_by_veto, reasons };
}
/**
 * `th tier classify <brief.json>` — ADVISORY (build plan §3). Computes the five
 * Tier-0 conditions and the blast-radius veto; reports a T0/≥T1 advisory and the
 * reasons any condition failed. Never hard-fails (exit 0); does NOT pick the
 * tier number.
 */
function runTierClassify(paths, briefPath) {
    if (!briefPath)
        return (0, output_1.failure)({ human: "usage: th tier classify <brief.json>" });
    // Resolve the brief path against the project root (--cwd), like `th artifact register`.
    const briefFile = (0, paths_1.resolveWithinRoot)(paths.root, briefPath);
    if (briefFile === null) {
        return (0, output_1.failure)({ human: `Brief path outside project root: ${briefPath}`, data: { error: "path_outside_root", file: briefPath } });
    }
    const loaded = (0, brief_1.loadBriefFromFile)(briefFile);
    if (!loaded.ok || !loaded.brief)
        return briefLoadFailure(briefFile, loaded.issues);
    const { tier0_eligible, blocked_by_veto, reasons } = classifyBrief(loaded.brief);
    const advisory = tier0_eligible ? "T0" : "≥T1";
    (0, log_1.structuredLog)({ cmd: "tier classify", advisory, blocked_by_veto });
    const human = tier0_eligible
        ? "Advisory: T0 — all five Tier-0 conditions hold and no blast-radius flag is present."
        : `Advisory: ≥T1 — Tier 0 not eligible:\n${reasons.map((r) => `  - ${r}`).join("\n")}`;
    // Anchor: REQ-303 — brownfield advisory (exit 0, surfaced in data only).
    const prereq = brownfieldPrerequisite(paths);
    const extraData = {};
    if (!prereq.ok) {
        if (prereq.missing.length > 0)
            extraData.brownfield_prerequisite_missing = prereq.missing;
        if (prereq.stale.length > 0)
            extraData.brownfield_prerequisite_stale = prereq.stale;
    }
    return (0, output_1.success)({
        data: {
            tier0_eligible,
            blocked_by_veto,
            blast_radius_flags: loaded.brief.blast_radius_flags,
            advisory,
            reasons,
            ...extraData,
        },
        human,
    });
}
/**
 * `th tier veto-check <brief.json>` — MECHANICAL exit-code gate (build plan §3).
 * Hard-fails with exit 3 when any blast-radius flag is present, forbidding Tier
 * 0. Never advisory — this enforces the §5 veto floor.
 */
function runTierVetoCheck(paths, briefPath) {
    if (!briefPath)
        return (0, output_1.failure)({ human: "usage: th tier veto-check <brief.json>" });
    // Anchor: REQ-301, REQ-302 — brownfield hard refusal BEFORE brief-load logic.
    // Covers a MISSING artifact (absent repo-map / codebase-analysis) and a STALE
    // repo-map (drifted from the tree) — both forbid Tier 0 until resolved.
    const prereq = brownfieldPrerequisite(paths);
    if (!prereq.ok) {
        const error = prereq.missing.length > 0 ? "brownfield_prerequisite_missing" : "brownfield_repo_map_stale";
        (0, log_1.structuredLog)({ cmd: "tier veto-check", error, missing: prereq.missing, stale: prereq.stale });
        const lines = ["BLOCKED: brownfield prerequisite(s) unmet — Tier 0 forbidden until resolved:"];
        for (const m of prereq.missing)
            lines.push(`  - missing: ${m}`);
        for (const s of prereq.stale)
            lines.push(`  - stale: ${s} (re-run \`th repo map\` to refresh it)`);
        lines.push("Run `th repo map` and provide docs/00-existing-codebase-analysis.md, then retry.");
        return (0, output_1.failure)({
            exitCode: exports.VETO_EXIT_CODE,
            data: { error, missing: prereq.missing, stale: prereq.stale },
            human: lines.join("\n"),
        });
    }
    // Resolve the brief path against the project root (--cwd), like `th artifact register`.
    const briefFile = (0, paths_1.resolveWithinRoot)(paths.root, briefPath);
    if (briefFile === null) {
        return (0, output_1.failure)({ human: `Brief path outside project root: ${briefPath}`, data: { error: "path_outside_root", file: briefPath } });
    }
    const loaded = (0, brief_1.loadBriefFromFile)(briefFile);
    if (!loaded.ok || !loaded.brief)
        return briefLoadFailure(briefFile, loaded.issues);
    const flags = loaded.brief.blast_radius_flags;
    const blocked = flags.length > 0;
    (0, log_1.structuredLog)({ cmd: "tier veto-check", blocked, flags });
    if (blocked) {
        return (0, output_1.failure)({
            exitCode: exports.VETO_EXIT_CODE,
            data: { blocked: true, flags },
            human: `BLOCKED: blast-radius flag(s) present — Tier 0 forbidden (§5): ${flags.join(", ")}`,
        });
    }
    return (0, output_1.success)({
        data: { blocked: false, flags: [] },
        human: "OK: no blast-radius flag; Tier 0 not vetoed.",
    });
}
/**
 * `th tier record <T>` — typed gate command mirroring the MCP `th_tier_record`
 * tool (#11). Runs `validateTierTransition` (refuses invalid_tier,
 * tier_locked_after_unlock, tier_downgrade_human_only, t0_blast_radius_veto) and,
 * on pass, writes the tier through the shared locked + ledgered `applyGateMutation`
 * (source "th tier record"), which also performs the #1 tier-upgrade stage
 * backfill. The gate-checked path operators should prefer over a raw `th state set
 * tier`.
 */
function runTierRecord(paths, tier) {
    if (!tier)
        return (0, output_1.failure)({ human: "usage: th tier record <T0|T1|T2|T3>" });
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid; fix it before recording a tier:\n${(0, guards_1.formatIssues)(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const check = (0, gate_preconditions_1.validateTierTransition)(r.state, tier);
    if (!check.ok) {
        return (0, output_1.failure)({
            human: `Refusing tier record (${check.error}).`,
            data: { error: check.error, ...(check.detail ?? {}) },
        });
    }
    return (0, state_1.applyGateMutation)(paths, { tier }, "th tier record");
}
