/**
 * R-38 — the PID-liveness steal-guard: a stale lock is stolen ONLY when its owner
 * is NOT alive, so a LIVE holder whose critical section legitimately ran past
 * STALE_MS is NEVER robbed (the lost-update probe #1 confirmed in Phase 5).
 *
 * Fail-before / pass-after: against the pre-R-38 age-only steal, the "live holder is
 * NOT stolen from" case RED-ed (the waiter stole the live lock → both ran fn() → lost
 * update). Post-R-38 the steal branch gates on `isPidAlive(ownerPid)`:
 *   - owner ALIVE   ⇒ no steal; the waiter waits to the (bounded) deadline → loud
 *                     LockTimeoutError, never a silent steal.
 *   - owner DEAD    ⇒ steal after age (crash-recovery preserved).
 *   - owner UNPARSEABLE ⇒ age-only fallback (an abandoned/legacy stamp — recovery kept).
 *
 * These use the deterministic in-process LockOps seam (virtual clock + injected
 * liveness verdict) so they are CI-safe and need no real second process — plus a
 * focused unit test on the liveness predicate itself against REAL pids.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import {
  withStateLock,
  LockTimeoutError,
  STALE_MS,
  parseOwnerPid,
  isPidAlive,
  realLockOps,
  type LockOps,
} from "../src/core/state-store";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

function lockableProject(): TempProject {
  tp = makeTempProject();
  fs.mkdirSync(tp.paths.stateDir, { recursive: true });
  return tp;
}

/**
 * A deterministic seam: the lock is ALWAYS held + ALWAYS stale, with a PARSEABLE
 * owner token (`<pid>-nonce`). `pidAlive` drives the R-38 liveness verdict; the
 * virtual clock advances on each sleep so the bounded deadline is reached fast.
 */
function heldStaleOps(opts: { ownerPid: number; pidAlive: boolean }): { ops: LockOps; removes: () => number } {
  let now = 1_000_000;
  let removeCount = 0;
  const token = `${opts.ownerPid}-deadbeefnonce`;
  const ops: LockOps = {
    now: () => now,
    sleep: (ms) => { now += Math.max(1, Math.ceil(ms)); },
    acquire: () => { throw Object.assign(new Error("held"), { code: "EEXIST" }); }, // always held
    mtimeMs: () => now - (STALE_MS + 5_000), // always stale
    remove: () => { removeCount++; },
    readOwner: () => token, // present + stable + PARSEABLE pid
    writeOwner: () => {},
    isPidAlive: () => opts.pidAlive,
  };
  return { ops, removes: () => removeCount };
}

describe("R-38 — a LIVE holder's stale lock is NEVER stolen (no lost update)", () => {
  it("owner pid ALIVE + stale age ⇒ no steal; the waiter times out LOUDLY instead", () => {
    const t = lockableProject();
    const { ops, removes } = heldStaleOps({ ownerPid: 4242, pidAlive: true });
    // The lock is stale by age but its owner is ALIVE → the steal branch must NOT fire.
    // With the lock never released, the waiter exhausts the deadline and throws a
    // typed LockTimeoutError — a recoverable error, NOT a silent steal/lost-update.
    expect(() => withStateLock(t.paths, () => 1, ops)).toThrow(LockTimeoutError);
    // The crux: the live owner's lock was never removed (never stolen).
    expect(removes()).toBe(0);
  });
});

describe("R-38 — a DEAD holder's stale lock is STILL stolen (crash-recovery preserved)", () => {
  it("owner pid DEAD + stale age ⇒ steal fires and fn runs", () => {
    const t = lockableProject();
    let acquireCalls = 0;
    let removed = false;
    let now = 1_000_000;
    const token = "9999-nonce";
    // Held+stale on attempt 1 (owner dead → steal), free on attempt 2 (post-steal acquire).
    const ops: LockOps = {
      now: () => now,
      sleep: (ms) => { now += Math.max(1, Math.ceil(ms)); },
      acquire: () => {
        acquireCalls++;
        if (acquireCalls === 1) throw Object.assign(new Error("held"), { code: "EEXIST" });
        // attempt 2: acquires (the steal freed it).
      },
      mtimeMs: () => now - (STALE_MS + 5_000),
      remove: () => { removed = true; },
      readOwner: () => token,
      writeOwner: () => {},
      isPidAlive: () => false, // owner is DEAD → steal-eligible
    };
    let ran = false;
    const out = withStateLock(t.paths, () => { ran = true; return 42; }, ops);
    expect(removed).toBe(true); // the dead holder's lock was stolen
    expect(ran).toBe(true);
    expect(out).toBe(42);
  });

  it("owner token UNPARSEABLE (no pid) + stale age ⇒ age-only fallback still steals (no recovery regression)", () => {
    const t = lockableProject();
    let acquireCalls = 0;
    let removed = false;
    let now = 1_000_000;
    const ops: LockOps = {
      now: () => now,
      sleep: (ms) => { now += Math.max(1, Math.ceil(ms)); },
      acquire: () => {
        acquireCalls++;
        if (acquireCalls === 1) throw Object.assign(new Error("held"), { code: "EEXIST" });
      },
      mtimeMs: () => now - (STALE_MS + 5_000),
      remove: () => { removed = true; },
      readOwner: () => "legacy-unparseable-token", // no <pid>- prefix → parseOwnerPid = null
      writeOwner: () => {},
      isPidAlive: () => true, // even if "alive" were reported, the unparseable pid → fallback
    };
    const out = withStateLock(t.paths, () => 7, ops);
    // Fallback to age-only steal: an abandoned/legacy stamp is reclaimed, recovery intact.
    expect(removed).toBe(true);
    expect(out).toBe(7);
  });
});

describe("R-38 — parseOwnerPid + isPidAlive predicates", () => {
  it("parseOwnerPid extracts the leading pid from a `<pid>-<nonce>` token; null on anything else", () => {
    expect(parseOwnerPid("1234-abcdef")).toBe(1234);
    expect(parseOwnerPid(`${process.pid}-xyz`)).toBe(process.pid);
    // Non-conforming / unusable tokens → null (the caller falls back to age-only).
    expect(parseOwnerPid(null)).toBeNull();
    expect(parseOwnerPid("")).toBeNull();
    expect(parseOwnerPid("no-pid-here")).toBeNull();
    expect(parseOwnerPid("crashed-holder-token")).toBeNull();
    expect(parseOwnerPid("-5-nonce")).toBeNull(); // leading '-' → no digit prefix
    expect(parseOwnerPid("0-nonce")).toBeNull(); // pid 0 is not a valid holder pid
  });

  it("isPidAlive: our OWN pid is alive; a definitely-dead pid is not", () => {
    // This process is alive.
    expect(isPidAlive(process.pid)).toBe(true);
    // A pid that cannot exist is dead (ESRCH). A non-integer / non-positive is dead.
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(2_147_483_646)).toBe(false); // near-INT_MAX pid: not a live process
  });

  it("realLockOps wires isPidAlive to the real liveness probe (self = alive)", () => {
    expect(typeof realLockOps.isPidAlive).toBe("function");
    expect(realLockOps.isPidAlive(process.pid)).toBe(true);
  });
});

describe("R-38 — real-fs end-to-end: a stale lock owned by THIS (alive) process is not stolen", () => {
  it("a stale, stamped lock whose owner pid is THIS live process is NOT stolen (times out)", () => {
    // The most faithful in-process proof: stamp the lock with OUR OWN pid (which is
    // provably alive) and age it past STALE_MS, then a withStateLock call (real ops)
    // must REFUSE to steal it and instead time out — never rob a live owner. We use a
    // short TH_LOCK_TIMEOUT_MS so the bounded wait is quick.
    const t = lockableProject();
    const lockDir = `${t.paths.stateDir}/.state.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(`${lockDir}/owner`, `${process.pid}-livenonce`, "utf8");
    const old = Date.now() - 60_000; // older than STALE_MS (15s)
    fs.utimesSync(lockDir, new Date(old), new Date(old));

    const saved = process.env.TH_LOCK_TIMEOUT_MS;
    process.env.TH_LOCK_TIMEOUT_MS = "1500"; // bound the wait so the test is fast
    try {
      expect(() => withStateLock(t.paths, () => 1)).toThrow(LockTimeoutError);
      // The live owner's lock survived (was not stolen): the dir + our stamp remain.
      expect(fs.existsSync(lockDir)).toBe(true);
      expect(fs.readFileSync(`${lockDir}/owner`, "utf8")).toBe(`${process.pid}-livenonce`);
    } finally {
      if (saved === undefined) delete process.env.TH_LOCK_TIMEOUT_MS;
      else process.env.TH_LOCK_TIMEOUT_MS = saved;
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });
});
