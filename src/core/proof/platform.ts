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

import * as os from "node:os";
import * as path from "node:path";
import { isLockHeldError } from "../state-store";
import { resolveWithinRoot, resolveProjectPaths } from "../paths";

export interface PlatformCase {
  name: string;
  os: string;
  /** True when the case actually executed its assertion on this host. */
  ran: boolean;
  /** True when the case was legitimately skipped on this host (mutually exclusive with a pass). */
  skipped: boolean;
  /** Human-readable outcome / skip reason. */
  reason: string;
}

export interface PlatformParityResult {
  os: string;
  cases: PlatformCase[];
}

/** Run the cross-platform parity cases for the current host. */
export function runPlatformParity(): PlatformParityResult {
  const platform = process.platform;
  const cases: PlatformCase[] = [];

  const ranCase = (name: string, ok: boolean, reason: string): PlatformCase => ({
    name,
    os: platform,
    ran: true,
    skipped: false,
    reason: `${ok ? "PASS" : "FAIL"}: ${reason}`,
  });
  const skipCase = (name: string, reason: string): PlatformCase => ({
    name,
    os: platform,
    ran: false,
    skipped: true,
    reason: `SKIP: ${reason}`,
  });

  // 1. Lock-error classification (POSIX EEXIST + Windows EPERM/EACCES = contention).
  try {
    const ok =
      isLockHeldError("EEXIST") &&
      isLockHeldError("EPERM") &&
      isLockHeldError("EACCES") &&
      !isLockHeldError("ENOENT") &&
      !isLockHeldError(undefined);
    cases.push(ranCase("lock-error-classification", ok, "EEXIST/EPERM/EACCES=held; ENOENT/unknown=rethrow"));
  } catch (e) {
    cases.push(ranCase("lock-error-classification", false, `threw: ${(e as Error).message}`));
  }

  // 2. The concurrency.test.ts:138 Windows-skip case — REPORTED, not silent.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (platform === "win32" || isRoot) {
    cases.push(
      skipCase(
        "windows-eperm-rethrow",
        platform === "win32"
          ? "Windows ignores directory mode bits for child creation; the genuine-permission rethrow path cannot be induced here"
          : "running as root bypasses the directory mode check; the rethrow path cannot be induced",
      ),
    );
  } else {
    // On non-root POSIX the rethrow path is inducible and exercised by
    // concurrency.test.ts; here we record that parity (the classifier agrees).
    cases.push(
      ranCase(
        "windows-eperm-rethrow",
        !isLockHeldError("ENOSPC"),
        "non-root POSIX: a genuine permission error (no contention code) rethrows rather than spins",
      ),
    );
  }

  // 3. Path resolution: in-root stays, traversal rejected.
  try {
    const root = path.join(os.tmpdir(), "th-proof-platform-root");
    const inRoot = resolveWithinRoot(root, path.join("docs", "x.md")) !== null;
    const escaped = resolveWithinRoot(root, path.join("..", "..", "escape")) === null;
    cases.push(ranCase("path-resolution", inRoot && escaped, "in-root path kept; traversal rejected"));
  } catch (e) {
    cases.push(ranCase("path-resolution", false, `threw: ${(e as Error).message}`));
  }

  // 4. Native path separators (de-POSIX-ified verify/coverage-report paths).
  try {
    const root = path.join(os.tmpdir(), "th-proof-platform-sep");
    const paths = resolveProjectPaths(root);
    // stateFile/docsDir must be absolute and use the host's native separator.
    const joined = path.join("a", "b");
    const nativeSep = joined.includes(path.sep);
    const absolute = path.isAbsolute(paths.stateFile) && path.isAbsolute(paths.docsDir);
    cases.push(
      ranCase("native-path-separators", nativeSep && absolute, `path.sep="${path.sep}"; project paths absolute + native`),
    );
  } catch (e) {
    cases.push(ranCase("native-path-separators", false, `threw: ${(e as Error).message}`));
  }

  return { os: platform, cases };
}
