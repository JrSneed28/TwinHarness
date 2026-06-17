/**
 * Component 4 (Performance) — deterministic mechanical micro-benchmarks (plan
 * Step 4). {@link measure} runs a function `iterations` times, collects the
 * per-iteration wall time, and reduces it to a numeric series + p50/p95 with a
 * `gating` flag (M4 split: mechanical metrics GATE the run; live wall-clock/token
 * are non-gating trend).
 *
 * The bundled helpers measure the DETERMINISTIC spine costs — `scanRepo` walk,
 * `withStateLock` acquire latency, and `scheduleWaves` planning — all tagged
 * `gating:true`. The in-process "MCP round-trip" metric is supplied via DEPENDENCY
 * INJECTION ({@link measureToolRoundTrip} takes a `run` callable) so this module
 * never imports `src/mcp-server.ts` (R7 — no bundle cycle). {@link liveMetric}
 * wraps an externally-collected live series as a non-gating trend.
 */

import { performance } from "node:perf_hooks";
import type { ProjectPaths } from "../paths";
import type { SliceState } from "../state-schema";
import { withStateLock } from "../state-store";
import { scanRepo } from "../repo-map/scanner";
import { scheduleWaves } from "../schedule";
import type { PerfMetric } from "./types";

export interface MeasureOptions {
  /** Number of timed iterations (default 30). */
  iterations?: number;
  /** Untimed warm-up iterations before measuring (default 3) to settle JIT/FS caches. */
  warmup?: number;
  /** Whether a regression on this metric can FAIL the run (M4). Mechanical = true. */
  gating?: boolean;
}

/**
 * Nearest-rank-with-interpolation percentile of a numeric series (p in [0,100]).
 * Empty series → 0. A COPY is sorted so the caller's series order is preserved.
 */
export function percentile(series: number[], p: number): number {
  if (series.length === 0) return 0;
  const sorted = [...series].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/**
 * Time `fn` over `iterations` runs (after `warmup` untimed runs) and reduce to a
 * {@link PerfMetric}. `gating` defaults to true (mechanical); the bundled helpers
 * force it explicitly, and {@link liveMetric} sets it false.
 */
export function measure(name: string, fn: () => unknown, opts: MeasureOptions = {}): PerfMetric {
  const iterations = Math.max(1, Math.floor(opts.iterations ?? 30));
  const warmup = Math.max(0, Math.floor(opts.warmup ?? 3));
  const gating = opts.gating ?? true;

  for (let i = 0; i < warmup; i++) fn();

  const series: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    series.push(performance.now() - t0);
  }

  return { name, series, p50: percentile(series, 50), p95: percentile(series, 95), gating };
}

/** Mechanical metric: a full `scanRepo` walk of `root` (gating:true). */
export function measureScannerWalk(root: string, opts: MeasureOptions = {}): PerfMetric {
  return measure("scanner-walk", () => scanRepo(root), { iterations: 10, ...opts, gating: true });
}

/** Mechanical metric: `withStateLock` acquire+release latency on `paths` (gating:true). */
export function measureLockLatency(paths: ProjectPaths, opts: MeasureOptions = {}): PerfMetric {
  return measure("lock-acquire", () => withStateLock(paths, () => undefined), { ...opts, gating: true });
}

/** Mechanical metric: `scheduleWaves` planning cost over `slices` (gating:true). */
export function measureScheduleWaves(slices: SliceState[], opts: MeasureOptions = {}): PerfMetric {
  return measure("schedule-waves", () => scheduleWaves(slices), { ...opts, gating: true });
}

/**
 * Mechanical metric: an INJECTED in-process round-trip (e.g. a `TOOL_DEFS[i].run`
 * call wrapped by the caller). The callable is supplied by the caller (cli.ts /
 * tests have TOOL_DEFS in scope) so this module never imports the MCP registry.
 * Tagged gating:true.
 */
export function measureToolRoundTrip(name: string, run: () => unknown, opts: MeasureOptions = {}): PerfMetric {
  return measure(name, run, { ...opts, gating: true });
}

/**
 * Wrap an externally-collected LIVE series (per-stage wall-clock, token counts)
 * as a non-gating trend metric (M4): its regression is REPORTED but never FAILS
 * the run. Use for anything non-deterministic / host-sensitive.
 */
export function liveMetric(name: string, series: number[]): PerfMetric {
  return {
    name,
    series: [...series],
    p50: percentile(series, 50),
    p95: percentile(series, 95),
    gating: false,
  };
}
