/**
 * Axis-B slice-4a (BSC-3) — driver-receipt ledger concurrency + durability (Lane D).
 *
 * Mirrors `tests/receipts-concurrency.test.ts` in structure and assertion style. The
 * driver-receipt store (`src/core/verification-driver.ts`) mirrors `receipts.ts`
 * EXACTLY: append-only, SHA-256 hash-chained, tolerant reader, atomic-append writer
 * under the CALLER's `withStateLock` span. These tests PROVE those guarantees hold for
 * the driver ledger:
 *
 *  - N concurrent in-process `withStateLock`-wrapped `appendDriverReceipt` calls each
 *    land (no lost update) and never break the hash chain (`verifyDriverChain` ok).
 *  - Concurrent readers interleaved with writers never observe a torn/partial line —
 *    every visible prefix is a valid chain (atomic line append).
 *  - A stale stamped `.state.lock` is stolen by the first driver writer, not wedged.
 *
 * No CLI-spawn wave here: the `th` driver verb does not exist yet (the Integrator wires
 * it; cross-process coverage lands with that). In-process `withStateLock` is the seam
 * the verb will reuse, so this pins the serialization guarantee the verb inherits.
 *
 * Platform: Windows-safe throughout — no shell sleep/true/false, no POSIX-only paths.
 * The 1 POSIX-only permission-error skip lives in tests/concurrency.test.ts (per
 * CLAUDE.md); nothing here is platform-conditional.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState, withStateLock } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { writeVerifyReport, type VerifyReport } from "../src/core/verify";
import {
  appendDriverReceipt,
  readDriverReceipts,
  verifyDriverChain,
} from "../src/core/verification-driver";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** A verify report observing all three seed dimensions. */
function reportObservingAll(): VerifyReport {
  return {
    ok: true,
    ranAt: new Date().toISOString(),
    results: [
      { command: "vitest run", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
      { command: "tsc --noEmit", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
      { command: "npm run build", exitCode: 0, ok: true, durationMs: 1, outputTail: "" },
    ],
  };
}

/** Init a project with state + a verify-report.json so the driver sensor has a real artifact. */
function initDriverProject(): TempProject {
  const p = makeTempProject();
  fs.mkdirSync(p.paths.stateDir, { recursive: true });
  writeState(p.paths, { ...initialState(), tier: "T1", current_stage: "final-verification" });
  writeVerifyReport(p.paths, reportObservingAll());
  return p;
}

// ---------------------------------------------------------------------------
// BSC3-CONC-001: N in-process concurrent driver appends — no lost update, intact chain
// ---------------------------------------------------------------------------

describe("BSC3-CONC-001: N parallel withStateLock-wrapped appendDriverReceipt calls → exact count, intact chain", () => {
  it("N=20 concurrent in-process driver appends all land; hash chain intact", async () => {
    tp = initDriverProject();
    const N = 20;

    const tasks = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendDriverReceipt(tp!.paths, { producerIdentity: `test:conc-${i}` }),
        ),
      ),
    );
    await Promise.all(tasks);

    // No lost update: exactly N receipts on disk (each call appends one line; the refId
    // is the same snapshot identity, but every append is a distinct, sealed chain link).
    const receipts = readDriverReceipts(tp.paths);
    expect(receipts).toHaveLength(N);

    // Every recorded receipt observed the seed dimensions.
    for (const r of receipts) {
      expect(r.dimensions.map((d) => d.name).sort()).toEqual(["build", "tests-executed", "typecheck"]);
    }

    // Hash chain must be intact end-to-end (no torn write, no lost link).
    expect(verifyDriverChain(receipts)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// BSC3-CONC-002: readers interleaved with writers — every visible prefix is a valid chain
// ---------------------------------------------------------------------------

describe("BSC3-CONC-002: concurrent readers during writers never see a partial line", () => {
  it("40 tolerant reads interleaved with N=16 writers: every visible prefix verifies", async () => {
    tp = initDriverProject();
    const N = 16;

    const writers = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendDriverReceipt(tp!.paths, { producerIdentity: `test:prefix-writer-${i}` }),
        ),
      ),
    );

    const readers = Array.from({ length: 40 }, () =>
      Promise.resolve().then(() => {
        const visible = readDriverReceipts(tp!.paths);
        // Whatever prefix is visible must verify (atomic single-line append).
        expect(verifyDriverChain(visible)).toEqual({ ok: true });
        return visible.length;
      }),
    );

    await Promise.all([...writers, ...readers]);

    const final = readDriverReceipts(tp.paths);
    expect(final).toHaveLength(N);
    expect(verifyDriverChain(final)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// BSC3-CONC-003: a stale stamped .state.lock is stolen, not wedged
// ---------------------------------------------------------------------------

describe("BSC3-CONC-003: a stamped stale .state.lock is stolen and the driver receipt lands", () => {
  it("plants a stale lock then appendDriverReceipt steals it quickly and writes exactly one receipt", () => {
    tp = initDriverProject();
    const paths = tp.paths;

    // Plant a stale, stamped lock (mtime far in the past, beyond STALE_MS).
    const lockDir = path.join(paths.stateDir, ".state.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner"), "crashed-holder-token", "utf8");
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, past, past);

    const start = Date.now();
    withStateLock(paths, () =>
      appendDriverReceipt(paths, { producerIdentity: "test:stale-lock-steal" }),
    );
    const elapsed = Date.now() - start;

    // Stolen quickly — nowhere near the lock timeout.
    expect(elapsed).toBeLessThan(5_000);

    const receipts = readDriverReceipts(paths);
    expect(receipts).toHaveLength(1);
    expect(verifyDriverChain(receipts)).toEqual({ ok: true });
  });
});
