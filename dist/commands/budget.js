"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_BUDGET_TOKENS = exports.TIER_BUDGET_DEFAULTS = exports.BUDGET_K = exports.BUDGET_OVER_PCT = exports.BUDGET_WARN_PCT = exports.BUDGET_W_ARTIFACT = exports.BUDGET_W_TOOL = exports.BUDGET_W_SLICE = exports.BUDGET_W_FILE = exports.BUDGET_BASE = void 0;
exports.kToTokens = kToTokens;
exports.verdictFor = verdictFor;
exports.estimateTokens = estimateTokens;
exports.resolveBudget = resolveBudget;
exports.runBudgetCheck = runBudgetCheck;
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const log_1 = require("../core/log");
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
exports.BUDGET_BASE = 2000;
exports.BUDGET_W_FILE = 1500;
exports.BUDGET_W_SLICE = 3000;
exports.BUDGET_W_TOOL = 500;
exports.BUDGET_W_ARTIFACT = 2000;
/** Verdict bands over pct = est/budget: ok < 0.75 ≤ warn < 1.0 ≤ over. */
exports.BUDGET_WARN_PCT = 0.75;
exports.BUDGET_OVER_PCT = 1.0;
/** "k" multiplier: the CLI --max / --max-tokens flags are given in THOUSANDS. */
exports.BUDGET_K = 1000;
/**
 * Tier-aware default budgets IN TOKENS (Track A-2 step 7). Placeholders chosen so
 * a cheaper tier trips its budget sooner; an explicit --max / persisted max_tokens
 * always overrides. Unclassified (tier null) falls back to the T2 default.
 */
exports.TIER_BUDGET_DEFAULTS = {
    T0: 120_000,
    T1: 120_000,
    T2: 160_000,
    T3: 200_000,
};
/** Fallback when the tier is unclassified (null) or state is absent. */
exports.DEFAULT_BUDGET_TOKENS = exports.TIER_BUDGET_DEFAULTS.T2;
/** Convert a "k" (thousands) flag value to absolute tokens. */
function kToTokens(k) {
    return Math.round(k * exports.BUDGET_K);
}
/** Verdict band for a pct (est/budget). warn at ≥0.75, over at ≥1.0. */
function verdictFor(pct) {
    if (pct >= exports.BUDGET_OVER_PCT)
        return "over";
    if (pct >= exports.BUDGET_WARN_PCT)
        return "warn";
    return "ok";
}
/** Deterministic weighted token estimate from the agent-supplied proxy counts. */
function estimateTokens(counts) {
    const filesRead = nonNegInt(counts.filesRead);
    const slicesBuilt = nonNegInt(counts.slicesBuilt);
    const toolCalls = nonNegInt(counts.toolCalls);
    const artifacts = nonNegInt(counts.artifacts);
    return (exports.BUDGET_BASE +
        exports.BUDGET_W_FILE * filesRead +
        exports.BUDGET_W_SLICE * slicesBuilt +
        exports.BUDGET_W_TOOL * toolCalls +
        exports.BUDGET_W_ARTIFACT * artifacts);
}
function nonNegInt(v) {
    if (v === undefined || !Number.isFinite(v) || v < 0)
        return 0;
    return Math.floor(v);
}
/**
 * Resolve the token budget, in precedence order:
 *   1. explicit --max (in k) → ×1000,
 *   2. persisted state.max_tokens (already absolute tokens),
 *   3. the tier-aware default (state.tier, else the unclassified fallback).
 */
function resolveBudget(opts) {
    const tier = opts.tier ?? null;
    if (opts.maxK !== undefined && Number.isFinite(opts.maxK) && opts.maxK > 0) {
        return { budget: kToTokens(opts.maxK), source: "flag", tier };
    }
    if (opts.stateMaxTokens !== undefined &&
        Number.isFinite(opts.stateMaxTokens) &&
        opts.stateMaxTokens > 0) {
        return { budget: opts.stateMaxTokens, source: "state", tier };
    }
    const budget = tier ? exports.TIER_BUDGET_DEFAULTS[tier] : exports.DEFAULT_BUDGET_TOKENS;
    return { budget, source: "tier-default", tier };
}
/**
 * `th budget check [--max <k>] [--files-read N] [--slices-built N] [--tool-calls N] [--artifacts N]`
 *
 * Read-only + tolerant: it reads state ONLY to source the tier and persisted
 * max_tokens for the default budget — an absent/invalid state still yields a
 * result (tier-default fallback), so the command works in a scratch dir without
 * `th init`.
 */
function runBudgetCheck(paths, opts = {}) {
    const r = (0, state_store_1.readState)(paths);
    const tier = r.state?.tier ?? null;
    const stateMaxTokens = r.state?.max_tokens;
    const estTokens = estimateTokens(opts);
    const { budget, source } = resolveBudget({ maxK: opts.max, stateMaxTokens, tier });
    const pct = budget > 0 ? estTokens / budget : 1;
    const verdict = verdictFor(pct);
    (0, log_1.structuredLog)({ cmd: "budget check", estTokens, budget, pct, verdict, source });
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
    return (0, output_1.success)({
        data: {
            estTokens,
            budget,
            pct,
            verdict,
            source,
            tier,
            weights: {
                base: exports.BUDGET_BASE,
                perFileRead: exports.BUDGET_W_FILE,
                perSliceBuilt: exports.BUDGET_W_SLICE,
                perToolCall: exports.BUDGET_W_TOOL,
                perArtifact: exports.BUDGET_W_ARTIFACT,
            },
            bands: { warn: exports.BUDGET_WARN_PCT, over: exports.BUDGET_OVER_PCT },
        },
        human,
    });
}
