import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runDriftAdd, runDriftList, runDriftResolve } from "../src/commands/drift";
import { parseDriftEntries } from "../src/core/drift-log";
import { readState } from "../src/core/state-store";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function driftLog(t: TempProject): string {
  return fs.readFileSync(t.paths.driftLog, "utf8");
}

describe("REQ-DRIFT-001: a derived entry is appended and is NOT blocking (§10)", () => {
  it("derived add → appended, drift_open_blocking unchanged", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const before = readState(tp.paths).state!.drift_open_blocking;

    const res = runDriftAdd(tp.paths, {
      layer: "derived",
      ref: "SLICE-2 / TASK-012",
      discovery: "Existing provider found",
      action: "Wired in",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.id).toBe("DRIFT-001");
    expect(res.data?.blocking).toBe(false);
    expect(res.data?.drift_open_blocking).toBe(before);

    const r = readState(tp.paths);
    expect(r.state?.drift_open_blocking).toBe(before);
    expect(driftLog(tp)).toContain("## DRIFT-001");
    expect(driftLog(tp)).toContain("derived layer, auto-applied");
  });
});

describe("REQ-DRIFT-002: a requirement entry is BLOCKING and increments drift_open_blocking (§10)", () => {
  it("requirement add → blocking, count incremented, default escalation", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    const res = runDriftAdd(tp.paths, {
      layer: "requirement",
      ref: "SLICE-5 / TASK-031",
      discovery: "REQ-004 infeasible",
      action: "Build paused",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.blocking).toBe(true);
    expect(res.data?.drift_open_blocking).toBe(1);

    expect(readState(tp.paths).state?.drift_open_blocking).toBe(1);
    expect(driftLog(tp)).toContain("requirement layer, BLOCKING");
    expect(driftLog(tp)).toContain("awaiting human decision");
  });
});

describe("REQ-DRIFT-003: drift ids auto-increment DRIFT-001 → DRIFT-002", () => {
  it("second add gets the next id", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const a = runDriftAdd(tp.paths, { layer: "derived", action: "x" });
    const b = runDriftAdd(tp.paths, { layer: "derived", action: "y" });
    expect(a.data?.id).toBe("DRIFT-001");
    expect(b.data?.id).toBe("DRIFT-002");
  });
});

describe("REQ-DRIFT-004: drift list parses entries and reports open blocking", () => {
  it("list returns parsed entries plus the open blocking count", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDriftAdd(tp.paths, { layer: "derived", ref: "SLICE-1 / TASK-001", discovery: "d1", action: "a1" });
    runDriftAdd(tp.paths, { layer: "requirement", ref: "SLICE-5 / TASK-031", discovery: "d2", action: "a2" });

    const res = runDriftList(tp.paths);
    expect(res.ok).toBe(true);
    const entries = res.data?.entries as Array<Record<string, string>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).toBe("DRIFT-001");
    expect(entries[0]!.layer).toBe("derived");
    expect(entries[0]!.ref).toBe("SLICE-1 / TASK-001");
    expect(entries[1]!.id).toBe("DRIFT-002");
    expect(entries[1]!.layer).toBe("requirement");
    expect(entries[1]!.discovery).toBe("d2");
    expect(res.data?.open_blocking).toBe(1);
  });
});

describe("REQ-DRIFT-005: resolve decrements drift_open_blocking (floor 0) and appends a note", () => {
  it("resolve a blocking drift → count back to 0, note appended", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDriftAdd(tp.paths, { layer: "requirement", action: "paused" });
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(1);

    const res = runDriftResolve(tp.paths, "DRIFT-001");
    expect(res.ok).toBe(true);
    expect(res.data?.drift_open_blocking).toBe(0);
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(0);
    expect(driftLog(tp)).toContain("## DRIFT-001 — resolved");
  });

  it("resolving a non-existent id returns drift_not_found (hardened validation)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // No drift entries exist → DRIFT-001 is not found.
    const res = runDriftResolve(tp.paths, "DRIFT-001");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("drift_not_found");
    // State unchanged.
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(0);
  });
});

describe("REQ-DRIFT-006: the log is append-only — earlier entries survive later adds", () => {
  it("a second add does not erase the first entry", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDriftAdd(tp.paths, { layer: "derived", discovery: "first discovery", action: "a1" });
    runDriftAdd(tp.paths, { layer: "derived", discovery: "second discovery", action: "a2" });

    const log = driftLog(tp);
    expect(log).toContain("## DRIFT-001");
    expect(log).toContain("first discovery");
    expect(log).toContain("## DRIFT-002");
    expect(log).toContain("second discovery");
  });
});

describe("REQ-DRIFT-008: drift resolve hardening — unknown id, double-resolve, derived layer", () => {
  it("resolving a derived entry does NOT change drift_open_blocking", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDriftAdd(tp.paths, { layer: "derived", action: "auto-applied" });

    const before = readState(tp.paths).state!.drift_open_blocking;
    const res = runDriftResolve(tp.paths, "DRIFT-001");
    expect(res.ok).toBe(true);
    // Derived entries do not affect the blocking counter.
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(before);
    expect(res.human).toContain("derived layer");
  });

  it("double-resolve is rejected with already_resolved", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDriftAdd(tp.paths, { layer: "requirement", action: "blocked" });
    runDriftResolve(tp.paths, "DRIFT-001");

    const res = runDriftResolve(tp.paths, "DRIFT-001");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("already_resolved");
  });

  it("resolving a requirement entry decrements the blocking counter", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDriftAdd(tp.paths, { layer: "requirement", action: "blocked" });
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(1);

    const res = runDriftResolve(tp.paths, "DRIFT-001");
    expect(res.ok).toBe(true);
    expect(readState(tp.paths).state?.drift_open_blocking).toBe(0);
    expect(res.human).toContain("requirement layer");
  });
});

describe("REQ-DRIFT-009: drift add --source", () => {
  it("custom source appears in the drift log heading", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runDriftAdd(tp.paths, {
      layer: "derived",
      ref: "SLICE-1 / TASK-001",
      source: "Orchestrator",
    });
    expect(res.ok).toBe(true);
    const log = fs.readFileSync(tp.paths.driftLog, "utf8");
    expect(log).toContain(", Orchestrator)");
  });

  it("default source (no --source) uses Builder in heading", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDriftAdd(tp.paths, { layer: "derived", ref: "SLICE-1 / TASK-001" });
    const log = fs.readFileSync(tp.paths.driftLog, "utf8");
    expect(log).toContain(", Builder)");
  });

  it("parseDriftEntries strips the source to keep only the ref", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDriftAdd(tp.paths, {
      layer: "derived",
      ref: "SLICE-2 / TASK-012",
      source: "Human",
      discovery: "found it",
    });
    const log = fs.readFileSync(tp.paths.driftLog, "utf8");
    const entries = parseDriftEntries(log);
    expect(entries[0]!.ref).toBe("SLICE-2 / TASK-012");
  });
});

describe("REQ-DRIFT-007: input/init failures", () => {
  it("add with an invalid layer → failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runDriftAdd(tp.paths, { layer: "bogus" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("invalid_layer");
  });

  it("add before init → failure not_initialized", () => {
    tp = makeTempProject();
    const res = runDriftAdd(tp.paths, { layer: "derived" });
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });

  it("resolve without an id → failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runDriftResolve(tp.paths, undefined).ok).toBe(false);
  });
});
