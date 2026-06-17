/**
 * CHARACTERIZATION TEST (T1) — pins the CURRENT (un-refactored) output of
 * `runNext()` (src/commands/next.ts) across representative run states.
 *
 * PURPOSE (plan §Phase 2 Step 4, AC-B2, pre-mortem #1): the upcoming T3 work
 * extracts each `runNext()` rung's PREDICATE from its `emit(...)` into shared
 * helpers (`src/core/gate-preconditions.ts`). That is a predicate-from-emission
 * refactor, NOT a pure move — a subtle reorder of the short-circuit ladder would
 * silently change WHICH obligation surfaces first, or drop a rung. These snapshots
 * are the guardrail: they assert the SPECIFIC `kind` (the stable machine token)
 * AND the discriminating `data` payload per state, so any reorder/drop is caught.
 *
 * This file MUST be GREEN against the CURRENT next.ts BEFORE T3 runs. Do NOT
 * modify next.ts to make it pass.
 *
 * KNOWN INTENTIONAL EXCEPTION — the `debate-blocked` snapshot (see that test):
 * today `runNext()` does NOT check `debate_open_blocking`, so the current output
 * is captured here PRE-FIX. T3 deliberately closes that gap (AC-B15) and will
 * update ONLY that one snapshot. Every other snapshot must stay byte-identical
 * across the refactor.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runNext } from "../src/commands/next";
import type { ProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Build a fresh temp project, optionally lay down files, then write `state`. */
function setup(
  overrides: Partial<TwinHarnessState> | null,
  files?: (paths: ProjectPaths) => void,
): ProjectPaths {
  tp = makeTempProject();
  files?.(tp.paths);
  if (overrides) writeState(tp.paths, { ...initialState(), ...overrides });
  return tp.paths;
}

/** Run the oracle and return its machine payload (the `--json` data object). */
function next(paths: ProjectPaths): Record<string, unknown> {
  const r = runNext(paths);
  expect(r.ok).toBe(true);
  return r.data ?? {};
}

function writeFile(paths: ProjectPaths, rel: string, contents: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
}

describe("th next characterization — current oracle output per representative state", () => {
  // 1. init — no state.json at all → scaffold is the only possible step.
  it("init: no run here → kind=init", () => {
    const paths = setup(null); // do NOT write state
    const d = next(paths);
    expect(d.kind).toBe("init");
  });

  // 2. tier-set — tier classified, pre-pipeline stage ("init") → the classify-tier
  //    gate is cleared and the oracle advances to the first engaged stage.
  it("tier-set: tier=T1 at stage 'init' → kind=advance-stage (init → requirements)", () => {
    const paths = setup({ tier: "T1", current_stage: "init" });
    const d = next(paths);
    expect(d.kind).toBe("advance-stage");
    expect(d.from).toBe("init");
    expect(d.to).toBe("requirements");
  });

  // 3. pre-coverage — at implementation-planning with its governing artifact
  //    REGISTERED (so the produce/register rung is satisfied), coverage is the
  //    hard gate and it fails (REQ-001 has neither a slice nor a test).
  it("pre-coverage: implementation-planning, plan registered, REQ uncovered → kind=fix-coverage", () => {
    const paths = setup(
      {
        tier: "T1",
        current_stage: "implementation-planning",
        // Registered (file may be absent on disk → 'missing', which the oracle's
        // artifact-drift rung ignores; only 'changed' is surfaced there). This lets
        // execution fall through to the coverage gate.
        approved_artifacts: [{ file: "docs/09-implementation-plan.md", version: 1, hash: "deadbeef" }],
      },
      (p) => {
        // A requirement with no slice and no test → a coverage gap.
        writeFile(p, "docs/01-requirements.md", "# Requirements\n\nREQ-001 the thing.\n");
      },
    );
    const d = next(paths);
    expect(d.kind).toBe("fix-coverage");
    const gaps = d.gaps as Array<{ req: string; inSlice: boolean; inTest: boolean }>;
    expect(gaps).toEqual([{ req: "REQ-001", inSlice: false, inTest: false }]);
  });

  // 4. produce-artifact — current stage owes an artifact (contract.produces set)
  //    that is NOT on disk and NOT registered. REQUIRED so the produce/register
  //    rung (next.ts:222-249) cannot be silently dropped by the T3 extraction.
  it("produce-artifact: requirements stage, artifact absent → kind=produce-artifact", () => {
    const paths = setup({ tier: "T1", current_stage: "requirements" });
    const d = next(paths);
    expect(d.kind).toBe("produce-artifact");
    expect(d.stage).toBe("requirements");
    expect(d.produces).toBe("docs/01-requirements.md");
  });

  // 5. register-artifact — artifact PRODUCED (on disk) but NOT registered. The
  //    second half of the produce/register rung; also pins it against drop.
  it("register-artifact: requirements stage, artifact on disk but unregistered → kind=register-artifact", () => {
    const paths = setup({ tier: "T1", current_stage: "requirements" }, (p) => {
      writeFile(p, "docs/01-requirements.md", "# Requirements\n\nREQ-001 the thing.\n");
    });
    const d = next(paths);
    expect(d.kind).toBe("register-artifact");
    expect(d.stage).toBe("requirements");
    expect(d.file).toBe("docs/01-requirements.md");
  });

  // 6. final-verification with unsettled slices — the slice floor blocks the
  //    verification report while any slice is neither done nor blocked.
  it("final-verification: unsettled slices → kind=finish-slices", () => {
    const paths = setup({
      tier: "T1",
      current_stage: "final-verification",
      slices: [{ id: "SLICE-1", status: "pending", components: [] }],
    });
    const d = next(paths);
    expect(d.kind).toBe("finish-slices");
    expect(d.open).toEqual(["SLICE-1"]);
  });

  // 7. debate-blocked — debate_open_blocking>0 with an otherwise-clean state.
  //
  //    *** DELIBERATELY UPDATED BY T3 (AC-B15) — the SANCTIONED reconciliation ***
  //    Before T3, runNext() did NOT consult `debate_open_blocking`, so an open debate
  //    was invisible to the oracle and this state produced the SAME output as the
  //    clean tier-set case (advance-stage init → requirements) — a pre-existing
  //    oracle/stop-gate divergence (the stop-gate already blocks on it, hook.ts:65).
  //    T3 added the debate rung to gate-preconditions (checkDebate), closing the gap,
  //    so `th next` now surfaces the open debate as `resolve-debate`. This is the ONE
  //    snapshot the extraction was allowed to change; the other 7 stayed byte-identical.
  it("debate-blocked (POST-FIX, AC-B15): open debate now surfaces → kind=resolve-debate", () => {
    const paths = setup({
      tier: "T1",
      current_stage: "init",
      debate_open_blocking: 1,
    });
    const d = next(paths);
    expect(d.kind).toBe("resolve-debate");
    expect(d.debate_open_blocking).toBe(1);
  });

  // 8. drift-blocked — open blocking drift outranks all stage progress.
  it("drift-blocked: drift_open_blocking>0 → kind=resolve-blocking-drift", () => {
    const paths = setup({ tier: "T1", current_stage: "implementation", drift_open_blocking: 2 });
    const d = next(paths);
    expect(d.kind).toBe("resolve-blocking-drift");
    expect(d.drift_open_blocking).toBe(2);
  });
});
