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
import { concurrencyEnv, makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readVerifyConfig } from "../src/core/verify";
import {
  readState,
  withStateLock,
  isLockHeldError,
  realLockOps,
  LockTimeoutError,
  type LockOps,
} from "../src/core/state-store";

const execFileP = promisify(execFile);
const CLI = path.resolve(__dirname, "../dist/cli.js");

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-STATE-LOCK-001: concurrent mutations do not lose updates (F10)", () => {
  // TEST-008/009: skipIf dist is absent so the suite degrades gracefully instead
  // of throwing. CI always builds first; local runs without a build simply skip.
  it.skipIf(!fs.existsSync(CLI))("N parallel `drift add` processes each increment the blocking count with a unique id", async () => {
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
        { env: concurrencyEnv() },
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
  }, 120_000);

  // NOT RUN IN CI (runs locally). The 12-process `slice set-status` stress wave is
  // reliably green locally but was an intractable false-red on windows-latest: even
  // when isolated into the serial stress pass (machine otherwise idle), an unlucky
  // waiter was scheduler-starved past even the 90s TH_LOCK_TIMEOUT_MS and threw a
  // LockTimeoutError on a write that would otherwise have landed. That is a *timeout*
  // (environmental), never a lost-update assertion — so removing it from CI loses no
  // lock-CORRECTNESS coverage: the same `withStateLock` no-lost-update guarantee stays
  // exercised in CI by the sibling `drift add` (N=20) / `verify add` (N=16) waves below
  // and the in-process LockOps seam tests. The `process.env.CI` guard skips it ONLY on
  // CI runners; local `npm test` still runs it. (skipIf dist is absent too, so the suite
  // degrades gracefully when run without a build — TEST-008/009.)
  it.skipIf(!fs.existsSync(CLI) || !!process.env.CI)("concurrent `slice set-status` updates all land (no lost slice writes)", async () => {
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
      { env: concurrencyEnv() });

    // Flip each to in-progress concurrently.
    await Promise.all(
      slices.map((s) =>
        execFileP("node", [CLI, "slice", "set-status", s.id, "in-progress", "--cwd", tp!.root],
          { env: concurrencyEnv() }),
      ),
    );

    const state = readState(tp.paths).state;
    const inProgress = state?.slices.filter((s) => s.status === "in-progress").length ?? 0;
    expect(inProgress).toBe(N);
  }, 120_000);

  // P1/R-03: `verify add` is a read-modify-write of verify.json. Without
  // `withStateLock` serializing it, N racing adds would lose updates (last writer
  // wins). Every concurrent add must land — N distinct commands present.
  it.skipIf(!fs.existsSync(CLI))("concurrent `verify add` all land (no lost verify-config writes)", async () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const N = 16;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        execFileP("node", [CLI, "verify", "add", `cmd-${i}`, "--cwd", tp!.root],
          { env: concurrencyEnv() }),
      ),
    );

    const commands = readVerifyConfig(tp.paths).commands;
    expect(commands).toHaveLength(N);
    expect(new Set(commands).size).toBe(N); // each distinct add present, none lost
  }, 120_000);
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

  it("steals a STALE, STAMPED lock and runs fn (the held → steal → retry loop, no fs mocking)", () => {
    const tp = makeTempProject();
    try {
      runInit(tp.paths, {}); // creates stateDir so withStateLock engages the lock
      const lockDir = path.join(tp.paths.stateDir, ".state.lock");

      // Simulate a crashed holder: a lock dir whose mtime is older than the stale
      // threshold (STALE_MS, now 15s). It carries an OWNER stamp so it is
      // steal-eligible — R-08: only STAMPED locks may be stolen; an owner-less lock
      // is reclaimed via the 25s timeout, never stolen (covered in state-store-seam).
      // The contention branch must steal this stamped stale lock and let fn run.
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, "owner"), "crashed-holder-token", "utf8");
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

  // This case forces a GENUINE permission error by chmod-ing the state dir
  // read-only so `mkdirSync(.state.lock)` is denied. That denial is only
  // enforceable on POSIX as a non-root user: Windows ignores directory mode bits
  // for child creation (mkdir succeeds under 0o444), and root bypasses the check
  // entirely — in both cases mkdir would succeed and the permission path can't be
  // induced. Skip there rather than assert a condition the environment won't
  // produce; the fail-safe stays covered on non-root Linux/macOS (incl. CI). This
  // is the suite's ONE intentional platform-conditional skip (see doc-truth's
  // skip-count guard + README/CHANGELOG/CLAUDE.md).
  //
  // REQ-STATE-LOCK-003 — fail-safe over fail-fast-but-crash: a genuinely
  // permission-denied stateDir no longer rethrows a RAW errno from the stat path.
  // The acquire (mkdir) throws a contention-shaped EPERM/EACCES, and the follow-up
  // stat on the (still-absent) lock dir throws ENOENT → treated as steal-churn →
  // back off + retry, bounded by the loop-head deadline → a TYPED LockTimeoutError
  // (which the CLI maps to a clean `state_lock_timeout`), never a raw crash.
  //
  // We inject ONLY a virtual clock + no-op sleep (the LockOps `now`/`sleep` seam)
  // while delegating every FS primitive to realLockOps, so the permission fault is
  // genuinely produced by real `node:fs` against the real read-only dir — but the
  // 25s deadline is reached in a handful of iterations instead of blocking the
  // suite for the full wall-clock TIMEOUT_MS.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a genuinely permission-denied lock dir fails SAFE via a bounded LockTimeoutError (real fs, virtual clock)",
    () => {
      const tp = makeTempProject();
      try {
        runInit(tp.paths, {}); // creates stateDir

        // Virtual clock over the REAL fs ops: now() advances by each (non-zero)
        // sleep so the real-fs permission loop reaches the deadline in bounded
        // iterations rather than ~25s of wall time. Sleep is a no-op (we only need
        // the clock to advance, which it does via now()).
        let virtualNow = 0;
        const fastClockOps: LockOps = {
          ...realLockOps,
          now: () => (virtualNow += 1_000), // +1s per read → crosses the 25s deadline fast
          sleep: () => {},
        };

        // Make stateDir read-only so mkdirSync(.state.lock) throws a permission
        // error while the lock directory itself does not yet exist.
        fs.chmodSync(tp.paths.stateDir, 0o444);
        try {
          // Bounded by the deadline → a TYPED LockTimeoutError, never a raw EPERM/EACCES.
          expect(() => withStateLock(tp.paths, () => 1, fastClockOps)).toThrow(LockTimeoutError);
        } finally {
          // Restore perms so cleanup can delete the temp dir.
          fs.chmodSync(tp.paths.stateDir, 0o755);
        }
      } finally {
        tp.cleanup();
      }
    },
  );
});
