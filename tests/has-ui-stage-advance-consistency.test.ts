/**
 * Regression for the review HIGH on finding #13: the stage-advance WRITERS
 * (`th stage advance` / MCP `th_stage_advance`) must use the SAME has_ui-aware
 * oracle (`nextStageAfterFor`) that `th next` uses, so a no-UI run never lands on —
 * or worse, rewinds because of — a non-applicable UX/UI stage.
 *
 * The original #13 wiring left the writers on tier-only `nextStageAfter`, so a
 * has_ui:false project at `architecture` would be WRITTEN to `ux-design` (engaged by
 * tier, not applicable), and the next `th next` would then hit `nextStageAfterFor`
 * on a filtered-out current stage and REWIND to `requirements` (engaged[0]) — exactly
 * the gate/oracle disagreement class #2 closed. These tests pin the hardened oracle.
 */

import { describe, it, expect } from "vitest";
import { nextStageAfterFor, engagedStagesFor } from "../src/core/stages";

const noUi = { tier: "T1", has_ui: false } as const;
const withUi = { tier: "T1", has_ui: true } as const;

describe("#13 hardening: nextStageAfterFor is has_ui-aware and never rewinds on a filtered-out UI stage", () => {
  it("excludes the UX/UI stages from the engaged set when has_ui===false", () => {
    const stages = engagedStagesFor(noUi).map((s) => s.stage);
    expect(stages).not.toContain("ux-design");
    expect(stages).not.toContain("ui-design");
    // A T1 with UI still engages them (default/preserved behavior).
    expect(engagedStagesFor(withUi).map((s) => s.stage)).toContain("ux-design");
  });

  it("advances architecture → implementation-planning (skips UX/UI) on a no-UI run", () => {
    expect(nextStageAfterFor("architecture", noUi)?.stage).toBe("implementation-planning");
  });

  it("does NOT rewind when the current stage is a filtered-out UI stage", () => {
    // The bug: ux-design is filtered out, findIndex(-1) → engaged[0] === requirements.
    // The fix resolves by pipeline ordinal → the next APPLICABLE stage.
    expect(nextStageAfterFor("ux-design", noUi)?.stage).toBe("implementation-planning");
    expect(nextStageAfterFor("ui-design", noUi)?.stage).toBe("implementation-planning");
    // It must never resolve backwards to an earlier stage.
    expect(nextStageAfterFor("ux-design", noUi)?.stage).not.toBe("requirements");
  });

  it("preserves tier-engaged UX/UI ordering for a has_ui:true run", () => {
    expect(nextStageAfterFor("architecture", withUi)?.stage).toBe("ux-design");
    expect(nextStageAfterFor("ux-design", withUi)?.stage).toBe("ui-design");
  });

  it("maps a pre-pipeline current stage to the first applicable stage", () => {
    expect(nextStageAfterFor("init", noUi)?.stage).toBe("requirements");
  });

  it("returns undefined at the terminal applicable stage", () => {
    expect(nextStageAfterFor("final-verification", noUi)).toBeUndefined();
  });
});
