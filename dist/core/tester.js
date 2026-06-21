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
exports.isRemoteEvidenceRef = isRemoteEvidenceRef;
exports.localEvidenceReadable = localEvidenceReadable;
exports.computeReceiptDigest = computeReceiptDigest;
exports.readTesterRecord = readTesterRecord;
exports.readTesterRecordValidated = readTesterRecordValidated;
exports.testerRecordPresent = testerRecordPresent;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const git_revision_1 = require("./git-revision");
const hash_1 = require("./hash");
/** `<stateDir>/tester-record.json` — the live-QA Tester evidence marker. */
function testerRecordPath(paths) {
    return path.join(paths.stateDir, "tester-record.json");
}
/**
 * An evidence reference is REMOTE (a URL like `https://…`, `s3://…`) rather than a
 * local file when it carries a URI scheme. A remote ref is not a file we can re-read,
 * so the local-evidence integrity checks are skipped for it (its string still binds
 * into the receipt digest). A bare path — absolute or relative — is treated as local.
 */
function isRemoteEvidenceRef(ref) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(ref);
}
/** Resolve a LOCAL evidence ref against the project root (absolute refs pass through). */
function resolveEvidencePath(root, ref) {
    return path.isAbsolute(ref) ? ref : path.resolve(root, ref);
}
/** True iff `ref` names a readable, regular file once resolved against `root`. */
function localEvidenceReadable(root, ref) {
    const abs = resolveEvidencePath(root, ref);
    try {
        return fs.existsSync(abs) && fs.statSync(abs).isFile();
    }
    catch {
        return false;
    }
}
/**
 * Compute the execution-receipt digest binding a Tester record to a real run
 * (F8/R-31). Hashes the run's identifying inputs (driver + provider + pass verdict +
 * evidence reference) AND, when `evidenceRef` names a readable LOCAL file, a content
 * hash of that file — so a fabricated marker without the real evidence cannot
 * reproduce the digest. A remote (URL) ref contributes only its string.
 *
 * The SINGLE source of truth shared by the `th tester record` writer
 * (`src/commands/tester.ts`) and {@link readTesterRecordValidated}'s
 * recompute-and-compare, so the writer and the validator can never drift apart on
 * the binding formula.
 */
function computeReceiptDigest(root, parts) {
    let evidenceContent = "";
    if (parts.evidenceRef && !isRemoteEvidenceRef(parts.evidenceRef)) {
        const abs = resolveEvidencePath(root, parts.evidenceRef);
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
 * posture — a coordinate we cannot compute cannot prove staleness). When the record
 * names a LOCAL evidence file, that file is re-read and the receipt RECOMPUTED, so a
 * record bound to absent evidence, or evidence deleted/replaced after the run, is
 * caught even when it lives outside the tracked tree (where the repo coordinates miss it).
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
    // Local-evidence integrity: a record naming a LOCAL evidence file must still be able
    // to read that file AND reproduce the bound receipt from its content. This catches a
    // record written against absent local evidence (the digest bound a null content hash),
    // and evidence deleted/replaced AFTER recording — neither of which the repo-snapshot
    // coordinates detect when the evidence lives outside the tracked tree. A remote (URL)
    // ref is not a file we can re-read → skipped (it contributes only its string).
    if (record.evidenceRef && !isRemoteEvidenceRef(record.evidenceRef)) {
        if (!localEvidenceReadable(paths.root, record.evidenceRef)) {
            return { status: "evidence_missing", record };
        }
        const recomputed = computeReceiptDigest(paths.root, {
            driver: record.driver,
            provider: record.provider,
            evidenceRef: record.evidenceRef,
            passed: record.passed === true,
        });
        if (recomputed !== record.receiptDigest) {
            return { status: "evidence_mismatch", record };
        }
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
 * execution-receipt digest, its LOCAL evidence file (if any) is readable and still
 * reproduces that digest, and its repo-snapshot binding matches the current tree
 * (`readTesterRecordValidated(...).status === "valid"`). A driver-only marker, a
 * missing/false pass verdict, an unbound (no-receipt) record, one whose local evidence
 * is absent or altered, or one staled by a code change since the run no longer clears
 * the rung — closing the F8 gap where a bare `{driver}` marker (copyable, unbound to
 * any real run) could fake the mandatory live QA. The richer classification + token
 * are available via `readTesterRecordValidated`.
 */
function testerRecordPresent(paths) {
    return readTesterRecordValidated(paths).status === "valid";
}
