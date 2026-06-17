/**
 * Component 4 (Performance) — split-gated baseline regression (plan §11; AC #7/#10,
 * M4). Proves the SPLIT: a degraded DETERMINISTIC mechanical metric (gating:true)
 * is flagged `regressed` and can fail the run, while a degraded LIVE metric
 * (gating:false) is reported but never flagged. Also covers baseline load/diff/flag
 * + persistence round-trip.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import {
  loadBaselines,
  saveBaselines,
  diffAgainstBaselines,
  flagRegressions,
  baselineFromMetric,
  DEFAULT_TOLERANCE_PCT,
} from "../src/core/proof/regression";
import type { Baseline, PerfMetric } from "../src/core/proof/types";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

const mechanical = (p50: number): PerfMetric => ({
  name: "scanner-walk",
  series: [p50],
  p50,
  p95: p50,
  gating: true,
});
const live = (p50: number): PerfMetric => ({
  name: "live-wall",
  series: [p50],
  p50,
  p95: p50,
  gating: false,
});

const baselines: Baseline[] = [
  { metric: "scanner-walk", p50: 100, p95: 150, timestamp: "2026-01-01T00:00:00.000Z" },
  { metric: "live-wall", p50: 100, p95: 150, timestamp: "2026-01-01T00:00:00.000Z" },
];

describe("proof/regression — M4 split gating", () => {
  it("a degraded MECHANICAL metric (gating:true) is flagged regressed and can fail the run", () => {
    const deltas = diffAgainstBaselines([mechanical(130)], baselines); // +30% vs 100
    const flagged = flagRegressions(deltas); // default tolerance 20%
    const d = flagged.find((x) => x.metric === "scanner-walk")!;
    expect(d.gating).toBe(true);
    expect(Math.round(d.deltaPct)).toBe(30);
    expect(d.regressed).toBe(true);
  });

  it("a degraded LIVE metric (gating:false) is reported but NEVER flagged regressed", () => {
    const deltas = diffAgainstBaselines([live(300)], baselines); // +200% vs 100
    const flagged = flagRegressions(deltas);
    const d = flagged.find((x) => x.metric === "live-wall")!;
    expect(d.gating).toBe(false);
    expect(Math.round(d.deltaPct)).toBe(200);
    expect(d.regressed).toBe(false); // non-gating: reported, never fails
  });

  it("a mechanical delta WITHIN tolerance is not flagged", () => {
    const deltas = diffAgainstBaselines([mechanical(110)], baselines); // +10% < 20%
    const flagged = flagRegressions(deltas, DEFAULT_TOLERANCE_PCT);
    expect(flagged.find((x) => x.metric === "scanner-walk")!.regressed).toBe(false);
  });

  it("a metric with no matching baseline yields no delta", () => {
    const deltas = diffAgainstBaselines([{ ...mechanical(999), name: "no-baseline" }], baselines);
    expect(deltas.find((x) => x.metric === "no-baseline")).toBeUndefined();
  });

  it("baselines persist + reload round-trip (scoped + union)", () => {
    tp = makeTempProject();
    const recorded = [baselineFromMetric(mechanical(120), "tiny"), baselineFromMetric(live(120), "tiny")];
    saveBaselines(tp.root, "tiny", recorded);

    const scoped = loadBaselines(tp.root, "tiny");
    expect(scoped.map((b) => b.metric).sort()).toEqual(["live-wall", "scanner-walk"]);

    const all = loadBaselines(tp.root);
    expect(all.length).toBe(2);
  });

  it("loadBaselines is tolerant of a missing baselines dir", () => {
    tp = makeTempProject();
    expect(loadBaselines(tp.root)).toEqual([]);
    expect(loadBaselines(tp.root, "absent")).toEqual([]);
  });
});
