/**
 * R-21: `th state unlock [--force]` reclaims a stale / owner-less `.state.lock` left by a
 * crashed `th` process — the recovery path for the owner-less-held lock that the acquire
 * loop never reclaims (R-08 forbids stealing it; the timeout only throws). Default removes
 * a stale OR owner-less lock and refuses a lock that still looks LIVE (stamped + fresh);
 * `--force` removes unconditionally.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateUnlock } from "../src/commands/state";
import { STALE_MS } from "../src/core/state-store";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function lockDirOf(t: TempProject): string {
  return path.join(t.paths.stateDir, ".state.lock");
}

describe("R-21: th state unlock", () => {
  it("no lock present → success, nothing removed", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runStateUnlock(tp.paths, {});
    expect(res.ok).toBe(true);
    expect(res.data?.removed).toBe(false);
    expect(res.data?.reason).toBe("no_lock");
  });

  // R-26: staleness is decided by AGE ALONE. A YOUNG owner-less lock is now REFUSED
  // without --force — R-21 acquires in two steps (mkdir, then writeOwner), so a LIVE
  // lock is transiently owner-less mid-acquire, and the owner read returns null on ANY
  // read error (EACCES/EBUSY), not just ENOENT. Removing it without --force could brick
  // a live holder. (Previously this was reclaimed by default — that was the defect.)
  it("a YOUNG owner-less lock is REFUSED without --force (R-26: may be a live mid-acquire holder)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const lock = lockDirOf(tp);
    fs.mkdirSync(lock); // no `owner` file inside → owner-less, but fresh mtime
    const res = runStateUnlock(tp.paths, {});
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("lock_live");
    expect(res.data?.ownerLess).toBe(true);
    expect(res.human).toContain("--force");
    expect(fs.existsSync(lock)).toBe(true); // left untouched
  });

  it("--force removes a young owner-less lock (the last-resort override still works)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const lock = lockDirOf(tp);
    fs.mkdirSync(lock); // owner-less, fresh
    const res = runStateUnlock(tp.paths, { force: true });
    expect(res.ok).toBe(true);
    expect(res.data?.removed).toBe(true);
    expect(res.data?.forced).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("an OLD owner-less lock (the genuine pre-R-21 brick) is reclaimed by default", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const lock = lockDirOf(tp);
    fs.mkdirSync(lock); // no `owner` file inside → owner-less
    // Backdate past STALE_MS: this is the genuine permanent-brick signature.
    const past = new Date(Date.now() - STALE_MS - 5_000);
    fs.utimesSync(lock, past, past);
    const res = runStateUnlock(tp.paths, {});
    expect(res.ok).toBe(true);
    expect(res.data?.removed).toBe(true);
    expect(res.data?.ownerLess).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("a FRESH stamped lock is REFUSED without --force (it may be a live holder)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const lock = lockDirOf(tp);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), "1234-abcd", "utf8"); // stamped + fresh mtime
    const res = runStateUnlock(tp.paths, {});
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("lock_live");
    expect(fs.existsSync(lock)).toBe(true); // left untouched
  });

  it("--force removes a fresh stamped lock", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const lock = lockDirOf(tp);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), "1234-abcd", "utf8");
    const res = runStateUnlock(tp.paths, { force: true });
    expect(res.ok).toBe(true);
    expect(res.data?.removed).toBe(true);
    expect(res.data?.forced).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("a genuinely STALE stamped lock (older than STALE_MS) is reclaimed by default", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const lock = lockDirOf(tp);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), "dead-holder", "utf8");
    // Backdate the lock dir mtime well past the stale threshold.
    const past = new Date(Date.now() - STALE_MS - 5_000);
    fs.utimesSync(lock, past, past);
    const res = runStateUnlock(tp.paths, {});
    expect(res.ok).toBe(true);
    expect(res.data?.removed).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
