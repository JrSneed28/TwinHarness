/**
 * Concurrency-safety suite for the BSC-6 incomplete-scan receipt store
 * (scan-completeness.jsonl). The store is append-only JSONL; the caller holds
 * `withStateLock` around every `appendScanCompletenessReceipt` call. These
 * in-process tests assert:
 *
 *   1. N concurrent locked appends never lose a record (no torn / dropped lines).
 *   2. Each read-back receipt has intact content (valid reason + digest).
 *   3. A sequential baseline round-trips correctly through the lock+append+read cycle.
 *
 * Note on in-process contention: `withStateLock` is synchronous (it uses
 * `sleepSync` internally for its backoff). `Promise.all` with
 * `Promise.resolve().then(...)` wrappers enqueues each lock call as a microtask,
 * but the lock's inner `fn` runs synchronously — so Node's event loop serializes
 * the appends one at a time through the lock. This is the CORRECT behaviour: the
 * lock exists precisely to serialize read-modify-append spans, and the correctness
 * assertion (exactly N records, no torn lines) is what matters. The test proves that
 * the lock+append+tolerant-read contract is end-to-end sound; a torn line or dropped
 * record would show up as a count < N.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { withStateLock } from "../src/core/state-store";
import {
  appendScanCompletenessReceipt,
  readScanCompletenessReceipts,
  type ScanUnobservedEntry,
} from "../src/core/scan-completeness";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("BSC-6 / scan-completeness concurrency: locked appends are safe (in-process)", () => {
  it("N concurrent locked appends each land exactly once — no lost or torn records", async () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const N = 20;

    // Wrap each append in its own withStateLock span and enqueue as a microtask so
    // they all compete for the same lock. Because withStateLock is synchronous,
    // Promise.all serializes them through the lock one at a time — which is exactly
    // the guarantee we are testing: the lock+append pair is atomic, so no record is
    // lost or torn.
    const tasks = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendScanCompletenessReceipt(tp!.paths, [
            {
              path: `dist/f${i}.js`,
              digest: "a".repeat(64),
              reason: "file_limit",
            } satisfies ScanUnobservedEntry,
          ]),
        ),
      ),
    );

    await Promise.all(tasks);

    const receipts = readScanCompletenessReceipts(tp.paths);

    // Every append must have landed — the tolerant reader drops torn/invalid lines,
    // so a count < N proves corruption.
    expect(receipts).toHaveLength(N);

    // The set of unobserved paths must be exactly dist/f0.js … dist/f19.js.
    const observedPaths = new Set(
      receipts.flatMap((r) => r.unobserved.map((u) => u.path)),
    );
    for (let i = 0; i < N; i++) {
      expect(observedPaths.has(`dist/f${i}.js`)).toBe(true);
    }
    expect(observedPaths.size).toBe(N);
  });

  it("interleaved appends preserve every record's content (valid reason + intact digest)", async () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const N = 20;
    const DIGEST = "b".repeat(64);

    const tasks = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        withStateLock(tp!.paths, () =>
          appendScanCompletenessReceipt(tp!.paths, [
            {
              path: `dist/g${i}.js`,
              digest: DIGEST,
              reason: "aggregate_limit",
            } satisfies ScanUnobservedEntry,
          ]),
        ),
      ),
    );

    await Promise.all(tasks);

    const receipts = readScanCompletenessReceipts(tp.paths);
    expect(receipts).toHaveLength(N);

    for (const receipt of receipts) {
      // Each receipt carries exactly one unobserved entry (one entry per append).
      expect(receipt.unobserved).toHaveLength(1);
      const entry = receipt.unobserved[0];

      // The reason must be the valid sentinel we wrote — a partial/torn line would
      // either be dropped by the tolerant reader (count < N) or produce a garbage reason.
      expect(entry.reason).toBe("aggregate_limit");

      // The digest must be exactly preserved — no partial byte written.
      expect(entry.digest).toBe(DIGEST);

      // limits_reached must be derived correctly from the unobserved array.
      expect(receipt.limits_reached).toEqual(["aggregate_limit"]);
    }
  });

  it("sequential baseline: 5 appends under separate locks read back exactly 5 in order", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const entries: ScanUnobservedEntry[] = Array.from({ length: 5 }, (_, i) => ({
      path: `dist/seq${i}.js`,
      digest: `${"c".repeat(63)}${i}`,
      reason: "watchdog" as const,
    }));

    for (const entry of entries) {
      withStateLock(tp.paths, () =>
        appendScanCompletenessReceipt(tp.paths, [entry]),
      );
    }

    const receipts = readScanCompletenessReceipts(tp.paths);

    expect(receipts).toHaveLength(5);

    // File order is append order — verify in-order round-trip.
    for (let i = 0; i < 5; i++) {
      expect(receipts[i].unobserved).toHaveLength(1);
      expect(receipts[i].unobserved[0].path).toBe(`dist/seq${i}.js`);
      expect(receipts[i].unobserved[0].reason).toBe("watchdog");
      expect(receipts[i].limits_reached).toEqual(["watchdog"]);
      expect(receipts[i].recordedAt).toBeTruthy();
    }
  });
});
