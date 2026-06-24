/**
 * Axis-B slice-7 (BSC-9) — interview-readiness-receipt ledger concurrency + durability. Mirrors
 * `tests/bsc1-realization-concurrency.test.ts` in structure and assertion style. The readiness
 * store (`src/core/interview-readiness.ts`) mirrors the realization/driver/terminal stores EXACTLY:
 * append-only, SHA-256 hash-chained, tolerant reader, atomic-append writer under the CALLER's
 * `withStateLock` span. These tests PROVE those guarantees hold for the readiness ledger:
 *
 *  - N concurrent in-process `withStateLock`-wrapped `appendReadinessReceipt` calls each land
 *    (no lost update) and never break the hash chain (`verifyReadinessChain` ok).
 *  - Concurrent readers interleaved with writers never observe a torn/partial line — every
 *    visible prefix is a valid chain (atomic single-line append).
 *  - A stale stamped `.state.lock` is stolen by the first readiness writer, not wedged.
 *
 * The store path resolves in source (refuse-at-creation requires it). Platform: Windows-safe.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState, withStateLock } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import {
  appendReadinessReceipt,
  readReadinessReceipts,
  verifyReadinessChain,
} from "../src/core/interview-readiness";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

const STORE = ".twinharness/interview.json";

/** Init a project with state + a real interview store so the readiness producer can bind it. */
function initReadinessProject(): TempProject {
  const p = makeTempProject();
  fs.mkdirSync(p.paths.stateDir, { recursive: true });
  writeState(p.paths, { ...initialState(), tier: "T1", current_stage: "final-verification" });
  const abs = path.resolve(p.paths.root, STORE);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify({ idea: "x", cutoff: 0.8, rounds: [], confidence: 0.95, status: "in-progress" }) + "\n", "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// BSC9-CONC-001: N in-process concurrent readiness appends — no lost update, intact chain
// ---------------------------------------------------------------------------

describe("BSC9-CONC-001: N parallel withStateLock-wrapped appendReadinessReceipt calls → exact count, intact chain", () => {
  it("N=20 concurrent in-process readiness appends all land; hash chain intact", async () => {
    tp = initReadinessProject();
    const N = 20;

    const tasks = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendReadinessReceipt(tp!.paths, {
            refId: `RUN-${String(i).padStart(3, "0")}`,
            confidence: 0.95,
            cutoff: 0.8,
            storePath: STORE,
            producerIdentity: `test:conc-${i}`,
          }),
        ),
      ),
    );
    await Promise.all(tasks);

    // No lost update: exactly N receipts on disk, each a distinct sealed chain link.
    const receipts = readReadinessReceipts(tp.paths);
    expect(receipts).toHaveLength(N);
    // Every distinct refId landed exactly once.
    expect(new Set(receipts.map((r) => r.refId)).size).toBe(N);
    // Hash chain intact end-to-end (no torn write, no lost link).
    expect(verifyReadinessChain(receipts)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// BSC9-CONC-002: readers interleaved with writers — every visible prefix is a valid chain
// ---------------------------------------------------------------------------

describe("BSC9-CONC-002: concurrent readers during writers never see a partial line", () => {
  it("40 tolerant reads interleaved with N=16 writers: every visible prefix verifies", async () => {
    tp = initReadinessProject();
    const N = 16;

    const writers = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendReadinessReceipt(tp!.paths, {
            refId: `RUN-${String(i).padStart(3, "0")}`,
            confidence: 0.95,
            cutoff: 0.8,
            storePath: STORE,
            producerIdentity: `test:prefix-writer-${i}`,
          }),
        ),
      ),
    );

    const readers = Array.from({ length: 40 }, () =>
      Promise.resolve().then(() => {
        const visible = readReadinessReceipts(tp!.paths);
        // Whatever prefix is visible must verify (atomic single-line append).
        expect(verifyReadinessChain(visible)).toEqual({ ok: true });
        return visible.length;
      }),
    );

    await Promise.all([...writers, ...readers]);

    const final = readReadinessReceipts(tp.paths);
    expect(final).toHaveLength(N);
    expect(verifyReadinessChain(final)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// BSC9-CONC-003: a stale stamped .state.lock is stolen, not wedged
// ---------------------------------------------------------------------------

describe("BSC9-CONC-003: a stamped stale .state.lock is stolen and the readiness receipt lands", () => {
  it("plants a stale lock then appendReadinessReceipt steals it quickly and writes exactly one receipt", () => {
    tp = initReadinessProject();
    const paths = tp.paths;

    // Plant a stale, stamped lock (mtime far in the past, beyond STALE_MS).
    const lockDir = path.join(paths.stateDir, ".state.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner"), "crashed-holder-token", "utf8");
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, past, past);

    const start = Date.now();
    withStateLock(paths, () =>
      appendReadinessReceipt(paths, {
        refId: "RUN-001",
        confidence: 0.95,
        cutoff: 0.8,
        storePath: STORE,
        producerIdentity: "test:stale-lock-steal",
      }),
    );
    const elapsed = Date.now() - start;

    // Stolen quickly — nowhere near the lock timeout.
    expect(elapsed).toBeLessThan(5_000);

    const receipts = readReadinessReceipts(paths);
    expect(receipts).toHaveLength(1);
    expect(verifyReadinessChain(receipts)).toEqual({ ok: true });
  });
});
