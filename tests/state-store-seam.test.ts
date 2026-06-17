/**
 * #3-pre — the injectable lock seam (LockOps) is INERT (behavior-preserving).
 *
 * `withStateLock` previously hard-wired the wall clock (`Date.now`), the sleep
 * (`sleepSync`), and the `node:fs` test-and-set / steal primitives, so its
 * contention / steal / timeout / backoff loop could not be driven deterministically
 * (no clock or sleep seam) — a bounded-time contention test was impossible. We
 * extracted a `LockOps` seam (mirroring atomic-io.ts's injected `rename`/`read`),
 * defaulting to the real ops. These tests pin that:
 *
 *   1. the DEFAULT (realLockOps) path is byte-for-byte the original behavior — this
 *      is also covered by the existing real-fs tests (concurrency.test.ts /
 *      state-store-lock.test.ts) staying green; and
 *   2. with an injected seam, acquire / steal / wait-timeout / rethrow semantics are
 *      identical to the pre-seam code, across ALL THREE lock-held errno codes
 *      (POSIX EEXIST and Windows EPERM/EACCES) — exercised deterministically here,
 *      regardless of the host OS (CI runs the pwsh leg, so EPERM/EACCES must be
 *      covered explicitly, not only EEXIST).
 *
 * The #3 deadline/backoff FIX (and the sustained-churn contention test it makes
 * possible) lands in the next checkpoint; this one proves the seam changes nothing.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { makeTempProject } from "./helpers";
import { withStateLock, LockTimeoutError, STALE_MS, realLockOps, type LockOps } from "../src/core/state-store";

/** A node ErrnoException with a given `code`. */
function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`fake ${code}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

interface FakeState {
  now: number;
  attempts: number;
  sleeps: number[];
  removes: number;
}

/**
 * Build a deterministic LockOps seam. `acquire(attempt)` returns the errno code to
 * THROW on the 1-based attempt, or null to ACQUIRE. `age` is the reported stale-age
 * (now − mtime); `owners` drives the TOCTOU owner-token read; `mtimeThrows` makes
 * the stat step throw (vanished / denied lock dir).
 */
function makeFakeOps(behavior: {
  acquire: (attempt: number) => string | null;
  age?: number;
  owners?: () => string | null;
  mtimeThrows?: string;
}): { state: FakeState; ops: LockOps } {
  const state: FakeState = { now: 1_000_000, attempts: 0, sleeps: [], removes: 0 };
  const ops: LockOps = {
    now: () => state.now,
    // Virtual clock: each wait advances `now` by the (ceil'd, non-zero) sleep so a
    // sustained wait is guaranteed to reach the deadline in bounded iterations.
    sleep: (ms) => {
      state.sleeps.push(ms);
      state.now += Math.max(1, Math.ceil(ms));
    },
    acquire: () => {
      state.attempts++;
      const code = behavior.acquire(state.attempts);
      if (code) throw errno(code);
    },
    mtimeMs: () => {
      if (behavior.mtimeThrows) throw errno(behavior.mtimeThrows);
      return state.now - (behavior.age ?? 0); // default age 0 → fresh (never stale)
    },
    remove: () => {
      state.removes++;
    },
    readOwner: () => (behavior.owners ? behavior.owners() : "tok"),
    writeOwner: () => {},
  };
  return { state, ops };
}

/** A temp project with its stateDir created so withStateLock engages the lock loop. */
function lockableProject() {
  const tp = makeTempProject();
  fs.mkdirSync(tp.paths.stateDir, { recursive: true });
  return tp;
}

describe("#3-pre: the LockOps seam default is the real clock + sleep + fs primitives", () => {
  it("realLockOps is exported and wires the production primitives", () => {
    expect(typeof realLockOps.now).toBe("function");
    expect(typeof realLockOps.sleep).toBe("function");
    expect(typeof realLockOps.acquire).toBe("function");
    expect(typeof realLockOps.mtimeMs).toBe("function");
    expect(typeof realLockOps.remove).toBe("function");
    // now() is the wall clock.
    const t0 = realLockOps.now();
    expect(t0).toBeGreaterThan(0);
    expect(Math.abs(t0 - Date.now())).toBeLessThan(50);
  });

  it("uses realLockOps by default: a free lock acquires, runs fn, and releases (real fs)", () => {
    const tp = lockableProject();
    try {
      let ran = false;
      const out = withStateLock(tp.paths, () => {
        ran = true;
        return 7;
      });
      expect(ran).toBe(true);
      expect(out).toBe(7);
      // Released in the finally — no lock dir left behind.
      expect(fs.existsSync(`${tp.paths.stateDir}/.state.lock`)).toBe(false);
    } finally {
      tp.cleanup();
    }
  });
});

describe("#3-pre: injected seam reproduces acquire / steal / timeout / rethrow identically", () => {
  it("acquires on the first attempt → fn runs, value returned, lock released", () => {
    const tp = lockableProject();
    try {
      const { state, ops } = makeFakeOps({ acquire: () => null });
      const out = withStateLock(tp.paths, () => 42, ops);
      expect(out).toBe(42);
      expect(state.attempts).toBe(1);
      expect(state.removes).toBe(1); // released once in the finally
      expect(state.sleeps).toEqual([]); // no contention → no backoff
    } finally {
      tp.cleanup();
    }
  });

  it("steals a STALE lock (owner unchanged) then acquires on retry → fn runs", () => {
    const tp = lockableProject();
    try {
      // attempt 1 held (EEXIST), stale age, owner token stable → steal; attempt 2 acquires.
      const { state, ops } = makeFakeOps({
        acquire: (n) => (n === 1 ? "EEXIST" : null),
        age: STALE_MS + 5_000,
        owners: () => "stable-token",
      });
      let ran = false;
      const out = withStateLock(tp.paths, () => {
        ran = true;
        return "ok";
      }, ops);
      expect(ran).toBe(true);
      expect(out).toBe("ok");
      expect(state.attempts).toBe(2); // held once, then acquired
      // remove called at least once for the STEAL (plus once for the release).
      expect(state.removes).toBeGreaterThanOrEqual(1);
    } finally {
      tp.cleanup();
    }
  });

  it("EEXIST vanished mid-stat (statSync throws) → retries and acquires (vanished `continue`)", () => {
    const tp = lockableProject();
    try {
      // attempt 1 held (EEXIST), but mtime stat throws ENOENT (lock vanished) → continue; attempt 2 acquires.
      const { state, ops } = makeFakeOps({
        acquire: (n) => (n === 1 ? "EEXIST" : null),
        mtimeThrows: "ENOENT",
      });
      const out = withStateLock(tp.paths, () => "acquired", ops);
      expect(out).toBe("acquired");
      expect(state.attempts).toBe(2);
    } finally {
      tp.cleanup();
    }
  });

  // The plan's hard requirement: cover BOTH lock-held branches deterministically,
  // regardless of host OS. CI runs the pwsh leg where contention surfaces as
  // EPERM/EACCES, so those are the primary legs — pinned here alongside EEXIST.
  for (const heldCode of ["EEXIST", "EPERM", "EACCES"]) {
    it(`sustained ${heldCode} on a FRESH (non-stale) held lock → LockTimeoutError within bounded attempts`, () => {
      const tp = lockableProject();
      try {
        const { state, ops } = makeFakeOps({ acquire: () => heldCode, age: 0 /* fresh → wait path */ });
        expect(() => withStateLock(tp.paths, () => 1, ops)).toThrow(LockTimeoutError);
        // It backed off (did not busy-spin) and stayed bounded — no infinite loop.
        expect(state.sleeps.length).toBeGreaterThan(0);
        expect(state.attempts).toBeLessThan(5_000);
        // The lock was never acquired, so fn never ran and nothing was released
        // beyond the (zero) acquisitions.
        expect(state.removes).toBe(0);
      } finally {
        tp.cleanup();
      }
    });
  }

  it("genuine non-contention error (ENOSPC) rethrows immediately — not treated as held", () => {
    const tp = lockableProject();
    try {
      const { state, ops } = makeFakeOps({ acquire: () => "ENOSPC" });
      expect(() => withStateLock(tp.paths, () => 1, ops)).toThrow(/ENOSPC/);
      expect(() => withStateLock(tp.paths, () => 1, makeFakeOps({ acquire: () => "ENOSPC" }).ops)).not.toThrow(LockTimeoutError);
      expect(state.attempts).toBe(1); // one attempt, then immediate rethrow (no retry loop)
    } finally {
      tp.cleanup();
    }
  });

  it("EPERM during stat with the lock-dir gone → genuine permission error rethrows (not a steal)", () => {
    const tp = lockableProject();
    try {
      // acquire throws EPERM (held on Windows), but the stat then throws too → the
      // EPERM/EACCES branch treats it as a genuine permission error and rethrows.
      const { ops } = makeFakeOps({ acquire: () => "EPERM", mtimeThrows: "EPERM" });
      expect(() => withStateLock(tp.paths, () => 1, ops)).toThrow(/EPERM/);
      expect(() => withStateLock(tp.paths, () => 1, makeFakeOps({ acquire: () => "EPERM", mtimeThrows: "EPERM" }).ops)).not.toThrow(LockTimeoutError);
    } finally {
      tp.cleanup();
    }
  });

  it("EPERM acquire (Windows contention) + lock VANISHED mid-stat (ENOENT) → retries and acquires (REQ-STATE-LOCK-002)", () => {
    const tp = lockableProject();
    try {
      // The windows-latest flake: mkdir threw EPERM because the lock was HELD
      // (Windows signals contention with EPERM, not EEXIST), then the holder
      // released it so the follow-up stat threw ENOENT. The verdict must key off
      // the STAT error (ENOENT = vanished → retry), NOT the acquire EPERM. The old
      // code keyed off the acquire code and rethrew a raw EPERM → crash.
      const { state, ops } = makeFakeOps({
        acquire: (n) => (n === 1 ? "EPERM" : null), // held once, then free
        mtimeThrows: "ENOENT", // lock vanished between mkdir and stat
      });
      const out = withStateLock(tp.paths, () => "acquired", ops);
      expect(out).toBe("acquired");
      expect(state.attempts).toBe(2); // attempt 1 vanished → retry → attempt 2 acquires
    } finally {
      tp.cleanup();
    }
  });
});

describe("#3: the deadline is enforced at the LOOP HEAD — no retry path can busy-loop", () => {
  it("a CHURNING stale lock (owner token changes each read → never actually stolen) still times out, BOUNDED", () => {
    const tp = lockableProject();
    try {
      let oc = 0;
      const { state, ops } = makeFakeOps({
        acquire: () => "EEXIST", // always held
        age: STALE_MS + 5_000, // always stale → the steal branch
        owners: () => `tok-${oc++}`, // token churns → TOCTOU guard fails → never steals
      });
      // Fail-before: the post-steal `continue` jumped PAST the (then post-block)
      // deadline check WITHOUT backing off → an infinite tight loop that never
      // advanced the clock (the bug). Pass-after: deadline at the loop head + backoff
      // on the steal-retry path bounds it to ~TIMEOUT_MS and a finite attempt count.
      expect(() => withStateLock(tp.paths, () => 1, ops)).toThrow(LockTimeoutError);
      expect(state.removes).toBe(0); // never stole (token always changed)
      expect(state.sleeps.length).toBeGreaterThan(0); // backed off on the steal-retry path
      expect(state.attempts).toBeLessThan(5_000); // bounded — no infinite spin
    } finally {
      tp.cleanup();
    }
  });

  it("a lock that keeps VANISHING/reappearing (EEXIST + stat-throw each time) still times out, BOUNDED", () => {
    const tp = lockableProject();
    try {
      const { state, ops } = makeFakeOps({
        acquire: () => "EEXIST", // always held
        mtimeThrows: "ENOENT", // stat always throws → the EEXIST-vanished `continue`
      });
      // Fail-before: the vanished `continue` also jumped past the deadline + backoff →
      // infinite tight loop. Pass-after: bounded by the head deadline + backoff.
      expect(() => withStateLock(tp.paths, () => 1, ops)).toThrow(LockTimeoutError);
      expect(state.sleeps.length).toBeGreaterThan(0); // backed off on the vanished-retry path
      expect(state.attempts).toBeLessThan(5_000); // bounded
    } finally {
      tp.cleanup();
    }
  });

  it("the FRESH-held wait path still times out (deadline-at-head regression guard), bounded", () => {
    const tp = lockableProject();
    try {
      const { state, ops } = makeFakeOps({ acquire: () => "EACCES", age: 0 });
      expect(() => withStateLock(tp.paths, () => 1, ops)).toThrow(LockTimeoutError);
      expect(state.attempts).toBeLessThan(5_000);
    } finally {
      tp.cleanup();
    }
  });
});
