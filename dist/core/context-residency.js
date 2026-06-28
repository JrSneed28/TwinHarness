"use strict";
/**
 * Context residency + epoch management (S1; D-10/D-11).
 *
 * Residency: given the shard records already read by the caller, decide
 * whether a given (logical_key, content_hash) pair is still live in the
 * model's context window.  Any uncertainty ⇒ not resident (FULL — savings-
 * only, never a correctness risk).
 *
 * Epoch: a monotonically-increasing counter stored in `epoch.json` whose
 * bump invalidates all prior residency claims.  Bumped on compaction signals,
 * clear/resume, session-id change, and absolute-token watermark breach.
 *
 * ALL paths are fail-safe (D-16): every public function swallows I/O
 * exceptions and returns a safe default.  Counter reads/writes use a
 * dedicated mkdir lock identical in shape to the shard lock in context-ledger.ts.
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
exports.DEFAULT_WATERMARK_TOKENS = exports.RESIDENCY_TTL_TURNS = void 0;
exports.currentEpoch = currentEpoch;
exports.bumpEpoch = bumpEpoch;
exports.maybeCheckEpoch = maybeCheckEpoch;
exports.deriveResidency = deriveResidency;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const context_page_1 = require("./context-page");
const context_ledger_1 = require("./context-ledger");
const context_telemetry_1 = require("./context-telemetry");
const sleep_1 = require("./sleep");
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Residency TTL in turns.  A record delivered > TTL turns ago is non-resident. */
exports.RESIDENCY_TTL_TURNS = 12;
/**
 * Ultra-conservative absolute-token watermark.  When cumulative input+output
 * tokens in the transcript exceed this value, bump the epoch to treat all
 * prior pages as non-resident.
 *
 * Set deliberately well below any plausible auto-compact threshold so
 * watermark checks are safe without knowing the model's exact context window.
 * Overridable via the `TH_WATERMARK_TOKENS` environment variable.
 */
exports.DEFAULT_WATERMARK_TOKENS = 100_000;
/** Ops that can confer residency (deliver, attest, delta, rehydrate). */
const RESIDENT_OPS = new Set(["deliver", "attest", "delta", "rehydrate"]);
/** Absolute path of `epoch.json` under the context-pages root. */
function epochFilePath(paths) {
    return path.join((0, context_page_1.contextPagesRoot)(paths), "epoch.json");
}
/**
 * Atomically write an epoch record to `epochFile`.  Writes to a sibling temp
 * file in the SAME directory, then `renameSync`s it into place — an atomic
 * operation on POSIX and Windows for same-directory renames.  This prevents a
 * crash or torn write from leaving a partial/zero-length `epoch.json` that
 * `currentEpoch` would treat as malformed and silently reset to epoch 0.
 *
 * Callers must already hold the epoch lock and have created the parent dir.
 */
function writeEpochAtomic(epochFile, rec) {
    const tmp = epochFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(rec), "utf8");
    fs.renameSync(tmp, epochFile);
}
/**
 * Read the current epoch record.  Missing or malformed file → safe default
 * `{ session_id: "", epoch: 0, reason: "init", ts: "" }`.  Never throws.
 */
function currentEpoch(paths) {
    try {
        const p = epochFilePath(paths);
        if (!fs.existsSync(p)) {
            return { session_id: "", epoch: 0, reason: "init", ts: "" };
        }
        const raw = fs.readFileSync(p, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" &&
            parsed !== null &&
            typeof parsed.epoch === "number") {
            return parsed;
        }
        return { session_id: "", epoch: 0, reason: "malformed", ts: "" };
    }
    catch {
        return { session_id: "", epoch: 0, reason: "error", ts: "" };
    }
}
// ---------------------------------------------------------------------------
// Epoch bump — concurrency-safe mkdir lock (mirrors shard lock in context-ledger.ts)
// ---------------------------------------------------------------------------
const EPOCH_LOCK_STALE_MS = 3_000;
const EPOCH_LOCK_TIMEOUT_MS = 5_000;
function isEpochLockHeldError(code) {
    return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}
function acquireEpochLock(lockDir) {
    const deadline = Date.now() + EPOCH_LOCK_TIMEOUT_MS;
    let backoff = 5;
    while (true) {
        try {
            fs.mkdirSync(lockDir);
            return true;
        }
        catch (e) {
            const code = e.code;
            if (!isEpochLockHeldError(code))
                throw e;
        }
        if (Date.now() >= deadline)
            return false;
        try {
            const mtime = fs.statSync(lockDir).mtimeMs;
            if (Date.now() - mtime > EPOCH_LOCK_STALE_MS) {
                fs.rmSync(lockDir, { recursive: true, force: true });
            }
        }
        catch {
            // lock may have been released between stat and rm — ignore
        }
        (0, sleep_1.sleepSync)(Math.floor(Math.random() * backoff));
        backoff = Math.min(backoff * 2, 80);
    }
}
/**
 * Atomically bump the epoch counter and record a reason.
 *
 * Uses a dedicated mkdir lock so concurrent bumps from concurrent hook
 * invocations are serialized.  On lock-timeout, falls back to an unlocked
 * write (last-write-wins — acceptable: both writers are bumping, so the
 * higher value produced by the last writer is correct).  Never throws;
 * returns the new epoch on success or the current epoch on any failure.
 */
function bumpEpoch(paths, reason) {
    const pagesRoot = (0, context_page_1.contextPagesRoot)(paths);
    const epochFile = epochFilePath(paths);
    const lockDir = epochFile + ".lock";
    try {
        fs.mkdirSync(pagesRoot, { recursive: true });
    }
    catch {
        // If we can't create the root, fall back gracefully
        return currentEpoch(paths).epoch;
    }
    const acquired = acquireEpochLock(lockDir);
    try {
        const current = currentEpoch(paths);
        const next = {
            session_id: current.session_id,
            epoch: current.epoch + 1,
            reason,
            ts: new Date().toISOString(),
        };
        fs.mkdirSync(path.dirname(epochFile), { recursive: true });
        writeEpochAtomic(epochFile, next);
        return next.epoch;
    }
    catch {
        return currentEpoch(paths).epoch;
    }
    finally {
        if (acquired) {
            try {
                fs.rmSync(lockDir, { recursive: true, force: true });
            }
            catch {
                // ignore cleanup failure
            }
        }
    }
}
/**
 * Check whether the epoch should be bumped for the given trigger and, if so,
 * bump it.  Returns the (possibly new) epoch number.  Never throws.
 *
 * @param paths          - Project paths.
 * @param trigger        - What fired the check.
 * @param opts.session_id - Incoming session_id (required for "session_start" trigger).
 * @param opts.transcript_path - Transcript file path (required for "watermark" trigger).
 * @param opts.watermark_tokens - Override for the token watermark (default: DEFAULT_WATERMARK_TOKENS).
 */
function maybeCheckEpoch(paths, trigger, opts = {}) {
    try {
        switch (trigger) {
            case "PreCompact":
                return bumpEpoch(paths, "SessionStart{compact}");
            case "clear":
                return bumpEpoch(paths, "clear");
            case "resume":
                return bumpEpoch(paths, "resume");
            case "session_start": {
                if (!opts.session_id)
                    return currentEpoch(paths).epoch;
                const rec = currentEpoch(paths);
                // If session_id is non-empty and differs from the stored one, bump.
                if (rec.session_id && rec.session_id !== opts.session_id) {
                    const pagesRoot = (0, context_page_1.contextPagesRoot)(paths);
                    const epochFile = epochFilePath(paths);
                    const lockDir = epochFile + ".lock";
                    try {
                        fs.mkdirSync(pagesRoot, { recursive: true });
                    }
                    catch {
                        return rec.epoch;
                    }
                    const acquired = acquireEpochLock(lockDir);
                    try {
                        // Re-read under lock to avoid TOCTOU
                        const fresh = currentEpoch(paths);
                        if (fresh.session_id && fresh.session_id !== opts.session_id) {
                            const next = {
                                session_id: opts.session_id,
                                epoch: fresh.epoch + 1,
                                reason: "new_session",
                                ts: new Date().toISOString(),
                            };
                            fs.mkdirSync(path.dirname(epochFile), { recursive: true });
                            writeEpochAtomic(epochFile, next);
                            return next.epoch;
                        }
                        return fresh.epoch;
                    }
                    catch {
                        return currentEpoch(paths).epoch;
                    }
                    finally {
                        if (acquired) {
                            try {
                                fs.rmSync(lockDir, { recursive: true, force: true });
                            }
                            catch { /* ignore */ }
                        }
                    }
                }
                // Record the session_id if it was previously unset.
                if (!rec.session_id && opts.session_id) {
                    try {
                        const pagesRoot = (0, context_page_1.contextPagesRoot)(paths);
                        fs.mkdirSync(pagesRoot, { recursive: true });
                        const updated = { ...rec, session_id: opts.session_id };
                        writeEpochAtomic(epochFilePath(paths), updated);
                    }
                    catch {
                        // fail-safe
                    }
                }
                return rec.epoch;
            }
            case "watermark": {
                if (!opts.transcript_path)
                    return currentEpoch(paths).epoch;
                const actuals = (0, context_telemetry_1.transcriptActuals)(opts.transcript_path);
                if (!actuals)
                    return currentEpoch(paths).epoch;
                const limit = opts.watermark_tokens ?? exports.DEFAULT_WATERMARK_TOKENS;
                const total = actuals.input_tokens + actuals.output_tokens;
                if (total >= limit) {
                    return bumpEpoch(paths, `watermark:${total}>=${limit}`);
                }
                return currentEpoch(paths).epoch;
            }
            default:
                return currentEpoch(paths).epoch;
        }
    }
    catch {
        // Fail-safe: D-16
        return currentEpoch(paths).epoch;
    }
}
/**
 * Determine whether the (logical_key, content_hash) pair is still live in
 * the model's context window, given the shard records already read by the
 * caller.
 *
 * Rules (all must hold for `resident: true`):
 *   1. The LATEST record for `logical_key` among {deliver,attest,delta,rehydrate}
 *      must exist and have op ∈ {deliver,attest,delta,rehydrate}.
 *   2. That record's `content_hash` must equal the supplied `content_hash`.
 *   3. `complete === true` on that record.
 *   4. The record was delivered within TTL turns of `nowTurn`
 *      (`nowTurn - record.seq <= RESIDENCY_TTL_TURNS`; seq is used as a
 *      turn-monotone counter because it is the only per-record ordinal available).
 *   5. The record's `epoch` matches the supplied `epoch` (cross-epoch pages
 *      are always non-resident — D-11).
 *   6. `computeLedgerRecordHash` recomputes to `record.recordHash` (tamper check).
 *
 * The chain `prevHash` walk is NEVER consulted here (audit-only — D-10).
 * Any exception ⇒ `{ resident: false, reason: "error" }` (D-16).
 *
 * @param shardRecords  Records from `readShardRecords` — tolerant, pre-filtered.
 * @param scope         Caller-supplied scope (unused here but passed for context).
 * @param logical_key   The page's stable content address key.
 * @param content_hash  64-hex SHA-256 of the page content to check.
 * @param epoch         Current epoch counter (from `currentEpoch`).
 * @param nowTurn       Current turn ordinal (typically `record.seq` of the newest
 *                      overall record in the shard).
 */
function deriveResidency(shardRecords, _scope, logical_key, content_hash, epoch, nowTurn) {
    try {
        // Find the latest op-eligible record for this logical_key (reverse scan, first wins).
        let latest;
        for (let i = shardRecords.length - 1; i >= 0; i--) {
            const r = shardRecords[i];
            if (r.logical_key === logical_key && RESIDENT_OPS.has(r.op)) {
                latest = r;
                break;
            }
        }
        if (!latest) {
            return { resident: false, reason: "no_record" };
        }
        // Rule 5: epoch boundary — cross-epoch pages are non-resident.
        if (latest.epoch !== epoch) {
            return { resident: false, reason: "epoch_mismatch" };
        }
        // Rule 2: content hash must match.
        if (latest.content_hash !== content_hash) {
            return { resident: false, reason: "hash_mismatch" };
        }
        // Rule 3: complete must be true.
        if (!latest.complete) {
            return { resident: false, reason: "incomplete" };
        }
        // Rule 4: TTL check (seq used as turn-monotone ordinal).
        const age = nowTurn - latest.seq;
        if (age > exports.RESIDENCY_TTL_TURNS) {
            return { resident: false, reason: `ttl_expired:age=${age}` };
        }
        // Rule 6: recordHash must recompute (tamper / corruption check).
        const { recordHash, ...rest } = latest;
        const recomputed = (0, context_ledger_1.computeLedgerRecordHash)(rest);
        if (recomputed !== recordHash) {
            return { resident: false, reason: "hash_tampered" };
        }
        return { resident: true, reason: "ok" };
    }
    catch {
        // D-16: any exception → not resident (fail-safe, savings-only)
        return { resident: false, reason: "error" };
    }
}
