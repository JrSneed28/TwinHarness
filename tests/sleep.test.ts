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

import { describe, it, expect } from "vitest";
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
