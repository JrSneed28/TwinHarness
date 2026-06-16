/**
 * Decision-gating survives stage normalization (F-6 item 2c).
 *
 * Normalizing current_stage (F-5) and canonicalizing stage links must not let a
 * gating decision silently stop gating because of a near-miss spelling on either
 * side. gatingObligations canonicalizes both the wanted `stage:<current_stage>`
 * and each decision link.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runDecisionAdd, runDecisionCheck, DECISION_GATE_EXIT } from "../src/commands/decision";
import { readState, writeState } from "../src/core/state-store";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Write current_stage DIRECTLY (bypassing th state set normalization) to model a
 *  non-canonical stage on disk. */
function forceStage(p: TempProject, stage: string): void {
  const s = readState(p.paths).state!;
  s.current_stage = stage;
  writeState(p.paths, s);
}

describe("F-6 item 2c: gating survives stage normalization", () => {
  it("link stage:final-verification still gates when current_stage is the 10-final-verification near-miss", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDecisionAdd(tp.paths, {
      title: "gates fv",
      rationale: "r",
      links: ["stage:final-verification"],
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    forceStage(tp, "10-final-verification");

    const r = runDecisionCheck(tp.paths, {});
    expect(r.exitCode).toBe(DECISION_GATE_EXIT);
    expect(r.data?.error).toBe("unapproved_gating");
    expect((r.data?.gating as Array<{ decisionId: string }>)[0]!.decisionId).toBe("DECISION-001");
  });

  it("a link recorded as the near-miss stage:10-final-verification still gates at canonical current_stage", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runDecisionAdd(tp.paths, {
      title: "gates fv",
      rationale: "r",
      links: ["stage:10-final-verification"],
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    forceStage(tp, "final-verification");

    expect(runDecisionCheck(tp.paths, {}).exitCode).toBe(DECISION_GATE_EXIT);
  });
});
