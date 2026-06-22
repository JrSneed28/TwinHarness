/**
 * Axis-B slice-3a (BSC-7) — human-approval stage-advance rung, ENFORCE PHASE (commit C-3).
 *
 * The prior commit (C-1, `e1de8fd`) introduced this rung in a WARN phase: it surfaced a
 * NON-blocking `notice` (token `human_approval_unverified`) but still returned `ok:true`,
 * so advancing out of a `humanGate` stage with no approval SUCCEEDED. This commit (C-3)
 * flips the single seam return warn→block: the rung now returns `ok:false` with
 * `error:"human_approval_unverified"` and `detail:{ stage, status }`. These tests are the
 * INVERSE of the C-1 warn assertions — they pin the BLOCK so the warn→enforce flip is a
 * deliberate, observable change (a reviewer can `git revert` C-3 and land back on the
 * green warn baseline, whose assertions this file replaced):
 *
 *   1. The exported rung `checkHumanApprovalAdvance` returns ok:false + the stable token +
 *      `{ stage, status }` detail when no approval exists, and a clean PASS once an
 *      approval is minted.
 *   2. Driven through the real `canAdvanceStage` ladder, advancing out of a humanGate stage
 *      with NO approval now BLOCKS (ok:false) with the same token — and a minted approval
 *      lets the ladder reach a clean PASS.
 *   3. `mintApprovalForFixture()` mints a VALID approval (smoke test of the helper).
 *
 * Deterministic + Windows-safe (path.join, no shell).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, mintApprovalForFixture, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import * as gate from "../src/core/gate-preconditions";
import { readApprovalValidated } from "../src/core/approvals";
import { stageContract } from "../src/core/stages";
import type { ProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

const HUMAN_GATE_STAGE = "requirements";

/** A minimal scaffold so the green rungs ahead of the approval rung do not block. */
function layDownGreenScaffold(paths: ProjectPaths): void {
  write(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  write(paths, "tests/cov.test.ts", "// REQ-001 verified here\n");
}

function write(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

/**
 * Lay down a run sitting at a `humanGate` stage with its governing artifact registered,
 * so `canAdvanceStage` reaches the approval rung (earlier rungs pass). Returns the paths.
 */
function greenAtHumanGateStage(stage: string): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  layDownGreenScaffold(paths);
  // Register the stage's governing artifact so checkGoverningArtifact passes.
  const rel = stageContract(stage)!.produces.replace(/\/$/, "");
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, `# ${stage}\n\n- REQ-001 covered.\n`, "utf8");
  writeState(paths, {
    ...initialState(),
    tier: "T3",
    current_stage: stage,
    // The soft interview gate (checkInterview) would otherwise block advancing PAST
    // `requirements` for a T3 run with no interview; disable it so the ladder reaches
    // the approval rung under test (the interview gate is orthogonal to this rung).
    interview_required: false,
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  runArtifactRegister(paths, rel, 1);
  return paths;
}

describe("BSC-7 slice-3a — human-approval advance rung (ENFORCE phase, blocks the advance)", () => {
  it("checkHumanApprovalAdvance BLOCKS (ok:false + token + {stage,status}) when no approval exists", () => {
    const paths = greenAtHumanGateStage(HUMAN_GATE_STAGE);
    const state = readState(paths).state!;
    const r = gate.checkHumanApprovalAdvance(paths, state);

    // ENFORCE: the rung now blocks with the stable token and structured detail; the warn
    // baseline (C-1, e1de8fd) instead returned ok:true + a non-blocking `notice`.
    expect(r.ok).toBe(false);
    expect(r.error).toBe("human_approval_unverified");
    expect(r.notice).toBeUndefined();
    expect(r.detail).toMatchObject({ stage: HUMAN_GATE_STAGE, status: "absent" });
  });

  it("advancing OUT of a humanGate stage with NO approval now BLOCKS (canAdvanceStage returns the token)", () => {
    const paths = greenAtHumanGateStage(HUMAN_GATE_STAGE);
    const state = readState(paths).state!;

    // ENFORCE SEAM: the rung's verdict is now canAdvanceStage's verdict — the whole advance
    // ladder refuses with human_approval_unverified (the inverse of the C-1 warn test, which
    // asserted the ladder stayed a clean ok:true PASS while only the rung carried a notice).
    const adv = gate.canAdvanceStage(paths, state);
    expect(adv.ok).toBe(false);
    expect(adv.error).toBe("human_approval_unverified");
    expect(adv.detail).toMatchObject({ stage: HUMAN_GATE_STAGE, status: "absent" });
  });

  it("with a minted approval the rung passes cleanly and the advance ladder reaches PASS", () => {
    const paths = greenAtHumanGateStage(HUMAN_GATE_STAGE);
    // Mint a valid in-process approval bound to the registered artifact's digest.
    mintApprovalForFixture(paths, HUMAN_GATE_STAGE);
    expect(readApprovalValidated(paths, HUMAN_GATE_STAGE).status).toBe("valid");

    const state = readState(paths).state!;
    const r = gate.checkHumanApprovalAdvance(paths, state);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.notice).toBeUndefined();

    // canAdvanceStage now reaches a clean pass (the approval cleared the only blocking rung).
    const adv = gate.canAdvanceStage(paths, state);
    expect(adv.ok).toBe(true);
  });

  it("mintApprovalForFixture mints a VALID approval (helper smoke test)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const sealed = mintApprovalForFixture(paths, "scope");
    expect(sealed.kind).toBe("human-approval");
    expect(sealed.stage).toBe("scope");
    expect(sealed.producer_kind).toBe("in-process");
    expect(readApprovalValidated(paths, "scope").status).toBe("valid");
  });
});
