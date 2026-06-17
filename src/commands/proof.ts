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

import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { resolveProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { runProof, runComponent, type ProofToolRegistry } from "../core/proof/runner";
import { defaultOutputRoot } from "../core/proof/report";
import { startScenario, finishScenario, listScenarios } from "../core/proof/scenario";
import { loadCorpus } from "../core/proof/corpus";
import { PROOF_COMPONENTS, type Corpus, type ProofComponent, type ProofReport, type SampleBrief } from "../core/proof/types";

/** Options the CLI / MCP wrappers thread into the proof handlers. */
export interface ProofCommandOptions {
  /** Injected MCP tool registry (R7 — never imported here). Absent → MCP dimension UNVERIFIABLE. */
  registry?: ProofToolRegistry;
  /** Deterministic mechanical-reachability mode (`--self-test`). */
  selfTest?: boolean;
  /** Single component selector: a name (e.g. `stress`) or its 1-based number (`3`). */
  component?: string;
  /** Brief id for `scenario start`. */
  brief?: string;
  /** Override the bundled corpus root (default `<repo>/proof/corpus`). */
  corpusRoot?: string;
  /** Override the report output root (default `<root>/.twinharness/proof`). */
  outputRoot?: string;
  /** The scenario root for `scenario finish` (default the resolved project root). */
  scenarioRoot?: string;
}

/** Default bundled-corpus root: `<repo>/proof/corpus`, resolved relative to this module. */
function defaultCorpusRoot(): string {
  // dist/commands/proof.js → ../../proof/corpus ; src/commands/proof.ts → ../../proof/corpus.
  return path.resolve(__dirname, "..", "..", "proof", "corpus");
}

/** Best-effort corpus load (the corpus is optional for self-test / harvest fallback). */
function tryLoadCorpus(opts: ProofCommandOptions): Corpus | undefined {
  try {
    return loadCorpus(opts.corpusRoot ?? defaultCorpusRoot());
  } catch {
    return undefined;
  }
}

/** Resolve a `--component <name|1-9>` selector to a {@link ProofComponent}. */
function resolveComponent(selector: string | undefined): ProofComponent | undefined {
  if (!selector) return undefined;
  if ((PROOF_COMPONENTS as readonly string[]).includes(selector)) return selector as ProofComponent;
  const n = Number(selector);
  if (Number.isInteger(n) && n >= 1 && n <= PROOF_COMPONENTS.length) return PROOF_COMPONENTS[n - 1];
  return undefined;
}

/** A concise human summary of a finished proof report. */
function summarizeReport(report: ProofReport): string {
  const lines: string[] = [];
  lines.push(`proof run ${report.summary.id} → ${report.summary.verdict.toUpperCase()}`);
  for (const card of report.cards) lines.push(`  ${card.verdict === "pass" ? "✓" : card.verdict === "skip" ? "∼" : "✗"} ${card.component}: ${card.verdict}`);
  lines.push(`  coverage matrix: ${report.matrix.complete ? "complete" : "INCOMPLETE"}`);
  const reportInfo = report.summary.stats.report as { dir?: string } | undefined;
  if (reportInfo?.dir) lines.push(`  report: ${reportInfo.dir}`);
  if (report.diagnostics.length) lines.push(`  diagnostics: ${report.diagnostics.length}`);
  return lines.join("\n");
}

/** Build the CommandResult envelope from a finished report (verdict drives exit code). */
function reportResult(report: ProofReport): CommandResult {
  const data: Record<string, unknown> = {
    verdict: report.summary.verdict,
    matrixComplete: report.matrix.complete,
    cards: report.cards.map((c) => ({ component: c.component, verdict: c.verdict })),
    diagnostics: report.diagnostics,
    summary: report.summary,
  };
  const human = summarizeReport(report);
  return report.summary.verdict === "fail" ? failure({ data, human }) : success({ data, human });
}

/**
 * `th proof run` — run the full operational proof suite (all nine components) and
 * emit the dual-format report. `--self-test` drives the deterministic spine (no LLM).
 */
export async function runProofRun(paths: ProjectPaths, opts: ProofCommandOptions = {}): Promise<CommandResult> {
  const report = await runProof({
    corpus: tryLoadCorpus(opts),
    selfTest: opts.selfTest,
    registry: opts.registry,
    repoRoot: paths.root,
    outputRoot: opts.outputRoot ?? defaultOutputRoot(paths.root),
  });
  return reportResult(report);
}

/**
 * `th proof component <name|1-9>` — run a single component's proof and emit the
 * report. Useful for the per-component slash command / iterative debugging.
 */
export async function runProofComponent(paths: ProjectPaths, opts: ProofCommandOptions = {}): Promise<CommandResult> {
  const component = resolveComponent(opts.component);
  if (!component) {
    return failure({
      human: `unknown proof component: ${opts.component ?? "(none)"}\navailable: ${PROOF_COMPONENTS.map((c, i) => `${i + 1}=${c}`).join(", ")}`,
      data: { error: "unknown_component", component: opts.component ?? null, available: PROOF_COMPONENTS },
    });
  }
  const report = await runComponent(component, {
    corpus: tryLoadCorpus(opts),
    selfTest: opts.selfTest,
    registry: opts.registry,
    repoRoot: paths.root,
    outputRoot: opts.outputRoot ?? defaultOutputRoot(paths.root),
  });
  return reportResult(report);
}

/**
 * `th proof report` — harvest the finished live scenarios and emit the consolidated
 * dual-format report (the final consolidation step of the in-session workflow).
 */
export async function runProofReport(paths: ProjectPaths, opts: ProofCommandOptions = {}): Promise<CommandResult> {
  const report = await runProof({
    corpus: tryLoadCorpus(opts),
    selfTest: false,
    registry: opts.registry,
    repoRoot: paths.root,
    outputRoot: opts.outputRoot ?? defaultOutputRoot(paths.root),
  });
  return reportResult(report);
}

/**
 * `th proof baseline update` — measure the deterministic mechanical perf metrics and
 * persist them as the new gating baselines (PS-Q2). Read-only on the proof corpus.
 */
export async function runProofBaselineUpdate(paths: ProjectPaths, opts: ProofCommandOptions = {}): Promise<CommandResult> {
  const report = await runProof({
    components: ["performance"],
    registry: opts.registry,
    repoRoot: paths.root,
    updateBaselines: true,
  });
  const perf = report.cards.find((c) => c.component === "performance");
  return success({
    data: { updated: true, performance: perf?.stats ?? null },
    human: `baselines updated under ${paths.root} (.twinharness/proof/baselines/proof.json)`,
  });
}

/**
 * `th proof scenario start --brief <id>` — scaffold an isolated scenario sandbox and
 * PRINT its root so the skill can `export CLAUDE_PROJECT_DIR=<scenarioRoot>` (C2).
 */
export function runProofScenarioStart(paths: ProjectPaths, opts: ProofCommandOptions = {}): CommandResult {
  void paths;
  const corpus = tryLoadCorpus(opts);
  if (!corpus) {
    return failure({ human: "could not load the proof corpus; pass --corpus-root or check proof/corpus/index.json", data: { error: "corpus_unavailable" } });
  }
  const brief: SampleBrief | undefined = opts.brief
    ? corpus.briefs.find((b) => b.id === opts.brief)
    : corpus.briefs[0];
  if (!brief) {
    return failure({
      human: `unknown brief: ${opts.brief ?? "(none)"}\navailable: ${corpus.briefs.map((b) => b.id).join(", ")}`,
      data: { error: "unknown_brief", brief: opts.brief ?? null, available: corpus.briefs.map((b) => b.id) },
    });
  }
  const handle = startScenario(brief);
  return success({
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
export function runProofScenarioFinish(paths: ProjectPaths, opts: ProofCommandOptions = {}): CommandResult {
  const scenarioPaths = opts.scenarioRoot ? resolveProjectPaths(opts.scenarioRoot) : paths;
  const scenario = finishScenario(scenarioPaths);
  return success({
    data: { scenario },
    human: `scenario ${scenario.id} (brief ${scenario.briefId || "?"}) → ${scenario.status}`,
  });
}

/** `th proof scenario list` — enumerate the prepared/finished scenario sandboxes. */
export function runProofScenarioList(_paths: ProjectPaths, _opts: ProofCommandOptions = {}): CommandResult {
  void _paths;
  void _opts;
  const scenarios = listScenarios();
  const human = scenarios.length
    ? scenarios.map((s) => `  ${s.id}  brief=${s.briefId || "?"}  tier=${s.tier ?? "?"}  ${s.status}`).join("\n")
    : "(no proof scenarios on disk)";
  return success({ data: { scenarios }, human: `proof scenarios (${scenarios.length}):\n${human}` });
}
