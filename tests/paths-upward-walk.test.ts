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

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("resolveProjectPaths — upward walk (M-7)", () => {
  it("finds the ancestor .twinharness from a deep subdir", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-upward-"));
    const root = path.join(tmp, "proj");
    const stateDir = path.join(root, ".twinharness");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "state.json"), "{}", "utf8");
    const deep = path.join(root, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });

    const paths = resolveProjectPaths(deep);
    expect(path.resolve(paths.root)).toBe(path.resolve(root));
    expect(paths.stateFile).toBe(path.join(stateDir, "state.json"));
  });

  it("finds the ancestor legacy .agentic-sdlc/state.json from a subdir", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-upward-legacy-"));
    const root = path.join(tmp, "proj");
    const legacyDir = path.join(root, ".agentic-sdlc");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "state.json"), "{}", "utf8");
    const deep = path.join(root, "src", "deep");
    fs.mkdirSync(deep, { recursive: true });

    const paths = resolveProjectPaths(deep);
    expect(path.resolve(paths.root)).toBe(path.resolve(root));
    expect(paths.stateDir).toContain(".agentic-sdlc");
  });

  it("falls back to the start dir when no ancestor has state", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-upward-none-"));
    const sub = path.join(tmp, "x", "y");
    fs.mkdirSync(sub, { recursive: true });

    const paths = resolveProjectPaths(sub);
    expect(path.resolve(paths.root)).toBe(path.resolve(sub));
  });

  it("prefers the nearest (deepest) ancestor when state dirs nest", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "th-upward-nested-"));
    const outer = path.join(tmp, "outer");
    const inner = path.join(outer, "inner");
    fs.mkdirSync(path.join(outer, ".twinharness"), { recursive: true });
    fs.mkdirSync(path.join(inner, ".twinharness"), { recursive: true });
    const deep = path.join(inner, "sub");
    fs.mkdirSync(deep, { recursive: true });

    const paths = resolveProjectPaths(deep);
    expect(path.resolve(paths.root)).toBe(path.resolve(inner));
  });
});
