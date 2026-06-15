/**
 * Soft-dependency speculative dispatch (core/wave.ts) — Phase 7 Slice 11.
 *
 * `depends_on_soft` lists INTERFACE-only (soft) dependencies: slices whose
 * contract a candidate builds against but which need NOT be `done` first. A
 * candidate may be dispatched SPECULATIVELY once its HARD `depends_on` are done
 * even while a soft upstream is still pending; a bad speculation is caught by the
 * merge-conflict-as-BLOCKING-drift backstop. HARD deps still gate as today.
 */

import { describe, it, expect } from "vitest";
import { computeWave } from "../src/core/wave";
import type { SliceState } from "../src/core/state-schema";

function slice(
  id: string,
  status: SliceState["status"],
  components: string[] = [],
  depends_on?: string[],
  depends_on_soft?: string[],
): SliceState {
  const s: SliceState = { id, status, components };
  if (depends_on) s.depends_on = depends_on;
  if (depends_on_soft) s.depends_on_soft = depends_on_soft;
  return s;
}

describe("REQ-PCO-070: soft-dependency speculative dispatch", () => {
  it("REQ-PCO-070: a slice whose only unmet dep is a pending depends_on_soft IS dispatched speculatively", () => {
    const slices = [
      slice("SLICE-1", "pending", ["api"]),
      slice("SLICE-2", "pending", ["ui"], undefined, ["SLICE-1"]),
    ];
    const plan = computeWave(slices, new Map(), false);
    // SLICE-2 dispatches even though its soft upstream SLICE-1 is still pending.
    expect(plan.wave).toContain("SLICE-2");
    expect(plan.held.find((h) => h.id === "SLICE-2")).toBeUndefined();
    expect(plan.stalled).toBe(false);
  });

  it("REQ-PCO-070: speculative dispatch holds when a HARD depends_on is unmet, even if soft deps are present", () => {
    const slices = [
      slice("SLICE-1", "pending", ["api"]),
      slice("SLICE-2", "done", ["contract"]),
      // HARD dep on still-pending SLICE-1; soft dep on already-done SLICE-2.
      slice("SLICE-3", "pending", ["ui"], ["SLICE-1"], ["SLICE-2"]),
    ];
    const plan = computeWave(slices, new Map(), false);
    expect(plan.wave).not.toContain("SLICE-3");
    const held = plan.held.find((h) => h.id === "SLICE-3");
    expect(held?.reason).toBe("dependency");
    expect(held?.detail).toEqual(["SLICE-1"]);
  });

  it("REQ-PCO-070: a slice with a met HARD dep AND a pending soft dep still dispatches", () => {
    const slices = [
      slice("SLICE-1", "done", ["api"]),
      slice("SLICE-2", "pending", ["contract"]),
      // HARD dep done, soft dep still pending → speculative dispatch allowed.
      slice("SLICE-3", "pending", ["ui"], ["SLICE-1"], ["SLICE-2"]),
    ];
    const plan = computeWave(slices, new Map(), false);
    expect(plan.wave).toContain("SLICE-3");
    expect(plan.held.find((h) => h.id === "SLICE-3")).toBeUndefined();
  });

  it("REQ-PCO-070: soft deps remain subject to the component-conflict guard (unchanged guards)", () => {
    const slices = [
      slice("SLICE-1", "pending", ["api"]),
      // Soft dep on SLICE-1, but its component is owned by another in-progress slice.
      slice("SLICE-2", "pending", ["api"], undefined, ["SLICE-1"]),
    ];
    const occupied = new Map([["api", "SLICE-OTHER"]]);
    const plan = computeWave(slices, occupied, true);
    const held = plan.held.find((h) => h.id === "SLICE-2");
    expect(held?.reason).toBe("component-conflict");
    expect(plan.wave).not.toContain("SLICE-2");
  });

  it("REQ-PCO-070: absence of depends_on_soft leaves behavior unchanged (backward compat)", () => {
    // Identical to the classic REQ-WAVE-001 unmet-hard-dep case: no soft deps anywhere.
    const slices = [
      slice("SLICE-1", "pending", ["x"]),
      slice("SLICE-2", "pending", ["y"], ["SLICE-1"]),
    ];
    const plan = computeWave(slices, new Map(), false);
    expect(plan.wave).toEqual(["SLICE-1"]);
    expect(plan.held.find((h) => h.id === "SLICE-2")?.reason).toBe("dependency");
    expect(plan.stalled).toBe(false);
  });
});
