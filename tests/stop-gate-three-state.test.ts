/**
 * R-29 ENFORCE — the three-state Stop-gate verdict + the F1 completion property +
 * the Stop↔next token-parity matrix + the Item-5 verify authority.
 *
 * These are the regression tests that are RED against HEAD's inline `evaluateStopGate`
 * (which checked only drift/debate/decisions + slices + a bare verify report, and never
 * composed checkProductionReality / coverage / report-registration at the Stop boundary).
 * They prove the gate now BITES the full completion ladder, that the loop-escape maps to
 * human-yield (not the empty complete payload), and that the verify authority at
 * final-verification is checkFinalVerification (NOT the weaker checkVerifySuite).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, mintRequiredApprovals, type TempProject } from "./helpers";
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
  // BSC-7 slice-3a C-2: mint the closed human-approval required-set so the green baseline
  // passes the new completion rung; each FIXTURES/perturbation then reds exactly one rung.
  mintRequiredApprovals(paths, state(paths));
  return paths;
}

describe("R-29 F1 property — block ⟹ non-complete for always-run + final tokens", () => {
  it("blocking drift (always-run): canAdvanceStage blocks ⟹ Stop blocks ∧ never complete", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), tier: "T1", current_stage: "implementation", drift_open_blocking: 1 });
    const s = state(tp.paths);
    expect(canAdvanceStage(tp.paths, s).ok).toBe(false);
    expect(decideStopGate(tp.paths, { stop_hook_active: false }).kind).toBe("block");
    // NEVER complete, regardless of the loop-escape flag.
    expect(decideStopGate(tp.paths, { stop_hook_active: true }).kind).not.toBe("complete");
    expect(decideStopGate(tp.paths, {}).kind).not.toBe("complete");
  });

  it("final-verification tester_record_missing (final): blocks ⟹ Stop blocks ∧ never complete", () => {
    const paths = greenAtFinal();
    fs.rmSync(path.join(paths.stateDir, "tester-record.json"), { force: true });
    expect(canAdvanceStage(paths, state(paths)).error).toBe("tester_record_missing");
    expect(decideStopGate(paths, { stop_hook_active: false }).kind).toBe("block");
    expect(decideStopGate(paths, { stop_hook_active: true }).kind).not.toBe("complete");
  });

  it("non-final PASS arm (Item 6 — exemplar checkRepoMap, explicitly NOT checkVerifySuite): forward-only fail ⟹ canCompleteRun PASSES ∧ Stop permits turn-end", () => {
    // EXEMPLAR: a brownfield, not-yet-unlocked run with a missing repo-map. This fails
    // canAdvanceStage on the forward-PROGRESS repo-map rung, but repo-map freshness is
    // not a completion condition — a turn-end mid-design is not a "claim done". We use
    // checkRepoMap (NOT checkVerifySuite — that is the final-verification authority, a
    // poor non-final exemplar).
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
    expect(canAdvanceStage(paths, s).error).toBe("repo_map_stale");
    expect(canCompleteRun(paths, s)).toEqual({ ok: true });
    expect(decideStopGate(paths, {}).kind).toBe("complete");
  });

  it("converse smoke (ok ⇒ complete): a fully green final state completes", () => {
    const paths = greenAtFinal();
    expect(canCompleteRun(paths, state(paths))).toEqual({ ok: true });
    expect(decideStopGate(paths, {}).kind).toBe("complete");
  });
});

describe("R-29 Item b — loop-escape maps to human-yield (NOT the empty complete payload)", () => {
  it("an unmet always-run rung with stop_hook_active:true → human-yield carrying the reason", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), tier: "T1", current_stage: "implementation", drift_open_blocking: 1 });
    const v = decideStopGate(tp.paths, { stop_hook_active: true });
    expect(v.kind).toBe("human-yield");
    expect(v.token).toBe("blocking_drift_open");
    expect(v.reason).toMatch(/blocking drift/i);
  });
});

describe("R-29 Item 5 — final-verification verify AUTHORITY is checkFinalVerification, not checkVerifySuite", () => {
  it("a configured-but-NEVER-RUN suite → non-complete with verify_suite_never_run", () => {
    const paths = greenAtFinal();
    writeVerifyConfig(paths, { commands: ["npm test"] }); // never run → no report
    const v = decideStopGate(paths, {});
    expect(v.kind).toBe("block");
    expect(v.token).toBe("verify_suite_never_run");
    // canCompleteRun agrees (the seam).
    expect(canCompleteRun(paths, state(paths)).error).toBe("verify_suite_never_run");
  });

  it("a CORRUPT verify config → non-complete with verify_config_corrupt", () => {
    const paths = greenAtFinal();
    fs.writeFileSync(path.join(paths.stateDir, "verify.json"), "{ not valid json", "utf8");
    const v = decideStopGate(paths, {});
    expect(v.kind).toBe("block");
    expect(v.token).toBe("verify_config_corrupt");
  });
});

describe("R-29 anti-vacuity — ≥1 ok:false fixture PER completion-relevant token", () => {
  // Each fixture perturbs EXACTLY one rung so the token is unambiguous. This proves the
  // property test is not vacuous and that canCompleteRun reaches the production-reality /
  // coverage / report-registration rungs HEAD's inline evaluateStopGate never composed.
  it("drift → blocking_drift_open", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), tier: "T1", current_stage: "implementation", drift_open_blocking: 1 });
    expect(canCompleteRun(tp.paths, state(tp.paths)).error).toBe("blocking_drift_open");
  });
  it("debate → debate_open_blocking", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), tier: "T1", current_stage: "implementation", debate_open_blocking: 1 });
    expect(canCompleteRun(tp.paths, state(tp.paths)).error).toBe("debate_open_blocking");
  });
  it("slices unsettled → slices_unsettled", () => {
    const paths = greenAtFinal();
    writeState(paths, { ...state(paths), slices: [{ id: "SLICE-0", status: "pending", components: [] }] });
    expect(canCompleteRun(paths, state(paths)).error).toBe("slices_unsettled");
  });
  it("corrupt verify config → verify_config_corrupt", () => {
    const paths = greenAtFinal();
    fs.writeFileSync(path.join(paths.stateDir, "verify.json"), "{bad", "utf8");
    expect(canCompleteRun(paths, state(paths)).error).toBe("verify_config_corrupt");
  });
  it("never-run suite → verify_suite_never_run", () => {
    const paths = greenAtFinal();
    writeVerifyConfig(paths, { commands: ["npm test"] });
    expect(canCompleteRun(paths, state(paths)).error).toBe("verify_suite_never_run");
  });
  it("coverage gap → coverage_failing", () => {
    const paths = greenAtFinal();
    // Add an uncovered REQ-002 (no slice/test) → coverage fails.
    write(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 covered.\n- REQ-002 uncovered.\n");
    expect(canCompleteRun(paths, state(paths)).error).toBe("coverage_failing");
  });
  it("report unregistered → report_not_registered", () => {
    const paths = greenAtFinal();
    // Remove the registration by writing fresh state without approved_artifacts.
    writeState(paths, { ...state(paths), approved_artifacts: [] });
    expect(canCompleteRun(paths, state(paths)).error).toBe("report_not_registered");
  });
  it("production-reality: unretired user-visible sim → simulation_unretired", () => {
    const paths = greenAtFinal();
    runSimAdd(paths, { classification: "Mocked", userVisible: true, replaces: "auth" });
    expect(canCompleteRun(paths, state(paths)).error).toBe("simulation_unretired");
  });
  it("production-reality: missing Tester record → tester_record_missing", () => {
    const paths = greenAtFinal();
    fs.rmSync(path.join(paths.stateDir, "tester-record.json"), { force: true });
    expect(canCompleteRun(paths, state(paths)).error).toBe("tester_record_missing");
  });
});

describe("R-29 Stop↔next token-parity — enum-iterated over every final-verification token", () => {
  // For each token, the Stop reason (renderStopReason) and the th next action must be the
  // identical sentence. We build a fixture per token and assert byte-equality between the
  // Stop reason and the th next action. (Enum-iterated, not a hand list: the token set is
  // the keys of FIXTURES, each independently perturbing a real rung.)
  const FIXTURES: Record<string, (p: ProjectPaths) => void> = {
    slices_unsettled: (p) => writeState(p, { ...state(p), slices: [{ id: "SLICE-0", status: "pending", components: [] }] }),
    verify_config_corrupt: (p) => fs.writeFileSync(path.join(p.stateDir, "verify.json"), "{bad", "utf8"),
    verify_suite_never_run: (p) => writeVerifyConfig(p, { commands: ["npm test"] }),
    coverage_failing: (p) => write(p, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 covered.\n- REQ-002 uncovered.\n"),
    report_not_registered: (p) => writeState(p, { ...state(p), approved_artifacts: [] }),
    simulation_unretired: (p) => { runSimAdd(p, { classification: "Mocked", userVisible: true, replaces: "auth" }); },
    tester_record_missing: (p) => fs.rmSync(path.join(p.stateDir, "tester-record.json"), { force: true }),
    // BSC-7 slice-3a C-2: drop the minted approvals so the closed required-set re-validates
    // `absent` → the completion rung blocks with human_approval_unverified (the first failing
    // required stage). Proves the token has a Stop↔next sentence and reaches the gate.
    human_approval_unverified: (p) => fs.rmSync(path.join(p.stateDir, "approval-receipts.jsonl"), { force: true }),
  };

  for (const token of Object.keys(FIXTURES)) {
    it(`token ${token}: Stop reason === th next action (parity)`, () => {
      const paths = greenAtFinal();
      FIXTURES[token]!(paths);
      const verdict = canCompleteRun(paths, state(paths));
      expect(verdict.ok).toBe(false);
      expect(verdict.error).toBe(token);
      const stopReason = renderStopReason(verdict.error!, verdict.detail);
      const nextAction = (runNext(paths, {}).data as Record<string, unknown>).action as string;
      // The Stop reason is the SAME sentence th next emits for this rung.
      expect(nextAction).toBe(stopReason);
    });
  }

  it("no completion-relevant token hits the generic fallback (every token has a sentence)", () => {
    for (const token of Object.keys(FIXTURES)) {
      expect(renderStopReason(token, {})).not.toMatch(/Completion is blocked by an unmet gate/);
    }
    // And the always-run tokens too.
    for (const token of ["blocking_drift_open", "revise_escalation_open", "decision_obligation_open", "debate_open_blocking"]) {
      expect(renderStopReason(token, {})).not.toMatch(/Completion is blocked by an unmet gate/);
    }
  });
});
