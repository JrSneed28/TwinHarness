import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { evaluateStopGate, runHookStopGate } from "../src/commands/hook";
import { readState, writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { writeVerifyConfig, writeVerifyReport } from "../src/core/verify";
import { runDecisionAdd, runDecisionApprove } from "../src/commands/decision";

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

describe("RULE-007: stop-gate blocks on an unapproved decision gating the current stage", () => {
  /** A fixed clock so audit timestamps are deterministic in tests. */
  const clock = (iso: string) => () => new Date(iso);

  /**
   * Settle the run at `stage` with NO other blockers: not at final-verification,
   * no blocking drift, no blocking debate, a valid tier and a non-pending slice.
   * So the decision gate is the only thing that can flip `block`.
   */
  function settledAt(p: TempProject, stage: string): void {
    const state = readState(p.paths).state!;
    state.tier = "T1";
    state.current_stage = stage;
    state.drift_open_blocking = 0;
    state.debate_open_blocking = 0;
    state.slices = [{ id: "SLICE-1", status: "done", components: [] }];
    writeState(p.paths, state);
  }

  it("blocks when a PROPOSED decision links the current stage (reason names the id + 'unapproved decision')", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    settledAt(tp, "architecture");

    runDecisionAdd(tp.paths, {
      title: "Decide architecture approach",
      rationale: "gates the architecture stage",
      links: ["stage:architecture"],
      now: clock("2026-06-15T00:00:00.000Z"),
    });

    const d = evaluateStopGate(tp.paths);
    expect(d.block).toBe(true);
    const reason = d.reasons.join(" ");
    expect(reason).toContain("DECISION-001");
    expect(reason).toContain("unapproved decision");
  });

  it("allows once that gating decision is APPROVED (no other blockers present)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    settledAt(tp, "architecture");

    runDecisionAdd(tp.paths, {
      title: "Decide architecture approach",
      rationale: "gates the architecture stage",
      links: ["stage:architecture"],
      now: clock("2026-06-15T00:00:00.000Z"),
    });
    // Blocked before approval.
    expect(evaluateStopGate(tp.paths).block).toBe(true);

    runDecisionApprove(tp.paths, "DECISION-001", {
      as: "alice",
      tty: { isTTY: true, stdinLine: "y" },
      now: clock("2026-06-15T01:00:00.000Z"),
    });

    // Cleared after approval.
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });

  it("does NOT block when a proposed decision links a DIFFERENT stage than current_stage", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    settledAt(tp, "architecture");

    // Linked to "stage:scope" while we sit at "architecture" → not a gate here.
    runDecisionAdd(tp.paths, {
      title: "Scope-stage decision",
      rationale: "gates a different stage",
      links: ["stage:scope"],
      now: clock("2026-06-15T00:00:00.000Z"),
    });

    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });
});
