/**
 * context-equivalence.ts — S7 equivalence harness (D-21 / AC-11).
 *
 * Tiered comparator over 7 dimensions:
 *   tests | types | build | gate+approval | requirement-coverage |
 *   side-effects | blast-radius
 *
 * `runEquivalence(baselineRun, contextRun): EquivalenceVerdict` — pure
 * comparison; reads run artifacts, produces a verdict. No suppression
 * side-effects; NO surface-file edits (T8 wires the CLI/MCP ops).
 *
 * Corpus structure: `.twinharness/context-pages/corpus/<category>/` tagged
 * by the 5 workload categories (D-21).
 *
 * Promotion gate: `isPromotionReady(verdicts): boolean` — true after
 * N = PROMOTION_CLEAN_RUNS consecutive zero-divergence verdicts (AC-11).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { contextPagesRoot } from "./context-page";
import type { ProjectPaths } from "./paths";

// ---------------------------------------------------------------------------
// WorkloadCategory — 5 categories (D-21)
// ---------------------------------------------------------------------------

/**
 * The 5 workload categories used to tag corpus entries (D-21 / D-20
 * `workload_category` field).
 *
 *   read      — file-read heavy sessions (Read / Grep / Glob dominated)
 *   bash      — shell-execution heavy sessions (Bash / tool output)
 *   test      — test-runner output and assertion heavy
 *   mcp       — MCP tool call heavy
 *   planning  — session-level capsule + manifest + approval workload
 */
export type WorkloadCategory = "read" | "bash" | "test" | "mcp" | "planning";

export const WORKLOAD_CATEGORIES: WorkloadCategory[] = [
  "read",
  "bash",
  "test",
  "mcp",
  "planning",
];

// ---------------------------------------------------------------------------
// Equivalence dimensions (AC-11)
// ---------------------------------------------------------------------------

/** The 7 dimensions compared by the equivalence harness. */
export type EquivalenceDimension =
  | "tests"
  | "types"
  | "build"
  | "gate+approval"
  | "requirement-coverage"
  | "side-effects"
  | "blast-radius";

export const EQUIVALENCE_DIMENSIONS: EquivalenceDimension[] = [
  "tests",
  "types",
  "build",
  "gate+approval",
  "requirement-coverage",
  "side-effects",
  "blast-radius",
];

// ---------------------------------------------------------------------------
// Run artifact schema
// ---------------------------------------------------------------------------

export interface TestOutcome {
  passed: number;
  failed: number;
  skipped: number;
  /** Names of failed tests, sorted (for stable comparison). */
  failedNames?: string[];
}

export interface TypecheckOutcome {
  errorCount: number;
  /** Sample of errors for reporting — not used for equality (errorCount is). */
  errors?: Array<{ file: string; message: string }>;
}

export interface BuildOutcome {
  success: boolean;
  /** Canonical hash per output artifact (relative path → SHA-256 hex). */
  artifactHashes?: Record<string, string>;
}

export interface GateOutcome {
  /** IDs of gates that passed, sorted. */
  gatesPassed: string[];
  /** IDs of gates that failed, sorted. */
  gatesFailed: string[];
  /** IDs of approvals granted, sorted. */
  approvalsGranted: string[];
}

export interface RequirementCoverageOutcome {
  /** Requirement IDs confirmed covered, sorted. */
  covered: string[];
  /** Requirement IDs not yet covered, sorted. */
  uncovered: string[];
}

export interface SideEffectRecord {
  kind: string;
  description: string;
}

export interface BlastRadiusOutcome {
  /** Blast-radius flags raised, sorted. */
  flags: string[];
  /** POSIX-relative affected paths, sorted. */
  affectedPaths: string[];
}

export interface TokenUsage {
  origTokens: number;
  returnedTokens: number;
}

/**
 * Observable outcomes of one session run.  All dimension fields are optional;
 * a missing dimension is treated as "not measured" (not diverged).
 */
export interface RunArtifact {
  session_id: string;
  workload_category: WorkloadCategory;
  /** ISO 8601 timestamp for ordering in the corpus. */
  ts: string;
  test?: TestOutcome;
  types?: TypecheckOutcome;
  build?: BuildOutcome;
  gate?: GateOutcome;
  requirements?: RequirementCoverageOutcome;
  side_effects?: SideEffectRecord[];
  blast_radius?: BlastRadiusOutcome;
  token_usage?: TokenUsage;
}

// ---------------------------------------------------------------------------
// Verdict types
// ---------------------------------------------------------------------------

export interface DimensionResult {
  dimension: EquivalenceDimension;
  /** True when the dimension diverged between baseline and context run. */
  diverged: boolean;
  reason?: string;
}

export interface ReductionReport {
  baselineOrigTokens: number;
  contextOrigTokens: number;
  baselineReturnedTokens: number;
  contextReturnedTokens: number;
  savedTokens: number;
  savingsPercent: number;
}

export interface EquivalenceVerdict {
  /** True iff ALL 7 dimensions show zero divergence. */
  clean: boolean;
  dimensions: DimensionResult[];
  /** Token reduction reported when token_usage is present on both runs. */
  reduction?: ReductionReport;
  ts: string;
}

// ---------------------------------------------------------------------------
// Promotion gate
// ---------------------------------------------------------------------------

/** Number of consecutive zero-divergence runs required to promote. */
export const PROMOTION_CLEAN_RUNS = 10;

/**
 * Returns true when the supplied list of verdicts contains at least
 * PROMOTION_CLEAN_RUNS consecutive clean verdicts at the tail.
 * Pure; no I/O.
 */
export function isPromotionReady(verdicts: EquivalenceVerdict[]): boolean {
  if (verdicts.length < PROMOTION_CLEAN_RUNS) return false;
  const tail = verdicts.slice(-PROMOTION_CLEAN_RUNS);
  return tail.every((v) => v.clean);
}

// ---------------------------------------------------------------------------
// Corpus helpers
// ---------------------------------------------------------------------------

/**
 * Absolute path for the corpus root under the context-pages tree.
 *   .twinharness/context-pages/corpus/
 */
export function corpusRoot(paths: ProjectPaths): string {
  return path.join(contextPagesRoot(paths), "corpus");
}

/**
 * Absolute path for the corpus sub-directory of a workload category.
 *   .twinharness/context-pages/corpus/<category>/
 */
export function corpusCategoryDir(paths: ProjectPaths, category: WorkloadCategory): string {
  return path.join(corpusRoot(paths), category);
}

/**
 * Persist a RunArtifact to the corpus.  File name: `<session_id>.json`.
 * Creates directories as needed.  Never throws (returns false on error).
 */
export function writeCorpusEntry(paths: ProjectPaths, artifact: RunArtifact): boolean {
  try {
    const dir = corpusCategoryDir(paths, artifact.workload_category);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${artifact.session_id}.json`);
    fs.writeFileSync(file, JSON.stringify(artifact, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a RunArtifact from the corpus by session ID and category.
 * Returns undefined on any error or when absent.
 */
export function readCorpusEntry(
  paths: ProjectPaths,
  category: WorkloadCategory,
  sessionId: string,
): RunArtifact | undefined {
  try {
    const file = path.join(corpusCategoryDir(paths, category), `${sessionId}.json`);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as RunArtifact;
  } catch {
    return undefined;
  }
}

/**
 * List all run artifacts for a category, sorted by ts ascending.
 * Returns [] on any error.
 */
export function listCorpusEntries(
  paths: ProjectPaths,
  category: WorkloadCategory,
): RunArtifact[] {
  try {
    const dir = corpusCategoryDir(paths, category);
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const entries: RunArtifact[] = [];
    for (const f of files) {
      try {
        const entry = JSON.parse(
          fs.readFileSync(path.join(dir, f), "utf8"),
        ) as RunArtifact;
        entries.push(entry);
      } catch {
        // skip malformed entries
      }
    }
    return entries.sort((a, b) => a.ts.localeCompare(b.ts));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-dimension comparison logic (pure)
// ---------------------------------------------------------------------------

function compareTests(
  baseline: RunArtifact,
  context: RunArtifact,
): DimensionResult {
  const dim: EquivalenceDimension = "tests";
  const b = baseline.test;
  const c = context.test;

  if (b === undefined && c === undefined) return { dimension: dim, diverged: false };
  if (b === undefined || c === undefined) {
    return { dimension: dim, diverged: true, reason: "one run missing test outcome" };
  }

  if (b.passed !== c.passed || b.failed !== c.failed || b.skipped !== c.skipped) {
    return {
      dimension: dim,
      diverged: true,
      reason: `counts differ: baseline(p=${b.passed},f=${b.failed},s=${b.skipped}) ctx(p=${c.passed},f=${c.failed},s=${c.skipped})`,
    };
  }

  // Compare failed test names when available
  const bNames = [...(b.failedNames ?? [])].sort().join("|");
  const cNames = [...(c.failedNames ?? [])].sort().join("|");
  if (bNames !== cNames) {
    return { dimension: dim, diverged: true, reason: "failed test names differ" };
  }

  return { dimension: dim, diverged: false };
}

function compareTypes(
  baseline: RunArtifact,
  context: RunArtifact,
): DimensionResult {
  const dim: EquivalenceDimension = "types";
  const b = baseline.types;
  const c = context.types;

  if (b === undefined && c === undefined) return { dimension: dim, diverged: false };
  if (b === undefined || c === undefined) {
    return { dimension: dim, diverged: true, reason: "one run missing types outcome" };
  }

  if (b.errorCount !== c.errorCount) {
    return {
      dimension: dim,
      diverged: true,
      reason: `errorCount differs: baseline=${b.errorCount} ctx=${c.errorCount}`,
    };
  }

  return { dimension: dim, diverged: false };
}

function compareBuild(
  baseline: RunArtifact,
  context: RunArtifact,
): DimensionResult {
  const dim: EquivalenceDimension = "build";
  const b = baseline.build;
  const c = context.build;

  if (b === undefined && c === undefined) return { dimension: dim, diverged: false };
  if (b === undefined || c === undefined) {
    return { dimension: dim, diverged: true, reason: "one run missing build outcome" };
  }

  if (b.success !== c.success) {
    return {
      dimension: dim,
      diverged: true,
      reason: `success differs: baseline=${b.success} ctx=${c.success}`,
    };
  }

  // Compare artifact hashes when both provide them
  if (b.artifactHashes !== undefined && c.artifactHashes !== undefined) {
    const bSig = JSON.stringify(sortedRecord(b.artifactHashes));
    const cSig = JSON.stringify(sortedRecord(c.artifactHashes));
    if (bSig !== cSig) {
      return { dimension: dim, diverged: true, reason: "artifact hashes differ" };
    }
  }

  return { dimension: dim, diverged: false };
}

function compareGate(
  baseline: RunArtifact,
  context: RunArtifact,
): DimensionResult {
  const dim: EquivalenceDimension = "gate+approval";
  const b = baseline.gate;
  const c = context.gate;

  if (b === undefined && c === undefined) return { dimension: dim, diverged: false };
  if (b === undefined || c === undefined) {
    return { dimension: dim, diverged: true, reason: "one run missing gate outcome" };
  }

  const bSig = sortedSig(b.gatesPassed, b.gatesFailed, b.approvalsGranted);
  const cSig = sortedSig(c.gatesPassed, c.gatesFailed, c.approvalsGranted);
  if (bSig !== cSig) {
    return { dimension: dim, diverged: true, reason: "gate/approval state differs" };
  }

  return { dimension: dim, diverged: false };
}

function compareRequirements(
  baseline: RunArtifact,
  context: RunArtifact,
): DimensionResult {
  const dim: EquivalenceDimension = "requirement-coverage";
  const b = baseline.requirements;
  const c = context.requirements;

  if (b === undefined && c === undefined) return { dimension: dim, diverged: false };
  if (b === undefined || c === undefined) {
    return { dimension: dim, diverged: true, reason: "one run missing requirement coverage" };
  }

  const bCov = [...b.covered].sort().join(",");
  const cCov = [...c.covered].sort().join(",");
  if (bCov !== cCov) {
    return { dimension: dim, diverged: true, reason: "covered requirements differ" };
  }

  return { dimension: dim, diverged: false };
}

function compareSideEffects(
  baseline: RunArtifact,
  context: RunArtifact,
): DimensionResult {
  const dim: EquivalenceDimension = "side-effects";
  const b = baseline.side_effects;
  const c = context.side_effects;

  if ((b === undefined || b.length === 0) && (c === undefined || c.length === 0)) {
    return { dimension: dim, diverged: false };
  }
  if (b === undefined || c === undefined) {
    return { dimension: dim, diverged: true, reason: "one run missing side-effects" };
  }

  const bSig = b.map((e) => `${e.kind}:${e.description}`).sort().join("|");
  const cSig = c.map((e) => `${e.kind}:${e.description}`).sort().join("|");
  if (bSig !== cSig) {
    return { dimension: dim, diverged: true, reason: "side-effects differ" };
  }

  return { dimension: dim, diverged: false };
}

function compareBlastRadius(
  baseline: RunArtifact,
  context: RunArtifact,
): DimensionResult {
  const dim: EquivalenceDimension = "blast-radius";
  const b = baseline.blast_radius;
  const c = context.blast_radius;

  if (b === undefined && c === undefined) return { dimension: dim, diverged: false };
  if (b === undefined || c === undefined) {
    return { dimension: dim, diverged: true, reason: "one run missing blast-radius" };
  }

  const bSig = [...b.flags].sort().join(",") + "|" + [...b.affectedPaths].sort().join(",");
  const cSig = [...c.flags].sort().join(",") + "|" + [...c.affectedPaths].sort().join(",");
  if (bSig !== cSig) {
    return { dimension: dim, diverged: true, reason: "blast-radius differs" };
  }

  return { dimension: dim, diverged: false };
}

// ---------------------------------------------------------------------------
// Reduction report helper
// ---------------------------------------------------------------------------

function computeReduction(
  baseline: RunArtifact,
  context: RunArtifact,
): ReductionReport | undefined {
  const b = baseline.token_usage;
  const c = context.token_usage;
  if (b === undefined || c === undefined) return undefined;

  const savedTokens = b.returnedTokens - c.returnedTokens;
  const savingsPercent = b.returnedTokens > 0
    ? Math.round((savedTokens / b.returnedTokens) * 1000) / 10
    : 0;

  return {
    baselineOrigTokens: b.origTokens,
    contextOrigTokens: c.origTokens,
    baselineReturnedTokens: b.returnedTokens,
    contextReturnedTokens: c.returnedTokens,
    savedTokens,
    savingsPercent,
  };
}

// ---------------------------------------------------------------------------
// Pure utility helpers
// ---------------------------------------------------------------------------

function sortedRecord(r: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(r).sort()) out[k] = r[k]!;
  return out;
}

function sortedSig(...arrays: string[][]): string {
  return arrays.map((a) => [...a].sort().join(",")).join("|");
}

// ---------------------------------------------------------------------------
// runEquivalence — main entry point (AC-11)
// ---------------------------------------------------------------------------

/**
 * Pure tiered comparator over 7 dimensions.
 *
 * `baselineRun` — the run with the context-pages mechanism OFF (shadow).
 * `contextRun`  — the run with the context-pages mechanism OBSERVE+recording.
 *
 * Returns a verdict that is clean only when ALL dimensions show zero
 * divergence (AC-11).  Token reduction is reported when both runs supply
 * `token_usage`.  Never throws.
 */
export function runEquivalence(
  baselineRun: RunArtifact,
  contextRun: RunArtifact,
): EquivalenceVerdict {
  try {
    const dimensions: DimensionResult[] = [
      compareTests(baselineRun, contextRun),
      compareTypes(baselineRun, contextRun),
      compareBuild(baselineRun, contextRun),
      compareGate(baselineRun, contextRun),
      compareRequirements(baselineRun, contextRun),
      compareSideEffects(baselineRun, contextRun),
      compareBlastRadius(baselineRun, contextRun),
    ];

    const clean = dimensions.every((d) => !d.diverged);
    const reduction = computeReduction(baselineRun, contextRun);

    return { clean, dimensions, reduction, ts: new Date().toISOString() };
  } catch {
    // Fail-safe: return diverged verdict rather than throw
    return {
      clean: false,
      dimensions: EQUIVALENCE_DIMENSIONS.map((dim) => ({
        dimension: dim,
        diverged: true,
        reason: "equivalence check error",
      })),
      ts: new Date().toISOString(),
    };
  }
}
