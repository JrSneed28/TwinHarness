/**
 * FIX TEST — Finding #1 (tier-upgrade stage backfill).
 *
 * BUG (now fixed): upgrading a run's tier (e.g. T1→T3) left `current_stage`
 * untouched, so stages newly engaged by the higher tier that sit BEFORE the
 * current stage in the pipeline (e.g. domain-model, adrs, technical-design,
 * security, failure-modes) were silently skipped forever.
 *
 * FIX: `applyGateMutation` (src/commands/state.ts) — the shared locked+ledgered
 * gate writer every surface (the typed CLI commands + the MCP gate tools) routes
 * through — now detects a tier UPGRADE and, in the SAME atomic write, rewinds
 * `current_stage` to the EARLIEST stage that the new tier engages, the old tier
 * did NOT, and that sits at/before the run's current stage. The upgrade is NOT
 * refused (the approved resolution); the skipped stages are backfilled.
 *
 * `validateTierTransition` itself is intentionally UNCHANGED — it still allows the
 * upgrade. The backfill lives in the write path so every entry point inherits it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { writeState, readState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { applyGateMutation } from "../src/commands/state";
import { validateTierTransition } from "../src/core/gate-preconditions";
import { engagedStages, nextStageAfter, STAGE_PIPELINE } from "../src/core/stages";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("Finding #1 — tier upgrade backfills newly-engaged skipped stages", () => {
  it("validateTierTransition still ALLOWS the T1→T3 upgrade (backfill, not refusal)", () => {
    const s = { ...initialState(), tier: "T1" as const, current_stage: "implementation-planning" };
    // The approved resolution rewinds current_stage rather than refusing — the
    // transition validator itself stays permissive.
    expect(validateTierTransition(s, "T3")).toEqual({ ok: true });
  });

  it("structural: T3 engages stages before implementation-planning that T1 does not", () => {
    const t1 = engagedStages("T1").map((x) => x.stage);
    const t3 = engagedStages("T3").map((x) => x.stage);
    const t3Only = t3.filter((x) => !t1.includes(x));
    expect(t3Only.length).toBeGreaterThan(0);

    const implPlanIdx = STAGE_PIPELINE.findIndex((x) => x.stage === "implementation-planning");
    const beforeImplPlan = t3Only.filter((name) => {
      const idx = STAGE_PIPELINE.findIndex((x) => x.stage === name);
      return idx >= 0 && idx < implPlanIdx;
    });
    // The earliest such stage is domain-model (the first T2/T3-only stage).
    expect(beforeImplPlan).toContain("domain-model");
  });

  it("applyGateMutation({tier:T3}) at implementation-planning REWINDS current_stage to the earliest skipped stage", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeState(tp.paths, { ...initialState(), tier: "T1", current_stage: "implementation-planning" });

    const res = applyGateMutation(tp.paths, { tier: "T3" }, "test");
    expect(res.ok).toBe(true);

    const stored = readState(tp.paths).state!;
    expect(stored.tier).toBe("T3");
    // domain-model is the earliest stage T3 engages, T1 did not, that is before
    // implementation-planning in the pipeline.
    expect(stored.current_stage).toBe("domain-model");
  });

  it("applyGateMutation upgrade ledgers BOTH the tier flip and the current_stage rewind", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeState(tp.paths, { ...initialState(), tier: "T1", current_stage: "implementation-planning" });

    const res = applyGateMutation(tp.paths, { tier: "T3" }, "th tier record");
    expect(res.ok).toBe(true);
    const fields = (res.data as { fields: Record<string, unknown> }).fields;
    expect(fields.tier).toBe("T3");
    expect(fields.current_stage).toBe("domain-model");
  });

  it("NO backfill when the upgrade engages nothing the run has already passed (current at requirements)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // requirements is engaged by every tier and is the first pipeline stage, so a
    // T1→T3 upgrade newly-engages nothing at/before it.
    writeState(tp.paths, { ...initialState(), tier: "T1", current_stage: "requirements" });

    applyGateMutation(tp.paths, { tier: "T3" }, "test");
    const stored = readState(tp.paths).state!;
    expect(stored.tier).toBe("T3");
    expect(stored.current_stage).toBe("requirements");
  });

  it("NO backfill on a from-null classification while still at the pre-pipeline init stage", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Fresh init: tier null, current_stage 'init' (pre-pipeline). Classifying to T3
    // must not rewind, because nothing has been passed yet.
    applyGateMutation(tp.paths, { tier: "T3" }, "test");
    const stored = readState(tp.paths).state!;
    expect(stored.tier).toBe("T3");
    expect(stored.current_stage).toBe("init");
  });

  it("nextStageAfter is unchanged (the fix lives in the write path, not stage math)", () => {
    expect(nextStageAfter("implementation-planning", "T3")?.stage).toBe("implementation");
  });
});
