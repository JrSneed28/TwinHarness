/**
 * T6 (unit + truth tables) — the shared gate-precondition helpers
 * (`src/core/gate-preconditions.ts`). Covers AC-B13 (canUnlockImplementation
 * completeness + composition), AC-B14 (tier downgrade human-only), the debate rung
 * (AC-B15), and the produce/register-artifact rung (Critic MAJOR).
 *
 * Strategy: build a project state that satisfies the ENTIRE canUnlockImplementation
 * ladder, assert it passes, then perturb exactly ONE rung at a time and assert the
 * helper returns that rung's STABLE error code — proving each rung is load-bearing
 * and that canUnlockImplementation runs canAdvanceStage's full ladder + the tail.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, mintApprovalForFixture, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { appendDecisionEvent } from "../src/core/decisions";
import { writeVerifyReport, writeVerifyConfig, verifyConfigPath } from "../src/core/verify";
import {
  canAdvanceStage,
  canUnlockImplementation,
  checkFinalVerification,
  checkImplementationSettled,
  validateTierTransition,
} from "../src/core/gate-preconditions";
import type { ProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

function writeFile(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

function reseed(paths: ProjectPaths, overrides: Partial<TwinHarnessState>): TwinHarnessState {
  writeState(paths, { ...state(paths), ...overrides });
  return state(paths);
}

/** A project that satisfies the FULL unlock ladder at implementation-planning. */
function readyAtImplementationPlanning(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\nREQ-001 the only requirement.\n");
  writeFile(paths, "docs/09-implementation-plan.md", "# Implementation plan\n\nSLICE-1 covers REQ-001.\n");
  writeFile(paths, "tests/cov.test.ts", "// REQ-001 verified here\n");
  writeState(paths, { ...initialState(), tier: "T2", current_stage: "implementation-planning" });
  // Register the governing artifact with its REAL hash so checkArtifactDrift stays clean.
  const reg = runArtifactRegister(paths, "docs/09-implementation-plan.md", 1);
  expect(reg.ok).toBe(true);
  return paths;
}

/** A project that satisfies canAdvanceStage at `requirements` (pre-impl-planning). */
function readyAtRequirements(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  writeFile(paths, "docs/01-requirements.md", "# Requirements\n\nREQ-001 the only requirement.\n");
  writeFile(paths, "docs/09-implementation-plan.md", "# Implementation plan\n\nSLICE-1 covers REQ-001.\n");
  writeFile(paths, "tests/cov.test.ts", "// REQ-001 verified here\n");
  // interview_required:false so the soft interview gate (finding #14) does not block
  // here — this helper isolates the stage-ordinal TAIL rung, not the interview rung.
  writeState(paths, { ...initialState(), tier: "T2", current_stage: "requirements", interview_required: false });
  const reg = runArtifactRegister(paths, "docs/01-requirements.md", 1);
  expect(reg.ok).toBe(true);
  // BSC-7 / Axis-B slice-3a (ENFORCE): `requirements` is a humanGate stage, so the
  // human-approval advance rung now BLOCKS canAdvanceStage unless a snapshot+digest-bound
  // approval exists. This helper isolates the stage-ordinal TAIL rung (not the approval
  // rung), so mint a valid approval bound to the just-registered governing artifact so the
  // advance ladder reaches a clean PASS and the test perturbs only the ordinal tail.
  mintApprovalForFixture(paths, "requirements");
  return paths;
}

describe("canUnlockImplementation — base ready state passes the full ladder + tail", () => {
  it("a fully-satisfied implementation-planning state unlocks (both helpers OK)", () => {
    const paths = readyAtImplementationPlanning();
    expect(canAdvanceStage(paths, state(paths))).toEqual({ ok: true });
    expect(canUnlockImplementation(paths, state(paths))).toEqual({ ok: true });
  });
});

describe("AC-B13 — canUnlockImplementation refuses on ANY ladder rung (completeness + composition)", () => {
  // For each ladder rung: perturb ONE thing, assert BOTH canAdvanceStage and
  // canUnlockImplementation surface the SAME stable error — proving the unlock
  // gate runs canAdvanceStage's full ladder (not a weaker coverage-only subset).
  const ladderCases: Array<{ name: string; error: string; perturb: (paths: ProjectPaths) => void }> = [
    { name: "blocking drift open", error: "blocking_drift_open", perturb: (p) => reseed(p, { drift_open_blocking: 1 }) },
    { name: "revise escalation", error: "revise_escalation_open", perturb: (p) => reseed(p, { revise_loop_counts: { architecture: 3 } }) },
    { name: "failing verify suite", error: "verify_suite_failing", perturb: (p) => writeVerifyReport(p, { ok: false, ranAt: new Date().toISOString(), results: [{ command: "npm test", exitCode: 1, ok: false, durationMs: 1, outputTail: "x" }] }) },
    { name: "artifact drift", error: "artifact_drift", perturb: (p) => fs.appendFileSync(path.resolve(p.root, "docs/09-implementation-plan.md"), "\n<!-- edited after register -->\n") },
    { name: "tier unclassified", error: "tier_unclassified", perturb: (p) => reseed(p, { tier: null }) },
    { name: "brownfield repo-map stale", error: "repo_map_stale", perturb: (p) => reseed(p, { project_mode: "brownfield" }) },
    { name: "open decision obligation", error: "decision_obligation_open", perturb: (p) => appendDecisionEvent(p, { id: "DECISION-001", event: "proposed", title: "gate", links: ["stage:implementation-planning"], proposer: "test", proposedAt: new Date().toISOString() }) },
    { name: "open blocking debate", error: "debate_open_blocking", perturb: (p) => reseed(p, { debate_open_blocking: 1 }) },
    { name: "governing artifact not registered", error: "artifact_not_registered", perturb: (p) => reseed(p, { approved_artifacts: [] }) },
    { name: "coverage failing", error: "coverage_failing", perturb: (p) => fs.appendFileSync(path.resolve(p.root, "docs/01-requirements.md"), "\nREQ-002 uncovered by any slice or test.\n") },
  ];

  for (const c of ladderCases) {
    it(`${c.name} → ${c.error} (canAdvanceStage AND canUnlockImplementation)`, () => {
      const paths = readyAtImplementationPlanning();
      c.perturb(paths);
      const s = state(paths);
      expect(canAdvanceStage(paths, s).error).toBe(c.error);
      expect(canUnlockImplementation(paths, s).error).toBe(c.error);
    });
  }

  it("governing artifact NOT produced (file absent + unregistered) → artifact_not_produced", () => {
    const paths = readyAtImplementationPlanning();
    reseed(paths, { approved_artifacts: [] });
    fs.rmSync(path.resolve(paths.root, "docs/09-implementation-plan.md"));
    expect(canUnlockImplementation(paths, state(paths)).error).toBe("artifact_not_produced");
  });

  it("TAIL strictness: canAdvanceStage OK but stage < implementation-planning → unlock refuses stage_before_implementation_planning", () => {
    const paths = readyAtRequirements();
    const s = state(paths);
    expect(canAdvanceStage(paths, s)).toEqual({ ok: true });
    expect(canUnlockImplementation(paths, s).error).toBe("stage_before_implementation_planning");
  });
});

describe("R-23 — checkFinalVerification fails CLOSED on a corrupt verify.json", () => {
  /** A state settled at final-verification (one done slice) so the verify-config rung is reached. */
  function settledFinal(): ProjectPaths {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, {
      ...initialState(),
      current_stage: "final-verification",
      slices: [{ id: "SLICE-1", status: "done", components: [] }],
    });
    return paths;
  }

  it("a present-but-corrupt verify.json → verify_config_corrupt (NOT verify_suite_never_run/pass)", () => {
    const paths = settledFinal();
    // Corrupt config bytes: the old readVerifyConfig collapsed this to `{ commands: [] }`,
    // skipping the suite rung so the gate PASSED on an unreadable config.
    fs.writeFileSync(verifyConfigPath(paths), "}{ broken json", "utf8");
    const res = checkFinalVerification(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("verify_config_corrupt");
  });

  it("a well-formed config with a command but no report → verify_suite_never_run (regression: corrupt path is distinct)", () => {
    const paths = settledFinal();
    writeVerifyConfig(paths, { commands: ["npm test"] });
    const res = checkFinalVerification(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("verify_suite_never_run");
  });
});

describe("validateTierTransition — AC-B14 + T0 veto + unlock-lock", () => {
  const base = (o: Partial<TwinHarnessState>): TwinHarnessState => ({ ...initialState(), ...o });

  it("rejects an unknown tier → invalid_tier", () => {
    expect(validateTierTransition(base({ tier: null }), "T9").error).toBe("invalid_tier");
  });
  it("set-from-null is allowed (first classification)", () => {
    expect(validateTierTransition(base({ tier: null }), "T2")).toEqual({ ok: true });
  });
  it("an upgrade is allowed (T1 → T3)", () => {
    expect(validateTierTransition(base({ tier: "T1" }), "T3")).toEqual({ ok: true });
  });
  it("re-setting the SAME tier is allowed (no downgrade)", () => {
    expect(validateTierTransition(base({ tier: "T2" }), "T2")).toEqual({ ok: true });
  });
  it("a downgrade is refused (T3 → T1) → tier_downgrade_human_only", () => {
    expect(validateTierTransition(base({ tier: "T3" }), "T1").error).toBe("tier_downgrade_human_only");
  });
  it("once implementation_allowed, the tier is frozen → tier_locked_after_unlock", () => {
    expect(validateTierTransition(base({ tier: "T2", implementation_allowed: true }), "T3").error).toBe("tier_locked_after_unlock");
  });
  it("set-from-null to T0 with blast-radius flags → t0_blast_radius_veto", () => {
    expect(validateTierTransition(base({ tier: null, blast_radius_flags: ["money"] }), "T0").error).toBe("t0_blast_radius_veto");
  });
});

describe("checkImplementationSettled — empty slice set policy (finding #2)", () => {
  const base = (o: Partial<TwinHarnessState>): TwinHarnessState => ({ ...initialState(), ...o });

  it("zero slices on a CODE project (default) → no_slices_defined (gate refuses; agrees with `th next`)", () => {
    const r = checkImplementationSettled(base({ slices: [] }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_slices_defined");
  });
  it("zero slices on a no-code / documentation-only project → PASS (vacuously settled)", () => {
    expect(checkImplementationSettled(base({ slices: [], delivery_mode: "no-code" }))).toEqual({ ok: true });
    expect(checkImplementationSettled(base({ slices: [], delivery_mode: "documentation-only" }))).toEqual({ ok: true });
  });
  it("an open (pending) slice → slices_unsettled", () => {
    const s = base({ slices: [{ id: "SLICE-1", status: "pending", components: [] }] });
    expect(checkImplementationSettled(s).error).toBe("slices_unsettled");
  });
  it("all slices terminal (done|blocked) → PASS", () => {
    const s = base({
      slices: [
        { id: "SLICE-1", status: "done", components: [] },
        { id: "SLICE-2", status: "blocked", components: [] },
      ],
    });
    expect(checkImplementationSettled(s)).toEqual({ ok: true });
  });
});
