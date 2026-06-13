/**
 * Live build coordination — `th build next-wave` + component leases + depends_on.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runSlicesSync } from "../src/commands/slices";
import { runBuildNextWave, runBuildClaim, runBuildRelease, runBuildLeases } from "../src/commands/build";
import { activeLeases } from "../src/core/leases";
import * as fs from "node:fs";
import * as path from "node:path";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function setSlices(t: TempProject, slices: unknown[]): void {
  runStateSet(t.paths, "slices", JSON.stringify(slices));
}

describe("REQ-NEXTWAVE-001: dispatches disjoint pending slices, holds component conflicts", () => {
  it("two disjoint pending slices dispatch together; an in-progress slice's components are busy", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [
      { id: "SLICE-1", status: "in-progress", components: ["api"] },
      { id: "SLICE-2", status: "pending", components: ["api"] }, // conflicts with in-progress SLICE-1
      { id: "SLICE-3", status: "pending", components: ["ui"] },
    ]);
    const res = runBuildNextWave(tp.paths);
    const wave = res.data?.wave as string[];
    const held = res.data?.held as Array<{ id: string; reason: string }>;
    expect(wave).toEqual(["SLICE-3"]);
    expect(held.find((h) => h.id === "SLICE-2")?.reason).toBe("component-conflict");
  });

  it("two pending slices sharing a component cannot both be in the wave", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [
      { id: "SLICE-1", status: "pending", components: ["api", "db"] },
      { id: "SLICE-2", status: "pending", components: ["api"] },
    ]);
    const res = runBuildNextWave(tp.paths);
    const wave = res.data?.wave as string[];
    expect(wave).toEqual(["SLICE-1"]); // SLICE-2 held on shared "api"
  });
});

describe("REQ-NEXTWAVE-002: depends_on holds a slice until its dependency is done", () => {
  it("SLICE-2 depends_on SLICE-1 (pending) → held as dependency; once done → dispatchable", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [
      { id: "SLICE-1", status: "pending", components: ["skeleton"] },
      { id: "SLICE-2", status: "pending", components: ["feature"], depends_on: ["SLICE-1"] },
    ]);
    let res = runBuildNextWave(tp.paths);
    expect((res.data?.wave as string[])).toEqual(["SLICE-1"]);
    expect((res.data?.held as Array<{ id: string; reason: string }>).find((h) => h.id === "SLICE-2")?.reason).toBe("dependency");

    // Mark SLICE-1 done → SLICE-2 becomes dispatchable.
    setSlices(tp, [
      { id: "SLICE-1", status: "done", components: ["skeleton"] },
      { id: "SLICE-2", status: "pending", components: ["feature"], depends_on: ["SLICE-1"] },
    ]);
    res = runBuildNextWave(tp.paths);
    expect((res.data?.wave as string[])).toEqual(["SLICE-2"]);
  });
});

describe("REQ-LEASE-001: claim takes a live lease; release frees it; leases lists active", () => {
  it("claim records the slice's components; release removes them", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [{ id: "SLICE-1", status: "in-progress", components: ["api", "db"] }]);

    expect(runBuildClaim(tp.paths, "SLICE-1").ok).toBe(true);
    expect(activeLeases(tp.paths)).toEqual([{ slice: "SLICE-1", components: ["api", "db"] }]);
    expect((runBuildLeases(tp.paths).data?.leases as unknown[]).length).toBe(1);

    expect(runBuildRelease(tp.paths, "SLICE-1").ok).toBe(true);
    expect(activeLeases(tp.paths)).toEqual([]);
  });

  it("claim refuses when a component is held by another slice (collision guard)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [
      { id: "SLICE-1", status: "in-progress", components: ["api"] },
      { id: "SLICE-2", status: "in-progress", components: ["api", "ui"] },
    ]);
    expect(runBuildClaim(tp.paths, "SLICE-1").ok).toBe(true);
    const conflict = runBuildClaim(tp.paths, "SLICE-2");
    expect(conflict.ok).toBe(false);
    expect(conflict.data?.error).toBe("lease_conflict");
  });

  it("a leased component is busy for next-wave even if no slice is in-progress", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [
      { id: "SLICE-1", status: "pending", components: ["api"] },
      { id: "SLICE-2", status: "pending", components: ["api"] },
    ]);
    // Manually lease "api" to SLICE-1 (e.g. a Builder claimed it).
    runStateSet(tp.paths, "slices", JSON.stringify([
      { id: "SLICE-1", status: "in-progress", components: ["api"] },
      { id: "SLICE-2", status: "pending", components: ["api"] },
    ]));
    runBuildClaim(tp.paths, "SLICE-1");
    const res = runBuildNextWave(tp.paths);
    expect((res.data?.wave as string[])).toEqual([]); // SLICE-2 held on the leased "api"
  });
});

describe("REQ-SLICE-DEPENDS-001: slices sync parses a Depends on line", () => {
  it("captures SLICE tokens from a 'Depends on:' line into depends_on", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const plan = [
      "### SLICE-1",
      "Components touched: skeleton",
      "",
      "### SLICE-2",
      "Components touched: feature",
      "Depends on: SLICE-1",
    ].join("\n");
    const abs = path.join(tp.root, "docs", "09-implementation-plan.md");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, plan, "utf8");

    runSlicesSync(tp.paths, { planFile: "docs/09-implementation-plan.md" });
    const raw = JSON.parse(fs.readFileSync(tp.paths.stateFile, "utf8")) as { slices: Array<{ id: string; depends_on?: string[] }> };
    const s1 = raw.slices.find((s) => s.id === "SLICE-1")!;
    const s2 = raw.slices.find((s) => s.id === "SLICE-2")!;
    expect(s1.depends_on).toBeUndefined(); // no deps → omitted (serialization stability)
    expect(s2.depends_on).toEqual(["SLICE-1"]);
  });
});
