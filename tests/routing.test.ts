import { describe, it, expect } from "vitest";
import { computeRoute } from "../src/core/routing";

/**
 * The routing table moved from prose into code (spec §2). These cases pin every
 * row of the old SKILL.md/orchestrator.md table so the code is provably equivalent.
 */
describe("computeRoute", () => {
  it("trivial summarization → haiku/low", () => {
    expect(computeRoute({ summarization: true })).toMatchObject({ model: "haiku", effort: "low" });
  });

  it("default → sonnet/medium, a notch higher on T3", () => {
    expect(computeRoute({})).toMatchObject({ model: "sonnet", effort: "medium" });
    expect(computeRoute({ tier: "T2" })).toMatchObject({ model: "sonnet", effort: "medium" });
    expect(computeRoute({ tier: "T3" })).toMatchObject({ model: "sonnet", effort: "high" });
  });

  it("heavy design mode escalates to opus on T3 OR blast", () => {
    expect(computeRoute({ agent: "spec", mode: "architecture", tier: "T3" })).toMatchObject({
      model: "opus",
      effort: "high",
    });
    expect(
      computeRoute({ agent: "spec", mode: "technical-design", tier: "T2", blastFlags: ["money"] }),
    ).toMatchObject({ model: "opus", effort: "high" });
    // T3 AND blast → xhigh
    expect(
      computeRoute({ agent: "spec", mode: "failure-modes", tier: "T3", blastFlags: ["data-integrity"] }),
    ).toMatchObject({ model: "opus", effort: "xhigh" });
  });

  it("security design on a T3 blast-radius project → opus/max (the most extreme)", () => {
    expect(
      computeRoute({ agent: "spec", mode: "security", tier: "T3", blastFlags: ["authentication"] }),
    ).toMatchObject({ model: "opus", effort: "max" });
  });

  it("a heavy design mode with neither T3 nor blast does NOT escalate", () => {
    expect(computeRoute({ agent: "spec", mode: "architecture", tier: "T2" })).toMatchObject({
      model: "sonnet",
    });
  });

  it("critic escalates to opus only in slice/code-review on a blast-radius project", () => {
    expect(
      computeRoute({ agent: "critic", mode: "code-review", blastFlags: ["migrations"] }),
    ).toMatchObject({ model: "opus", effort: "high" });
    expect(computeRoute({ agent: "critic", mode: "slice", blastFlags: ["money"] })).toMatchObject({
      model: "opus",
    });
    // No blast → not escalated.
    expect(computeRoute({ agent: "critic", mode: "code-review" })).toMatchObject({ model: "sonnet" });
    // Critic in a design mode is NOT the spec design-escalation (excluded).
    expect(computeRoute({ agent: "critic", mode: "architecture", tier: "T3" })).toMatchObject({
      model: "sonnet",
    });
  });

  it("builder escalates to opus on a blast-radius component", () => {
    expect(computeRoute({ agent: "builder", componentBlast: true })).toMatchObject({
      model: "opus",
      effort: "high",
    });
    expect(computeRoute({ agent: "builder", blastFlags: ["authorization"] })).toMatchObject({
      model: "opus",
    });
    expect(computeRoute({ agent: "builder" })).toMatchObject({ model: "sonnet" });
  });

  it("orchestrator & vertical-slice default to opus", () => {
    expect(computeRoute({ agent: "orchestrator" })).toMatchObject({ model: "opus", effort: "medium" });
    expect(computeRoute({ agent: "orchestrator", tier: "T3" })).toMatchObject({
      model: "opus",
      effort: "high",
    });
    expect(computeRoute({ agent: "vertical-slice" })).toMatchObject({ model: "opus" });
  });

  it("is total and deterministic", () => {
    const a = computeRoute({ agent: "spec", mode: "security", tier: "T3", blastFlags: ["money"] });
    const b = computeRoute({ agent: "spec", mode: "security", tier: "T3", blastFlags: ["money"] });
    expect(a).toEqual(b);
  });
});
