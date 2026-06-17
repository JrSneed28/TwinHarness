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
exports.isRecognizedTestFile = isRecognizedTestFile;
exports.collectTestReqIds = collectTestReqIds;
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
 * Recognize a RECOGNIZED test file by its (forward-slash) path relative to the
 * scanned root: a `*.test.*` / `*.spec.*` file name, OR any file located under a
 * conventional test directory (`tests/`, `test/`, `__tests__/`, `spec/`,
 * `specs/`) at any depth — including the scan root itself when it IS that dir.
 *
 * Anchor: REQ-COV-TESTONLY-001 (GOV-1) — the TEST dimension of `th coverage
 * check` must count only anchors in REAL test files. Before this, ANY file under
 * the tests dir (a README, a fixture data file, prose) made a REQ-ID count as
 * "tested", so the gate was satisfiable with no executable test. The path is
 * relative to the tests root, so a bare `foo.test.ts` (rel = `foo.test.ts`) is
 * recognized by name and a `helpers/data.json` (rel = `helpers/data.json`) is
 * NOT — unless its segment is itself a test dir.
 *
 * ACCEPTED GOV-1 RESIDUALS (finding #4 / ADR-005 — documented, not tightened):
 *   (a) The path rule matches a test-dir SEGMENT at ANY depth, so a prose/fixture
 *       file under a NESTED test-named subdir (e.g. `helpers/tests/data.json`)
 *       still counts as "tested". Tightening to require a test-NAME match would
 *       UNDER-count legitimate tests that live under `tests/` without a `.test.`
 *       name, so the path rule is kept deliberately (a false-positive is the safe
 *       direction here — it never HIDES a real gap, it only over-credits a fixture
 *       that already sits in a test dir the author chose).
 *   (b) A `*.test.d.ts` / `*.spec.d.ts` TYPE-DECLARATION file is NOT recognized by
 *       NAME (the trailing `.d.ts` defeats `\.(test|spec)\.[^./]+$`). That is
 *       CORRECT, not a gap: a declaration file carries no runtime assertions, so it
 *       cannot evidence a REQ. (It still counts via the path rule if it lives under
 *       a test dir — same residual as (a).)
 * Both are PINNED by a table test (coverage.test.ts) so any future change is a
 * deliberate decision, not an accidental drift.
 */
function isRecognizedTestFile(relPosixPath) {
    const lower = relPosixPath.toLowerCase();
    const base = lower.split("/").pop() ?? lower;
    // Name-based: foo.test.ts, foo.spec.tsx, foo.test.py, …
    if (/\.(test|spec)\.[^./]+$/.test(base))
        return true;
    // go-style foo_test.go and python test_foo.py also count as real tests.
    if (/_test\.[^./]+$/.test(base))
        return true;
    if (/^test_[^/]*\.[^./]+$/.test(base))
        return true;
    // Path-based: anywhere under a conventional test directory segment.
    if (/(^|\/)(tests?|__tests__|specs?)(\/|$)/.test(lower))
        return true;
    return false;
}
/**
 * TEST-dimension collector (GOV-1): like {@link collectDirReqIds} but counts a
 * REQ-ID only when it is anchored in at least one RECOGNIZED test file (see
 * {@link isRecognizedTestFile}). An anchor that appears ONLY in a prose / fixture
 * / non-test file under the tests dir does NOT count as tested. The
 * requirement/implementation dimensions keep using the unrestricted
 * {@link collectDirReqIds}.
 */
function collectTestReqIds(dir) {
    const scanMap = (0, anchors_1.scanDirForReqIds)(dir);
    const out = [];
    for (const [reqId, files] of scanMap) {
        if (files.some(isRecognizedTestFile))
            out.push(reqId);
    }
    return out;
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
    // TEST dimension counts only RECOGNIZED test files (GOV-1); the implementation
    // dimension scans the whole code dir unchanged.
    const testSet = new Set(collectTestReqIds(testsAbs));
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
