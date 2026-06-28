/**
 * Phase B6 — savings render surface. Maps to spec AC-14, AC-15, AC-16, AC-17.
 * Plain-text-first: meaning never depends on color; truncation is deterministic.
 */

import { describe, it, expect, afterEach } from "vitest";
import { renderStatusLine, renderDetail } from "../src/core/savings-render";
import type { SavingsResult } from "../src/core/savings";
import { TELEMETRY_WORKLOAD_CATEGORIES } from "../src/core/savings-classify";

/** A populated result with all 8 categories zero-filled. */
function result(p: Partial<SavingsResult>): SavingsResult {
  return {
    baseline_tokens: 1000,
    actual_tokens: 360,
    avoided_tokens: 640,
    saved_pct: 64,
    payback_tokens: 0,
    payback_measured: true,
    cache_read_tokens: 0,
    categories: TELEMETRY_WORKLOAD_CATEGORIES.map((category) => ({
      category,
      avoided_tokens: 0,
      label: "measured" as const,
    })),
    uncategorized_tokens: 0,
    avoided_input_tokens: 640,
    record_count: 5,
    suppress_mode: true,
    headline_label: "measured",
    ...p,
  };
}

/** Strip ANSI escapes to inspect the plain-text payload. */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const ESC = /\x1b\[/;

describe("renderStatusLine", () => {
  afterEach(() => {
    delete process.env.NO_COLOR;
  });

  it("AC-14: idle marker when no records", () => {
    const r = result({ record_count: 0 });
    expect(renderStatusLine(r, 80, false)).toBe("TH · savings idle");
    expect(renderStatusLine(r, 80, true)).toBe("TH · savings idle");
  });

  it("AC-15: compact line shows saved%, avoided, and mode on one line", () => {
    const line = renderStatusLine(result({}), 80, false);
    expect(line).not.toContain("\n");
    expect(line).toContain("TH 64%");
    expect(line).toContain("avoided");
    expect(line).toContain("suppress");
  });

  it("AC-16: color=false emits zero ANSI codes", () => {
    const line = renderStatusLine(result({}), 80, false);
    expect(ESC.test(line)).toBe(false);
  });

  it("AC-16: NO_COLOR set strips ANSI even when color=true", () => {
    process.env.NO_COLOR = "1";
    const line = renderStatusLine(result({}), 80, true);
    expect(ESC.test(line)).toBe(false);
  });

  it("AC-16: color=true is enhancement only — stripped text equals plain text", () => {
    const plain = renderStatusLine(result({}), 80, false);
    const colored = renderStatusLine(result({}), 80, true);
    expect(ESC.test(colored)).toBe(true);
    expect(strip(colored)).toBe(plain);
  });

  it("AC-17: truncation drops trailing fields first but always keeps Saved%", () => {
    const r = result({ payback_measured: false });
    const wide = renderStatusLine(r, 80, false);
    // Wide carries every field including the honesty marker and mode.
    expect(wide).toContain("upper bound");
    expect(wide).toContain("suppress");

    // Medium width drops the lowest-priority trailing field (mode) first.
    const medium = renderStatusLine(r, 28, false);
    expect(medium).toContain("TH 64%");
    expect(medium.length).toBeLessThanOrEqual(28);
    expect(medium).not.toContain("suppress");

    // Tiny width keeps only the headline.
    const tiny = renderStatusLine(r, 7, false);
    expect(tiny).toContain("TH 64%");
    expect(tiny).not.toContain("avoided");
  });

  it("AC-17: honesty marker survives longer than mode under truncation", () => {
    const r = result({ payback_measured: false });
    // Width fits headline + avoided + 'upper bound' (34) but not the trailing mode (45).
    const line = renderStatusLine(r, 36, false);
    expect(line).toContain("upper bound");
    expect(line).not.toContain("suppress");
  });
});

describe("renderDetail", () => {
  it("AC-18: renders per-category breakdown + cache line (cost emitted by handler)", () => {
    const detail = renderDetail(result({ uncategorized_tokens: 12 }), "$0.42 [estimated · snapshot 2026-06-28]");
    expect(detail).toContain("\n");
    for (const cat of TELEMETRY_WORKLOAD_CATEGORIES) {
      expect(detail).toContain(cat);
    }
    expect(detail).toContain("uncategorized");
    expect(detail).toContain("[incomplete]");
    expect(detail).toContain("cache-read");
    // The `cost:` line is the handler's responsibility (single source of truth, with USD).
    expect(detail).not.toContain("cost:");
  });

  it("defaults payback to [unavailable] when unmeasured and does not emit a cost line", () => {
    const detail = renderDetail(result({ payback_measured: false }));
    expect(detail).not.toContain("cost:");
    expect(detail).toContain("payback:    [unavailable]");
  });
});
