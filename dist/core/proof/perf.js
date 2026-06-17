"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.percentile = percentile;
exports.measure = measure;
exports.measureScannerWalk = measureScannerWalk;
exports.measureLockLatency = measureLockLatency;
exports.measureScheduleWaves = measureScheduleWaves;
exports.measureToolRoundTrip = measureToolRoundTrip;
exports.liveMetric = liveMetric;
const node_perf_hooks_1 = require("node:perf_hooks");
const state_store_1 = require("../state-store");
const scanner_1 = require("../repo-map/scanner");
const schedule_1 = require("../schedule");
/**
 * Nearest-rank-with-interpolation percentile of a numeric series (p in [0,100]).
 * Empty series → 0. A COPY is sorted so the caller's series order is preserved.
 */
function percentile(series, p) {
    if (series.length === 0)
        return 0;
    const sorted = [...series].sort((a, b) => a - b);
    if (sorted.length === 1)
        return sorted[0];
    const rank = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi)
        return sorted[lo];
    const frac = rank - lo;
    return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
/**
 * Time `fn` over `iterations` runs (after `warmup` untimed runs) and reduce to a
 * {@link PerfMetric}. `gating` defaults to true (mechanical); the bundled helpers
 * force it explicitly, and {@link liveMetric} sets it false.
 */
function measure(name, fn, opts = {}) {
    const iterations = Math.max(1, Math.floor(opts.iterations ?? 30));
    const warmup = Math.max(0, Math.floor(opts.warmup ?? 3));
    const gating = opts.gating ?? true;
    for (let i = 0; i < warmup; i++)
        fn();
    const series = [];
    for (let i = 0; i < iterations; i++) {
        const t0 = node_perf_hooks_1.performance.now();
        fn();
        series.push(node_perf_hooks_1.performance.now() - t0);
    }
    return { name, series, p50: percentile(series, 50), p95: percentile(series, 95), gating };
}
/** Mechanical metric: a full `scanRepo` walk of `root` (gating:true). */
function measureScannerWalk(root, opts = {}) {
    return measure("scanner-walk", () => (0, scanner_1.scanRepo)(root), { iterations: 10, ...opts, gating: true });
}
/** Mechanical metric: `withStateLock` acquire+release latency on `paths` (gating:true). */
function measureLockLatency(paths, opts = {}) {
    return measure("lock-acquire", () => (0, state_store_1.withStateLock)(paths, () => undefined), { ...opts, gating: true });
}
/** Mechanical metric: `scheduleWaves` planning cost over `slices` (gating:true). */
function measureScheduleWaves(slices, opts = {}) {
    return measure("schedule-waves", () => (0, schedule_1.scheduleWaves)(slices), { ...opts, gating: true });
}
/**
 * Mechanical metric: an INJECTED in-process round-trip (e.g. a `TOOL_DEFS[i].run`
 * call wrapped by the caller). The callable is supplied by the caller (cli.ts /
 * tests have TOOL_DEFS in scope) so this module never imports the MCP registry.
 * Tagged gating:true.
 */
function measureToolRoundTrip(name, run, opts = {}) {
    return measure(name, run, { ...opts, gating: true });
}
/**
 * Wrap an externally-collected LIVE series (per-stage wall-clock, token counts)
 * as a non-gating trend metric (M4): its regression is REPORTED but never FAILS
 * the run. Use for anything non-deterministic / host-sensitive.
 */
function liveMetric(name, series) {
    return {
        name,
        series: [...series],
        p50: percentile(series, 50),
        p95: percentile(series, 95),
        gating: false,
    };
}
