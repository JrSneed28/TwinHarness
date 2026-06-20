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
exports.realLockOps = exports.STALE_MS = exports.LockTimeoutError = void 0;
exports.readState = readState;
exports.writeState = writeState;
exports.isLockHeldError = isLockHeldError;
exports.withStateLock = withStateLock;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const atomic_io_1 = require("./atomic-io");
const sleep_1 = require("./sleep");
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
        return { exists: true, raw, issues: result.issues, warnings: result.warnings };
    }
    // Self-heal a legacy (pre-v2) `interview_threshold` into `interview_cutoff` on
    // read so a mutating read-modify-write that happens BEFORE `th migrate` does not
    // silently DROP the (un-inverted) value: `interview_threshold` is now an unknown
    // key, so `serializeState` would omit it on the next write and the later migrate
    // would fall back to the default cutoff — a silent gate change. Mirrors the
    // state.json v1→v2 migration and the interview.json lazy upgrade
    // (cutoff = 1 − threshold). Idempotent; does not stamp schema_version, so a
    // subsequent `th migrate` still runs the version step.
    const state = result.state;
    if (state) {
        if (state.interview_cutoff === undefined && typeof state.interview_threshold === "number") {
            state.interview_cutoff = 1 - state.interview_threshold;
        }
        delete state.interview_threshold;
    }
    // A valid file may still carry non-fatal warnings (e.g. an unknown top-level
    // key); thread them through so callers like `th state verify` can surface them.
    return { exists: true, raw, state, warnings: result.warnings };
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
    (0, atomic_io_1.atomicWriteFile)(paths.stateFile, (0, state_schema_1.serializeState)(state), { root: paths.root });
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
 * The lock is an atomic `mkdir` on `<stateDir>/.state.lock`. It waits between
 * attempts with a zero-CPU {@link sleepSync} (the CLI is synchronous and each
 * critical section is short; the old `while`-spin pegged a core, PERF-007), times out after
 * ~25s rather than hang forever, and steals a lock older than the stale
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
/**
 * Age (ms) after which an unrefreshed `.state.lock` is considered stale and
 * may be stolen by a waiting caller. Exported so tests can use `STALE_MS + N`
 * rather than hardcoding the magic literal (TEST-006).
 *
 * Keep STALE_MS < TIMEOUT_MS (25 s) so a crashed holder is always reclaimable
 * before a healthy waiter times out.
 */
exports.STALE_MS = 15_000;
/** Production lock ops — the real clock + sleep + `node:fs` primitives. */
exports.realLockOps = {
    now: Date.now,
    sleep: sleep_1.sleepSync,
    acquire: (lockDir) => fs.mkdirSync(lockDir),
    mtimeMs: (lockDir) => fs.statSync(lockDir).mtimeMs,
    remove: (lockDir) => fs.rmSync(lockDir, { recursive: true, force: true }),
    readOwner: readLockOwner,
    writeOwner: (ownerFile, token) => fs.writeFileSync(ownerFile, token, "utf8"),
};
function withStateLock(paths, fn, ops = exports.realLockOps) {
    if (!fs.existsSync(paths.stateDir))
        return fn();
    const lockDir = path.join(paths.stateDir, ".state.lock");
    const ownerFile = path.join(lockDir, "owner");
    // A pid+nonce stamped into the lock on acquire. Used to close the 3-party
    // stale-lock TOCTOU: a waiter only steals the SAME stale lock it observed.
    const myToken = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    // STALE_MS is the module-level exported constant (15 s). See its declaration
    // above for the full rationale. Referenced here by name so tests can import
    // it and use STALE_MS + N instead of hardcoding the magic literal (TEST-006).
    const TIMEOUT_MS = 25_000;
    const deadline = ops.now() + TIMEOUT_MS;
    // Backoff-with-jitter for the inter-attempt wait (PERF-008). A FIXED cadence
    // made N contending writers wake in lock-step (thundering herd) and collide on
    // the same mkdir over and over. Instead, grow the wait per failed attempt
    // (5,10,20,40,80 ms) capped at BACKOFF_CAP_MS, and pick the actual sleep
    // uniformly in [0, backoff) ("full jitter") so contenders desynchronize.
    //
    // This ONLY changes how long a waiter sleeps between attempts — never whether
    // it may steal-if-stale or acquire. TIMEOUT_MS (25s), STALE_MS stealing, and
    // the owner-token TOCTOU guard are all unchanged.
    //
    // The cap (80 ms) is kept far below TIMEOUT_MS so a freed lock is re-acquired
    // promptly (worst-case extra latency after a release is one ~80ms nap). With a
    // ~80ms ceiling the expected per-attempt sleep is ~40ms, giving each waiter
    // ~25 acquisition attempts/sec; that comfortably supports tens of concurrent
    // writers (the realistic ceiling for a parallel `th` build wave) without the
    // lock-step collisions of the old fixed wait. Backoff is per-call state, so it
    // resets between invocations and never accumulates across critical sections.
    const BACKOFF_BASE_MS = 5;
    const BACKOFF_CAP_MS = 80;
    let attempt = 0;
    // Zero-CPU backoff-with-jitter for THIS failed attempt (PERF-007 / PERF-008): the
    // ceiling is BACKOFF_BASE_MS * 2^attempt clamped to BACKOFF_CAP_MS, and we sleep a
    // uniform [0, ceiling) ("full jitter") so N contenders desynchronize instead of
    // waking in lock-step. Applied on EVERY non-acquiring retry path below — the plain
    // wait, the post-steal retry, AND the EEXIST-vanished retry — so none can busy-loop
    // or overrun TIMEOUT_MS (#3).
    const backoff = () => {
        const backoffCeil = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
        attempt++;
        ops.sleep(Math.random() * backoffCeil);
    };
    for (;;) {
        // Deadline at the LOOP HEAD (#3): checked before EVERY acquire/steal/stat attempt
        // so no retry path can overrun TIMEOUT_MS. Previously this lived AFTER the
        // steal/stat block, so the post-steal and EEXIST-vanished `continue`s jumped past
        // it: a churning stale lock (owner token changes each read → never actually
        // stolen) or a lock that keeps vanishing/reappearing would `continue` forever,
        // bypassing both the deadline AND the backoff and pegging the loop.
        if (ops.now() > deadline) {
            throw new LockTimeoutError(lockDir);
        }
        try {
            ops.acquire(lockDir); // atomic test-and-set: throws EEXIST (POSIX) / EPERM|EACCES (Windows) if held
            // Stamp the owner token BEFORE declaring acquisition success so a LIVE lock is
            // reliably steal-eligible-and-verifiable: a waiter only steals a STAMPED stale
            // lock whose token is unchanged (the TOCTOU guard below). Best-effort — if the
            // stamp throws (swallowed; common on Windows under AV/contention) the lock is
            // owner-less, and per R-08 an owner-less lock is NEVER stolen, only reclaimed via
            // the ~25s TIMEOUT_MS path. So a swallowed stamp can only DELAY a crashed holder's
            // reclamation to the timeout — it can never let two actors enter the section.
            try {
                ops.writeOwner(ownerFile, myToken);
            }
            catch {
                /* best-effort owner stamp; absence makes this lock un-stealable (R-08), not unsafe */
            }
            break;
        }
        catch (e) {
            const code = e.code;
            if (!isLockHeldError(code))
                throw e;
            // Held: steal if stale, else wait. statSync doubles as the existence check and
            // mtime fetch in one call. If it throws, the lock dir was momentarily absent or
            // inaccessible BECAUSE the lock is under active contention/steal-churn — ANY
            // such stat failure (ENOENT vanish or EPERM/EACCES half-replaced dir) is treated
            // symmetrically: back off and retry, bounded by the loop-head deadline
            // (REQ-STATE-LOCK-003).
            try {
                const ownerBefore = ops.readOwner(ownerFile);
                // R-08 — NEVER steal an OWNER-LESS lock. `readOwner` returns null both on a
                // read failure AND when the owner stamp is simply absent (the holder's
                // best-effort `writeOwner` threw and was swallowed — common on Windows under
                // AV/contention — or a crashed/legacy owner-less lock). With a null
                // `ownerBefore` the TOCTOU guard below degrades to `null === null` → TRUE for
                // EVERY waiter, so two waiters could both pass it and both `remove()`, letting
                // a fresh third holder's LIVE lock be clobbered → two actors in `fn()` (the
                // lost-update the lock exists to prevent). Only a STAMPED lock is steal-eligible;
                // an unstamped lock is reclaimed via the ~25s TIMEOUT_MS path, never stolen. Back
                // off and retry (bounded by the loop-head deadline) instead of the age/steal check.
                if (ownerBefore === null) {
                    backoff(); // owner-less → not steal-eligible; wait it out to the timeout (#3)
                    continue;
                }
                const age = ops.now() - ops.mtimeMs(lockDir);
                if (age > exports.STALE_MS) {
                    // TOCTOU guard: only steal if the owner token is unchanged since we
                    // observed the stale lock. If another waiter already stole and
                    // re-acquired (fresh token, or a fresh mtime), we must NOT clobber its
                    // live lock — fall through and retry/wait instead. (`ownerBefore` is now
                    // provably non-null here, so this compares two real stamps, never null===null.)
                    if (ops.readOwner(ownerFile) === ownerBefore) {
                        ops.remove(lockDir);
                    }
                    backoff(); // bound the post-steal retry — re-checks the deadline at the head (#3)
                    continue;
                }
            }
            catch {
                // The lock was HELD (acquire threw a contention code) but the follow-up stat
                // failed. ANY stat failure here is the SAME steal-churn race — never a verdict
                // on its own — so we back off and retry, bounded by the loop-head deadline
                // (REQ-STATE-LOCK-003). Both stat-failure shapes are the contention we are
                // already in the middle of waiting out:
                //   • stat ENOENT → the holder released the lock between our mkdir and the
                //     stat (the textbook vanish race). The dominant Windows path: a
                //     *contention* EPERM from mkdir (see isLockHeldError) immediately
                //     followed by the holder's release (REQ-STATE-LOCK-002).
                //   • stat EPERM/EACCES → ANOTHER waiter was concurrently rmdir+mkdir-ing this
                //     same lock dir mid-steal, so the stat momentarily hit a half-replaced dir
                //     and threw a TRANSIENT permission code. Because the acquire just threw a
                //     contention code and we are still under the deadline, this is steal-churn,
                //     NOT a genuine permission fault. The old code misclassified it and rethrew
                //     the original EEXIST/EPERM, crashing the caller with a raw errno under load
                //     (windows-latest flake lineage REQ-STATE-LOCK-001/-002, resurfaced under
                //     the heavier contention the audit PR #20's fsync change induces).
                // Deliberate tradeoff (fail-safe over fail-fast-but-crash): a state dir that is
                // GENUINELY permission-denied no longer rethrows a raw errno immediately — it
                // backs off until TIMEOUT_MS (25s) and then surfaces a TYPED, BOUNDED
                // LockTimeoutError, the same well-typed boundary the CLI already maps to a clean
                // `state_lock_timeout` failure. No separate retry counter is needed: the loop's
                // existing "the deadline is the ultimate bound" philosophy means the same 25s
                // deadline that already caps a genuinely-stuck holder also caps a genuinely-denied
                // dir, applying the ENOENT path's treatment symmetrically to every stat failure.
                backoff(); // bound the steal-churn retry (#3) — re-checks the deadline at the head
                continue; // stat failed mid-steal-churn — back off and retry
            }
            // Plain wait path (held + not stale): back off, then retry from the loop head
            // (which enforces the deadline). The old `while`-spin pegged a core here.
            backoff();
        }
    }
    try {
        return fn();
    }
    finally {
        try {
            ops.remove(lockDir);
        }
        catch {
            // Best-effort release; a stale lock is reclaimed by the next caller.
        }
    }
}
