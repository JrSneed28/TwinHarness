/**
 * Phase B1 — savings calc core. Pure, deterministic, order-independent.
 * Maps to spec AC-1..AC-8, AC-20, AC-28 (the calc-side subset).
 */

import { describe, it, expect } from "vitest";
import { computeSavings } from "../src/core/savings";
import { TELEMETRY_WORKLOAD_CATEGORIES } from "../src/core/savings-classify";
import type { TelemetryRecord } from "../src/core/context-telemetry";

/** Build a telemetry record with sane required defaults. */
function rec(p: Partial<TelemetryRecord>): TelemetryRecord {
  return {
    ts: "2026-06-28T00:00:00.000Z",
    session_id: "s1",
    epoch: 0,
    ...p,
  };
}

/** Deterministic shuffle (seeded) so the order-independence test is stable. */
function shuffle<T>(arr: T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe("computeSavings — headline math", () => {
  it("AC-1/AC-6: baseline=Σorig, actual=Σreturned, avoided is the upper bound", () => {
    const records = [
      rec({ page_id: "p1", workload_category: "file-read", orig_tokens: 100, returned_tokens: 40 }),
      rec({ page_id: "p2", workload_category: "file-read", orig_tokens: 200, returned_tokens: 50 }),
    ];
    const r = computeSavings(records, { suppressMode: true });
    expect(r.baseline_tokens).toBe(300);
    expect(r.actual_tokens).toBe(90);
    expect(r.avoided_tokens).toBe(210);
    expect(r.saved_pct).toBe(70);
    // No rehydration anywhere but credited>0 ⇒ payback is unmeasured (upper bound).
    expect(r.payback_measured).toBe(false);
    expect(r.headline_label).toBe("measured · pre-rehydration upper bound");
  });

  it("AC-2: a stored-but-delivered page (returned==orig) contributes 0 avoided", () => {
    const records = [
      rec({ page_id: "p1", workload_category: "file-read", orig_tokens: 100, returned_tokens: 100 }),
    ];
    const r = computeSavings(records, { suppressMode: true });
    expect(r.avoided_tokens).toBe(0);
    expect(r.saved_pct).toBe(0);
    // No credit anywhere ⇒ nothing owed ⇒ payback considered measured.
    expect(r.payback_measured).toBe(true);
  });

  it("AC-20: baseline==0 yields saved_pct 0 (no divide-by-zero / NaN)", () => {
    const r = computeSavings([], { suppressMode: true });
    expect(r.baseline_tokens).toBe(0);
    expect(r.saved_pct).toBe(0);
    expect(Number.isNaN(r.saved_pct)).toBe(false);
    expect(r.record_count).toBe(0);
    expect(r.payback_measured).toBe(true);
  });

  it("AC-4: avoided is order-independent across record order", () => {
    const records = [
      rec({ page_id: "p1", epoch: 0, workload_category: "file-read", orig_tokens: 100, returned_tokens: 30 }),
      rec({ page_id: "p1", epoch: 1, workload_category: "file-read", orig_tokens: 80, returned_tokens: 20 }),
      rec({ page_id: "p2", epoch: 0, workload_category: "repo-analysis", orig_tokens: 50, returned_tokens: 10 }),
      rec({ orig_tokens: 40, returned_tokens: 5, workload_category: "debug-output" }),
    ];
    const base = computeSavings(records, { suppressMode: true });
    for (const seed of [1, 7, 42, 1000]) {
      const r = computeSavings(shuffle(records, seed), { suppressMode: true });
      expect(r.avoided_tokens).toBe(base.avoided_tokens);
      expect(r.baseline_tokens).toBe(base.baseline_tokens);
      expect(r.payback_tokens).toBe(base.payback_tokens);
    }
  });

  it("AC-28: malformed/partial records never throw and coerce to 0", () => {
    const bad = [
      // @ts-expect-error intentionally malformed for the fail-safe path
      rec({ page_id: "p1", orig_tokens: "nope", returned_tokens: undefined }),
      // @ts-expect-error intentionally malformed
      rec({ page_id: "p2", orig_tokens: NaN, returned_tokens: 10 }),
      rec({ page_id: "p3", orig_tokens: 100, returned_tokens: 25 }),
    ];
    let r!: ReturnType<typeof computeSavings>;
    expect(() => {
      r = computeSavings(bad, { suppressMode: true });
    }).not.toThrow();
    // Only the well-formed record contributes; malformed ones coerce to 0.
    expect(r.avoided_tokens).toBe(75);
    expect(r.baseline_tokens).toBe(100);
  });
});

describe("computeSavings — rehydration netting", () => {
  it("AC-3: single-cycle rehydration caps payback at credit and nets to 0", () => {
    const records = [
      rec({ page_id: "p1", epoch: 0, workload_category: "file-read", orig_tokens: 100, returned_tokens: 20 }),
      // Payback larger than credit (80) → capped at 80 → net 0, never negative.
      rec({ page_id: "p1", epoch: 0, content_hash: "h1", rehydrated_full_tokens: 500, workload_category: "rehydration" }),
    ];
    const r = computeSavings(records, { suppressMode: true });
    expect(r.payback_tokens).toBe(80);
    expect(r.avoided_tokens).toBe(0);
    expect(r.avoided_tokens).toBeGreaterThanOrEqual(0);
    expect(r.payback_measured).toBe(true);
  });

  it("AC-3/I1: nets per (page_id, epoch) across two epochs of one page", () => {
    const records = [
      // epoch 0: credit 70, payback 30 → net 40
      rec({ page_id: "p1", epoch: 0, workload_category: "file-read", orig_tokens: 100, returned_tokens: 30 }),
      rec({ page_id: "p1", epoch: 0, content_hash: "a", rehydrated_full_tokens: 30, workload_category: "rehydration" }),
      // epoch 1: credit 50, payback 20 → net 30
      rec({ page_id: "p1", epoch: 1, workload_category: "file-read", orig_tokens: 60, returned_tokens: 10 }),
      rec({ page_id: "p1", epoch: 1, content_hash: "b", rehydrated_full_tokens: 20, workload_category: "rehydration" }),
    ];
    const r = computeSavings(records, { suppressMode: true });
    expect(r.payback_tokens).toBe(50);
    expect(r.avoided_tokens).toBe(70); // 40 + 30
    expect(r.payback_measured).toBe(true);
  });

  it("I2: duplicate rehydration records sharing content_hash subtract once (idempotent)", () => {
    const records = [
      rec({ page_id: "p1", epoch: 0, workload_category: "file-read", orig_tokens: 100, returned_tokens: 20 }),
      rec({ page_id: "p1", epoch: 0, content_hash: "dup", rehydrated_full_tokens: 30, workload_category: "rehydration" }),
      rec({ page_id: "p1", epoch: 0, content_hash: "dup", rehydrated_full_tokens: 30, workload_category: "rehydration" }),
      rec({ page_id: "p1", epoch: 0, content_hash: "dup", rehydrated_full_tokens: 30, workload_category: "rehydration" }),
    ];
    const r = computeSavings(records, { suppressMode: true });
    expect(r.payback_tokens).toBe(30); // counted once, not 90
    expect(r.avoided_tokens).toBe(50); // 80 credit − 30 payback
  });

  it("idempotent payback is order-independent under shuffle", () => {
    const records = [
      rec({ page_id: "p1", epoch: 0, workload_category: "file-read", orig_tokens: 100, returned_tokens: 20 }),
      rec({ page_id: "p1", epoch: 0, content_hash: "dup", rehydrated_full_tokens: 30, workload_category: "rehydration" }),
      rec({ page_id: "p1", epoch: 0, content_hash: "dup", rehydrated_full_tokens: 30, workload_category: "rehydration" }),
    ];
    const base = computeSavings(records, { suppressMode: true });
    for (const seed of [2, 9, 88]) {
      expect(computeSavings(shuffle(records, seed), { suppressMode: true }).payback_tokens).toBe(
        base.payback_tokens,
      );
    }
  });

  it("capsule payback (no page_id, the real R7 emitter) subtracts session-wide, idempotently", () => {
    // Page suppressions: credit 80 + 50 = 130 across two different pages.
    const suppressions = [
      rec({ page_id: "p1", epoch: 0, workload_category: "file-read", orig_tokens: 100, returned_tokens: 20 }),
      rec({ page_id: "p2", epoch: 0, workload_category: "file-read", orig_tokens: 60, returned_tokens: 10 }),
    ];
    // Capsule-level rehydration: epoch-scoped, content_hash-keyed, NO page_id.
    const capsule = rec({ epoch: 0, content_hash: "cap", rehydrated_full_tokens: 50, workload_category: "rehydration" });

    // (a) avoided drops by min(capsule, credited) = 50 → 130 − 50 = 80.
    const r = computeSavings([...suppressions, capsule], { suppressMode: true });
    expect(r.avoided_tokens).toBe(80);
    expect(r.payback_tokens).toBe(50);
    // (b) at least one rehydration record exists ⇒ payback is measured (not an upper bound).
    expect(r.payback_measured).toBe(true);
    expect(r.headline_label).toBe("measured");
    // Reconciliation still holds with capsule applied (AC-8).
    const catSum = r.categories.reduce((s, c) => s + c.avoided_tokens, 0);
    expect(catSum + r.uncategorized_tokens).toBe(r.avoided_tokens);

    // (c) a duplicate capsule record sharing content_hash does NOT double-subtract.
    const dup = rec({ epoch: 0, content_hash: "cap", rehydrated_full_tokens: 50, workload_category: "rehydration" });
    const r2 = computeSavings([...suppressions, capsule, dup], { suppressMode: true });
    expect(r2.payback_tokens).toBe(50);
    expect(r2.avoided_tokens).toBe(80);

    // Cap + floor: a capsule larger than total credit nets to 0, never negative.
    const huge = rec({ epoch: 0, content_hash: "big", rehydrated_full_tokens: 9999, workload_category: "rehydration" });
    const r3 = computeSavings([...suppressions, huge], { suppressMode: true });
    expect(r3.payback_tokens).toBe(130);
    expect(r3.avoided_tokens).toBe(0);
    expect(r3.avoided_tokens).toBeGreaterThanOrEqual(0);
  });
});

describe("computeSavings — categories", () => {
  it("emits all 8 categories in canonical order", () => {
    const r = computeSavings([], { suppressMode: true });
    expect(r.categories.map((c) => c.category)).toEqual([...TELEMETRY_WORKLOAD_CATEGORIES]);
  });

  it("AC-8: category sum (+ uncategorized, rehydration subtracted) reconciles to avoided", () => {
    const records = [
      rec({ page_id: "p1", epoch: 0, workload_category: "file-read", orig_tokens: 100, returned_tokens: 30 }),
      rec({ page_id: "p2", epoch: 0, workload_category: "repo-analysis", orig_tokens: 80, returned_tokens: 20 }),
      rec({ page_id: "p3", epoch: 0, workload_category: "mcp-result", orig_tokens: 60, returned_tokens: 10 }),
      // A record whose category cannot resolve → uncategorized.
      rec({ page_id: "p4", epoch: 0, orig_tokens: 40, returned_tokens: 15 }),
      // Rehydration payback (subtracted line) within p1/epoch0.
      rec({ page_id: "p1", epoch: 0, content_hash: "h", rehydrated_full_tokens: 25, workload_category: "rehydration" }),
    ];
    const r = computeSavings(records, { suppressMode: true });
    const catSum = r.categories.reduce((s, c) => s + c.avoided_tokens, 0);
    expect(catSum + r.uncategorized_tokens).toBe(r.avoided_tokens);
    expect(r.uncategorized_tokens).toBe(25); // 40 − 15
    const rehy = r.categories.find((c) => c.category === "rehydration")!;
    expect(rehy.avoided_tokens).toBe(-25); // shown subtracted
  });
});

describe("computeSavings — scoping + labels", () => {
  it("AC-26: filters by session_id and does not bleed across sessions", () => {
    const records = [
      rec({ session_id: "A", page_id: "p1", orig_tokens: 100, returned_tokens: 20, workload_category: "file-read" }),
      rec({ session_id: "B", page_id: "p2", orig_tokens: 999, returned_tokens: 1, workload_category: "file-read" }),
    ];
    const r = computeSavings(records, { session_id: "A", suppressMode: true });
    expect(r.baseline_tokens).toBe(100);
    expect(r.avoided_tokens).toBe(80);
    expect(r.session_id).toBe("A");
    expect(r.record_count).toBe(1);
  });

  it("headline label is observe-only when suppress mode is off", () => {
    const records = [rec({ page_id: "p1", orig_tokens: 100, returned_tokens: 20, workload_category: "file-read" })];
    const r = computeSavings(records, { suppressMode: false });
    expect(r.suppress_mode).toBe(false);
    expect(r.headline_label).toBe("measured · observe-only (0%)");
  });

  it("cache_read_tokens is always 0 and avoided_input_tokens mirrors avoided", () => {
    const records = [rec({ page_id: "p1", orig_tokens: 100, returned_tokens: 20, workload_category: "file-read" })];
    const r = computeSavings(records, { suppressMode: true });
    expect(r.cache_read_tokens).toBe(0);
    expect(r.avoided_input_tokens).toBe(r.avoided_tokens);
  });
});
