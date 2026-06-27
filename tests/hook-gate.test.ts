import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, mintRequiredApprovals, mintAssertionPresenceForFixture, ASSERTED_COV_TEST, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { evaluateStopGate, runHookStopGate } from "../src/commands/hook";
import { readState, writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { writeVerifyConfig, writeVerifyReportEnvelope, verifyConfigPath, type VerifyReport } from "../src/core/verify";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { runDecisionAdd, runDecisionApprove } from "../src/commands/decision";
import type { ProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/**
 * R-29 re-baseline helper: lay down a project that is GREEN across the ENTIRE
 * final-verification completion ladder EXCEPT the verify suite (the caller's variable).
 * The Stop gate now consumes `canCompleteRun` → the strict `checkFinalVerification`
 * ladder (slices → verify → coverage → report → production-reality), so a final-stage
 * fixture must satisfy coverage (reqs+plan+test), a registered verification report, and
 * a VALID F8-bound Tester record — otherwise the gate blocks on those rungs, not the
 * verify suite the REQ-GATE-005 tests isolate. Mirrors production-reality.test.ts's
 * greenAtFinalVerification.
 */
function greenAtFinalExceptVerify(p: TempProject): void {
  const paths = p.paths;
  write(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-1 covers REQ-001.\n");
  // BSC-2 slice-6: REQ-001's test file carries a NON-TRIVIAL assertion (was a bare comment).
  write(paths, "tests/cov.test.ts", ASSERTED_COV_TEST);
  write(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    slices: [{ id: "SLICE-1", status: "done", components: [] }],
  });
  expect(runArtifactRegister(paths, "docs/10-verification-report.md", 1).ok).toBe(true);
  expect(runTesterRecord(paths, { driver: "cli-e2e", passed: true }).ok).toBe(true);
  // BSC-7 slice-3a C-2: the completion ladder re-validates the closed human-approval
  // required-set (rung 1c, BEFORE the verify rung), so mint it here — otherwise the
  // REQ-GATE-005 verify-suite isolation would block on human_approval_unverified, not
  // the verify rung it targets.
  mintRequiredApprovals(paths, readState(paths).state!);
  // BSC-2 slice-6: the assertion rung composes after the verify rung, so the green-except-verify
  // fixture must also carry an F8-bound assertion-presence receipt for the PASS arm. Mint LAST.
  mintAssertionPresenceForFixture(paths);
}

/** A GREEN bound verify report (envelope) for the current config — sealed at the
 * current snapshot so the validated reader accepts it as `valid`. */
function sealGreenReport(paths: ProjectPaths, commands: string[]): void {
  const report: VerifyReport = {
    ok: true,
    ranAt: new Date().toISOString(),
    results: commands.map((command) => ({ command, exitCode: 0, ok: true, durationMs: 1, outputTail: "" })),
  };
  writeVerifyReportEnvelope(paths, report, commands);
}

function write(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

describe("REQ-GATE-001: stop-gate blocks premature completion (pre-mortem #2)", () => {
  it("allows when no TwinHarness run is active (no state.json)", () => {
    tp = makeTempProject();
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });

  it("blocks when state.json is present but invalid", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(tp.paths.stateFile, "{ broken", "utf8");
    const d = evaluateStopGate(tp.paths);
    expect(d.block).toBe(true);
    expect(d.reasons.length).toBeGreaterThan(0);
  });

  it("allows when state is valid and there is no blocking drift", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });

  it("blocks when there is open blocking drift (§10)", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), drift_open_blocking: 1 });
    expect(evaluateStopGate(tp.paths).block).toBe(true);
  });

  it("runHookStopGate emits a Claude Code decision payload", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const allow = runHookStopGate(tp.paths);
    expect(allow.exitCode).toBe(0);
    expect(JSON.parse(allow.stdout)).toEqual({});

    writeState(tp.paths, { ...initialState(), drift_open_blocking: 2 });
    expect(JSON.parse(runHookStopGate(tp.paths).stdout).decision).toBe("block");
  });

  it("blocks at most once per stop sequence: stop_hook_active downgrades to a systemMessage", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), drift_open_blocking: 1 });

    // First stop attempt (stop_hook_active absent/false) → hard block.
    expect(JSON.parse(runHookStopGate(tp.paths, {}).stdout).decision).toBe("block");
    expect(JSON.parse(runHookStopGate(tp.paths, { stop_hook_active: false }).stdout).decision).toBe("block");

    // Already continuing because of a stop hook → allow (human-yield), but surface the
    // reasons. R-29: the reason is the renderStopReason sentence for blocking_drift_open.
    const second = JSON.parse(runHookStopGate(tp.paths, { stop_hook_active: true }).stdout);
    expect(second.decision).toBeUndefined();
    expect(second.systemMessage).toContain("STILL blocked");
    expect(second.systemMessage).toMatch(/blocking drift/i);
  });

  it("stop_hook_active does not alter a clean allow", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(JSON.parse(runHookStopGate(tp.paths, { stop_hook_active: true }).stdout)).toEqual({});
  });

  // F6: final-verification slice-completion gate. The slices rung is FIRST in the
  // checkFinalVerification ladder, so a pending slice still surfaces first.
  it("blocks at final-verification when a slice is still pending", () => {
    tp = makeTempProject();
    writeState(tp.paths, {
      ...initialState(),
      current_stage: "final-verification",
      slices: [{ id: "SLICE-1", status: "pending", components: [] }],
    });
    const d = evaluateStopGate(tp.paths);
    expect(d.block).toBe(true);
    expect(d.reasons[0]).toContain("SLICE-1");
    // R-29: the reason is now the renderStopReason sentence for slices_unsettled
    // ("Final verification is blocked while slices are unfinished — finish or block …").
    expect(d.reasons[0]).toMatch(/[Ff]inal verification is blocked while slices/);
  });

  it("allows at final-verification when the FULL completion ladder is green (slices settled + coverage + report + Tester)", () => {
    // R-29 re-baseline: the Stop gate now runs the full checkFinalVerification ladder,
    // so "all slices settled" alone no longer allows — the run must also clear coverage,
    // the registered report, and the production-reality (Tester) rung. With the green
    // scaffold and no verify suite configured, the gate allows.
    tp = makeTempProject();
    greenAtFinalExceptVerify(tp);
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });

  it("does NOT block at a non-final stage even with pending slices (a mid-build turn-end is not a claim-done)", () => {
    tp = makeTempProject();
    writeState(tp.paths, {
      ...initialState(),
      tier: "T1",
      current_stage: "implementation",
      slices: [
        { id: "SLICE-1", status: "pending", components: [] },
        { id: "SLICE-2", status: "in-progress", components: [] },
      ],
    });
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });
});

describe("REQ-GATE-005: final-verification requires a green verify suite when one is configured", () => {
  // R-29: the Stop gate now runs the full checkFinalVerification ladder, so to ISOLATE
  // the verify-suite behavior the fixture must be green on every OTHER rung (coverage,
  // report, Tester). greenAtFinalExceptVerify lays that down; the caller then perturbs
  // only the verify config/report.
  function settledAtFinal(tp: TempProject): void {
    greenAtFinalExceptVerify(tp);
  }

  it("no verify commands configured → suite check is inert (allows)", () => {
    tp = makeTempProject();
    settledAtFinal(tp);
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });

  it("commands configured but no report → blocks (never run)", () => {
    tp = makeTempProject();
    settledAtFinal(tp);
    writeVerifyConfig(tp.paths, { commands: ["npm test"] });
    const d = evaluateStopGate(tp.paths);
    expect(d.block).toBe(true);
    expect(d.reasons[0]).toContain("never been recorded");
  });

  it("a RED report → blocks", () => {
    tp = makeTempProject();
    settledAtFinal(tp);
    writeVerifyConfig(tp.paths, { commands: ["npm test"] });
    // A bound RED envelope (sealed at the current snapshot so it is `valid`, just red).
    writeVerifyReportEnvelope(
      tp.paths,
      { ok: false, ranAt: "2026-06-13T00:00:00.000Z", results: [{ command: "npm test", exitCode: 1, ok: false, durationMs: 1, outputTail: "fail" }] },
      ["npm test"],
    );
    const d = evaluateStopGate(tp.paths);
    expect(d.block).toBe(true);
    // R-29: the final-verification verify authority is checkFinalVerification, which
    // surfaces verify_suite_failing as the legacy token's successor at the suite rung;
    // a red bound report blocks. The renderStopReason sentence names the red suite.
    expect(d.reasons[0]).toMatch(/verify|suite|RED|red/);
  });

  it("a GREEN bound report → allows", () => {
    tp = makeTempProject();
    settledAtFinal(tp);
    writeVerifyConfig(tp.paths, { commands: ["npm test"] });
    sealGreenReport(tp.paths, ["npm test"]);
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });

  it("a LEGACY (unbound) green report → blocks (F2: a bare report is not trustworthy evidence)", () => {
    // F2/R-30: a bare `{ok:true}` report carries no snapshot binding, so the gate can no
    // longer trust its greenness. This is the NEW enforcement — re-run `th verify run`
    // to seal a bound envelope.
    tp = makeTempProject();
    settledAtFinal(tp);
    writeVerifyConfig(tp.paths, { commands: ["npm test"] });
    fs.writeFileSync(
      path.join(tp.paths.stateDir, "verify-report.json"),
      JSON.stringify({ ok: true, ranAt: "2026-06-13T00:00:00.000Z", results: [{ command: "npm test", exitCode: 0, ok: true, durationMs: 1, outputTail: "" }] }),
      "utf8",
    );
    expect(evaluateStopGate(tp.paths).block).toBe(true);
  });

  // R-23: a present-but-CORRUPT verify.json must fail CLOSED at the stop gate.
  it("a CORRUPT verify.json → blocks (fail-closed, NOT treated as empty/no-commands)", () => {
    tp = makeTempProject();
    settledAtFinal(tp);
    writeVerifyConfig(tp.paths, { commands: ["npm test"] });
    sealGreenReport(tp.paths, ["npm test"]);
    fs.writeFileSync(verifyConfigPath(tp.paths), "{ not valid json", "utf8");
    const d = evaluateStopGate(tp.paths);
    expect(d.block).toBe(true);
    expect(d.reasons[0]).toContain("corrupt");
  });
});

describe("RULE-007: stop-gate blocks on an unapproved decision gating the current stage", () => {
  /** A fixed clock so audit timestamps are deterministic in tests. */
  const clock = (iso: string) => () => new Date(iso);

  /**
   * Settle the run at `stage` with NO other blockers: not at final-verification,
   * no blocking drift, no blocking debate, a valid tier and a non-pending slice.
   * So the decision gate is the only thing that can flip `block`.
   */
  function settledAt(p: TempProject, stage: string): void {
    const state = readState(p.paths).state!;
    state.tier = "T1";
    state.current_stage = stage;
    state.drift_open_blocking = 0;
    state.debate_open_blocking = 0;
    state.slices = [{ id: "SLICE-1", status: "done", components: [] }];
    writeState(p.paths, state);
  }

  it("blocks when a PROPOSED decision links the current stage (reason names the id + 'unapproved decision')", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    settledAt(tp, "architecture");

    runDecisionAdd(tp.paths, {
      title: "Decide architecture approach",
      rationale: "gates the architecture stage",
      links: ["stage:architecture"],
      now: clock("2026-06-15T00:00:00.000Z"),
    });

    const d = evaluateStopGate(tp.paths);
    expect(d.block).toBe(true);
    const reason = d.reasons.join(" ");
    expect(reason).toContain("DECISION-001");
    expect(reason).toContain("unapproved decision");
  });

  it("allows once that gating decision is APPROVED (no other blockers present)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    settledAt(tp, "architecture");

    runDecisionAdd(tp.paths, {
      title: "Decide architecture approach",
      rationale: "gates the architecture stage",
      links: ["stage:architecture"],
      now: clock("2026-06-15T00:00:00.000Z"),
    });
    // Blocked before approval.
    expect(evaluateStopGate(tp.paths).block).toBe(true);

    runDecisionApprove(tp.paths, "DECISION-001", {
      as: "alice",
      tty: { isTTY: true, stdinLine: "y" },
      now: clock("2026-06-15T01:00:00.000Z"),
    });

    // Cleared after approval.
    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });

  it("does NOT block when a proposed decision links a DIFFERENT stage than current_stage", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    settledAt(tp, "architecture");

    // Linked to "stage:scope" while we sit at "architecture" → not a gate here.
    runDecisionAdd(tp.paths, {
      title: "Scope-stage decision",
      rationale: "gates a different stage",
      links: ["stage:scope"],
      now: clock("2026-06-15T00:00:00.000Z"),
    });

    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });
});
