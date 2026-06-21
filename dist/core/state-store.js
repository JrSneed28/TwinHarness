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
exports.DEFAULT_LOCK_TIMEOUT_MS = exports.realLockOps = exports.STALE_MS = exports.SchemaTooNewError = exports.LockStampError = exports.LockTimeoutError = void 0;
exports.readState = readState;
exports.assertWriteAllowed = assertWriteAllowed;
exports.writeState = writeState;
exports.isLockHeldError = isLockHeldError;
exports.lockTimeoutMs = lockTimeoutMs;
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
        super(`state lock timeout: ${lockDir} is held; if no \`th\` process is running, reclaim it with \`th state unlock\`.`);
        this.name = "LockTimeoutError";
    }
}
exports.LockTimeoutError = LockTimeoutError;
/**
 * Thrown by {@link withStateLock} (R-21) when the owner stamp cannot be written after
 * acquiring the lock, repeatedly, within `MAX_STAMP_FAILS` attempts. This means the
 * filesystem itself is refusing the owner write (full disk, read-only mount, or
 * persistent AV interception of the just-created lock dir) — distinct from
 * `state_lock_timeout` (another process holds the lock). The stamp is MANDATORY: a held
 * but owner-less lock is never stealable (R-08) and the timeout path never reclaims it,
 * so proceeding owner-less and then crashing would brick every future state mutation.
 * Surfaced as a distinct typed error so the operator knows the FS — not a stuck holder —
 * is the problem.
 */
class LockStampError extends Error {
    code = "state_lock_stamp_failed";
    constructor(lockDir) {
        super(`state lock owner-stamp failed: could not write the owner token under ${lockDir} ` +
            `(the filesystem may be read-only/full, or the lock dir is being blocked).`);
        this.name = "LockStampError";
    }
}
exports.LockStampError = LockStampError;
/**
 * Thrown by {@link writeState} (R-33, finding F4) when a MUTATION would clobber a
 * state file this binary is not authorized to rewrite. Two refuse arms (see
 * {@link assertWriteAllowed}):
 *   • the on-disk file VALIDATES and its `schema_version` is NEWER than this
 *     binary's {@link CURRENT_SCHEMA_VERSION} — a forward-compat file an older
 *     binary must NOT silently downgrade; or
 *   • the on-disk file is PRESENT but does not validate (corrupt / partially
 *     written) — never blindly overwritten, and (crucially) never misread as an
 *     "absent fresh first write".
 *
 * On either arm the on-disk file is left BYTE-IDENTICAL: we throw BEFORE the
 * `atomicWriteFile` rename, so nested + top-level future fields survive intact.
 *
 * Carries a stable `code = "schema_too_new"` so the single CLI boundary
 * (`mapDispatchError`) and the MCP `callTool` boundary map it to a clean
 * structured failure — matching the convention the lock/contention errors use.
 * Reads NEVER raise this: `readState` / `th doctor` only WARN on a too-new file.
 */
class SchemaTooNewError extends Error {
    onDisk;
    current;
    code = "schema_too_new";
    constructor(
    /** The on-disk `schema_version` that triggered the refusal (undefined when the file is present-but-invalid). */
    onDisk, 
    /** This binary's current schema version (the ceiling we refuse above). */
    current, message) {
        super(message);
        this.onDisk = onDisk;
        this.current = current;
        this.name = "SchemaTooNewError";
    }
}
exports.SchemaTooNewError = SchemaTooNewError;
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
 * R-33 / finding F4 — the SINGLE mutation-boundary refuse seam. Decide whether a
 * pending state-mutation may overwrite whatever is on disk RIGHT NOW, leaving the
 * file byte-identical if not.
 *
 * Called by {@link writeState} (the one universal state.json write chokepoint —
 * every mutating command, including `th init` which bypasses `withStateLock`,
 * ends here), so EVERY mutating command inherits the refusal without per-command
 * wiring.
 *
 * The first-write predicate is keyed on the VALIDATED-STATE result, NEVER on a
 * bare `existsSync`/try-catch — that is the truncation trap (a partially-written
 * future file misread as "absent" and wrongly allowed). The four arms:
 *
 *   1. No state file present                         → ALLOW (fresh first write).
 *   2. File validates AND schema_version === undefined → ALLOW (legacy v1, a
 *                                                        normal first/ongoing write).
 *   2b. File validates AND schema_version <= CURRENT  → ALLOW (the ordinary case:
 *                                                        an in-range existing run).
 *   3. File PRESENT but does NOT validate (corrupt /  → REFUSE: take the existing
 *      partially-written future)                        invalid-state path; NEVER
 *                                                        misread as an absent fresh
 *                                                        write, NEVER clobbered.
 *   4. File validates AND schema_version > CURRENT    → REFUSE `schema_too_new`.
 *
 * Arms 3 and 4 both throw {@link SchemaTooNewError} — BEFORE the serialize/rename
 * in {@link writeState} — so the on-disk bytes (nested + top-level future fields)
 * survive intact. Precedent making the validated-state key safe: `validateState`
 * treats an absent `schema_version` as legacy-v1 (structurally valid) but a
 * non-integer / `< 1` value as a HARD error, so a present-but-corrupt newer file
 * FAILS `validateState` first → arm 3 → never mistaken for arm 1.
 */
function assertWriteAllowed(paths) {
    // Arm 1 — no file on disk: a genuine fresh first write. Note we DELEGATE the
    // present/absent decision to the read+validate below rather than trusting
    // `existsSync` alone for the refuse arms: existsSync only gates the cheap
    // "nothing here yet" case; a present file's verdict comes from validateState.
    if (!fs.existsSync(paths.stateFile))
        return;
    // Read the CURRENT on-disk bytes and validate. A present file that fails to
    // parse or validate is arm 3 (corrupt/partial) — refuse rather than clobber,
    // and (critically) never let a truncated future file masquerade as absent.
    let raw;
    try {
        raw = (0, atomic_io_1.readFileWithRetry)(paths.stateFile);
    }
    catch {
        // Present (existsSync true) but unreadable right now — treat as the
        // invalid/corrupt arm; do not overwrite something we cannot inspect.
        throw new SchemaTooNewError(undefined, state_schema_1.CURRENT_SCHEMA_VERSION, `Refusing to mutate state.json: the file is present but could not be read to verify its schema version. ` +
            `Resolve the read error before mutating.`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new SchemaTooNewError(undefined, state_schema_1.CURRENT_SCHEMA_VERSION, `Refusing to mutate state.json: the on-disk file is present but not valid JSON (corrupt or partially written). ` +
            `Repair it (e.g. \`th doctor\`, then \`th migrate\`) before mutating; the file is left untouched.`);
    }
    const result = (0, state_schema_1.validateState)(parsed);
    if (!result.ok) {
        // Arm 3 — present but invalid: refuse, leave byte-identical. This is the SAME
        // existing invalid-state path corrupt files already take; a present-but-corrupt
        // FUTURE file lands here (not arm 1) because validateState rejects a non-integer
        // / `< 1` schema_version as a hard error.
        throw new SchemaTooNewError(undefined, state_schema_1.CURRENT_SCHEMA_VERSION, `Refusing to mutate state.json: the on-disk file is present but does not validate (corrupt or partially written). ` +
            `Repair it before mutating; the file is left untouched.`);
    }
    const onDisk = result.state.schema_version;
    // Arms 2 / 2b — absent (legacy v1) or in-range version: ALLOW.
    if (onDisk === undefined || onDisk <= state_schema_1.CURRENT_SCHEMA_VERSION)
        return;
    // Arm 4 — validates but NEWER than this binary: refuse `schema_too_new`, leave
    // byte-identical (a newer binary wrote it; we must not silently downgrade).
    throw new SchemaTooNewError(onDisk, state_schema_1.CURRENT_SCHEMA_VERSION, `Refusing to mutate state.json: it is schema v${onDisk}, newer than this th (v${state_schema_1.CURRENT_SCHEMA_VERSION}). ` +
        `Upgrade th; refusing to downgrade. The file is left untouched.`);
}
/**
 * Write state.json atomically (write temp, then rename over the target).
 *
 * The rename is atomic within the directory, so a crashed/partial write is never
 * observed and is *replaced, not duplicated* on resume (spec §18 idempotency).
 *
 * R-33 / F4: BEFORE serializing/replacing, the mutation-boundary seam
 * ({@link assertWriteAllowed}) is consulted. If the on-disk file is a too-new
 * (forward-compat) state or present-but-corrupt, it throws {@link SchemaTooNewError}
 * here — before any byte is written — so the file is left byte-identical and the
 * older binary cannot clobber/downgrade it. This is the SINGLE seam every mutating
 * command inherits (init included, which does not take `withStateLock`).
 */
function writeState(paths, state) {
    // R-33: refuse the mutation at the boundary if the on-disk file is too-new or
    // corrupt — throws SchemaTooNewError and leaves the file byte-identical (no
    // serialize-rewrite). Runs for EVERY writer because this is the one chokepoint.
    assertWriteAllowed(paths);
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
 * R-35 / finding F6 — the PRE-INIT window MUST be locked too. The lock dir lives
 * UNDER `<stateDir>`, so when `<stateDir>` does not yet exist there is nowhere to
 * place it. The old code treated that as "no shared state to race on" and ran `fn`
 * UNLOCKED — but a wave of concurrent first-writers against a FRESH root each
 * read-init-write `state.json` with NO shared lock covering the read→write span, so
 * all but one update is lost (the classic 28/29/30-of-30 loss). That is precisely
 * the race a lock exists to prevent, and it is WORST at init (every writer starts
 * from the same empty state and clobbers the others). So we now CREATE `<stateDir>`
 * (idempotent `mkdir -p`) and fall through into the normal lock loop, covering the
 * pre-init read-modify-write under the held lock. Creating an empty state dir is
 * inert: with no `state.json` in it `readState` still returns `{exists:false}`, so a
 * "not initialized" command observes the same verdict. The first locked write to a
 * fresh root is then ALLOWED by {@link assertWriteAllowed} (arm 1: no file ⇒ allow);
 * F4's refuse arms now run UNDER the held lock (complementary, not conflicting). The
 * owner-stamp R-08/R-23 semantics are unchanged (the same loop, same token).
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
/** Default lock-acquisition deadline (ms). Kept < no realistic critical section. */
exports.DEFAULT_LOCK_TIMEOUT_MS = 25_000;
/**
 * The lock-acquisition deadline (ms): {@link DEFAULT_LOCK_TIMEOUT_MS} (25s) unless
 * `TH_LOCK_TIMEOUT_MS` overrides it. The override grants more PATIENCE for heavy
 * cross-process contention under I/O pressure — an oversubscribed CI runner spawning
 * the concurrency stress tests, or an operator on a slow/networked filesystem — where
 * an unlucky waiter can otherwise be scheduler-starved past 25s and fail a write that
 * would have landed. It changes ONLY how long a waiter waits: steal-if-stale (STALE_MS),
 * the owner-token TOCTOU guard, and acquisition are all unchanged. A non-numeric or
 * non-positive value falls back to the default. Keep STALE_MS < the effective timeout
 * so a crashed holder stays reclaimable.
 */
function lockTimeoutMs() {
    const raw = process.env.TH_LOCK_TIMEOUT_MS;
    if (raw === undefined)
        return exports.DEFAULT_LOCK_TIMEOUT_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : exports.DEFAULT_LOCK_TIMEOUT_MS;
}
function withStateLock(paths, fn, ops = exports.realLockOps) {
    // R-35 / F6: the lock dir lives under `<stateDir>`. Ensure `<stateDir>` exists so a
    // FRESH-root first-writer wave is serialized under the lock (the pre-init window),
    // instead of bypassing the lock and racing N read-init-writes into a lost-update.
    // Idempotent: existing projects' `mkdir -p` is a no-op, and an empty state dir with
    // no `state.json` still reads as "not initialized" (readState → {exists:false}).
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const lockDir = path.join(paths.stateDir, ".state.lock");
    const ownerFile = path.join(lockDir, "owner");
    // A pid+nonce stamped into the lock on acquire. Used to close the 3-party
    // stale-lock TOCTOU: a waiter only steals the SAME stale lock it observed.
    const myToken = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    // STALE_MS is the module-level exported constant (15 s). See its declaration
    // above for the full rationale. Referenced here by name so tests can import
    // it and use STALE_MS + N instead of hardcoding the magic literal (TEST-006).
    const TIMEOUT_MS = lockTimeoutMs(); // default 25s; TH_LOCK_TIMEOUT_MS override (see lockTimeoutMs)
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
    // R-21: cap consecutive owner-stamp failures so a genuinely unwritable FS surfaces a
    // distinct LockStampError WELL within the 25s deadline, instead of retrying to timeout.
    const MAX_STAMP_FAILS = 3;
    let stampFails = 0;
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
            // lock whose token is unchanged (the TOCTOU guard below).
            //
            // R-21: the stamp is MANDATORY, not best-effort. If it throws (Windows AV/contention
            // can deny the write to the just-created lock dir), we must NOT proceed into fn()
            // holding an OWNER-LESS lock: such a lock is never stealable (R-08) and the deadline
            // path only throws — it never reclaims — so a crash while holding one would brick
            // EVERY future state mutation until a manual `th state unlock`. Instead, release our
            // OWN just-acquired lock and retry. Releasing is race-free wrt R-08: WE are the
            // holder, so this removes our own lock, and a waiter cannot have stolen an owner-less
            // lock (the guard below forbids it). The lock is therefore owner-less only transiently
            // (we hold nothing across the retry). A genuinely unwritable FS is bounded: after
            // MAX_STAMP_FAILS consecutive failures we surface a distinct LockStampError well
            // within the 25s deadline (the loop-head deadline still bounds the interim retries).
            try {
                ops.writeOwner(ownerFile, myToken);
            }
            catch {
                stampFails++;
                try {
                    ops.remove(lockDir);
                }
                catch {
                    /* best-effort release of our own just-acquired lock */
                }
                if (stampFails >= MAX_STAMP_FAILS)
                    throw new LockStampError(lockDir);
                backoff();
                continue;
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
