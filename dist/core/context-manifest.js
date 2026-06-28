"use strict";
/**
 * context-manifest.ts — Stage dependency manifests (S4; D-03).
 *
 * A StageManifest at `.twinharness/context-manifests/<tier>/<stage>.json`
 * declares which context pages are pinned, upstream, optional, excluded,
 * which sections an artifact provides, and which critic evidence is required.
 *
 * ADVISORY only: when a manifest is absent or malformed, all callers MUST
 * treat it as a passthrough — behavior unchanged, never throws, never blocks.
 * A later promotion (N=10 clean equivalence runs) may make manifests
 * authoritative; that is explicitly out of scope for this run.
 *
 * Key dependencies (reused, not reinvented):
 *   ProjectPaths  ← src/core/paths.ts
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
exports.INSPECTOR_MANIFEST_PACK = exports.DEBUGGER_MANIFEST_PACK = exports.BUILDER_MANIFEST_PACK = exports.CRITIC_MANIFEST_PACK = void 0;
exports.manifestFilePath = manifestFilePath;
exports.loadManifest = loadManifest;
exports.validateManifest = validateManifest;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
// ---------------------------------------------------------------------------
// Advisory default
// ---------------------------------------------------------------------------
/**
 * Advisory default: returned by {@link loadManifest} when the manifest file
 * is absent or malformed. All fields are empty / zero — callers that receive
 * this default produce behaviour identical to having no manifest at all.
 *
 * Not exported because the advisory contract is surfaced through the
 * {@link ManifestLoadResult} fields (`found`, `valid`); callers never branch
 * on the default's content, they branch on `valid`.
 */
const ADVISORY_DEFAULT = {
    pinned: [],
    upstream: [],
    optional: [],
    excluded: [],
    sections: { artifact: [] },
    selectors: [],
    critic_evidence: [],
    max_budget: 0,
};
// ---------------------------------------------------------------------------
// Well-known agent packs (preset manifests)
// ---------------------------------------------------------------------------
/**
 * Critic pack — pinned context the Critic requires for a coherence review.
 * Covers the mandatory upstream artifacts and the evidence signals each
 * grounded defect must supply.
 */
exports.CRITIC_MANIFEST_PACK = {
    pinned: ["requirements", "scope", "domain-model"],
    upstream: ["architecture", "contracts", "test-strategy"],
    optional: ["adr", "technical-design", "security", "failure-modes"],
    excluded: [],
    sections: { artifact: ["Summary", "Findings", "Risks", "Open questions"] },
    selectors: [],
    critic_evidence: ["grounded-defect", "upstream-summary"],
    max_budget: 4000,
};
/**
 * Builder pack — context the Builder needs to implement a slice task.
 * Intentionally lean; full artifacts fetched on demand only (§9).
 */
exports.BUILDER_MANIFEST_PACK = {
    pinned: ["slice-plan", "contracts"],
    upstream: ["architecture", "domain-model", "test-strategy"],
    optional: ["adr", "technical-design"],
    excluded: [],
    sections: { artifact: ["Summary", "Tasks", "Acceptance criteria"] },
    selectors: [],
    critic_evidence: [],
    max_budget: 3000,
};
/**
 * Debugger pack — context the Debugger needs for an evidence-first defect trace.
 * Emphasises contract anchors and reproduction evidence over narrative artifacts.
 */
exports.DEBUGGER_MANIFEST_PACK = {
    pinned: ["requirements", "contracts"],
    upstream: ["slice-plan", "test-strategy"],
    optional: ["domain-model", "architecture"],
    excluded: [],
    sections: { artifact: ["Summary", "Root cause", "Reproduction", "Minimal fix"] },
    selectors: [],
    critic_evidence: ["file-line-anchor", "captured-output"],
    max_budget: 2500,
};
/**
 * Codebase-Inspector pack — context needed for a brownfield ground-truth scan.
 * Requires no pinned upstream artifacts (the Inspector IS the first fact-gather).
 */
exports.INSPECTOR_MANIFEST_PACK = {
    pinned: [],
    upstream: [],
    optional: ["requirements"],
    excluded: [],
    sections: { artifact: ["Summary", "Module map", "Blast-radius inventory", "Adoption seams"] },
    selectors: [],
    critic_evidence: [],
    max_budget: 3000,
};
// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
/**
 * Absolute path of a manifest file:
 * `<stateDir>/context-manifests/<tier>/<stage>.json`.
 */
function manifestFilePath(paths, tier, stage) {
    return path.join(paths.stateDir, "context-manifests", tier, `${stage}.json`);
}
/**
 * Load the stage manifest for `<tier>/<stage>` from disk.
 *
 * ADVISORY contract (D-03):
 *   - File absent        → `{found:false, valid:false}` + advisory default.
 *   - Invalid JSON       → `{found:true,  valid:false, reason}` + advisory default.
 *   - Schema violation   → `{found:true,  valid:false, reason}` + advisory default.
 *   - Well-formed        → `{found:true,  valid:true,  manifest}`.
 *
 * Never throws. Callers must treat any non-valid result as passthrough — the
 * default is all-empty / zero, ensuring no behaviour change on the absent path.
 */
function loadManifest(paths, tier, stage) {
    const filePath = manifestFilePath(paths, tier, stage);
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf8");
    }
    catch {
        // Absent or unreadable — advisory default, passthrough.
        return { manifest: { ...ADVISORY_DEFAULT, sections: { artifact: [] } }, found: false, valid: false };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return {
            manifest: { ...ADVISORY_DEFAULT, sections: { artifact: [] } },
            found: true,
            valid: false,
            reason: "manifest is not valid JSON",
        };
    }
    const result = validateManifest(parsed);
    if (!result.ok) {
        return {
            manifest: { ...ADVISORY_DEFAULT, sections: { artifact: [] } },
            found: true,
            valid: false,
            reason: result.reason,
        };
    }
    return { manifest: result.manifest, found: true, valid: true };
}
/**
 * Validate that `raw` conforms to the {@link StageManifest} schema.
 *
 * Permissive on extra fields; strict on required shapes. Each field that is
 * absent defaults to the empty / zero value rather than being an error — the
 * only failures are wrong TYPES (non-array, non-string element, non-number
 * budget). Does not access the filesystem.
 */
function validateManifest(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, reason: "manifest must be a JSON object" };
    }
    const obj = raw;
    const pinned = coerceStringArray(obj["pinned"]);
    if (pinned === null)
        return { ok: false, reason: '"pinned" must be an array of strings' };
    const upstream = coerceStringArray(obj["upstream"]);
    if (upstream === null)
        return { ok: false, reason: '"upstream" must be an array of strings' };
    const optional = coerceStringArray(obj["optional"]);
    if (optional === null)
        return { ok: false, reason: '"optional" must be an array of strings' };
    const excluded = coerceStringArray(obj["excluded"]);
    if (excluded === null)
        return { ok: false, reason: '"excluded" must be an array of strings' };
    const selectors = coerceStringArray(obj["selectors"]);
    if (selectors === null)
        return { ok: false, reason: '"selectors" must be an array of strings' };
    const critic_evidence = coerceStringArray(obj["critic_evidence"]);
    if (critic_evidence === null)
        return { ok: false, reason: '"critic_evidence" must be an array of strings' };
    // sections: optional object; sections.artifact defaults to []
    const sectionsRaw = obj["sections"];
    let sections;
    if (sectionsRaw === undefined || sectionsRaw === null) {
        sections = { artifact: [] };
    }
    else if (typeof sectionsRaw !== "object" || Array.isArray(sectionsRaw)) {
        return { ok: false, reason: '"sections" must be an object' };
    }
    else {
        const artifact = coerceStringArray(sectionsRaw["artifact"]);
        if (artifact === null)
            return { ok: false, reason: '"sections.artifact" must be an array of strings' };
        sections = { artifact };
    }
    // max_budget: non-negative finite number; defaults to 0 when absent
    const budgetRaw = obj["max_budget"];
    let max_budget;
    if (budgetRaw === undefined || budgetRaw === null) {
        max_budget = 0;
    }
    else if (typeof budgetRaw !== "number" ||
        !Number.isFinite(budgetRaw) ||
        budgetRaw < 0) {
        return { ok: false, reason: '"max_budget" must be a non-negative finite number' };
    }
    else {
        max_budget = budgetRaw;
    }
    return {
        ok: true,
        manifest: { pinned, upstream, optional, excluded, sections, selectors, critic_evidence, max_budget },
    };
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Coerce `val` to `string[]`.
 *   - `undefined` → `[]`   (field absent, use the empty default).
 *   - non-array or array-with-non-string-element → `null` (type mismatch).
 */
function coerceStringArray(val) {
    if (val === undefined)
        return [];
    if (!Array.isArray(val))
        return null;
    for (const item of val) {
        if (typeof item !== "string")
            return null;
    }
    return val;
}
