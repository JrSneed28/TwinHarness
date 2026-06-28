"use strict";
/**
 * Context ledger: sharded, append-only JSONL hash chain recording every page
 * delivered into a session. Mirrors receipts.ts external-store + jsonl.ts
 * tolerant-reader patterns (plan §D-09).
 *
 * LOCK ISOLATION: dedicated per-shard mkdir lock under context-pages/ — NOT
 * .state.lock / withStateLock — so ledger appends never contend with the main
 * state read-modify-write path.
 *
 * S0 = record-only: only op="deliver" is emitted by callers. Other op values
 * are valid enum entries for later slices.
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
exports.contextPagesDir = contextPagesDir;
exports.ledgerShardPath = ledgerShardPath;
exports.computeLedgerRecordHash = computeLedgerRecordHash;
exports.readShardRecords = readShardRecords;
exports.readLastShardRecordHash = readLastShardRecordHash;
exports.appendLedgerRecord = appendLedgerRecord;
exports.verifyLedgerChain = verifyLedgerChain;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const hash_1 = require("./hash");
const jsonl_1 = require("./jsonl");
const sleep_1 = require("./sleep");
const SHARD_COMPONENT_FALLBACK = "unknown";
/**
 * Encode untrusted session / agent identifiers into one filesystem-safe segment.
 * Hook payloads are external input; raw ids must never be interpolated into a path
 * because `/`, `\\`, `..`, drive prefixes, or reserved characters can escape the
 * context-pages directory.  Base64url is deterministic, compact, and contains no
 * path separators; very long ids fall back to a full content hash to keep path
 * lengths bounded.
 */
function encodeShardComponent(raw) {
    const value = raw.length > 0 ? raw : SHARD_COMPONENT_FALLBACK;
    const encoded = Buffer.from(value, "utf8").toString("base64url");
    return encoded.length <= 120 ? encoded : `sha256-${(0, hash_1.hashContent)(value)}`;
}
function assertUnderContextPages(pagesDir, candidate) {
    const resolvedRoot = path.resolve(pagesDir);
    const resolvedCandidate = path.resolve(candidate);
    const rel = path.relative(resolvedRoot, resolvedCandidate);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        return resolvedCandidate;
    }
    throw new Error("context ledger shard path escaped context-pages directory");
}
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
/** `<stateDir>/context-pages/` — all page data lives here, never in state.json. */
function contextPagesDir(paths) {
    return path.join(paths.stateDir, "context-pages");
}
/** `<contextPagesDir>/ledger-<encoded-session>-<encoded-agentOrRoot>.jsonl`. */
function ledgerShardPath(paths, scope) {
    const pagesDir = contextPagesDir(paths);
    const shard = `ledger-${encodeShardComponent(scope.session_id)}-${encodeShardComponent(scope.agentOrRoot)}.jsonl`;
    return assertUnderContextPages(pagesDir, path.join(pagesDir, shard));
}
// ---------------------------------------------------------------------------
// Canonical serialization + record hash (mirrors computeRecordHash in receipts.ts)
// ---------------------------------------------------------------------------
/**
 * Field order for deterministic JSON serialization. recordHash is excluded —
 * it is the SHA-256 of the canonical text of the rest of the record.
 */
const CANONICAL_FIELD_ORDER = [
    "seq",
    "ts",
    "session_id",
    "agent_id",
    "agent_type",
    "epoch",
    "op",
    "page_id",
    "logical_key",
    "content_hash",
    "base_hash",
    "complete",
    "est_tokens",
    "reduction_kind",
    "prevHash",
];
function canonicalText(rec) {
    const ordered = {};
    for (const key of CANONICAL_FIELD_ORDER) {
        const val = rec[key];
        if (val === undefined)
            continue; // omit absent optional fields (e.g. base_hash)
        ordered[key] = val;
    }
    return JSON.stringify(ordered);
}
/** recordHash = SHA-256 of the canonical text of the record without recordHash. */
function computeLedgerRecordHash(rec) {
    return (0, hash_1.hashContent)(canonicalText(rec));
}
// ---------------------------------------------------------------------------
// Validation — shape predicate for the tolerant readers
// ---------------------------------------------------------------------------
const OP_VALUES = new Set([
    "deliver",
    "attest",
    "delta",
    "rehydrate",
    "invalidate",
    "epoch-bump",
]);
function isValidLedgerRecord(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const r = parsed;
    if (typeof r.seq !== "number")
        return false;
    if (typeof r.ts !== "string" || r.ts === "")
        return false;
    if (typeof r.session_id !== "string" || r.session_id === "")
        return false;
    if (typeof r.agent_id !== "string")
        return false;
    if (typeof r.agent_type !== "string")
        return false;
    if (typeof r.epoch !== "number")
        return false;
    if (typeof r.op !== "string" || !OP_VALUES.has(r.op))
        return false;
    if (typeof r.page_id !== "string" || r.page_id === "")
        return false;
    if (typeof r.logical_key !== "string")
        return false;
    if (typeof r.content_hash !== "string")
        return false;
    if (r.base_hash !== undefined && typeof r.base_hash !== "string")
        return false;
    if (typeof r.complete !== "boolean")
        return false;
    if (typeof r.est_tokens !== "number")
        return false;
    if (typeof r.reduction_kind !== "string")
        return false;
    if (typeof r.prevHash !== "string" || !hash_1.HEX64.test(r.prevHash))
        return false;
    if (typeof r.recordHash !== "string" || !hash_1.HEX64.test(r.recordHash))
        return false;
    return true;
}
// ---------------------------------------------------------------------------
// Tolerant readers (mirror readJsonlValues / scanTailValid from jsonl.ts)
// ---------------------------------------------------------------------------
/**
 * Read all valid records from a shard in file order. Missing file → [].
 * Unparseable / schema-invalid lines are silently skipped — tolerant, never throws.
 * Chain integrity is NOT checked here; use verifyLedgerChain for that (audit-only).
 */
function readShardRecords(paths, scope) {
    return (0, jsonl_1.readJsonlValues)(ledgerShardPath(paths, scope), isValidLedgerRecord);
}
function readLastShardRecord(paths, scope) {
    return (0, jsonl_1.scanTailValid)(ledgerShardPath(paths, scope), isValidLedgerRecord) ?? undefined;
}
/**
 * The recordHash of the last valid record in the shard — the prevHash seed for the
 * next append. Missing / empty / no-valid-tail → GENESIS_PREV_HASH. Tail-scans so
 * N sequential appends stay O(N) total. Never throws.
 */
function readLastShardRecordHash(paths, scope) {
    const last = readLastShardRecord(paths, scope);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
// ---------------------------------------------------------------------------
// Per-shard lock (dedicated mkdir lock — NOT .state.lock / withStateLock)
// ---------------------------------------------------------------------------
/** Milliseconds before the shard lock dir is considered stale and may be stolen. */
const SHARD_LOCK_STALE_MS = 3_000;
/**
 * Milliseconds we wait to acquire the shard lock before falling back to an
 * unlocked appendFileSync. A shorter ceiling than the state lock (25s) because
 * a ledger append is a fast, lock-scope-narrow operation.
 */
const SHARD_LOCK_TIMEOUT_MS = 5_000;
/**
 * Classify a mkdirSync failure as "lock already held" vs. a real error.
 * Mirrors isLockHeldError in state-store.ts for cross-platform correctness
 * (Windows can surface EPERM / EACCES instead of EEXIST on a contended mkdir).
 */
function isShardLockHeldError(code) {
    return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}
/**
 * Try to acquire the per-shard mkdir lock, waiting up to SHARD_LOCK_TIMEOUT_MS.
 * Returns true when the lock is acquired (caller MUST release via rmSync).
 * Returns false on timeout — caller falls back to direct appendFileSync;
 * the resulting forked prevHash is tolerated (external-store precedent, receipts.ts).
 */
function acquireShardLock(lockDir) {
    const deadline = Date.now() + SHARD_LOCK_TIMEOUT_MS;
    let backoff = 5;
    while (true) {
        try {
            fs.mkdirSync(lockDir);
            return true; // acquired
        }
        catch (e) {
            const code = e.code;
            if (!isShardLockHeldError(code))
                throw e; // real error — propagate
        }
        if (Date.now() >= deadline)
            return false; // timed out
        // Steal a stale lock left by a crashed holder (mirrors withStateLock steal logic)
        try {
            const mtime = fs.statSync(lockDir).mtimeMs;
            if (Date.now() - mtime > SHARD_LOCK_STALE_MS) {
                fs.rmSync(lockDir, { recursive: true, force: true });
            }
        }
        catch {
            // lock may have been released between statSync and rmSync — ignore
        }
        // Exponential backoff with full jitter (mirrors withStateLock PERF-008)
        (0, sleep_1.sleepSync)(Math.floor(Math.random() * backoff));
        backoff = Math.min(backoff * 2, 80);
    }
}
// ---------------------------------------------------------------------------
// Append (the write path)
// ---------------------------------------------------------------------------
/**
 * Seal and append one record to the appropriate shard.
 *
 * Derives prevHash from the shard tail (GENESIS_PREV_HASH when empty) and
 * computes recordHash before writing. Uses a dedicated per-shard mkdir lock
 * under context-pages/ so shard appends are serialized without touching the
 * main .state.lock span.
 *
 * On lock-timeout: falls back to a single-syscall appendFileSync with
 * GENESIS_PREV_HASH as prevHash. The resulting forked chain link is tolerated
 * (matches external-receipts precedent in receipts.ts §682–684). The record is
 * written, never silently dropped.
 *
 * The caller provides all fields except prevHash and recordHash.
 */
function appendLedgerRecord(paths, scope, rec) {
    const pagesDir = contextPagesDir(paths);
    const shardFile = ledgerShardPath(paths, scope);
    const lockDir = shardFile + ".lock";
    // Ensure the context-pages directory exists (idempotent; first append creates it)
    fs.mkdirSync(pagesDir, { recursive: true });
    const acquiredLock = acquireShardLock(lockDir);
    try {
        // Inside the lock: read the accurate tail. On timeout: use GENESIS_PREV_HASH
        // (forked prevHash is acceptable — chain is advisory, not a gate).
        const last = acquiredLock ? readLastShardRecord(paths, scope) : undefined;
        const prevHash = acquiredLock
            ? (last ? last.recordHash : hash_1.GENESIS_PREV_HASH)
            : hash_1.GENESIS_PREV_HASH;
        const seq = acquiredLock ? (last ? last.seq + 1 : 0) : rec.seq;
        const withPrev = { ...rec, seq, prevHash };
        const recordHash = computeLedgerRecordHash(withPrev);
        const sealed = { ...withPrev, recordHash };
        // Single-syscall append — atomic for one \n-terminated line on all major FSes.
        fs.appendFileSync(shardFile, JSON.stringify(sealed) + "\n", "utf8");
        return sealed;
    }
    finally {
        if (acquiredLock) {
            try {
                fs.rmSync(lockDir, { recursive: true, force: true });
            }
            catch {
                // ignore — lock cleanup failure does not affect the written record
            }
        }
    }
}
/**
 * Walk records in file order and verify the SHA-256 hash chain.
 *
 * For each record: recompute recordHash from its canonical text — a mismatch
 * means the record was edited after it was appended. Then check
 * prevHash === expectedPrev — a mismatch means a record was inserted, deleted,
 * or reordered. Returns { ok:false, brokenAt:N } at the first break;
 * { ok:true } when every link is intact.
 *
 * AUDIT-ONLY: must NOT be called on the live residency path. readShardRecords
 * is the tolerant live reader; this function exists for offline integrity checks.
 * A forked chain (parallel writers using GENESIS_PREV_HASH) will surface here
 * as prev_mismatch, which is expected and diagnostic — it does not indicate
 * data loss, only that concurrent appends raced.
 */
function verifyLedgerChain(records) {
    let expectedPrev = hash_1.GENESIS_PREV_HASH;
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        const { recordHash, ...rest } = r;
        const recomputed = computeLedgerRecordHash(rest);
        if (recomputed !== recordHash) {
            return { ok: false, brokenAt: i, reason: "edited" };
        }
        if (r.prevHash !== expectedPrev) {
            return { ok: false, brokenAt: i, reason: "prev_mismatch" };
        }
        expectedPrev = r.recordHash;
    }
    return { ok: true };
}
