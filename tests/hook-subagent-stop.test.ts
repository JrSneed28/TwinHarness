import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runHookSubagentStop } from "../src/commands/hook";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";

/**
 * REQ-GATE-006: SubagentStop state-validity guard.
 *
 * When a delegated subagent (Spec, Critic, Builder, …) finishes a turn, the
 * SubagentStop hook mechanically checks that state.json is still valid. It is a
 * narrow guard (not the full completion gate — that is the top-level Stop hook):
 *   - no state.json  → allow  (non-TwinHarness projects / Tier-0 bypass)
 *   - invalid state  → block  (force a repair before downstream delegations)
 *   - valid state    → allow
 * Always exits 0; the JSON on stdout carries the decision.
 */

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-GATE-006: subagent-stop guards state validity", () => {
  it("allows when no state.json exists (non-TwinHarness project / Tier-0 bypass)", () => {
    tp = makeTempProject();
    const out = runHookSubagentStop(tp.paths);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({});
  });

  it("blocks when state.json is present but invalid", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(tp.paths.stateFile, "{ broken", "utf8");
    const out = runHookSubagentStop(tp.paths);
    expect(out.exitCode).toBe(0);
    const decision = JSON.parse(out.stdout);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("state.json");
  });

  it("allows when state.json is valid (freshly initialised)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const out = runHookSubagentStop(tp.paths);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({});
  });

  it("allows when state is valid even mid-build (it is not the completion gate)", () => {
    tp = makeTempProject();
    writeState(tp.paths, {
      ...initialState(),
      current_stage: "final-verification",
      // A pending slice would block the top-level Stop gate, but NOT subagent-stop.
      slices: [{ id: "SLICE-1", status: "pending", components: [] }],
      drift_open_blocking: 3,
    });
    const out = runHookSubagentStop(tp.paths);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({});
  });

  it("downgrades to a systemMessage (no hard block) when already looping (stop_hook_active)", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(tp.paths.stateFile, "{ broken", "utf8");

    // First pass (not yet looping) → hard block.
    expect(JSON.parse(runHookSubagentStop(tp.paths, {}).stdout).decision).toBe("block");

    // Already continuing because the hook blocked → allow, surface the reason.
    const second = JSON.parse(
      runHookSubagentStop(tp.paths, { stop_hook_active: true }).stdout,
    );
    expect(second.decision).toBeUndefined();
    expect(second.systemMessage).toContain("state.json");
  });
});
