/**
 * resolveProjectPaths upward walk to the nearest ancestor state dir (M-7).
 *
 * A session whose cwd is a subdirectory of the project must still find the
 * project's gates instead of failing OPEN (treating the subdir as untracked and
 * allowing the run). If no ancestor holds state, it falls back to the start dir.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectPaths } from "../src/core/paths";
import { initialState, serializeState } from "../src/core/state-schema";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/**
 * R-34 / F5 — the upward walk now stops only at a VALID `state.json` FILE, not a
 * bare state DIRECTORY. Write a VALID state file at `<dir>/state.json` so a location
 * legitimately anchors the project (an empty `{}` does NOT validate, by design — a
 * bare/empty state dir must no longer fail open as "the project root").
 */
const writeValidState = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), serializeState(initialState()), "utf8");
};

/**
 * Canonicalize a dir for comparison. R-13 realpaths the selected root via
 * `fs.realpathSync.native`, so the expected dir must use the SAME resolver —
 * otherwise a symlinked tmpdir (macOS `/var` -> `/private/var`) or a Windows 8.3
 * short name (`RUNNER~1` -> `runneradmin`, which ONLY the native resolver expands;
 * the JS `fs.realpathSync` leaves 8.3 names untouched) makes the comparison
 * spuriously fail on CI. realpath'ing both sides with the native resolver asserts
 * the directories are the SAME, which is the actual contract.
 */
const real = (p: string): string => fs.realpathSync.native(p);

describe("resolveProjectPaths — upward walk (M-7)", () => {
  it("finds the ancestor .twinharness from a deep subdir", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-upward-"));
    const root = path.join(tmp, "proj");
    writeValidState(path.join(root, ".twinharness"));
    const deep = path.join(root, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });

    const paths = resolveProjectPaths(deep);
    expect(real(paths.root)).toBe(real(root));
    expect(paths.stateFile).toBe(path.join(paths.root, ".twinharness", "state.json"));
  });

  it("finds the ancestor legacy .agentic-sdlc/state.json from a subdir", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-upward-legacy-"));
    const root = path.join(tmp, "proj");
    writeValidState(path.join(root, ".agentic-sdlc"));
    const deep = path.join(root, "src", "deep");
    fs.mkdirSync(deep, { recursive: true });

    const paths = resolveProjectPaths(deep);
    expect(real(paths.root)).toBe(real(root));
    expect(paths.stateDir).toContain(".agentic-sdlc");
  });

  it("falls back to the start dir when no ancestor has state", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-upward-none-"));
    const sub = path.join(tmp, "x", "y");
    fs.mkdirSync(sub, { recursive: true });

    const paths = resolveProjectPaths(sub);
    expect(real(paths.root)).toBe(real(sub));
  });

  it("prefers the nearest (deepest) ancestor when state dirs nest", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-upward-nested-"));
    const outer = path.join(tmp, "outer");
    const inner = path.join(outer, "inner");
    writeValidState(path.join(outer, ".twinharness"));
    writeValidState(path.join(inner, ".twinharness"));
    const deep = path.join(inner, "sub");
    fs.mkdirSync(deep, { recursive: true });

    const paths = resolveProjectPaths(deep);
    expect(real(paths.root)).toBe(real(inner));
  });
});
