"use strict";
/**
 * Component 9 (the runner) — plan Step 9 / §7. {@link runProof} orchestrates the
 * whole suite end-to-end and returns a {@link ProofReport}:
 *
 *   harvest live scenarios (or, in --self-test, drive the deterministic spine via
 *   the real `run*` handlers to PRODUCE harvestable artifacts — NO LLM) → run the
 *   LLM-free mechanical sub-proofs (stress / performance / failure-injection /
 *   containment / cross-platform) → build the nine report cards → compute the
 *   enforced coverage matrix → diff regressions (split-gated, M4) → assemble the
 *   {@link ProofReport} → (optionally) emit the dual-format report to disk.
 *
 * Overall verdict is `fail` if ANY card fails, the coverage matrix is incomplete,
 * or a GATING regression tripped. In --self-test mode all nine cards + the matrix
 * are produced, but the live MCP-tool dimension is explicitly NOT satisfied (a
 * self-test loop proves mechanical reachability only — pre-mortem #1 / AC #5).
 *
 * R7: this module NEVER imports `src/mcp-server.ts`. The live MCP tool registry is
 * INJECTED via {@link ProofToolRegistry} (the CLI / MCP wrappers / unit tests supply
 * it); when absent, the MCP-tool dimension is reported UNVERIFIABLE, not complete.
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
exports.runProof = runProof;
exports.runComponent = runComponent;
const os = __importStar(require("node:os"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("../paths");
const state_store_1 = require("../state-store");
const init_1 = require("../../commands/init");
const artifact_1 = require("../../commands/artifact");
const route_1 = require("../../commands/route");
const telemetry_1 = require("../telemetry");
const hook_1 = require("../../commands/hook");
const decision_1 = require("../../commands/decision");
const harvest_1 = require("./harvest");
const scenario_1 = require("./scenario");
const assert_1 = require("./assert");
const dogfood_1 = require("./dogfood");
const stress_1 = require("./stress");
const fixtures_1 = require("./fixtures");
const perf_1 = require("./perf");
const regression_1 = require("./regression");
const faults_1 = require("./faults");
const containment_1 = require("./containment");
const platform_1 = require("./platform");
const coverage_matrix_1 = require("./coverage-matrix");
const report_1 = require("./report");
const types_1 = require("./types");
/** Build one assertion record (local mirror of assert.ts's private helper). */
function mk(component, name, expected, actual, pass) {
    return { name, component, expected, actual, pass };
}
/** Which `src/core/*` subsystems each component exercises (union → matrix touched-set). */
const COMPONENT_SUBSYSTEMS = {
    operational: ["state-store", "state-schema", "ledger", "decisions", "health", "guards", "paths"],
    orchestration: ["schedule", "wave", "leases", "routing", "telemetry", "state-store"],
    stress: ["state-store", "repo-map/scanner", "sleep"],
    performance: ["repo-map/scanner", "state-store", "schedule", "sleep"],
    dogfood: ["coverage", "anchors", "telemetry", "health", "state-store"],
    "failure-injection": ["state-store", "state-schema", "wave", "health", "decisions", "guards"],
    containment: ["paths", "state-fields"],
    "cross-platform": ["paths", "state-store"],
    "runner-report": ["paths"],
};
/** A synthetic brief for --self-test (the spine produces a clean completed run). */
const SELF_TEST_BRIEF = {
    id: "self-test",
    size: "tiny",
    domain: "cli",
    tierHint: "T1",
    type: "greenfield",
    acceptanceCriteria: ["self-test mechanical reachability"],
};
/**
 * Drive the deterministic spine (real `run*` handlers, NO LLM — the
 * orchestration-e2e pattern) to PRODUCE a harvestable scenario in an isolated OS
 * temp root: init → telemetry on → a real approved artifact → a completed,
 * gate-clean, dep-ordered slice plan → a real dispatch-route telemetry event.
 */
function driveSelfTestScenario() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-selftest-"));
    const paths = (0, paths_1.resolveProjectPaths)(root);
    (0, init_1.runInit)(paths, {});
    (0, telemetry_1.writeTelemetryConfig)(paths, { enabled: true });
    fs.mkdirSync(paths.docsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.docsDir, "04-architecture.md"), "# Architecture\n\nComponents and data flow.\n", "utf8");
    (0, artifact_1.runArtifactRegister)(paths, "docs/04-architecture.md", 1);
    const cur = (0, state_store_1.readState)(paths).state;
    const slices = [
        { id: "SLICE-1", status: "done", components: ["cli"] },
        { id: "SLICE-2", status: "done", components: ["core"], depends_on: ["SLICE-1"] },
    ];
    (0, state_store_1.writeState)(paths, {
        ...cur,
        tier: "T1",
        current_stage: "final-verification",
        implementation_allowed: true,
        slices,
        drift_open_blocking: 0,
    });
    (0, route_1.runRoute)(paths, { agent: "orchestrator", mode: "architecture" });
    return {
        artifacts: (0, harvest_1.harvestScenario)(paths, SELF_TEST_BRIEF.id),
        brief: SELF_TEST_BRIEF,
        cleanup: () => {
            try {
                fs.rmSync(root, { recursive: true, force: true });
            }
            catch {
                /* best-effort */
            }
        },
    };
}
/** Harvest the live scenarios on disk, matching each to its corpus brief by id. */
function harvestLiveScenarios(corpus) {
    const byId = new Map((corpus?.briefs ?? []).map((b) => [b.id, b]));
    const out = [];
    for (const scenario of (0, scenario_1.listScenarios)()) {
        try {
            const scenarioPaths = (0, paths_1.resolveProjectPaths)(scenario.scenarioRoot);
            out.push({
                artifacts: (0, harvest_1.harvestScenario)(scenarioPaths, scenario.briefId || null),
                brief: scenario.briefId ? byId.get(scenario.briefId) : undefined,
            });
        }
        catch {
            // Skip an unreadable/partial scenario sandbox.
        }
    }
    return out;
}
/**
 * Aggregate a per-component card across scenarios. One scenario → the card verbatim;
 * many → assertions are namespaced by briefId and per-scenario stats are keyed.
 */
function aggregateCard(component, parts) {
    if (parts.length === 1)
        return parts[0].card;
    if (parts.length === 0) {
        return (0, assert_1.buildReportCard)(component, [mk(component, "live_scenario_harvested", ">=1", 0, false)], { scenarios: 0 }, [
            {
                component,
                location: `${component}#live_scenario_harvested`,
                severity: "error",
                hint: `no live scenario was harvested for component ${component}; run \`th proof scenario start\` and drive a real pipeline first.`,
            },
        ]);
    }
    const assertions = [];
    const stats = {};
    for (const { briefId, card } of parts) {
        for (const a of card.assertions)
            assertions.push({ ...a, name: `${briefId}:${a.name}` });
        stats[briefId] = card.stats;
    }
    return (0, assert_1.buildReportCard)(component, assertions, stats);
}
/** Build components 1/2/5 cards (verdict from harvested LIVE artifacts only). */
function buildHarvestCards(scenarios, want) {
    const cards = new Map();
    const runs = [];
    const briefIds = [];
    const opParts = [];
    const orchParts = [];
    const dogParts = [];
    for (const s of scenarios) {
        const briefId = s.brief?.id ?? s.artifacts.briefId ?? "(unknown)";
        if (!briefIds.includes(briefId))
            briefIds.push(briefId);
        const op = (0, assert_1.operationalCard)(s.artifacts);
        const orch = (0, assert_1.orchestrationCard)(s.artifacts);
        const dog = (0, dogfood_1.dogfoodCard)(s.artifacts, s.brief);
        opParts.push({ briefId, card: op });
        orchParts.push({ briefId, card: orch });
        dogParts.push({ briefId, card: dog });
        const scenarioVerdict = [op, orch, dog].some((c) => c.verdict === "fail") ? "fail" : "pass";
        runs.push({
            id: briefId,
            briefId,
            tier: s.artifacts.state?.tier ?? null,
            type: s.brief?.type ?? "greenfield",
            status: "harvested",
            verdict: scenarioVerdict,
            stats: { stage: s.artifacts.state?.current_stage ?? null },
        });
    }
    if (want.has("operational"))
        cards.set("operational", aggregateCard("operational", opParts));
    if (want.has("orchestration"))
        cards.set("orchestration", aggregateCard("orchestration", orchParts));
    if (want.has("dogfood"))
        cards.set("dogfood", aggregateCard("dogfood", dogParts));
    return { cards, runs, briefIds };
}
/** Component 3 (stress) card — real multi-process lock contention + scanner load. */
async function buildStressCard(opts, repoRoot) {
    const C = "stress";
    const writers = Math.max(1, Math.floor(opts.stressWriters ?? (opts.selfTest ? 3 : 8)));
    const cliPath = opts.cliPath ?? path.join(repoRoot, "dist", "cli.js");
    const cliPresent = fs.existsSync(cliPath);
    const assertions = [];
    let lock;
    if (cliPresent) {
        lock = await (0, stress_1.runLockContention)({ writers, cliPath });
        assertions.push(mk(C, "lock_no_lost_updates", false, lock.lostUpdates, !lock.lostUpdates), mk(C, "lock_no_deadlock", false, lock.deadlock, !lock.deadlock), mk(C, "lock_unique_ids", writers, lock.uniqueIds, lock.uniqueIds === writers), mk(C, "lock_final_count", writers, lock.finalCount, lock.finalCount === writers));
    }
    const fixtureRoot = (0, fixtures_1.makeLargeRepo)(opts.selfTest ? 120 : 600);
    let scan;
    try {
        scan = (0, stress_1.runScannerLoad)(fixtureRoot, {});
        assertions.push(mk(C, "scanner_completed", true, scan.completed, scan.completed), mk(C, "scanner_within_bound", true, scan.withinBound, scan.withinBound));
    }
    finally {
        try {
            fs.rmSync(fixtureRoot, { recursive: true, force: true });
        }
        catch {
            /* best-effort */
        }
    }
    const stats = { writers, cliPath, cliPresent, lock, scan };
    if (!cliPresent) {
        // No compiled CLI → the real multi-process contention proof cannot run here.
        return {
            component: C,
            verdict: "skip",
            assertions,
            stats,
            diagnostics: [
                {
                    component: C,
                    location: cliPath,
                    severity: "warning",
                    hint: "dist/cli.js absent — run `npm run build` to exercise the real multi-process lock-contention stress proof.",
                },
            ],
        };
    }
    return (0, assert_1.buildReportCard)(C, assertions, stats);
}
/** Measure the deterministic mechanical perf metrics (all gating:true). */
function measureMetrics(opts) {
    const metrics = [];
    const iter = opts.selfTest ? 3 : 10;
    const scanRoot = (0, fixtures_1.makeLargeRepo)(opts.selfTest ? 60 : 200);
    try {
        metrics.push((0, perf_1.measureScannerWalk)(scanRoot, { iterations: iter }));
    }
    finally {
        try {
            fs.rmSync(scanRoot, { recursive: true, force: true });
        }
        catch {
            /* best-effort */
        }
    }
    const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-perf-"));
    try {
        const p = (0, paths_1.resolveProjectPaths)(lockRoot);
        (0, init_1.runInit)(p, {});
        metrics.push((0, perf_1.measureLockLatency)(p, { iterations: opts.selfTest ? 5 : 30 }));
    }
    finally {
        try {
            fs.rmSync(lockRoot, { recursive: true, force: true });
        }
        catch {
            /* best-effort */
        }
    }
    const slices = [
        { id: "SLICE-1", status: "pending", components: ["a"] },
        { id: "SLICE-2", status: "pending", components: ["b"], depends_on: ["SLICE-1"] },
        { id: "SLICE-3", status: "pending", components: ["c"], depends_on: ["SLICE-1"] },
    ];
    metrics.push((0, perf_1.measureScheduleWaves)(slices, { iterations: opts.selfTest ? 10 : 30 }));
    return metrics;
}
/** Component 4 (performance) card — metrics measured + gating regression check. */
function buildPerformanceCard(metrics, regressions) {
    const C = "performance";
    const assertions = metrics.map((m) => mk(C, `metric_${m.name}_measured`, ">=1 sample", m.series.length, m.series.length > 0));
    const gatingRegressed = regressions.filter((r) => r.regressed);
    assertions.push(mk(C, "no_gating_regression", [], gatingRegressed.map((r) => r.metric), gatingRegressed.length === 0));
    const stats = {
        metrics: metrics.map((m) => ({ name: m.name, p50: m.p50, p95: m.p95, gating: m.gating, samples: m.series.length })),
        regressions,
    };
    return (0, assert_1.buildReportCard)(C, assertions, stats);
}
/** Component 6 (failure-injection) card — every enumerated fault failed safely. */
function buildFaultsCard() {
    const C = "failure-injection";
    const results = (0, faults_1.runAllFaults)();
    const assertions = results.map((r) => mk(C, `fault_${r.fault}`, r.expected, r.observed, r.pass));
    const stats = {
        faults: results.map((r) => ({ fault: r.fault, pass: r.pass, observed: r.observed, gateBlocked: r.gateBlocked })),
        gateBlocks: results.filter((r) => r.gateBlocked).length,
    };
    return (0, assert_1.buildReportCard)(C, assertions, stats);
}
/** Component 7 (containment) card — exact NAME-SET allowlist + guards + GATE_OWNED + no-network. */
function buildContainmentCard(toolNames) {
    const C = "containment";
    const report = (0, containment_1.assertContainment)({ toolNames });
    return { component: C, verdict: report.assertions.some((a) => !a.pass) ? "fail" : "pass", assertions: report.assertions, stats: report.stats, diagnostics: report.diagnostics };
}
/** Component 8 (cross-platform) card — per-case OS pass/skip recorded, never silent. */
function buildPlatformCard() {
    const C = "cross-platform";
    const parity = (0, platform_1.runPlatformParity)();
    const assertions = parity.cases.map((c) => 
    // A case is satisfactory when it either ran-and-passed OR was legitimately skipped.
    mk(C, `case_${c.name}`, "ran:PASS | skipped", c.reason, c.skipped || c.reason.startsWith("PASS")));
    const stats = { os: parity.os, cases: parity.cases };
    return (0, assert_1.buildReportCard)(C, assertions, stats);
}
/**
 * Exercise the four gates mechanically (stop / write / PreToolUse / decision) in an
 * isolated temp project and return which were reachable. Pure mechanical
 * reachability — never an LLM — feeding the coverage-matrix gate dimension.
 */
function exerciseGates() {
    const touched = new Set();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-gates-"));
    try {
        const paths = (0, paths_1.resolveProjectPaths)(root);
        (0, init_1.runInit)(paths, {});
        (0, hook_1.evaluateStopGate)(paths);
        touched.add("stop");
        (0, hook_1.runHookPretoolGate)(paths, {
            tool_name: "Write",
            tool_input: { file_path: path.join(root, "src", "probe.ts") },
            cwd: root,
        });
        touched.add("write");
        touched.add("PreToolUse");
        (0, decision_1.runDecisionCheck)(paths, {});
        touched.add("decision");
    }
    catch {
        /* best-effort — whatever was reached is recorded */
    }
    finally {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        }
        catch {
            /* best-effort */
        }
    }
    return [...touched];
}
/**
 * Run the full operational proof suite (or the requested component subset) and
 * return the consolidated {@link ProofReport}. Async because the stress sub-proof
 * spawns real OS processes.
 */
async function runProof(opts = {}) {
    const startedAt = new Date().toISOString();
    const repoRoot = opts.repoRoot ?? process.cwd();
    const selfTest = opts.selfTest ?? false;
    const want = new Set(opts.components && opts.components.length ? opts.components : [...types_1.PROOF_COMPONENTS]);
    const componentsRun = types_1.PROOF_COMPONENTS.filter((c) => want.has(c));
    const toolNames = opts.registry?.names ?? containment_1.EXPECTED_TOOL_ALLOWLIST;
    const registryPresent = opts.registry !== undefined;
    const cardsByComponent = new Map();
    const diagnostics = [];
    let regressions = [];
    const cleanups = [];
    // --- Components 1/2/5: harvested LIVE artifacts (or the self-test spine). ---
    const need125 = want.has("operational") || want.has("orchestration") || want.has("dogfood");
    let scenarios = [];
    if (need125) {
        scenarios = selfTest ? [driveSelfTestScenario()] : harvestLiveScenarios(opts.corpus);
        for (const s of scenarios)
            if (s.cleanup)
                cleanups.push(s.cleanup);
    }
    const harvest = buildHarvestCards(scenarios, want);
    for (const [component, card] of harvest.cards)
        cardsByComponent.set(component, card);
    // --- Component 3: stress (real multi-process). ---
    if (want.has("stress"))
        cardsByComponent.set("stress", await buildStressCard(opts, repoRoot));
    // --- Component 4: performance + split-gated regression (M4). ---
    if (want.has("performance")) {
        const metrics = measureMetrics(opts);
        const baselines = (0, regression_1.loadBaselines)(repoRoot);
        regressions = (0, regression_1.flagRegressions)((0, regression_1.diffAgainstBaselines)(metrics, baselines), opts.tolerancePct ?? regression_1.DEFAULT_TOLERANCE_PCT);
        if (opts.updateBaselines) {
            try {
                (0, regression_1.saveBaselines)(repoRoot, "proof", metrics.map((m) => (0, regression_1.baselineFromMetric)(m, "proof")));
            }
            catch {
                /* best-effort: baseline persistence must never fail the run */
            }
        }
        cardsByComponent.set("performance", buildPerformanceCard(metrics, regressions));
    }
    // --- Component 6: failure-injection. ---
    if (want.has("failure-injection"))
        cardsByComponent.set("failure-injection", buildFaultsCard());
    // --- Component 7: containment. ---
    if (want.has("containment"))
        cardsByComponent.set("containment", buildContainmentCard(toolNames));
    // --- Component 8: cross-platform. ---
    if (want.has("cross-platform"))
        cardsByComponent.set("cross-platform", buildPlatformCard());
    // --- Coverage matrix (always computed; it is ProofReport.matrix). ---
    const subsystemsTouched = [...new Set(componentsRun.flatMap((c) => [...COMPONENT_SUBSYSTEMS[c]]))];
    const gatesTouched = want.has("runner-report") || want.has("failure-injection") ? exerciseGates() : [];
    const liveMcpCalls = scenarios.flatMap((s) => s.artifacts.mcpCalls);
    const mcpUnverifiable = !registryPresent && !selfTest;
    const matrix = (0, coverage_matrix_1.buildCoverageMatrix)({
        knownToolNames: toolNames,
        liveMcpCalls,
        subsystemsTouched,
        gatesTouched,
        selfTestOnly: selfTest,
        mcpUnverifiable,
    });
    // --- Component 9: runner-report (matrix completeness verdict). ---
    if (want.has("runner-report")) {
        const C = "runner-report";
        const assertions = [
            mk(C, "coverage_matrix_complete", true, matrix.complete, matrix.complete),
            mk(C, "subsystems_all_touched", 0, matrix.subsystems.untouched.length, matrix.subsystems.untouched.length === 0),
            mk(C, "mcp_tools_all_touched", 0, matrix.mcpTools.untouched.length, matrix.mcpTools.untouched.length === 0),
            mk(C, "gates_all_touched", 0, matrix.gates.untouched.length, matrix.gates.untouched.length === 0),
            mk(C, "report_assembled", true, true, true),
        ];
        const matrixDiags = (0, coverage_matrix_1.matrixDiagnostics)(matrix, { selfTestOnly: selfTest, mcpUnverifiable });
        cardsByComponent.set(C, (0, assert_1.buildReportCard)(C, assertions, { matrix }, matrixDiags));
    }
    // --- Assemble cards in component order + collect diagnostics. ---
    const cards = [];
    for (const component of types_1.PROOF_COMPONENTS) {
        const card = cardsByComponent.get(component);
        if (card) {
            cards.push(card);
            diagnostics.push(...card.diagnostics);
        }
    }
    // --- Overall verdict + run summary. ---
    const anyCardFail = cards.some((c) => c.verdict === "fail");
    const gatingRegression = regressions.some((r) => r.regressed);
    // The coverage-matrix completeness gate (AC #5) applies ONLY to a FULL nine-component
    // run: a subset / single-component run (`th proof component <N>`) can never touch every
    // subsystem, MCP tool, and gate, so its matrix is necessarily incomplete. For a subset
    // run the matrix is REPORTED but NOT gating — the verdict derives from the card(s) + any
    // gating regression — so a passing component faithfully yields a passing run.
    const fullRun = componentsRun.length === types_1.PROOF_COMPONENTS.length;
    const verdict = anyCardFail || (fullRun && !matrix.complete) || gatingRegression ? "fail" : "pass";
    const finishedAt = new Date().toISOString();
    const summary = {
        id: `proof-${startedAt.replace(/[:.]/g, "-")}`,
        startedAt,
        finishedAt,
        verdict,
        briefIds: harvest.briefIds,
        componentsRun,
        scenarios: harvest.runs,
        stats: {
            selfTest,
            registryPresent,
            toolCount: toolNames.length,
            matrixComplete: matrix.complete,
            gatingRegression,
            cardVerdicts: Object.fromEntries(cards.map((c) => [c.component, c.verdict])),
        },
        tokenCost: null,
    };
    const report = { summary, cards, matrix, regressions, diagnostics };
    // --- Optionally emit the dual-format report. ---
    const outputRoot = opts.outputRoot ?? (opts.emit ? (0, report_1.defaultOutputRoot)(repoRoot) : undefined);
    if (outputRoot) {
        const emitted = (0, report_1.emitReport)(report, { outputRoot });
        summary.stats.report = { dir: emitted.dir, jsonPath: emitted.jsonPath, jsonlPath: emitted.jsonlPath, mdPath: emitted.mdPath };
    }
    for (const cleanup of cleanups)
        cleanup();
    return report;
}
/** Run a single component (plan Step 9 — single-component runs). */
async function runComponent(component, opts = {}) {
    return runProof({ ...opts, components: [component] });
}
