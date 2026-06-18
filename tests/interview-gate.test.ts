/**
 * REGRESSION TEST — Finding #14 (FIXED): the interview is now a SOFT gate.
 *
 * Previously the clarity interview computed `ready` but nothing consumed it, so a
 * run could advance past `requirements` with the interview unfinished.
 *
 * FIX (audit fix pass): a `checkInterview` rung was added to the advancement ladder
 * (`canAdvanceStage`, right after `checkTierSet`). While an interview is REQUIRED
 * (`interview_required`, or computed true for T2/T3) AND not yet ready, advancement
 * past `requirements` is refused with `interview_incomplete`, and `th next` emits a
 * `complete-interview` action. Once the interview is ready — or it is not required —
 * advancement is allowed. It is a SOFT, front-loaded gate: stages already past
 * `requirements` are never blocked by it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { writeState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { checkInterview, interviewRequired, canAdvanceStage } from "../src/core/gate-preconditions";
import { runInterviewStart, runInterviewRecord } from "../src/commands/interview";
import { runNext } from "../src/commands/next";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Drive the interview store to a READY state (ambiguity ≤ threshold). */
function makeInterviewReady(paths: TempProject["paths"]): void {
  runInterviewStart(paths, { idea: "build a thing", threshold: 0.2 });
  runInterviewRecord(paths, {
    question: "q",
    answer: "a",
    scores: { goal: 0.95, constraints: 0.95, criteria: 0.9 },
    ambiguity: 0.08,
  });
}

function reqStateT2(): TwinHarnessState {
  return { ...initialState(), tier: "T2", current_stage: "requirements" };
}

describe("Finding #14 — interview soft gate (regression)", () => {
  it("interviewRequired: computed true for T2/T3, false for T0/T1/unclassified; explicit boolean wins", () => {
    expect(interviewRequired({ tier: "T2" })).toBe(true);
    expect(interviewRequired({ tier: "T3" })).toBe(true);
    expect(interviewRequired({ tier: "T1" })).toBe(false);
    expect(interviewRequired({ tier: "T0" })).toBe(false);
    expect(interviewRequired({ tier: null })).toBe(false);
    // explicit override
    expect(interviewRequired({ tier: "T1", interview_required: true })).toBe(true);
    expect(interviewRequired({ tier: "T3", interview_required: false })).toBe(false);
  });

  it("REFUSES advancement past requirements when required & not ready", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const s = reqStateT2();
    writeState(tp.paths, s);

    const gate = checkInterview(tp.paths, s);
    expect(gate.ok).toBe(false);
    expect(gate.error).toBe("interview_incomplete");

    // The full ladder also refuses (the rung is wired into canAdvanceStage).
    expect(canAdvanceStage(tp.paths, s).error).toBe("interview_incomplete");
  });

  it("`th next` emits a complete-interview action when required & not ready", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeState(tp.paths, reqStateT2());

    const action = runNext(tp.paths).data as { kind: string };
    expect(action.kind).toBe("complete-interview");
  });

  it("ALLOWS advancement once the interview is ready", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const s = reqStateT2();
    writeState(tp.paths, s);
    makeInterviewReady(tp.paths);

    expect(checkInterview(tp.paths, s)).toEqual({ ok: true });
    // Past the interview rung, `th next` moves on to the stage-artifact obligation.
    const action = runNext(tp.paths).data as { kind: string };
    expect(action.kind).not.toBe("complete-interview");
  });

  it("ALLOWS advancement when the interview is NOT required (T1)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const s = { ...initialState(), tier: "T1" as const, current_stage: "requirements" };
    writeState(tp.paths, s);

    expect(checkInterview(tp.paths, s)).toEqual({ ok: true });
    const action = runNext(tp.paths).data as { kind: string };
    expect(action.kind).not.toBe("complete-interview");
  });

  it("ALLOWS advancement when interview_required is explicitly false on a T2 run", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const s = { ...reqStateT2(), interview_required: false };
    writeState(tp.paths, s);

    expect(checkInterview(tp.paths, s)).toEqual({ ok: true });
  });

  it("is a SOFT front gate — a stage already PAST requirements is not blocked", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // T2, at `scope` (one stage past requirements), interview never completed.
    const s = { ...initialState(), tier: "T2" as const, current_stage: "scope" };
    writeState(tp.paths, s);

    expect(checkInterview(tp.paths, s)).toEqual({ ok: true });
  });
});
