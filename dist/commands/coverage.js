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
exports.runCoverageCheck = runCoverageCheck;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const anchors_1 = require("../core/anchors");
const log_1 = require("../core/log");
/** Read a file as UTF-8, or return undefined if it is absent / not a file. */
function readFileOrUndefined(abs) {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
        return undefined;
    return fs.readFileSync(abs, "utf8");
}
/**
 * Extract REQ-IDs from the MVP Scope section of a scope file. If the file
 * lacks an `## MVP Scope` heading (case-insensitive) or the section is empty,
 * returns undefined (caller falls back to no-filter behaviour).
 *
 * The MVP section runs from the `## MVP Scope` heading until the next `## `
 * heading (or end of file).
 */
function extractMvpScopeReqIds(scopeContent) {
    const lines = scopeContent.split(/\r?\n/);
    const MVP_HEADING_RE = /^##\s+MVP\s+Scope\b/i;
    const NEXT_H2_RE = /^##\s+/;
    let inSection = false;
    const sectionLines = [];
    for (const line of lines) {
        if (!inSection) {
            if (MVP_HEADING_RE.test(line)) {
                inSection = true;
            }
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
/**
 * Collect all REQ-IDs referenced by any file in `testsDir` (full recursion,
 * all files, same skip-dirs as scanDirForReqIds). Returns unique union.
 * Missing dir → empty array.
 */
function collectTestReqIds(testsAbs) {
    const scanMap = (0, anchors_1.scanDirForReqIds)(testsAbs);
    const seen = new Set();
    const out = [];
    for (const id of scanMap.keys()) {
        if (!seen.has(id)) {
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}
/**
 * `th coverage check [--reqs F] [--plan F] [--tests D] [--scope F]` — verify
 * that every (MVP) requirement REQ-ID is mapped to at least one slice
 * (implementation plan) and at least one test. Success (exit 0) when there are
 * zero gaps; failure (exit 1) listing each gap otherwise.
 *
 * MVP filtering: if docs/02-scope.md (or `--scope`) exists and contains a
 * `## MVP Scope` heading, the checked requirement set is the intersection of
 * (REQ-IDs in requirements file) ∩ (REQ-IDs in the MVP Scope section). When
 * the filter produces an empty set or the scope file / section is absent,
 * falls back to checking all REQ-IDs.
 */
function runCoverageCheck(paths, opts = {}) {
    const reqsAbs = path.resolve(paths.root, opts.reqsFile ?? "docs/01-requirements.md");
    const planAbs = path.resolve(paths.root, opts.planFile ?? "docs/09-implementation-plan.md");
    const testsAbs = path.resolve(paths.root, opts.testsDir ?? "tests");
    const scopeAbs = path.resolve(paths.root, opts.scopeFile ?? "docs/02-scope.md");
    const reqsContent = readFileOrUndefined(reqsAbs);
    if (reqsContent === undefined) {
        const rel = path.relative(paths.root, reqsAbs).split(path.sep).join("/");
        return (0, output_1.failure)({
            human: `Requirements file not found: ${rel}. Run \`th init\` and author requirements first.`,
            data: { error: "reqs_file_not_found", reqsFile: rel },
        });
    }
    const allReqIds = (0, anchors_1.extractReqIds)(reqsContent);
    // MVP filtering: try to extract the MVP Scope section from the scope file.
    let mvpFilter;
    const scopeContent = readFileOrUndefined(scopeAbs);
    if (scopeContent !== undefined) {
        mvpFilter = extractMvpScopeReqIds(scopeContent);
    }
    let reqSet;
    let filterDescription;
    if (mvpFilter !== undefined && mvpFilter.length > 0) {
        const mvpSet = new Set(mvpFilter);
        reqSet = allReqIds.filter((id) => mvpSet.has(id));
        if (reqSet.length === 0) {
            // Intersection empty → fall back.
            reqSet = allReqIds;
            filterDescription = "MVP filter: intersection empty — checking all REQ-IDs";
        }
        else {
            filterDescription = `MVP filter: applied (${reqSet.length} of ${allReqIds.length} REQ-IDs)`;
        }
    }
    else {
        reqSet = allReqIds;
        filterDescription = "MVP filter: none — checking all REQ-IDs";
    }
    // Missing plan file → empty slice set (everything is a gap), but never crash.
    const planContent = readFileOrUndefined(planAbs);
    const sliceSet = planContent === undefined ? [] : (0, anchors_1.extractReqIds)(planContent);
    // Missing tests dir → empty test set. Full recursion via scanDirForReqIds.
    const testSet = collectTestReqIds(testsAbs);
    const gaps = [];
    for (const req of reqSet) {
        const inSlice = sliceSet.includes(req);
        const inTest = testSet.includes(req);
        if (!inSlice || !inTest)
            gaps.push({ req, inSlice, inTest });
    }
    const total = reqSet.length;
    const covered = total - gaps.length;
    (0, log_1.structuredLog)({ cmd: "coverage check", total, covered, gaps: gaps.length, filter: filterDescription });
    if (gaps.length === 0) {
        return (0, output_1.success)({
            data: { ok: true, total, covered, gaps: [], mvpFilter: filterDescription },
            human: `coverage complete: ${covered}/${total} REQ-IDs mapped to ≥1 slice and ≥1 test\n${filterDescription}`,
        });
    }
    const lines = gaps.map((g) => {
        const missing = [];
        if (!g.inSlice)
            missing.push("no slice");
        if (!g.inTest)
            missing.push("no test");
        return `  - ${g.req}: ${missing.join(", ")}`;
    });
    return (0, output_1.failure)({
        data: { gaps, total, covered, mvpFilter: filterDescription },
        human: `coverage gap: ${covered}/${total} REQ-IDs mapped; ${gaps.length} uncovered:\n${lines.join("\n")}\n${filterDescription}`,
    });
}
