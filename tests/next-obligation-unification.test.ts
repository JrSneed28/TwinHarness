/**
 * Phase 5 / P5-5 — unified "open human obligation" surface in `th next`
 * (REQ-PCO-063).
 *
 * Drift / debate / decision blocking counters are presented behind ONE
 * abstraction. Mechanics are unchanged — the ladder ordering and each rung's
 * `kind` are identical — so these tests pin only the new SURFACE: the unified
 * `obligations` summary in the data payload and the multi-obligation suffix.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runDriftAdd } from "../src/commands/drift";
import { runDebateAdd } from "../src/commands/debate";
import { runNext, openHumanObligations, type OpenHumanObligations } from "../src/commands/next";
import { readState } from "../src/core/state-store";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function obligationsOf(t: TempProject): OpenHumanObligations {
  const r = readState(t.paths);
  expect(r.state).toBeDefined();
  return openHumanObligations(t.paths, r.state!);
}

describe("REQ-PCO-063: openHumanObligations unifies drift/debate/decision", () => {
  it("REQ-PCO-063: a clean run owes zero obligations", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const o = obligationsOf(tp);
    expect(o).toEqual({ drift: 0, debate: 0, decision: 0, total: 0 });
  });

  it("REQ-PCO-063: a blocking drift contributes to the unified total", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDriftAdd(tp.paths, { layer: "requirement", ref: "SLICE-1 / TASK-1" });
    const o = obligationsOf(tp);
    expect(o.drift).toBeGreaterThanOrEqual(1);
    expect(o.total).toBe(o.drift + o.debate + o.decision);
  });

  it("REQ-PCO-063: drift AND debate both count toward the unified total", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // The debate ledger is an advanced feature gated at tier <T2 (SG3 P1-C / C-14);
    // record T2 so `runDebateAdd` reaches the ledger instead of refusing tier_locked.
    runStateSet(tp.paths, "tier", "T2", { emergency: true });
    runDriftAdd(tp.paths, { layer: "requirement", ref: "SLICE-1 / TASK-1" });
    runDebateAdd(tp.paths, { topic: "queue vs stream", links: "REQ-001" });
    const o = obligationsOf(tp);
    expect(o.drift).toBeGreaterThanOrEqual(1);
    expect(o.debate).toBeGreaterThanOrEqual(1);
    expect(o.total).toBe(o.drift + o.debate + o.decision);
  });
});

describe("REQ-PCO-063: th next surfaces the unified obligations payload", () => {
  it("REQ-PCO-063: the firing obligation rung carries the obligations summary in data", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDriftAdd(tp.paths, { layer: "requirement", ref: "SLICE-1 / TASK-1" });

    const res = runNext(tp.paths);
    expect(res.ok).toBe(true);
    // Mechanics unchanged: blocking drift still fires first.
    expect(res.data?.kind).toBe("resolve-blocking-drift");
    // Surface unified: the obligations summary is attached.
    const o = res.data?.obligations as OpenHumanObligations;
    expect(o).toBeDefined();
    expect(o.drift).toBeGreaterThanOrEqual(1);
    expect(o.total).toBe(o.drift + o.debate + o.decision);
  });

  it("REQ-PCO-063: a SINGLE obligation prints no unified suffix (output stays minimal)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDriftAdd(tp.paths, { layer: "requirement", ref: "SLICE-1 / TASK-1" });
    const res = runNext(tp.paths);
    expect(res.human).not.toContain("open human obligations:");
  });

  it("REQ-PCO-063: MULTIPLE obligation classes print one unified suffix from the firing rung", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // The debate ledger is an advanced feature gated at tier <T2 (SG3 P1-C / C-14);
    // record T2 so `runDebateAdd` reaches the ledger instead of refusing tier_locked.
    runStateSet(tp.paths, "tier", "T2", { emergency: true });
    runDriftAdd(tp.paths, { layer: "requirement", ref: "SLICE-1 / TASK-1" });
    runDebateAdd(tp.paths, { topic: "queue vs stream", links: "REQ-001" });

    const res = runNext(tp.paths);
    // Still fires the highest-priority rung (drift) — ordering unchanged.
    expect(res.data?.kind).toBe("resolve-blocking-drift");
    // But the human line now names the whole human-owed backlog in one place.
    expect(res.human).toContain("open human obligations:");
    expect(res.human).toContain("blocking drift");
    expect(res.human).toContain("open debate");
  });
});
