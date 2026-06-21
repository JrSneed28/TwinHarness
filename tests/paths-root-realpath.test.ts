/**
 * resolveProjectPaths canonicalizes the SELECTED root (R-13).
 *
 * The upward walk picks the project root LEXICALLY (`abs = cursor`). If an
 * ancestor in the chain is an NTFS junction (the proven Windows vector —
 * junctions are NOT symlinks, so `lstat().isSymbolicLink()` is false for them)
 * or a POSIX symlink, that lexical anchor is non-canonical. Containment holds
 * today only because `resolveWithinRoot` realpaths both sides; a future writer
 * using `paths.root` directly would inherit the redirected base. R-13 realpaths
 * the selected root once so the anchor is canonical at selection.
 *
 * This MUST run on windows-latest (the junction case is the concrete risk).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectPaths } from "../src/core/paths";
import { initialState, serializeState } from "../src/core/state-schema";

// R-34 / F5 — the upward walk anchors on a VALID `state.json` FILE (an empty `{}`
// no longer validates and so no longer anchors). Write a valid state file.
const writeValidState = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), serializeState(initialState()), "utf8");
};

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/**
 * Create a directory junction (Windows) / dir symlink (POSIX) and return whether
 * it succeeded. Junction/symlink creation can be unsupported (e.g. a POSIX
 * filesystem without symlink support, or a restricted CI). Mirrors the POSIX-only
 * skip pattern in tests/concurrency.test.ts: when the link can't be created we
 * skip cleanly rather than fail. On Windows, junctions need no elevation, so this
 * runs there.
 */
function tryLink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

describe("resolveProjectPaths — selected root is realpath'd (R-13)", () => {
  it("a junctioned-ancestor walk resolves root to the realpath, not the junction path", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-root-rp-"));
    // Real on-disk project with a state dir so the upward walk selects it.
    const realProject = path.join(tmp, "real-project");
    writeValidState(path.join(realProject, ".twinharness"));

    // A junction that redirects to the real project. Resolving from INSIDE the
    // junction yields a lexical root under `linkedProject` that is NOT canonical.
    const linkedProject = path.join(tmp, "linked-project");
    if (!tryLink(realProject, linkedProject)) {
      // Junction/symlink unsupported on this host — skip cleanly (POSIX-only
      // skip pattern). On Windows this branch is not taken.
      return;
    }

    // Resolve from a subdir reached THROUGH the junction.
    const deepThroughLink = path.join(linkedProject, "a", "b");
    fs.mkdirSync(deepThroughLink, { recursive: true });

    const paths = resolveProjectPaths(deepThroughLink);

    // The selected root, once realpath'd, equals the REAL project dir — not the
    // junction path it was reached through.
    const realExpected = fs.realpathSync.native(realProject);
    expect(fs.realpathSync.native(paths.root)).toBe(realExpected);
    expect(paths.root).toBe(realExpected);
    // And the lexical junction path is NOT the anchor.
    expect(paths.root).not.toBe(linkedProject);
    // State dir derives from the canonical root.
    expect(paths.stateDir).toBe(path.join(realExpected, ".twinharness"));
  });

  it("a non-junctioned project root is unchanged (realpath is a no-op)", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-root-rp-plain-"));
    const root = path.join(tmp, "proj");
    writeValidState(path.join(root, ".twinharness"));

    const paths = resolveProjectPaths(root);
    expect(paths.root).toBe(fs.realpathSync.native(root));
  });

  it("a fresh (not-yet-created) root resolves without throwing (longest-existing-prefix)", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-root-rp-fresh-"));
    // A start dir that does not exist on disk yet: realpathExistingPrefix must
    // resolve the existing prefix and re-append the missing tail literally.
    const ghost = path.join(tmp, "does", "not", "exist", "yet");
    const paths = resolveProjectPaths(ghost);
    // Falls back to the start dir (no ancestor state) with the existing prefix
    // canonicalized and the missing tail preserved.
    expect(paths.root).toBe(path.join(fs.realpathSync.native(tmp), "does", "not", "exist", "yet"));
  });
});
