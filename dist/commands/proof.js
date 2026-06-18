"use strict";
/**
 * `th proof …` command handlers (plan Step 9). Thin {@link CommandResult} adapters
 * over the deterministic proof engine (`src/core/proof/*`): the runner, scenario
 * lifecycle, corpus loader, and baseline store. Mirrors the repo's command style —
 * pure `run<Group><Sub>(paths, opts?) → CommandResult` functions the CLI dispatches.
 *
 * R7: this module NEVER imports `src/mcp-server.ts`. The live MCP tool registry is
 * INJECTED via `opts.registry` (cli.ts and the th_proof_* MCP wrappers supply it);
 * when absent, the coverage matrix's MCP-tool dimension is reported UNVERIFIABLE.
 *
 * Async note: the runner spawns real OS processes, so the run/component/report/
 * baseline handlers return `Promise<CommandResult>`; the scenario lifecycle handlers
 * are synchronous. The CLI dispatcher must `await` the async handlers (Phase B).
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
exports.runProofRun = runProofRun;
exports.runProofComponent = runProofComponent;
exports.runProofReport = runProofReport;
exports.runProofBaselineUpdate = runProofBaselineUpdate;
exports.runProofScenarioStart = runProofScenarioStart;
exports.runProofScenarioFinish = runProofScenarioFinish;
exports.runProofScenarioList = runProofScenarioList;
const path = __importStar(require("node:path"));
const paths_1 = require("../core/paths");
const output_1 = require("../core/output");
const runner_1 = require("../core/proof/runner");
const report_1 = require("../core/proof/report");
const scenario_1 = require("../core/proof/scenario");
const corpus_1 = require("../core/proof/corpus");
const types_1 = require("../core/proof/types");
/** Default bundled-corpus root: `<repo>/proof/corpus`, resolved relative to this module. */
function defaultCorpusRoot() {
    // dist/commands/proof.js → ../../proof/corpus ; src/commands/proof.ts → ../../proof/corpus.
    return path.resolve(__dirname, "..", "..", "proof", "corpus");
}
/** Best-effort corpus load (the corpus is optional for self-test / harvest fallback). */
function tryLoadCorpus(opts) {
    try {
        return (0, corpus_1.loadCorpus)(opts.corpusRoot ?? defaultCorpusRoot());
    }
    catch {
        return undefined;
    }
}
/** Resolve a `--component <name|1-9>` selector to a {@link ProofComponent}. */
function resolveComponent(selector) {
    if (!selector)
        return undefined;
    if (types_1.PROOF_COMPONENTS.includes(selector))
        return selector;
    const n = Number(selector);
    if (Number.isInteger(n) && n >= 1 && n <= types_1.PROOF_COMPONENTS.length)
        return types_1.PROOF_COMPONENTS[n - 1];
    return undefined;
}
/** A concise human summary of a finished proof report. */
function summarizeReport(report) {
    const lines = [];
    lines.push(`proof run ${report.summary.id} → ${report.summary.verdict.toUpperCase()}`);
    for (const card of report.cards)
        lines.push(`  ${card.verdict === "pass" ? "✓" : card.verdict === "skip" ? "∼" : "✗"} ${card.component}: ${card.verdict}`);
    lines.push(`  coverage matrix: ${report.matrix.complete ? "complete" : "INCOMPLETE"}`);
    const reportInfo = report.summary.stats.report;
    if (reportInfo?.dir)
        lines.push(`  report: ${reportInfo.dir}`);
    if (report.diagnostics.length)
        lines.push(`  diagnostics: ${report.diagnostics.length}`);
    return lines.join("\n");
}
/** Build the CommandResult envelope from a finished report (verdict drives exit code). */
function reportResult(report) {
    const data = {
        verdict: report.summary.verdict,
        matrixComplete: report.matrix.complete,
        cards: report.cards.map((c) => ({ component: c.component, verdict: c.verdict })),
        diagnostics: report.diagnostics,
        summary: report.summary,
    };
    const human = summarizeReport(report);
    return report.summary.verdict === "fail" ? (0, output_1.failure)({ data, human }) : (0, output_1.success)({ data, human });
}
/**
 * `th proof run` — mechanical self-test and report runner: evaluates all nine
 * component cards over harvested proof scenarios and emits the dual-format report.
 * `--self-test` drives the deterministic self-test spine (real `run*` handlers,
 * no LLM) to produce harvestable artifacts — NOT a live agent/pipeline driver.
 */
async function runProofRun(paths, opts = {}) {
    const report = await (0, runner_1.runProof)({
        corpus: tryLoadCorpus(opts),
        selfTest: opts.selfTest,
        registry: opts.registry,
        repoRoot: paths.root,
        outputRoot: opts.outputRoot ?? (0, report_1.defaultOutputRoot)(paths.root),
    });
    return reportResult(report);
}
/**
 * `th proof component <name|1-9>` — run a single component's proof and emit the
 * report. Useful for the per-component slash command / iterative debugging.
 */
async function runProofComponent(paths, opts = {}) {
    const component = resolveComponent(opts.component);
    if (!component) {
        return (0, output_1.failure)({
            human: `unknown proof component: ${opts.component ?? "(none)"}\navailable: ${types_1.PROOF_COMPONENTS.map((c, i) => `${i + 1}=${c}`).join(", ")}`,
            data: { error: "unknown_component", component: opts.component ?? null, available: types_1.PROOF_COMPONENTS },
        });
    }
    const report = await (0, runner_1.runComponent)(component, {
        corpus: tryLoadCorpus(opts),
        selfTest: opts.selfTest,
        registry: opts.registry,
        repoRoot: paths.root,
        outputRoot: opts.outputRoot ?? (0, report_1.defaultOutputRoot)(paths.root),
    });
    return reportResult(report);
}
/**
 * `th proof report` — harvest the finished live scenarios and emit the consolidated
 * dual-format report (the final consolidation step of the in-session workflow).
 */
async function runProofReport(paths, opts = {}) {
    const report = await (0, runner_1.runProof)({
        corpus: tryLoadCorpus(opts),
        selfTest: false,
        registry: opts.registry,
        repoRoot: paths.root,
        outputRoot: opts.outputRoot ?? (0, report_1.defaultOutputRoot)(paths.root),
    });
    return reportResult(report);
}
/**
 * `th proof baseline update` — measure the deterministic mechanical perf metrics and
 * persist them as the new gating baselines (PS-Q2). Read-only on the proof corpus.
 */
async function runProofBaselineUpdate(paths, opts = {}) {
    const report = await (0, runner_1.runProof)({
        components: ["performance"],
        registry: opts.registry,
        repoRoot: paths.root,
        updateBaselines: true,
    });
    const perf = report.cards.find((c) => c.component === "performance");
    return (0, output_1.success)({
        data: { updated: true, performance: perf?.stats ?? null },
        human: `baselines updated under ${paths.root} (.twinharness/proof/baselines/proof.json)`,
    });
}
/**
 * `th proof scenario start --brief <id>` — scaffold an isolated scenario sandbox and
 * PRINT its root so the skill can `export CLAUDE_PROJECT_DIR=<scenarioRoot>` (C2).
 */
function runProofScenarioStart(paths, opts = {}) {
    void paths;
    const corpus = tryLoadCorpus(opts);
    if (!corpus) {
        return (0, output_1.failure)({ human: "could not load the proof corpus; pass --corpus-root or check proof/corpus/index.json", data: { error: "corpus_unavailable" } });
    }
    const brief = opts.brief
        ? corpus.briefs.find((b) => b.id === opts.brief)
        : corpus.briefs[0];
    if (!brief) {
        return (0, output_1.failure)({
            human: `unknown brief: ${opts.brief ?? "(none)"}\navailable: ${corpus.briefs.map((b) => b.id).join(", ")}`,
            data: { error: "unknown_brief", brief: opts.brief ?? null, available: corpus.briefs.map((b) => b.id) },
        });
    }
    const handle = (0, scenario_1.startScenario)(brief);
    return (0, output_1.success)({
        data: { scenarioRoot: handle.scenarioRoot, briefId: brief.id, stateDir: handle.scenarioPaths.stateDir },
        human: [
            `scenario prepared for brief "${brief.id}" (tier ${brief.tierHint}, ${brief.type}).`,
            `scenarioRoot: ${handle.scenarioRoot}`,
            ``,
            `Export it for the live run, then drive the real pipeline:`,
            `  export CLAUDE_PROJECT_DIR="${handle.scenarioRoot}"`,
        ].join("\n"),
    });
}
/**
 * `th proof scenario finish` — mark the scenario (default: the resolved project root,
 * or `--scenario-root <dir>`) finished; artifacts remain in the scenario root.
 */
function runProofScenarioFinish(paths, opts = {}) {
    const scenarioPaths = opts.scenarioRoot ? (0, paths_1.resolveProjectPaths)(opts.scenarioRoot) : paths;
    const scenario = (0, scenario_1.finishScenario)(scenarioPaths);
    return (0, output_1.success)({
        data: { scenario },
        human: `scenario ${scenario.id} (brief ${scenario.briefId || "?"}) → ${scenario.status}`,
    });
}
/** `th proof scenario list` — enumerate the prepared/finished scenario sandboxes. */
function runProofScenarioList(_paths, _opts = {}) {
    void _paths;
    void _opts;
    const scenarios = (0, scenario_1.listScenarios)();
    const human = scenarios.length
        ? scenarios.map((s) => `  ${s.id}  brief=${s.briefId || "?"}  tier=${s.tier ?? "?"}  ${s.status}`).join("\n")
        : "(no proof scenarios on disk)";
    return (0, output_1.success)({ data: { scenarios }, human: `proof scenarios (${scenarios.length}):\n${human}` });
}
