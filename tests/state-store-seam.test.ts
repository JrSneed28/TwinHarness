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

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject } from "./helpers";
import { withStateLock, LockTimeoutError, LockStampError, STALE_MS, realLockOps, lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, type LockOps } from "../src/core/state-store";

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
 * the stat step throw (vanished / denied lock dir) — pass a string to throw that
 * code on EVERY stat, or a `(attempt) => code | null` function to make the throw
 * TRANSIENT (e.g. throw on attempt 1, succeed after), which models a stat that
 * momentarily hits a half-replaced lock dir mid steal-churn.
 */
function makeFakeOps(behavior: {
  acquire: (attempt: number) => string | null;
  age?: number;
  owners?: () => string | null;
  mtimeThrows?: string | ((attempt: number) => string | null);
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
      // `mtimeThrows` keyed off the CURRENT acquire attempt (state.attempts): a
      // string throws on every stat; a function may throw transiently then succeed.
      const t = behavior.mtimeThrows;
      const code = typeof t === "function" ? t(state.attempts) : t;
      if (code) throw errno(code);
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

  // REQ-STATE-LOCK-003 — a PERSISTENT stat EPERM/EACCES (held + every stat throws) is
  // NO LONGER rethrown as a raw errno. It is now treated as steal-churn and retried,
  // so a genuinely permission-denied lock dir fails SAFE: a typed, bounded
  // LockTimeoutError after the 25s deadline — never a raw EPERM crash. This is the
  // deliberate fail-safe-over-fail-fast tradeoff (the symmetric counterpart to the
  // ENOENT vanish path), and the regression guard for the steal-stat misclassification.
  for (const statCode of ["EPERM", "EACCES"]) {
    it(`persistent stat ${statCode} while held → BOUNDED LockTimeoutError, never a raw ${statCode}`, () => {
      const tp = lockableProject();
      try {
        const { state, ops } = makeFakeOps({ acquire: () => statCode, mtimeThrows: statCode });
        // The fix: a real permission fault is bounded by the deadline (typed error),
        // not surfaced as a raw errno crash.
        expect(() => withStateLock(tp.paths, () => 1, ops)).toThrow(LockTimeoutError);
        // And specifically NOT the raw errno the old code rethrew.
        expect(() => withStateLock(tp.paths, () => 1, makeFakeOps({ acquire: () => statCode, mtimeThrows: statCode }).ops))
          .not.toThrow(new RegExp(`fake ${statCode}`));
        expect(state.sleeps.length).toBeGreaterThan(0); // backed off, did not busy-spin
        expect(state.attempts).toBeLessThan(5_000); // bounded — no infinite loop
        expect(state.removes).toBe(0); // never acquired, so never released
      } finally {
        tp.cleanup();
      }
    });
  }

  // REQ-STATE-LOCK-003 — the core steal-stat-misclassification regression. Under heavy
  // Windows contention a waiter's mkdir throws a contention code (EEXIST on POSIX,
  // EPERM/EACCES on Windows) and its follow-up stat TRANSIENTLY throws EPERM/EACCES
  // because ANOTHER waiter is concurrently rmdir+mkdir-ing the same lock dir mid-steal.
  // The old code misclassified that transient stat error as a genuine permission fault
  // and rethrew the original contention errno, crashing the caller with a raw
  // `EEXIST/EPERM ... mkdir ...state.lock`. The fix treats it as churn → back off +
  // retry, so a subsequent attempt where the lock is free acquires and runs fn.
  for (const heldCode of ["EEXIST", "EPERM", "EACCES"]) {
    for (const statCode of ["EPERM", "EACCES"]) {
      it(`held ${heldCode} + TRANSIENT stat ${statCode} mid-steal → backs off, retries, then acquires (no raw errno)`, () => {
        const tp = lockableProject();
        try {
          // attempt 1: lock held (heldCode); the follow-up stat throws statCode because a
          // concurrent waiter is rmdir+mkdir-ing the lock dir → must NOT rethrow, must retry.
          // attempt 2: lock is free → acquire, run fn, return.
          const { state, ops } = makeFakeOps({
            acquire: (n) => (n === 1 ? heldCode : null),
            mtimeThrows: (n) => (n === 1 ? statCode : null),
          });
          let ran = false;
          const out = withStateLock(tp.paths, () => {
            ran = true;
            return "acquired";
          }, ops);
          expect(ran).toBe(true);
          expect(out).toBe("acquired");
          expect(state.attempts).toBe(2); // churned once → retried → acquired
          expect(state.sleeps.length).toBe(1); // backed off exactly once on the churn retry
        } finally {
          tp.cleanup();
        }
      });
    }
  }

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

describe("R-08: an OWNER-LESS stale lock is NEVER stolen — only stamped locks are steal-eligible", () => {
  // The degeneracy: `readOwner` returns null both on a read failure AND when the
  // owner stamp is simply absent (the holder's best-effort `writeOwner` threw and was
  // swallowed — common on Windows under AV/contention — or a crashed/legacy owner-less
  // lock). The OLD steal guard `if (readOwner() === ownerBefore) remove()` then became
  // `null === null` → TRUE for EVERY waiter, so two concurrent waiters BOTH passed the
  // guard and BOTH removed the dir — one clobbering a fresh third holder's LIVE lock,
  // letting two actors into `fn()`. The existing seam tests above always supply a
  // PRESENT owner ("tok"/"stable-token"), so this absent case was unexercised.

  it("owner-less + stale + always-held → NEVER calls remove() on the steal path; times out instead", () => {
    const tp = lockableProject();
    try {
      // The owner stamp is ABSENT (readOwner → null) and the lock is stale and stays
      // held forever. Pre-fix this STOLE on the first attempt (null===null → remove()).
      // Post-fix the owner-less branch backs off and waits out the deadline — it must
      // NEVER steal, so a concurrent waiter cannot also steal and clobber a live lock.
      const { state, ops } = makeFakeOps({
        acquire: () => "EEXIST", // always held
        age: STALE_MS + 5_000, // stale → the steal branch would fire IF owner-present
        owners: () => null, // OWNER-LESS — the degenerate case
      });
      expect(() => withStateLock(tp.paths, () => 1, ops)).toThrow(LockTimeoutError);
      // The crux: an owner-less lock is reclaimed via the TIMEOUT path, never STOLEN.
      // remove() is therefore never called (no acquisition either → no release remove).
      expect(state.removes).toBe(0);
      expect(state.sleeps.length).toBeGreaterThan(0); // backed off, did not busy-spin
      expect(state.attempts).toBeLessThan(5_000); // bounded — no infinite loop
    } finally {
      tp.cleanup();
    }
  });

  it("owner-less stale lock that is later RELEASED → acquires once free (waited, never stole)", () => {
    const tp = lockableProject();
    try {
      // Held + owner-less + stale for the first two attempts (must NOT steal), then the
      // (crashed) holder's lock is gone and we acquire on attempt 3. This models the
      // safe outcome: an owner-less lock is waited out, not stolen, and the section is
      // entered EXACTLY ONCE — only after the lock is genuinely free.
      const { state, ops } = makeFakeOps({
        acquire: (n) => (n <= 2 ? "EEXIST" : null),
        age: STALE_MS + 5_000,
        owners: () => null, // owner-less throughout the held attempts
      });
      let entries = 0;
      const out = withStateLock(tp.paths, () => {
        entries++;
        return "ok";
      }, ops);
      expect(out).toBe("ok");
      expect(entries).toBe(1); // EXACTLY ONE actor enters fn
      expect(state.attempts).toBe(3); // waited (not stole) twice, then acquired
      // remove() only for the release in the finally — never for a steal.
      expect(state.removes).toBe(1);
    } finally {
      tp.cleanup();
    }
  });

  it("POSITIVE CONTROL: an owner-PRESENT stale lock IS still stolen (legit stealing unbroken)", () => {
    const tp = lockableProject();
    try {
      // Contrast with the owner-less cases: a STAMPED stale lock (token stable) is still
      // steal-eligible, so this must steal (remove on the steal path) then acquire. Proves
      // the R-08 fix narrowed stealing to stamped locks WITHOUT disabling it entirely.
      const { state, ops } = makeFakeOps({
        acquire: (n) => (n === 1 ? "EEXIST" : null),
        age: STALE_MS + 5_000,
        owners: () => "stable-token", // PRESENT + stable → steal-eligible
      });
      const out = withStateLock(tp.paths, () => "stolen-then-acquired", ops);
      expect(out).toBe("stolen-then-acquired");
      expect(state.attempts).toBe(2); // stole on attempt 1, acquired on attempt 2
      expect(state.removes).toBeGreaterThanOrEqual(2); // >=1 steal + 1 release
    } finally {
      tp.cleanup();
    }
  });

  it("two waiters against the SAME owner-less stale lock: at most ONE could ever steal (both wait)", () => {
    // Model the original double-steal SCHEDULE deterministically with the seam: two
    // independent waiters each observe the SAME owner-less stale lock. Pre-fix BOTH
    // passed `null === null` and BOTH removed the dir (the second clobbering a fresh
    // third holder's live lock). Post-fix NEITHER steals — each backs off to the
    // timeout — so `remove()` is called ZERO times across both waiters, which is the
    // invariant that makes the "two actors in fn()" outcome unreachable.
    const tpA = lockableProject();
    const tpB = lockableProject();
    try {
      const mk = () =>
        makeFakeOps({ acquire: () => "EEXIST", age: STALE_MS + 5_000, owners: () => null });
      const a = mk();
      const b = mk();
      expect(() => withStateLock(tpA.paths, () => 1, a.ops)).toThrow(LockTimeoutError);
      expect(() => withStateLock(tpB.paths, () => 1, b.ops)).toThrow(LockTimeoutError);
      // The crux invariant: NEITHER waiter stole the owner-less lock (0 + 0 removes).
      expect(a.state.removes + b.state.removes).toBe(0);
    } finally {
      tpA.cleanup();
      tpB.cleanup();
    }
  });
});

describe("R-21: the owner stamp is MANDATORY — a held owner-less lock is never entered", () => {
  it("acquire ok but writeOwner ALWAYS throws → releases each time and throws LockStampError at the cap (no 25s livelock, no owner-less-held lock)", () => {
    const tp = lockableProject();
    try {
      const { state, ops } = makeFakeOps({ acquire: () => null }); // acquire always succeeds
      ops.writeOwner = () => {
        throw new Error("simulated EACCES on owner stamp (AV / read-only FS)");
      };
      // Fast-fail at MAX_STAMP_FAILS=3 — NOT a ~25s deadline livelock.
      expect(() => withStateLock(tp.paths, () => 1, ops)).toThrow(LockStampError);
      expect(state.attempts).toBe(3); // exactly the cap, not the hundreds a 25s deadline would take
      expect(state.removes).toBe(3); // each acquired-but-unstamped lock is RELEASED (never held owner-less)
      expect(state.sleeps.length).toBe(2); // backed off after fails 1 and 2; throws on fail 3 before backoff
    } finally {
      tp.cleanup();
    }
  });

  it("a TRANSIENT stamp failure (throws once, then succeeds) recovers, stamps, and runs fn", () => {
    const tp = lockableProject();
    try {
      const { state, ops } = makeFakeOps({ acquire: () => null });
      let stampCalls = 0;
      ops.writeOwner = () => {
        stampCalls++;
        if (stampCalls === 1) throw new Error("transient AV block");
        // 2nd stamp succeeds.
      };
      let ran = false;
      const out = withStateLock(tp.paths, () => {
        ran = true;
        return "ok";
      }, ops);
      expect(ran).toBe(true);
      expect(out).toBe("ok");
      expect(state.attempts).toBe(2); // released the unstamped lock, re-acquired, stamped, ran
      expect(state.removes).toBe(2); // 1 release of the failed-stamp lock + 1 finally release
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

// The lock-acquisition deadline is env-tunable (TH_LOCK_TIMEOUT_MS) so an
// oversubscribed CI runner — or an operator on a slow/networked filesystem —
// can grant a heavily contended waiter more patience than the 25s default
// before it gives up. The default and the parse guard are pinned here.
describe("lockTimeoutMs: TH_LOCK_TIMEOUT_MS deadline override", () => {
  const saved = process.env.TH_LOCK_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.TH_LOCK_TIMEOUT_MS;
    else process.env.TH_LOCK_TIMEOUT_MS = saved;
  });

  it("defaults to 25s when the env var is unset", () => {
    delete process.env.TH_LOCK_TIMEOUT_MS;
    expect(lockTimeoutMs()).toBe(DEFAULT_LOCK_TIMEOUT_MS);
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBe(25_000);
  });

  it("honors a positive integer override", () => {
    process.env.TH_LOCK_TIMEOUT_MS = "90000";
    expect(lockTimeoutMs()).toBe(90_000);
  });

  it("falls back to the default for non-numeric / non-positive values", () => {
    for (const bad of ["abc", "", "0", "-5", "NaN"]) {
      process.env.TH_LOCK_TIMEOUT_MS = bad;
      expect(lockTimeoutMs(), `"${bad}" must fall back`).toBe(DEFAULT_LOCK_TIMEOUT_MS);
    }
  });
});
