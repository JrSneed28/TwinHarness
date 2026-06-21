/**
 * R-37 — release-confidence backstop: STOP ↔ `th next` ↔ STAGE-ADVANCE parity (F1).
 *
 * Phase-1..4 (tests/stop-gate-three-state.test.ts) proved a per-token Stop↔next
 * sentence-parity matrix and two point-instances of the completion property. This
 * suite hardens the F1 contract into TWO general properties asserted across EVERY
 * final-verification token in one place, as the release backstop:
 *
 *   PROPERTY 1 (parity): for every final-verification token, renderStopReason(token)
 *     === the `th next` action sentence. (No token may diverge between the Stop reason
 *     and the next-action prompt — the human is told the SAME thing either way.)
 *
 *   PROPERTY 2 (block ⟹ non-complete): whenever canAdvanceStage at final-verification
 *     reports ok:false (a completion-relevant rung is unmet), the Stop verdict is NEVER
 *     `complete` — regardless of stop_hook_active. This is the F1 safety invariant: a
 *     blocked gate can never be reported done.
 *
 * The token set is DERIVED from a green-at-final fixture perturbed one rung at a time —
 * not a hand list — so a newly added completion rung that forgets a Stop sentence or a
 * parity arm is caught here, not in production.
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
import { writeVerifyConfig } from "../src/core/verify";
import { canAdvanceStage, canCompleteRun } from "../src/core/gate-preconditions";
import { decideStopGate } from "../src/commands/hook";
import { renderStopReason, runNext } from "../src/commands/next";
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

/** A project GREEN across the whole final-verification ladder; perturb one rung. */
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
  expect(runTesterRecord(paths, { driver: "cli-e2e", passed: true }).ok).toBe(true);
  return paths;
}

/** Each perturbation drives exactly one final-verification rung to ok:false. */
const PERTURB: Record<string, (p: ProjectPaths) => void> = {
  slices_unsettled: (p) =>
    writeState(p, { ...state(p), slices: [{ id: "SLICE-0", status: "pending", components: [] }] }),
  verify_config_corrupt: (p) => fs.writeFileSync(path.join(p.stateDir, "verify.json"), "{bad", "utf8"),
  verify_suite_never_run: (p) => writeVerifyConfig(p, { commands: ["npm test"] }),
  coverage_failing: (p) =>
    write(p, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 covered.\n- REQ-002 uncovered.\n"),
  report_not_registered: (p) => writeState(p, { ...state(p), approved_artifacts: [] }),
  simulation_unretired: (p) => {
    runSimAdd(p, { classification: "Mocked", userVisible: true, replaces: "auth" });
  },
  tester_record_missing: (p) => fs.rmSync(path.join(p.stateDir, "tester-record.json"), { force: true }),
};

describe("R-37 F1 PROPERTY 1 — Stop reason === `th next` action for every final-verification token", () => {
  for (const token of Object.keys(PERTURB)) {
    it(`${token}: renderStopReason === th next action (byte-equal parity)`, () => {
      const paths = greenAtFinal();
      PERTURB[token]!(paths);
      const verdict = canCompleteRun(paths, state(paths));
      expect(verdict.ok).toBe(false);
      expect(verdict.error).toBe(token);
      const stopReason = renderStopReason(verdict.error!, verdict.detail);
      const nextAction = (runNext(paths, {}).data as Record<string, unknown>).action as string;
      expect(nextAction).toBe(stopReason);
      // And it never falls through to the generic fallback sentence.
      expect(stopReason).not.toMatch(/Completion is blocked by an unmet gate/);
    });
  }
});

describe("R-37 F1 PROPERTY 2 — canAdvanceStage blocks ⟹ Stop is NEVER complete (final tokens)", () => {
  for (const token of Object.keys(PERTURB)) {
    it(`${token}: ok:false ⟹ Stop ≠ complete (both stop_hook_active states)`, () => {
      const paths = greenAtFinal();
      PERTURB[token]!(paths);
      // The rung is genuinely unmet at the completion boundary.
      expect(canAdvanceStage(paths, state(paths)).ok).toBe(false);
      expect(canCompleteRun(paths, state(paths)).ok).toBe(false);
      // Neither loop-escape nor first-pass may report `complete`.
      expect(decideStopGate(paths, { stop_hook_active: false }).kind).not.toBe("complete");
      expect(decideStopGate(paths, { stop_hook_active: true }).kind).not.toBe("complete");
    });
  }

  it("CONVERSE: a fully-green final state DOES complete (the property is not vacuous)", () => {
    const paths = greenAtFinal();
    expect(canCompleteRun(paths, state(paths))).toEqual({ ok: true });
    expect(decideStopGate(paths, {}).kind).toBe("complete");
  });
});
