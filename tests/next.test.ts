/**
 * `th next` — the next-action oracle — REQ-anchored.
 *
 * Verifies the priority ordering of mechanical obligations and that each one is a
 * computation over durable state, never a strategy decision.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runDriftAdd } from "../src/commands/drift";
import { runReviseBump } from "../src/commands/revise";
import { runArtifactRegister } from "../src/commands/artifact";
import { runSlicesSync } from "../src/commands/slices";
import { runVerifyAdd, runVerifyRun } from "../src/commands/verify";
import { runNext } from "../src/commands/next";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function writeFile(t: TempProject, rel: string, content: string): void {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

describe("REQ-NEXT-001: no run / invalid state", () => {
  it("uninitialized dir → kind init", () => {
    tp = makeTempProject();
    expect(runNext(tp.paths).data?.kind).toBe("init");
  });

  it("invalid state.json → kind fix-state", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    fs.writeFileSync(tp.paths.stateFile, "{ not json");
    expect(runNext(tp.paths).data?.kind).toBe("fix-state");
  });
});

describe("REQ-NEXT-002: blocking drift outranks everything else", () => {
  it("open blocking drift → kind resolve-blocking-drift", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    runDriftAdd(tp.paths, { layer: "requirement", ref: "SLICE-1 / TASK-1", discovery: "x", action: "paused" });
    expect(runNext(tp.paths).data?.kind).toBe("resolve-blocking-drift");
  });
});

describe("REQ-NEXT-003: a revise loop at cap escalates to the human", () => {
  it("revise count >= cap → kind escalate-revise", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    runReviseBump(tp.paths, "architecture");
    runReviseBump(tp.paths, "architecture");
    runReviseBump(tp.paths, "architecture"); // count 3 == default cap
    expect(runNext(tp.paths).data?.kind).toBe("escalate-revise");
  });
});

describe("REQ-NEXT-004: tier must be classified before stages run", () => {
  it("tier null → kind classify-tier", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runNext(tp.paths).data?.kind).toBe("classify-tier");
  });
});

describe("REQ-NEXT-005: current stage owes its produced artifact", () => {
  it("at requirements with no artifact on disk → kind produce-artifact", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    runStateSet(tp.paths, "current_stage", "requirements");
    expect(runNext(tp.paths).data?.kind).toBe("produce-artifact");
  });

  it("artifact exists but unregistered → kind register-artifact", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    runStateSet(tp.paths, "current_stage", "requirements");
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    expect(runNext(tp.paths).data?.kind).toBe("register-artifact");
  });

  it("artifact produced + registered → advances to the next engaged stage", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    runStateSet(tp.paths, "current_stage", "requirements");
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);
    const res = runNext(tp.paths);
    expect(res.data?.kind).toBe("advance-stage");
    // Next engaged stage after requirements for T2 is scope.
    expect(res.data?.to).toBe("scope");
  });
});

describe("REQ-NEXT-006: re-register a silently changed artifact before advancing", () => {
  it("registered artifact edited on disk → kind re-register-artifact", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    runStateSet(tp.paths, "current_stage", "requirements");
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);
    // Edit after registration → drift.
    writeFile(tp, "docs/01-requirements.md", "REQ-001 changed.\n");
    expect(runNext(tp.paths).data?.kind).toBe("re-register-artifact");
  });
});

describe("REQ-NEXT-008: a failing suite routes to the Debugger before advancing", () => {
  it("verify report failing → kind investigate-failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    runVerifyAdd(tp.paths, "false");
    runVerifyRun(tp.paths);
    expect(runNext(tp.paths).data?.kind).toBe("investigate-failure");
  });
});

describe("REQ-NEXT-009: implementation stage dispatches build waves", () => {
  it("pending slices at implementation → kind dispatch-wave", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    runStateSet(tp.paths, "current_stage", "implementation");
    runStateSet(tp.paths, "slices", JSON.stringify([{ id: "SLICE-1", status: "pending", components: ["api"] }]));
    expect(runNext(tp.paths).data?.kind).toBe("dispatch-wave");
  });

  it("only in-progress slices remain → kind await-builders", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    runStateSet(tp.paths, "current_stage", "implementation");
    runStateSet(tp.paths, "slices", JSON.stringify([{ id: "SLICE-1", status: "in-progress", components: ["api"] }]));
    expect(runNext(tp.paths).data?.kind).toBe("await-builders");
  });
});

describe("REQ-NEXT-007: final-verification floor — slices then coverage then sign-off", () => {
  it("unfinished slices at final-verification → kind finish-slices", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T1");
    writeFile(tp, "docs/09-implementation-plan.md", "### SLICE-1\nComponents touched: api\n");
    runSlicesSync(tp.paths, { planFile: "docs/09-implementation-plan.md" });
    runStateSet(tp.paths, "current_stage", "final-verification");
    expect(runNext(tp.paths).data?.kind).toBe("finish-slices");
  });
});
