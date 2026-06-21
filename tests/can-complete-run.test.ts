/**
 * `canCompleteRun` composition (R-29, Item 1) — the COMPLETION re-selection.
 *
 * canCompleteRun is NOT a verbatim canAdvanceStage alias: it blocks completion at any
 * stage on the always-run human-reconciliation obligations, runs the strict
 * checkFinalVerification ladder at final-verification, and PASSes the forward-only
 * rungs at a non-final stage (a mid-build turn-end is not a "claim done"). These tests
 * pin that composition directly (the Stop-gate property test in
 * stop-gate-three-state.test.ts exercises the verdict mapping on top of it).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { runSimAdd } from "../src/commands/sim";
import { canCompleteRun, canAdvanceStage } from "../src/core/gate-preconditions";
import type { ProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

function write(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}
function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

/** A project GREEN at final-verification (every completion rung clears). Mirrors
 * production-reality.test.ts's greenAtFinalVerification, plus the F8 bound Tester
 * record so canCompleteRun's final ladder passes end-to-end. */
function greenAtFinal(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  write(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  write(paths, "tests/cov.test.ts", "// REQ-001 verified here\n");
  write(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  expect(runArtifactRegister(paths, "docs/10-verification-report.md", 1).ok).toBe(true);
  // F8/R-31 (enforced): the gate requires a PASSED, receipt+repo-bound Tester record.
  expect(runTesterRecord(paths, { driver: "cli-e2e", passed: true }).ok).toBe(true);
  return paths;
}

describe("canCompleteRun — always-run obligations block completion at ANY stage", () => {
  it("blocking drift blocks completion at a NON-final stage", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), tier: "T1", current_stage: "implementation", drift_open_blocking: 2 });
    const r = canCompleteRun(tp.paths, state(tp.paths));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("blocking_drift_open");
  });

  it("open blocking debate blocks completion at a NON-final stage", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), tier: "T1", current_stage: "implementation", debate_open_blocking: 1 });
    expect(canCompleteRun(tp.paths, state(tp.paths)).error).toBe("debate_open_blocking");
  });
});

describe("canCompleteRun — forward-only rungs PASS at a non-final stage (Item 6 exemplar)", () => {
  it("a state failing ONLY checkRepoMap (a forward-only rung) at a non-final stage ⇒ canCompleteRun PASSES", () => {
    // EXEMPLAR CHOICE: checkRepoMap — a brownfield, not-yet-unlocked run with no
    // repo-map is STALE for advancement (canAdvanceStage blocks), but repo-map
    // freshness is a forward-PROGRESS rung, NOT a completion condition: a turn-end
    // mid-design is not a "claim done", so completion must PASS. We deliberately do
    // NOT use checkVerifySuite here (Item 6) — that token is final-verification's
    // authority, not a clean forward-only exemplar at a non-final stage.
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, {
      ...initialState(),
      tier: "T1",
      current_stage: "requirements",
      project_mode: "brownfield",
      implementation_allowed: false,
    });
    const s = state(paths);
    // canAdvanceStage BLOCKS on the missing/stale brownfield repo-map (forward-progress).
    const adv = canAdvanceStage(paths, s);
    expect(adv.ok).toBe(false);
    expect(adv.error).toBe("repo_map_stale");
    // canCompleteRun PASSES — repo-map freshness does not gate a mid-run turn-end.
    expect(canCompleteRun(paths, s)).toEqual({ ok: true });
  });

  it("a state failing ONLY checkInterview (a forward-only rung) at a non-final stage ⇒ canCompleteRun PASSES", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, {
      ...initialState(),
      tier: "T3", // interview required for T3
      current_stage: "requirements",
      interview_required: true,
    });
    const s = state(paths);
    expect(canAdvanceStage(paths, s).error).toBe("interview_incomplete");
    expect(canCompleteRun(paths, s)).toEqual({ ok: true });
  });
});

describe("canCompleteRun — at final-verification the STRICT checkFinalVerification ladder is authority (Item 5)", () => {
  it("a configured-but-NEVER-RUN verify suite blocks completion with verify_suite_never_run", () => {
    const paths = greenAtFinal();
    fs.writeFileSync(path.join(paths.stateDir, "verify.json"), JSON.stringify({ commands: ["npm test"] }), "utf8");
    // No report written → never run.
    const r = canCompleteRun(paths, state(paths));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("verify_suite_never_run");
  });

  it("a CORRUPT verify config blocks completion with verify_config_corrupt (NOT silently passed)", () => {
    const paths = greenAtFinal();
    fs.writeFileSync(path.join(paths.stateDir, "verify.json"), "{ not valid json", "utf8");
    const r = canCompleteRun(paths, state(paths));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("verify_config_corrupt");
  });

  it("a production-reality blocker (unretired user-visible sim) blocks completion", () => {
    const paths = greenAtFinal();
    runSimAdd(paths, { classification: "Mocked", userVisible: true, replaces: "auth" });
    expect(canCompleteRun(paths, state(paths)).error).toBe("simulation_unretired");
  });

  it("converse: a fully GREEN final-verification ⇒ canCompleteRun PASSES (ok⇒complete smoke)", () => {
    const paths = greenAtFinal();
    expect(canCompleteRun(paths, state(paths))).toEqual({ ok: true });
  });
});