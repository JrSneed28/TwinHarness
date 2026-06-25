"use strict";
/**
 * Interview-readiness receipt store (Axis-B slice-7 / BSC-9 — readiness-from-scores).
 *
 * `interviewReady(paths)` (`commands/interview.ts`) is consumed by the soft interview
 * gate (`checkInterview` in `gate-preconditions.ts`) as the SINGLE source of "the
 * interview reached confidence". It is SELF-ASSERTED: it re-reads `interview.json` and
 * returns `confidence >= cutoff`, with NO correspondence artifact recording that a real
 * scored round produced the readiness — a run can flip `ready` by editing the store and
 * the gate has no receipt to validate against. This module mints a schema-registered
 * {@link InterviewReadinessReceipt} whose *ground* (the recomputed `{confidence, cutoff,
 * ready}` over a content digest of the interview store + the repository snapshot
 * coordinate it was minted at) is re-derivable at gate time, so a readiness asserted
 * without a backing receipt — or with `confidence < cutoff` — is mechanically detectable.
 *
 * Storage mirrors `src/core/realization.ts` EXACTLY (the FIFTH+ instance of the shipped
 * receipt shape): a DEDICATED, lock-isolated append-only SHA-256 hash-chained
 * `<stateDir>/interview-readiness-receipts.jsonl`, a tolerant reader, a tail-scan for the
 * next `prevHash`, an atomic-append writer that runs under the CALLER's `withStateLock`
 * span, and a tamper-detecting chain walk. A dedicated store gives the gate one validated
 * reader and the external (un-writable) producer a distinct location.
 *
 * The readiness GROUND is keyed to the interview store, NOT a free `targetPath`: it binds
 * to `interview.json`'s digest at mint time, and the validator re-reads the store and
 * RECOMPUTES `ready = confidence >= cutoff` (the SAME `computeReadinessGround` formula
 * used at mint), so a flipped/edited store is `target_mismatch`/`not-ready` rather than
 * silently accepted (the F8 "diffable ground" lesson).
 *
 * REUSE (avoid F8 regression): the shared digest path (`computeTargetDigest`), snapshot
 * coordinate (`currentReceiptSnapshotCoord`, `SnapshotCoord`) come from `receipts.ts` and
 * the signing infra from `receipt-signing.ts` — NO new digest formula, NO touch to
 * `tester.ts`.
 *
 * `producer_identity` carries ZERO trust weight in-process (consensus §3): an audit
 * breadcrumb only. The in-process pass status is `valid` NEVER `valid-grounded`, so the
 * status itself encodes the trust level. The genuine un-forgeable property arrives via the
 * external Ed25519 producer — and even THAT is SIGNATURE-PROVENANCE independence only (the
 * scored judgment is still agent-authored; the external producer proves the receipt was
 * not forged in-process, NOT that the judgment is independent).
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
exports.StoreUnresolvedError = void 0;
exports.computeReadinessGround = computeReadinessGround;
exports.readinessCanonicalText = readinessCanonicalText;
exports.computeReadinessRecordHash = computeReadinessRecordHash;
exports.readinessReceiptsPath = readinessReceiptsPath;
exports.externalReadinessReceiptsPath = externalReadinessReceiptsPath;
exports.isValidReadinessReceipt = isValidReadinessReceipt;
exports.readReadinessReceipts = readReadinessReceipts;
exports.readExternalReadinessReceipts = readExternalReadinessReceipts;
exports.readLastExternalReadinessRecordHash = readLastExternalReadinessRecordHash;
exports.readLastReadinessRecordHash = readLastReadinessRecordHash;
exports.verifyReadinessChain = verifyReadinessChain;
exports.readinessRefId = readinessRefId;
exports.appendReadinessReceipt = appendReadinessReceipt;
exports.readReadinessReceiptValidated = readReadinessReceiptValidated;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
const hash_1 = require("./hash");
const jsonl_1 = require("./jsonl");
const receipts_1 = require("./receipts");
const receipt_signing_1 = require("./receipt-signing");
// ---------------------------------------------------------------------------
// Shared readiness-ground formula — used by BOTH the producer AND the validator
// ---------------------------------------------------------------------------
/**
 * The SINGLE shared readiness-ground formula. `ready` is the EXACT predicate
 * `computeReady`/`interviewReady` apply (`confidence !== null && confidence >= cutoff`),
 * so the mint side and the gate side can never drift apart on what "ready" means.
 */
function computeReadinessGround(confidence, cutoff) {
    return { confidence, cutoff, ready: confidence !== null && confidence >= cutoff };
}
// ---------------------------------------------------------------------------
// Canonical text + hashing (mirrors realization.ts)
// ---------------------------------------------------------------------------
/**
 * The fixed canonical field order for hashing/signing. `signature` and `recordHash` are
 * EXCLUDED trailers (computed over the IDENTICAL bytes); `undefined` keys are dropped, so
 * an in-process receipt (the three signing fields absent) is byte-stable. The nested
 * objects (`ground`, `store_coord`, `snapshot_coord`) are re-emitted in a fixed key order.
 */
const CANONICAL_FIELD_ORDER = [
    "kind",
    "refId",
    "ground",
    "store_coord",
    "snapshot_coord",
    "producer_identity",
    "producer_kind",
    "key_id",
    "legacy",
    "prevHash",
];
/** Canonical key order for {@link ReadinessGround} (byte-stable nested JSON). */
const GROUND_FIELD_ORDER = ["confidence", "cutoff", "ready"];
/** Canonical key order for the store coordinate (byte-stable nested JSON). */
const STORE_FIELD_ORDER = ["path", "digest"];
/** Canonical key order for {@link SnapshotCoord} (byte-stable nested JSON). */
const SNAPSHOT_FIELD_ORDER = ["gitHead", "treeDigest"];
/** Re-emit a nested object in a fixed key order (deterministic JSON). */
function reorder(obj, order) {
    const out = {};
    for (const key of order)
        out[key] = obj[key];
    return out;
}
/**
 * Deterministic canonical text of a readiness receipt for hashing/signing. Field order is
 * fixed; `undefined` keys and `recordHash` are dropped; the three nested objects are
 * re-emitted in their fixed key order; `JSON.stringify` with no indentation. `signature`
 * is excluded (a trailer). `hashContent` then CRLF→LF normalizes (harmless — no CRLF).
 */
function readinessCanonicalText(receipt) {
    const ordered = {};
    for (const key of CANONICAL_FIELD_ORDER) {
        const val = receipt[key];
        if (val === undefined)
            continue;
        if (key === "ground") {
            ordered[key] = reorder(val, GROUND_FIELD_ORDER);
        }
        else if (key === "store_coord") {
            ordered[key] = reorder(val, STORE_FIELD_ORDER);
        }
        else if (key === "snapshot_coord") {
            ordered[key] = reorder(val, SNAPSHOT_FIELD_ORDER);
        }
        else {
            ordered[key] = val;
        }
    }
    return JSON.stringify(ordered);
}
/** `recordHash` for a readiness receipt = SHA-256 of its canonical text (recordHash omitted). */
function computeReadinessRecordHash(receipt) {
    return (0, hash_1.hashContent)(readinessCanonicalText(receipt));
}
// ---------------------------------------------------------------------------
// Storage (mirrors realization.ts)
// ---------------------------------------------------------------------------
/** `<stateDir>/interview-readiness-receipts.jsonl` — the in-process readiness-receipt ledger. */
function readinessReceiptsPath(paths) {
    return path.join(paths.stateDir, "interview-readiness-receipts.jsonl");
}
/**
 * `<stateDir>/external-interview-readiness-receipts.jsonl` — the EXTERNAL keyed producer's
 * store. A SEPARATE file for LOCK-ISOLATION (parallel to the realization/driver/approval
 * external stores): the out-of-process producer appends here without taking the in-process
 * `withStateLock` span. The SECURITY boundary is NOT this path — it is the private key held
 * only by the producer; a forged line written here is rejected by
 * {@link readReadinessReceiptValidated} (no verifying signature ⇒ `forged`).
 */
function externalReadinessReceiptsPath(paths) {
    return path.join(paths.stateDir, "external-interview-readiness-receipts.jsonl");
}
const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
/** Validate the shape of a parsed readiness-receipt line; malformed lines are skipped (tolerant). */
function isValidReadinessReceipt(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const r = parsed;
    if (r.kind !== "interview-readiness")
        return false;
    if (typeof r.refId !== "string" || r.refId === "")
        return false;
    if (typeof r.producer_identity !== "string")
        return false;
    if (typeof r.prevHash !== "string" || !hash_1.HEX64.test(r.prevHash))
        return false;
    if (typeof r.recordHash !== "string" || !hash_1.HEX64.test(r.recordHash))
        return false;
    if (r.legacy !== undefined && typeof r.legacy !== "boolean")
        return false;
    // OPTIONAL signing fields: accepted when present, NEVER required.
    if (r.producer_kind !== undefined && r.producer_kind !== "external" && r.producer_kind !== "in-process")
        return false;
    if (r.key_id !== undefined && typeof r.key_id !== "string")
        return false;
    if (r.signature !== undefined &&
        (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))) {
        return false;
    }
    // Nested ground must be present + shaped.
    const g = r.ground;
    if (typeof g !== "object" || g === null)
        return false;
    const gr = g;
    if (!(gr.confidence === null || (typeof gr.confidence === "number" && Number.isFinite(gr.confidence))))
        return false;
    if (typeof gr.cutoff !== "number" || !Number.isFinite(gr.cutoff))
        return false;
    if (typeof gr.ready !== "boolean")
        return false;
    // Nested store coordinate must be present + shaped.
    const sc = r.store_coord;
    if (typeof sc !== "object" || sc === null)
        return false;
    const s2 = sc;
    if (typeof s2.path !== "string" || typeof s2.digest !== "string")
        return false;
    // Snapshot coordinate must be present + shaped.
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
/**
 * Read + parse every readiness receipt in the in-process store, in file order. Missing
 * file → `[]`. Bad lines are silently skipped — tolerant, never throws. Chain breaks
 * surface via {@link verifyReadinessChain}.
 */
function readReadinessReceipts(paths) {
    return (0, jsonl_1.readJsonlValues)(readinessReceiptsPath(paths), isValidReadinessReceipt);
}
/**
 * Read + parse every readiness receipt in the EXTERNAL store, same tolerant shape as
 * {@link readReadinessReceipts}. The signature on a line is verified at gate time by
 * {@link readReadinessReceiptValidated}, NOT here — this reader is shape-only, so a
 * forged-but-well-shaped line is returned and then classified `forged` downstream.
 */
function readExternalReadinessReceipts(paths) {
    return (0, jsonl_1.readJsonlValues)(externalReadinessReceiptsPath(paths), isValidReadinessReceipt);
}
/**
 * The `recordHash` of the EXTERNAL store's last valid readiness receipt — the `prevHash`
 * seed for the external producer's own append-only chain. Missing/empty/no-valid-tail →
 * `GENESIS_PREV_HASH`. Used by the standalone producer.
 */
function readLastExternalReadinessRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(externalReadinessReceiptsPath(paths), isValidReadinessReceipt);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * The `recordHash` of the in-process ledger's last VALID readiness receipt — the seed
 * {@link appendReadinessReceipt} needs to seal the next link. Tail-scans the file so N
 * appends stay O(N) total. Missing/empty/no-valid-tail → `GENESIS_PREV_HASH`.
 */
function readLastReadinessRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(readinessReceiptsPath(paths), isValidReadinessReceipt);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * Walk readiness receipts in file order with a running `expectedPrev = GENESIS`. For each
 * receipt: recompute `recordHash` from its canonical text — a mismatch means the record
 * was edited. If `prevHash !== expectedPrev` the line was inserted/deleted/reordered.
 * Return `{ ok:false, brokenAt:N }` at the FIRST break; else advance. Byte-identical
 * posture to `realization.verifyRealizationChain`.
 */
function verifyReadinessChain(receipts) {
    let expectedPrev = hash_1.GENESIS_PREV_HASH;
    for (let i = 0; i < receipts.length; i++) {
        const r = receipts[i];
        const { recordHash, ...rest } = r;
        const recomputed = computeReadinessRecordHash(rest);
        if (recomputed !== recordHash)
            return { ok: false, brokenAt: i, reason: "edited" };
        if (r.prevHash !== expectedPrev)
            return { ok: false, brokenAt: i, reason: "prev_mismatch" };
        expectedPrev = r.recordHash;
    }
    return { ok: true };
}
// ---------------------------------------------------------------------------
// Producer API (caller already holds withStateLock)
// ---------------------------------------------------------------------------
/**
 * The run identity a readiness receipt is keyed by — the snapshot coordinate's `gitHead`,
 * or `"no-git"` on a non-git checkout. A re-interview at a new HEAD mints a receipt under a
 * new refId, so the gate finds the LATEST receipt for the current snapshot. The SINGLE
 * helper the mint side and the gate side both call, so the lookup key can never drift.
 */
function readinessRefId(paths) {
    return (0, receipts_1.currentReceiptSnapshotCoord)(paths).gitHead ?? "no-git";
}
/**
 * Thrown by {@link appendReadinessReceipt} when `storePath` does NOT resolve in source
 * (refuse-at-creation: a readiness whose store is already missing must not be minted —
 * mirrors the terminal/realization flows).
 */
class StoreUnresolvedError extends Error {
    store;
    /** Stable machine token for the CLI failure envelope. */
    code = "readiness_store_unresolved";
    constructor(message, 
    /** The offending (root-relative) store path. */
    store) {
        super(message);
        this.store = store;
        this.name = "StoreUnresolvedError";
    }
}
exports.StoreUnresolvedError = StoreUnresolvedError;
/**
 * Append one in-process readiness receipt, sealing the hash chain. The caller MUST already
 * hold the `withStateLock` span (read-modify-append is serialized there), exactly like
 * `appendRealizationReceipt`.
 *
 * Refuse-at-creation: `storePath` MUST resolve in source (its digest is the recomputable
 * store ground) — else {@link StoreUnresolvedError}. The receipt records the readiness
 * ground (recomputed via {@link computeReadinessGround}), the store digest + the current
 * snapshot coordinate, derives `prevHash` from the tail, computes `recordHash`, asserts the
 * write-surface, and atomically appends. `producer_kind` is `"in-process"` (zero trust
 * weight). Returns the sealed receipt.
 */
function appendReadinessReceipt(paths, input) {
    const digest = (0, receipts_1.computeTargetDigest)(paths.root, input.storePath);
    if (digest === null) {
        throw new StoreUnresolvedError(`Refusing to mint an interview-readiness receipt for ${input.refId}: store "${input.storePath}" does not resolve in source.`, input.storePath);
    }
    return sealAndAppend(paths, {
        kind: "interview-readiness",
        refId: input.refId,
        ground: computeReadinessGround(input.confidence, input.cutoff),
        store_coord: { path: input.storePath, digest },
        snapshot_coord: (0, receipts_1.currentReceiptSnapshotCoord)(paths),
        producer_identity: input.producerIdentity,
        producer_kind: "in-process",
    });
}
/**
 * The shared seal+append chokepoint: derive `prevHash` from the tail, compute `recordHash`,
 * assert the governed write-surface, mkdir, atomically append. The single place a readiness
 * receipt line is written.
 */
function sealAndAppend(paths, receipt) {
    (0, paths_1.assertGovernedWriteSurface)(paths.root, readinessReceiptsPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const prevHash = readLastReadinessRecordHash(paths);
    const withPrev = { ...receipt, prevHash };
    const recordHash = computeReadinessRecordHash(withPrev);
    const sealed = { ...withPrev, recordHash };
    fs.appendFileSync(readinessReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
    return sealed;
}
/**
 * Compare a recorded coordinate against the current one under the F8 rule: a coordinate
 * discriminates ONLY when BOTH the recorded and the current value are non-null.
 */
function snapshotStaleReasons(recorded, current) {
    const reasons = [];
    if (recorded.gitHead !== null && current.gitHead !== null && recorded.gitHead !== current.gitHead) {
        reasons.push("gitHead");
    }
    if (recorded.treeDigest !== null &&
        current.treeDigest !== null &&
        recorded.treeDigest !== current.treeDigest) {
        reasons.push("treeDigest");
    }
    return reasons;
}
/**
 * Apply the CONTENT checks to a present, non-legacy receipt, returning a pass/fail status.
 * On PASS the caller-supplied `passStatus` is returned (`valid` in-process / `valid-grounded`
 * external). On FAIL the specific token (`store_missing`/`store_mismatch`/`stale`/`not-ready`)
 * — IDENTICAL discrimination for both producer kinds. The readiness ground is re-derived
 * FRESH from the recorded `{confidence, cutoff}` (the receipt's stored `ready` is the F8
 * correspondence artifact; the live recompute is the verdict) so a hand-edited `ready:true`
 * over a sub-cutoff confidence is `not-ready`.
 */
function classifyReadinessContent(paths, receipt, passStatus) {
    const recordedPath = receipt.store_coord.path;
    const recordedDigest = receipt.store_coord.digest;
    const currentDigest = (0, receipts_1.computeTargetDigest)(paths.root, recordedPath);
    if (currentDigest === null)
        return { status: "store_missing", receipt };
    if (currentDigest !== recordedDigest)
        return { status: "store_mismatch", receipt };
    const staleReasons = snapshotStaleReasons(receipt.snapshot_coord, (0, receipts_1.currentReceiptSnapshotCoord)(paths));
    if (staleReasons.length > 0)
        return { status: "stale", receipt, staleReasons };
    // Re-derive readiness FRESH from the recorded confidence/cutoff — do not trust the stored
    // `ready` flag. A sub-cutoff (or null) confidence is `not-ready` regardless of the flag.
    const reground = computeReadinessGround(receipt.ground.confidence, receipt.ground.cutoff);
    if (!reground.ready)
        return { status: "not-ready", receipt };
    return { status: passStatus, receipt };
}
/**
 * True iff a receipt CLAIMS to be external/signed — it carries EITHER a `signature` trailer
 * OR a `key_id`. Such a receipt MUST prove itself with a verifying Ed25519 signature; a
 * claim that fails verification is `forged`.
 */
function claimsExternal(r) {
    return typeof r.signature === "string" || typeof r.key_id === "string";
}
/** Verify a readiness receipt's Ed25519 signature against the loaded external public key. */
function signatureVerifies(receipt) {
    const publicKey = (0, receipt_signing_1.loadExternalPublicKey)();
    if (publicKey === null)
        return false;
    if (typeof receipt.signature !== "string")
        return false;
    if (receipt.key_id !== (0, receipt_signing_1.externalKeyId)(publicKey))
        return false;
    const { recordHash: _rh, signature: _sig, ...signedView } = receipt;
    return (0, receipt_signing_1.verifyCanonical)(readinessCanonicalText(signedView), receipt.signature, publicKey);
}
/**
 * Validate the receipt backing the readiness claim for `refId`. Reads BOTH stores — the
 * in-process `interview-readiness-receipts.jsonl` AND the external store — and gathers every
 * candidate matching `refId`. Mirrors `readRealizationReceiptValidated` precedence EXACTLY:
 * external decisive (verify-or-`forged`) → in-process `valid` → `legacy` grandfather → block
 * set.
 */
function readReadinessReceiptValidated(paths, refId) {
    const matches = (r) => r.refId === refId;
    const inProcessReceipts = readReadinessReceipts(paths);
    if (!verifyReadinessChain(inProcessReceipts).ok)
        return { status: "tampered" };
    // LATEST in-process candidate in file order (a re-interview mints a newer receipt).
    let inProcess;
    for (const r of inProcessReceipts) {
        if (matches(r))
            inProcess = r;
    }
    // ALL external candidates claiming this refId. A tampered external chain is fail-closed.
    const externalReceipts = readExternalReadinessReceipts(paths);
    const externalChainOk = verifyReadinessChain(externalReceipts).ok;
    const externalCandidates = externalReceipts.filter((r) => matches(r) && claimsExternal(r));
    // (1) An external CLAIM exists → it must PROVE itself with a verifying signature.
    if (externalCandidates.length > 0) {
        const publicKey = (0, receipt_signing_1.loadExternalPublicKey)();
        if (publicKey !== null && externalChainOk) {
            // The LAST verifying external candidate in file order (a re-mint wins).
            let verified;
            for (const cand of externalCandidates) {
                if (signatureVerifies(cand))
                    verified = cand;
            }
            if (verified) {
                if (verified.legacy === true)
                    return { status: "legacy", receipt: verified };
                return classifyReadinessContent(paths, verified, "valid-grounded");
            }
        }
        // No external candidate verified (key absent, chain broken, or all signatures bad) → forged.
        return { status: "forged", receipt: externalCandidates[externalCandidates.length - 1] };
    }
    // (2) No external claim → the in-process classification on the latest line.
    if (!inProcess)
        return { status: "absent" };
    if (inProcess.legacy === true)
        return { status: "legacy", receipt: inProcess };
    return classifyReadinessContent(paths, inProcess, "valid");
}
