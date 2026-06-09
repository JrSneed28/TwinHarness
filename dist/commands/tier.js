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
exports.VETO_EXIT_CODE = void 0;
exports.runTierClassify = runTierClassify;
exports.runTierVetoCheck = runTierVetoCheck;
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const brief_1 = require("../core/brief");
const log_1 = require("../core/log");
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
function formatIssues(issues) {
    return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}
function briefLoadFailure(briefPath, issues) {
    return (0, output_1.failure)({
        human: `Could not load brief "${briefPath}":\n${formatIssues(issues)}`,
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
    const briefFile = path.isAbsolute(briefPath) ? briefPath : path.join(paths.root, briefPath);
    const loaded = (0, brief_1.loadBriefFromFile)(briefFile);
    if (!loaded.ok || !loaded.brief)
        return briefLoadFailure(briefFile, loaded.issues);
    const { tier0_eligible, blocked_by_veto, reasons } = classifyBrief(loaded.brief);
    const advisory = tier0_eligible ? "T0" : "≥T1";
    (0, log_1.structuredLog)({ cmd: "tier classify", advisory, blocked_by_veto });
    const human = tier0_eligible
        ? "Advisory: T0 — all five Tier-0 conditions hold and no blast-radius flag is present."
        : `Advisory: ≥T1 — Tier 0 not eligible:\n${reasons.map((r) => `  - ${r}`).join("\n")}`;
    return (0, output_1.success)({
        data: {
            tier0_eligible,
            blocked_by_veto,
            blast_radius_flags: loaded.brief.blast_radius_flags,
            advisory,
            reasons,
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
    // Resolve the brief path against the project root (--cwd), like `th artifact register`.
    const briefFile = path.isAbsolute(briefPath) ? briefPath : path.join(paths.root, briefPath);
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
