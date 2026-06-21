"use strict";
/**
 * Tester-record presence (SG3 P2-C, audit C-08). The production-reality gate's 3rd
 * condition is "a live-QA Tester run record is attached" — the audit's "mandatory
 * live QA + Production Reality Gate" promotes the on-demand Tester to a REQUIRED
 * final-verification gate (`orchestrator.md`, `templates/10` Tester Evidence).
 *
 * The record is a small JSON marker at `.twinharness/tester-record.json` written by
 * the live Tester (driver used, real/sandbox provider confirmed, raw output ref).
 * This module is the PURE read predicate the gate consumes; it is deliberately a
 * file-presence + shape check (not a counter on state.json) so the Tester's evidence
 * is auditable history, consistent with the simulation ledger and verify-report
 * sidecars. Keeping the predicate here (separate from the gate) mirrors how
 * `interviewReady`/`readVerifyReport` are pure readers the gate calls.
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
exports.testerRecordPath = testerRecordPath;
exports.readTesterRecord = readTesterRecord;
exports.testerRecordPresent = testerRecordPresent;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/** `<stateDir>/tester-record.json` — the live-QA Tester evidence marker. */
function testerRecordPath(paths) {
    return path.join(paths.stateDir, "tester-record.json");
}
/**
 * Read the Tester record, returning `null` when absent or unreadable/malformed
 * (fail-closed for the gate: no readable record ⇒ the rung blocks). A present record
 * must carry a non-empty `driver` to count — an empty marker is not evidence.
 */
function readTesterRecord(paths) {
    const file = testerRecordPath(paths);
    if (!fs.existsSync(file))
        return null;
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null)
        return null;
    const r = parsed;
    if (typeof r.driver !== "string" || r.driver.trim() === "")
        return null;
    return {
        driver: r.driver,
        provider: typeof r.provider === "string" ? r.provider : undefined,
        evidenceRef: typeof r.evidenceRef === "string" ? r.evidenceRef : undefined,
        ranAt: typeof r.ranAt === "string" ? r.ranAt : undefined,
    };
}
/** True iff a valid live-QA Tester record is attached — the gate's 3rd condition. */
function testerRecordPresent(paths) {
    return readTesterRecord(paths) !== null;
}
