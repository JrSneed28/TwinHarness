"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TOLERANCE_PCT = void 0;
exports.baselinesDir = baselinesDir;
exports.baselinePath = baselinePath;
exports.baselineFromMetric = baselineFromMetric;
exports.loadBaselines = loadBaselines;
exports.saveBaselines = saveBaselines;
exports.diffAgainstBaselines = diffAgainstBaselines;
exports.flagRegressions = flagRegressions;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("../paths");
/**
 * Provisional default mechanical regression tolerance (PS-Q2): a current metric is
 * flagged regressed when its gating p50 is more than this percent slower than
 * baseline. Set to a real per-metric value after collecting baselines.
 */
exports.DEFAULT_TOLERANCE_PCT = 20;
/** `<root>/.twinharness/proof/baselines` — the baseline store (root-contained). */
function baselinesDir(root) {
    const dir = (0, paths_1.resolveWithinRoot)(root, path.join(".twinharness", "proof", "baselines"));
    if (dir === null) {
        // A constant in-root relative path cannot escape; this guards a hostile `root`.
        throw new Error(`baselines dir escapes project root: ${root}`);
    }
    return dir;
}
/** `<baselinesDir>/<scenario>.json` for one scenario's baselines. */
function baselinePath(root, scenario) {
    // Reject a scenario name that would traverse out of the baselines dir.
    const file = (0, paths_1.resolveWithinRoot)(baselinesDir(root), `${scenario}.json`);
    if (file === null) {
        throw new Error(`baseline scenario name escapes the baselines dir: ${scenario}`);
    }
    return file;
}
/** Derive a {@link Baseline} record from a measured metric (p50/p95 snapshot). */
function baselineFromMetric(metric, scenario) {
    return {
        metric: metric.name,
        p50: metric.p50,
        p95: metric.p95,
        timestamp: new Date().toISOString(),
        ...(scenario ? { scenario } : {}),
    };
}
/** Shape-guard one parsed baseline record; malformed entries are skipped. */
function isBaseline(v) {
    if (typeof v !== "object" || v === null)
        return false;
    const b = v;
    return (typeof b.metric === "string" &&
        typeof b.p50 === "number" &&
        typeof b.p95 === "number" &&
        typeof b.timestamp === "string");
}
/**
 * Load stored baselines from the baselines dir. With `scenario` → just that file;
 * without → the union across every `*.json` in the dir. Tolerant: a missing dir /
 * file → `[]`, and a malformed file or entry is skipped (never throws).
 */
function loadBaselines(root, scenario) {
    const out = [];
    const readFile = (file) => {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        }
        catch {
            return;
        }
        if (Array.isArray(parsed)) {
            for (const e of parsed)
                if (isBaseline(e))
                    out.push(e);
        }
    };
    if (scenario) {
        const file = baselinePath(root, scenario);
        if (fs.existsSync(file))
            readFile(file);
        return out;
    }
    const dir = baselinesDir(root);
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        return out;
    }
    for (const name of entries) {
        if (!name.endsWith(".json"))
            continue;
        readFile(path.join(dir, name));
    }
    return out;
}
/** Persist `baselines` for `scenario` (overwrites that scenario's file). */
function saveBaselines(root, scenario, baselines) {
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
function diffAgainstBaselines(metrics, baselines) {
    const byName = new Map(baselines.map((b) => [b.metric, b]));
    const deltas = [];
    for (const m of metrics) {
        const base = byName.get(m.name);
        if (!base)
            continue;
        const baseline = base.p50;
        const current = m.p50;
        // Guard divide-by-zero: a zero baseline with any positive current is treated
        // as a full (100%) increase; equal-to-zero is a 0% delta.
        const deltaPct = baseline === 0 ? (current === 0 ? 0 : 100) : ((current - baseline) / baseline) * 100;
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
function flagRegressions(deltas, tolerancePct = exports.DEFAULT_TOLERANCE_PCT) {
    return deltas.map((d) => ({
        ...d,
        regressed: d.gating && d.deltaPct > tolerancePct,
    }));
}
