/**
 * `th stage` — per-stage contract (Phase 3) — REQ-anchored.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runStageList, runStageDescribe, runStageCurrent } from "../src/commands/stage";
import { STAGE_PIPELINE } from "../src/core/stages";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-STAGE-001: stage list/describe", () => {
  it("list returns the whole pipeline", () => {
    const res = runStageList();
    expect(res.ok).toBe(true);
    expect((res.data?.stages as unknown[]).length).toBe(STAGE_PIPELINE.length);
  });

  it("describe returns a known stage's contract", () => {
    const res = runStageDescribe("architecture");
    expect(res.ok).toBe(true);
    const c = res.data?.stage as { humanGate: boolean; produces: string; criticMode: string };
    expect(c.humanGate).toBe(true);
    expect(c.produces).toBe("docs/04-architecture.md");
    expect(c.criticMode).toBe("architecture");
  });

  it("describe rejects an unknown stage", () => {
    const res = runStageDescribe("not-a-stage");
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unknown_stage");
  });
});

describe("REQ-STAGE-002: stage current reads state.current_stage", () => {
  it("a pre-pipeline stage (init) has no contract", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runStageCurrent(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.contract).toBeNull();
  });

  it("an engaged stage resolves its contract", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "current_stage", "contracts");
    const res = runStageCurrent(tp.paths);
    expect(res.ok).toBe(true);
    const c = res.data?.contract as { stage: string; humanGate: boolean };
    expect(c.stage).toBe("contracts");
    expect(c.humanGate).toBe(true); // auth choices are a blast-radius gate
  });
});
