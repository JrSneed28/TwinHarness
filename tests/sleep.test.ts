/**
 * PERF-007 (P1-8) — `sleepSync` is a zero-CPU synchronous sleep.
 *
 * The state lock and the atomic-write/read retry loops are synchronous (no event
 * loop to `await`), so they previously blocked by SPINNING a full CPU core in a
 * `while (Date.now() < until) {}` busy-wait. `sleepSync` replaces every spin with
 * a single shared `Atomics.wait` primitive that parks the thread (zero CPU) for
 * the requested duration.
 *
 * FAIL-before/PASS-after: before `sleepSync` exists this file does not compile /
 * the import is undefined; after it is added the timing assertions pass.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { sleepSync } from "../src/core/sleep";

describe("PERF-007 — sleepSync blocks for ~ms with zero CPU", () => {
  it("returns after approximately the requested duration", () => {
    const ms = 50;
    const start = Date.now();
    sleepSync(ms);
    const elapsed = Date.now() - start;
    // Allow a small scheduler tolerance below; never finishes meaningfully early.
    expect(elapsed).toBeGreaterThanOrEqual(ms - 5);
    // And it does not over-wait wildly (parked, not hung).
    expect(elapsed).toBeLessThan(ms + 500);
  });

  it("returns immediately for non-positive / non-finite durations (no hang)", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY * 0]) {
      const start = Date.now();
      sleepSync(bad);
      expect(Date.now() - start).toBeLessThan(20);
    }
  });

  it("accumulates across calls (two 25ms sleeps ~= 50ms) — durations are honored, not collapsed", () => {
    const start = Date.now();
    sleepSync(25);
    sleepSync(25);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });
});

describe("finding #7 — sleepSync never throws + uses a single shared lock word", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT throw when Atomics.wait throws — falls back to a bounded spin that still blocks ~ms", () => {
    // Simulate a hardened runtime that forbids Atomics.wait at call time.
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      throw new Error("forbidden");
    });
    const start = Date.now();
    expect(() => sleepSync(30)).not.toThrow();
    const elapsed = Date.now() - start;
    // Fallback engaged: the call still honored the requested duration.
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });

  it("does NOT throw / falls back when SharedArrayBuffer is absent at module load (null-word path)", async () => {
    vi.resetModules();
    const savedSAB = (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
    try {
      // Make the module-level allocation fail at import time → lock word is null.
      (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer = undefined;
      const fresh = await import("../src/core/sleep");
      const start = Date.now();
      expect(() => fresh.sleepSync(20)).not.toThrow();
      const elapsed = Date.now() - start;
      // Null-word path still blocks for ~ms via the bounded fallback.
      expect(elapsed).toBeGreaterThanOrEqual(15);
    } finally {
      (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer = savedSAB;
      vi.resetModules();
    }
  });

  it("allocates the lock word ONCE at import — the SharedArrayBuffer constructor is NOT invoked per call", () => {
    // The singleton was already built at module load; repeated calls must not
    // construct a new SharedArrayBuffer (no per-call GC churn).
    const ctorSpy = vi.spyOn(globalThis, "SharedArrayBuffer");
    sleepSync(1);
    sleepSync(1);
    sleepSync(1);
    expect(ctorSpy).not.toHaveBeenCalled();
  });
});
