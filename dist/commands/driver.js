"use strict";
/**
 * `th driver record` (Axis-B slice-4a / BSC-3) — mint the in-process driver-dimension
 * receipt the production-reality gate's verification-driver rung reads.
 *
 * Before this verb, the completion gate cleared on a verify report that said "ok" with
 * NO record of WHICH verification dimensions a trusted runner actually EXERCISED — a run
 * that never typechecked read identically to one that did (BSC-3). This is the missing
 * in-process SENSOR writer: it records which seed dimensions (`tests-executed`,
 * `typecheck`, `build`) `verify-report.json` actually observed, hash-chained into
 * `<stateDir>/driver-receipts.jsonl`, under `withStateLock` (exactly like `th approve`).
 *
 * ZERO TRUST WEIGHT (consensus §3): this is the IN-PROCESS producer — the agent can mint
 * it, so the record is attribution-only. Its trust label is `valid` NEVER `valid-grounded`;
 * the independently-grounded property arrives only in slice-4b (an external Ed25519-keyed
 * producer at a write-surface TwinHarness cannot reach). The record LOOKS authoritative
 * (hash-chained, snapshot-bound) but is NOT an independence anchor.
 *
 * SENSOR + refuse-at-creation (the 4a negative-control): the receipt records a dimension
 * ONLY when `verify-report.json` actually OBSERVES it. A `--dimension` claim is INTERSECTED
 * with the observed set; a claimed-but-unobserved name is REFUSED before any write
 * (`driver_dimension_unobserved`), and a missing/unresolving report is refused too
 * (`driver_evidence_unresolved`). The core sensor lives in `src/core/verification-driver.ts`;
 * this is its governed CLI writer (mirroring the approval/tester producer split).
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
exports.runDriverRecord = runDriverRecord;
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const log_1 = require("../core/log");
const ledger_1 = require("../core/ledger");
const guards_1 = require("../core/guards");
const verification_driver_1 = require("../core/verification-driver");
/**
 * `th driver record [--dimension <name>] [--identity <who>]` — mint an in-process
 * driver-dimension receipt from the current `verify-report.json`. Serialized under the
 * state lock so the chain append is atomic (mirrors `th approve`).
 */
function runDriverRecord(paths, opts = {}) {
    return (0, state_store_1.withStateLock)(paths, () => runDriverRecordLocked(paths, opts));
}
function runDriverRecordLocked(paths, opts) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: "state.json is invalid; fix it before recording a driver-dimension receipt.",
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    let sealed;
    try {
        sealed = (0, verification_driver_1.appendDriverReceipt)(paths, {
            ...(opts.dimensionNames !== undefined ? { dimensionNames: opts.dimensionNames } : {}),
            producerIdentity: opts.producerIdentity ?? "cli:th driver record",
        });
    }
    catch (e) {
        if (e instanceof verification_driver_1.DimensionUnobservedError) {
            return (0, output_1.failure)({
                human: `Refusing to record driver dimension(s) not observed in verify-report.json: ${e.unobserved.join(", ")}. ` +
                    `Run \`th verify run\` so the report evidences the dimension(s) first, then re-record.`,
                data: { error: e.code, unobserved: e.unobserved },
            });
        }
        if (e instanceof verification_driver_1.EvidenceUnresolvedError) {
            return (0, output_1.failure)({
                human: `Cannot record a driver-dimension receipt: evidence artifact "${e.evidenceRef}" does not resolve in source. ` +
                    `Run \`th verify run\` to produce the report, then re-record.`,
                data: { error: e.code, evidenceRef: e.evidenceRef },
            });
        }
        throw e;
    }
    const rel = path.relative(paths.root, (0, verification_driver_1.driverReceiptsPath)(paths)).split(path.sep).join("/");
    const recorded = sealed.dimensions.map((d) => d.name);
    // Audit trail (mirrors the approval/tester writers): a driver receipt grounds the BSC-3
    // verification-driver rung. Key the chain digest as `driverRecordHash` so it never
    // collides with the ledger entry's OWN recordHash/prevHash seal fields.
    (0, ledger_1.appendLedger)(paths, { event: "driver-record", dimensions: recorded, driverRecordHash: sealed.recordHash });
    (0, log_1.structuredLog)({ cmd: "driver record", dimensions: recorded, driverRecordHash: sealed.recordHash });
    return (0, output_1.success)({
        data: {
            file: rel,
            dimensions: recorded,
            producer_kind: sealed.producer_kind ?? "in-process",
            recordHash: sealed.recordHash,
        },
        human: `Recorded an in-process driver-dimension receipt at ${rel} ` +
            `(dimensions observed: ${recorded.length > 0 ? recorded.join(", ") : "(none)"}). ` +
            `NOTE: this in-process record is ATTRIBUTION-ONLY (zero trust weight) — the agent can mint it; ` +
            `independent grounding requires the slice-4b external-signed producer.`,
        receipts: [{ file: rel, hash: sealed.recordHash }],
    });
}
