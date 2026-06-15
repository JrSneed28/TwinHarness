/**
 * Phase 3 / Slice 4 — `th build plan --advise` parallelism-optimizer advisory.
 *
 * REQ-PCO-030: the advisory reports the current max wave width and the conflict
 * pairs whose shared components serialize the plan, so the Vertical-Slice agent
 * can re-cut to widen build waves. Advisory only — it never changes the schedule
 * or the coverage hard-gate. These tests exercise the run handler directly.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runBuildPlan } from "../src/commands/build";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function setSlices(t: TempProject, slices: unknown[]): void {
  runStateSet(t.paths, "slices", JSON.stringify(slices));
}

describe("REQ-PCO-030: th build plan --advise emits the parallelism-optimizer advisory", () => {
  it("reports max wave width across disjoint slices and an empty conflict set", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [
      { id: "SLICE-1", status: "pending", components: ["api"] },
      { id: "SLICE-2", status: "pending", components: ["ui"] },
    ]);

    const res = runBuildPlan(tp.paths, { advise: true });
    expect(res.ok).toBe(true);
    const data = res.data as { parallelism: number; conflicts: unknown[]; advise: boolean };
    expect(data.advise).toBe(true);
    expect(data.parallelism).toBe(2); // both disjoint slices share one wave
    expect(data.conflicts).toHaveLength(0);
    expect(res.human).toContain("ADVISORY");
    expect(res.human).toMatch(/max wave width = 2/);
  });

  it("surfaces the conflict pairs whose shared components serialize the plan", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [
      { id: "SLICE-1", status: "pending", components: ["api", "db"] },
      { id: "SLICE-2", status: "pending", components: ["api"] }, // shares "api" with SLICE-1
      { id: "SLICE-3", status: "pending", components: ["ui"] },
    ]);

    const res = runBuildPlan(tp.paths, { advise: true });
    expect(res.ok).toBe(true);
    const data = res.data as { conflicts: Array<{ a: string; b: string; shared: string[] }> };
    const pair = data.conflicts.find(
      (c) => (c.a === "SLICE-1" && c.b === "SLICE-2") || (c.a === "SLICE-2" && c.b === "SLICE-1"),
    );
    expect(pair, "SLICE-1 × SLICE-2 should be a serializing conflict on 'api'").toBeTruthy();
    expect(pair!.shared).toContain("api");
    expect(res.human).toMatch(/conflict pair/);
  });

  it("without --advise the advisory line is absent (advisory is opt-in)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [{ id: "SLICE-1", status: "pending", components: ["api"] }]);

    const res = runBuildPlan(tp.paths, {});
    expect(res.ok).toBe(true);
    expect((res.data as { advise: boolean }).advise).toBe(false);
    expect(res.human).not.toContain("ADVISORY");
  });
});
