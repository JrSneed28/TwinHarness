/**
 * SLICE-3 / TASK-007 — PathSandbox confinement (REQ-021 read/search half, REQ-NFR-007).
 *
 * The data-integrity blast-radius guard. These tests drive the PURE confinement
 * decision under BOTH path regimes on a single (Windows) host by injecting the
 * path-module seam (`path.posix` vs `path.win32`) and the case-fold flag, plus a
 * scripted `realpath` so symlink-escape is asserted deterministically WITHOUT
 * needing a real POSIX filesystem or symlink-creation privileges (REQ-NFR-007).
 *
 * checkRead is ALWAYS allowed (INV-002); checkWrite/checkExecCwd are allowed IFF
 * the target's real path equals/descends the canonical root, and FAIL CLOSED on any
 * resolution doubt.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPathSandbox,
  isContained,
  type SandboxPolicy,
} from "../src/path-sandbox.js";

/**
 * Build a policy with an INJECTED realpath map so we control symlink resolution.
 * `realMap` maps an absolute (already pathMod-resolved) input to its resolved real
 * path; an entry whose value differs from its key models a symlink. Any path not in
 * the map (and not a prefix of one) is treated as non-existent (realpath throws),
 * which drives the deepest-existing-ancestor + tail walk and the fail-closed path.
 */
function policyWith(opts: {
  posix: boolean;
  existing: Record<string, string>;
}): SandboxPolicy {
  const pathMod = opts.posix ? path.posix : path.win32;
  return {
    caseFold: !opts.posix, // Windows case-folds; POSIX does not
    pathMod,
    realpath: (p: string) => {
      const key = pathMod.resolve(p);
      // Case-fold the lookup key on Windows so the map can be written naturally.
      const lookup = opts.posix ? key : key.toLowerCase();
      for (const [k, v] of Object.entries(opts.existing)) {
        const fk = opts.posix ? pathMod.resolve(k) : pathMod.resolve(k).toLowerCase();
        if (fk === lookup) return v;
      }
      throw new Error(`ENOENT (scripted): ${p}`);
    },
  };
}

// Anchor: REQ-NFR-007.
describe("SLICE-3 PathSandbox confinement (REQ-021 partial / REQ-NFR-007)", () => {
  it("test_REQNFR007_path_confinement_windows_and_posix", () => {
    // ---- POSIX regime --------------------------------------------------------
    // Root and an in-root subtree exist and resolve to themselves (no symlink).
    const posixRoot = "/work/project";
    const posix = policyWith({
      posix: true,
      existing: {
        "/work/project": "/work/project",
        "/work/project/src": "/work/project/src",
        // A symlink INSIDE the root whose real target ESCAPES the root.
        "/work/project/escape-link": "/etc/passwd-dir",
        "/work": "/work",
        "/etc/passwd-dir": "/etc/passwd-dir",
      },
    });
    const sbPosix = createPathSandbox(posixRoot, posix);

    // Reads are ALWAYS allowed (INV-002), even outside the root.
    expect(sbPosix.checkRead("/etc/shadow").allowed).toBe(true);

    // In-root existing dir → write allowed, canonical path returned.
    const inRoot = sbPosix.checkWrite("/work/project/src");
    expect(inRoot.allowed).toBe(true);
    expect(inRoot.canonicalPath).toBe("/work/project/src");

    // Not-yet-created file INSIDE the root (deepest existing ancestor = src) → allowed.
    const newFile = sbPosix.checkWrite("/work/project/src/new-file.ts");
    expect(newFile.allowed).toBe(true);
    expect(newFile.canonicalPath).toBe("/work/project/src/new-file.ts");

    // Traversal escape (absolute, climbs out) → PATH_ESCAPE.
    const traversal = sbPosix.checkWrite("/work/project/../other/x");
    expect(traversal.allowed).toBe(false);
    expect(traversal.reason?.code).toBe("PATH_ESCAPE");

    // Absolute-outside → PATH_ESCAPE.
    const absOut = sbPosix.checkWrite("/etc/passwd");
    expect(absOut.allowed).toBe(false);
    expect(absOut.reason?.code).toBe("PATH_ESCAPE");

    // SYMLINK escape: a link inside the root whose REAL target is /etc/passwd-dir.
    // Confinement must follow the symlink and reject (real path escapes root).
    const symEscape = sbPosix.checkWrite("/work/project/escape-link");
    expect(symEscape.allowed).toBe(false);
    expect(symEscape.reason?.code).toBe("PATH_ESCAPE");

    // exec cwd escape uses the same guard.
    expect(sbPosix.checkExecCwd("/etc").allowed).toBe(false);
    expect(sbPosix.checkExecCwd("/work/project/src").allowed).toBe(true);

    // POSIX is CASE-SENSITIVE: a differently-cased in-root path does NOT match an
    // existing ancestor and (being non-existent under the map, with /WORK absent)
    // resolves up to "/" which is not in the map → fail-closed PATH_ESCAPE.
    const caseSensitive = sbPosix.checkWrite("/WORK/project/src/x");
    expect(caseSensitive.allowed).toBe(false);
    expect(caseSensitive.reason?.code).toBe("PATH_ESCAPE");

    // ---- WINDOWS regime ------------------------------------------------------
    const winRoot = "C:\\Work\\Project";
    const win = policyWith({
      posix: false,
      existing: {
        "C:\\Work\\Project": "C:\\Work\\Project",
        "C:\\Work\\Project\\src": "C:\\Work\\Project\\src",
        "C:\\Work\\Project\\escape-link": "C:\\Windows\\System32",
        "C:\\Work": "C:\\Work",
        "C:\\Windows\\System32": "C:\\Windows\\System32",
      },
    });
    const sbWin = createPathSandbox(winRoot, win);

    // In-root, but with DIFFERENT CASE + forward slashes: Windows case-folds and
    // normalizes separators, so this is allowed (REQ-NFR-007 case-fold/backslash).
    const winCase = sbWin.checkWrite("c:/work/PROJECT/src");
    expect(winCase.allowed).toBe(true);

    // Not-yet-created file inside root (mixed separators) → allowed.
    const winNew = sbWin.checkWrite("C:\\Work\\Project\\src\\New.ts");
    expect(winNew.allowed).toBe(true);

    // Absolute-outside on Windows → PATH_ESCAPE.
    const winOut = sbWin.checkWrite("C:\\Windows\\System32\\evil.dll");
    expect(winOut.allowed).toBe(false);
    expect(winOut.reason?.code).toBe("PATH_ESCAPE");

    // Symlink/junction escape on Windows (link inside root → System32) → PATH_ESCAPE.
    const winSym = sbWin.checkWrite("C:\\Work\\Project\\escape-link");
    expect(winSym.allowed).toBe(false);
    expect(winSym.reason?.code).toBe("PATH_ESCAPE");

    // Reads still always allowed on Windows too.
    expect(sbWin.checkRead("C:\\Windows\\System32\\config").allowed).toBe(true);
  });

  it("test_REQNFR007_path_confinement_windows_and_posix_fail_closed", () => {
    // A path with NO existing ancestor at all (the scripted realpath throws for
    // every probe, including the filesystem root) must FAIL CLOSED → PATH_ESCAPE,
    // never a permissive default. This is the unresolvable-path guard.
    const posix = policyWith({ posix: true, existing: {} });
    // Root itself does not resolve → pinned lexically; any write fails closed.
    const sb = createPathSandbox("/work/project", posix);
    const v = sb.checkWrite("/work/project/anything");
    expect(v.allowed).toBe(false);
    expect(v.reason?.code).toBe("PATH_ESCAPE");

    // The pure decision is symmetric across regimes: equal/descend → true,
    // climb-out → false, under both separators.
    expect(isContained("/a/b", "/a/b/c", posix)).toBe(true);
    expect(isContained("/a/b", "/a/x", posix)).toBe(false);
    const win = policyWith({ posix: false, existing: {} });
    expect(isContained("C:\\a\\b", "C:\\A\\B\\c", win)).toBe(true); // case-fold
    expect(isContained("C:\\a\\b", "D:\\a\\b", win)).toBe(false); // different drive
  });
});
