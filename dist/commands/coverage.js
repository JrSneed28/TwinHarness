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
exports.runCoverageReport = runCoverageReport;
const path = __importStar(require("node:path"));
const paths_1 = require("../core/paths");
const output_1 = require("../core/output");
const anchors_1 = require("../core/anchors");
const coverage_1 = require("../core/coverage");
const verify_1 = require("../core/verify");
const log_1 = require("../core/log");
/** Validate that every supplied path override stays within the project root. */
function rejectEscapingPath(paths, opts) {
    const fields = [
        ["reqsFile", opts.reqsFile],
        ["planFile", opts.planFile],
        ["testsDir", opts.testsDir],
        ["scopeFile", opts.scopeFile],
        ["codeDir", opts.codeDir],
    ];
    for (const [, value] of fields) {
        if (value !== undefined && (0, paths_1.resolveWithinRoot)(paths.root, value) === null) {
            return (0, output_1.failure)({ human: `Path outside project root: ${value}`, data: { error: "path_outside_root", file: value } });
        }
    }
    return undefined;
}
/**
 * `th coverage check [--reqs F] [--plan F] [--tests D] [--scope F]` — verify
 * that every (MVP) requirement REQ-ID is mapped to at least one slice
 * (implementation plan) and at least one test. Success (exit 0) when there are
 * zero gaps; failure (exit 1) listing each gap otherwise.
 */
function runCoverageCheck(paths, opts = {}) {
    const escaped = rejectEscapingPath(paths, opts);
    if (escaped)
        return escaped;
    const reqsAbs = path.resolve(paths.root, opts.reqsFile ?? "docs/01-requirements.md");
    const planAbs = path.resolve(paths.root, opts.planFile ?? "docs/09-implementation-plan.md");
    const testsAbs = path.resolve(paths.root, opts.testsDir ?? "tests");
    const scopeAbs = path.resolve(paths.root, opts.scopeFile ?? "docs/02-scope.md");
    const reqsContent = (0, coverage_1.readFileOrUndefined)(reqsAbs);
    if (reqsContent === undefined) {
        const rel = path.relative(paths.root, reqsAbs).split(path.sep).join("/");
        return (0, output_1.failure)({
            human: `Requirements file not found: ${rel}. Run \`th init\` and author requirements first.`,
            data: { error: "reqs_file_not_found", reqsFile: rel },
        });
    }
    const { allReqIds, reqSet, filterDescription } = (0, coverage_1.resolveReqSet)(reqsContent, (0, coverage_1.readFileOrUndefined)(scopeAbs));
    void allReqIds;
    const planContent = (0, coverage_1.readFileOrUndefined)(planAbs);
    const sliceSet = planContent === undefined ? [] : (0, anchors_1.extractReqIds)(planContent);
    // TEST dimension counts only RECOGNIZED test files (GOV-1): an anchor in a
    // prose/fixture file under tests/ no longer satisfies the gate.
    const testSet = (0, coverage_1.collectTestReqIds)(testsAbs);
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
/**
 * `th coverage report [--reqs F] [--plan F] [--tests D] [--scope F] [--code D]`
 * — the planned / implemented / tested / passing breakdown for every checked
 * REQ-ID (read-only; never a gate). Always exits 0 when the requirements file is
 * present — it is a status view, not the hard gate (`th coverage check`).
 *
 *   planned     → REQ-ID is in the implementation plan (a slice exists)
 *   implemented → REQ-ID is anchored in the code dir (default src)
 *   tested      → REQ-ID is anchored in a test file
 *   passing     → tested AND the last `th verify run` reported a green suite
 *                 (whole-suite signal; "—" when no verify report exists)
 */
function runCoverageReport(paths, opts = {}) {
    const escaped = rejectEscapingPath(paths, opts);
    if (escaped)
        return escaped;
    const breakdown = (0, coverage_1.computeBreakdown)(paths.root, opts);
    if ("error" in breakdown) {
        return (0, output_1.failure)({
            human: `Requirements file not found: ${breakdown.reqsFile}. Run \`th init\` and author requirements first.`,
            data: { error: breakdown.error, reqsFile: breakdown.reqsFile },
        });
    }
    const report = (0, verify_1.readVerifyReport)(paths);
    const suitePassing = report ? report.ok : null;
    const passingCount = suitePassing === null ? null : breakdown.rows.filter((r) => r.tested && suitePassing).length;
    (0, log_1.structuredLog)({
        cmd: "coverage report",
        total: breakdown.total,
        planned: breakdown.planned,
        implemented: breakdown.implemented,
        tested: breakdown.tested,
        passing: passingCount,
    });
    const cell = (b) => (b ? "✓" : "·");
    const passCell = (tested) => (suitePassing === null ? "—" : tested && suitePassing ? "✓" : "·");
    const rows = breakdown.rows.map((r) => `  ${r.req.padEnd(16)} ${cell(r.planned)} planned  ${cell(r.implemented)} implemented  ${cell(r.tested)} tested  ${passCell(r.tested)} passing`);
    const passingSummary = passingCount === null ? "— (no verify report — run `th verify run`)" : `${passingCount}/${breakdown.total}`;
    const human = [
        `Coverage breakdown — ${breakdown.total} REQ-ID(s) checked`,
        `  planned:     ${breakdown.planned}/${breakdown.total}`,
        `  implemented: ${breakdown.implemented}/${breakdown.total}`,
        `  tested:      ${breakdown.tested}/${breakdown.total}`,
        `  passing:     ${passingSummary}`,
        breakdown.filterDescription,
        "",
        ...(rows.length ? rows : ["  (no REQ-IDs found)"]),
    ].join("\n");
    return (0, output_1.success)({
        data: {
            total: breakdown.total,
            planned: breakdown.planned,
            implemented: breakdown.implemented,
            tested: breakdown.tested,
            passing: passingCount,
            suitePassing,
            rows: breakdown.rows,
            mvpFilter: breakdown.filterDescription,
        },
        human,
    });
}
