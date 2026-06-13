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
exports.runDebugPack = runDebugPack;
exports.runDebugLogAdd = runDebugLogAdd;
exports.runDebugLogList = runDebugLogList;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const anchors_1 = require("../core/anchors");
const drift_log_1 = require("../core/drift-log");
const debug_log_1 = require("../core/debug-log");
const verify_1 = require("../core/verify");
const log_1 = require("../core/log");
/**
 * `th debug` — mechanical support for the Debugger agent (evidence-first
 * defect tracing). `th debug pack` assembles a deterministic evidence bundle so
 * the Debugger starts from facts (failing output, anchors, slice, recent drift,
 * open findings); `th debug log add|list` is the append-only evidence ledger
 * (`debug-log.md`, mirroring `drift-log.md`). Records and computes; it never
 * decides a root cause and never fixes anything.
 */
function debugLogPath(paths) {
    return path.join(paths.root, "debug-log.md");
}
const NOT_INIT = (0, output_1.failure)({ human: "No state.json found. Run `th init` first.", data: { error: "not_initialized" } });
/**
 * `th debug pack [--slice <ID> | --req <REQ-ID>]` — assemble the read-only
 * evidence bundle for a failure: the failing verify commands + output tails, the
 * REQ/slice anchors for the affected area, recent drift, and any open debug
 * findings. Sibling of `th context pack`, aimed at a defect rather than a handoff.
 */
function runDebugPack(paths, opts = {}) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state)
        return (0, output_1.failure)({ human: "state.json is invalid.", data: { error: "invalid_state", issues: r.issues } });
    const s = r.state;
    // Failing suite (from the last `th verify run`).
    const report = (0, verify_1.readVerifyReport)(paths);
    const failing = report ? report.results.filter((x) => !x.ok) : [];
    // Target framing: a slice's components, or a REQ-ID's code/test anchors.
    let sliceBlock;
    let reqAnchors;
    if (opts.slice) {
        const target = s.slices.find((sl) => sl.id === opts.slice);
        if (!target) {
            return (0, output_1.failure)({ human: `Unknown slice: ${opts.slice}. Known: ${s.slices.map((sl) => sl.id).join(", ") || "(none)"}`, data: { error: "unknown_slice", slice: opts.slice } });
        }
        sliceBlock = { id: target.id, status: target.status, components: target.components };
    }
    if (opts.req) {
        const files = [];
        for (const dir of ["src", "tests", "docs"]) {
            const map = (0, anchors_1.scanDirForReqIds)(path.join(paths.root, dir));
            for (const f of map.get(opts.req) ?? [])
                files.push(`${dir}/${f}`);
        }
        reqAnchors = { req: opts.req, files };
    }
    // Recent drift + open debug findings.
    const driftText = fs.existsSync(paths.driftLog) ? fs.readFileSync(paths.driftLog, "utf8") : "";
    const drift = (0, drift_log_1.parseDriftEntries)(driftText).slice(-3).map((e) => ({ id: e.id, ref: e.ref, layer: e.layer, discovery: e.discovery }));
    const debugText = fs.existsSync(debugLogPath(paths)) ? fs.readFileSync(debugLogPath(paths), "utf8") : "";
    const openDebug = (0, debug_log_1.parseDebugEntries)(debugText).filter((e) => e.status === "open").map((e) => ({ id: e.id, ref: e.ref, symptom: e.symptom }));
    (0, log_1.structuredLog)({ cmd: "debug pack", slice: opts.slice ?? null, req: opts.req ?? null, failing: failing.length });
    const lines = [`Debug evidence pack${opts.slice ? ` — ${opts.slice}` : opts.req ? ` — ${opts.req}` : ""}`];
    lines.push("", report ? `Suite: ${report.ok ? "green" : "FAILING"} (${report.results.length} command(s), last run ${report.ranAt})` : "Suite: no verify report (run `th verify run` to capture failures)");
    for (const f of failing) {
        lines.push(`  ✗ (${f.exitCode}) ${f.command}`);
        for (const l of f.outputTail.split(/\r?\n/).slice(-6))
            lines.push(`      ${l}`);
    }
    if (sliceBlock)
        lines.push("", `Slice ${sliceBlock.id} [${sliceBlock.status}] — components: ${sliceBlock.components.join(", ") || "(none)"}`);
    if (reqAnchors)
        lines.push("", `${reqAnchors.req} anchored in: ${reqAnchors.files.join(", ") || "(no anchors found)"}`);
    lines.push("", drift.length ? `Recent drift: ${drift.map((d) => `${d.id} (${d.layer})`).join(", ")}` : "Recent drift: (none)");
    lines.push(openDebug.length ? `Open debug findings: ${openDebug.map((d) => d.id).join(", ")}` : "Open debug findings: (none)");
    return (0, output_1.success)({
        data: { slice: sliceBlock ?? null, req: reqAnchors ?? null, failing, drift, openDebug, suite: report ? { ok: report.ok, ranAt: report.ranAt } : null },
        human: lines.join("\n"),
    });
}
/** `th debug log add --ref … --symptom … --evidence … --root-cause … [--status open|resolved]`. */
function runDebugLogAdd(paths, opts) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state)
        return (0, output_1.failure)({ human: "state.json is invalid.", data: { error: "invalid_state", issues: r.issues } });
    if (!opts.ref || !opts.symptom) {
        return (0, output_1.failure)({ human: 'usage: th debug log add --ref "REQ-007 / SLICE-2" --symptom "…" [--evidence "…"] [--root-cause "…"] [--status open|resolved]' });
    }
    const status = opts.status === "resolved" ? "resolved" : "open";
    const file = debugLogPath(paths);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# Debug log\n\nAppend-only evidence trail for the Debugger agent.\n\n";
    const id = (0, debug_log_1.nextDebugId)(existing);
    const block = (0, debug_log_1.formatDebugEntry)({
        id,
        ref: opts.ref,
        symptom: opts.symptom,
        evidence: opts.evidence ?? "(pending)",
        rootCause: opts.rootCause ?? "(under investigation)",
        status,
    });
    fs.writeFileSync(file, existing + block, "utf8");
    (0, log_1.structuredLog)({ cmd: "debug log add", id, ref: opts.ref, status });
    return (0, output_1.success)({ data: { id, ref: opts.ref, status }, human: `${id} logged (${status}).` });
}
/** `th debug log list` — list debug entries + open count. */
function runDebugLogList(paths) {
    const file = debugLogPath(paths);
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const entries = (0, debug_log_1.parseDebugEntries)(text);
    const open = entries.filter((e) => e.status === "open");
    const human = entries.length
        ? [...entries.map((e) => `${e.id}  (${e.ref})  — ${e.status}: ${e.symptom}`), "", `${open.length} open, ${entries.length} total.`].join("\n")
        : "(no debug entries)";
    return (0, output_1.success)({ data: { entries, open: open.length, total: entries.length }, human });
}
