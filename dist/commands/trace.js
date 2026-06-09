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
exports.runTraceRender = runTraceRender;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const anchors_1 = require("../core/anchors");
const log_1 = require("../core/log");
/**
 * `th trace render` — the RENDERED traceability view (spec §17). Traceability is
 * **generated on demand** by scanning the durable REQ-ID anchors that live next
 * to the code; it is NEVER stored as a maintained matrix (§17, decision #12). The
 * view never goes stale the way a hand-maintained matrix does because the anchors
 * move with the code.
 *
 * Mechanical only (plan §3 boundary rule): it records WHERE each requirement's
 * anchor appears across design/contracts/plan/tests/code; it never decides
 * whether a requirement is correct or adequately covered.
 */
/** Requirements file relative to the project root (§17 anchor source of truth). */
const REQUIREMENTS_FILE = "docs/01-requirements.md";
/** Contracts file relative to the project root (§17 "Contract" column). */
const CONTRACTS_FILE = "docs/07-contracts.md";
/** Implementation-plan file relative to the project root (§17 "Slice / Task"). */
const PLAN_FILE = "docs/09-implementation-plan.md";
/** SLICE-/TASK- token shape surfaced from the plan as a best-effort convenience. */
const SLICE_TASK_PATTERN = /\b(?:SLICE|TASK)-\d+\b/g;
/** Read a file as UTF-8, or return undefined if it is absent / not a file. */
function readFileOrUndefined(abs) {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
        return undefined;
    return fs.readFileSync(abs, "utf8");
}
/**
 * Invert a `REQ-ID → files` scan into a `REQ-ID → Set<files>` lookup, optionally
 * dropping any file path matching `exclude` (used to keep 01-requirements out of
 * the Design column). File paths are prefixed with `prefix` so they read as
 * project-root-relative forward-slash paths in the rendered view.
 */
function indexByReq(map, prefix, exclude) {
    const out = new Map();
    for (const [req, files] of map) {
        for (const rel of files) {
            if (exclude && exclude(rel))
                continue;
            const full = prefix ? `${prefix}/${rel}` : rel;
            const list = out.get(req);
            if (list) {
                if (!list.includes(full))
                    list.push(full);
            }
            else {
                out.set(req, [full]);
            }
        }
    }
    return out;
}
/** Best-effort SLICE-/TASK- tokens found anywhere in the plan, unique + stable. */
function planSliceTaskTokens(planContent) {
    const seen = new Set();
    const out = [];
    for (const m of planContent.matchAll(SLICE_TASK_PATTERN)) {
        if (!seen.has(m[0])) {
            seen.add(m[0]);
            out.push(m[0]);
        }
    }
    return out;
}
/** Render a row's cell: join file lists with ", "; an empty cell shows as "—". */
function cell(items) {
    return items.length ? items.join(", ") : "—";
}
/**
 * `th trace render` — build the §17 traceability view fresh from anchors and
 * return both structured rows and a markdown table. Failure (exit 1) when the
 * project is not initialized far enough to have a requirements file or when that
 * file defines no requirements to trace.
 */
function runTraceRender(paths) {
    const reqsAbs = path.resolve(paths.root, REQUIREMENTS_FILE);
    const reqsContent = readFileOrUndefined(reqsAbs);
    if (reqsContent === undefined) {
        return (0, output_1.failure)({
            human: `no requirements to trace: ${REQUIREMENTS_FILE} not found. Run \`th init\` and author requirements first.`,
            data: { error: "no_requirements" },
        });
    }
    const reqSet = (0, anchors_1.extractReqIds)(reqsContent);
    if (reqSet.length === 0) {
        return (0, output_1.failure)({
            human: `no requirements to trace: ${REQUIREMENTS_FILE} defines no REQ-ID anchors.`,
            data: { error: "no_requirements" },
        });
    }
    // Design = REQ-ID anchors in design docs under docs/ (esp. 03 domain / 04
    // architecture / 06 technical-design, §17 "Design ref"). The files that own a
    // DEDICATED column — 01-requirements, 07-contracts, 09-implementation-plan —
    // are excluded so Design, Contract, and Slice/Task stay distinct (§17).
    const docsScan = (0, anchors_1.scanDirForReqIds)(paths.docsDir);
    const designExcluded = new Set([
        "01-requirements.md",
        path.basename(CONTRACTS_FILE),
        path.basename(PLAN_FILE),
    ]);
    const designIdx = indexByReq(docsScan, "docs", (rel) => designExcluded.has(rel));
    // Contract = REQ-ID anchors in the contracts file (§17 "Contract").
    const contractContent = readFileOrUndefined(path.resolve(paths.root, CONTRACTS_FILE));
    const contractIdx = new Map();
    if (contractContent !== undefined) {
        for (const id of (0, anchors_1.extractReqIds)(contractContent))
            contractIdx.set(id, [CONTRACTS_FILE]);
    }
    // Slice / Task = the REQ-ID appearing in the plan, plus best-effort SLICE-/TASK-
    // tokens surfaced from the plan as a convenience (§17 "Slice / Task").
    const planContent = readFileOrUndefined(path.resolve(paths.root, PLAN_FILE));
    const planReqs = planContent === undefined ? new Set() : new Set((0, anchors_1.extractReqIds)(planContent));
    const planTokens = planContent === undefined ? [] : planSliceTaskTokens(planContent);
    // Test = REQ-ID anchors under tests/; Code = REQ-ID anchors under src/ (§17).
    const testIdx = indexByReq((0, anchors_1.scanDirForReqIds)(path.join(paths.root, "tests")), "tests");
    const codeIdx = indexByReq((0, anchors_1.scanDirForReqIds)(path.join(paths.root, "src")), "src");
    const rows = reqSet.map((req) => {
        const sliceTask = [];
        if (planReqs.has(req)) {
            sliceTask.push(PLAN_FILE);
            for (const tok of planTokens)
                sliceTask.push(tok);
        }
        return {
            req,
            design: designIdx.get(req) ?? [],
            contract: contractIdx.get(req) ?? [],
            sliceTask,
            test: testIdx.get(req) ?? [],
            code: codeIdx.get(req) ?? [],
        };
    });
    // Human render = a markdown table with the §17 columns, generated fresh; nothing
    // is persisted (§17 — rendered on demand, never stored).
    const header = "| Requirement | Design ref | Contract | Slice / Task | Test | Code |";
    const divider = "| --- | --- | --- | --- | --- | --- |";
    const body = rows.map((r) => `| ${r.req} | ${cell(r.design)} | ${cell(r.contract)} | ${cell(r.sliceTask)} | ${cell(r.test)} | ${cell(r.code)} |`);
    const human = [header, divider, ...body].join("\n");
    (0, log_1.structuredLog)({ cmd: "trace render", requirements: rows.length });
    return (0, output_1.success)({ data: { rows }, human });
}
