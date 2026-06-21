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
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const atomic_io_1 = require("../core/atomic-io");
const hash_1 = require("../core/hash");
const log_1 = require("../core/log");
const ledger_1 = require("../core/ledger");
const guards_1 = require("../core/guards");
const tester_1 = require("../core/tester");
/**
 * `th tester record --driver <d> [--provider real|sandbox] [--evidence-ref <path|url>]`
 *
 * Write the live-QA Tester marker at `.twinharness/tester-record.json` (through the
 * UNMODIFIED governed-write chokepoint — the state dir is an admitted write surface) and
 * stamp `ranAt`. A non-empty `driver` is REQUIRED (an empty marker is not evidence and
 * the read predicate rejects it). Returns a `{file, hash}` receipt.
 */
function runTesterRecord(paths, opts) {
    const driver = (opts.driver ?? "").trim();
    if (driver === "") {
        return (0, output_1.failure)({
            human: "usage: th tester record --driver <playwright|curl|cli-e2e|…> [--provider real|sandbox] [--evidence-ref <path|url>]",
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
    const record = {
        driver,
        ...(provider ? { provider } : {}),
        ...(evidenceRef ? { evidenceRef } : {}),
        ranAt: new Date().toISOString(),
    };
    const body = JSON.stringify(record, null, 2) + "\n";
    (0, atomic_io_1.atomicWriteFile)((0, tester_1.testerRecordPath)(paths), body, { root: paths.root });
    const hash = (0, hash_1.shortHash)(body);
    const rel = path.relative(paths.root, (0, tester_1.testerRecordPath)(paths)).split(path.sep).join("/");
    // Audit trail (mirrors the sim ledger): attaching a Tester record clears a gate rung.
    (0, ledger_1.appendLedger)(paths, { event: "tester-record", driver: record.driver, provider: record.provider ?? null });
    (0, log_1.structuredLog)({ cmd: "tester record", driver: record.driver, provider: record.provider ?? null });
    return (0, output_1.success)({
        data: { file: rel, ...record, hash },
        human: `Recorded live-QA Tester evidence at ${rel} (driver: ${record.driver}` +
            `${record.provider ? `, provider: ${record.provider}` : ""}${record.evidenceRef ? `, evidence: ${record.evidenceRef}` : ""}). ` +
            `The production-reality gate's Tester condition is now satisfied.`,
        receipts: [{ file: rel, hash }],
    });
}
