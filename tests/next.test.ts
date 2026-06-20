/**
 * `th next` — the next-action oracle — REQ-anchored.
 *
 * Verifies the priority ordering of mechanical obligations and that each one is a
 * computation over durable state, never a strategy decision.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runDriftAdd } from "../src/commands/drift";
import { readState, writeState } from "../src/core/state-store";
import type { TwinHarnessState } from "../src/core/state-schema";
import { runReviseBump } from "../src/commands/revise";
import { runArtifactRegister } from "../src/commands/artifact";
import { runSlicesSync } from "../src/commands/slices";
import { runVerifyAdd, runVerifyRun, runVerifyApprove } from "../src/commands/verify";
import { readVerifyReport, writeVerifyReport } from "../src/core/verify";
import { runNext } from "../src/commands/next";
import { runRepoMap } from "../src/commands/repo";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function writeFile(t: TempProject, rel: string, content: string): void {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/**
 * Position durable state for a test. Gate-owned fields (tier, current_stage,
 * implementation_allowed, blast_radius_flags) can no longer be moved with a raw
 * `th state set` after the #11 demotion, so setup uses the ungated low-level
 * positioning writer directly. `interview_required: false` is passed on T2/T3
 * positions so the new soft interview gate (#14) doesn't preempt the obligation
 * under test (these tests are not about the interview gate).
 */
function position(t: TempProject, patch: Partial<TwinHarnessState>): void {
  writeState(t.paths, { ...readState(t.paths).state!, ...patch });
}

describe("REQ-NEXT-001: no run / invalid state", () => {
  it("uninitialized dir → kind init", () => {
    tp = makeTempProject();
    expect(runNext(tp.paths).data?.kind).toBe("init");
  });

  it("invalid state.json → kind fix-state", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    fs.writeFileSync(tp.paths.stateFile, "{ not json");
    expect(runNext(tp.paths).data?.kind).toBe("fix-state");
  });
});

describe("REQ-NEXT-002: blocking drift outranks everything else", () => {
  it("open blocking drift → kind resolve-blocking-drift", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, { tier: "T2", interview_required: false });
    runDriftAdd(tp.paths, { layer: "requirement", ref: "SLICE-1 / TASK-1", discovery: "x", action: "paused" });
    expect(runNext(tp.paths).data?.kind).toBe("resolve-blocking-drift");
  });
});

describe("REQ-NEXT-003: a revise loop at cap escalates to the human", () => {
  it("revise count >= cap → kind escalate-revise", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, { tier: "T2", interview_required: false });
    runReviseBump(tp.paths, "architecture");
    runReviseBump(tp.paths, "architecture");
    runReviseBump(tp.paths, "architecture"); // count 3 == default cap
    expect(runNext(tp.paths).data?.kind).toBe("escalate-revise");
  });
});

describe("REQ-NEXT-004: tier must be classified before stages run", () => {
  it("tier null → kind classify-tier", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runNext(tp.paths).data?.kind).toBe("classify-tier");
  });
});

describe("REQ-NEXT-005: current stage owes its produced artifact", () => {
  it("at requirements with no artifact on disk → kind produce-artifact", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, { tier: "T2", current_stage: "requirements", interview_required: false });
    expect(runNext(tp.paths).data?.kind).toBe("produce-artifact");
  });

  it("artifact exists but unregistered → kind register-artifact", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, { tier: "T2", current_stage: "requirements", interview_required: false });
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    expect(runNext(tp.paths).data?.kind).toBe("register-artifact");
  });

  it("artifact produced + registered → advances to the next engaged stage", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, { tier: "T2", current_stage: "requirements", interview_required: false });
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);
    const res = runNext(tp.paths);
    expect(res.data?.kind).toBe("advance-stage");
    // Next engaged stage after requirements for T2 is scope.
    expect(res.data?.to).toBe("scope");
  });
});

describe("REQ-NEXT-006: re-register a silently changed artifact before advancing", () => {
  it("registered artifact edited on disk → kind re-register-artifact", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, { tier: "T2", current_stage: "requirements", interview_required: false });
    writeFile(tp, "docs/01-requirements.md", "REQ-001.\n");
    runArtifactRegister(tp.paths, "docs/01-requirements.md", 1);
    // Edit after registration → drift.
    writeFile(tp, "docs/01-requirements.md", "REQ-001 changed.\n");
    expect(runNext(tp.paths).data?.kind).toBe("re-register-artifact");
  });
});

describe("REQ-NEXT-008: a failing suite routes to the Debugger before advancing", () => {
  it("verify report failing → kind investigate-failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, { tier: "T2", interview_required: false });
    runVerifyAdd(tp.paths, "false");
    runVerifyApprove(tp.paths, { as: "test", tty: { isTTY: true, stdinLine: "y" } });
    runVerifyRun(tp.paths);
    expect(runNext(tp.paths).data?.kind).toBe("investigate-failure");
  });
});

describe("REQ-NEXT-009: implementation stage dispatches build waves", () => {
  it("pending slices at implementation → kind dispatch-wave, action prefers `th build dispatch`", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, {
      tier: "T2",
      current_stage: "implementation",
      interview_required: false,
      slices: [{ id: "SLICE-1", status: "pending", components: ["api"] }],
    });
    const res = runNext(tp.paths);
    expect(res.data?.kind).toBe("dispatch-wave");
    // Task 5: the action recommends the single-payload `th build dispatch` …
    expect(res.data?.action).toContain("th build dispatch");
    // … while keeping the still-required per-slice claim step (dispatch is read-only).
    expect(res.data?.action).toContain("th build claim");
  });

  it("only in-progress slices remain → kind await-builders", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, {
      tier: "T2",
      current_stage: "implementation",
      interview_required: false,
      slices: [{ id: "SLICE-1", status: "in-progress", components: ["api"] }],
    });
    expect(runNext(tp.paths).data?.kind).toBe("await-builders");
  });

  it("a dependency deadlock → kind stalled-build (not a cheery dispatch-wave)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, {
      tier: "T2",
      current_stage: "implementation",
      interview_required: false,
      slices: [
        { id: "SLICE-1", status: "pending", components: ["a"], depends_on: ["SLICE-2"] },
        { id: "SLICE-2", status: "pending", components: ["b"], depends_on: ["SLICE-1"] },
      ],
    });
    expect(runNext(tp.paths).data?.kind).toBe("stalled-build");
  });
});

describe("REQ-NEXT-012: brownfield repo-map freshness gates pre-implementation work", () => {
  it("brownfield + tier set + NO repo-map → kind refresh-repo-map", () => {
    tp = makeTempProject();
    runInit(tp.paths, { brownfield: true });
    position(tp, { tier: "T2", interview_required: false });
    // No repo-map.json on disk → `th repo check` is no-map → must refresh first.
    const res = runNext(tp.paths);
    expect(res.data?.kind).toBe("refresh-repo-map");
    expect(res.data?.action).toContain("th repo map");
  });

  it("brownfield + tier set + STALE repo-map → kind refresh-repo-map", () => {
    tp = makeTempProject();
    runInit(tp.paths, { brownfield: true });
    position(tp, { tier: "T2", interview_required: false });
    // Build a fresh map, then mutate the tree so it drifts (stale).
    writeFile(tp, "src/foo.ts", "// REQ-001\nexport const x = 1;\n");
    runRepoMap(tp.paths, { write: true });
    writeFile(tp, "src/foo.ts", "// REQ-001\nexport const x = 2;\n"); // modified after snapshot.
    expect(runNext(tp.paths).data?.kind).toBe("refresh-repo-map");
  });

  it("brownfield + tier set + FRESH repo-map → does NOT emit refresh-repo-map", () => {
    tp = makeTempProject();
    runInit(tp.paths, { brownfield: true });
    position(tp, { tier: "T2", interview_required: false });
    writeFile(tp, "src/foo.ts", "// REQ-001\nexport const x = 1;\n");
    runRepoMap(tp.paths, { write: true }); // fresh snapshot of the current tree.
    expect(runNext(tp.paths).data?.kind).not.toBe("refresh-repo-map");
  });

  it("brownfield but implementation already unlocked → NOT refresh-repo-map (no build deadlock)", () => {
    tp = makeTempProject();
    runInit(tp.paths, { brownfield: true });
    position(tp, { tier: "T2", implementation_allowed: true, interview_required: false }); // building has begun.
    // No map (would be stale/absent), but the guard skips the gate once implementation is allowed.
    expect(runNext(tp.paths).data?.kind).not.toBe("refresh-repo-map");
  });

  it("greenfield + no repo-map → NOT refresh-repo-map (gate is brownfield-only)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {}); // greenfield.
    position(tp, { tier: "T2", interview_required: false });
    expect(runNext(tp.paths).data?.kind).not.toBe("refresh-repo-map");
  });
});

describe("REQ-NEXT-007: final-verification floor — slices then coverage then sign-off", () => {
  it("unfinished slices at final-verification → kind finish-slices", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, { tier: "T1" });
    writeFile(tp, "docs/09-implementation-plan.md", "### SLICE-1\nComponents touched: api\n");
    runSlicesSync(tp.paths, { planFile: "docs/09-implementation-plan.md" });
    position(tp, { current_stage: "final-verification" });
    expect(runNext(tp.paths).data?.kind).toBe("finish-slices");
  });
});

describe("REQ-NEXT-011: final-verification mirrors the stop-gate verify-suite check", () => {
  it("verify configured but never run at final-verification → kind run-verify", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, { tier: "T1" });
    writeFile(tp, "docs/09-implementation-plan.md", "### SLICE-1\nComponents touched: api\n");
    runSlicesSync(tp.paths, { planFile: "docs/09-implementation-plan.md" });
    // Settle the slice so the finish-slices floor is clear; configure a verify
    // command but never run it — exactly what the stop-gate blocks completion on.
    position(tp, {
      slices: [{ id: "SLICE-1", status: "done", components: ["api"] }],
      current_stage: "final-verification",
    });
    runVerifyAdd(tp.paths, "true");
    expect(runNext(tp.paths).data?.kind).toBe("run-verify");
  });

  it("verify configured AND run green at final-verification → no run-verify obligation", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, { tier: "T1" });
    writeFile(tp, "docs/09-implementation-plan.md", "### SLICE-1\nComponents touched: api\n");
    runSlicesSync(tp.paths, { planFile: "docs/09-implementation-plan.md" });
    position(tp, {
      slices: [{ id: "SLICE-1", status: "done", components: ["api"] }],
      current_stage: "final-verification",
    });
    runVerifyAdd(tp.paths, "true");
    runVerifyApprove(tp.paths, { as: "test", tty: { isTTY: true, stdinLine: "y" } });
    runVerifyRun(tp.paths); // green (`true` exits 0)
    expect(runNext(tp.paths).data?.kind).not.toBe("run-verify");
  });

  // FLAKE FIX (REQ-NEXT-011): a freshly-written verify report must NEVER read as
  // absent and re-trigger a spurious `run-verify`. The root cause was a
  // non-atomic report write + a read whose catch-all swallowed a transient
  // contention error as "absent" — under full-suite load a present report
  // intermittently looked missing. The report is now written atomically and read
  // with a bounded retry. This determinism check writes the report and reads the
  // obligation many times in a tight loop; before the fix this surfaced
  // `run-verify` intermittently, now it is always stable.
  it("REQ-NEXT-011 (flake fix): a green report is deterministically NOT judged un-run across many reads", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, { tier: "T1" });
    writeFile(tp, "docs/09-implementation-plan.md", "### SLICE-1\nComponents touched: api\n");
    runSlicesSync(tp.paths, { planFile: "docs/09-implementation-plan.md" });
    position(tp, {
      slices: [{ id: "SLICE-1", status: "done", components: ["api"] }],
      current_stage: "final-verification",
    });
    runVerifyAdd(tp.paths, "true");
    runVerifyApprove(tp.paths, { as: "test", tty: { isTTY: true, stdinLine: "y" } });
    runVerifyRun(tp.paths); // green report on disk

    for (let i = 0; i < 50; i++) {
      const kind = runNext(tp.paths).data?.kind;
      // The settled green run owes a human sign-off, never a re-run of verify.
      expect(kind).not.toBe("run-verify");
    }
  });
});

describe("ARCH-005 flake substrate: verify report write/read is atomic + retrying (REQ-NEXT-011)", () => {
  it("writeVerifyReport then readVerifyReport round-trips and never reads a present report as null", () => {
    tp = makeTempProject();
    const report = { ok: true, ranAt: new Date().toISOString(), results: [] };
    // Repeated atomic write + retrying read must always return the present report,
    // never null (the failure mode that re-triggered run-verify).
    for (let i = 0; i < 100; i++) {
      writeVerifyReport(tp.paths, report);
      const got = readVerifyReport(tp.paths);
      expect(got).not.toBeNull();
      expect(got!.ok).toBe(true);
    }
  });
});

describe("REQ-NEXT-010: --explain adds a WHY for the chosen obligation", () => {
  it("default (no --explain) carries no why; --explain adds a why to data + human", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Tier unclassified → the obligation is classify-tier (a stable, simple case).
    const plain = runNext(tp.paths);
    expect(plain.data?.kind).toBe("classify-tier");
    expect(plain.data?.why).toBeUndefined();
    expect(plain.human).not.toMatch(/why:/);

    const explained = runNext(tp.paths, { explain: true });
    expect(explained.data?.kind).toBe("classify-tier");
    expect(typeof explained.data?.why).toBe("string");
    expect((explained.data?.why as string).length).toBeGreaterThan(0);
    // The WHY explains the ORDERING (why it gates), not just the action.
    expect(explained.data?.why).toMatch(/tier/i);
    expect(explained.human).toMatch(/^why: /m);
    // The action line is unchanged whether or not --explain is passed.
    expect(explained.data?.action).toBe(plain.data?.action);
  });

  it("the highest-priority obligation's why explains why it outranks the rest", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    position(tp, { tier: "T2", interview_required: false });
    // Open blocking drift is the top-priority obligation; its WHY must cite the stop-gate.
    runDriftAdd(tp.paths, { layer: "requirement", ref: "SLICE-1 / TASK-1", discovery: "x", action: "paused" });
    const res = runNext(tp.paths, { explain: true });
    expect(res.data?.kind).toBe("resolve-blocking-drift");
    expect(res.data?.why).toMatch(/stop-gate|completion/i);
  });
});
