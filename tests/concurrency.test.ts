/**
 * Cross-process state-lock concurrency (audit finding F10) — REQ-anchored.
 *
 * Each `th` invocation is a separate OS process. During a parallel build wave,
 * multiple Builders mutate state concurrently. This test spawns N real
 * `node dist/cli.js drift add` processes at once and asserts no update is lost:
 * every requirement-layer drift must increment `drift_open_blocking` and receive
 * a unique DRIFT-NNN id. Without `withStateLock`, racing read-modify-write would
 * under-count the blocking gate and collide ids.
 *
 * Runs against the COMPILED CLI (dist/cli.js), so CI builds before testing.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState, withStateLock, isLockHeldError } from "../src/core/state-store";

const execFileP = promisify(execFile);
const CLI = path.resolve(__dirname, "../dist/cli.js");

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-STATE-LOCK-001: concurrent mutations do not lose updates (F10)", () => {
  it("N parallel `drift add` processes each increment the blocking count with a unique id", async () => {
    // Guard: this test needs the compiled CLI. CI builds before testing.
    if (!fs.existsSync(CLI)) {
      throw new Error(`dist/cli.js missing — run \`npm run build\` before the concurrency test (${CLI}).`);
    }
    tp = makeTempProject();
    runInit(tp.paths, {});

    const N = 20;
    const tasks = Array.from({ length: N }, (_, i) =>
      execFileP(
        "node",
        [
          CLI, "drift", "add",
          "--layer", "requirement",
          "--ref", `SLICE-${i}`,
          "--discovery", `concurrent discovery ${i}`,
          "--action", "build paused",
          "--cwd", tp!.root,
        ],
        { env: { ...process.env, TH_NO_LOG: "1" } },
      ),
    );
    await Promise.all(tasks);

    // No lost increment: every requirement-layer drift counted.
    const state = readState(tp.paths).state;
    expect(state?.drift_open_blocking).toBe(N);

    // No id collision: the serialized nextDriftId produced N distinct ids.
    const log = fs.readFileSync(tp.paths.driftLog, "utf8");
    const ids = new Set([...log.matchAll(/DRIFT-(\d+)/g)].map((m) => m[1]));
    expect(ids.size).toBe(N);
  }, 30_000);

  it("concurrent `slice set-status` updates all land (no lost slice writes)", async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`dist/cli.js missing — run \`npm run build\` before the concurrency test.`);
    }
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Seed N pending slices.
    const N = 12;
    const slices = Array.from({ length: N }, (_, i) => ({
      id: `SLICE-${i}`,
      status: "pending",
      components: [`src/mod${i}`],
    }));
    await execFileP("node", [CLI, "state", "set", "slices", JSON.stringify(slices), "--cwd", tp.root],
      { env: { ...process.env, TH_NO_LOG: "1" } });

    // Flip each to in-progress concurrently.
    await Promise.all(
      slices.map((s) =>
        execFileP("node", [CLI, "slice", "set-status", s.id, "in-progress", "--cwd", tp!.root],
          { env: { ...process.env, TH_NO_LOG: "1" } }),
      ),
    );

    const state = readState(tp.paths).state;
    const inProgress = state?.slices.filter((s) => s.status === "in-progress").length ?? 0;
    expect(inProgress).toBe(N);
  }, 30_000);
});

describe("REQ-PCO-000: withStateLock treats Windows EPERM/EACCES as 'held' and retries", () => {
  // On Windows a concurrent mkdirSync against a contended dir can throw EPERM (or
  // EACCES) instead of EEXIST. The lock path must recognize all three as
  // contention (wait / steal-if-stale / retry) rather than rethrow and crash the
  // caller. The classification is a pure exported predicate so it can be pinned
  // directly — `fs` module exports are not spy-able under vitest's ESM interop.
  it("isLockHeldError classifies EEXIST/EPERM/EACCES as contention; everything else rethrows", () => {
    expect(isLockHeldError("EEXIST")).toBe(true); // POSIX contention
    expect(isLockHeldError("EPERM")).toBe(true); // Windows contention
    expect(isLockHeldError("EACCES")).toBe(true); // Windows contention (variant)
    expect(isLockHeldError("ENOENT")).toBe(false); // genuine error → rethrow
    expect(isLockHeldError("ENOSPC")).toBe(false); // genuine error → rethrow
    expect(isLockHeldError(undefined)).toBe(false); // unknown → rethrow
  });

  it("steals a STALE lock and runs fn (the held → steal → retry loop, no fs mocking)", () => {
    const tp = makeTempProject();
    try {
      runInit(tp.paths, {}); // creates stateDir so withStateLock engages the lock
      const lockDir = path.join(tp.paths.stateDir, ".state.lock");

      // Simulate a crashed holder: a lock dir whose mtime is older than the stale
      // threshold (30s). The contention branch must steal it and let fn run.
      fs.mkdirSync(lockDir, { recursive: true });
      const old = Date.now() - 60_000;
      fs.utimesSync(lockDir, new Date(old), new Date(old));

      let ran = false;
      const out = withStateLock(tp.paths, () => {
        ran = true;
        return 42;
      });
      expect(ran).toBe(true); // fn ran → the stale lock was stolen and acquired
      expect(out).toBe(42); // returned fn's value, did not throw
      expect(fs.existsSync(lockDir)).toBe(false); // released in the finally
    } finally {
      tp.cleanup();
    }
  });
});
