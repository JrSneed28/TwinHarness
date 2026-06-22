/**
 * Axis-B slice-3a (BSC-7) — human-approval stage-advance rung, WARN PHASE (commit C-1).
 *
 * This commit registers + invokes the rung but blocks NOTHING. The rung fires when
 * advancing OUT of a `humanGate` stage; when the stage carries no valid approval it
 * surfaces a NON-blocking `notice` (stable token `human_approval_unverified` + the
 * `{ stage, status }` detail) while STILL returning `ok:true`. These tests pin that
 * warn-only behavior so the later enforce-flip (C-3) is a deliberate, observable change:
 *
 *   1. The exported rung `checkHumanApprovalAdvance` returns ok:true + the notice when
 *      no approval exists, and a clean PASS (no notice) once an approval is minted.
 *   2. Driven through the real `canAdvanceStage` ladder, advancing out of a humanGate
 *      stage with NO approval still SUCCEEDS (ok:true) AND carries the warning notice.
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

describe("BSC-7 slice-3a — human-approval advance rung (WARN phase, blocks nothing)", () => {
  it("checkHumanApprovalAdvance warns (ok:true + notice naming stage+token) when no approval exists", () => {
    const paths = greenAtHumanGateStage(HUMAN_GATE_STAGE);
    const state = readState(paths).state!;
    const r = gate.checkHumanApprovalAdvance(paths, state);

    // WARN: passes (blocks nothing) but surfaces the structured notice.
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.notice).toBeDefined();
    expect(r.notice!.token).toBe("human_approval_unverified");
    expect(r.notice!.detail).toMatchObject({ stage: HUMAN_GATE_STAGE, status: "absent" });
  });

  it("advancing OUT of a humanGate stage with NO approval still SUCCEEDS (canAdvanceStage stays a clean PASS — blocks nothing)", () => {
    const paths = greenAtHumanGateStage(HUMAN_GATE_STAGE);
    const state = readState(paths).state!;

    // WARN-PHASE TRANSPARENCY: the whole advance ladder still passes and is UNPERTURBED
    // (no block, no error) — the warn rung does not change canAdvanceStage's verdict. The
    // warning itself is observed on the rung's OWN result (next assertion), which is the
    // seam the enforce-flip (C-3) turns into a block.
    const adv = gate.canAdvanceStage(paths, state);
    expect(adv.ok).toBe(true);
    expect(adv.error).toBeUndefined();

    // The warning IS observable on the rung (names the offending stage + token).
    const r = gate.checkHumanApprovalAdvance(paths, state);
    expect(r.ok).toBe(true);
    expect(r.notice!.token).toBe("human_approval_unverified");
    expect(r.notice!.detail).toMatchObject({ stage: HUMAN_GATE_STAGE, status: "absent" });
  });

  it("with a minted approval the rung passes cleanly with NO warning", () => {
    const paths = greenAtHumanGateStage(HUMAN_GATE_STAGE);
    // Mint a valid in-process approval bound to the registered artifact's digest.
    mintApprovalForFixture(paths, HUMAN_GATE_STAGE);
    expect(readApprovalValidated(paths, HUMAN_GATE_STAGE).status).toBe("valid");

    const state = readState(paths).state!;
    const r = gate.checkHumanApprovalAdvance(paths, state);
    expect(r.ok).toBe(true);
    expect(r.notice).toBeUndefined();

    // canAdvanceStage still a clean pass (no warning to surface).
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
