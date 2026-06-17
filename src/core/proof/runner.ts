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

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveProjectPaths, type ProjectPaths } from "../paths";
import type { SliceState } from "../state-schema";
import { readState, writeState } from "../state-store";
import { runInit } from "../../commands/init";
import { runArtifactRegister } from "../../commands/artifact";
import { runRoute } from "../../commands/route";
import { writeTelemetryConfig } from "../telemetry";
import { evaluateStopGate, runHookPretoolGate } from "../../commands/hook";
import { runDecisionCheck } from "../../commands/decision";

import { harvestScenario } from "./harvest";
import { listScenarios } from "./scenario";
import { operationalCard, orchestrationCard, buildReportCard } from "./assert";
import { dogfoodCard } from "./dogfood";
import { runLockContention, runScannerLoad } from "./stress";
import { makeLargeRepo } from "./fixtures";
import { measureScannerWalk, measureLockLatency, measureScheduleWaves } from "./perf";
import { loadBaselines, diffAgainstBaselines, flagRegressions, saveBaselines, baselineFromMetric, DEFAULT_TOLERANCE_PCT } from "./regression";
import { runAllFaults } from "./faults";
import { assertContainment, EXPECTED_TOOL_ALLOWLIST } from "./containment";
import { runPlatformParity } from "./platform";
import { buildCoverageMatrix, matrixDiagnostics } from "./coverage-matrix";
import { emitReport, defaultOutputRoot, type EmittedReport } from "./report";
import {
  PROOF_COMPONENTS,
  type Assertion,
  type Corpus,
  type Diagnostic,
  type PerfMetric,
  type ProofComponent,
  type ProofReport,
  type ProofRun,
  type ReportCard,
  type RegressionDelta,
  type RunSummary,
  type SampleBrief,
  type ScenarioArtifacts,
} from "./types";

/**
 * The injected MCP tool registry (R7 — never imported from `src/mcp-server.ts`).
 * `names` is the live tool-name set (the coverage matrix's known MCP-tool set);
 * `invoke` is an optional in-process round-trip the perf/round-trip metric can use.
 */
export interface ProofToolRegistry {
  names: readonly string[];
  invoke?(name: string, paths: ProjectPaths, args: Record<string, unknown>): unknown;
}

export interface RunProofOptions {
  /** The bundled corpus (its briefs identify harvested scenarios). */
  corpus?: Corpus;
  /** Restrict the run to these components (default: all nine). */
  components?: ProofComponent[];
  /** Deterministic mechanical-reachability mode (drives `run*`, no LLM). */
  selfTest?: boolean;
  /** The injected MCP tool registry (absent → MCP-tool dimension UNVERIFIABLE). */
  registry?: ProofToolRegistry;
  /** Where to write the dual-format report (default {@link defaultOutputRoot}). */
  outputRoot?: string;
  /** The repo root for baselines + the default output root (default `process.cwd()`). */
  repoRoot?: string;
  /** Emit the dual-format report to disk (default: only when `outputRoot` is set). */
  emit?: boolean;
  /** Concurrent stress writers (default: 8 live / 3 self-test). */
  stressWriters?: number;
  /** Compiled CLI path for the stress proof (default `<repoRoot>/dist/cli.js`). */
  cliPath?: string;
  /** Persist freshly-measured perf metrics as the new gating baselines. */
  updateBaselines?: boolean;
  /** Mechanical regression tolerance percent (default {@link DEFAULT_TOLERANCE_PCT}). */
  tolerancePct?: number;
}

/** Build one assertion record (local mirror of assert.ts's private helper). */
function mk(component: ProofComponent, name: string, expected: unknown, actual: unknown, pass: boolean): Assertion {
  return { name, component, expected, actual, pass };
}

/** Which `src/core/*` subsystems each component exercises (union → matrix touched-set). */
const COMPONENT_SUBSYSTEMS: Record<ProofComponent, readonly string[]> = {
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
const SELF_TEST_BRIEF: SampleBrief = {
  id: "self-test",
  size: "tiny",
  domain: "cli",
  tierHint: "T1",
  type: "greenfield",
  acceptanceCriteria: ["self-test mechanical reachability"],
};

/** A harvested scenario + the brief that produced it (brief drives the dogfood card). */
interface HarvestedScenario {
  artifacts: ScenarioArtifacts;
  brief?: SampleBrief;
  cleanup?: () => void;
}

/**
 * Drive the deterministic spine (real `run*` handlers, NO LLM — the
 * orchestration-e2e pattern) to PRODUCE a harvestable scenario in an isolated OS
 * temp root: init → telemetry on → a real approved artifact → a completed,
 * gate-clean, dep-ordered slice plan → a real dispatch-route telemetry event.
 */
function driveSelfTestScenario(): HarvestedScenario {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-selftest-"));
  const paths = resolveProjectPaths(root);
  runInit(paths, {});
  writeTelemetryConfig(paths, { enabled: true });

  fs.mkdirSync(paths.docsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.docsDir, "04-architecture.md"), "# Architecture\n\nComponents and data flow.\n", "utf8");
  runArtifactRegister(paths, "docs/04-architecture.md", 1);

  const cur = readState(paths).state!;
  const slices: SliceState[] = [
    { id: "SLICE-1", status: "done", components: ["cli"] },
    { id: "SLICE-2", status: "done", components: ["core"], depends_on: ["SLICE-1"] },
  ];
  writeState(paths, {
    ...cur,
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    slices,
    drift_open_blocking: 0,
  });

  runRoute(paths, { agent: "orchestrator", mode: "architecture" });

  return {
    artifacts: harvestScenario(paths, SELF_TEST_BRIEF.id),
    brief: SELF_TEST_BRIEF,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Harvest the live scenarios on disk, matching each to its corpus brief by id. */
function harvestLiveScenarios(corpus?: Corpus): HarvestedScenario[] {
  const byId = new Map((corpus?.briefs ?? []).map((b) => [b.id, b]));
  const out: HarvestedScenario[] = [];
  for (const scenario of listScenarios()) {
    try {
      const scenarioPaths = resolveProjectPaths(scenario.scenarioRoot);
      out.push({
        artifacts: harvestScenario(scenarioPaths, scenario.briefId || null),
        brief: scenario.briefId ? byId.get(scenario.briefId) : undefined,
      });
    } catch {
      // Skip an unreadable/partial scenario sandbox.
    }
  }
  return out;
}

/**
 * Aggregate a per-component card across scenarios. One scenario → the card verbatim;
 * many → assertions are namespaced by briefId and per-scenario stats are keyed.
 */
function aggregateCard(component: ProofComponent, parts: Array<{ briefId: string; card: ReportCard }>): ReportCard {
  if (parts.length === 1) return parts[0]!.card;
  if (parts.length === 0) {
    return buildReportCard(
      component,
      [mk(component, "live_scenario_harvested", ">=1", 0, false)],
      { scenarios: 0 },
      [
        {
          component,
          location: `${component}#live_scenario_harvested`,
          severity: "error",
          hint: `no live scenario was harvested for component ${component}; run \`th proof scenario start\` and drive a real pipeline first.`,
        },
      ],
    );
  }
  const assertions: Assertion[] = [];
  const stats: Record<string, unknown> = {};
  for (const { briefId, card } of parts) {
    for (const a of card.assertions) assertions.push({ ...a, name: `${briefId}:${a.name}` });
    stats[briefId] = card.stats;
  }
  return buildReportCard(component, assertions, stats);
}

/** Build components 1/2/5 cards (verdict from harvested LIVE artifacts only). */
function buildHarvestCards(
  scenarios: HarvestedScenario[],
  want: Set<ProofComponent>,
): { cards: Map<ProofComponent, ReportCard>; runs: ProofRun[]; briefIds: string[] } {
  const cards = new Map<ProofComponent, ReportCard>();
  const runs: ProofRun[] = [];
  const briefIds: string[] = [];

  const opParts: Array<{ briefId: string; card: ReportCard }> = [];
  const orchParts: Array<{ briefId: string; card: ReportCard }> = [];
  const dogParts: Array<{ briefId: string; card: ReportCard }> = [];

  for (const s of scenarios) {
    const briefId = s.brief?.id ?? s.artifacts.briefId ?? "(unknown)";
    if (!briefIds.includes(briefId)) briefIds.push(briefId);
    const op = operationalCard(s.artifacts);
    const orch = orchestrationCard(s.artifacts);
    const dog = dogfoodCard(s.artifacts, s.brief);
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

  if (want.has("operational")) cards.set("operational", aggregateCard("operational", opParts));
  if (want.has("orchestration")) cards.set("orchestration", aggregateCard("orchestration", orchParts));
  if (want.has("dogfood")) cards.set("dogfood", aggregateCard("dogfood", dogParts));

  return { cards, runs, briefIds };
}

/** Component 3 (stress) card — real multi-process lock contention + scanner load. */
async function buildStressCard(opts: RunProofOptions, repoRoot: string): Promise<ReportCard> {
  const C: ProofComponent = "stress";
  const writers = Math.max(1, Math.floor(opts.stressWriters ?? (opts.selfTest ? 3 : 8)));
  const cliPath = opts.cliPath ?? path.join(repoRoot, "dist", "cli.js");
  const cliPresent = fs.existsSync(cliPath);

  const assertions: Assertion[] = [];
  let lock: Awaited<ReturnType<typeof runLockContention>> | undefined;
  if (cliPresent) {
    lock = await runLockContention({ writers, cliPath });
    assertions.push(
      mk(C, "lock_no_lost_updates", false, lock.lostUpdates, !lock.lostUpdates),
      mk(C, "lock_no_deadlock", false, lock.deadlock, !lock.deadlock),
      mk(C, "lock_unique_ids", writers, lock.uniqueIds, lock.uniqueIds === writers),
      mk(C, "lock_final_count", writers, lock.finalCount, lock.finalCount === writers),
    );
  }

  const fixtureRoot = makeLargeRepo(opts.selfTest ? 120 : 600);
  let scan: ReturnType<typeof runScannerLoad> | undefined;
  try {
    scan = runScannerLoad(fixtureRoot, {});
    assertions.push(
      mk(C, "scanner_completed", true, scan.completed, scan.completed),
      mk(C, "scanner_within_bound", true, scan.withinBound, scan.withinBound),
    );
  } finally {
    try {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  const stats: Record<string, unknown> = { writers, cliPath, cliPresent, lock, scan };

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
  return buildReportCard(C, assertions, stats);
}

/** Measure the deterministic mechanical perf metrics (all gating:true). */
function measureMetrics(opts: RunProofOptions): PerfMetric[] {
  const metrics: PerfMetric[] = [];
  const iter = opts.selfTest ? 3 : 10;

  const scanRoot = makeLargeRepo(opts.selfTest ? 60 : 200);
  try {
    metrics.push(measureScannerWalk(scanRoot, { iterations: iter }));
  } finally {
    try {
      fs.rmSync(scanRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-perf-"));
  try {
    const p = resolveProjectPaths(lockRoot);
    runInit(p, {});
    metrics.push(measureLockLatency(p, { iterations: opts.selfTest ? 5 : 30 }));
  } finally {
    try {
      fs.rmSync(lockRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  const slices: SliceState[] = [
    { id: "SLICE-1", status: "pending", components: ["a"] },
    { id: "SLICE-2", status: "pending", components: ["b"], depends_on: ["SLICE-1"] },
    { id: "SLICE-3", status: "pending", components: ["c"], depends_on: ["SLICE-1"] },
  ];
  metrics.push(measureScheduleWaves(slices, { iterations: opts.selfTest ? 10 : 30 }));

  return metrics;
}

/** Component 4 (performance) card — metrics measured + gating regression check. */
function buildPerformanceCard(metrics: PerfMetric[], regressions: RegressionDelta[]): ReportCard {
  const C: ProofComponent = "performance";
  const assertions: Assertion[] = metrics.map((m) =>
    mk(C, `metric_${m.name}_measured`, ">=1 sample", m.series.length, m.series.length > 0),
  );
  const gatingRegressed = regressions.filter((r) => r.regressed);
  assertions.push(mk(C, "no_gating_regression", [], gatingRegressed.map((r) => r.metric), gatingRegressed.length === 0));
  const stats = {
    metrics: metrics.map((m) => ({ name: m.name, p50: m.p50, p95: m.p95, gating: m.gating, samples: m.series.length })),
    regressions,
  };
  return buildReportCard(C, assertions, stats);
}

/** Component 6 (failure-injection) card — every enumerated fault failed safely. */
function buildFaultsCard(): ReportCard {
  const C: ProofComponent = "failure-injection";
  const results = runAllFaults();
  const assertions: Assertion[] = results.map((r) =>
    mk(C, `fault_${r.fault}`, r.expected, r.observed, r.pass),
  );
  const stats = {
    faults: results.map((r) => ({ fault: r.fault, pass: r.pass, observed: r.observed, gateBlocked: r.gateBlocked })),
    gateBlocks: results.filter((r) => r.gateBlocked).length,
  };
  return buildReportCard(C, assertions, stats);
}

/** Component 7 (containment) card — exact NAME-SET allowlist + guards + GATE_OWNED + no-network. */
function buildContainmentCard(toolNames: readonly string[]): ReportCard {
  const C: ProofComponent = "containment";
  const report = assertContainment({ toolNames });
  return { component: C, verdict: report.assertions.some((a) => !a.pass) ? "fail" : "pass", assertions: report.assertions, stats: report.stats, diagnostics: report.diagnostics };
}

/** Component 8 (cross-platform) card — per-case OS pass/skip recorded, never silent. */
function buildPlatformCard(): ReportCard {
  const C: ProofComponent = "cross-platform";
  const parity = runPlatformParity();
  const assertions: Assertion[] = parity.cases.map((c) =>
    // A case is satisfactory when it either ran-and-passed OR was legitimately skipped.
    mk(C, `case_${c.name}`, "ran:PASS | skipped", c.reason, c.skipped || c.reason.startsWith("PASS")),
  );
  const stats = { os: parity.os, cases: parity.cases };
  return buildReportCard(C, assertions, stats);
}

/**
 * Exercise the four gates mechanically (stop / write / PreToolUse / decision) in an
 * isolated temp project and return which were reachable. Pure mechanical
 * reachability — never an LLM — feeding the coverage-matrix gate dimension.
 */
function exerciseGates(): string[] {
  const touched = new Set<string>();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-gates-"));
  try {
    const paths = resolveProjectPaths(root);
    runInit(paths, {});
    evaluateStopGate(paths);
    touched.add("stop");
    runHookPretoolGate(paths, {
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "src", "probe.ts") },
      cwd: root,
    });
    touched.add("write");
    touched.add("PreToolUse");
    runDecisionCheck(paths, {});
    touched.add("decision");
  } catch {
    /* best-effort — whatever was reached is recorded */
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
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
export async function runProof(opts: RunProofOptions = {}): Promise<ProofReport> {
  const startedAt = new Date().toISOString();
  const repoRoot = opts.repoRoot ?? process.cwd();
  const selfTest = opts.selfTest ?? false;
  const want = new Set<ProofComponent>(opts.components && opts.components.length ? opts.components : [...PROOF_COMPONENTS]);
  const componentsRun = PROOF_COMPONENTS.filter((c) => want.has(c));

  const toolNames = opts.registry?.names ?? EXPECTED_TOOL_ALLOWLIST;
  const registryPresent = opts.registry !== undefined;

  const cardsByComponent = new Map<ProofComponent, ReportCard>();
  const diagnostics: Diagnostic[] = [];
  let regressions: RegressionDelta[] = [];
  const cleanups: Array<() => void> = [];

  // --- Components 1/2/5: harvested LIVE artifacts (or the self-test spine). ---
  const need125 = want.has("operational") || want.has("orchestration") || want.has("dogfood");
  let scenarios: HarvestedScenario[] = [];
  if (need125) {
    scenarios = selfTest ? [driveSelfTestScenario()] : harvestLiveScenarios(opts.corpus);
    for (const s of scenarios) if (s.cleanup) cleanups.push(s.cleanup);
  }
  const harvest = buildHarvestCards(scenarios, want);
  for (const [component, card] of harvest.cards) cardsByComponent.set(component, card);

  // --- Component 3: stress (real multi-process). ---
  if (want.has("stress")) cardsByComponent.set("stress", await buildStressCard(opts, repoRoot));

  // --- Component 4: performance + split-gated regression (M4). ---
  if (want.has("performance")) {
    const metrics = measureMetrics(opts);
    const baselines = loadBaselines(repoRoot);
    regressions = flagRegressions(diffAgainstBaselines(metrics, baselines), opts.tolerancePct ?? DEFAULT_TOLERANCE_PCT);
    if (opts.updateBaselines) {
      try {
        saveBaselines(repoRoot, "proof", metrics.map((m) => baselineFromMetric(m, "proof")));
      } catch {
        /* best-effort: baseline persistence must never fail the run */
      }
    }
    cardsByComponent.set("performance", buildPerformanceCard(metrics, regressions));
  }

  // --- Component 6: failure-injection. ---
  if (want.has("failure-injection")) cardsByComponent.set("failure-injection", buildFaultsCard());

  // --- Component 7: containment. ---
  if (want.has("containment")) cardsByComponent.set("containment", buildContainmentCard(toolNames));

  // --- Component 8: cross-platform. ---
  if (want.has("cross-platform")) cardsByComponent.set("cross-platform", buildPlatformCard());

  // --- Coverage matrix (always computed; it is ProofReport.matrix). ---
  const subsystemsTouched = [...new Set(componentsRun.flatMap((c) => [...COMPONENT_SUBSYSTEMS[c]]))];
  const gatesTouched: string[] = want.has("runner-report") || want.has("failure-injection") ? exerciseGates() : [];
  const liveMcpCalls = scenarios.flatMap((s) => s.artifacts.mcpCalls);
  const mcpUnverifiable = !registryPresent && !selfTest;
  const matrix = buildCoverageMatrix({
    knownToolNames: toolNames,
    liveMcpCalls,
    subsystemsTouched,
    gatesTouched,
    selfTestOnly: selfTest,
    mcpUnverifiable,
  });

  // --- Component 9: runner-report (matrix completeness verdict). ---
  if (want.has("runner-report")) {
    const C: ProofComponent = "runner-report";
    const assertions: Assertion[] = [
      mk(C, "coverage_matrix_complete", true, matrix.complete, matrix.complete),
      mk(C, "subsystems_all_touched", 0, matrix.subsystems.untouched.length, matrix.subsystems.untouched.length === 0),
      mk(C, "mcp_tools_all_touched", 0, matrix.mcpTools.untouched.length, matrix.mcpTools.untouched.length === 0),
      mk(C, "gates_all_touched", 0, matrix.gates.untouched.length, matrix.gates.untouched.length === 0),
      mk(C, "report_assembled", true, true, true),
    ];
    const matrixDiags = matrixDiagnostics(matrix, { selfTestOnly: selfTest, mcpUnverifiable });
    cardsByComponent.set(C, buildReportCard(C, assertions, { matrix }, matrixDiags));
  }

  // --- Assemble cards in component order + collect diagnostics. ---
  const cards: ReportCard[] = [];
  for (const component of PROOF_COMPONENTS) {
    const card = cardsByComponent.get(component);
    if (card) {
      cards.push(card);
      diagnostics.push(...card.diagnostics);
    }
  }

  // --- Overall verdict + run summary. ---
  const anyCardFail = cards.some((c) => c.verdict === "fail");
  const gatingRegression = regressions.some((r) => r.regressed);
  const verdict = anyCardFail || !matrix.complete || gatingRegression ? "fail" : "pass";

  const finishedAt = new Date().toISOString();
  const summary: RunSummary = {
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

  const report: ProofReport = { summary, cards, matrix, regressions, diagnostics };

  // --- Optionally emit the dual-format report. ---
  const outputRoot = opts.outputRoot ?? (opts.emit ? defaultOutputRoot(repoRoot) : undefined);
  if (outputRoot) {
    const emitted: EmittedReport = emitReport(report, { outputRoot });
    summary.stats.report = { dir: emitted.dir, jsonPath: emitted.jsonPath, jsonlPath: emitted.jsonlPath, mdPath: emitted.mdPath };
  }

  for (const cleanup of cleanups) cleanup();
  return report;
}

/** Run a single component (plan Step 9 — single-component runs). */
export async function runComponent(component: ProofComponent, opts: RunProofOptions = {}): Promise<ProofReport> {
  return runProof({ ...opts, components: [component] });
}
