import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { evaluateStopGate, runHookStopGate } from "../src/commands/hook";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { writeVerifyConfig, writeVerifyReport } from "../src/core/verify";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-GATE-001: stop-gate blocks premature completion (pre-mortem #2)", () => {
  it("allows when no TwinHarness run is active (no state.json)", () => {
    tp = makeTempProject();
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });

  it("blocks when state.json is present but invalid", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(tp.paths.stateFile, "{ broken", "utf8");
    const d = evaluateStopGate(tp.paths);
    expect(d.block).toBe(true);
    expect(d.reasons.length).toBeGreaterThan(0);
  });

  it("allows when state is valid and there is no blocking drift", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });

  it("blocks when there is open blocking drift (§10)", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), drift_open_blocking: 1 });
    expect(evaluateStopGate(tp.paths).block).toBe(true);
  });

  it("runHookStopGate emits a Claude Code decision payload", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const allow = runHookStopGate(tp.paths);
    expect(allow.exitCode).toBe(0);
    expect(JSON.parse(allow.stdout)).toEqual({});

    writeState(tp.paths, { ...initialState(), drift_open_blocking: 2 });
    expect(JSON.parse(runHookStopGate(tp.paths).stdout).decision).toBe("block");
  });

  it("blocks at most once per stop sequence: stop_hook_active downgrades to a systemMessage", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), drift_open_blocking: 1 });

    // First stop attempt (stop_hook_active absent/false) → hard block.
    expect(JSON.parse(runHookStopGate(tp.paths, {}).stdout).decision).toBe("block");
    expect(JSON.parse(runHookStopGate(tp.paths, { stop_hook_active: false }).stdout).decision).toBe("block");

    // Already continuing because of a stop hook → allow, but surface the reasons.
    const second = JSON.parse(runHookStopGate(tp.paths, { stop_hook_active: true }).stdout);
    expect(second.decision).toBeUndefined();
    expect(second.systemMessage).toContain("BLOCKING drift");
  });

  it("stop_hook_active does not alter a clean allow", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(JSON.parse(runHookStopGate(tp.paths, { stop_hook_active: true }).stdout)).toEqual({});
  });

  // F6: final-verification slice-completion gate
  it("blocks at final-verification when a slice is still pending", () => {
    tp = makeTempProject();
    writeState(tp.paths, {
      ...initialState(),
      current_stage: "final-verification",
      slices: [{ id: "SLICE-1", status: "pending", components: [] }],
    });
    const d = evaluateStopGate(tp.paths);
    expect(d.block).toBe(true);
    expect(d.reasons[0]).toContain("SLICE-1");
    expect(d.reasons[0]).toContain("final-verification");
  });

  it("allows at final-verification when all slices are done or blocked", () => {
    tp = makeTempProject();
    writeState(tp.paths, {
      ...initialState(),
      current_stage: "final-verification",
      slices: [
        { id: "SLICE-1", status: "done", components: [] },
        { id: "SLICE-2", status: "blocked", components: [] },
      ],
    });
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });

  it("does NOT block at a non-final stage even with pending slices", () => {
    tp = makeTempProject();
    writeState(tp.paths, {
      ...initialState(),
      current_stage: "implementation",
      slices: [
        { id: "SLICE-1", status: "pending", components: [] },
        { id: "SLICE-2", status: "in-progress", components: [] },
      ],
    });
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });
});

describe("REQ-GATE-005: final-verification requires a green verify suite when one is configured", () => {
  function settledAtFinal(tp: TempProject): void {
    writeState(tp.paths, {
      ...initialState(),
      current_stage: "final-verification",
      slices: [{ id: "SLICE-1", status: "done", components: [] }],
    });
  }

  it("no verify commands configured → suite check is inert (allows)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    settledAtFinal(tp);
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });

  it("commands configured but no report → blocks (never run)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeVerifyConfig(tp.paths, { commands: ["npm test"] });
    settledAtFinal(tp);
    const d = evaluateStopGate(tp.paths);
    expect(d.block).toBe(true);
    expect(d.reasons[0]).toContain("never been recorded");
  });

  it("a RED report → blocks", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeVerifyConfig(tp.paths, { commands: ["npm test"] });
    writeVerifyReport(tp.paths, { ok: false, ranAt: "2026-06-13T00:00:00.000Z", results: [{ command: "npm test", exitCode: 1, ok: false, durationMs: 1, outputTail: "fail" }] });
    settledAtFinal(tp);
    const d = evaluateStopGate(tp.paths);
    expect(d.block).toBe(true);
    expect(d.reasons[0]).toContain("RED");
  });

  it("a GREEN report → allows", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeVerifyConfig(tp.paths, { commands: ["npm test"] });
    writeVerifyReport(tp.paths, { ok: true, ranAt: "2026-06-13T00:00:00.000Z", results: [{ command: "npm test", exitCode: 0, ok: true, durationMs: 1, outputTail: "" }] });
    settledAtFinal(tp);
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });
});
