import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runSlicesSync, runSliceSetStatus, parsePlanSlices } from "../src/commands/slices";
import { readState } from "../src/core/state-store";
import { runStateSet } from "../src/commands/state";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Write a file relative to a temp project root. */
function writeFile(t: TempProject, rel: string, content: string): void {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

// ---------------------------------------------------------------------------
// Fixture: a realistic implementation plan snippet.
// ---------------------------------------------------------------------------
const PLAN_FIXTURE = `
# Implementation Plan

## Summary

Three slices.

---

## Slice 0 — Walking Skeleton

- **Components touched:** \`cli-entry\`, \`state-store\`
- **REQ-IDs satisfied:** none

---

### SLICE-1 — Feature Alpha

- **REQ-IDs satisfied:** REQ-001
- **Components touched (end-to-end):** \`api-layer\`, \`db-layer\`, \`cli-entry\`

---

### SLICE-2 — Feature Beta

- **REQ-IDs satisfied:** REQ-002
- **Components touched (end-to-end):** \`ui-layer\`, \`api-layer\`

---

### SLICE-3 — No-component slice

- **REQ-IDs satisfied:** REQ-003
`;

describe("REQ-SLICES-PARSE-001: parsePlanSlices from a realistic fixture", () => {
  it("extracts SLICE-0 through SLICE-3 with correct ids", () => {
    const slices = parsePlanSlices(PLAN_FIXTURE);
    const ids = slices.map((s) => s.id);
    expect(ids).toEqual(["SLICE-0", "SLICE-1", "SLICE-2", "SLICE-3"]);
  });

  it("SLICE-0 components: cli-entry and state-store (backtick-quoted)", () => {
    const slices = parsePlanSlices(PLAN_FIXTURE);
    expect(slices[0]!.components).toEqual(["cli-entry", "state-store"]);
  });

  it("SLICE-1 components: api-layer, db-layer, cli-entry", () => {
    const slices = parsePlanSlices(PLAN_FIXTURE);
    expect(slices[1]!.components).toEqual(["api-layer", "db-layer", "cli-entry"]);
  });

  it("SLICE-2 components: ui-layer, api-layer", () => {
    const slices = parsePlanSlices(PLAN_FIXTURE);
    expect(slices[2]!.components).toEqual(["ui-layer", "api-layer"]);
  });

  it("SLICE-3 with no components line → empty components array", () => {
    const slices = parsePlanSlices(PLAN_FIXTURE);
    expect(slices[3]!.components).toEqual([]);
  });
});

describe("REQ-SLICES-SYNC-001: basic sync from plan file", () => {
  it("syncs plan slices into state and defaults new slices to pending", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/09-implementation-plan.md", PLAN_FIXTURE);

    const res = runSlicesSync(tp.paths);
    expect(res.ok).toBe(true);
    const state = readState(tp.paths).state!;
    expect(state.slices).toHaveLength(4);
    expect(state.slices[0]!.id).toBe("SLICE-0");
    expect(state.slices[0]!.status).toBe("pending");
    expect(state.slices[1]!.components).toEqual(["api-layer", "db-layer", "cli-entry"]);
  });

  it("reports added and updated counts correctly", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/09-implementation-plan.md", PLAN_FIXTURE);

    const res = runSlicesSync(tp.paths);
    expect(res.data?.added).toEqual(["SLICE-0", "SLICE-1", "SLICE-2", "SLICE-3"]);
    expect(res.data?.updated).toEqual([]);
  });
});

describe("REQ-SLICES-SYNC-002: status preservation on re-sync", () => {
  it("existing slice status is preserved when re-syncing", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/09-implementation-plan.md", PLAN_FIXTURE);

    // First sync to populate.
    runSlicesSync(tp.paths);

    // Mark SLICE-1 as done.
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([
        { id: "SLICE-0", status: "done", components: [] },
        { id: "SLICE-1", status: "done", components: [] },
        { id: "SLICE-2", status: "in-progress", components: [] },
        { id: "SLICE-3", status: "pending", components: [] },
      ]),
    );

    // Re-sync.
    const res = runSlicesSync(tp.paths);
    expect(res.ok).toBe(true);
    const state = readState(tp.paths).state!;
    expect(state.slices.find((s) => s.id === "SLICE-0")?.status).toBe("done");
    expect(state.slices.find((s) => s.id === "SLICE-1")?.status).toBe("done");
    expect(state.slices.find((s) => s.id === "SLICE-2")?.status).toBe("in-progress");
    // Components are updated from the plan.
    expect(state.slices.find((s) => s.id === "SLICE-1")?.components).toEqual(["api-layer", "db-layer", "cli-entry"]);
  });
});

describe("REQ-SLICES-SYNC-003: --dry-run does not write state", () => {
  it("dry run reports changes but leaves state.slices unchanged", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/09-implementation-plan.md", PLAN_FIXTURE);

    const before = readState(tp.paths).state!.slices.length;
    const res = runSlicesSync(tp.paths, { dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.data?.dryRun).toBe(true);
    // State was not written.
    const after = readState(tp.paths).state!.slices.length;
    expect(after).toBe(before);
    expect(res.human).toContain("dry run");
  });
});

describe("REQ-SLICES-SYNC-004: missing plan file → clear failure", () => {
  it("no plan file → failure plan_file_not_found", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const res = runSlicesSync(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("plan_file_not_found");
  });

  it("--plan override respected", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "custom/plan.md", PLAN_FIXTURE);

    const res = runSlicesSync(tp.paths, { planFile: "custom/plan.md" });
    expect(res.ok).toBe(true);
    const state = readState(tp.paths).state!;
    expect(state.slices).toHaveLength(4);
  });
});

describe("REQ-SLICES-SYNC-005: missing slices reported but not removed by default", () => {
  it("slices in state but absent from plan are reported and kept", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Seed state with a slice not in the plan.
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([{ id: "SLICE-99", status: "pending", components: [] }]),
    );
    writeFile(tp, "docs/09-implementation-plan.md", PLAN_FIXTURE);

    const res = runSlicesSync(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.missing).toContain("SLICE-99");
    // SLICE-99 should still be in state.
    const state = readState(tp.paths).state!;
    expect(state.slices.some((s) => s.id === "SLICE-99")).toBe(true);
  });

  it("--remove-missing removes obsolete slices", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([{ id: "SLICE-99", status: "pending", components: [] }]),
    );
    writeFile(tp, "docs/09-implementation-plan.md", PLAN_FIXTURE);

    const res = runSlicesSync(tp.paths, { removeMissing: true });
    expect(res.ok).toBe(true);
    expect(res.data?.removed).toContain("SLICE-99");
    const state = readState(tp.paths).state!;
    expect(state.slices.some((s) => s.id === "SLICE-99")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// th slice set-status
// ---------------------------------------------------------------------------

describe("REQ-SLICE-STATUS-001: set-status updates a single slice", () => {
  it("updates SLICE-1 status from pending to done", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeFile(tp, "docs/09-implementation-plan.md", PLAN_FIXTURE);
    runSlicesSync(tp.paths);

    const res = runSliceSetStatus(tp.paths, "SLICE-1", "done");
    expect(res.ok).toBe(true);
    expect(res.data?.status).toBe("done");
    const state = readState(tp.paths).state!;
    expect(state.slices.find((s) => s.id === "SLICE-1")?.status).toBe("done");
    // Other slices unchanged.
    expect(state.slices.find((s) => s.id === "SLICE-0")?.status).toBe("pending");
  });

  it("all valid statuses are accepted", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([{ id: "SLICE-1", status: "pending", components: [] }]),
    );
    for (const s of ["pending", "in-progress", "done", "blocked"] as const) {
      expect(runSliceSetStatus(tp.paths, "SLICE-1", s).ok).toBe(true);
    }
  });
});

describe("REQ-SLICE-STATUS-002: validation errors", () => {
  it("invalid status → failure invalid_status", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([{ id: "SLICE-1", status: "pending", components: [] }]),
    );
    const res = runSliceSetStatus(tp.paths, "SLICE-1", "launched");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("invalid_status");
  });

  it("unknown slice id → failure slice_not_found", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runSliceSetStatus(tp.paths, "SLICE-99", "done");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("slice_not_found");
  });

  it("missing id arg → failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runSliceSetStatus(tp.paths, undefined, "done");
    expect(res.ok).toBe(false);
    expect(res.human).toContain("usage:");
  });

  it("not initialized → failure not_initialized", () => {
    tp = makeTempProject();
    const res = runSliceSetStatus(tp.paths, "SLICE-1", "done");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });
});
