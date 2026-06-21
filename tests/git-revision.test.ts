/**
 * git-revision helpers (R-29..R-31) — gitHead / dirtyTreeDigest fail-soft.
 *
 * Both MUST fail soft to `null` on a non-git checkout (so a non-git project never
 * throws or blocks), and produce stable, deterministic coordinates in a git checkout.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { gitHead, dirtyTreeDigest, CLEAN_TREE_DIGEST } from "../src/core/git-revision";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "th-gitrev-"));
  tmpDirs.push(d);
  return d;
}

/** A real git repo with one commit, or null if git is unavailable in this env. */
function gitRepo(): string | null {
  const d = freshDir();
  const run = (args: string[]) => spawnSync("git", args, { cwd: d, encoding: "utf8" });
  if (run(["init"]).error) return null;
  run(["config", "user.email", "t@t.t"]);
  run(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(d, "a.txt"), "hello\n", "utf8");
  run(["add", "-A"]);
  const c = run(["commit", "-m", "init", "--no-gpg-sign"]);
  if (typeof c.status === "number" && c.status !== 0) return null;
  return d;
}

describe("git-revision — fail-soft on a non-git checkout", () => {
  it("gitHead returns null for a plain (non-git) directory", () => {
    const d = freshDir();
    expect(gitHead(d)).toBeNull();
  });

  it("dirtyTreeDigest returns null for a plain (non-git) directory", () => {
    const d = freshDir();
    expect(dirtyTreeDigest(d)).toBeNull();
  });

  it("neither throws on a nonexistent path", () => {
    const missing = path.join(freshDir(), "does", "not", "exist");
    expect(() => gitHead(missing)).not.toThrow();
    expect(() => dirtyTreeDigest(missing)).not.toThrow();
  });
});

describe("git-revision — coordinates in a real git checkout", () => {
  it("gitHead resolves to a 40-hex commit; a clean tree digests to the clean sentinel", () => {
    const d = gitRepo();
    if (d === null) return; // git unavailable → skip (the fail-soft path is covered above)
    const head = gitHead(d);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(dirtyTreeDigest(d)).toBe(CLEAN_TREE_DIGEST);
  });

  it("a dirty tree digests to a stable, content-derived hash distinct from clean", () => {
    const d = gitRepo();
    if (d === null) return;
    fs.writeFileSync(path.join(d, "a.txt"), "hello\nworld\n", "utf8");
    const dirty1 = dirtyTreeDigest(d);
    expect(dirty1).not.toBeNull();
    expect(dirty1).not.toBe(CLEAN_TREE_DIGEST);
    // Deterministic: same tree state → same digest.
    expect(dirtyTreeDigest(d)).toBe(dirty1);
    // A DIFFERENT edit → a different digest.
    fs.writeFileSync(path.join(d, "a.txt"), "hello\nplanet\n", "utf8");
    expect(dirtyTreeDigest(d)).not.toBe(dirty1);
  });
});
