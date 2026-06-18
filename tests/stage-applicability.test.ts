/**
 * REGRESSION TEST — Finding #13 (FIXED)
 *
 * Previously "ux-design" and "ui-design" were engaged for ALL tiers (T1/T2/T3) with
 * no `has_ui` flag, so a no-UI project was forced through the UX/UI stages with no
 * way to mark them N/A.
 *
 * FIX (audit fix pass): a mechanical `has_ui?: boolean` flag was added to the state
 * schema (absent ⇒ true, preserving today's behaviour). The tier-only
 * `engagedStages(tier)` / `nextStageAfter` signatures are UNCHANGED (other callers
 * depend on them); UI applicability is a SEPARATE axis exposed via `engagedStagesFor`
 * and `nextStageAfterFor`. When `has_ui === false` the ux-design/ui-design stages are
 * NOT applicable (mechanically satisfied as "N/A — no UI surface" by exclusion) rather
 * than silently skipped.
 */

import { describe, it, expect } from "vitest";
import {
  engagedStages,
  engagedStagesFor,
  nextStageAfterFor,
  projectHasUi,
  STAGE_PIPELINE,
} from "../src/core/stages";
import { validateState, initialState } from "../src/core/state-schema";
import type { TwinHarnessState } from "../src/core/state-schema";

describe("Finding #13 — UX/UI stages gated by has_ui (regression)", () => {
  it("engagedStages(tier) stays tier-only and still includes ux/ui for T1/T2/T3", () => {
    // The tier-only signature is unchanged (typed gate tools depend on it).
    for (const tier of ["T1", "T2", "T3"] as const) {
      const stages = engagedStages(tier).map((s) => s.stage);
      expect(stages).toContain("ux-design");
      expect(stages).toContain("ui-design");
    }
  });

  it("engagedStagesFor(has_ui:true) INCLUDES ux-design and ui-design", () => {
    const stages = engagedStagesFor({ tier: "T2", has_ui: true }).map((s) => s.stage);
    expect(stages).toContain("ux-design");
    expect(stages).toContain("ui-design");
  });

  it("engagedStagesFor(has_ui absent) defaults to true → INCLUDES ux-design and ui-design", () => {
    const stages = engagedStagesFor({ tier: "T2" }).map((s) => s.stage);
    expect(stages).toContain("ux-design");
    expect(stages).toContain("ui-design");
  });

  it("engagedStagesFor(has_ui:false) EXCLUDES ux-design and ui-design (mechanically N/A)", () => {
    for (const tier of ["T1", "T2", "T3"] as const) {
      const stages = engagedStagesFor({ tier, has_ui: false }).map((s) => s.stage);
      expect(stages).not.toContain("ux-design");
      expect(stages).not.toContain("ui-design");
    }
  });

  it("projectHasUi: true by default/when true, false only when explicitly false", () => {
    expect(projectHasUi({})).toBe(true);
    expect(projectHasUi({ has_ui: true })).toBe(true);
    expect(projectHasUi({ has_ui: false })).toBe(false);
  });

  it("nextStageAfterFor skips the not-applicable UX/UI stages when has_ui:false", () => {
    // After `architecture`, a UI project goes to ux-design; a no-UI project skips it.
    const withUi = nextStageAfterFor("architecture", { tier: "T2", has_ui: true });
    expect(withUi?.stage).toBe("ux-design");

    const noUi = nextStageAfterFor("architecture", { tier: "T2", has_ui: false });
    expect(noUi?.stage).not.toBe("ux-design");
    expect(noUi?.stage).not.toBe("ui-design");
  });

  it("the state schema now accepts has_ui (boolean) and rejects a non-boolean", () => {
    expect(validateState({ ...initialState(), has_ui: true }).ok).toBe(true);
    expect(validateState({ ...initialState(), has_ui: false }).ok).toBe(true);
    const bad = validateState({ ...initialState(), has_ui: "yes" });
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.path === "has_ui")).toBe(true);
  });

  it("has_ui is optional — a freshly-initialized state omits it (absent ⇒ true semantics)", () => {
    // initialState does not write has_ui, preserving byte-identical serialization for
    // existing state files; absence is interpreted as `true` by projectHasUi.
    const state: TwinHarnessState = initialState();
    expect("has_ui" in state).toBe(false);
    expect(projectHasUi(state)).toBe(true);
  });

  it("the STAGE_PIPELINE summaries still mark the UX/UI stages 'Conditional on a UI'", () => {
    const ux = STAGE_PIPELINE.find((s) => s.stage === "ux-design")!;
    const ui = STAGE_PIPELINE.find((s) => s.stage === "ui-design")!;
    expect(ux.summary).toContain("Conditional on a UI");
    expect(ui.summary).toContain("Conditional on a UI");
  });
});
