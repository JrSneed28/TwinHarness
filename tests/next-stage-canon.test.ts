/**
 * `th next` stage canonicalization (F-2, C-1/M-2).
 *
 * `th next` must take the same final-verification branch as the stop-gate for
 * near-miss spellings. Before the fix `next.ts` compared the raw `current_stage`
 * exactly, so `Final-Verification` / `10-final-verification` fell through to the
 * generic "advance to the next stage" path and DISAGREED with the stop-gate
 * (which would block). Now both canonicalize, so they agree.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runNext } from "../src/commands/next";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { nextStageAfter } from "../src/core/stages";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("F-2/M-2: th next takes the final-verification branch for near-miss stages", () => {
  it.each(["Final-Verification", "10-final-verification", "final-verification"])(
    "current_stage=%j with an unfinished slice → settle-slices guidance (not advance-stage)",
    (stage) => {
      tp = makeTempProject();
      runInit(tp.paths, {});
      writeState(tp.paths, {
        ...initialState(),
        tier: "T1",
        current_stage: stage,
        slices: [{ id: "SLICE-1", status: "pending", components: [] }],
      });

      const res = runNext(tp.paths, {});
      // The final-verification branch emits the "finish-slices" obligation; it must
      // NOT fall through to "advance-stage" (which would mean next.ts disagreed
      // with the stop-gate on the near-miss spelling).
      expect(res.data?.kind).toBe("finish-slices");
    },
  );

  it("a near-miss final-verification with settled slices does not try to advance past the pipeline end", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeState(tp.paths, {
      ...initialState(),
      tier: "T1",
      current_stage: "10-final-verification",
      slices: [{ id: "SLICE-1", status: "done", components: [] }],
    });

    const res = runNext(tp.paths, {});
    // Canonicalized to final-verification → nextStageAfter returns undefined (last
    // engaged stage), so it must NOT emit "advance-stage" back to an early stage.
    expect(res.data?.kind).not.toBe("advance-stage");
  });

  it("the stage after architecture is the new ux-design (Stage 4a) for an engaged tier", () => {
    expect(nextStageAfter("architecture", "T2")?.stage).toBe("ux-design");
  });
});
