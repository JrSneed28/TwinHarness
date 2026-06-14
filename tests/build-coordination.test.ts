/**
 * Live build coordination — `th build next-wave` + component leases + depends_on.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runSlicesSync } from "../src/commands/slices";
import { runBuildNextWave, runBuildClaim, runBuildRelease, runBuildLeases } from "../src/commands/build";
import { runSliceSetStatus } from "../src/commands/slices";
import { activeLeases, liveLeases, staleLeases } from "../src/core/leases";
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

  it("claim refuses a slice that is not in-progress (protocol: set in-progress first)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [{ id: "SLICE-1", status: "pending", components: ["api"] }]);
    const pending = runBuildClaim(tp.paths, "SLICE-1");
    expect(pending.ok).toBe(false);
    expect(pending.data?.error).toBe("slice_not_in_progress");
    // Per protocol: set in-progress first, then the claim succeeds.
    runSliceSetStatus(tp.paths, "SLICE-1", "in-progress");
    expect(runBuildClaim(tp.paths, "SLICE-1").ok).toBe(true);
  });
});

describe("REQ-LEASE-002: leases reconcile against slice state (no stale wedge)", () => {
  it("set-status done auto-releases the slice's lease", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [{ id: "SLICE-1", status: "in-progress", components: ["api"] }]);
    runBuildClaim(tp.paths, "SLICE-1");
    expect(activeLeases(tp.paths)).toHaveLength(1);

    const res = runSliceSetStatus(tp.paths, "SLICE-1", "done");
    expect(res.ok).toBe(true);
    expect(res.data?.releasedLease).toEqual(["api"]);
    expect(activeLeases(tp.paths)).toEqual([]); // released by the status change
  });

  it("a stale lease (owning slice done, never released) is ignored by next-wave and claim", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // SLICE-1 in-progress claims api, then a forced raw status flip leaves the lease behind.
    setSlices(tp, [
      { id: "SLICE-1", status: "in-progress", components: ["api"] },
      { id: "SLICE-2", status: "pending", components: ["api"] },
    ]);
    runBuildClaim(tp.paths, "SLICE-1");
    // Simulate a crash-style settle WITHOUT release by writing state directly.
    setSlices(tp, [
      { id: "SLICE-1", status: "done", components: ["api"] },
      { id: "SLICE-2", status: "pending", components: ["api"] },
    ]);
    // The ledger still holds SLICE-1's claim, but it's now stale.
    expect(staleLeases(tp.paths, [{ id: "SLICE-1", status: "done" }]).length).toBe(1);
    expect(liveLeases(tp.paths, [{ id: "SLICE-1", status: "done" }])).toEqual([]);

    // next-wave must NOT treat api as busy → SLICE-2 dispatches.
    const res = runBuildNextWave(tp.paths);
    expect((res.data?.wave as string[])).toEqual(["SLICE-2"]);
    // Dispatch SLICE-2 per protocol (set in-progress, then claim); the claim must
    // still ignore the stale lease left behind by the crashed SLICE-1.
    setSlices(tp, [
      { id: "SLICE-1", status: "done", components: ["api"] },
      { id: "SLICE-2", status: "in-progress", components: ["api"] },
    ]);
    expect(runBuildClaim(tp.paths, "SLICE-2").ok).toBe(true);
  });

  it("th build leases lists the stale set separately", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [{ id: "SLICE-1", status: "in-progress", components: ["api"] }]);
    runBuildClaim(tp.paths, "SLICE-1");
    setSlices(tp, [{ id: "SLICE-1", status: "blocked", components: ["api"] }]);
    const res = runBuildLeases(tp.paths);
    expect((res.data?.stale as unknown[]).length).toBe(1);
    expect((res.data?.leases as unknown[]).length).toBe(0);
  });
});

describe("REQ-NEXTWAVE-003: dependency deadlocks surface as a stall, not an empty wave", () => {
  it("a depends_on cycle → stalled + reported cycle", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [
      { id: "SLICE-1", status: "pending", components: ["a"], depends_on: ["SLICE-2"] },
      { id: "SLICE-2", status: "pending", components: ["b"], depends_on: ["SLICE-1"] },
    ]);
    const res = runBuildNextWave(tp.paths);
    expect((res.data?.wave as string[])).toEqual([]);
    expect(res.data?.stalled).toBe(true);
    expect((res.data?.deps as { cycles: string[][] }).cycles.length).toBeGreaterThan(0);
  });

  it("a dangling depends_on reference is reported", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [{ id: "SLICE-1", status: "pending", components: ["a"], depends_on: ["SLICE-99"] }]);
    const res = runBuildNextWave(tp.paths);
    expect((res.data?.deps as { dangling: unknown[] }).dangling).toEqual([{ slice: "SLICE-1", missing: ["SLICE-99"] }]);
    expect(res.data?.stalled).toBe(true);
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
