/**
 * Axis-B slice-7 (BSC-5) — dimension-set-coverage-receipt ledger concurrency + durability.
 * Mirrors `tests/assertion-presence-concurrency.test.ts` / `tests/bsc3-driver-concurrency.test.ts`
 * in structure and assertion style. The coverage store (`appendCoverageReceipt` in
 * `src/core/receipts.ts`) mirrors the driver/assertion stores EXACTLY: append-only, SHA-256
 * hash-chained, tolerant reader, atomic-append writer under the CALLER's `withStateLock` span.
 * These tests PROVE those guarantees hold for the coverage ledger:
 *
 *  - N concurrent in-process `withStateLock`-wrapped `appendCoverageReceipt` calls each land
 *    (no lost update) and never break the hash chain (`verifyCoverageChain` ok) — no forked prevHash.
 *  - Concurrent readers interleaved with writers never observe a torn/partial line — every visible
 *    prefix is a valid chain (atomic single-line append).
 *  - A stale stamped `.state.lock` is stolen by the first writer, not wedged.
 *
 * Each receipt records the committed declared-set digest + a fixed observed set. Platform:
 * Windows-safe throughout (no shell sleep/true/false, no POSIX-only paths). No `dist/` build
 * required — runs against `src/`.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState, withStateLock } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { appendCoverageReceipt, readCoverageReceipts, verifyCoverageChain } from "../src/core/receipts";
import { declaredDimensionSet, declaredDimensionSetDigest } from "../src/core/declared-dimensions";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Init a project with state so the coverage store has a home. */
function initCoverageProject(): TempProject {
  const p = makeTempProject();
  fs.mkdirSync(p.paths.stateDir, { recursive: true });
  writeState(p.paths, { ...initialState(), tier: "T1", current_stage: "final-verification" });
  return p;
}

/** A coverage mint input grounded in the live committed declared set + all-observed. */
function mintInput(i: number) {
  return {
    producerIdentity: `test:conc-${i}`,
    declaredSetDigest: declaredDimensionSetDigest(),
    declaredSet: declaredDimensionSet(),
    observedSet: ["tests-executed", "typecheck", "build"],
  };
}

// ---------------------------------------------------------------------------
// BSC5-CONC-001: N in-process concurrent appends — no lost update, intact chain
// ---------------------------------------------------------------------------

describe("BSC5-CONC-001: N parallel withStateLock-wrapped appendCoverageReceipt calls → exact count, intact chain", () => {
  it("N=20 concurrent in-process coverage appends all land; hash chain intact (no forked prevHash)", async () => {
    tp = initCoverageProject();
    const N = 20;

    const tasks = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () => appendCoverageReceipt(tp!.paths, mintInput(i))),
      ),
    );
    await Promise.all(tasks);

    // No lost update: exactly N receipts on disk, each a distinct sealed chain link.
    const receipts = readCoverageReceipts(tp.paths);
    expect(receipts).toHaveLength(N);

    // Every receipt recorded covered:true over the committed declared set.
    for (const r of receipts) {
      expect(r.covered).toBe(true);
      expect(r.declared_set_digest).toBe(declaredDimensionSetDigest());
    }

    // Hash chain intact end-to-end (no torn write, no lost link, no forked prevHash).
    expect(verifyCoverageChain(receipts)).toEqual({ ok: true });
    for (let i = 1; i < receipts.length; i++) {
      expect(receipts[i]!.prevHash).toBe(receipts[i - 1]!.recordHash);
    }
  });
});

// ---------------------------------------------------------------------------
// BSC5-CONC-002: readers interleaved with writers — every visible prefix is a valid chain
// ---------------------------------------------------------------------------

describe("BSC5-CONC-002: concurrent readers during writers never see a partial line", () => {
  it("40 tolerant reads interleaved with N=16 writers: every visible prefix verifies", async () => {
    tp = initCoverageProject();
    const N = 16;

    const writers = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () => appendCoverageReceipt(tp!.paths, mintInput(i))),
      ),
    );

    const readers = Array.from({ length: 40 }, () =>
      Promise.resolve().then(() => {
        const visible = readCoverageReceipts(tp!.paths);
        expect(verifyCoverageChain(visible)).toEqual({ ok: true });
        return visible.length;
      }),
    );

    await Promise.all([...writers, ...readers]);

    const final = readCoverageReceipts(tp.paths);
    expect(final).toHaveLength(N);
    expect(verifyCoverageChain(final)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// BSC5-CONC-003: a stale stamped .state.lock is stolen, not wedged
// ---------------------------------------------------------------------------

describe("BSC5-CONC-003: a stamped stale .state.lock is stolen and the coverage receipt lands", () => {
  it("plants a stale lock then appendCoverageReceipt steals it quickly and writes exactly one receipt", () => {
    tp = initCoverageProject();
    const paths = tp.paths;

    const lockDir = path.join(paths.stateDir, ".state.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner"), "crashed-holder-token", "utf8");
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, past, past);

    const start = Date.now();
    withStateLock(paths, () => appendCoverageReceipt(paths, mintInput(0)));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5_000);

    const receipts = readCoverageReceipts(paths);
    expect(receipts).toHaveLength(1);
    expect(verifyCoverageChain(receipts)).toEqual({ ok: true });
  });
});
