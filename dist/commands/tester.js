"use strict";
/**
 * `th tester record` (SG3 P2-C, audit C-08) — attach the live-QA Tester run record the
 * production-reality gate's 3rd condition requires.
 *
 * The gate (`src/core/gate-preconditions.ts` → `checkProductionReality`) refuses
 * completion at final-verification until `.twinharness/tester-record.json` is present
 * and well-shaped (a non-empty `driver`). Before this verb existed, NO command or MCP
 * tool wrote that marker — the Tester agent only routed findings to drift/blackboard
 * and `th next` told the human to update the verification report, which the gate does
 * NOT read — so the gate could never be cleared through the documented workflow (audit
 * P1). This verb is the missing writer: it records the marker the gate reads.
 *
 * Mechanical only (plan §3 boundary rule): the CLI records the driver/provider/evidence
 * the live Tester supplies and content-hashes the marker. It does NOT decide whether the
 * live run actually passed — that judgment is the Tester's, surfaced in the verification
 * report's Tester Evidence section; the gate's mechanical requirement is only that a
 * recorded live run EXISTS. The pure READ predicate the gate consumes lives in
 * `src/core/tester.ts`; this is its governed writer (mirroring the sim ledger split).
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
exports.runTesterRecord = runTesterRecord;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const atomic_io_1 = require("../core/atomic-io");
const hash_1 = require("../core/hash");
const log_1 = require("../core/log");
const ledger_1 = require("../core/ledger");
const guards_1 = require("../core/guards");
const git_revision_1 = require("../core/git-revision");
const tester_1 = require("../core/tester");
/**
 * Compute the execution-receipt digest binding a Tester record to a real run (F8/R-31).
 * It hashes the run's identifying inputs (driver + provider + the pass verdict + the
 * evidence reference) AND, when `evidenceRef` names a readable file under the project,
 * a content hash of that file — so a fabricated marker without the real evidence file
 * cannot reproduce the digest. A non-file/URL evidenceRef still contributes its string.
 */
function computeReceiptDigest(root, parts) {
    let evidenceContent = "";
    if (parts.evidenceRef) {
        const abs = path.isAbsolute(parts.evidenceRef) ? parts.evidenceRef : path.resolve(root, parts.evidenceRef);
        try {
            if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                evidenceContent = fs.readFileSync(abs, "utf8");
            }
        }
        catch {
            /* unreadable → contribute nothing extra; the ref string still binds */
        }
    }
    const canonical = JSON.stringify({
        driver: parts.driver,
        provider: parts.provider ?? null,
        evidenceRef: parts.evidenceRef ?? null,
        passed: parts.passed,
        evidenceContentHash: evidenceContent ? (0, hash_1.hashContent)(evidenceContent) : null,
    });
    return (0, hash_1.hashContent)(canonical);
}
/**
 * `th tester record --driver <d> --passed [--provider real|sandbox] [--evidence-ref <path|url>]`
 *
 * Write the live-QA Tester marker at `.twinharness/tester-record.json` (through the
 * UNMODIFIED governed-write chokepoint — the state dir is an admitted write surface) and
 * stamp `ranAt`. A non-empty `driver` is REQUIRED.
 *
 * F8/R-31 — the record is now BOUND so it is actual proof a live run PASSED against
 * THIS snapshot, not a copyable driver-only marker: it carries the `passed` verdict, an
 * execution-receipt digest, and the repo-snapshot coordinates (gitHead/dirtyTreeDigest).
 * The strict gate predicate (`testerRecordPresent`) requires `passed:true` + a receipt +
 * a matching snapshot. Mechanical (plan §3): the CLI records the verdict the live Tester
 * supplies; it does not re-run or re-judge the live QA. Returns a `{file, hash}` receipt.
 */
function runTesterRecord(paths, opts) {
    const driver = (opts.driver ?? "").trim();
    if (driver === "") {
        return (0, output_1.failure)({
            human: "usage: th tester record --driver <playwright|curl|cli-e2e|…> --passed [--provider real|sandbox] [--evidence-ref <path|url>]",
            data: { error: "missing_driver" },
        });
    }
    // Require an initialized run (matches the other governed writers) so the marker is
    // attached to a real project; a clean NOT_INIT beats a stray file in a non-run dir.
    const st = (0, guards_1.requireState)(paths);
    if (st.result)
        return st.result;
    const provider = opts.provider?.trim();
    const evidenceRef = opts.evidenceRef?.trim();
    const passed = opts.passed === true;
    const receiptDigest = computeReceiptDigest(paths.root, { driver, provider, evidenceRef, passed });
    const record = {
        driver,
        ...(provider ? { provider } : {}),
        ...(evidenceRef ? { evidenceRef } : {}),
        ranAt: new Date().toISOString(),
        passed,
        receiptDigest,
        gitHead: (0, git_revision_1.gitHead)(paths.root),
        dirtyTreeDigest: (0, git_revision_1.dirtyTreeDigest)(paths.root),
    };
    const body = JSON.stringify(record, null, 2) + "\n";
    (0, atomic_io_1.atomicWriteFile)((0, tester_1.testerRecordPath)(paths), body, { root: paths.root });
    const hash = (0, hash_1.shortHash)(body);
    const rel = path.relative(paths.root, (0, tester_1.testerRecordPath)(paths)).split(path.sep).join("/");
    // Audit trail (mirrors the sim ledger): attaching a Tester record clears a gate rung.
    (0, ledger_1.appendLedger)(paths, { event: "tester-record", driver: record.driver, provider: record.provider ?? null, passed });
    (0, log_1.structuredLog)({ cmd: "tester record", driver: record.driver, provider: record.provider ?? null, passed });
    // Honest signal when the run was NOT marked passed: the record is written (audit
    // history) but the production-reality gate's Tester condition is NOT satisfied.
    const gateNote = passed
        ? "The production-reality gate's Tester condition is now satisfied."
        : "NOTE: recorded as NOT passed (`--passed` absent) — the production-reality gate's Tester condition is NOT satisfied. Re-record with `--passed` once the live run is green.";
    return (0, output_1.success)({
        data: { file: rel, ...record, hash },
        human: `Recorded live-QA Tester evidence at ${rel} (driver: ${record.driver}` +
            `${record.provider ? `, provider: ${record.provider}` : ""}${record.evidenceRef ? `, evidence: ${record.evidenceRef}` : ""}, passed: ${passed}). ` +
            gateNote,
        receipts: [{ file: rel, hash }],
    });
}
