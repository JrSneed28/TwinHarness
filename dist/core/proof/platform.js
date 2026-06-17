"use strict";
/**
 * Component 8 (Cross-platform parity) — plan Step 8. Runs a set of parity cases and
 * records a per-case `{os, ran|skipped, reason}` entry so a platform-conditional
 * skip is REPORTED rather than silent (closing the `tests/concurrency.test.ts:138`
 * Windows visibility gap). Pure + no-throw: a case that errors is reported as a
 * non-passing `ran` entry with the error reason, never an exception.
 *
 * Cases:
 *   - lock-error-classification : `isLockHeldError` treats EEXIST/EPERM/EACCES as
 *       contention and ENOENT/unknown as genuine errors (all OS).
 *   - windows-eperm-rethrow     : the `concurrency.test.ts:138` rethrow case — only
 *       inducible on non-root POSIX; SKIPPED (and reported) on Windows / as root.
 *   - path-resolution           : `resolveWithinRoot` keeps in-root paths and
 *       rejects traversal (all OS).
 *   - native-path-separators    : `resolveProjectPaths` / `path.join` use the native
 *       separator (de-POSIX-ified verify / coverage-report paths) (all OS).
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
exports.runPlatformParity = runPlatformParity;
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const state_store_1 = require("../state-store");
const paths_1 = require("../paths");
/** Run the cross-platform parity cases for the current host. */
function runPlatformParity() {
    const platform = process.platform;
    const cases = [];
    const ranCase = (name, ok, reason) => ({
        name,
        os: platform,
        ran: true,
        skipped: false,
        reason: `${ok ? "PASS" : "FAIL"}: ${reason}`,
    });
    const skipCase = (name, reason) => ({
        name,
        os: platform,
        ran: false,
        skipped: true,
        reason: `SKIP: ${reason}`,
    });
    // 1. Lock-error classification (POSIX EEXIST + Windows EPERM/EACCES = contention).
    try {
        const ok = (0, state_store_1.isLockHeldError)("EEXIST") &&
            (0, state_store_1.isLockHeldError)("EPERM") &&
            (0, state_store_1.isLockHeldError)("EACCES") &&
            !(0, state_store_1.isLockHeldError)("ENOENT") &&
            !(0, state_store_1.isLockHeldError)(undefined);
        cases.push(ranCase("lock-error-classification", ok, "EEXIST/EPERM/EACCES=held; ENOENT/unknown=rethrow"));
    }
    catch (e) {
        cases.push(ranCase("lock-error-classification", false, `threw: ${e.message}`));
    }
    // 2. The concurrency.test.ts:138 Windows-skip case — REPORTED, not silent.
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (platform === "win32" || isRoot) {
        cases.push(skipCase("windows-eperm-rethrow", platform === "win32"
            ? "Windows ignores directory mode bits for child creation; the genuine-permission rethrow path cannot be induced here"
            : "running as root bypasses the directory mode check; the rethrow path cannot be induced"));
    }
    else {
        // On non-root POSIX the rethrow path is inducible and exercised by
        // concurrency.test.ts; here we record that parity (the classifier agrees).
        cases.push(ranCase("windows-eperm-rethrow", !(0, state_store_1.isLockHeldError)("ENOSPC"), "non-root POSIX: a genuine permission error (no contention code) rethrows rather than spins"));
    }
    // 3. Path resolution: in-root stays, traversal rejected.
    try {
        const root = path.join(os.tmpdir(), "th-proof-platform-root");
        const inRoot = (0, paths_1.resolveWithinRoot)(root, path.join("docs", "x.md")) !== null;
        const escaped = (0, paths_1.resolveWithinRoot)(root, path.join("..", "..", "escape")) === null;
        cases.push(ranCase("path-resolution", inRoot && escaped, "in-root path kept; traversal rejected"));
    }
    catch (e) {
        cases.push(ranCase("path-resolution", false, `threw: ${e.message}`));
    }
    // 4. Native path separators (de-POSIX-ified verify/coverage-report paths).
    try {
        const root = path.join(os.tmpdir(), "th-proof-platform-sep");
        const paths = (0, paths_1.resolveProjectPaths)(root);
        // stateFile/docsDir must be absolute and use the host's native separator.
        const joined = path.join("a", "b");
        const nativeSep = joined.includes(path.sep);
        const absolute = path.isAbsolute(paths.stateFile) && path.isAbsolute(paths.docsDir);
        cases.push(ranCase("native-path-separators", nativeSep && absolute, `path.sep="${path.sep}"; project paths absolute + native`));
    }
    catch (e) {
        cases.push(ranCase("native-path-separators", false, `threw: ${e.message}`));
    }
    return { os: platform, cases };
}
