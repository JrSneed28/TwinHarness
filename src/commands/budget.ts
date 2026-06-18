import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success } from "../core/output";
import { readState } from "../core/state-store";
import { structuredLog } from "../core/log";
import type { Tier } from "../core/state-schema";

/**
 * `th budget check` — a DETERMINISTIC context-budget estimator (Track A-2).
 *
 * The deterministic-CLI principle (`th` never calls an LLM) means we cannot ask a
 * model how many tokens it has spent. Instead the AGENT supplies proxy COUNTS of
 * the context-consuming work it has done (files read, slices built, tool calls,
 * approved artifacts), and this command applies a fixed weighted formula to
 * estimate the token surface and a verdict band. The math is pure and unit-tested;
 * the inputs are agent-supplied, the OUTPUT is mechanical.
 *
 *   est = BASE + W_FILE*filesRead + W_SLICE*slicesBuilt + W_TOOL*toolCalls + W_ARTIFACT*artifacts
 *
 * Rationale for the named weights (rough averages over real TwinHarness runs;
 * intentionally conservative so the band trips BEFORE a hard compaction):
 *  - BASE (≈2000): the fixed playbook/skill prompt surface that is always resident.
 *  - W_FILE (≈1500): a typical source/doc read pulled into context.
 *  - W_SLICE (≈3000): a built slice drags its task file + summaries + diffs along.
 *  - W_TOOL (≈500): an average tool call's request+result echo.
 *  - W_ARTIFACT (≈2000): an approved artifact's Summary block carried as handoff currency.
 */
export const BUDGET_BASE = 2000;
export const BUDGET_W_FILE = 1500;
export const BUDGET_W_SLICE = 3000;
export const BUDGET_W_TOOL = 500;
export const BUDGET_W_ARTIFACT = 2000;

/** Verdict bands over pct = est/budget: ok < 0.75 ≤ warn < 1.0 ≤ over. */
export const BUDGET_WARN_PCT = 0.75;
export const BUDGET_OVER_PCT = 1.0;

/** "k" multiplier: the CLI --max / --max-tokens flags are given in THOUSANDS. */
export const BUDGET_K = 1000;

/**
 * Tier-aware default budgets IN TOKENS (Track A-2 step 7). Placeholders chosen so
 * a cheaper tier trips its budget sooner; an explicit --max / persisted max_tokens
 * always overrides. Unclassified (tier null) falls back to the T2 default.
 */
export const TIER_BUDGET_DEFAULTS: Record<Tier, number> = {
  T0: 120_000,
  T1: 120_000,
  T2: 160_000,
  T3: 200_000,
};
/** Fallback when the tier is unclassified (null) or state is absent. */
export const DEFAULT_BUDGET_TOKENS = TIER_BUDGET_DEFAULTS.T2;

/** Convert a "k" (thousands) flag value to absolute tokens. */
export function kToTokens(k: number): number {
  return Math.round(k * BUDGET_K);
}

export type BudgetVerdict = "ok" | "warn" | "over";

/** Verdict band for a pct (est/budget). warn at ≥0.75, over at ≥1.0. */
export function verdictFor(pct: number): BudgetVerdict {
  if (pct >= BUDGET_OVER_PCT) return "over";
  if (pct >= BUDGET_WARN_PCT) return "warn";
  return "ok";
}

export interface BudgetCounts {
  filesRead?: number;
  slicesBuilt?: number;
  toolCalls?: number;
  artifacts?: number;
}

/** Deterministic weighted token estimate from the agent-supplied proxy counts. */
export function estimateTokens(counts: BudgetCounts): number {
  const filesRead = nonNegInt(counts.filesRead);
  const slicesBuilt = nonNegInt(counts.slicesBuilt);
  const toolCalls = nonNegInt(counts.toolCalls);
  const artifacts = nonNegInt(counts.artifacts);
  return (
    BUDGET_BASE +
    BUDGET_W_FILE * filesRead +
    BUDGET_W_SLICE * slicesBuilt +
    BUDGET_W_TOOL * toolCalls +
    BUDGET_W_ARTIFACT * artifacts
  );
}

function nonNegInt(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

export interface ResolvedBudget {
  budget: number;
  /** Where the budget came from: an explicit --max, the persisted state value, or the tier default. */
  source: "flag" | "state" | "tier-default";
  tier: Tier | null;
}

/**
 * Resolve the token budget, in precedence order:
 *   1. explicit --max (in k) → ×1000,
 *   2. persisted state.max_tokens (already absolute tokens),
 *   3. the tier-aware default (state.tier, else the unclassified fallback).
 */
export function resolveBudget(opts: {
  maxK?: number;
  stateMaxTokens?: number;
  tier?: Tier | null;
}): ResolvedBudget {
  const tier = opts.tier ?? null;
  if (opts.maxK !== undefined && Number.isFinite(opts.maxK) && opts.maxK > 0) {
    return { budget: kToTokens(opts.maxK), source: "flag", tier };
  }
  if (
    opts.stateMaxTokens !== undefined &&
    Number.isFinite(opts.stateMaxTokens) &&
    opts.stateMaxTokens > 0
  ) {
    return { budget: opts.stateMaxTokens, source: "state", tier };
  }
  const budget = tier ? TIER_BUDGET_DEFAULTS[tier] : DEFAULT_BUDGET_TOKENS;
  return { budget, source: "tier-default", tier };
}

export interface BudgetCheckOptions extends BudgetCounts {
  /** Explicit budget override in THOUSANDS (k). When omitted, falls back to state/tier. */
  max?: number;
}

/**
 * `th budget check [--max <k>] [--files-read N] [--slices-built N] [--tool-calls N] [--artifacts N]`
 *
 * Read-only + tolerant: it reads state ONLY to source the tier and persisted
 * max_tokens for the default budget — an absent/invalid state still yields a
 * result (tier-default fallback), so the command works in a scratch dir without
 * `th init`.
 */
export function runBudgetCheck(paths: ProjectPaths, opts: BudgetCheckOptions = {}): CommandResult {
  const r = readState(paths);
  const tier = r.state?.tier ?? null;
  const stateMaxTokens = r.state?.max_tokens;

  const estTokens = estimateTokens(opts);
  const { budget, source } = resolveBudget({ maxK: opts.max, stateMaxTokens, tier });
  const pct = budget > 0 ? estTokens / budget : 1;
  const verdict = verdictFor(pct);

  structuredLog({ cmd: "budget check", estTokens, budget, pct, verdict, source });

  const human = [
    `Budget check — verdict: ${verdict.toUpperCase()}`,
    `  estimate: ~${estTokens} tokens`,
    `  budget:   ${budget} tokens (${source}${tier ? `, tier ${tier}` : ""})`,
    `  usage:    ${(pct * 100).toFixed(1)}%`,
    verdict === "over"
      ? "  → OVER budget: pause and choose Continue or Fresh (write a handoff + restart fresh)."
      : verdict === "warn"
        ? "  → approaching the budget: consider a handoff before the next wave."
        : "  → within budget.",
  ].join("\n");

  return success({
    data: {
      estTokens,
      budget,
      pct,
      verdict,
      source,
      tier,
      weights: {
        base: BUDGET_BASE,
        perFileRead: BUDGET_W_FILE,
        perSliceBuilt: BUDGET_W_SLICE,
        perToolCall: BUDGET_W_TOOL,
        perArtifact: BUDGET_W_ARTIFACT,
      },
      bands: { warn: BUDGET_WARN_PCT, over: BUDGET_OVER_PCT },
    },
    human,
  });
}
