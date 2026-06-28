"use strict";
/**
 * context-equivalence.ts — S7 equivalence harness (D-21 / AC-11).
 *
 * Tiered comparator over 7 dimensions:
 *   tests | types | build | gate+approval | requirement-coverage |
 *   side-effects | blast-radius
 *
 * `runEquivalence(baselineRun, contextRun): EquivalenceVerdict` — pure
 * comparison; reads run artifacts, produces a verdict. No suppression
 * side-effects; NO surface-file edits (T8 wires the CLI/MCP ops).
 *
 * Corpus structure: `.twinharness/context-pages/corpus/<category>/` tagged
 * by the 5 workload categories (D-21).
 *
 * Promotion gate: `isPromotionReady(verdicts): boolean` — true after
 * N = PROMOTION_CLEAN_RUNS consecutive zero-divergence verdicts (AC-11).
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
exports.PROMOTION_CLEAN_RUNS = exports.EQUIVALENCE_DIMENSIONS = exports.WORKLOAD_CATEGORIES = void 0;
exports.isPromotionReady = isPromotionReady;
exports.corpusRoot = corpusRoot;
exports.corpusCategoryDir = corpusCategoryDir;
exports.writeCorpusEntry = writeCorpusEntry;
exports.readCorpusEntry = readCorpusEntry;
exports.listCorpusEntries = listCorpusEntries;
exports.runEquivalence = runEquivalence;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const context_page_1 = require("./context-page");
exports.WORKLOAD_CATEGORIES = [
    "read",
    "bash",
    "test",
    "mcp",
    "planning",
];
exports.EQUIVALENCE_DIMENSIONS = [
    "tests",
    "types",
    "build",
    "gate+approval",
    "requirement-coverage",
    "side-effects",
    "blast-radius",
];
// ---------------------------------------------------------------------------
// Promotion gate
// ---------------------------------------------------------------------------
/** Number of consecutive zero-divergence runs required to promote. */
exports.PROMOTION_CLEAN_RUNS = 10;
/**
 * Returns true when the supplied list of verdicts contains at least
 * PROMOTION_CLEAN_RUNS consecutive clean verdicts at the tail.
 * Pure; no I/O.
 */
function isPromotionReady(verdicts) {
    if (verdicts.length < exports.PROMOTION_CLEAN_RUNS)
        return false;
    const tail = verdicts.slice(-exports.PROMOTION_CLEAN_RUNS);
    return tail.every((v) => v.clean);
}
// ---------------------------------------------------------------------------
// Corpus helpers
// ---------------------------------------------------------------------------
/**
 * Absolute path for the corpus root under the context-pages tree.
 *   .twinharness/context-pages/corpus/
 */
function corpusRoot(paths) {
    return path.join((0, context_page_1.contextPagesRoot)(paths), "corpus");
}
/**
 * Absolute path for the corpus sub-directory of a workload category.
 *   .twinharness/context-pages/corpus/<category>/
 */
function corpusCategoryDir(paths, category) {
    return path.join(corpusRoot(paths), category);
}
/**
 * Persist a RunArtifact to the corpus.  File name: `<session_id>.json`.
 * Creates directories as needed.  Never throws (returns false on error).
 */
function writeCorpusEntry(paths, artifact) {
    try {
        const dir = corpusCategoryDir(paths, artifact.workload_category);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${artifact.session_id}.json`);
        fs.writeFileSync(file, JSON.stringify(artifact, null, 2), "utf8");
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Read a RunArtifact from the corpus by session ID and category.
 * Returns undefined on any error or when absent.
 */
function readCorpusEntry(paths, category, sessionId) {
    try {
        const file = path.join(corpusCategoryDir(paths, category), `${sessionId}.json`);
        if (!fs.existsSync(file))
            return undefined;
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return undefined;
    }
}
/**
 * List all run artifacts for a category, sorted by ts ascending.
 * Returns [] on any error.
 */
function listCorpusEntries(paths, category) {
    try {
        const dir = corpusCategoryDir(paths, category);
        if (!fs.existsSync(dir))
            return [];
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
        const entries = [];
        for (const f of files) {
            try {
                const entry = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
                entries.push(entry);
            }
            catch {
                // skip malformed entries
            }
        }
        return entries.sort((a, b) => a.ts.localeCompare(b.ts));
    }
    catch {
        return [];
    }
}
// ---------------------------------------------------------------------------
// Per-dimension comparison logic (pure)
// ---------------------------------------------------------------------------
function compareTests(baseline, context) {
    const dim = "tests";
    const b = baseline.test;
    const c = context.test;
    if (b === undefined && c === undefined)
        return { dimension: dim, diverged: false };
    if (b === undefined || c === undefined) {
        return { dimension: dim, diverged: true, reason: "one run missing test outcome" };
    }
    if (b.passed !== c.passed || b.failed !== c.failed || b.skipped !== c.skipped) {
        return {
            dimension: dim,
            diverged: true,
            reason: `counts differ: baseline(p=${b.passed},f=${b.failed},s=${b.skipped}) ctx(p=${c.passed},f=${c.failed},s=${c.skipped})`,
        };
    }
    // Compare failed test names when available
    const bNames = [...(b.failedNames ?? [])].sort().join("|");
    const cNames = [...(c.failedNames ?? [])].sort().join("|");
    if (bNames !== cNames) {
        return { dimension: dim, diverged: true, reason: "failed test names differ" };
    }
    return { dimension: dim, diverged: false };
}
function compareTypes(baseline, context) {
    const dim = "types";
    const b = baseline.types;
    const c = context.types;
    if (b === undefined && c === undefined)
        return { dimension: dim, diverged: false };
    if (b === undefined || c === undefined) {
        return { dimension: dim, diverged: true, reason: "one run missing types outcome" };
    }
    if (b.errorCount !== c.errorCount) {
        return {
            dimension: dim,
            diverged: true,
            reason: `errorCount differs: baseline=${b.errorCount} ctx=${c.errorCount}`,
        };
    }
    return { dimension: dim, diverged: false };
}
function compareBuild(baseline, context) {
    const dim = "build";
    const b = baseline.build;
    const c = context.build;
    if (b === undefined && c === undefined)
        return { dimension: dim, diverged: false };
    if (b === undefined || c === undefined) {
        return { dimension: dim, diverged: true, reason: "one run missing build outcome" };
    }
    if (b.success !== c.success) {
        return {
            dimension: dim,
            diverged: true,
            reason: `success differs: baseline=${b.success} ctx=${c.success}`,
        };
    }
    // Compare artifact hashes when both provide them
    if (b.artifactHashes !== undefined && c.artifactHashes !== undefined) {
        const bSig = JSON.stringify(sortedRecord(b.artifactHashes));
        const cSig = JSON.stringify(sortedRecord(c.artifactHashes));
        if (bSig !== cSig) {
            return { dimension: dim, diverged: true, reason: "artifact hashes differ" };
        }
    }
    return { dimension: dim, diverged: false };
}
function compareGate(baseline, context) {
    const dim = "gate+approval";
    const b = baseline.gate;
    const c = context.gate;
    if (b === undefined && c === undefined)
        return { dimension: dim, diverged: false };
    if (b === undefined || c === undefined) {
        return { dimension: dim, diverged: true, reason: "one run missing gate outcome" };
    }
    const bSig = sortedSig(b.gatesPassed, b.gatesFailed, b.approvalsGranted);
    const cSig = sortedSig(c.gatesPassed, c.gatesFailed, c.approvalsGranted);
    if (bSig !== cSig) {
        return { dimension: dim, diverged: true, reason: "gate/approval state differs" };
    }
    return { dimension: dim, diverged: false };
}
function compareRequirements(baseline, context) {
    const dim = "requirement-coverage";
    const b = baseline.requirements;
    const c = context.requirements;
    if (b === undefined && c === undefined)
        return { dimension: dim, diverged: false };
    if (b === undefined || c === undefined) {
        return { dimension: dim, diverged: true, reason: "one run missing requirement coverage" };
    }
    const bCov = [...b.covered].sort().join(",");
    const cCov = [...c.covered].sort().join(",");
    if (bCov !== cCov) {
        return { dimension: dim, diverged: true, reason: "covered requirements differ" };
    }
    return { dimension: dim, diverged: false };
}
function compareSideEffects(baseline, context) {
    const dim = "side-effects";
    const b = baseline.side_effects;
    const c = context.side_effects;
    if ((b === undefined || b.length === 0) && (c === undefined || c.length === 0)) {
        return { dimension: dim, diverged: false };
    }
    if (b === undefined || c === undefined) {
        return { dimension: dim, diverged: true, reason: "one run missing side-effects" };
    }
    const bSig = b.map((e) => `${e.kind}:${e.description}`).sort().join("|");
    const cSig = c.map((e) => `${e.kind}:${e.description}`).sort().join("|");
    if (bSig !== cSig) {
        return { dimension: dim, diverged: true, reason: "side-effects differ" };
    }
    return { dimension: dim, diverged: false };
}
function compareBlastRadius(baseline, context) {
    const dim = "blast-radius";
    const b = baseline.blast_radius;
    const c = context.blast_radius;
    if (b === undefined && c === undefined)
        return { dimension: dim, diverged: false };
    if (b === undefined || c === undefined) {
        return { dimension: dim, diverged: true, reason: "one run missing blast-radius" };
    }
    const bSig = [...b.flags].sort().join(",") + "|" + [...b.affectedPaths].sort().join(",");
    const cSig = [...c.flags].sort().join(",") + "|" + [...c.affectedPaths].sort().join(",");
    if (bSig !== cSig) {
        return { dimension: dim, diverged: true, reason: "blast-radius differs" };
    }
    return { dimension: dim, diverged: false };
}
// ---------------------------------------------------------------------------
// Reduction report helper
// ---------------------------------------------------------------------------
function computeReduction(baseline, context) {
    const b = baseline.token_usage;
    const c = context.token_usage;
    if (b === undefined || c === undefined)
        return undefined;
    const savedTokens = b.returnedTokens - c.returnedTokens;
    const savingsPercent = b.returnedTokens > 0
        ? Math.round((savedTokens / b.returnedTokens) * 1000) / 10
        : 0;
    return {
        baselineOrigTokens: b.origTokens,
        contextOrigTokens: c.origTokens,
        baselineReturnedTokens: b.returnedTokens,
        contextReturnedTokens: c.returnedTokens,
        savedTokens,
        savingsPercent,
    };
}
// ---------------------------------------------------------------------------
// Pure utility helpers
// ---------------------------------------------------------------------------
function sortedRecord(r) {
    const out = {};
    for (const k of Object.keys(r).sort())
        out[k] = r[k];
    return out;
}
function sortedSig(...arrays) {
    return arrays.map((a) => [...a].sort().join(",")).join("|");
}
// ---------------------------------------------------------------------------
// runEquivalence — main entry point (AC-11)
// ---------------------------------------------------------------------------
/**
 * Pure tiered comparator over 7 dimensions.
 *
 * `baselineRun` — the run with the context-pages mechanism OFF (shadow).
 * `contextRun`  — the run with the context-pages mechanism OBSERVE+recording.
 *
 * Returns a verdict that is clean only when ALL dimensions show zero
 * divergence (AC-11).  Token reduction is reported when both runs supply
 * `token_usage`.  Never throws.
 */
function runEquivalence(baselineRun, contextRun) {
    try {
        const dimensions = [
            compareTests(baselineRun, contextRun),
            compareTypes(baselineRun, contextRun),
            compareBuild(baselineRun, contextRun),
            compareGate(baselineRun, contextRun),
            compareRequirements(baselineRun, contextRun),
            compareSideEffects(baselineRun, contextRun),
            compareBlastRadius(baselineRun, contextRun),
        ];
        const clean = dimensions.every((d) => !d.diverged);
        const reduction = computeReduction(baselineRun, contextRun);
        return { clean, dimensions, reduction, ts: new Date().toISOString() };
    }
    catch {
        // Fail-safe: return diverged verdict rather than throw
        return {
            clean: false,
            dimensions: exports.EQUIVALENCE_DIMENSIONS.map((dim) => ({
                dimension: dim,
                diverged: true,
                reason: "equivalence check error",
            })),
            ts: new Date().toISOString(),
        };
    }
}
