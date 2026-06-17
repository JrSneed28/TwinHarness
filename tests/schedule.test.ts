import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runBuildPlan } from "../src/commands/build";
import { shareComponent, scheduleWaves, conflictPairs } from "../src/core/schedule";
import { validateDeps, hasDepIssues } from "../src/core/wave";
import type { SliceState } from "../src/core/state-schema";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function slice(id: string, components: string[], status: SliceState["status"] = "pending"): SliceState {
  return { id, status, components };
}

/** A pending slice with an explicit hard `depends_on` set (ARCH-001 ordering tests). */
function dep(id: string, components: string[], dependsOn: string[]): SliceState {
  return { id, status: "pending", components, depends_on: dependsOn };
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

describe("ARCH-001: scheduleWaves is DEPENDENCY-AWARE (hard depends_on strictly orders waves)", () => {
  it("disjoint components but B depends_on A → B lands in a STRICTLY LATER wave than A", () => {
    // The pre-fix bug: disjoint components let A and B pack same-wave even though
    // B hard-depends on A. The fix forces B strictly after A regardless of §16.
    const waves = scheduleWaves([slice("A", ["api"]), dep("B", ["ui"], ["A"])]);
    expect(waveOf(waves, "B")).toBeGreaterThan(waveOf(waves, "A"));
  });

  it("a transitive chain A ← B ← C places them in 3 strictly increasing waves (disjoint components)", () => {
    const waves = scheduleWaves([
      slice("A", ["a"]),
      dep("B", ["b"], ["A"]),
      dep("C", ["c"], ["B"]),
    ]);
    expect(waves).toHaveLength(3);
    expect(waveOf(waves, "A")).toBeLessThan(waveOf(waves, "B"));
    expect(waveOf(waves, "B")).toBeLessThan(waveOf(waves, "C"));
  });

  it("order-robust: a FORWARD reference (dependency listed AFTER its dependent) still orders strictly", () => {
    // B appears before A in input, yet B depends_on A → B must still be later.
    const waves = scheduleWaves([dep("B", ["ui"], ["A"]), slice("A", ["api"])]);
    expect(waveOf(waves, "B")).toBeGreaterThan(waveOf(waves, "A"));
  });

  it("disjoint dependents of a common parent pack TOGETHER in the wave after the parent (diamond)", () => {
    const waves = scheduleWaves([
      slice("A", ["a"]),
      dep("B", ["b"], ["A"]),
      dep("C", ["c"], ["A"]),
      dep("D", ["d"], ["B", "C"]),
    ]);
    // B and C: disjoint components, both depend only on A → same wave (parallel).
    expect(waveOf(waves, "B")).toBe(waveOf(waves, "C"));
    expect(waveOf(waves, "B")).toBeGreaterThan(waveOf(waves, "A"));
    // D depends on both B and C → strictly after both.
    expect(waveOf(waves, "D")).toBeGreaterThan(waveOf(waves, "B"));
    expect(waveOf(waves, "D")).toBeGreaterThan(waveOf(waves, "C"));
  });

  it("a dangling depends_on id does NOT crash; the slice is still placed", () => {
    const waves = scheduleWaves([dep("A", ["a"], ["GHOST"]), slice("B", ["b"])]);
    expect(waveOf(waves, "A")).toBeGreaterThanOrEqual(0);
    expect(waveOf(waves, "B")).toBeGreaterThanOrEqual(0);
  });

  it("a dependency CYCLE terminates (no infinite loop) and places every slice", () => {
    const waves = scheduleWaves([dep("A", ["a"], ["B"]), dep("B", ["b"], ["A"])]);
    expect(waveOf(waves, "A")).toBeGreaterThanOrEqual(0);
    expect(waveOf(waves, "B")).toBeGreaterThanOrEqual(0);
  });

  it("a self-dependency terminates and places the slice", () => {
    const waves = scheduleWaves([dep("A", ["a"], ["A"])]);
    expect(waves).toHaveLength(1);
    expect(waveOf(waves, "A")).toBe(0);
  });

  it("is deterministic: identical input → identical wave output", () => {
    const input = (): SliceState[] => [slice("X", ["a"]), dep("Y", ["b"], ["X"]), dep("Z", ["a"], ["X"])];
    expect(scheduleWaves(input())).toEqual(scheduleWaves(input()));
  });

  it("no depends_on → output is byte-identical to the pure §16 component schedule (regression guard)", () => {
    const slices = [slice("SLICE-1", ["api", "db"]), slice("SLICE-2", ["api"]), slice("SLICE-3", ["ui"])];
    expect(scheduleWaves(slices)).toEqual([["SLICE-1", "SLICE-3"], ["SLICE-2"]]);
  });
});

describe("ARCH-001: validateDeps surfaces cycles and dangling deps for the build-plan path", () => {
  it("reports a 2-cycle A↔B", () => {
    const issues = validateDeps([dep("A", ["a"], ["B"]), dep("B", ["b"], ["A"])]);
    expect(hasDepIssues(issues)).toBe(true);
    expect(issues.cycles.length).toBeGreaterThan(0);
    // The cycle contains both members.
    const flat = issues.cycles.flat();
    expect(flat).toContain("A");
    expect(flat).toContain("B");
  });

  it("reports a dangling dependency (unknown slice id)", () => {
    const issues = validateDeps([dep("A", ["a"], ["GHOST"]), slice("B", ["b"])]);
    expect(hasDepIssues(issues)).toBe(true);
    expect(issues.dangling).toEqual([{ slice: "A", missing: ["GHOST"] }]);
  });

  it("clean graph → no issues", () => {
    const issues = validateDeps([slice("A", ["a"]), dep("B", ["b"], ["A"])]);
    expect(hasDepIssues(issues)).toBe(false);
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

  it("dependency-aware: B depends_on A (disjoint components) → B in a strictly later wave", () => {
    tp = init();
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([
        { id: "SLICE-1", status: "pending", components: ["api"] },
        { id: "SLICE-2", status: "pending", components: ["ui"], depends_on: ["SLICE-1"] },
      ]),
    );
    const res = runBuildPlan(tp.paths);
    expect(res.ok).toBe(true);
    const waves = res.data?.waves as string[][];
    expect(waveOf(waves, "SLICE-2")).toBeGreaterThan(waveOf(waves, "SLICE-1"));
  });
});

describe("ARCH-001: th build plan surfaces an unsatisfiable depends_on graph (exit 7)", () => {
  function init(): TempProject {
    const t = makeTempProject();
    runInit(t.paths, {});
    return t;
  }

  it("a clean graph → ok, deps reported with no issues", () => {
    tp = init();
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([
        { id: "SLICE-1", status: "pending", components: ["api"] },
        { id: "SLICE-2", status: "pending", components: ["ui"], depends_on: ["SLICE-1"] },
      ]),
    );
    const res = runBuildPlan(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.depIssues).toBe(false);
    const deps = res.data?.deps as { dangling: unknown[]; cycles: unknown[] };
    expect(deps.dangling).toEqual([]);
    expect(deps.cycles).toEqual([]);
  });

  it("a dependency cycle → failure exit 7, cycle reported in data + human", () => {
    tp = init();
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([
        { id: "SLICE-1", status: "pending", components: ["api"], depends_on: ["SLICE-2"] },
        { id: "SLICE-2", status: "pending", components: ["ui"], depends_on: ["SLICE-1"] },
      ]),
    );
    const res = runBuildPlan(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(7);
    expect(res.data?.error).toBe("dependency_graph_unsatisfiable");
    const deps = res.data?.deps as { cycles: string[][] };
    expect(deps.cycles.length).toBeGreaterThan(0);
    expect(res.human).toContain("DEPENDENCY CYCLE");
    // The full plan data is still present alongside the failure.
    expect(res.data?.waves).toBeDefined();
  });

  it("a dangling dependency → failure exit 7, dangling reported", () => {
    tp = init();
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([
        { id: "SLICE-1", status: "pending", components: ["api"], depends_on: ["SLICE-404"] },
      ]),
    );
    const res = runBuildPlan(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(7);
    const deps = res.data?.deps as { dangling: { slice: string; missing: string[] }[] };
    expect(deps.dangling).toEqual([{ slice: "SLICE-1", missing: ["SLICE-404"] }]);
    expect(res.human).toContain("DANGLING DEPENDENCY");
  });

  it("a cycle that involves a done slice is still surfaced (validates the FULL slice set)", () => {
    tp = init();
    // SLICE-1 is done but a cycle SLICE-2↔SLICE-3 remains; even though done slices
    // are excluded from the *schedule*, the dep graph is validated over all slices.
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([
        { id: "SLICE-1", status: "done", components: ["api"] },
        { id: "SLICE-2", status: "pending", components: ["ui"], depends_on: ["SLICE-3"] },
        { id: "SLICE-3", status: "pending", components: ["db"], depends_on: ["SLICE-2"] },
      ]),
    );
    const res = runBuildPlan(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(7);
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
