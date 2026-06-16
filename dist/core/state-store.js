"use strict";
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
exports.LockTimeoutError = void 0;
exports.readState = readState;
exports.writeState = writeState;
exports.isLockHeldError = isLockHeldError;
exports.withStateLock = withStateLock;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const atomic_io_1 = require("./atomic-io");
const state_schema_1 = require("./state-schema");
/**
 * Thrown by {@link withStateLock} when the lock cannot be acquired within the
 * timeout. Carries a stable `code` so the CLI boundary maps it to
 * `failure({ error: "state_lock_timeout" })` and `--json` callers get clean
 * output instead of a raw stack (M-3).
 */
class LockTimeoutError extends Error {
    code = "state_lock_timeout";
    constructor(lockDir) {
        super(`state lock timeout: ${lockDir} is held; remove it if no \`th\` process is running.`);
        this.name = "LockTimeoutError";
    }
}
exports.LockTimeoutError = LockTimeoutError;
/** Read + validate state.json. Distinguishes "missing" from "present but invalid". */
function readState(paths) {
    if (!fs.existsSync(paths.stateFile)) {
        return { exists: false };
    }
    const raw = (0, atomic_io_1.readFileWithRetry)(paths.stateFile);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        return { exists: true, raw, issues: [{ path: "$", message: `invalid JSON: ${e.message}` }] };
    }
    const result = (0, state_schema_1.validateState)(parsed);
    if (!result.ok) {
        return { exists: true, raw, issues: result.issues };
    }
    return { exists: true, raw, state: result.state };
}
/**
 * Write state.json atomically (write temp, then rename over the target).
 *
 * The rename is atomic within the directory, so a crashed/partial write is never
 * observed and is *replaced, not duplicated* on resume (spec §18 idempotency).
 */
function writeState(paths, state) {
    // atomicWriteFile retries the rename on transient contention (a concurrent
    // reader holding the file open → EPERM/EACCES/EBUSY on Windows) and, only if
    // the budget is exhausted, throws StateWriteContendedError — which the CLI
    // boundary turns into a clean structured failure (C-2).
    (0, atomic_io_1.atomicWriteFile)(paths.stateFile, (0, state_schema_1.serializeState)(state));
}
/**
 * Run `fn` while holding an exclusive, cross-process advisory lock on the state
 * directory (audit finding F10).
 *
 * Each `th` invocation is a separate OS process. During a parallel build wave,
 * multiple Builders run `th drift add` / `th slice set-status` / `th artifact
 * register` concurrently — each a read-modify-write of state.json (and, for
 * drift, of drift-log.md and the next DRIFT-NNN id). Without a lock, two
 * concurrent mutations lose an update: a dropped requirement-layer `drift add`
 * would leave `drift_open_blocking` too low and let the stop-gate pass a run it
 * should block. This serializes the whole read→write span.
 *
 * The lock is an atomic `mkdir` on `<stateDir>/.state.lock`. It busy-waits
 * (the CLI is synchronous and each critical section is short), times out after
 * ~10s rather than hang forever, and steals a lock older than the stale
 * threshold so a crashed holder can't wedge the project permanently.
 *
 * Contention is recognized by THREE errno codes, not just `EEXIST`: on POSIX a
 * `mkdir` onto an existing dir throws `EEXIST`, but on Windows a concurrent
 * `mkdirSync` against a contended directory can instead throw `EPERM` (and, on
 * some filesystems / antivirus interception, `EACCES`). All three mean "the lock
 * is held — wait / steal-if-stale / retry", so treating only `EEXIST` as
 * contention rethrows the Windows codes and crashes the caller (REQ-PCO-000 /
 * REQ-STATE-LOCK-001 on windows-latest CI). This is the targeted fix only — the
 * mkdir mechanism is unchanged (no migration to flock).
 *
 * When the state directory does not yet exist there is no shared state to race
 * on, so `fn` runs directly without creating anything (preserves the behaviour
 * of commands that return "not initialized").
 */
/**
 * Classify a `mkdirSync` failure as "the lock is already held" (→ wait/steal/
 * retry) versus a genuine error (→ rethrow).
 *
 * Anchor: REQ-PCO-000 — POSIX signals contention with `EEXIST`; on Windows an
 * atomic `mkdir` on a contended directory can instead throw `EPERM` (and
 * sometimes `EACCES`). Treating only `EEXIST` as contention rethrows the Windows
 * codes and crashes the caller (REQ-STATE-LOCK-001 on windows-latest CI). Pure +
 * exported so the classification is unit-tested directly without mocking `fs`.
 */
function isLockHeldError(code) {
    return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}
/** Read the lock's owner token, or null if absent/unreadable. */
function readLockOwner(ownerFile) {
    try {
        return fs.readFileSync(ownerFile, "utf8");
    }
    catch {
        return null;
    }
}
function withStateLock(paths, fn) {
    if (!fs.existsSync(paths.stateDir))
        return fn();
    const lockDir = path.join(paths.stateDir, ".state.lock");
    const ownerFile = path.join(lockDir, "owner");
    // A pid+nonce stamped into the lock on acquire. Used to close the 3-party
    // stale-lock TOCTOU: a waiter only steals the SAME stale lock it observed.
    const myToken = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    // STALE_MS < TIMEOUT_MS so a crashed holder's lock becomes stealable strictly
    // before a healthy waiter gives up (the original had STALE 30s > TIMEOUT 10s,
    // which could wedge waiters: they'd time out before the lock ever went stale).
    const STALE_MS = 5_000;
    const TIMEOUT_MS = 10_000;
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
        try {
            fs.mkdirSync(lockDir); // atomic test-and-set: throws EEXIST (POSIX) / EPERM|EACCES (Windows) if held
            try {
                fs.writeFileSync(ownerFile, myToken, "utf8");
            }
            catch {
                /* best-effort owner stamp; absence just means a steal can't TOCTOU-verify */
            }
            break;
        }
        catch (e) {
            const code = e.code;
            if (!isLockHeldError(code))
                throw e;
            // Held: steal if stale, else wait until the deadline.
            // statSync doubles as the existence check and mtime fetch in one call,
            // avoiding a redundant existsSync + statSync pair. If it throws, the lock
            // dir is absent or inaccessible: for EPERM/EACCES that means a genuine
            // permission error (not contention) so we rethrow the original; for EEXIST
            // the dir just vanished and we retry.
            try {
                const ownerBefore = readLockOwner(ownerFile);
                const age = Date.now() - fs.statSync(lockDir).mtimeMs;
                if (age > STALE_MS) {
                    // TOCTOU guard: only steal if the owner token is unchanged since we
                    // observed the stale lock. If another waiter already stole and
                    // re-acquired (fresh token, or a fresh mtime), we must NOT clobber its
                    // live lock — fall through and retry/wait instead.
                    if (readLockOwner(ownerFile) === ownerBefore) {
                        fs.rmSync(lockDir, { recursive: true, force: true });
                    }
                    continue;
                }
            }
            catch (statErr) {
                if (code === "EPERM" || code === "EACCES")
                    throw e; // genuine permission error
                continue; // EEXIST: lock vanished between mkdir and stat — retry
            }
            if (Date.now() > deadline) {
                throw new LockTimeoutError(lockDir);
            }
            const spinUntil = Date.now() + 20;
            while (Date.now() < spinUntil) {
                /* busy-wait: the CLI has no event loop to yield to */
            }
        }
    }
    try {
        return fn();
    }
    finally {
        try {
            fs.rmSync(lockDir, { recursive: true, force: true });
        }
        catch {
            // Best-effort release; a stale lock is reclaimed by the next caller.
        }
    }
}
