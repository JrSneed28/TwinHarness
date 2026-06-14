/**
 * Sub-leases (Phase 5) — a scoped sub-Builder claims a SUBSET of an in-progress
 * parent slice's components, nested under the parent's already-held top-level
 * lease. Sibling-collision guard + parent-reconciled lifetime.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import {
  runBuildClaim,
  runBuildLeases,
  runBuildSubClaim,
  runBuildSubRelease,
} from "../src/commands/build";
import { runSliceSetStatus } from "../src/commands/slices";
import {
  activeLeases,
  liveLeases,
  staleLeases,
  subLeasesOf,
  occupiedComponents,
} from "../src/core/leases";
import type { SliceState } from "../src/core/state-schema";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function setSlices(t: TempProject, slices: unknown[]): void {
  runStateSet(t.paths, "slices", JSON.stringify(slices));
}

/** A parent slice in-progress on a few components, with its top-level lease held. */
function parentInProgress(t: TempProject, id = "SLICE-1", components = ["api", "db", "ui"]): void {
  setSlices(t, [{ id, status: "in-progress", components }]);
  runBuildClaim(t.paths, id); // parent holds the top-level lease on all its components
}

describe("REQ-SUBLEASE-001: sub-claim opens a sub-lease on a subset of an in-progress parent", () => {
  it("succeeds on a valid subset and records parent + sub-owner id", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp);

    const res = runBuildSubClaim(tp.paths, "SLICE-1", ["api", "db"]);
    expect(res.ok).toBe(true);
    expect(res.data?.parent).toBe("SLICE-1");
    expect(res.data?.components).toEqual(["api", "db"]);
    expect(res.data?.subId).toBe("SLICE-1#sub-1");

    // The sub-lease is recorded with its parent, alongside the parent's own lease.
    const subs = subLeasesOf(tp.paths, "SLICE-1");
    expect(subs).toEqual([{ slice: "SLICE-1#sub-1", components: ["api", "db"], parent: "SLICE-1" }]);
  });

  it("mints a fresh, non-colliding sub-owner id per claim under the same parent", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp);

    expect(runBuildSubClaim(tp.paths, "SLICE-1", ["api"]).data?.subId).toBe("SLICE-1#sub-1");
    expect(runBuildSubClaim(tp.paths, "SLICE-1", ["db"]).data?.subId).toBe("SLICE-1#sub-2");
    expect(subLeasesOf(tp.paths, "SLICE-1").map((l) => l.slice)).toEqual([
      "SLICE-1#sub-1",
      "SLICE-1#sub-2",
    ]);
  });

  it("refuses when the parent slice does not exist (slice_not_found)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [{ id: "SLICE-1", status: "in-progress", components: ["api"] }]);
    const res = runBuildSubClaim(tp.paths, "SLICE-99", ["api"]);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("slice_not_found");
  });

  it("refuses when the parent is not in-progress (parent_not_in_progress)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    setSlices(tp, [{ id: "SLICE-1", status: "pending", components: ["api"] }]);
    const res = runBuildSubClaim(tp.paths, "SLICE-1", ["api"]);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("parent_not_in_progress");
  });
});

describe("REQ-SUBLEASE-002: components must be a non-empty SUBSET of the parent", () => {
  it("refuses a superset / component not in the parent (not_a_subset)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp, "SLICE-1", ["api", "db"]);

    // "ui" is not among the parent's components → superset of the parent set.
    const res = runBuildSubClaim(tp.paths, "SLICE-1", ["api", "ui"]);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_a_subset");
    expect(res.data?.extra).toEqual(["ui"]);
  });

  it("refuses an empty component list", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp, "SLICE-1", ["api"]);
    const res = runBuildSubClaim(tp.paths, "SLICE-1", []);
    expect(res.ok).toBe(false);
  });
});

describe("REQ-SUBLEASE-003: sibling sub-leases must be disjoint (sub_lease_conflict, exit 1)", () => {
  it("refuses an overlapping sibling sub-lease with exit 1", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp, "SLICE-1", ["api", "db", "ui"]);

    expect(runBuildSubClaim(tp.paths, "SLICE-1", ["api", "db"]).ok).toBe(true);
    const conflict = runBuildSubClaim(tp.paths, "SLICE-1", ["db", "ui"]); // "db" overlaps
    expect(conflict.ok).toBe(false);
    expect(conflict.exitCode).toBe(1);
    expect(conflict.data?.error).toBe("sub_lease_conflict");
  });

  it("a disjoint sibling sub-lease is allowed; a released sibling frees its components", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp, "SLICE-1", ["api", "db", "ui"]);

    expect(runBuildSubClaim(tp.paths, "SLICE-1", ["api"]).ok).toBe(true);
    // Disjoint sibling — allowed.
    expect(runBuildSubClaim(tp.paths, "SLICE-1", ["db"]).ok).toBe(true);

    // Release sub-1, then sub-3 may reclaim "api".
    expect(runBuildSubRelease(tp.paths, "SLICE-1#sub-1").ok).toBe(true);
    const reclaim = runBuildSubClaim(tp.paths, "SLICE-1", ["api"]);
    expect(reclaim.ok).toBe(true);
    expect(reclaim.data?.subId).toBe("SLICE-1#sub-3"); // id never reused
  });
});

describe("REQ-SUBLEASE-004: a sub-lease's lifetime is its PARENT's status (reconciliation)", () => {
  it("is LIVE while the parent is in-progress and STALE once the parent is done", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp, "SLICE-1", ["api", "db"]);
    runBuildSubClaim(tp.paths, "SLICE-1", ["api"]);

    const slicesInProgress: Pick<SliceState, "id" | "status">[] = [{ id: "SLICE-1", status: "in-progress" }];
    expect(liveLeases(tp.paths, slicesInProgress).map((l) => l.slice)).toContain("SLICE-1#sub-1");
    expect(staleLeases(tp.paths, slicesInProgress).map((l) => l.slice)).not.toContain("SLICE-1#sub-1");

    // Parent set done WITHOUT explicitly releasing the sub-lease → sub-lease goes stale.
    const res = runSliceSetStatus(tp.paths, "SLICE-1", "done");
    expect(res.ok).toBe(true);
    // The sub-lease event log still holds the claim (no auto sub-release)...
    expect(activeLeases(tp.paths).map((l) => l.slice)).toContain("SLICE-1#sub-1");
    // ...but reconciliation against the now-done parent marks it stale, not live.
    const slicesDone: Pick<SliceState, "id" | "status">[] = [{ id: "SLICE-1", status: "done" }];
    expect(liveLeases(tp.paths, slicesDone).map((l) => l.slice)).not.toContain("SLICE-1#sub-1");
    expect(staleLeases(tp.paths, slicesDone).map((l) => l.slice)).toContain("SLICE-1#sub-1");
  });

  it("becomes STALE when the parent is set blocked", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp, "SLICE-1", ["api"]);
    runBuildSubClaim(tp.paths, "SLICE-1", ["api"]);
    runSliceSetStatus(tp.paths, "SLICE-1", "blocked");
    const slicesBlocked: Pick<SliceState, "id" | "status">[] = [{ id: "SLICE-1", status: "blocked" }];
    expect(staleLeases(tp.paths, slicesBlocked).map((l) => l.slice)).toContain("SLICE-1#sub-1");
  });
});

describe("REQ-SUBLEASE-005: a live sub-lease's components count as occupied", () => {
  it("occupiedComponents includes a live sub-lease's components (mapped to the sub-owner id)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const slices: SliceState[] = [{ id: "SLICE-1", status: "in-progress", components: ["api", "db"] }];
    setSlices(tp, slices);
    runBuildClaim(tp.paths, "SLICE-1");
    runBuildSubClaim(tp.paths, "SLICE-1", ["api"]);

    const occ = occupiedComponents(tp.paths, slices);
    // The in-progress parent already occupies "api"/"db" by slice; the sub-lease is
    // subsumed but its components remain occupied (never freed while parent lives).
    expect(occ.has("api")).toBe(true);
    expect(occ.has("db")).toBe(true);
  });

  it("occupies a sub-lease's components even with no in-progress slice claiming them directly", () => {
    // Construct the ledger so a live sub-lease is the SOLE occupant of a component:
    // parent in-progress declares only "db"; the sub-lease (under the parent) holds
    // "api" — which no in-progress slice's component set covers.
    tp = makeTempProject();
    runInit(tp.paths, {});
    const slices: SliceState[] = [{ id: "SLICE-1", status: "in-progress", components: ["db"] }];
    // Open the sub-lease while the parent still declares "api" (subset guard
    // satisfied), then narrow the parent's declared set back to just "db". The
    // sub-lease is reconciled against the parent's STATUS (still in-progress), so
    // it stays live and remains the sole occupant of "api".
    setSlices(tp, [{ id: "SLICE-1", status: "in-progress", components: ["db", "api"] }]);
    runBuildSubClaim(tp.paths, "SLICE-1", ["api"]);
    setSlices(tp, slices); // parent now declares only "db"; sub-lease still holds "api"

    const occ = occupiedComponents(tp.paths, slices);
    expect(occ.get("api")).toBe("SLICE-1#sub-1"); // sole occupant is the sub-owner id
  });
});

describe("REQ-SUBLEASE-006: sub-release closes the sub-lease; bad id is rejected", () => {
  it("sub-release removes the sub-lease from the active set", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp, "SLICE-1", ["api", "db"]);
    runBuildSubClaim(tp.paths, "SLICE-1", ["api"]);
    expect(subLeasesOf(tp.paths, "SLICE-1")).toHaveLength(1);

    expect(runBuildSubRelease(tp.paths, "SLICE-1#sub-1").ok).toBe(true);
    expect(subLeasesOf(tp.paths, "SLICE-1")).toHaveLength(0);
  });

  it("refuses sub-release of an unknown sub-id (sub_lease_not_found)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp, "SLICE-1", ["api"]);
    const res = runBuildSubRelease(tp.paths, "SLICE-1#sub-9");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("sub_lease_not_found");
  });

  it("refuses to sub-release a TOP-LEVEL lease id (not a sub-lease)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp, "SLICE-1", ["api"]);
    const res = runBuildSubRelease(tp.paths, "SLICE-1"); // the parent's own lease, not a sub-lease
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("sub_lease_not_found");
  });
});

describe("REQ-SUBLEASE-007: th build leases shows sub-leases in a labeled section", () => {
  it("lists the live sub-lease alongside the top-level lease", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp, "SLICE-1", ["api", "db"]);
    runBuildSubClaim(tp.paths, "SLICE-1", ["api"]);

    const res = runBuildLeases(tp.paths);
    expect((res.data?.leases as unknown[]).length).toBe(1); // top-level lease
    expect((res.data?.subLeases as Array<{ slice: string }>).map((l) => l.slice)).toEqual([
      "SLICE-1#sub-1",
    ]);
    expect(res.human).toContain("Live sub-leases:");
    expect(res.human).toContain("SLICE-1#sub-1 (under SLICE-1)");
  });

  it("reports a sub-lease as STALE once its parent settles", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    parentInProgress(tp, "SLICE-1", ["api"]);
    runBuildSubClaim(tp.paths, "SLICE-1", ["api"]);
    // Force the parent done without releasing either lease.
    setSlices(tp, [{ id: "SLICE-1", status: "done", components: ["api"] }]);

    const res = runBuildLeases(tp.paths);
    expect((res.data?.staleSubLeases as Array<{ slice: string }>).map((l) => l.slice)).toEqual([
      "SLICE-1#sub-1",
    ]);
    expect(res.human).toContain("STALE sub-leases");
  });
});

describe("REQ-SUBLEASE-008: top-level claim still refuses cross-slice component overlap (unchanged)", () => {
  it("a second slice cannot claim a component held by a live top-level lease", () => {
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
});
