/**
 * Axis-B slice-3a (BSC-7) — the SIX-surface human-approval negative-control suite
 * (consensus plan §7 / §8 / §10 e2e-probe). Each enumerated bypass surface must BLOCK
 * at the correct gate with the correct STABLE TOKEN/status, AND is paired with a
 * NON-VACUOUS positive twin in THIS file (the correct/current/valid approval actually
 * PASSES, proving the block is the approval check and not an unrelated rung):
 *
 *   (a) Absent                       — advance out of a humanGate stage with no approval →
 *                                       `absent` → BLOCK at BOTH stage-advance and completion.
 *   (b) Forged / external-claim-no-sig— an in-process approval CLAIMING producer_kind
 *                                       "external" with no verifying signature → `forged` →
 *                                       BLOCK (completion + surfaced at advance). Positive in
 *                                       3a = a legit in-process approval (no external claim)
 *                                       for the SAME stage → `valid` → PASS.
 *   (c) Wrong-stage / stale-snapshot — approval bound to a different stage, or to a
 *                                       snapshot_coord/governing_artifact_digest that no longer
 *                                       matches the tree → `target_mismatch`/`stale` → BLOCK both.
 *   (d) --emergency / raw state set  — jump current_stage past a humanGate stage via the
 *                                       state.ts normalization path → completion re-check STILL
 *                                       blocks (closed required-set) → BLOCK at completion (L1).
 *   (e) Replay                       — reuse a prior-snapshot approval after the governing
 *                                       artifact changed → `target_mismatch`/`stale` → BLOCK both.
 *   (f) Store / migration-marker tampering — (i) truncated/deleted store WITH marker present →
 *                                       `absent` → BLOCK; (ii) DELETED migration marker + engaged
 *                                       humanGate stages unreceipted → BLOCK (NOT `legacy`-PASS);
 *                                       (iii) hash-chain-head truncation → `tampered` → BLOCK.
 *
 * Plus: absent-`producer_kind` → in-process `valid` discrimination (the external precedence
 * fires ONLY on an explicit producer_kind==="external" claim); the marker-baseline-injection
 * control (a hand-edited marker baseline naming a stage with NO on-disk chain-sealed
 * `legacy:true` stamp must NOT classify `legacy`-PASS — HARDENED in approvals.ts so the
 * baseline is cross-checked against a real stamp); and the approve.ts default-stage refusal.
 *
 * Deterministic + Windows-safe (path.join, no shell). The `stale` snapshot surfaces use a
 * real git repo and skip when git is unavailable.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempProject, mintApprovalForFixture, mintRequiredApprovals, mintAssertionPresenceForFixture, ASSERTED_COV_TEST, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { runTesterRecord } from "../src/commands/tester";
import { runApprove } from "../src/commands/approve";
import { runStateSet } from "../src/commands/state";
import {
  checkHumanApprovalAdvance,
  canAdvanceStage,
  canCompleteRun,
  checkProductionReality,
  requiredHumanGateStages,
} from "../src/core/gate-preconditions";
import {
  appendApprovalReceipt,
  approvalReceiptsPath,
  externalApprovalsPath,
  readApprovalReceipts,
  readApprovalValidated,
  readLastApprovalRecordHash,
  computeApprovalRecordHash,
  grandfatheredBaseline,
  ensureApprovalMigration,
  type HumanApprovalReceipt,
} from "../src/core/approvals";
import { stageContract } from "../src/core/stages";
import { computeTargetDigest } from "../src/core/receipts";
import { GENESIS_PREV_HASH } from "../src/core/hash";
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

/** Write a humanGate stage's governing artifact so an approval can bind its digest. */
function writeStageArtifact(root: string, stage: string, content = "x\n"): string {
  const rel = stageContract(stage)!.produces.replace(/\/$/, "");
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

/**
 * Seal a hand-built approval onto the in-process chain (bypassing the producer's
 * refuse-at-creation gate) so a control can pin an arbitrary recorded
 * snapshot_coord / digest / producer_kind. Mirrors `tests/approvals.test.ts`.
 */
function appendRawApproval(
  paths: ProjectPaths,
  fields: Omit<HumanApprovalReceipt, "prevHash" | "recordHash">,
): HumanApprovalReceipt {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const prevHash = readLastApprovalRecordHash(paths);
  const withPrev = { ...fields, prevHash };
  const recordHash = computeApprovalRecordHash(withPrev);
  const sealed: HumanApprovalReceipt = { ...withPrev, recordHash };
  fs.appendFileSync(approvalReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

/** A real git repo with one commit at `root`, or false when git is unavailable. */
function initGitRepo(root: string): boolean {
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run(["init"]).error) return false;
  run(["config", "user.email", "t@t.t"]);
  run(["config", "user.name", "t"]);
  run(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, ".gitkeep"), "x\n", "utf8");
  run(["add", "-A"]);
  const c = run(["commit", "-m", "init", "--no-gpg-sign"]);
  return !c.error && c.status === 0;
}

// ---------------------------------------------------------------------------
// Shared fixtures for the stage-advance (per-stage) and completion (closed-set) gates.
// ---------------------------------------------------------------------------

/**
 * A run sitting AT a `humanGate` stage with its governing artifact registered, so
 * `canAdvanceStage` reaches the human-approval advance rung (earlier rungs pass).
 * Mirrors `tests/gate-human-approval-warn.test.ts:greenAtHumanGateStage`.
 */
function greenAtHumanGateStage(stage: string): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  write(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  write(paths, "tests/cov.test.ts", "// REQ-001 verified here\n");
  const rel = stageContract(stage)!.produces.replace(/\/$/, "");
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, `# ${stage}\n\n- REQ-001 covered.\n`, "utf8");
  writeState(paths, {
    ...initialState(),
    tier: "T3",
    current_stage: stage,
    interview_required: false,
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  runArtifactRegister(paths, rel, 1);
  return paths;
}

function attachTesterRecord(paths: ProjectPaths): void {
  expect(runTesterRecord(paths, { driver: "cli-e2e", provider: "sandbox", passed: true }).ok).toBe(true);
}

/**
 * A run whose entire final-verification ladder is GREEN EXCEPT the human-approval
 * completion rung — slices settled, no verify config, coverage clean, report registered,
 * Tester record attached, no dist/. The human-approval required-set is NOT yet minted, so
 * the ONLY remaining lever is the approval condition each control perturbs. Mirrors
 * `tests/production-reality.test.ts:greenAtFinalVerification` but WITHOUT the approval mint.
 */
function greenAtFinalVerificationNoApprovals(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  write(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
  write(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
  // BSC-2 slice-6: REQ-001's test file carries a NON-TRIVIAL assertion (was a bare comment).
  write(paths, "tests/cov.test.ts", ASSERTED_COV_TEST);
  write(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
  writeState(paths, {
    ...initialState(),
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  expect(runArtifactRegister(paths, "docs/10-verification-report.md", 1).ok).toBe(true);
  attachTesterRecord(paths);
  return paths;
}

/**
 * Author + register every required humanGate stage's governing artifact for the
 * final-verification run, so a positive control can mint REAL (digest-binding) approvals
 * across the closed required-set. (The T1 required-set is requirements/scope/architecture/
 * ux-design/ui-design/final-verification.) Returns the paths.
 */
function greenAtFinalVerificationArtifacts(): ProjectPaths {
  const paths = greenAtFinalVerificationNoApprovals();
  for (const stage of requiredHumanGateStages(state(paths))) {
    const rel = stageContract(stage)!.produces.replace(/\/$/, "");
    const abs = path.resolve(paths.root, rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `# ${stage}\n\n- REQ-001 covered.\n`, "utf8");
    }
  }
  // BSC-2 slice-6: mint the F8-bound assertion-presence receipt LAST (after every tests/** write —
  // only docs/** are authored here). Harmless for the BLOCK controls (they short-circuit on the
  // human-approval rung, composed BEFORE the assertion rung); the POSITIVE controls reach the
  // assertion rung's PASS arm and need it. The later inline mintRequiredApprovals writes only
  // docs/** placeholders, so the tests/-scoped ground digest stays valid.
  mintAssertionPresenceForFixture(paths);
  return paths;
}

// ===========================================================================
// (a) ABSENT — BLOCK at BOTH stage-advance and completion; positive PASSes both.
// ===========================================================================
describe("BSC-7 negative-control (a): ABSENT approval", () => {
  it("advance out of a humanGate stage with NO approval → absent → BLOCK at stage-advance", () => {
    const paths = greenAtHumanGateStage("requirements");
    const r = checkHumanApprovalAdvance(paths, state(paths));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("human_approval_unverified");
    expect(r.detail).toMatchObject({ stage: "requirements", status: "absent" });
    // Driven through the real advance ladder, the verdict is the rung's verdict.
    const adv = canAdvanceStage(paths, state(paths));
    expect(adv.ok).toBe(false);
    expect(adv.error).toBe("human_approval_unverified");
    expect(adv.detail).toMatchObject({ stage: "requirements", status: "absent" });
  });

  it("complete with a required-set approval missing → absent → BLOCK at completion (L1)", () => {
    const paths = greenAtFinalVerificationArtifacts();
    // No approvals minted ⇒ the first required stage classifies `absent`.
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("human_approval_unverified");
    expect(res.detail!.status).toBe("absent");
    expect(canCompleteRun(paths, state(paths)).error).toBe("human_approval_unverified");
  });

  it("POSITIVE: a minted valid approval clears the stage-advance gate", () => {
    const paths = greenAtHumanGateStage("requirements");
    mintApprovalForFixture(paths, "requirements");
    expect(readApprovalValidated(paths, "requirements").status).toBe("valid");
    expect(checkHumanApprovalAdvance(paths, state(paths)).ok).toBe(true);
    expect(canAdvanceStage(paths, state(paths)).ok).toBe(true);
  });

  it("POSITIVE: the fully-approved closed required-set clears the completion gate", () => {
    const paths = greenAtFinalVerificationArtifacts();
    mintRequiredApprovals(paths, state(paths));
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
    expect(canCompleteRun(paths, state(paths))).toEqual({ ok: true });
  });
});

// ===========================================================================
// (b) FORGED — an in-process line CLAIMING producer_kind:"external" with no verifying
//     signature → `forged` → BLOCK. POSITIVE (non-vacuous in 3a): a legit in-process
//     approval (no external claim) for the SAME stage → `valid` → PASS.
// ===========================================================================
describe("BSC-7 negative-control (b): FORGED external-claim-without-signature", () => {
  /** Write an external-CLAIMING line (bogus signature) for `stage` into the external store. */
  function writeForgedExternal(paths: ProjectPaths, stage: string, digest: string): void {
    const ext: Omit<HumanApprovalReceipt, "recordHash"> = {
      kind: "human-approval",
      stage,
      approval_of: { snapshot_coord: { gitHead: null, treeDigest: null }, governing_artifact_digest: digest },
      producer_identity: "external:forger",
      producer_kind: "external",
      key_id: "deadbeef",
      signature: "A".repeat(86) + "==",
      prevHash: GENESIS_PREV_HASH,
    };
    const recordHash = computeApprovalRecordHash(ext);
    fs.writeFileSync(externalApprovalsPath(paths), JSON.stringify({ ...ext, recordHash }) + "\n", "utf8");
  }

  it("a forged external claim → forged → BLOCK at completion (the unprovable claim cannot pass)", () => {
    const paths = greenAtFinalVerificationArtifacts();
    // Mint the whole valid required-set first (so the ONLY perturbation is the forged claim).
    mintRequiredApprovals(paths, state(paths));
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true }); // baseline green
    // Now overlay a forged external claim on one required stage — it must WIN (fail-closed).
    const digest = computeTargetDigest(paths.root, stageContract("requirements")!.produces)!;
    writeForgedExternal(paths, "requirements", digest);
    expect(readApprovalValidated(paths, "requirements").status).toBe("forged");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("human_approval_unverified");
    expect(res.detail).toMatchObject({ stage: "requirements", status: "forged" });
  });

  it("a forged external claim is ALSO surfaced at stage-advance → BLOCK with status `forged`", () => {
    const paths = greenAtHumanGateStage("requirements");
    // A legit in-process approval exists, yet the forged external claim outranks it.
    mintApprovalForFixture(paths, "requirements");
    const digest = computeTargetDigest(paths.root, stageContract("requirements")!.produces)!;
    writeForgedExternal(paths, "requirements", digest);
    const r = checkHumanApprovalAdvance(paths, state(paths));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("human_approval_unverified");
    expect(r.detail).toMatchObject({ stage: "requirements", status: "forged" });
  });

  it("POSITIVE: a legit in-process approval (NO external claim) for the SAME stage → valid → PASS", () => {
    const paths = greenAtHumanGateStage("requirements");
    mintApprovalForFixture(paths, "requirements");
    // No external store written at all → the in-process valid path fires (non-vacuous).
    expect(readApprovalValidated(paths, "requirements").status).toBe("valid");
    expect(checkHumanApprovalAdvance(paths, state(paths)).ok).toBe(true);
  });
});

// ===========================================================================
// (c) WRONG-STAGE / STALE-SNAPSHOT — target_mismatch / stale → BLOCK both gates.
//     POSITIVE: a correctly-bound current approval passes.
// ===========================================================================
describe("BSC-7 negative-control (c): WRONG-STAGE / STALE binding", () => {
  it("approval bound to a digest that no longer matches the tree → target_mismatch → BLOCK both gates", () => {
    const paths = greenAtHumanGateStage("requirements");
    mintApprovalForFixture(paths, "requirements"); // binds the CURRENT artifact digest
    expect(readApprovalValidated(paths, "requirements").status).toBe("valid");
    // Mutate the governing artifact AFTER minting → the recorded digest no longer matches.
    write(paths, stageContract("requirements")!.produces.replace(/\/$/, ""), "# EDITED requirements\n");
    expect(readApprovalValidated(paths, "requirements").status).toBe("target_mismatch");
    // Stage-advance blocks.
    const adv = checkHumanApprovalAdvance(paths, state(paths));
    expect(adv.ok).toBe(false);
    expect(adv.detail).toMatchObject({ stage: "requirements", status: "target_mismatch" });

    // Completion blocks too — build a final-verification run with the same drift.
    const cp2 = greenAtFinalVerificationArtifacts();
    mintRequiredApprovals(cp2, state(cp2));
    write(cp2, stageContract("requirements")!.produces.replace(/\/$/, ""), "# EDITED again\n");
    const res = checkProductionReality(cp2, state(cp2));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatchObject({ stage: "requirements", status: "target_mismatch" });
  });

  it("approval bound to a DIFFERENT stage does not satisfy the gate for the crossed stage (absent)", () => {
    const paths = greenAtHumanGateStage("requirements");
    // Mint a valid approval for `scope`, NOT `requirements`. The requirements gate is unmet.
    mintApprovalForFixture(paths, "scope");
    expect(readApprovalValidated(paths, "scope").status).toBe("valid"); // valid for the OTHER stage
    expect(readApprovalValidated(paths, "requirements").status).toBe("absent"); // not for THIS one
    const adv = checkHumanApprovalAdvance(paths, state(paths));
    expect(adv.ok).toBe(false);
    expect(adv.detail).toMatchObject({ stage: "requirements", status: "absent" });
  });

  it("stale — recorded snapshot_coord gitHead diverged → stale → BLOCK (requires git)", () => {
    const paths = greenAtHumanGateStage("requirements");
    if (!initGitRepo(paths.root)) return; // skip when git unavailable
    const rel = stageContract("requirements")!.produces.replace(/\/$/, "");
    const digest = computeTargetDigest(paths.root, rel)!;
    appendRawApproval(paths, {
      kind: "human-approval",
      stage: "requirements",
      approval_of: {
        snapshot_coord: { gitHead: "0000000000000000000000000000000000000000", treeDigest: null },
        governing_artifact_digest: digest,
      },
      producer_identity: "x",
      producer_kind: "in-process",
    });
    const v = readApprovalValidated(paths, "requirements");
    expect(v.status).toBe("stale");
    expect(v.staleReasons).toContain("gitHead");
    const adv = checkHumanApprovalAdvance(paths, state(paths));
    expect(adv.ok).toBe(false);
    expect(adv.detail).toMatchObject({ stage: "requirements", status: "stale" });
  });

  it("POSITIVE: a correctly-bound CURRENT approval passes both gates", () => {
    const paths = greenAtFinalVerificationArtifacts();
    mintRequiredApprovals(paths, state(paths));
    // No artifact drift → every required approval binds the current digest.
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
    expect(canCompleteRun(paths, state(paths))).toEqual({ ok: true });
  });
});

// ===========================================================================
// (d) --emergency / raw `state set` jump past a humanGate stage → completion STILL
//     blocks (closed required-set). POSITIVE: same jump WITH required approvals minted.
// ===========================================================================
describe("BSC-7 negative-control (d): --emergency / raw state set jump", () => {
  /** A mid-pipeline run (no approvals) that we will jump to final-verification. */
  function midPipelineRun(): ProjectPaths {
    tp = makeTempProject();
    const paths = tp.paths;
    write(paths, "docs/01-requirements.md", "# Requirements\n\n- REQ-001 the only requirement.\n");
    write(paths, "docs/09-implementation-plan.md", "# Plan\n\nSLICE-0 covers REQ-001.\n");
    // BSC-2 slice-6: REQ-001's test file carries a NON-TRIVIAL assertion (was a bare comment).
    write(paths, "tests/cov.test.ts", ASSERTED_COV_TEST);
    write(paths, "docs/10-verification-report.md", "# Verification Report\n\nREQ-001 verified.\n");
    writeState(paths, {
      ...initialState(),
      tier: "T1",
      current_stage: "requirements",
      implementation_allowed: true,
      slices: [{ id: "SLICE-0", status: "done", components: [] }],
    });
    expect(runArtifactRegister(paths, "docs/10-verification-report.md", 1).ok).toBe(true);
    attachTesterRecord(paths);
    // Author the artifacts so a POSITIVE mint can bind real digests after the jump.
    for (const stage of ["requirements", "scope", "architecture", "ux-design", "ui-design", "final-verification"]) {
      const rel = stageContract(stage)!.produces.replace(/\/$/, "");
      const abs = path.resolve(paths.root, rel);
      if (!fs.existsSync(abs)) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `# ${stage}\n\n- REQ-001 covered.\n`, "utf8");
      }
    }
    // BSC-2 slice-6: mint the F8-bound assertion-presence receipt LAST (only docs/** authored
    // here). Harmless for the BLOCK control (it short-circuits on human-approval before the
    // assertion rung); the POSITIVE control reaches the assertion rung's PASS arm and needs it.
    mintAssertionPresenceForFixture(paths);
    return paths;
  }

  it("jumping current_stage to final-verification via `state set --emergency` STILL blocks completion", () => {
    const paths = midPipelineRun();
    // The gate-owned current_stage jump goes through the state.ts enum-normalization path.
    const set = runStateSet(paths, "current_stage", "final-verification", { emergency: true });
    expect(set.ok).toBe(true); // the jump itself succeeds (emergency-forced)
    expect(state(paths).current_stage).toBe("final-verification");
    // The closed required-set now makes the jumped-over humanGate stages required → BLOCK.
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("human_approval_unverified");
    expect(res.detail!.status).toBe("absent");
    expect(canCompleteRun(paths, state(paths)).error).toBe("human_approval_unverified");
  });

  it("POSITIVE: the SAME jump with the required-set minted → completion passes", () => {
    const paths = midPipelineRun();
    expect(runStateSet(paths, "current_stage", "final-verification", { emergency: true }).ok).toBe(true);
    mintRequiredApprovals(paths, state(paths));
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
    expect(canCompleteRun(paths, state(paths))).toEqual({ ok: true });
  });
});

// ===========================================================================
// (e) REPLAY — reuse a prior-snapshot approval after the governing artifact changed →
//     target_mismatch → BLOCK both gates. POSITIVE: re-mint at the new snapshot → passes.
// ===========================================================================
describe("BSC-7 negative-control (e): REPLAY a prior-snapshot approval", () => {
  it("an approval minted at an OLD artifact state is invalid after the artifact changes → BLOCK", () => {
    const paths = greenAtHumanGateStage("requirements");
    const rel = stageContract("requirements")!.produces.replace(/\/$/, "");
    write(paths, rel, "# requirements v1\n");
    mintApprovalForFixture(paths, "requirements"); // binds the v1 digest
    expect(readApprovalValidated(paths, "requirements").status).toBe("valid");
    // The artifact moves on (a later revision) but the OLD approval is replayed.
    write(paths, rel, "# requirements v2 (governing artifact changed)\n");
    expect(readApprovalValidated(paths, "requirements").status).toBe("target_mismatch");
    const adv = checkHumanApprovalAdvance(paths, state(paths));
    expect(adv.ok).toBe(false);
    expect(adv.detail).toMatchObject({ stage: "requirements", status: "target_mismatch" });
  });

  it("POSITIVE: re-minting the approval at the NEW snapshot clears the gate again", () => {
    const paths = greenAtHumanGateStage("requirements");
    const rel = stageContract("requirements")!.produces.replace(/\/$/, "");
    write(paths, rel, "# requirements v1\n");
    mintApprovalForFixture(paths, "requirements");
    write(paths, rel, "# requirements v2\n");
    expect(readApprovalValidated(paths, "requirements").status).toBe("target_mismatch"); // replay blocked
    // Re-mint at v2: the newest in-process record binds the v2 digest → valid again.
    mintApprovalForFixture(paths, "requirements");
    expect(readApprovalValidated(paths, "requirements").status).toBe("valid");
    expect(checkHumanApprovalAdvance(paths, state(paths)).ok).toBe(true);
  });
});

// ===========================================================================
// (f) STORE / MIGRATION-MARKER TAMPERING — three sub-cases. POSITIVE for each: intact store.
// ===========================================================================
describe("BSC-7 negative-control (f): store / migration-marker tampering", () => {
  it("(i) truncated/deleted approval store WITH marker present → required approvals → absent → BLOCK", () => {
    const paths = greenAtFinalVerificationArtifacts();
    mintRequiredApprovals(paths, state(paths));
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true }); // baseline green
    // Mark migration done (marker PRESENT) with an empty baseline, then DELETE the store.
    ensureApprovalMigration(paths, []); // writes the marker; baseline empty
    fs.rmSync(approvalReceiptsPath(paths), { force: true }); // truncate/delete the store
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("human_approval_unverified");
    expect(res.detail!.status).toBe("absent"); // marker present but store gone → absent, NOT a pass
  });

  it("(ii) DELETED migration marker + engaged stages unreceipted → BLOCK (NOT downgraded to legacy-PASS)", () => {
    const paths = greenAtFinalVerificationArtifacts();
    // Migrate (stamps legacy for `requirements`), then DELETE the marker (the receipts.ts:710-715-style
    // full-bypass attempt: a missing marker must NOT blanket-`legacy`-PASS every post-regime stage).
    ensureApprovalMigration(paths, ["requirements"]);
    fs.rmSync(path.join(paths.stateDir, ".approval-receipts-migration"), { force: true });
    // A stage with NO record and an empty (marker-gone) baseline classifies `absent` → BLOCK.
    expect(readApprovalValidated(paths, "architecture").status).toBe("absent");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("human_approval_unverified");
    expect(res.detail!.status).toBe("absent");
  });

  it("(iii) hash-chain-HEAD truncation → tampered → BLOCK (never silent absent)", () => {
    const paths = greenAtFinalVerificationArtifacts();
    // Two appends, then delete the FIRST line so the survivor's prevHash ≠ GENESIS.
    mintApprovalForFixture(paths, "requirements");
    mintApprovalForFixture(paths, "scope");
    const file = approvalReceiptsPath(paths);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    fs.writeFileSync(file, lines[1] + "\n", "utf8"); // keep only the SECOND line → head truncated
    expect(readApprovalValidated(paths, "scope").status).toBe("tampered");
    const res = checkProductionReality(paths, state(paths));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("human_approval_unverified");
    expect(res.detail!.status).toBe("tampered"); // never silently `absent`
  });

  it("POSITIVE: the intact, correct store passes (each sub-case's non-vacuous twin)", () => {
    const paths = greenAtFinalVerificationArtifacts();
    mintRequiredApprovals(paths, state(paths));
    // Untruncated store, no marker tampering, intact chain → completion passes.
    expect(checkProductionReality(paths, state(paths))).toEqual({ ok: true });
    expect(canCompleteRun(paths, state(paths))).toEqual({ ok: true });
  });
});

// ===========================================================================
// absent-`producer_kind` → in-process `valid` discrimination (plan §7 note).
// ===========================================================================
describe("BSC-7 discrimination: absent producer_kind → in-process valid (never external, never free pass)", () => {
  it("an approval with NO producer_kind classifies in-process `valid` (attribution-only), not forged, not grounded", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const rel = writeStageArtifact(paths.root, "architecture");
    const digest = computeTargetDigest(paths.root, rel)!;
    // Hand-build an approval with NO producer_kind field at all (omit-when-absent).
    appendRawApproval(paths, {
      kind: "human-approval",
      stage: "architecture",
      approval_of: { snapshot_coord: { gitHead: null, treeDigest: null }, governing_artifact_digest: digest },
      producer_identity: "cli:th approve",
    });
    const v = readApprovalValidated(paths, "architecture");
    expect(v.status).toBe("valid"); // in-process path fired (the external branch needs an explicit claim)
    expect(v.status).not.toBe("valid-grounded");
    expect(v.status).not.toBe("forged");
  });
});

// ===========================================================================
// [carry-forward] Marker-baseline INJECTION control. EXPECTATION: an injected baseline
// member with NO on-disk chain-sealed `legacy:true` stamp must NOT classify `legacy`-PASS.
// This REVEALED A BYPASS (grandfatheredBaseline trusted the marker array verbatim) →
// HARDENED in src/core/approvals.ts (the baseline is now cross-checked against a real
// on-disk legacy stamp). These tests pin the hardened fail-closed behavior.
// ===========================================================================
describe("BSC-7 [carry-forward]: marker-baseline injection must NOT manufacture a legacy-PASS", () => {
  it("a hand-edited marker naming a stage with NO on-disk legacy stamp → that stage is `absent`, not `legacy`", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    fs.mkdirSync(paths.stateDir, { recursive: true });
    // Inject a baseline naming `architecture` — but write NO legacy:true stamp for it on disk.
    const marker = { migratedAt: new Date().toISOString(), baseline: ["architecture"] };
    fs.writeFileSync(path.join(paths.stateDir, ".approval-receipts-migration"), JSON.stringify(marker), "utf8");
    expect(readApprovalReceipts(paths)).toHaveLength(0); // no on-disk stamp
    // HARDENED: the baseline is cross-checked against a real stamp → the injected entry is dropped.
    expect([...grandfatheredBaseline(paths)]).toEqual([]);
    expect(readApprovalValidated(paths, "architecture").status).toBe("absent"); // NOT legacy
  });

  it("a baseline member WITH a real chain-sealed legacy:true stamp still classifies `legacy` (legit path preserved)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    fs.mkdirSync(paths.stateDir, { recursive: true });
    // The production migration seals a REAL legacy:true stamp for `requirements`.
    ensureApprovalMigration(paths, ["requirements"]);
    expect([...grandfatheredBaseline(paths)]).toEqual(["requirements"]); // real stamp → retained
    expect(readApprovalValidated(paths, "requirements").status).toBe("legacy");
  });

  it("a marker whose baseline mixes a REAL stamp + an INJECTED stage keeps only the stamped one", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    fs.mkdirSync(paths.stateDir, { recursive: true });
    // Real migration stamps `requirements`; then hand-edit the marker to ALSO claim `scope`.
    ensureApprovalMigration(paths, ["requirements"]);
    const markerPath = path.join(paths.stateDir, ".approval-receipts-migration");
    const m = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    m.baseline = ["requirements", "scope"]; // inject `scope` with no stamp
    fs.writeFileSync(markerPath, JSON.stringify(m), "utf8");
    expect([...grandfatheredBaseline(paths)].sort()).toEqual(["requirements"]); // scope dropped
    expect(readApprovalValidated(paths, "requirements").status).toBe("legacy"); // real stamp
    expect(readApprovalValidated(paths, "scope").status).toBe("absent"); // injected → blocked
  });
});

// ===========================================================================
// [carry-forward] approve.ts default-stage contract: on a non-humanGate current_stage,
// `runApprove(paths, undefined)` refuses (not a silent no-op).
// ===========================================================================
describe("BSC-7 [carry-forward]: approve.ts default-stage refusal", () => {
  it("runApprove(paths, undefined) on a NON-humanGate current_stage refuses with approval_stage_not_human_gate", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeState(paths, {
      ...initialState(),
      tier: "T1",
      current_stage: "implementation", // NOT a humanGate stage
      implementation_allowed: true,
    });
    const res = runApprove(paths, undefined); // default-to-current-stage
    expect(res.ok).toBe(false);
    expect(res.data!.error).toBe("approval_stage_not_human_gate");
    expect(res.data!.stage).toBe("implementation");
    // No approval was silently written.
    expect(readApprovalReceipts(paths)).toHaveLength(0);
  });

  it("POSITIVE: runApprove(paths, undefined) on a humanGate current_stage mints for that stage", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    writeStageArtifact(paths.root, "requirements");
    writeState(paths, {
      ...initialState(),
      tier: "T1",
      current_stage: "requirements", // a humanGate stage
      implementation_allowed: true,
    });
    const res = runApprove(paths, undefined);
    expect(res.ok).toBe(true);
    expect(res.data!.stage).toBe("requirements");
    expect(readApprovalValidated(paths, "requirements").status).toBe("valid");
  });
});
