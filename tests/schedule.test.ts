import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runBuildPlan } from "../src/commands/build";
import { shareComponent, scheduleWaves, conflictPairs } from "../src/core/schedule";
import type { SliceState } from "../src/core/state-schema";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function slice(id: string, components: string[], status: SliceState["status"] = "pending"): SliceState {
  return { id, status, components };
}

/** The wave (array index) that contains slice `id`, or -1 if absent. */
function waveOf(waves: string[][], id: string): number {
  return waves.findIndex((w) => w.includes(id));
}

/** True if any wave contains both members of any sharing pair (a coloring violation). */
function hasSharingPairInSameWave(slices: SliceState[], waves: string[][]): boolean {
  for (let i = 0; i < slices.length; i++) {
    for (let j = i + 1; j < slices.length; j++) {
      if (shareComponent(slices[i]!, slices[j]!)) {
        if (waveOf(waves, slices[i]!.id) === waveOf(waves, slices[j]!.id)) return true;
      }
    }
  }
  return false;
}

describe("REQ-SCHEDULE-001: shareComponent detects component intersection (§16)", () => {
  it("overlapping component sets → true", () => {
    expect(shareComponent(slice("A", ["api", "db"]), slice("B", ["api"]))).toBe(true);
  });

  it("disjoint component sets → false", () => {
    expect(shareComponent(slice("A", ["api", "db"]), slice("B", ["ui"]))).toBe(false);
  });

  it("empty component set conflicts with nothing → false", () => {
    expect(shareComponent(slice("A", []), slice("B", ["api"]))).toBe(false);
  });
});

describe("REQ-SCHEDULE-002: scheduleWaves serializes shared, parallelizes disjoint (§16)", () => {
  it("TWO slices with OVERLAPPING components → DIFFERENT waves (serialized)", () => {
    const slices = [slice("SLICE-1", ["api", "db"]), slice("SLICE-2", ["api"])];
    const waves = scheduleWaves(slices);
    expect(waveOf(waves, "SLICE-1")).not.toBe(waveOf(waves, "SLICE-2"));
    expect(hasSharingPairInSameWave(slices, waves)).toBe(false);
  });

  it("TWO slices with DISJOINT components → SAME wave (parallel)", () => {
    const slices = [slice("SLICE-1", ["api"]), slice("SLICE-3", ["ui"])];
    const waves = scheduleWaves(slices);
    expect(waves).toHaveLength(1);
    expect(waveOf(waves, "SLICE-1")).toBe(waveOf(waves, "SLICE-3"));
  });

  it("three slices A∩B share, A∩C & B∩C disjoint → valid coloring (no sharing pair shares a wave)", () => {
    // A=["api"], B=["api"], C=["ui"]: only A∩B share.
    const slices = [slice("A", ["api"]), slice("B", ["api"]), slice("C", ["ui"])];
    const waves = scheduleWaves(slices);
    expect(hasSharingPairInSameWave(slices, waves)).toBe(false);
    // A and B must be in different waves; C is free to pack with either.
    expect(waveOf(waves, "A")).not.toBe(waveOf(waves, "B"));
  });

  it("empty-component slices pack freely into the first wave", () => {
    const slices = [slice("A", ["api"]), slice("B", []), slice("C", [])];
    const waves = scheduleWaves(slices);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toEqual(["A", "B", "C"]);
  });

  it("no slices → no waves", () => {
    expect(scheduleWaves([])).toEqual([]);
  });
});

describe("REQ-SCHEDULE-003: conflictPairs reports shared-component pairs (§16)", () => {
  it("returns the overlapping pair with the shared component name", () => {
    const pairs = conflictPairs([slice("SLICE-1", ["api", "db"]), slice("SLICE-2", ["api"])]);
    expect(pairs).toEqual([{ a: "SLICE-1", b: "SLICE-2", shared: ["api"] }]);
  });

  it("empty when all slices are disjoint", () => {
    expect(conflictPairs([slice("A", ["api"]), slice("B", ["ui"])])).toEqual([]);
  });
});

describe("REQ-BUILD-001: th build plan schedules state.slices into waves (§16)", () => {
  function init(): TempProject {
    const t = makeTempProject();
    runInit(t.paths, {});
    return t;
  }

  it("an overlapping pair → different waves AND listed in conflicts", () => {
    tp = init();
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([
        { id: "SLICE-1", status: "pending", components: ["api", "db"] },
        { id: "SLICE-2", status: "pending", components: ["api"] },
      ]),
    );
    const res = runBuildPlan(tp.paths);
    expect(res.ok).toBe(true);
    const waves = res.data?.waves as string[][];
    const conflicts = res.data?.conflicts as { a: string; b: string; shared: string[] }[];
    expect(waveOf(waves, "SLICE-1")).not.toBe(waveOf(waves, "SLICE-2"));
    expect(conflicts).toEqual([{ a: "SLICE-1", b: "SLICE-2", shared: ["api"] }]);
  });

  it("a disjoint pair → same wave, no conflicts, parallelism 2", () => {
    tp = init();
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([
        { id: "SLICE-1", status: "pending", components: ["api"] },
        { id: "SLICE-3", status: "pending", components: ["ui"] },
      ]),
    );
    const res = runBuildPlan(tp.paths);
    expect(res.ok).toBe(true);
    const waves = res.data?.waves as string[][];
    expect(waves).toHaveLength(1);
    expect(waveOf(waves, "SLICE-1")).toBe(waveOf(waves, "SLICE-3"));
    expect(res.data?.conflicts).toEqual([]);
    expect(res.data?.parallelism).toBe(2);
  });

  it("the §16 acceptance case: shared pair serializes while a disjoint slice parallelizes", () => {
    tp = init();
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([
        { id: "SLICE-1", status: "pending", components: ["api", "db"] },
        { id: "SLICE-2", status: "pending", components: ["api"] },
        { id: "SLICE-3", status: "pending", components: ["ui"] },
      ]),
    );
    const res = runBuildPlan(tp.paths);
    const waves = res.data?.waves as string[][];
    const conflicts = res.data?.conflicts as { a: string; b: string; shared: string[] }[];
    // SLICE-1 and SLICE-2 serialized (different waves) on the shared "api".
    expect(waveOf(waves, "SLICE-1")).not.toBe(waveOf(waves, "SLICE-2"));
    expect(conflicts).toEqual([{ a: "SLICE-1", b: "SLICE-2", shared: ["api"] }]);
    // SLICE-3 parallelizes — it shares a wave with SLICE-1 (both first-fit into wave 1).
    expect(waveOf(waves, "SLICE-3")).toBe(waveOf(waves, "SLICE-1"));
  });
});

describe("REQ-BUILD-002: done slices are excluded unless --include-done", () => {
  function init(): TempProject {
    const t = makeTempProject();
    runInit(t.paths, {});
    return t;
  }

  it("done slices are not scheduled by default", () => {
    tp = init();
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([
        { id: "SLICE-1", status: "done", components: ["api"] },
        { id: "SLICE-2", status: "pending", components: ["ui"] },
      ]),
    );
    const res = runBuildPlan(tp.paths);
    const waves = res.data?.waves as string[][];
    expect(waveOf(waves, "SLICE-1")).toBe(-1);
    expect(waveOf(waves, "SLICE-2")).not.toBe(-1);
  });

  it("--include-done schedules done slices too", () => {
    tp = init();
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([
        { id: "SLICE-1", status: "done", components: ["api"] },
        { id: "SLICE-2", status: "pending", components: ["ui"] },
      ]),
    );
    const res = runBuildPlan(tp.paths, { includeDone: true });
    const waves = res.data?.waves as string[][];
    expect(waveOf(waves, "SLICE-1")).not.toBe(-1);
    expect(waveOf(waves, "SLICE-2")).not.toBe(-1);
  });
});

describe("REQ-BUILD-003: not_initialized on an empty project", () => {
  it("build plan before init → failure not_initialized", () => {
    const empty = makeTempProject();
    const res = runBuildPlan(empty.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
    empty.cleanup();
  });
});
