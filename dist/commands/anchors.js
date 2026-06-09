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
exports.runAnchorsScan = runAnchorsScan;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const anchors_1 = require("../core/anchors");
const log_1 = require("../core/log");
const DEFAULT_DIRS = {
    requirements: "docs",
    tests: "tests",
    code: "src",
};
/** Turn a `Map<string, string[]>` (insertion-ordered) into a plain record. */
function toRecord(m) {
    const out = {};
    for (const [req, files] of m)
        out[req] = files;
    return out;
}
/**
 * The DEFINED requirement set = REQ-IDs in `docs/01-requirements.md` if present,
 * else every REQ-ID anywhere under `docs/`. Returned as a Set for membership tests.
 */
function definedRequirementSet(paths) {
    const reqsFile = path.join(paths.docsDir, "01-requirements.md");
    if (fs.existsSync(reqsFile) && fs.statSync(reqsFile).isFile()) {
        return new Set((0, anchors_1.extractReqIds)(fs.readFileSync(reqsFile, "utf8")));
    }
    const ids = new Set();
    for (const id of (0, anchors_1.scanDirForReqIds)(paths.docsDir).keys())
        ids.add(id);
    return ids;
}
/**
 * `th anchors scan` — scan the selected categories for REQ-ID anchors and detect
 * orphans. If none of reqs/tests/code is requested, all three are scanned.
 * Exit 0 normally; with `strict` and a non-empty orphan list → failure (exit 1).
 */
function runAnchorsScan(paths, opts = {}) {
    // Default: scan all three when no category flag is given.
    const anySelected = !!(opts.reqs || opts.tests || opts.code);
    const scanReqs = anySelected ? !!opts.reqs : true;
    const scanTests = anySelected ? !!opts.tests : true;
    const scanCode = anySelected ? !!opts.code : true;
    const data = { orphans: [] };
    let requirementsMap;
    let testsMap;
    let codeMap;
    if (scanReqs) {
        requirementsMap = (0, anchors_1.scanDirForReqIds)(path.join(paths.root, DEFAULT_DIRS.requirements));
        data.requirements = toRecord(requirementsMap);
    }
    if (scanTests) {
        testsMap = (0, anchors_1.scanDirForReqIds)(path.join(paths.root, DEFAULT_DIRS.tests));
        data.tests = toRecord(testsMap);
    }
    if (scanCode) {
        codeMap = (0, anchors_1.scanDirForReqIds)(path.join(paths.root, DEFAULT_DIRS.code));
        data.code = toRecord(codeMap);
    }
    // Orphan detection: REQ anchors in tests/ or src/ that are NOT in the defined
    // requirement set. (Requirements themselves can never be orphans.)
    const defined = definedRequirementSet(paths);
    const orphans = [];
    const recordOrphans = (m, label) => {
        if (!m)
            return;
        for (const [req, files] of m) {
            if (defined.has(req))
                continue;
            for (const file of files)
                orphans.push({ req, where: `${label}/${file}` });
        }
    };
    recordOrphans(testsMap, "tests");
    recordOrphans(codeMap, "code");
    data.orphans = orphans;
    // Human: compact per-category counts + orphan list.
    const countLines = [];
    if (data.requirements)
        countLines.push(`requirements: ${Object.keys(data.requirements).length} REQ-ID(s)`);
    if (data.tests)
        countLines.push(`tests:        ${Object.keys(data.tests).length} REQ-ID(s)`);
    if (data.code)
        countLines.push(`code:         ${Object.keys(data.code).length} REQ-ID(s)`);
    const orphanLines = orphans.length
        ? ["orphans:", ...orphans.map((o) => `  - ${o.req} (${o.where})`)]
        : ["orphans: (none)"];
    const human = [...countLines, ...orphanLines].join("\n");
    (0, log_1.structuredLog)({ cmd: "anchors scan", scanned: { reqs: scanReqs, tests: scanTests, code: scanCode }, orphans: orphans.length });
    if (opts.strict && orphans.length > 0) {
        return (0, output_1.failure)({
            data,
            human: `${human}\n\n${orphans.length} orphan anchor(s) (--strict).`,
        });
    }
    return (0, output_1.success)({ data, human });
}
