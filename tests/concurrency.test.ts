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
import { concurrencyEnv, makeTempProject, SKIP_SPAWN_HEAVY_IN_CI, LIGHT_SPAWN_CONCURRENCY, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readVerifyConfig } from "../src/core/verify";
import { initialState } from "../src/core/state-schema";
import {
  readState,
  writeState,
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
  // NOT RUN IN CI (see SKIP_SPAWN_HEAVY_IN_CI) — this spawns N=20 concurrent
  // `node dist/cli.js` lock contenders, an intractable scheduler-starvation
  // false-red on windows-latest. Runs on every local `npm test`.
  // TEST-008/009: skipIf dist is absent so the suite degrades gracefully instead
  // of throwing. CI always builds first; local runs without a build simply skip.
  it.skipIf(!fs.existsSync(CLI) || SKIP_SPAWN_HEAVY_IN_CI)("N parallel `drift add` processes each increment the blocking count with a unique id", async () => {
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

  // NOT RUN IN CI (see SKIP_SPAWN_HEAVY_IN_CI) — N=12 concurrent `slice set-status`
  // lock contenders; intractable scheduler-starvation false-red on windows-latest.
  // Runs on every local `npm test`. (skipIf dist absent → degrade gracefully, TEST-008/009.)
  it.skipIf(!fs.existsSync(CLI) || SKIP_SPAWN_HEAVY_IN_CI)("concurrent `slice set-status` updates all land (no lost slice writes)", async () => {
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
  // NOT RUN IN CI (see SKIP_SPAWN_HEAVY_IN_CI) — N=16 concurrent `verify add`
  // lock contenders; intractable scheduler-starvation false-red on windows-latest.
  it.skipIf(!fs.existsSync(CLI) || SKIP_SPAWN_HEAVY_IN_CI)("concurrent `verify add` all land (no lost verify-config writes)", async () => {
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

describe("REQ-STATE-LOCK-002: a LIGHT cross-process lock wave runs in CI too (compiled-CLI integration)", () => {
  // Unlike the heavy N=12–52 waves above (local-only via SKIP_SPAWN_HEAVY_IN_CI), this
  // fires only LIGHT_SPAWN_CONCURRENCY (3) concurrent `node dist/cli.js` processes — low
  // enough that even an oversubscribed CI runner cannot scheduler-starve a waiter past the
  // 90s TH_LOCK_TIMEOUT_MS, yet it still exercises the COMPILED CLI + real OS file lock +
  // process integration that the in-process LockOps seam tests cannot reach. This keeps
  // cross-process lock coverage alive on EVERY CI runner (audit P2) instead of disabling
  // it wholesale. (skipIf dist absent → degrade gracefully, TEST-008/009.)
  it.skipIf(!fs.existsSync(CLI))("a few parallel `drift add` processes each land with a unique id (CI-safe)", async () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const N = LIGHT_SPAWN_CONCURRENCY;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        execFileP(
          "node",
          [
            CLI, "drift", "add",
            "--layer", "requirement",
            "--ref", `SLICE-${i}`,
            "--discovery", `light concurrent discovery ${i}`,
            "--action", "build paused",
            "--cwd", tp!.root,
          ],
          { env: concurrencyEnv() },
        ),
      ),
    );

    // No lost increment and no id collision through the real OS lock + compiled CLI.
    const state = readState(tp.paths).state;
    expect(state?.drift_open_blocking).toBe(N);
    const log = fs.readFileSync(tp.paths.driftLog, "utf8");
    const ids = new Set([...log.matchAll(/DRIFT-(\d+)/g)].map((m) => m[1]));
    expect(ids.size).toBe(N);
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

describe("R-35 / F6: the PRE-INIT window is locked too (no lost first-writes to a FRESH root)", () => {
  // The bug (F6): `withStateLock` USED to run `fn` UNLOCKED whenever `<stateDir>` did
  // not exist yet — "no shared state to race on". But N concurrent FIRST-writers
  // against a fresh root each read-init-write `state.json`/`verify.json` with NO lock
  // covering the read→write span, so all but one update is lost (the 28/29/30-of-30
  // loss). `th verify add` against a fresh root (no `th init` first) is the cleanest
  // repro: every process loads an empty/absent config, pushes its own command, writes.
  // Without the pre-init lock the file ends with ONE command; with it, all N land.
  //
  // CI-SKIP convention (SKIP_SPAWN_HEAVY_IN_CI — same as the heavy waves above): this
  // spawns N real `node dist/cli.js` lock contenders, scheduler-starvation-prone on
  // windows-latest. Runs on every local `npm test`; the LIGHT in-process cases below
  // run EVERYWHERE (including CI) and pin the same fix without spawning.
  it.skipIf(!fs.existsSync(CLI) || SKIP_SPAWN_HEAVY_IN_CI)(
    "N parallel `verify add` against a FRESH (un-init'd) root all land (pre-init lock)",
    async () => {
      tp = makeTempProject();
      // DELIBERATELY do NOT runInit — the state dir/file do not exist, so every
      // process hits the pre-init window. (HEAD ran these unlocked → lost updates.)
      const N = 16;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          execFileP("node", [CLI, "verify", "add", `precmd-${i}`, "--cwd", tp!.root],
            { env: concurrencyEnv() }),
        ),
      );

      const commands = readVerifyConfig(tp.paths).commands;
      expect(commands).toHaveLength(N); // none lost in the pre-init race
      expect(new Set(commands).size).toBe(N); // each distinct add present
    },
    120_000,
  );

  // LIGHT cross-process wave that runs EVERYWHERE (incl. CI), low enough not to
  // scheduler-starve a waiter past the 90s deadline — proves the compiled CLI
  // serializes the pre-init read-modify-write through the real OS file lock.
  it.skipIf(!fs.existsSync(CLI))(
    "a few parallel `verify add` against a fresh root each land (CI-safe pre-init lock)",
    async () => {
      tp = makeTempProject();
      const N = LIGHT_SPAWN_CONCURRENCY;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          execFileP("node", [CLI, "verify", "add", `lightpre-${i}`, "--cwd", tp!.root],
            { env: concurrencyEnv() }),
        ),
      );
      const commands = readVerifyConfig(tp.paths).commands;
      expect(commands).toHaveLength(N);
      expect(new Set(commands).size).toBe(N);
    },
    120_000,
  );

  // In-process: the pre-init lock must ACTUALLY engage (create `<stateDir>` and the
  // lock dir) for a fresh root, not bypass it. Drive two serial critical sections
  // through `withStateLock` against a never-init'd root and assert each ran under a
  // real lock (the lock dir existed during fn, released after).
  it("withStateLock against a fresh root creates the state dir and locks fn (no unlocked bypass)", () => {
    tp = makeTempProject();
    // Fresh: state dir does not exist yet.
    expect(fs.existsSync(tp.paths.stateDir)).toBe(false);

    const lockDir = path.join(tp.paths.stateDir, ".state.lock");
    let lockedDuringFn = false;
    const out = withStateLock(tp.paths, () => {
      // The lock dir exists WHILE fn runs ⇒ fn is genuinely under the lock (the old
      // bypass ran fn with no lock dir ever created).
      lockedDuringFn = fs.existsSync(lockDir);
      return "ran";
    });
    expect(out).toBe("ran");
    expect(lockedDuringFn).toBe(true); // pre-init window was covered by the lock
    expect(fs.existsSync(tp.paths.stateDir)).toBe(true); // state dir was created
    expect(fs.existsSync(lockDir)).toBe(false); // released in the finally
  });

  // In-process add/clear race semantics before init: a fresh-root locked write is
  // ALLOWED by assertWriteAllowed (arm 1: no file ⇒ allow), and a second locked
  // read-modify-write sees the first's result (no lost update across the two spans).
  it("serial pre-init read-modify-writes accumulate (fresh-root first write allowed, second sees it)", () => {
    tp = makeTempProject();
    // First locked write to a fresh root: must be ALLOWED (no SchemaTooNewError).
    expect(() =>
      withStateLock(tp.paths, () => writeState(tp!.paths, { ...initialState(), max_tokens: 111 })),
    ).not.toThrow();
    // Second locked read-modify-write sees the first's persisted value.
    const after = withStateLock(tp.paths, () => {
      const s = readState(tp!.paths).state!;
      expect(s.max_tokens).toBe(111); // first write was not lost
      writeState(tp!.paths, { ...s, max_tokens: 222 });
      return readState(tp!.paths).state!.max_tokens;
    });
    expect(after).toBe(222);
  });
});
