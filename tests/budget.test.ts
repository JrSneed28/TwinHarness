/**
 * Track A-2 — `th budget check` deterministic budget math + verdict bands,
 * tier-aware defaults, and the `--max-tokens` flag parse + state persistence
 * (150 → 150000). The math is mechanical (the deterministic-CLI principle: `th`
 * never calls an LLM; proxy counts are agent-supplied inputs).
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState } from "../src/core/state-store";
import { runStateSet } from "../src/commands/state";
import { parseArgs } from "../src/cli";
import {
  estimateTokens,
  verdictFor,
  resolveBudget,
  kToTokens,
  runBudgetCheck,
  BUDGET_BASE,
  BUDGET_W_FILE,
  BUDGET_W_SLICE,
  BUDGET_W_TOOL,
  BUDGET_W_ARTIFACT,
  BUDGET_WARN_PCT,
  BUDGET_OVER_PCT,
  TIER_BUDGET_DEFAULTS,
  DEFAULT_BUDGET_TOKENS,
} from "../src/commands/budget";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

describe("Track A-2: budget estimate math", () => {
  it("base only when all counts absent", () => {
    expect(estimateTokens({})).toBe(BUDGET_BASE);
  });

  it("applies each documented weight linearly", () => {
    const est = estimateTokens({ filesRead: 10, slicesBuilt: 2, toolCalls: 20, artifacts: 3 });
    expect(est).toBe(
      BUDGET_BASE + BUDGET_W_FILE * 10 + BUDGET_W_SLICE * 2 + BUDGET_W_TOOL * 20 + BUDGET_W_ARTIFACT * 3,
    );
  });

  it("treats negative / non-finite / fractional counts as floored non-negatives", () => {
    expect(estimateTokens({ filesRead: -5 })).toBe(BUDGET_BASE);
    expect(estimateTokens({ filesRead: Number.NaN })).toBe(BUDGET_BASE);
    expect(estimateTokens({ filesRead: 2.9 })).toBe(BUDGET_BASE + BUDGET_W_FILE * 2);
  });
});

describe("Track A-2: verdict bands", () => {
  it("ok below the warn band", () => {
    expect(verdictFor(0)).toBe("ok");
    expect(verdictFor(0.74)).toBe("ok");
  });
  it("warn at >= 0.75 and below 1.0", () => {
    expect(verdictFor(BUDGET_WARN_PCT)).toBe("warn");
    expect(verdictFor(0.75)).toBe("warn");
    expect(verdictFor(0.999)).toBe("warn");
  });
  it("over at >= 1.0", () => {
    expect(verdictFor(BUDGET_OVER_PCT)).toBe("over");
    expect(verdictFor(1)).toBe("over");
    expect(verdictFor(6.4)).toBe("over");
  });
});

describe("Track A-2: kToTokens + budget resolution precedence", () => {
  it("kToTokens multiplies by 1000", () => {
    expect(kToTokens(150)).toBe(150000);
    expect(kToTokens(0.5)).toBe(500);
  });

  it("explicit --max (k) wins over state and tier", () => {
    const r = resolveBudget({ maxK: 150, stateMaxTokens: 99000, tier: "T3" });
    expect(r).toEqual({ budget: 150000, source: "flag", tier: "T3" });
  });

  it("persisted state.max_tokens wins over the tier default", () => {
    const r = resolveBudget({ stateMaxTokens: 99000, tier: "T3" });
    expect(r).toEqual({ budget: 99000, source: "state", tier: "T3" });
  });

  it("tier default applies when neither flag nor state is present", () => {
    expect(resolveBudget({ tier: "T0" }).budget).toBe(TIER_BUDGET_DEFAULTS.T0);
    expect(resolveBudget({ tier: "T1" }).budget).toBe(TIER_BUDGET_DEFAULTS.T1);
    expect(resolveBudget({ tier: "T2" }).budget).toBe(TIER_BUDGET_DEFAULTS.T2);
    expect(resolveBudget({ tier: "T3" }).budget).toBe(TIER_BUDGET_DEFAULTS.T3);
    expect(resolveBudget({ tier: "T2" }).source).toBe("tier-default");
  });

  it("unclassified tier falls back to the default budget", () => {
    expect(resolveBudget({ tier: null }).budget).toBe(DEFAULT_BUDGET_TOKENS);
    expect(resolveBudget({}).budget).toBe(DEFAULT_BUDGET_TOKENS);
  });

  it("tier defaults: cheaper tier trips sooner (T0/T1 < T2 < T3)", () => {
    expect(TIER_BUDGET_DEFAULTS.T0).toBe(120000);
    expect(TIER_BUDGET_DEFAULTS.T1).toBe(120000);
    expect(TIER_BUDGET_DEFAULTS.T2).toBe(160000);
    expect(TIER_BUDGET_DEFAULTS.T3).toBe(200000);
  });
});

describe("Track A-2: runBudgetCheck", () => {
  it("works without state.json (scratch dir) using --max + counts", () => {
    tp = makeTempProject();
    const res = runBudgetCheck(tp.paths, { max: 150, filesRead: 10, toolCalls: 20 });
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.estTokens).toBe(BUDGET_BASE + BUDGET_W_FILE * 10 + BUDGET_W_TOOL * 20);
    expect(d.budget).toBe(150000);
    expect(d.source).toBe("flag");
    expect(d.verdict).toBe("ok");
  });

  it("reports the over verdict when the estimate exceeds the budget", () => {
    tp = makeTempProject();
    const res = runBudgetCheck(tp.paths, { max: 5, filesRead: 10, slicesBuilt: 5 });
    const d = res.data as Record<string, unknown>;
    expect(d.verdict).toBe("over");
    expect(d.pct as number).toBeGreaterThanOrEqual(1);
  });

  it("sources the tier default from state when --max omitted", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T3");
    const res = runBudgetCheck(tp.paths, { filesRead: 1 });
    const d = res.data as Record<string, unknown>;
    expect(d.budget).toBe(TIER_BUDGET_DEFAULTS.T3);
    expect(d.source).toBe("tier-default");
    expect(d.tier).toBe("T3");
  });

  it("sources the persisted state.max_tokens over the tier default", () => {
    tp = makeTempProject();
    runInit(tp.paths, { maxTokens: 150 });
    runStateSet(tp.paths, "tier", "T3");
    const res = runBudgetCheck(tp.paths, { filesRead: 1 });
    const d = res.data as Record<string, unknown>;
    expect(d.budget).toBe(150000);
    expect(d.source).toBe("state");
  });
});

describe("Track A-2: --max-tokens flag parse + state persistence", () => {
  it("parser yields the RAW number (no ×1000 in the parser)", () => {
    const parsed = parseArgs(["init", "--max-tokens", "150"]);
    expect(parsed.flags.maxTokens).toBe(150);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.unknownFlags).toHaveLength(0);
  });

  it("rejects a non-numeric --max-tokens", () => {
    const parsed = parseArgs(["init", "--max-tokens", "abc"]);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("`th init --max-tokens 150` persists max_tokens = 150000 (×1000 at the write site)", () => {
    tp = makeTempProject();
    runInit(tp.paths, { maxTokens: 150 });
    const r = readState(tp.paths);
    expect(r.state?.max_tokens).toBe(150000);
  });

  it("max_tokens survives a re-read (persists across resume)", () => {
    tp = makeTempProject();
    runInit(tp.paths, { maxTokens: 200 });
    // A second non-force init must not clobber it.
    runInit(tp.paths, {});
    const r = readState(tp.paths);
    expect(r.state?.max_tokens).toBe(200000);
  });

  it("a later --max-tokens updates the persisted budget without --force", () => {
    tp = makeTempProject();
    runInit(tp.paths, { maxTokens: 150 });
    runInit(tp.paths, { maxTokens: 250 });
    const r = readState(tp.paths);
    expect(r.state?.max_tokens).toBe(250000);
  });
});
