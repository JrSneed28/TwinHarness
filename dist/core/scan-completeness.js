"use strict";
/**
 * Scan-completeness stores (Axis-B slice-2 / BSC-6). TWO append-only JSONL stores,
 * both under `<stateDir>` (already on the governed write-surface — the first path
 * segment is the state dir; {@link assertGovernedWriteSurface} keys on that, NOT the
 * filename, so no allow-list change is needed):
 *
 *   1. `scan-completeness.jsonl` — the INCOMPLETE-SCAN RECEIPT (slice-2a). A structured
 *      result log naming, for an incomplete `dist/` scan, WHICH limit was reached, WHAT
 *      remained unscanned (paths + digests), and WHICH coverage dimensions are therefore
 *      unproven (seeds BSC-3/BSC-5 observability). It carries **ZERO gate authority**:
 *      the completion gate RECOMPUTES coverage every run and never reads this file to
 *      decide — trusting a persisted "complete" summary is the EXACT bug class BSC-6 is.
 *      This is the audit trail + the `th sim scan` human surface, not a trusted source.
 *
 *   2. `scan-exceptions.jsonl` — the EXTERNAL-SIGNED EXCEPTION ACK (slice-2b — the
 *      independence increment). The ONLY trust-bearing input: an `unobserved` `dist/`
 *      file is exonerated ONLY by an Ed25519-signed, path-and-digest-scoped ack produced
 *      OUT of process (the in-process surface holds the verify-only public key and
 *      provably cannot forge one — the slice-1b grounded/forged asymmetry applied to
 *      exceptions). Signature verification, NOT chain order, is authoritative (mirrors
 *      the slice-1b external store), so the producer may append without the state lock.
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
exports.scanCompletenessPath = scanCompletenessPath;
exports.readScanCompletenessReceipts = readScanCompletenessReceipts;
exports.appendScanCompletenessReceipt = appendScanCompletenessReceipt;
exports.scanExceptionsPath = scanExceptionsPath;
exports.scanExceptionCanonicalText = scanExceptionCanonicalText;
exports.computeScanExceptionRecordHash = computeScanExceptionRecordHash;
exports.readScanExceptions = readScanExceptions;
exports.readLastScanExceptionRecordHash = readLastScanExceptionRecordHash;
exports.readScanExceptionValidated = readScanExceptionValidated;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
const hash_1 = require("./hash");
const jsonl_1 = require("./jsonl");
const receipts_1 = require("./receipts");
const receipt_signing_1 = require("./receipt-signing");
const UNOBSERVED_REASONS = new Set([
    "file_limit",
    "aggregate_limit",
    "watchdog",
    "read_error",
]);
const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
/** `<stateDir>/scan-completeness.jsonl` — the incomplete-scan receipt store. */
function scanCompletenessPath(paths) {
    return path.join(paths.stateDir, "scan-completeness.jsonl");
}
/** Tolerant shape check for an incomplete-scan receipt line (bad lines are skipped). */
function isValidScanCompletenessReceipt(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const r = parsed;
    if (!Array.isArray(r.unobserved))
        return false;
    for (const u of r.unobserved) {
        if (typeof u !== "object" || u === null)
            return false;
        const e = u;
        if (typeof e.path !== "string" || e.path === "")
            return false;
        if (!(e.digest === null || typeof e.digest === "string"))
            return false;
        if (typeof e.reason !== "string" || !UNOBSERVED_REASONS.has(e.reason))
            return false;
    }
    if (!Array.isArray(r.limits_reached) || !r.limits_reached.every((x) => typeof x === "string" && UNOBSERVED_REASONS.has(x))) {
        return false;
    }
    if (!Array.isArray(r.unproven_dimensions) || !r.unproven_dimensions.every((x) => typeof x === "string"))
        return false;
    if (typeof r.recordedAt !== "string")
        return false;
    const snap = r.snapshot_coord;
    if (typeof snap !== "object" || snap === null)
        return false;
    const s = snap;
    if (!(s.gitHead === null || typeof s.gitHead === "string"))
        return false;
    if (!(s.treeDigest === null || typeof s.treeDigest === "string"))
        return false;
    return true;
}
/** Read every incomplete-scan receipt (file order). Missing file → `[]`; tolerant; never throws. */
function readScanCompletenessReceipts(paths) {
    return (0, jsonl_1.readJsonlValues)(scanCompletenessPath(paths), isValidScanCompletenessReceipt);
}
/**
 * Append one incomplete-scan receipt. The caller MUST already hold the `withStateLock`
 * span (mirrors `appendTerminalReceipt`). Asserts the governed write-surface, derives
 * the distinct limits + unproven dimensions, stamps the snapshot coordinate + time, and
 * atomically appends one JSON line. Returns the sealed receipt.
 */
function appendScanCompletenessReceipt(paths, unobserved) {
    (0, paths_1.assertGovernedWriteSurface)(paths.root, scanCompletenessPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const limits_reached = [...new Set(unobserved.map((u) => u.reason))].sort();
    const unproven_dimensions = unobserved.map((u) => `simulation-token-coverage:${u.path}`);
    const receipt = {
        unobserved,
        limits_reached,
        unproven_dimensions,
        snapshot_coord: (0, receipts_1.currentReceiptSnapshotCoord)(paths),
        recordedAt: new Date().toISOString(),
    };
    fs.appendFileSync(scanCompletenessPath(paths), JSON.stringify(receipt) + "\n", "utf8");
    return receipt;
}
/** `<stateDir>/scan-exceptions.jsonl` — the external-signed exception ack store. */
function scanExceptionsPath(paths) {
    return path.join(paths.stateDir, "scan-exceptions.jsonl");
}
/** Canonical field order for the ack (signature + recordHash excluded — they are trailers). */
const ACK_CANONICAL_FIELD_ORDER = ["path", "digest", "snapshot_coord", "producer_kind", "key_id", "prevHash"];
const SNAPSHOT_FIELD_ORDER = ["gitHead", "treeDigest"];
/**
 * Deterministic canonical text of an ack for signing + hashing: fixed field order, the
 * nested `snapshot_coord` re-emitted in a fixed key order, `signature`/`recordHash`
 * dropped. The SINGLE formula the external producer (at sign time) and the in-process
 * validator (at gate time) both use, so they can never diverge on the binding.
 */
function scanExceptionCanonicalText(ack) {
    const ordered = {};
    for (const key of ACK_CANONICAL_FIELD_ORDER) {
        const val = ack[key];
        if (val === undefined)
            continue;
        if (key === "snapshot_coord") {
            const snap = val;
            const reordered = {};
            for (const k of SNAPSHOT_FIELD_ORDER)
                reordered[k] = snap[k];
            ordered[key] = reordered;
        }
        else {
            ordered[key] = val;
        }
    }
    return JSON.stringify(ordered);
}
/** `recordHash` for an ack = SHA-256 of its canonical text. */
function computeScanExceptionRecordHash(ack) {
    return (0, hash_1.hashContent)(scanExceptionCanonicalText(ack));
}
/** Tolerant shape check for an ack line (a malformed line is skipped, never trusted). */
function isValidScanExceptionAck(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const r = parsed;
    if (typeof r.path !== "string" || r.path === "")
        return false;
    if (typeof r.digest !== "string" || !hash_1.HEX64.test(r.digest))
        return false;
    if (r.producer_kind !== "external")
        return false;
    if (typeof r.key_id !== "string" || r.key_id === "")
        return false;
    if (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))
        return false;
    if (typeof r.prevHash !== "string" || !hash_1.HEX64.test(r.prevHash))
        return false;
    if (typeof r.recordHash !== "string" || !hash_1.HEX64.test(r.recordHash))
        return false;
    const snap = r.snapshot_coord;
    if (typeof snap !== "object" || snap === null)
        return false;
    const s = snap;
    if (!(s.gitHead === null || typeof s.gitHead === "string"))
        return false;
    if (!(s.treeDigest === null || typeof s.treeDigest === "string"))
        return false;
    return true;
}
/** Read every (well-shaped) ack. Signatures are verified at gate time, NOT here. */
function readScanExceptions(paths) {
    return (0, jsonl_1.readJsonlValues)(scanExceptionsPath(paths), isValidScanExceptionAck);
}
/** The `recordHash` of the ack store's last valid line — the producer's `prevHash` seed. */
function readLastScanExceptionRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(scanExceptionsPath(paths), isValidScanExceptionAck);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * Validate the exception ack for `(targetPath, targetDigest)` (the enumerated
 * coordinate). Mirrors `readReceiptValidated`'s external precedence: an external CLAIM
 * must PROVE itself with a verifying Ed25519 signature over its canonical text under the
 * configured public key; only then, and only if the signed digest equals the CURRENT
 * digest, is the file exonerated. A path-mismatch never reaches here (filtered out);
 * a digest-mismatch is `stale`; an unverifiable line is `forged`. An in-process forge
 * cannot produce a verifying signature (the in-process surface holds no private key).
 */
function readScanExceptionValidated(paths, targetPath, targetDigest) {
    const candidates = readScanExceptions(paths).filter((a) => a.path === targetPath);
    if (candidates.length === 0)
        return { status: "absent" };
    const publicKey = (0, receipt_signing_1.loadExternalPublicKey)();
    if (publicKey !== null) {
        const configuredKeyId = (0, receipt_signing_1.externalKeyId)(publicKey);
        // The LAST verifying candidate in file order wins (a re-mint supersedes).
        let verified;
        for (const cand of candidates) {
            if (cand.key_id !== configuredKeyId)
                continue;
            const { recordHash: _rh, signature, ...signedView } = cand;
            if ((0, receipt_signing_1.verifyCanonical)(scanExceptionCanonicalText(signedView), signature, publicKey))
                verified = cand;
        }
        if (verified) {
            // Path matches (filtered above); the ack exonerates ONLY the digest it signed.
            if (verified.digest === targetDigest)
                return { status: "accepted", ack: verified };
            return { status: "stale", ack: verified };
        }
    }
    // Candidate line(s) exist for this path but none verify (key absent / bad signature).
    return { status: "forged", ack: candidates[candidates.length - 1] };
}
