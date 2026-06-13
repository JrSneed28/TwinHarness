/**
 * Pure live-wave computation + dependency-graph validation (core/wave.ts).
 */

import { describe, it, expect } from "vitest";
import { computeWave, validateDeps, hasDepIssues } from "../src/core/wave";
import type { SliceState } from "../src/core/state-schema";

function slice(id: string, status: SliceState["status"], components: string[] = [], depends_on?: string[]): SliceState {
  return depends_on ? { id, status, components, depends_on } : { id, status, components };
}

describe("REQ-WAVE-001: computeWave dispatches disjoint pending slices, holds conflicts", () => {
  it("a slice never blocks itself via its own occupied component", () => {
    const slices = [slice("SLICE-1", "pending", ["api"])];
    const occupied = new Map([["api", "SLICE-1"]]); // owned by itself
    const plan = computeWave(slices, occupied, false);
    expect(plan.wave).toEqual(["SLICE-1"]);
    expect(plan.stalled).toBe(false);
  });

  it("a component owned by a DIFFERENT slice holds the candidate", () => {
    const slices = [slice("SLICE-2", "pending", ["api"])];
    const occupied = new Map([["api", "SLICE-1"]]);
    const plan = computeWave(slices, occupied, true);
    expect(plan.wave).toEqual([]);
    expect(plan.held[0]).toMatchObject({ id: "SLICE-2", reason: "component-conflict" });
    expect(plan.stalled).toBe(false); // something in progress may free it
  });

  it("unmet depends_on holds as a dependency", () => {
    const slices = [slice("SLICE-1", "pending", ["x"]), slice("SLICE-2", "pending", ["y"], ["SLICE-1"])];
    const plan = computeWave(slices, new Map(), false);
    expect(plan.wave).toEqual(["SLICE-1"]);
    expect(plan.held.find((h) => h.id === "SLICE-2")?.reason).toBe("dependency");
  });
});

describe("REQ-WAVE-002: stalled is true only when nothing can progress", () => {
  it("pending slice blocked by a never-finishing dep + nothing in progress → stalled", () => {
    const slices = [slice("SLICE-1", "blocked", ["x"]), slice("SLICE-2", "pending", ["y"], ["SLICE-1"])];
    const plan = computeWave(slices, new Map(), false);
    expect(plan.wave).toEqual([]);
    expect(plan.stalled).toBe(true);
  });

  it("same blockage but a slice is in progress → not stalled (waiting)", () => {
    const slices = [slice("SLICE-1", "in-progress", ["x"]), slice("SLICE-2", "pending", ["y"], ["SLICE-1"])];
    const plan = computeWave(slices, new Map([["x", "SLICE-1"]]), true);
    expect(plan.stalled).toBe(false);
  });
});

describe("REQ-WAVE-003: validateDeps detects cycles and dangling references", () => {
  it("a two-node cycle is reported", () => {
    const slices = [slice("SLICE-1", "pending", [], ["SLICE-2"]), slice("SLICE-2", "pending", [], ["SLICE-1"])];
    const deps = validateDeps(slices);
    expect(deps.cycles.length).toBeGreaterThan(0);
    expect(hasDepIssues(deps)).toBe(true);
  });

  it("a dangling reference to an unknown slice is reported", () => {
    const slices = [slice("SLICE-1", "pending", [], ["SLICE-99"])];
    const deps = validateDeps(slices);
    expect(deps.dangling).toEqual([{ slice: "SLICE-1", missing: ["SLICE-99"] }]);
  });

  it("a clean acyclic graph has no issues", () => {
    const slices = [slice("SLICE-1", "done", []), slice("SLICE-2", "pending", [], ["SLICE-1"])];
    expect(hasDepIssues(validateDeps(slices))).toBe(false);
  });
});
