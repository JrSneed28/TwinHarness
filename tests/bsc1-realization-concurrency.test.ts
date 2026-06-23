/**
 * Axis-B slice-5 (BSC-1) — realization-receipt ledger concurrency + durability. Mirrors
 * `tests/bsc3-driver-concurrency.test.ts` in structure and assertion style. The realization
 * store (`src/core/realization.ts`) mirrors the driver/terminal stores EXACTLY: append-only,
 * SHA-256 hash-chained, tolerant reader, atomic-append writer under the CALLER's
 * `withStateLock` span. These tests PROVE those guarantees hold for the realization ledger:
 *
 *  - N concurrent in-process `withStateLock`-wrapped `appendRealizationReceipt` calls each
 *    land (no lost update) and never break the hash chain (`verifyRealizationChain` ok).
 *  - Concurrent readers interleaved with writers never observe a torn/partial line — every
 *    visible prefix is a valid chain (atomic single-line append).
 *  - A stale stamped `.state.lock` is stolen by the first realization writer, not wedged.
 *
 * The referent path resolves in source (refuse-at-creation requires it). Platform: Windows-safe
 * throughout — no shell sleep/true/false, no POSIX-only paths.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState, withStateLock } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import {
  appendRealizationReceipt,
  readRealizationReceipts,
  verifyRealizationChain,
} from "../src/core/realization";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

const REFERENT = "src/a.ts";

/** Init a project with state + a real source referent so the realization producer can bind it. */
function initRealizationProject(): TempProject {
  const p = makeTempProject();
  fs.mkdirSync(p.paths.stateDir, { recursive: true });
  writeState(p.paths, { ...initialState(), tier: "T1", current_stage: "final-verification" });
  const abs = path.resolve(p.paths.root, REFERENT);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "export const a = 1;\n", "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// BSC1-CONC-001: N in-process concurrent realization appends — no lost update, intact chain
// ---------------------------------------------------------------------------

describe("BSC1-CONC-001: N parallel withStateLock-wrapped appendRealizationReceipt calls → exact count, intact chain", () => {
  it("N=20 concurrent in-process realization appends all land; hash chain intact", async () => {
    tp = initRealizationProject();
    const N = 20;

    const tasks = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendRealizationReceipt(tp!.paths, {
            reqId: `REQ-${String(i).padStart(3, "0")}`,
            owningSlice: "SLICE-0",
            artifactPath: REFERENT,
            producerIdentity: `test:conc-${i}`,
          }),
        ),
      ),
    );
    await Promise.all(tasks);

    // No lost update: exactly N receipts on disk, each a distinct sealed chain link.
    const receipts = readRealizationReceipts(tp.paths);
    expect(receipts).toHaveLength(N);
    // Every distinct REQ-ID landed exactly once.
    expect(new Set(receipts.map((r) => r.req_id)).size).toBe(N);
    // Hash chain intact end-to-end (no torn write, no lost link).
    expect(verifyRealizationChain(receipts)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// BSC1-CONC-002: readers interleaved with writers — every visible prefix is a valid chain
// ---------------------------------------------------------------------------

describe("BSC1-CONC-002: concurrent readers during writers never see a partial line", () => {
  it("40 tolerant reads interleaved with N=16 writers: every visible prefix verifies", async () => {
    tp = initRealizationProject();
    const N = 16;

    const writers = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendRealizationReceipt(tp!.paths, {
            reqId: `REQ-${String(i).padStart(3, "0")}`,
            owningSlice: "SLICE-0",
            artifactPath: REFERENT,
            producerIdentity: `test:prefix-writer-${i}`,
          }),
        ),
      ),
    );

    const readers = Array.from({ length: 40 }, () =>
      Promise.resolve().then(() => {
        const visible = readRealizationReceipts(tp!.paths);
        // Whatever prefix is visible must verify (atomic single-line append).
        expect(verifyRealizationChain(visible)).toEqual({ ok: true });
        return visible.length;
      }),
    );

    await Promise.all([...writers, ...readers]);

    const final = readRealizationReceipts(tp.paths);
    expect(final).toHaveLength(N);
    expect(verifyRealizationChain(final)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// BSC1-CONC-003: a stale stamped .state.lock is stolen, not wedged
// ---------------------------------------------------------------------------

describe("BSC1-CONC-003: a stamped stale .state.lock is stolen and the realization receipt lands", () => {
  it("plants a stale lock then appendRealizationReceipt steals it quickly and writes exactly one receipt", () => {
    tp = initRealizationProject();
    const paths = tp.paths;

    // Plant a stale, stamped lock (mtime far in the past, beyond STALE_MS).
    const lockDir = path.join(paths.stateDir, ".state.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner"), "crashed-holder-token", "utf8");
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, past, past);

    const start = Date.now();
    withStateLock(paths, () =>
      appendRealizationReceipt(paths, {
        reqId: "REQ-001",
        owningSlice: "SLICE-0",
        artifactPath: REFERENT,
        producerIdentity: "test:stale-lock-steal",
      }),
    );
    const elapsed = Date.now() - start;

    // Stolen quickly — nowhere near the lock timeout.
    expect(elapsed).toBeLessThan(5_000);

    const receipts = readRealizationReceipts(paths);
    expect(receipts).toHaveLength(1);
    expect(verifyRealizationChain(receipts)).toEqual({ ok: true });
  });
});
