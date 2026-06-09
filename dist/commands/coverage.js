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
/** True if the path looks like a test source file we should scan for REQ-IDs. */
function isTestSource(name) {
    return /\.(test|spec)\.[^.]+$/.test(name) || /\.(ts|js)$/.test(name);
}
/**
 * Collect REQ-IDs referenced by every test source directly under `testsDir`
 * (recursing one level into subdirectories is enough for the MVP layout).
 * Missing dir → empty set.
 */
function collectTestReqIds(testsDir) {
    if (!fs.existsSync(testsDir) || !fs.statSync(testsDir).isDirectory())
        return [];
    const seen = new Set();
    const out = [];
    const addFrom = (abs) => {
        const content = fs.readFileSync(abs, "utf8");
        for (const id of (0, anchors_1.extractReqIds)(content)) {
            if (!seen.has(id)) {
                seen.add(id);
                out.push(id);
            }
        }
    };
    for (const entry of fs.readdirSync(testsDir, { withFileTypes: true })) {
        const abs = path.join(testsDir, entry.name);
        if (entry.isFile() && isTestSource(entry.name)) {
            addFrom(abs);
        }
        else if (entry.isDirectory()) {
            // Recurse one level.
            for (const inner of fs.readdirSync(abs, { withFileTypes: true })) {
                if (inner.isFile() && isTestSource(inner.name))
                    addFrom(path.join(abs, inner.name));
            }
        }
    }
    return out;
}
/**
 * `th coverage check` — verify that every requirement REQ-ID is mapped to at
 * least one slice (implementation plan) and at least one test. Success (exit 0)
 * when there are zero gaps; failure (exit 1) listing each gap otherwise.
 */
function runCoverageCheck(paths, opts = {}) {
    const reqsAbs = path.resolve(paths.root, opts.reqsFile ?? "docs/01-requirements.md");
    const planAbs = path.resolve(paths.root, opts.planFile ?? "docs/09-implementation-plan.md");
    const testsAbs = path.resolve(paths.root, opts.testsDir ?? "tests");
    const reqsContent = readFileOrUndefined(reqsAbs);
    if (reqsContent === undefined) {
        const rel = path.relative(paths.root, reqsAbs).split(path.sep).join("/");
        return (0, output_1.failure)({
            human: `Requirements file not found: ${rel}. Run \`th init\` and author requirements first.`,
            data: { error: "reqs_file_not_found", reqsFile: rel },
        });
    }
    // MVP-filtering via scope is a future refinement; for now the requirement set
    // = all REQ-IDs in the requirements file.
    const reqSet = (0, anchors_1.extractReqIds)(reqsContent);
    // Missing plan file → empty slice set (everything is a gap), but never crash.
    const planContent = readFileOrUndefined(planAbs);
    const sliceSet = planContent === undefined ? [] : (0, anchors_1.extractReqIds)(planContent);
    // Missing tests dir → empty test set.
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
    (0, log_1.structuredLog)({ cmd: "coverage check", total, covered, gaps: gaps.length });
    if (gaps.length === 0) {
        return (0, output_1.success)({
            data: { ok: true, total, covered, gaps: [] },
            human: `coverage complete: ${covered}/${total} REQ-IDs mapped to ≥1 slice and ≥1 test`,
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
        data: { gaps, total, covered },
        human: `coverage gap: ${covered}/${total} REQ-IDs mapped; ${gaps.length} uncovered:\n${lines.join("\n")}`,
    });
}
