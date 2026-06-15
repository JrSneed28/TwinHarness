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
exports.readState = readState;
exports.writeState = writeState;
exports.isLockHeldError = isLockHeldError;
exports.withStateLock = withStateLock;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const state_schema_1 = require("./state-schema");
/** Read + validate state.json. Distinguishes "missing" from "present but invalid". */
function readState(paths) {
    if (!fs.existsSync(paths.stateFile)) {
        return { exists: false };
    }
    const raw = fs.readFileSync(paths.stateFile, "utf8");
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
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const serialized = (0, state_schema_1.serializeState)(state);
    const tmp = path.join(paths.stateDir, `state.json.tmp-${process.pid}`);
    fs.writeFileSync(tmp, serialized, "utf8");
    fs.renameSync(tmp, paths.stateFile);
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
function withStateLock(paths, fn) {
    if (!fs.existsSync(paths.stateDir))
        return fn();
    const lockDir = path.join(paths.stateDir, ".state.lock");
    const STALE_MS = 30_000;
    const TIMEOUT_MS = 10_000;
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
        try {
            fs.mkdirSync(lockDir); // atomic test-and-set: throws EEXIST (POSIX) / EPERM|EACCES (Windows) if held
            break;
        }
        catch (e) {
            if (!isLockHeldError(e.code))
                throw e;
            // Held: steal if stale, else wait until the deadline.
            try {
                const age = Date.now() - fs.statSync(lockDir).mtimeMs;
                if (age > STALE_MS) {
                    fs.rmSync(lockDir, { recursive: true, force: true });
                    continue;
                }
            }
            catch {
                continue; // lock vanished between mkdir and stat — retry
            }
            if (Date.now() > deadline) {
                throw new Error(`state lock timeout: ${lockDir} is held; remove it if no \`th\` process is running.`);
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
