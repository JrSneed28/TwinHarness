/**
 * `th preview` — the pre-run pipeline-shape view (G6) — REQ-anchored.
 *
 * Verifies tier resolution (flag → state → T2 default), that the engaged stages
 * for a tier are listed in pipeline order with their human gates and Critic
 * modes, and that the summary line counts stages/gates/reviews correctly. The
 * command is read-only — it must never mutate state.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState, writeState } from "../src/core/state-store";
import { engagedStages } from "../src/core/stages";
import { runPreview } from "../src/commands/preview";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

interface PreviewStage {
  stage: string;
  produces: string;
  criticMode: string;
  humanGate: boolean;
}
const stages = (data: unknown): PreviewStage[] => (data as { stages: PreviewStage[] }).stages;

describe("REQ-PREVIEW-001: lists engaged stages and gates for a tier", () => {
  it("a --tier flag lists exactly that tier's engaged stages in pipeline order", () => {
    tp = makeTempProject();
    const res = runPreview(tp.paths, { tier: "T2" });
    expect(res.ok).toBe(true);
    expect(res.data?.tier).toBe("T2");
    expect(res.data?.tierSource).toBe("flag");

    // Must match the canonical engaged-stage list for T2, in order.
    const expected = engagedStages("T2").map((s) => s.stage);
    expect(stages(res.data).map((s) => s.stage)).toEqual(expected);

    // T2 does NOT engage T3-only stages.
    const ids = stages(res.data).map((s) => s.stage);
    expect(ids).not.toContain("adrs");
    expect(ids).not.toContain("security");
    // ...but DOES engage T2 stages.
    expect(ids).toContain("domain-model");
    expect(ids).toContain("contracts");
  });

  it("marks which stages carry a human gate and which Critic mode reviews each", () => {
    tp = makeTempProject();
    const res = runPreview(tp.paths, { tier: "T2" });
    const requirements = stages(res.data).find((s) => s.stage === "requirements");
    const domain = stages(res.data).find((s) => s.stage === "domain-model");
    expect(requirements?.humanGate).toBe(true);
    expect(requirements?.criticMode).toBe("requirements");
    expect(domain?.humanGate).toBe(false); // domain-model streams (no human gate)
    expect(domain?.criticMode).toBe("domain-model");
  });

  it("the summary line counts stages, human gates, and Critic reviews", () => {
    tp = makeTempProject();
    const res = runPreview(tp.paths, { tier: "T2" });
    const engaged = engagedStages("T2");
    const gates = engaged.filter((s) => s.humanGate).length;
    expect(res.data?.humanGates).toBe(gates);
    expect(res.data?.criticReviews).toBe(engaged.length); // every engaged stage has a Critic mode
    expect(res.data?.summary).toBe(`T2: ${engaged.length} stages, ${gates} human gates, ${engaged.length} Critic reviews`);
    expect(res.human).toContain(`T2: ${engaged.length} stages`);
  });
});

describe("REQ-PREVIEW-002: tier resolution falls back state → T2 default", () => {
  it("with no flag, uses the recorded state.tier", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // tier is gate-owned (#11): position it with the ungated low-level writer.
    writeState(tp.paths, { ...readState(tp.paths).state!, tier: "T3" });
    const res = runPreview(tp.paths, {});
    expect(res.data?.tier).toBe("T3");
    expect(res.data?.tierSource).toBe("state");
    // T3 engages the full pipeline (e.g. adrs/security/technical-design).
    expect(stages(res.data).map((s) => s.stage)).toContain("adrs");
  });

  it("with no flag and no classified tier, defaults to T2 and notes it", () => {
    tp = makeTempProject();
    runInit(tp.paths, {}); // tier is null after init
    const res = runPreview(tp.paths, {});
    expect(res.data?.tier).toBe("T2");
    expect(res.data?.tierSource).toBe("default");
    expect(res.human).toMatch(/default/i);
  });

  it("with no run at all, still defaults to the T2 pipeline", () => {
    tp = makeTempProject();
    const res = runPreview(tp.paths, {});
    expect(res.ok).toBe(true);
    expect(res.data?.tier).toBe("T2");
    expect(res.data?.tierSource).toBe("default");
  });
});

describe("REQ-PREVIEW-003: T0 bypasses the pipeline; read-only", () => {
  it("T0 engages no stages, gates, or reviews", () => {
    tp = makeTempProject();
    const res = runPreview(tp.paths, { tier: "T0" });
    expect(stages(res.data)).toEqual([]);
    expect(res.data?.humanGates).toBe(0);
    expect(res.data?.criticReviews).toBe(0);
    expect(res.data?.summary).toBe("T0: 0 stages, 0 human gates, 0 Critic reviews");
    expect(res.human).toMatch(/bypass/i);
  });

  it("preview never mutates state.json", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeState(tp.paths, { ...readState(tp.paths).state!, tier: "T2" });
    const before = fs.readFileSync(tp.paths.stateFile, "utf8");
    runPreview(tp.paths, { tier: "T3" });
    runPreview(tp.paths, {});
    expect(fs.readFileSync(tp.paths.stateFile, "utf8")).toBe(before);
  });
});
