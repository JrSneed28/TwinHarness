/**
 * Stop-gate stage canonicalization (F-2, C-1/M-2).
 *
 * Before the fix the stop-gate compared `current_stage === "final-verification"`
 * exactly, so near-miss spellings (`Final-Verification`, `10-final-verification`)
 * slipped past the final-verification slice-completeness check and a run with
 * unfinished slices was allowed to complete. The gate now canonicalizes via
 * `isFinalVerification`, so every spelling that means final-verification blocks.
 *
 * Note on `done`/`complete`: those are NOT final-verification (canonicalizeStage
 * is deliberately conservative — see stages-predicate.test.ts) and are closed at
 * the WRITE path instead — `th state set current_stage done` is rejected as an
 * unknown stage (see state-set-gate-fields.test.ts), so they can never be the
 * stored stage via the CLI or MCP surface.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { evaluateStopGate, runHookStopGate } from "../src/commands/hook";
import { writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import type { ProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function write(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

const UNFINISHED_SLICES = [
  { id: "SLICE-1", status: "pending" as const, components: [] },
  { id: "SLICE-2", status: "in-progress" as const, components: [] },
];

describe("F-2/C-1: final-verification near-misses block premature completion", () => {
  const nearMisses = [
    "final-verification",
    "Final-Verification",
    "FINAL-VERIFICATION",
    " final-verification ",
    "10-final-verification",
  ];

  it.each(nearMisses)("blocks completion at current_stage=%j with unfinished slices", (stage) => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeState(tp.paths, { ...initialState(), current_stage: stage, slices: UNFINISHED_SLICES });

    const decision = evaluateStopGate(tp.paths);
    expect(decision.block).toBe(true);

    const hook = runHookStopGate(tp.paths);
    expect(JSON.parse(hook.stdout).decision).toBe("block");
  });

  it("still allows at a non-final stage with pending slices (mid-build pause, unchanged)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeState(tp.paths, { ...initialState(), current_stage: "implementation", slices: UNFINISHED_SLICES });

    expect(evaluateStopGate(tp.paths).block).toBe(false);
  });

  it("allows at a final-verification near-miss once the full completion ladder is green", () => {
    // R-29: the Stop gate now runs the full checkFinalVerification ladder, so the
    // near-miss spelling must canonicalize AND the run must clear coverage/report/Tester.
    // The point of this test (the `10-` prefix canonicalizes to final-verification) holds:
    // with the green scaffold the gate allows, proving the near-miss reached the same
    // final ladder as the canonical spelling.
    tp = makeTempProject();
    const paths = tp.paths;
    write(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
    write(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-1 covers REQ-001.\n");
    write(paths, "tests/cov.test.ts", "// REQ-001 verified here\n");
    write(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
    writeState(paths, {
      ...initialState(),
      tier: "T1",
      current_stage: "10-final-verification",
      implementation_allowed: true,
      slices: [
        { id: "SLICE-1", status: "done", components: [] },
        { id: "SLICE-2", status: "blocked", components: [] },
      ],
    });
    expect(runArtifactRegister(paths, "docs/10-verification-report.md", 1).ok).toBe(true);
    expect(runTesterRecord(paths, { driver: "cli-e2e", passed: true }).ok).toBe(true);

    expect(evaluateStopGate(paths).block).toBe(false);
  });
});
