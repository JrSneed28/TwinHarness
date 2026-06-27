/**
 * Axis-B slice-6 (BSC-2) — assertion-presence-receipt ledger concurrency + durability (Lane D,
 * deliverable 5). Mirrors `tests/bsc3-driver-concurrency.test.ts` / `tests/bsc1-realization-
 * concurrency.test.ts` in structure and assertion style. The assertion-presence store
 * (`src/core/assertion-presence.ts`) mirrors the driver/realization stores EXACTLY: append-only,
 * SHA-256 hash-chained, tolerant reader, atomic-append writer under the CALLER's `withStateLock`
 * span. These tests PROVE those guarantees hold for the assertion-presence ledger:
 *
 *  - N concurrent in-process `withStateLock`-wrapped `appendAssertionPresenceReceipt` calls each
 *    land (no lost update) and never break the hash chain (`verifyAssertionPresenceChain` ok) —
 *    no forked prevHash.
 *  - Concurrent readers interleaved with writers never observe a torn/partial line — every visible
 *    prefix is a valid chain (atomic single-line append).
 *  - A stale stamped `.state.lock` is stolen by the first writer, not wedged.
 *
 * Each receipt's ground is recomputed FRESH at mint from `<root>/tests`, so the fixture writes a
 * stable tests dir up front; every append records the SAME ground (the chain still advances because
 * each append seals a distinct prevHash→recordHash link). Platform: Windows-safe throughout — no
 * shell sleep/true/false, no POSIX-only paths. No `dist/` build required — runs against `src/`.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState, withStateLock } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import {
  appendAssertionPresenceReceipt,
  readAssertionPresenceReceipts,
  verifyAssertionPresenceChain,
} from "../src/core/assertion-presence";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Init a project with state + a tests dir carrying a real assertion so the sensor has ground. */
function initAssertionProject(): TempProject {
  const p = makeTempProject();
  fs.mkdirSync(p.paths.stateDir, { recursive: true });
  writeState(p.paths, { ...initialState(), tier: "T1", current_stage: "final-verification" });
  const abs = path.resolve(p.paths.root, "tests", "cov.test.ts");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(
    abs,
    `// REQ-001\nimport { it, expect } from "vitest";\nit("x", () => { expect(compute()).toBe(42); });\n`,
    "utf8",
  );
  return p;
}

// ---------------------------------------------------------------------------
// BSC2-CONC-001: N in-process concurrent appends — no lost update, intact chain
// ---------------------------------------------------------------------------

describe("BSC2-CONC-001: N parallel withStateLock-wrapped appendAssertionPresenceReceipt calls → exact count, intact chain", () => {
  it("N=20 concurrent in-process assertion-presence appends all land; hash chain intact (no forked prevHash)", async () => {
    tp = initAssertionProject();
    const N = 20;

    const tasks = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendAssertionPresenceReceipt(tp!.paths, { producerIdentity: `test:conc-${i}` }),
        ),
      ),
    );
    await Promise.all(tasks);

    // No lost update: exactly N receipts on disk, each a distinct sealed chain link.
    const receipts = readAssertionPresenceReceipts(tp.paths);
    expect(receipts).toHaveLength(N);

    // Every receipt recorded the same fresh ground (REQ-001 present, non-trivial).
    for (const r of receipts) {
      expect(r.ground.map((g) => g.reqId)).toContain("REQ-001");
    }

    // Hash chain intact end-to-end (no torn write, no lost link, no forked prevHash).
    expect(verifyAssertionPresenceChain(receipts)).toEqual({ ok: true });

    // No forked prevHash: each link's prevHash equals the previous link's recordHash.
    for (let i = 1; i < receipts.length; i++) {
      expect(receipts[i]!.prevHash).toBe(receipts[i - 1]!.recordHash);
    }
  });
});

// ---------------------------------------------------------------------------
// BSC2-CONC-002: readers interleaved with writers — every visible prefix is a valid chain
// ---------------------------------------------------------------------------

describe("BSC2-CONC-002: concurrent readers during writers never see a partial line", () => {
  it("40 tolerant reads interleaved with N=16 writers: every visible prefix verifies", async () => {
    tp = initAssertionProject();
    const N = 16;

    const writers = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendAssertionPresenceReceipt(tp!.paths, { producerIdentity: `test:prefix-writer-${i}` }),
        ),
      ),
    );

    const readers = Array.from({ length: 40 }, () =>
      Promise.resolve().then(() => {
        const visible = readAssertionPresenceReceipts(tp!.paths);
        // Whatever prefix is visible must verify (atomic single-line append).
        expect(verifyAssertionPresenceChain(visible)).toEqual({ ok: true });
        return visible.length;
      }),
    );

    await Promise.all([...writers, ...readers]);

    const final = readAssertionPresenceReceipts(tp.paths);
    expect(final).toHaveLength(N);
    expect(verifyAssertionPresenceChain(final)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// BSC2-CONC-003: a stale stamped .state.lock is stolen, not wedged
// ---------------------------------------------------------------------------

describe("BSC2-CONC-003: a stamped stale .state.lock is stolen and the assertion-presence receipt lands", () => {
  it("plants a stale lock then appendAssertionPresenceReceipt steals it quickly and writes exactly one receipt", () => {
    tp = initAssertionProject();
    const paths = tp.paths;

    // Plant a stale, stamped lock (mtime far in the past, beyond STALE_MS).
    const lockDir = path.join(paths.stateDir, ".state.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner"), "crashed-holder-token", "utf8");
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, past, past);

    const start = Date.now();
    withStateLock(paths, () =>
      appendAssertionPresenceReceipt(paths, { producerIdentity: "test:stale-lock-steal" }),
    );
    const elapsed = Date.now() - start;

    // Stolen quickly — nowhere near the lock timeout.
    expect(elapsed).toBeLessThan(5_000);

    const receipts = readAssertionPresenceReceipts(paths);
    expect(receipts).toHaveLength(1);
    expect(verifyAssertionPresenceChain(receipts)).toEqual({ ok: true });
  });
});
