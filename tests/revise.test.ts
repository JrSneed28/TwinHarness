import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runReviseBump, runReviseStatus, runReviseReset, DEFAULT_REVISE_CAP } from "../src/commands/revise";
import { readState } from "../src/core/state-store";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function init(): TempProject {
  const t = makeTempProject();
  runInit(t.paths, {});
  return t;
}

describe("REQ-REVISE: mechanical revise-loop cap (spec §18)", () => {
  it("REQ-REVISE-001: bump increments from 0 -> 1 -> 2 and persists", () => {
    tp = init();
    const r1 = runReviseBump(tp.paths, "requirements");
    expect(r1.ok).toBe(true);
    expect(r1.data?.count).toBe(1);
    expect(r1.data?.escalate).toBe(false);
    expect(readState(tp.paths).state?.revise_loop_counts.requirements).toBe(1);

    const r2 = runReviseBump(tp.paths, "requirements");
    expect(r2.data?.count).toBe(2);
    expect(r2.data?.escalate).toBe(false);
    expect(readState(tp.paths).state?.revise_loop_counts.requirements).toBe(2);
  });

  it("REQ-REVISE-002: default cap is 3", () => {
    tp = init();
    const r = runReviseStatus(tp.paths, "requirements");
    expect(r.data?.cap).toBe(3);
    expect(DEFAULT_REVISE_CAP).toBe(3);
  });

  it("REQ-REVISE-003: hitting the cap (3) flips escalate true", () => {
    tp = init();
    runReviseBump(tp.paths, "requirements"); // 1
    runReviseBump(tp.paths, "requirements"); // 2
    const r3 = runReviseBump(tp.paths, "requirements"); // 3
    expect(r3.data?.count).toBe(3);
    expect(r3.data?.escalate).toBe(true);
  });

  it("REQ-REVISE-004: escalate stays true past the cap", () => {
    tp = init();
    runReviseBump(tp.paths, "architecture"); // 1
    runReviseBump(tp.paths, "architecture"); // 2
    runReviseBump(tp.paths, "architecture"); // 3 -> escalate
    const r4 = runReviseBump(tp.paths, "architecture"); // 4
    expect(r4.data?.count).toBe(4);
    expect(r4.data?.escalate).toBe(true);
  });

  it("REQ-REVISE-005: status does NOT mutate state", () => {
    tp = init();
    runReviseBump(tp.paths, "slice"); // 1
    const before = readState(tp.paths).state?.revise_loop_counts.slice;
    const r = runReviseStatus(tp.paths, "slice");
    expect(r.ok).toBe(true);
    expect(r.data?.count).toBe(1);
    expect(r.data?.escalate).toBe(false);
    expect(readState(tp.paths).state?.revise_loop_counts.slice).toBe(before);
  });

  it("REQ-REVISE-006: status on an unseen mode reports 0 without writing", () => {
    tp = init();
    const r = runReviseStatus(tp.paths, "never-touched");
    expect(r.ok).toBe(true);
    expect(r.data?.count).toBe(0);
    expect(r.data?.escalate).toBe(false);
    expect(readState(tp.paths).state?.revise_loop_counts["never-touched"]).toBeUndefined();
  });

  it("REQ-REVISE-007: reset zeroes the count and persists", () => {
    tp = init();
    runReviseBump(tp.paths, "requirements"); // 1
    runReviseBump(tp.paths, "requirements"); // 2
    const r = runReviseReset(tp.paths, "requirements");
    expect(r.ok).toBe(true);
    expect(r.data?.count).toBe(0);
    expect(readState(tp.paths).state?.revise_loop_counts.requirements).toBe(0);
  });

  it("REQ-REVISE-008: explicit --cap override changes the escalate boundary", () => {
    tp = init();
    const r1 = runReviseBump(tp.paths, "requirements", 1); // 1 >= cap 1
    expect(r1.data?.cap).toBe(1);
    expect(r1.data?.count).toBe(1);
    expect(r1.data?.escalate).toBe(true);

    // A higher cap defers escalation.
    const s = runReviseStatus(tp.paths, "requirements", 5);
    expect(s.data?.cap).toBe(5);
    expect(s.data?.count).toBe(1);
    expect(s.data?.escalate).toBe(false);
  });

  it("REQ-REVISE-009: missing mode is treated as 0 on first bump", () => {
    tp = init();
    const r = runReviseBump(tp.paths, "brand-new-mode");
    expect(r.data?.count).toBe(1);
  });

  it("REQ-REVISE-010: not_initialized error on an empty project", () => {
    const empty = makeTempProject();
    expect(runReviseBump(empty.paths, "requirements").data?.error).toBe("not_initialized");
    expect(runReviseStatus(empty.paths, "requirements").data?.error).toBe("not_initialized");
    expect(runReviseReset(empty.paths, "requirements").data?.error).toBe("not_initialized");
    expect(runReviseBump(empty.paths, "requirements").ok).toBe(false);
    empty.cleanup();
  });
});
