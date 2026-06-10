/**
 * IF-010 PathSandbox — filesystem/shell confinement boundary (REQ-021, ADR-005,
 * RULE-001/003).
 *
 * The data-integrity blast-radius guard. The asymmetry is deliberate (INV-002,
 * ADR-005):
 *  - `checkRead`   → ALWAYS allowed (reads are never confined — read-anywhere).
 *  - `checkWrite` / `checkExecCwd` → allowed IFF the target's REAL path equals or
 *    descends the canonical root. The decision resolves the real path of the
 *    DEEPEST EXISTING ANCESTOR and re-appends the non-existing tail, so a
 *    not-yet-created file inside the root is allowed while a symlink that escapes
 *    the root is caught. ANY resolution doubt/error FAILS CLOSED (rejection).
 *
 * Cross-platform (REQ-NFR-007): on Windows we case-fold and normalize backslashes;
 * elsewhere POSIX semantics apply. The platform-dependent decision is factored into
 * a PURE function (`isContained`) that is parameterized over a path-module seam
 * (path.win32 / path.posix) and a case-fold flag, so confinement can be unit-tested
 * for BOTH separator/casing regimes on a single host (the test driver exercises the
 * POSIX regime on a Windows machine by injecting `path.posix`).
 */
import path from "node:path";
import fs from "node:fs";
import type { PathSandbox, SandboxVerdict } from "./contracts.js";

/** The minimal slice of `node:path` the pure confinement logic needs. */
export interface PathModuleSeam {
  resolve(...segments: string[]): string;
  dirname(p: string): string;
  basename(p: string): string;
  relative(from: string, to: string): string;
  isAbsolute(p: string): boolean;
  readonly sep: string;
}

/** Resolves a path to its real (symlink-resolved) form, or throws on failure. */
export type RealpathFn = (p: string) => string;

/**
 * Tunable confinement policy. `caseFold` is true on Windows (case-insensitive FS),
 * false on POSIX. `pathMod` selects win32 vs posix separator/resolution semantics.
 * `realpath` is the (injectable) symlink resolver. Defaults bind to the live host.
 */
export interface SandboxPolicy {
  caseFold: boolean;
  pathMod: PathModuleSeam;
  realpath: RealpathFn;
}

/** Live-host default policy: case-fold + win32 semantics on Windows, else POSIX. */
export function defaultPolicy(): SandboxPolicy {
  const isWindows = process.platform === "win32";
  return {
    caseFold: isWindows,
    pathMod: isWindows ? path.win32 : path.posix,
    // fs.realpathSync resolves symlinks; on a path that does not exist it throws —
    // callers only ever hand it the deepest EXISTING ancestor, never a missing tail.
    realpath: (p: string) => fs.realpathSync(p),
  };
}

/** Case-fold a path segment for comparison iff the policy is case-insensitive. */
function fold(s: string, caseFold: boolean): string {
  return caseFold ? s.toLowerCase() : s;
}

/**
 * PURE confinement decision. Given a canonical (already real-path-resolved) root
 * and a candidate's real path, return whether the candidate equals or descends the
 * root, under the policy's separator + case-fold semantics. Exposed for direct
 * unit testing of BOTH the Windows and POSIX regimes (REQ-NFR-007).
 */
export function isContained(
  canonicalRoot: string,
  candidateReal: string,
  policy: SandboxPolicy,
): boolean {
  const { pathMod, caseFold } = policy;
  const rootResolved = pathMod.resolve(canonicalRoot);
  const candResolved = pathMod.resolve(candidateReal);
  const foldedRoot = fold(rootResolved, caseFold);
  const foldedCand = fold(candResolved, caseFold);
  if (foldedCand === foldedRoot) {
    return true; // the root itself is contained (equals)
  }
  const rel = pathMod.relative(foldedRoot, foldedCand);
  // Escapes if relative path climbs out (`..`) or is itself absolute (different
  // drive/root). An empty rel means equality (handled above). Otherwise it
  // descends iff it neither starts with `..` nor is absolute.
  if (rel === "" ) {
    return true;
  }
  const climbsOut = rel === ".." || rel.startsWith(".." + pathMod.sep);
  return !climbsOut && !pathMod.isAbsolute(rel);
}

/**
 * Resolve the REAL path of a candidate that may not yet exist: walk up to the
 * deepest EXISTING ancestor, realpath THAT (resolving any symlink in the existing
 * prefix — this is what catches symlink escapes), then re-append the non-existing
 * tail. FAIL-CLOSED: if even the resolution of an existing ancestor throws (a
 * genuinely unresolvable path), we throw so the caller rejects.
 */
export function resolveRealWithTail(
  candidate: string,
  root: string,
  policy: SandboxPolicy,
): string {
  const { pathMod, realpath } = policy;
  // Resolve the candidate to an absolute path against the canonical root first
  // (so traversal / relative inputs are normalized before we test containment).
  const abs = pathMod.isAbsolute(candidate)
    ? pathMod.resolve(candidate)
    : pathMod.resolve(root, candidate);

  // Walk up collecting non-existing tail segments until we hit an existing dir.
  // `dirname` of a filesystem root returns the root itself; we stop when it stops
  // changing (and throw — a candidate with no existing ancestor is fail-closed).
  const tail: string[] = [];
  let cursor = abs;
  for (;;) {
    try {
      // The realpath probe is the existence + symlink-resolution test in one: it
      // succeeds only for an existing path and returns its symlink-resolved form
      // (this is what catches a symlink in the existing prefix that escapes root).
      const real = realpath(cursor);
      // Re-attach the non-existing tail (collected deepest-first via unshift).
      return tail.reduce((acc, seg) => pathMod.resolve(acc, seg), real);
    } catch {
      const parent = pathMod.dirname(cursor);
      if (parent === cursor) {
        // Reached the filesystem root and nothing resolved → fail-closed.
        throw new Error(`unresolvable path (no existing ancestor): ${candidate}`);
      }
      tail.unshift(pathMod.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Build the sandbox. The canonical root is pinned via `realpath` ONCE at
 * construction (so the root comparison is itself symlink-resolved). If the root is
 * not resolvable we fail-closed by pinning the lexically-resolved root and letting
 * every write/exec check reject (a non-resolvable root is a degenerate, unsafe
 * state). The `policy` param is injectable for cross-platform unit testing; it
 * defaults to the live host.
 */
export function createPathSandbox(
  root: string,
  policy: SandboxPolicy = defaultPolicy(),
): PathSandbox {
  const { pathMod, realpath } = policy;
  let canonicalRoot: string;
  try {
    canonicalRoot = realpath(pathMod.resolve(root));
  } catch {
    // Root not resolvable: pin the lexical resolution; write/exec will fail-closed.
    canonicalRoot = pathMod.resolve(root);
  }

  const guard = (candidate: string): SandboxVerdict => {
    // Fail-closed on empty / non-string-ish input.
    if (typeof candidate !== "string" || candidate.length === 0) {
      return {
        allowed: false,
        reason: { code: "PATH_ESCAPE", message: `empty or invalid path` },
      };
    }
    let candidateReal: string;
    try {
      candidateReal = resolveRealWithTail(candidate, canonicalRoot, policy);
    } catch (err) {
      // Any resolution doubt → fail-closed rejection (never a permissive default).
      return {
        allowed: false,
        reason: {
          code: "PATH_ESCAPE",
          message: `unresolvable path (fail-closed): ${candidate} (${(err as Error).message})`,
        },
      };
    }
    if (!isContained(canonicalRoot, candidateReal, policy)) {
      return {
        allowed: false,
        reason: { code: "PATH_ESCAPE", message: `path escapes root: ${candidate}` },
      };
    }
    return { allowed: true, canonicalPath: candidateReal };
  };

  return {
    // Reads are unconditionally allowed (INV-002). We still return the
    // symlink-resolved canonical path of the deepest existing ancestor + tail when
    // we can; if the path is wholly unresolvable we fall back to the lexically
    // resolved absolute path (reads never reject, so this is safe).
    checkRead(p: string): SandboxVerdict {
      let canonicalPath: string;
      try {
        canonicalPath = resolveRealWithTail(p, canonicalRoot, policy);
      } catch {
        canonicalPath = pathMod.isAbsolute(p)
          ? pathMod.resolve(p)
          : pathMod.resolve(canonicalRoot, p);
      }
      return { allowed: true, canonicalPath };
    },
    checkWrite(p: string): SandboxVerdict {
      return guard(p);
    },
    checkExecCwd(cwd: string): SandboxVerdict {
      return guard(cwd);
    },
  };
}
