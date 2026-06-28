/**
 * T2 (S1) — context-capsule unit tests.
 *
 * Coverage (per brief):
 *   - Mandatory safety subset is always present even at micro budget.
 *   - capsule_hash is deterministic (same inputs → same hash; 64-char hex).
 *   - Hard cap < 10K tokens (D-17).
 */

import { describe, it, expect } from "vitest";
import {
  capsuleFromState,
  MICRO_BUDGET_TOKENS,
  HARD_CAP_TOKENS,
  MANDATORY_CAPSULE_FIELDS,
  type Capsule,
} from "../src/core/context-capsule";
import { estimateTokens } from "../src/core/context-telemetry";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_AT = "2026-01-01T00:00:00.000Z";
const BASE_OPTS = { epoch: 1, generatedAt: FIXED_AT };

function makeState(overrides: Partial<TwinHarnessState> = {}): TwinHarnessState {
  return { ...initialState(), ...overrides };
}

/** Produces a state whose full capsule body grossly exceeds any soft budget. */
function bloatedState(): TwinHarnessState {
  return makeState({
    complexity_rationale: "A".repeat(40_000),
    open_questions: Array.from({ length: 200 }, (_, i) => `Q${i}: ${"X".repeat(200)}`),
    slices: Array.from({ length: 60 }, (_, i) => ({
      id: `S${String(i).padStart(2, "0")}`,
      status: "in-progress" as const,
      components: ["api", "db", "ui"],
    })),
    blast_radius_flags: ["authentication", "money"],
    approved_artifacts: Array.from({ length: 10 }, (_, i) => ({
      file: `artifact-${i}.md`,
      version: i + 1,
      hash: "a".repeat(64),
    })),
    drift_open_blocking: 5,
  });
}

// ---------------------------------------------------------------------------
// Mandatory subset — always present regardless of budget
// ---------------------------------------------------------------------------

describe("mandatory safety subset", () => {
  it("standard budget: all mandatory fields are present on the capsule", () => {
    const state = makeState({
      tier: "T2",
      blast_radius_flags: ["authentication"],
      approved_artifacts: [{ file: "spec.md", version: 1, hash: "a".repeat(64) }],
      drift_open_blocking: 2,
    });
    const c = capsuleFromState(state, "T2", "implementation", BASE_OPTS);

    for (const field of MANDATORY_CAPSULE_FIELDS) {
      expect(c[field], `mandatory field "${field}" must be defined`).toBeDefined();
    }
  });

  it("micro budget: mandatory string fields are non-empty strings", () => {
    const state = makeState({
      tier: "T1",
      blast_radius_flags: [],
      drift_open_blocking: 1,
    });
    const c = capsuleFromState(state, "T1", "requirements", { ...BASE_OPTS, budget: "micro" });

    expect(c.tier).toBe("T1");
    expect(c.stage).toBe("requirements");
    expect(c.completion_criteria.length).toBeGreaterThan(0);
    expect(c.capsule_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof c.epoch).toBe("number");
    expect(c.generated_at).toBe(FIXED_AT);
  });

  it("micro budget: mandatory arrays are still arrays (not replaced with overflow string)", () => {
    const state = makeState({
      blast_radius_flags: ["authentication", "money"],
      slices: [{ id: "S01", status: "pending", components: ["api"] }],
    });
    const c = capsuleFromState(state, "T2", "design", { ...BASE_OPTS, budget: "micro" });

    expect(Array.isArray(c.blast_radius_flags)).toBe(true);
    expect(Array.isArray(c.requirement_ids)).toBe(true);
    expect(Array.isArray(c.approved_constraints)).toBe(true);
    expect(Array.isArray(c.open_blocking_drift)).toBe(true);
  });

  it("bloated state + micro budget: mandatory fields survive; narrative may collapse", () => {
    const state = bloatedState();
    const c = capsuleFromState(state, "T3", "implementation", { ...BASE_OPTS, budget: "micro" });

    // Mandatory fields must still hold their actual content.
    expect(c.blast_radius_flags).toContain("authentication");
    expect(c.blast_radius_flags).toContain("money");
    expect(c.tier).toBe("T3");
    expect(c.stage).toBe("implementation");
    expect(c.completion_criteria.length).toBeGreaterThan(0);
    // open_blocking_drift must still report the real count.
    expect(c.open_blocking_drift.some((s) => s.includes("drift_open_blocking=5"))).toBe(true);
    // The objective (narrative) may or may not be collapsed — we only care about mandatory.
    expect(typeof c.objective).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Hard cap < 10K tokens (D-17)
// ---------------------------------------------------------------------------

describe("hard cap D-17", () => {
  it("capsule is always under HARD_CAP_TOKENS even for a bloated state", () => {
    const c = capsuleFromState(bloatedState(), "T3", "implementation", BASE_OPTS);
    const tokens = estimateTokens(JSON.stringify(c));
    expect(tokens).toBeLessThanOrEqual(HARD_CAP_TOKENS);
  });

  it("standard capsule for minimal state is well under cap", () => {
    const c = capsuleFromState(makeState(), "T0", "init", BASE_OPTS);
    const tokens = estimateTokens(JSON.stringify(c));
    expect(tokens).toBeLessThan(HARD_CAP_TOKENS);
  });

  it("micro budget capsule is also under hard cap", () => {
    const c = capsuleFromState(bloatedState(), "T2", "design", { ...BASE_OPTS, budget: "micro" });
    const tokens = estimateTokens(JSON.stringify(c));
    expect(tokens).toBeLessThanOrEqual(HARD_CAP_TOKENS);
  });

  it("HARD_CAP_TOKENS constant is 9999", () => {
    expect(HARD_CAP_TOKENS).toBe(9_999);
  });

  it("MICRO_BUDGET_TOKENS is 1500", () => {
    expect(MICRO_BUDGET_TOKENS).toBe(1_500);
  });
});

// ---------------------------------------------------------------------------
// Deterministic hash
// ---------------------------------------------------------------------------

describe("capsule_hash determinism", () => {
  it("same inputs produce the same capsule_hash", () => {
    const state = makeState({ tier: "T2", drift_open_blocking: 1 });
    const a = capsuleFromState(state, "T2", "implementation", BASE_OPTS);
    const b = capsuleFromState(state, "T2", "implementation", BASE_OPTS);
    expect(a.capsule_hash).toBe(b.capsule_hash);
  });

  it("different tier produces different hash", () => {
    const state = makeState({ tier: "T1" });
    const a = capsuleFromState(state, "T1", "implementation", BASE_OPTS);
    const b = capsuleFromState(state, "T2", "implementation", BASE_OPTS);
    expect(a.capsule_hash).not.toBe(b.capsule_hash);
  });

  it("different stage produces different hash", () => {
    const state = makeState();
    const a = capsuleFromState(state, "T0", "requirements", BASE_OPTS);
    const b = capsuleFromState(state, "T0", "implementation", BASE_OPTS);
    expect(a.capsule_hash).not.toBe(b.capsule_hash);
  });

  it("different epoch produces different hash", () => {
    const state = makeState();
    const a = capsuleFromState(state, "T0", "init", { ...BASE_OPTS, epoch: 1 });
    const b = capsuleFromState(state, "T0", "init", { ...BASE_OPTS, epoch: 2 });
    expect(a.capsule_hash).not.toBe(b.capsule_hash);
  });

  it("different generatedAt produces different hash", () => {
    const state = makeState();
    const a = capsuleFromState(state, "T0", "init", { epoch: 0, generatedAt: "2026-01-01T00:00:00.000Z" });
    const b = capsuleFromState(state, "T0", "init", { epoch: 0, generatedAt: "2026-06-01T00:00:00.000Z" });
    expect(a.capsule_hash).not.toBe(b.capsule_hash);
  });

  it("capsule_hash is 64-char lowercase hex", () => {
    const c = capsuleFromState(makeState(), "T0", "init", BASE_OPTS);
    expect(c.capsule_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same state with bloating produces deterministic hash across two calls", () => {
    const state = bloatedState();
    const a = capsuleFromState(state, "T3", "implementation", BASE_OPTS);
    const b = capsuleFromState(state, "T3", "implementation", BASE_OPTS);
    expect(a.capsule_hash).toBe(b.capsule_hash);
  });
});

// ---------------------------------------------------------------------------
// Budget preset behaviour
// ---------------------------------------------------------------------------

describe("budget presets", () => {
  it("micro budget capsule is <= standard capsule token size for a large state", () => {
    const state = makeState({
      complexity_rationale: "B".repeat(8_000),
      open_questions: Array.from({ length: 80 }, (_, i) => `question-${i}: ${"C".repeat(50)}`),
    });
    const micro = capsuleFromState(state, "T0", "init", { ...BASE_OPTS, budget: "micro" });
    const std = capsuleFromState(state, "T0", "init", { ...BASE_OPTS, budget: "standard" });
    const microTok = estimateTokens(JSON.stringify(micro));
    const stdTok = estimateTokens(JSON.stringify(std));
    expect(microTok).toBeLessThanOrEqual(stdTok);
  });

  it("small state: both budgets return the full capsule (under micro cap)", () => {
    const c = capsuleFromState(makeState(), "T0", "init", { ...BASE_OPTS, budget: "micro" });
    const tokens = estimateTokens(JSON.stringify(c));
    // A minimal state should fit well within micro budget.
    expect(tokens).toBeLessThan(MICRO_BUDGET_TOKENS);
  });
});

// ---------------------------------------------------------------------------
// Field mapping from state
// ---------------------------------------------------------------------------

describe("field mapping from state", () => {
  it("blast_radius_flags mirrors state.blast_radius_flags", () => {
    const state = makeState({ blast_radius_flags: ["authentication", "money"] });
    const c = capsuleFromState(state, "T2", "implementation", BASE_OPTS);
    expect(c.blast_radius_flags).toEqual(["authentication", "money"]);
  });

  it("approved_constraints encodes file:vN:hash12 format", () => {
    const state = makeState({
      approved_artifacts: [{ file: "design.md", version: 2, hash: "b".repeat(64) }],
    });
    const c = capsuleFromState(state, "T1", "design", BASE_OPTS);
    expect(c.approved_constraints).toHaveLength(1);
    expect(c.approved_constraints[0]).toContain("design.md");
    expect(c.approved_constraints[0]).toContain("v2");
    // Only first 12 chars of hash in the ref.
    expect(c.approved_constraints[0]).toContain("b".repeat(12));
  });

  it("open_blocking_drift includes drift_open_blocking when > 0", () => {
    const state = makeState({ drift_open_blocking: 3 });
    const c = capsuleFromState(state, "T1", "design", BASE_OPTS);
    expect(c.open_blocking_drift.some((s) => s.includes("drift_open_blocking=3"))).toBe(true);
  });

  it("open_blocking_drift includes debate_open_blocking when > 0", () => {
    const state = makeState({ drift_open_blocking: 0, debate_open_blocking: 2 });
    const c = capsuleFromState(state, "T1", "design", BASE_OPTS);
    expect(c.open_blocking_drift.some((s) => s.includes("debate_open_blocking=2"))).toBe(true);
  });

  it("open_blocking_drift is empty when both drift counts are 0", () => {
    const state = makeState({ drift_open_blocking: 0 });
    const c = capsuleFromState(state, "T0", "init", BASE_OPTS);
    expect(c.open_blocking_drift).toHaveLength(0);
  });

  it("requirement_ids lists all slice IDs", () => {
    const state = makeState({
      slices: [
        { id: "S01", status: "done", components: ["api"] },
        { id: "S02", status: "pending", components: ["db"] },
      ],
    });
    const c = capsuleFromState(state, "T1", "implementation", BASE_OPTS);
    expect(c.requirement_ids).toContain("S01");
    expect(c.requirement_ids).toContain("S02");
  });

  it("failures_blockers lists blocked slice IDs", () => {
    const state = makeState({
      slices: [
        { id: "S01", status: "blocked", components: ["api"] },
        { id: "S02", status: "done", components: ["db"] },
      ],
    });
    const c = capsuleFromState(state, "T1", "implementation", BASE_OPTS);
    expect(c.failures_blockers).toContain("S01");
    expect(c.failures_blockers).not.toContain("S02");
  });

  it("epoch and generated_at are carried through from opts", () => {
    const c = capsuleFromState(makeState(), "T0", "init", { epoch: 7, generatedAt: FIXED_AT });
    expect(c.epoch).toBe(7);
    expect(c.generated_at).toBe(FIXED_AT);
  });

  it("tier 'unclassified' when state.tier is null", () => {
    const state = makeState({ tier: null });
    const c = capsuleFromState(state, "unclassified", "init", BASE_OPTS);
    expect(c.tier).toBe("unclassified");
  });

  it("completion_criteria mentions blast-radius flags when present", () => {
    const state = makeState({ blast_radius_flags: ["data-integrity"] });
    const c = capsuleFromState(state, "T2", "implementation", BASE_OPTS);
    expect(c.completion_criteria).toContain("data-integrity");
  });
});
