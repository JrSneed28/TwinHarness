/**
 * Component 4 (Performance) — split-gated baseline regression engine (plan Step 4,
 * M4). Baselines persist as per-scenario JSON under
 * `<root>/.twinharness/proof/baselines/<scenario>.json` (resolved via
 * {@link resolveWithinRoot} — never a literal path), one {@link Baseline} per
 * recorded metric.
 *
 * M4 SPLIT GATING: {@link diffAgainstBaselines} computes the percentage delta of a
 * current metric against its stored baseline and carries the metric's `gating`
 * flag; {@link flagRegressions} marks `regressed` ONLY when the delta exceeds
 * tolerance AND the metric is gating — so deterministic mechanical metrics can fail
 * the run while non-gating live wall-clock/token trends are merely reported.
 *
 * Pure + zero-SUT: file IO only touches the baselines directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveWithinRoot } from "../paths";
import type { Baseline, PerfMetric, RegressionDelta } from "./types";

/**
 * Provisional default mechanical regression tolerance (PS-Q2): a current metric is
 * flagged regressed when its gating p50 is more than this percent slower than
 * baseline. Set to a real per-metric value after collecting baselines.
 */
export const DEFAULT_TOLERANCE_PCT = 20;

/** `<root>/.twinharness/proof/baselines` — the baseline store (root-contained). */
export function baselinesDir(root: string): string {
  const dir = resolveWithinRoot(root, path.join(".twinharness", "proof", "baselines"));
  if (dir === null) {
    // A constant in-root relative path cannot escape; this guards a hostile `root`.
    throw new Error(`baselines dir escapes project root: ${root}`);
  }
  return dir;
}

/** `<baselinesDir>/<scenario>.json` for one scenario's baselines. */
export function baselinePath(root: string, scenario: string): string {
  // Reject a scenario name that would traverse out of the baselines dir.
  const file = resolveWithinRoot(baselinesDir(root), `${scenario}.json`);
  if (file === null) {
    throw new Error(`baseline scenario name escapes the baselines dir: ${scenario}`);
  }
  return file;
}

/** Derive a {@link Baseline} record from a measured metric (p50/p95 snapshot). */
export function baselineFromMetric(metric: PerfMetric, scenario?: string): Baseline {
  return {
    metric: metric.name,
    p50: metric.p50,
    p95: metric.p95,
    timestamp: new Date().toISOString(),
    ...(scenario ? { scenario } : {}),
  };
}

/** Shape-guard one parsed baseline record; malformed entries are skipped. */
function isBaseline(v: unknown): v is Baseline {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.metric === "string" &&
    typeof b.p50 === "number" &&
    typeof b.p95 === "number" &&
    typeof b.timestamp === "string"
  );
}

/**
 * Load stored baselines from the baselines dir. With `scenario` → just that file;
 * without → the union across every `*.json` in the dir. Tolerant: a missing dir /
 * file → `[]`, and a malformed file or entry is skipped (never throws).
 */
export function loadBaselines(root: string, scenario?: string): Baseline[] {
  const out: Baseline[] = [];
  const readFile = (file: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return;
    }
    if (Array.isArray(parsed)) {
      for (const e of parsed) if (isBaseline(e)) out.push(e);
    }
  };

  if (scenario) {
    const file = baselinePath(root, scenario);
    if (fs.existsSync(file)) readFile(file);
    return out;
  }

  const dir = baselinesDir(root);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    readFile(path.join(dir, name));
  }
  return out;
}

/** Persist `baselines` for `scenario` (overwrites that scenario's file). */
export function saveBaselines(root: string, scenario: string, baselines: Baseline[]): void {
  const file = baselinePath(root, scenario);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(baselines, null, 2) + "\n", "utf8");
}

/**
 * Diff current metrics against their baselines by metric name, on p50. `deltaPct`
 * is positive when the current value is SLOWER/worse than baseline. Each metric's
 * `gating` flag is carried through (M4); `regressed` starts false and is decided by
 * {@link flagRegressions}. Metrics with no matching baseline are skipped (no delta).
 */
export function diffAgainstBaselines(metrics: PerfMetric[], baselines: Baseline[]): RegressionDelta[] {
  const byName = new Map(baselines.map((b) => [b.metric, b]));
  const deltas: RegressionDelta[] = [];
  for (const m of metrics) {
    const base = byName.get(m.name);
    if (!base) continue;
    const baseline = base.p50;
    const current = m.p50;
    // Guard divide-by-zero: a zero baseline with any positive current is treated
    // as a full (100%) increase; equal-to-zero is a 0% delta.
    const deltaPct =
      baseline === 0 ? (current === 0 ? 0 : 100) : ((current - baseline) / baseline) * 100;
    deltas.push({ metric: m.name, baseline, current, deltaPct, gating: m.gating, regressed: false });
  }
  return deltas;
}

/**
 * Flag regressions (M4 split): set `regressed:true` ONLY when the delta exceeds
 * `tolerancePct` AND the metric is gating. Non-gating (live) deltas are returned
 * with `regressed:false` regardless of magnitude — reported, never failing. Returns
 * a NEW array; inputs are not mutated.
 */
export function flagRegressions(deltas: RegressionDelta[], tolerancePct: number = DEFAULT_TOLERANCE_PCT): RegressionDelta[] {
  return deltas.map((d) => ({
    ...d,
    regressed: d.gating && d.deltaPct > tolerancePct,
  }));
}
