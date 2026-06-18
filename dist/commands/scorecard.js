"use strict";
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
exports.runScorecardHotspots = runScorecardHotspots;
exports.runScorecard = runScorecard;
const fs = __importStar(require("node:fs"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const health_1 = require("../core/health");
const coverage_1 = require("../core/coverage");
const verify_1 = require("../core/verify");
const drift_log_1 = require("../core/drift-log");
const ledger_1 = require("../core/ledger");
const telemetry_1 = require("../core/telemetry");
/**
 * Summarize the recorded `th route` telemetry: count the "route" events and tally
 * them by chosen model. Read-only — it consults the same local telemetry log the
 * scorecard appends to, never the network. A missing/disabled log reads as zero
 * events (and renders as "—").
 */
function summarizeRouting(paths) {
    const models = {};
    let events = 0;
    for (const rec of (0, telemetry_1.readTelemetryLog)(paths)) {
        if (rec.event !== "route")
            continue;
        events++;
        if (typeof rec.model === "string" && rec.model.length > 0) {
            models[rec.model] = (models[rec.model] ?? 0) + 1;
        }
    }
    return { events, models };
}
/** First finite numeric field among `keys` on `rec`, else 0. */
function pickNumber(rec, keys) {
    for (const k of keys) {
        const v = rec[k];
        if (typeof v === "number" && Number.isFinite(v))
            return v;
    }
    return 0;
}
/**
 * Aggregate the LOCAL telemetry log into a per-stage cost table: token
 * (estimate/proxy) + wall-clock totals, grouped by the `stage` field every
 * snapshot already carries. Read-only — it consults the same `telemetry.jsonl`
 * the scorecard appends to, never the network. Records without a string `stage`
 * are ignored (route events, etc.); a missing/disabled/empty log yields an empty
 * table (handled by the caller as a graceful, exit-0 "no data" message).
 */
function summarizeHotspots(paths) {
    const byStage = new Map();
    let recordsScanned = 0;
    for (const raw of (0, telemetry_1.readTelemetryLog)(paths)) {
        recordsScanned++;
        const rec = raw;
        const stage = rec.stage;
        if (typeof stage !== "string" || stage.length === 0)
            continue;
        const tokens = pickNumber(rec, ["tokens", "estTokens", "tokensProxy"]);
        const wallMs = pickNumber(rec, ["wallMs", "durationMs"]);
        const cur = byStage.get(stage) ?? { stage, events: 0, tokens: 0, wallMs: 0 };
        cur.events++;
        cur.tokens += tokens;
        cur.wallMs += wallMs;
        byStage.set(stage, cur);
    }
    const stages = [...byStage.values()].sort((a, b) => b.tokens - a.tokens || a.stage.localeCompare(b.stage));
    return { stages, recordsScanned };
}
/**
 * `th scorecard --hotspots` — a per-stage cost table (token estimate/proxy +
 * wall-clock) computed from the LOCAL telemetry log. Read-only and crash-proof:
 * when telemetry is off/empty (no stage-bearing records) it returns an empty,
 * zeroed table with a clear message and exit 0 — it never throws. Like the rest
 * of the scorecard it emits both a `--json` payload and a human table.
 */
function runScorecardHotspots(paths) {
    const { stages, recordsScanned } = summarizeHotspots(paths);
    const totalEvents = stages.reduce((n, s) => n + s.events, 0);
    const totalTokens = stages.reduce((n, s) => n + s.tokens, 0);
    const totalWallMs = stages.reduce((n, s) => n + s.wallMs, 0);
    const data = {
        hotspots: stages,
        totalEvents,
        totalTokens,
        totalWallMs,
        recordsScanned,
    };
    let human;
    if (stages.length === 0) {
        human = [
            "Per-stage hotspots: no stage telemetry recorded yet.",
            recordsScanned === 0
                ? "Telemetry log is empty — enable it with `th telemetry on`; hotspots populate as stages emit token/wall-clock snapshots."
                : `Scanned ${recordsScanned} telemetry record(s), none carried a stage. Hotspots populate as stages emit token/wall-clock snapshots.`,
        ].join("\n");
    }
    else {
        const header = `${"STAGE".padEnd(20)} ${"EVENTS".padStart(7)} ${"~TOKENS".padStart(9)} ${"WALL(ms)".padStart(9)}`;
        const rows = stages.map((s) => `${s.stage.padEnd(20)} ${String(s.events).padStart(7)} ${String(s.tokens).padStart(9)} ${String(s.wallMs).padStart(9)}`);
        const total = `${"TOTAL".padEnd(20)} ${String(totalEvents).padStart(7)} ${String(totalTokens).padStart(9)} ${String(totalWallMs).padStart(9)}`;
        human = [
            `Per-stage hotspots (from ${recordsScanned} telemetry record(s), ${stages.length} stage(s)):`,
            header,
            ...rows,
            total,
        ].join("\n");
    }
    return (0, output_1.success)({ data, human });
}
function runScorecard(paths, opts) {
    if (opts.hotspots)
        return runScorecardHotspots(paths);
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists) {
        return (0, output_1.failure)({ human: "No TwinHarness run here. Run `th init` first.", data: { error: "not_initialized" } });
    }
    if (!r.state) {
        return (0, output_1.failure)({ human: "state.json is invalid (`th state verify` for details).", data: { error: "invalid_state", issues: r.issues } });
    }
    const s = r.state;
    // --- Coverage (planned / implemented / tested) ---
    const breakdown = (0, coverage_1.computeBreakdown)(paths.root);
    const coverage = "error" in breakdown
        ? null
        : { total: breakdown.total, planned: breakdown.planned, implemented: breakdown.implemented, tested: breakdown.tested };
    // --- Slice progress ---
    const prog = (0, health_1.sliceProgress)(s);
    // --- Suite status (from the optional verify report; "—" when never run) ---
    const report = (0, verify_1.readVerifyReport)(paths);
    const suite = report ? (report.ok ? "green" : "failing") : "—";
    const suiteFailures = report ? report.results.filter((x) => !x.ok).length : 0;
    // --- Drift summary (log entries + open blocking from durable state) ---
    let driftEntries = 0;
    try {
        if (fs.existsSync(paths.driftLog)) {
            driftEntries = (0, drift_log_1.parseDriftEntries)(fs.readFileSync(paths.driftLog, "utf8")).length;
        }
    }
    catch {
        // Unreadable drift log → treat as zero entries (never crash the scorecard).
    }
    const drift = { entries: driftEntries, openBlocking: s.drift_open_blocking };
    // --- Revise escalations (loops at cap → a human owes a decision) ---
    const escalations = (0, health_1.reviseEscalations)(s);
    // --- Artifact integrity (changed/missing governed docs) ---
    const integrity = (0, health_1.artifactIntegrity)(paths, s);
    const artifactsChanged = integrity.filter((i) => i.status === "changed").length;
    const artifactsMissing = integrity.filter((i) => i.status === "missing").length;
    const ledgerEntries = (0, ledger_1.readLedger)(paths).length;
    // --- Routing (read-only summary of recorded `th route` telemetry) ---
    const routing = summarizeRouting(paths);
    const data = {
        tier: s.tier,
        stage: s.current_stage,
        implementationAllowed: s.implementation_allowed,
        coverage,
        slices: { total: prog.total, done: prog.done, blocked: prog.blocked, inProgress: prog.inProgress, pending: prog.pending },
        suite,
        suiteFailures,
        drift,
        reviseEscalations: escalations,
        artifacts: { registered: integrity.length, changed: artifactsChanged, missing: artifactsMissing },
        ledgerEntries,
        routing,
    };
    // --- Opt-in local telemetry snapshot (no-op when telemetry is disabled) ---
    if ((0, telemetry_1.readTelemetryConfig)(paths).enabled) {
        (0, telemetry_1.appendTelemetry)(paths, {
            ts: new Date().toISOString(),
            event: "scorecard",
            tier: s.tier,
            stage: s.current_stage,
            coverage,
            slices: data.slices,
            suite,
            drift,
            reviseEscalations: escalations.length,
            artifactsChanged,
            artifactsMissing,
        });
    }
    const human = renderScorecard(data);
    return (0, output_1.success)({ data, human });
}
function renderScorecard(d) {
    const cov = d.coverage
        ? `${d.coverage.planned}/${d.coverage.implemented}/${d.coverage.tested} of ${d.coverage.total} (planned/implemented/tested)`
        : "requirements not authored yet";
    const suite = d.suite === "—"
        ? "— (run `th verify run`)"
        : d.suite === "green"
            ? "green"
            : `FAILING (${d.suiteFailures} command${d.suiteFailures === 1 ? "" : "s"})`;
    const slices = d.slices.total === 0
        ? "no slices synced"
        : `${d.slices.done} done / ${d.slices.total} total / ${d.slices.blocked} blocked` +
            (d.slices.inProgress + d.slices.pending > 0 ? ` (${d.slices.inProgress} in-progress, ${d.slices.pending} pending)` : "");
    const drift = d.drift.entries === 0 && d.drift.openBlocking === 0
        ? "none"
        : `${d.drift.entries} entr${d.drift.entries === 1 ? "y" : "ies"}, ${d.drift.openBlocking} open blocking`;
    const revise = d.reviseEscalations.length === 0
        ? "none at cap"
        : `at cap: ${d.reviseEscalations.map((e) => `${e.mode} (${e.count}/${e.cap})`).join(", ")}`;
    const artifacts = d.artifacts.changed + d.artifacts.missing === 0
        ? `${d.artifacts.registered} registered, all match`
        : `${d.artifacts.registered} registered, ${d.artifacts.changed} changed, ${d.artifacts.missing} missing`;
    const routing = d.routing.events === 0
        ? "—"
        : `${d.routing.events} route call${d.routing.events === 1 ? "" : "s"}` +
            (Object.keys(d.routing.models).length > 0
                ? ` (${Object.entries(d.routing.models)
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                    .map(([model, n]) => `${model}×${n}`)
                    .join(", ")})`
                : "");
    return [
        `Tier / stage : ${d.tier ?? "unclassified"} / ${d.stage}${d.implementationAllowed ? " (implementation allowed)" : ""}`,
        `Coverage     : ${cov}`,
        `Slices       : ${slices}`,
        `Suite        : ${suite}`,
        `Drift        : ${drift}`,
        `Revise loops : ${revise}`,
        `Artifacts    : ${artifacts}`,
        `Routing      : ${routing}`,
    ].join("\n");
}
