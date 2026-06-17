/**
 * TwinHarness Operational Proof Suite — the versioned domain contract.
 *
 * THE single source of truth for every shared type the `src/core/proof/*`
 * subsystem and `src/commands/proof.ts` use. It is PURE TYPES + CONSTS only: it
 * performs no IO, opens no socket, and imports NOTHING at runtime (every import
 * below is `import type`, fully erased by tsc/esbuild). That keeps `types.ts`
 * importable from any layer with ZERO bundle impact — the harvest contract can be
 * shared by the deterministic engine, the CLI commands, and the (later) MCP tools
 * without dragging mcp-server/cli into the dependency graph.
 *
 * Design tie-back: the entities here mirror the deep-interview Ontology (Proof
 * Run/Scenario, Sample Project Brief, Pipeline Run, Statistics Report,
 * Feature-Coverage Matrix, Baseline, Diagnostic, Assertion/Verdict) and the plan
 * §3/§4 architecture. The harvest contract is VERSIONED ({@link HARVEST_VERSION})
 * so a shape change is detectable across the live-producer / deterministic-engine
 * boundary the suite is built around.
 */

import type { ProjectPaths } from "../paths";
import type { TwinHarnessState, ValidationIssue } from "../state-schema";
import type { RunManifest } from "../../commands/manifest";
import type { LedgerEntry } from "../ledger";
import type { DecisionEvent } from "../decisions";
import type { ActiveLease } from "../leases";
import type { SliceProgress, ArtifactIntegrity } from "../health";

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * The harvest-contract version stamped into every {@link ScenarioArtifacts}. Bump
 * this whenever the harvested shape changes so a stale consumer (engine, golden
 * fixture) can detect the drift instead of silently mis-reading a snapshot.
 */
export const HARVEST_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Component identity (the nine proof components)
// ---------------------------------------------------------------------------

/**
 * The nine proof components, in spec topology order (1..9). Used as the stable
 * `component` discriminator on {@link Assertion}, {@link Diagnostic}, and
 * {@link ReportCard}, and as the matrix subsystem key.
 */
export const PROOF_COMPONENTS = [
  "operational", // 1
  "orchestration", // 2
  "stress", // 3
  "performance", // 4
  "dogfood", // 5
  "failure-injection", // 6
  "containment", // 7
  "cross-platform", // 8
  "runner-report", // 9
] as const;

export type ProofComponent = (typeof PROOF_COMPONENTS)[number];

/** Component → its 1-based topology number (for per-component report cards). */
export const PROOF_COMPONENT_NUMBERS: Record<ProofComponent, number> = {
  operational: 1,
  orchestration: 2,
  stress: 3,
  performance: 4,
  dogfood: 5,
  "failure-injection": 6,
  containment: 7,
  "cross-platform": 8,
  "runner-report": 9,
};

// ---------------------------------------------------------------------------
// Primitive vocabularies
// ---------------------------------------------------------------------------

/** A component / scenario / run pass-fail outcome. `skip` = legitimately not run on this host. */
export type Verdict = "pass" | "fail" | "skip";

/** Diagnostic severity (AI-actionable findings). */
export type Severity = "error" | "warning" | "info";

/** Graduated corpus brief size. */
export type BriefSize = "tiny" | "small" | "medium";

/** Greenfield vs. brownfield (adopting an existing codebase). */
export type ProjectType = "greenfield" | "brownfield";

/** Declared tier hint for a corpus brief (mirrors the state-schema tiers). */
export type TierHint = "T0" | "T1" | "T2" | "T3";

/** Scenario lifecycle status (scenario.ts owns the transitions). */
export type ScenarioStatus = "prepared" | "running" | "finished" | "harvested";

// ---------------------------------------------------------------------------
// Corpus + scenario domain
// ---------------------------------------------------------------------------

/**
 * A bundled graduated synthetic brief (corpus input). `id`/`size`/`tierHint`/
 * `type`/`acceptanceCriteria` come from the brief's `meta.json`; `briefDir` and
 * `seedDir` are ABSOLUTE paths resolved by {@link loadCorpus} (never persisted to
 * meta.json) so a consumer can copy a brownfield seed tree without re-resolving.
 */
export interface SampleBrief {
  id: string;
  size: BriefSize;
  domain: string;
  tierHint: TierHint;
  type: ProjectType;
  /** The brief's declared acceptance criteria (dogfood asserts these were met). */
  acceptanceCriteria: string[];
  /** Absolute path to the brief's corpus directory (set by loadCorpus). */
  briefDir?: string;
  /** Absolute path to the brownfield seed tree, when present (set by loadCorpus). */
  seedDir?: string;
}

/** A loaded corpus: its root dir plus every enumerated brief. */
export interface Corpus {
  root: string;
  briefs: SampleBrief[];
}

/** Result of {@link validateCorpus}: FAILS on a missing tier or no brownfield brief. */
export interface CorpusValidation {
  ok: boolean;
  /** Human-readable reasons the corpus is invalid (empty when ok). */
  issues: string[];
}

/**
 * A prepared/created proof scenario (the lifecycle record scenario.ts manages).
 * `id` is the temp-root basename (e.g. `th-proof-AbC123`). `scenarioRoot` is the
 * OS-temp root OUTSIDE any ancestor `.twinharness` (C2 isolation).
 */
export interface ProofScenario {
  id: string;
  briefId: string;
  tier: TierHint | null;
  type: ProjectType;
  status: ScenarioStatus;
  verdict?: Verdict;
  stats?: Record<string, unknown>;
  scenarioRoot: string;
}

/**
 * The record of one brief's full-pipeline proof run (the spec Ontology
 * "Proof Run / Scenario" entity at run granularity).
 */
export interface ProofRun {
  id: string;
  briefId: string;
  tier: TierHint | null;
  type: ProjectType;
  status: ScenarioStatus;
  verdict: Verdict;
  stats: Record<string, unknown>;
}

/**
 * The handle {@link startScenario} returns: the isolated scenario root the skill
 * must export as `CLAUDE_PROJECT_DIR`, its resolved {@link ProjectPaths}, and the
 * brief it was scaffolded for.
 */
export interface ScenarioHandle {
  scenarioRoot: string;
  scenarioPaths: ProjectPaths;
  brief: SampleBrief;
}

/**
 * On-disk scenario marker (`<stateDir>/proof-scenario.json`) written by
 * {@link startScenario}, advanced by {@link finishScenario}, and enumerated by
 * {@link listScenarios}. Carries the pre-run baseline manifest snapshot.
 */
export interface ScenarioMarker {
  scenario: ProofScenario;
  baselineManifest: RunManifest | null;
  createdAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Harvest contract (the producer→engine boundary)
// ---------------------------------------------------------------------------

/** One producer-side MCP tool call record (dedicated `proof-calls.jsonl`, C1/A1/A2). */
export interface ProofCall {
  tool: string;
  ts: string;
  ok: boolean;
}

/** Read-only summary of recorded `th route` telemetry events. */
export interface RoutingSummary {
  /** Total recorded "route" events. */
  events: number;
  /** Per-model tally across those events (e.g. {opus: 2, sonnet: 3}). */
  models: Record<string, number>;
}

/**
 * The normalized, VERSIONED snapshot {@link harvestScenario} produces from a real
 * scenario run — the single artifact the deterministic engine consumes. Composed
 * ONLY from the existing read/build validators (zero recomputation), and
 * PATH-AGNOSTIC (sourced via `paths.stateDir`), so an `.agentic-sdlc`-seeded
 * brownfield root harvests identically to a `.twinharness` one.
 */
export interface ScenarioArtifacts {
  /** Contract version ({@link HARVEST_VERSION}) this snapshot was produced under. */
  harvestVersion: number;
  /** The brief this scenario ran, when known (null when harvesting a bare root). */
  briefId: string | null;
  /** Absolute scenario root (`paths.root`). */
  scenarioRoot: string;
  /** The resolved state dir (`.twinharness` OR legacy `.agentic-sdlc`). */
  stateDir: string;

  /** Validated `state.json` snapshot, or null when absent/invalid. */
  state: TwinHarnessState | null;
  /** True iff state.json exists AND validates clean. */
  stateValid: boolean;
  /** Validation issues when state.json is present but invalid (empty otherwise). */
  stateIssues: ValidationIssue[];

  /** Deterministic run manifest (buildManifest), or null when state absent/invalid. */
  manifest: RunManifest | null;

  /** `runScorecard(paths,{json:true}).data` — composite run stats; null on failure. */
  scorecard: Record<string, unknown> | null;

  /** Gate ledger entries (`gate-ledger.jsonl`). */
  ledger: LedgerEntry[];
  /** Whether the gate-ledger tamper chain verifies. */
  ledgerChainValid: boolean;

  /** Decision events (`decisions.jsonl`). */
  decisions: DecisionEvent[];
  /** Whether the decision tamper chain verifies. */
  decisionsChainValid: boolean;

  /** Raw local telemetry records (`telemetry.jsonl`). */
  telemetry: object[];
  /** Summary of recorded `th route` events (non-empty once telemetry + routing fire). */
  routing: RoutingSummary;

  /** Currently-held leases (component + sub + section) reduced from the ledger. */
  leases: ActiveLease[];
  /** Leases reconciled against slice state (stale leases dropped). */
  liveLeases: ActiveLease[];

  /** Slice progress derived from state (null when state absent/invalid). */
  sliceProgress: SliceProgress | null;
  /** Approved-artifact integrity (changed/missing governed docs). */
  artifactIntegrity: ArtifactIntegrity[];

  /** Producer-side dedicated MCP call trail (`proof-calls.jsonl`) — the live tool-call set. */
  mcpCalls: ProofCall[];
}

// ---------------------------------------------------------------------------
// Assertions / report cards / diagnostics
// ---------------------------------------------------------------------------

/** One explicit assertion over harvested/mechanical evidence — rolls into a verdict. */
export interface Assertion {
  name: string;
  component: ProofComponent;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

/** An AI-actionable finding emitted on every assertion/regression failure. */
export interface Diagnostic {
  component: ProofComponent;
  /** Where the failure is (file:line, tool name, metric name, subsystem id, …). */
  location: string;
  severity: Severity;
  /** A concrete, actionable next step. */
  hint: string;
}

/** A per-component report card (verdict + assertions + stats + diagnostics). */
export interface ReportCard {
  component: ProofComponent;
  verdict: Verdict;
  assertions: Assertion[];
  stats: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Mechanical sub-proof results (components 3/4/6/7/8)
// ---------------------------------------------------------------------------

/** Component 3 (stress) — real multi-process lock-contention result. */
export interface StressResult {
  name: string;
  /** N concurrent real `node dist/cli.js` writers spawned. */
  writers: number;
  /** Final blocking-count (or equivalent) after contention. */
  finalCount: number;
  /** Distinct ids minted (no collision when === writers). */
  uniqueIds: number;
  /** True iff an update was lost (finalCount < writers). */
  lostUpdates: boolean;
  /** True iff the contention deadlocked / timed out. */
  deadlock: boolean;
  /** Observed wall-clock for the contended batch (bounded-wait evidence). */
  elapsedMs: number;
  pass: boolean;
}

/** Component 3 (stress) — large-repo scanner load result. */
export interface ScannerLoadResult {
  files: number;
  bytes: number;
  ms: number;
  completed: boolean;
  /** Whether the walk finished within the configured time bound. */
  withinBound: boolean;
}

/** Component 6 (failure-injection) — one fault → observed-vs-expected result. */
export interface FaultResult {
  fault: string;
  expected: string;
  observed: string;
  pass: boolean;
  /** Exit code observed when the fault path surfaces one. */
  exitCode?: number;
  /** The gate that blocked, when applicable. */
  gateBlocked?: string;
}

// ---------------------------------------------------------------------------
// Performance + regression (component 4, M4 split gating)
// ---------------------------------------------------------------------------

/** A measured performance metric: numeric series + p50/p95 + gating flag. */
export interface PerfMetric {
  name: string;
  series: number[];
  p50: number;
  p95: number;
  /** Whether a regression on this metric can FAIL the run (M4: mechanical=true, live=false). */
  gating: boolean;
}

/** A stored regression baseline for a single metric. */
export interface Baseline {
  metric: string;
  p50: number;
  p95: number;
  /** ISO-8601 UTC timestamp the baseline was recorded. */
  timestamp: string;
  /** The scenario/corpus the baseline was captured from, when scoped. */
  scenario?: string;
}

/** A computed regression delta of a current metric against its baseline. */
export interface RegressionDelta {
  metric: string;
  baseline: number;
  current: number;
  /** Percentage change vs. baseline (positive = slower/worse). */
  deltaPct: number;
  /** Whether this metric is gating (only gating regressions can fail the run, M4). */
  gating: boolean;
  /** True iff the delta exceeds tolerance AND the metric is gating. */
  regressed: boolean;
}

// ---------------------------------------------------------------------------
// Dogfood case study (component 5)
// ---------------------------------------------------------------------------

/** Outcome statistics captured for a dogfood case study. */
export interface CaseStudyOutcome {
  durationMs: number | null;
  slicesCompleted: number;
  reviseLoopCounts: Record<string, number>;
  driftEntries: number;
  coverage: { total: number; planned: number; implemented: number; tested: number } | null;
  /** Token / cost from harvested telemetry, when telemetry captured them. */
  tokens?: number | null;
  cost?: number | null;
}

/** Component 5 (dogfood) — a narrative case study + outcome stats per brief. */
export interface CaseStudy {
  briefId: string;
  narrative: string;
  outcome: CaseStudyOutcome;
  /** Whether the brief's declared acceptance criteria were satisfied. */
  acceptanceCriteriaMet: boolean;
  /** Whether the run reached "working code". */
  reachedWorkingCode: boolean;
}

// ---------------------------------------------------------------------------
// Coverage matrix (component 9 — the hard gate)
// ---------------------------------------------------------------------------

/** One coverage dimension: known set count + touched/untouched name lists. */
export interface CoverageDimension {
  count: number;
  touched: string[];
  untouched: string[];
}

/**
 * The enforced feature-coverage matrix. `complete` is false (run FAILS) if ANY
 * subsystem / MCP tool / gate is untouched across the corpus. The MCP-tool
 * touched-set derives from the LIVE dedicated `proof-calls.jsonl` trail (C1/A1).
 */
export interface CoverageMatrix {
  subsystems: CoverageDimension;
  mcpTools: CoverageDimension;
  gates: CoverageDimension;
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Top-level report (component 9 — dual-format output)
// ---------------------------------------------------------------------------

/** The run-level summary aggregated across all scenarios in a proof run. */
export interface RunSummary {
  id: string;
  /** ISO-8601 UTC start/finish. */
  startedAt: string;
  finishedAt: string;
  verdict: Verdict;
  /** Every brief exercised in this run. */
  briefIds: string[];
  /** Which components were run (full suite = all nine). */
  componentsRun: ProofComponent[];
  /** Per-brief run records. */
  scenarios: ProofRun[];
  stats: Record<string, unknown>;
  /** Total token cost surfaced for operator budgeting (PS-Q3), when available. */
  tokenCost?: number | null;
}

/**
 * The consolidated dual-format proof report (the spec "Statistics Report"):
 * run summary + per-component cards + enforced coverage matrix + regression
 * deltas + AI-actionable diagnostics.
 */
export interface ProofReport {
  summary: RunSummary;
  cards: ReportCard[];
  matrix: CoverageMatrix;
  regressions: RegressionDelta[];
  diagnostics: Diagnostic[];
}
