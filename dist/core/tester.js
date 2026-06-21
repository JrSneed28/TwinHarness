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
exports.readTesterRecordValidated = readTesterRecordValidated;
exports.testerRecordPresent = testerRecordPresent;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const git_revision_1 = require("./git-revision");
/** `<stateDir>/tester-record.json` — the live-QA Tester evidence marker. */
function testerRecordPath(paths) {
    return path.join(paths.stateDir, "tester-record.json");
}
/**
 * Read the Tester record, returning `null` when absent or unreadable/malformed
 * (fail-closed for the gate: no readable record ⇒ the rung blocks). A present record
 * must carry a non-empty `driver` to PARSE — an empty marker is not evidence. The
 * F8 BINDING fields are carried through when present (the strict gate predicate
 * inspects them); a legacy bare record still parses (advisory back-compat).
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
        passed: typeof r.passed === "boolean" ? r.passed : undefined,
        receiptDigest: typeof r.receiptDigest === "string" ? r.receiptDigest : undefined,
        gitHead: typeof r.gitHead === "string" ? r.gitHead : r.gitHead === null ? null : undefined,
        dirtyTreeDigest: typeof r.dirtyTreeDigest === "string" ? r.dirtyTreeDigest : r.dirtyTreeDigest === null ? null : undefined,
    };
}
/**
 * Read + CLASSIFY the Tester record against the F8 binding (R-31). The git
 * coordinates discriminate only when BOTH sides are non-null (the honest "unbound"
 * posture — a coordinate we cannot compute cannot prove staleness). `commands`-style
 * content hashing is not needed here: the record's identity is its receipt + the
 * repo snapshot it ran against.
 */
function readTesterRecordValidated(paths) {
    const record = readTesterRecord(paths);
    if (record === null)
        return { status: "absent" };
    // A bare/legacy marker: a driver but no pass+receipt binding.
    if (record.passed === undefined && record.receiptDigest === undefined) {
        return { status: "driver_only", record };
    }
    if (record.passed !== true)
        return { status: "not_passed", record };
    if (typeof record.receiptDigest !== "string" || record.receiptDigest.trim() === "") {
        return { status: "unbound", record };
    }
    // Repo-snapshot binding: stale when a present coordinate diverged from the current tree.
    const curHead = (0, git_revision_1.gitHead)(paths.root);
    const curDirty = (0, git_revision_1.dirtyTreeDigest)(paths.root);
    const staleReasons = [];
    if (record.gitHead != null && curHead != null && record.gitHead !== curHead) {
        staleReasons.push("gitHead");
    }
    if (record.dirtyTreeDigest != null && curDirty != null && record.dirtyTreeDigest !== curDirty) {
        staleReasons.push("dirtyTreeDigest");
    }
    if (staleReasons.length > 0)
        return { status: "stale", record, staleReasons };
    return { status: "valid", record };
}
/**
 * True iff a live-QA Tester record satisfying the F8 binding is attached — the
 * production-reality gate's 3rd condition (R-31, ENFORCED).
 *
 * STRICT: a record counts ONLY when the live run is recorded as PASSED, carries an
 * execution-receipt digest, and its repo-snapshot binding matches the current tree
 * (`readTesterRecordValidated(...).status === "valid"`). A driver-only marker, a
 * missing/false pass verdict, an unbound (no-receipt) record, or one staled by a code
 * change since the run no longer clears the rung — closing the F8 gap where a bare
 * `{driver}` marker (copyable, unbound to any real run) could fake the mandatory live
 * QA. The richer classification + token are available via `readTesterRecordValidated`.
 */
function testerRecordPresent(paths) {
    return readTesterRecordValidated(paths).status === "valid";
}
