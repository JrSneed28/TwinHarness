"use strict";
/**
 * Pure coverage computation shared by `th coverage check` (the hard gate) and
 * `th coverage report` (the planned/implemented/tested breakdown), plus the
 * run-health audit (`th doctor`) and the next-action oracle (`th next`).
 *
 * REQ-ID traceability arithmetic only (spec §11/§15.8/§15.9): it computes which
 * dimension each requirement is anchored in. It never decides whether a
 * requirement is correct, and it never runs anything (plan §3 boundary rule).
 *
 * The three static dimensions, all derived from durable REQ-ID anchors:
 *   - planned     → the REQ-ID appears in the implementation plan (a slice exists)
 *   - implemented → the REQ-ID is anchored in the code directory (Builder writes
 *                   REQ-ID anchors WITH the implementation — see agents/builder.md)
 *   - tested      → the REQ-ID is anchored in a test file
 *
 * "passing" is intentionally NOT computed here — it requires executing the test
 * suite, which the CLI never does. It is layered on by the coverage-report
 * command from the optional `th verify run` report (and is whole-suite, not
 * per-REQ).
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
exports.readFileOrUndefined = readFileOrUndefined;
exports.extractMvpScopeReqIds = extractMvpScopeReqIds;
exports.collectDirReqIds = collectDirReqIds;
exports.resolveReqSet = resolveReqSet;
exports.computeBreakdown = computeBreakdown;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const anchors_1 = require("./anchors");
/** Read a file as UTF-8, or return undefined if it is absent / not a file. */
function readFileOrUndefined(abs) {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
        return undefined;
    return fs.readFileSync(abs, "utf8");
}
/**
 * Extract REQ-IDs from the `## MVP Scope` section of a scope file. Returns
 * undefined when the heading is absent or the section has no REQ-IDs (the caller
 * then falls back to checking all REQ-IDs). The section runs from the
 * `## MVP Scope` heading (case-insensitive) until the next `## ` heading.
 */
function extractMvpScopeReqIds(scopeContent) {
    const lines = scopeContent.split(/\r?\n/);
    const MVP_HEADING_RE = /^##\s+MVP\s+Scope\b/i;
    const NEXT_H2_RE = /^##\s+/;
    let inSection = false;
    const sectionLines = [];
    for (const line of lines) {
        if (!inSection) {
            if (MVP_HEADING_RE.test(line))
                inSection = true;
        }
        else {
            if (NEXT_H2_RE.test(line))
                break;
            sectionLines.push(line);
        }
    }
    if (!inSection)
        return undefined;
    const ids = (0, anchors_1.extractReqIds)(sectionLines.join("\n"));
    return ids.length > 0 ? ids : undefined;
}
/** Unique union of every REQ-ID referenced by any file under `dir` (full recursion). */
function collectDirReqIds(dir) {
    const scanMap = (0, anchors_1.scanDirForReqIds)(dir);
    return [...scanMap.keys()];
}
/**
 * Resolve the requirement set to check: the intersection of (REQ-IDs in the
 * requirements file) ∩ (REQ-IDs in the `## MVP Scope` section) when a usable MVP
 * filter is present, otherwise all REQ-IDs. Identical semantics to the original
 * `th coverage check` so the gate's behaviour is unchanged.
 */
function resolveReqSet(reqsContent, scopeContent) {
    const allReqIds = (0, anchors_1.extractReqIds)(reqsContent);
    const mvpFilter = scopeContent !== undefined ? extractMvpScopeReqIds(scopeContent) : undefined;
    if (mvpFilter !== undefined && mvpFilter.length > 0) {
        const mvpSet = new Set(mvpFilter);
        const reqSet = allReqIds.filter((id) => mvpSet.has(id));
        if (reqSet.length === 0) {
            return { allReqIds, reqSet: allReqIds, filterDescription: "MVP filter: intersection empty — checking all REQ-IDs" };
        }
        return { allReqIds, reqSet, filterDescription: `MVP filter: applied (${reqSet.length} of ${allReqIds.length} REQ-IDs)` };
    }
    return { allReqIds, reqSet: allReqIds, filterDescription: "MVP filter: none — checking all REQ-IDs" };
}
/**
 * Compute the planned/implemented/tested breakdown for every checked REQ-ID.
 * Resolves all paths relative to `root`. Missing plan/tests/code → those
 * dimensions are simply false (never a crash). Returns a `reqs_file_not_found`
 * sentinel when the requirements file itself is absent.
 */
function computeBreakdown(root, opts = {}) {
    const reqsAbs = path.resolve(root, opts.reqsFile ?? "docs/01-requirements.md");
    const planAbs = path.resolve(root, opts.planFile ?? "docs/09-implementation-plan.md");
    const testsAbs = path.resolve(root, opts.testsDir ?? "tests");
    const scopeAbs = path.resolve(root, opts.scopeFile ?? "docs/02-scope.md");
    const codeAbs = path.resolve(root, opts.codeDir ?? "src");
    const reqsContent = readFileOrUndefined(reqsAbs);
    if (reqsContent === undefined) {
        return { error: "reqs_file_not_found", reqsFile: path.relative(root, reqsAbs).split(path.sep).join("/") };
    }
    const { reqSet, filterDescription } = resolveReqSet(reqsContent, readFileOrUndefined(scopeAbs));
    const planContent = readFileOrUndefined(planAbs);
    const sliceSet = new Set(planContent === undefined ? [] : (0, anchors_1.extractReqIds)(planContent));
    const testSet = new Set(collectDirReqIds(testsAbs));
    const codeSet = new Set(collectDirReqIds(codeAbs));
    const rows = reqSet.map((req) => ({
        req,
        planned: sliceSet.has(req),
        implemented: codeSet.has(req),
        tested: testSet.has(req),
    }));
    return {
        rows,
        total: rows.length,
        planned: rows.filter((r) => r.planned).length,
        implemented: rows.filter((r) => r.implemented).length,
        tested: rows.filter((r) => r.tested).length,
        filterDescription,
    };
}
