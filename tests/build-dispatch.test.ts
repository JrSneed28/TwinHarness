/**
 * `th build dispatch` — single-payload parallel-dispatch oracle (REQ-PCO-001).
 *
 * Where `th build next-wave` emits the dispatchable slice IDs, `dispatch` emits
 * the FULL spawn set in ONE payload (per-slice spawn descriptors with a
 * recommended {model, effort}) so the Orchestrator can launch every wave Builder
 * in a single message. These tests assert it surfaces ≥2 disjoint pending slices
 * as descriptors carrying their sliceId + components, reusing the same live-wave
 * computation as next-wave. Mirrors the fixture pattern in build-coordination.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runBuildDispatch, type DispatchDescriptor } from "../src/commands/build";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function setSlices(t: TempProject, slices: unknown[]): void {
  runStateSet(t.paths, "slices", JSON.stringify(slices));
}

describe("REQ-PCO-001: build dispatch emits the full parallel wave as spawn descriptors", () => {
  it("two disjoint pending slices dispatch together, each with sliceId + components", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [
      { id: "SLICE-1", status: "pending", components: ["api"] },
      { id: "SLICE-2", status: "pending", components: ["ui"] },
    ]);

    const res = runBuildDispatch(tp.paths);
    expect(res.ok).toBe(true);

    const wave = res.data?.wave as DispatchDescriptor[];
    expect(wave).toHaveLength(2);
    // Deterministic: schedule order preserves slice order; both disjoint → both dispatch.
    expect(wave.map((d) => d.sliceId)).toEqual(["SLICE-1", "SLICE-2"]);
    for (const d of wave) {
      expect(typeof d.sliceId).toBe("string");
      expect(Array.isArray(d.components)).toBe(true);
      // Each descriptor carries a per-slice spawn recommendation.
      expect(typeof d.model).toBe("string");
      expect(typeof d.effort).toBe("string");
    }
    expect(wave.find((d) => d.sliceId === "SLICE-1")?.components).toEqual(["api"]);
    expect(wave.find((d) => d.sliceId === "SLICE-2")?.components).toEqual(["ui"]);
  });

  it("a component-conflicting slice is held (not dispatched) and reported in held", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [
      { id: "SLICE-1", status: "pending", components: ["api", "db"] },
      { id: "SLICE-2", status: "pending", components: ["api"] }, // shares "api" with SLICE-1
      { id: "SLICE-3", status: "pending", components: ["ui"] },
    ]);

    const res = runBuildDispatch(tp.paths);
    expect(res.ok).toBe(true);

    const wave = res.data?.wave as DispatchDescriptor[];
    // SLICE-1 and SLICE-3 are disjoint; SLICE-2 serializes behind SLICE-1's "api".
    expect(wave.map((d) => d.sliceId)).toEqual(["SLICE-1", "SLICE-3"]);

    const held = res.data?.held as Array<{ id: string; reason: string }>;
    expect(held.find((h) => h.id === "SLICE-2")?.reason).toBe("component-conflict");
  });

  it("dependency-graph problems surface as warnings in the same payload", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [
      { id: "SLICE-1", status: "pending", components: ["a"], depends_on: ["SLICE-2"] },
      { id: "SLICE-2", status: "pending", components: ["b"], depends_on: ["SLICE-1"] },
    ]);

    const res = runBuildDispatch(tp.paths);
    expect(res.ok).toBe(true);
    const wave = res.data?.wave as DispatchDescriptor[];
    expect(wave).toHaveLength(0); // a cycle dispatches nothing
    const warnings = res.data?.warnings as string[];
    expect(warnings.some((w) => w.includes("DEPENDENCY CYCLE"))).toBe(true);
    expect(warnings.some((w) => w.includes("STALLED"))).toBe(true);
  });
});
