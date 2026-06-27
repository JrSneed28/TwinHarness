/**
 * Axis-B slice-3a (BSC-7) — human-approval receipt store (src/core/approvals.ts).
 *
 * Unit tests for the new entity + validator + migration (plan §4 3a-1 / 3a-4 / 3a-5,
 * §10 unit plan):
 *   - canonical text: deterministic, signature-free, `stage` IN the canonical input
 *     (R5), `governing_artifact_digest` mandatory (R3), `computeApprovalRecordHash`
 *     round-trips through the shared hash chain;
 *   - producer refuse-at-creation: stage ∉ humanGate, governing artifact unresolved;
 *   - `readApprovalValidated` classification for each status (valid / legacy / absent /
 *     target_missing / target_mismatch / stale / forged / tampered);
 *   - absent-`producer_kind` → in-process `valid` discrimination (never a free pass);
 *   - `ensureApprovalMigration`: grandfather + post-migration-absent-blocks +
 *     marker-deleted → fail-closed (NOT legacy-PASS) + chain-truncation → tampered.
 *
 * Deterministic + Windows-safe (path.join, no shell). The `stale` snapshot test uses a
 * real git repo and skips when git is unavailable.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempProject, type TempProject } from "./helpers";
import {
  // schema / chain
  approvalCanonicalText,
  computeApprovalRecordHash,
  verifyApprovalChain,
  isHumanGateStage,
  HUMAN_GATE_STAGES,
  // storage
  approvalReceiptsPath,
  externalApprovalsPath,
  readApprovalReceipts,
  readLastApprovalRecordHash,
  // producer
  appendApprovalReceipt,
  ApprovalUnmintableError,
  // validation
  readApprovalValidated,
  // migration
  approvalMigrationDone,
  grandfatheredBaseline,
  ensureApprovalMigration,
  type HumanApprovalReceipt,
} from "../src/core/approvals";
import { stageContract } from "../src/core/stages";
import { computeTargetDigest } from "../src/core/receipts";
import { GENESIS_PREV_HASH } from "../src/core/hash";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** A temp project whose state dir exists, so appends land in a real .twinharness/. */
function freshProject(): TempProject {
  const p = makeTempProject();
  fs.mkdirSync(p.paths.stateDir, { recursive: true });
  return p;
}

/** Write the governing artifact for a humanGate stage so an approval can be minted. */
function writeStageArtifact(root: string, stage: string, content = "x\n"): string {
  const rel = stageContract(stage)!.produces;
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

/**
 * Seal a hand-built approval onto the chain and append it directly (bypassing the
 * producer's refuse-at-creation gate) so a test can pin an arbitrary recorded
 * snapshot_coord / digest / producer_kind. Mirrors `sealAndAppend` using the public
 * `computeApprovalRecordHash` so the appended line is chain-valid.
 */
function appendRawApproval(
  paths: TempProject["paths"],
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
// Schema constants
// ---------------------------------------------------------------------------

describe("BSC-7: the 8 humanGate stages", () => {
  it("derives exactly the 8 humanGate stages from STAGE_PIPELINE", () => {
    expect([...HUMAN_GATE_STAGES].sort()).toEqual(
      [
        "architecture",
        "contracts",
        "final-verification",
        "requirements",
        "scope",
        "security",
        "ui-design",
        "ux-design",
      ].sort(),
    );
    expect(HUMAN_GATE_STAGES.size).toBe(8);
  });

  it("isHumanGateStage discriminates humanGate from non-humanGate stages", () => {
    expect(isHumanGateStage("requirements")).toBe(true);
    expect(isHumanGateStage("final-verification")).toBe(true);
    expect(isHumanGateStage("domain-model")).toBe(false); // humanGate:false
    expect(isHumanGateStage("implementation")).toBe(false);
    expect(isHumanGateStage("nonsense")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Canonical text + hashing (R3 / R5)
// ---------------------------------------------------------------------------

describe("BSC-7: approval canonical text + hashing", () => {
  const base: Omit<HumanApprovalReceipt, "recordHash"> = {
    kind: "human-approval",
    stage: "requirements",
    approval_of: {
      snapshot_coord: { gitHead: "abc", treeDigest: "def" },
      governing_artifact_digest: "deadbeef",
    },
    producer_identity: "cli:th approve",
    producer_kind: "in-process",
    prevHash: GENESIS_PREV_HASH,
  };

  it("is deterministic (same input → same canonical bytes)", () => {
    expect(approvalCanonicalText(base)).toBe(approvalCanonicalText({ ...base }));
  });

  it("includes `stage` in the canonical input (R5 — signature bound to the stage)", () => {
    const text = approvalCanonicalText(base);
    expect(text).toContain('"stage":"requirements"');
    // A different stage changes the canonical text (and therefore the recordHash/sig).
    const other = approvalCanonicalText({ ...base, stage: "scope" });
    expect(other).not.toBe(text);
    expect(computeApprovalRecordHash(base)).not.toBe(computeApprovalRecordHash({ ...base, stage: "scope" }));
  });

  it("is signature-free (the signature trailer is excluded from canonical text)", () => {
    const withSig = approvalCanonicalText({
      ...base,
      signature: "A".repeat(86) + "==",
    });
    expect(withSig).toBe(approvalCanonicalText(base));
    expect(withSig).not.toContain("signature");
  });

  it("binds the mandatory governing_artifact_digest (R3)", () => {
    const text = approvalCanonicalText(base);
    expect(text).toContain('"governing_artifact_digest":"deadbeef"');
    expect(approvalCanonicalText({
      ...base,
      approval_of: { ...base.approval_of, governing_artifact_digest: "other" },
    })).not.toBe(text);
  });

  it("computeApprovalRecordHash round-trips (a sealed approval verifies on its own chain)", () => {
    const recordHash = computeApprovalRecordHash(base);
    const sealed: HumanApprovalReceipt = { ...base, recordHash };
    expect(verifyApprovalChain([sealed])).toEqual({ ok: true });
  });

  it("omit-when-absent: an approval with no optional signing fields is byte-stable", () => {
    const minimal: Omit<HumanApprovalReceipt, "recordHash"> = {
      kind: "human-approval",
      stage: "scope",
      approval_of: { snapshot_coord: { gitHead: null, treeDigest: null }, governing_artifact_digest: "" },
      producer_identity: "legacy-backfill",
      legacy: true,
      prevHash: GENESIS_PREV_HASH,
    };
    const text = approvalCanonicalText(minimal);
    expect(text).not.toContain("producer_kind");
    expect(text).not.toContain("key_id");
    expect(text).not.toContain("signature");
  });
});

// ---------------------------------------------------------------------------
// Producer — refuse-at-creation (plan §4 3a-2)
// ---------------------------------------------------------------------------

describe("BSC-7: appendApprovalReceipt refuse-at-creation", () => {
  it("mints a valid in-process approval for a humanGate stage with a resolving artifact", () => {
    tp = freshProject();
    writeStageArtifact(tp.root, "requirements");
    const sealed = appendApprovalReceipt(tp.paths, { stage: "requirements", producerIdentity: "cli:th approve" });
    expect(sealed.kind).toBe("human-approval");
    expect(sealed.stage).toBe("requirements");
    expect(sealed.producer_kind).toBe("in-process");
    expect(sealed.approval_of.governing_artifact_digest).not.toBe("");
    expect(readApprovalReceipts(tp.paths)).toHaveLength(1);
    expect(verifyApprovalChain(readApprovalReceipts(tp.paths))).toEqual({ ok: true });
  });

  it("refuses a non-humanGate stage (approval_stage_not_human_gate)", () => {
    tp = freshProject();
    expect(() => appendApprovalReceipt(tp!.paths, { stage: "domain-model", producerIdentity: "x" }))
      .toThrow(ApprovalUnmintableError);
    try {
      appendApprovalReceipt(tp.paths, { stage: "domain-model", producerIdentity: "x" });
    } catch (e) {
      expect((e as ApprovalUnmintableError).code).toBe("approval_stage_not_human_gate");
    }
    expect(readApprovalReceipts(tp.paths)).toHaveLength(0); // no partial write
  });

  it("refuses when the governing artifact does not resolve in source (approval_artifact_unresolved)", () => {
    tp = freshProject();
    // No docs/01-requirements.md written → unresolved.
    try {
      appendApprovalReceipt(tp.paths, { stage: "requirements", producerIdentity: "x" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApprovalUnmintableError);
      expect((e as ApprovalUnmintableError).code).toBe("approval_artifact_unresolved");
      expect((e as ApprovalUnmintableError).artifact).toBe("docs/01-requirements.md");
    }
    expect(readApprovalReceipts(tp.paths)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Validator — classification per status (plan §10)
// ---------------------------------------------------------------------------

describe("BSC-7: readApprovalValidated classification", () => {
  it("absent — migrated, stage not grandfathered → BLOCK", () => {
    tp = freshProject();
    // Mark migration done with an EMPTY baseline (no grandfathered stages).
    ensureApprovalMigration(tp.paths, []);
    expect(readApprovalValidated(tp.paths, "requirements")).toEqual({ status: "absent" });
  });

  it("valid — present, non-legacy, in-process, content passes → ACCEPT (never valid-grounded)", () => {
    tp = freshProject();
    writeStageArtifact(tp.root, "scope");
    appendApprovalReceipt(tp.paths, { stage: "scope", producerIdentity: "cli:th approve" });
    const v = readApprovalValidated(tp.paths, "scope");
    expect(v.status).toBe("valid");
    expect(v.receipt?.stage).toBe("scope");
  });

  it("absent-producer_kind discrimination: an approval with NO producer_kind is in-process `valid`, not a free pass", () => {
    tp = freshProject();
    const rel = writeStageArtifact(tp.root, "architecture");
    const digest = computeTargetDigest(tp.root, rel)!;
    // Hand-build an approval with NO producer_kind field at all.
    appendRawApproval(tp.paths, {
      kind: "human-approval",
      stage: "architecture",
      approval_of: { snapshot_coord: { gitHead: null, treeDigest: null }, governing_artifact_digest: digest },
      producer_identity: "cli:th approve",
    });
    const v = readApprovalValidated(tp.paths, "architecture");
    expect(v.status).toBe("valid"); // in-process path fired (no external claim)
    expect(v.status).not.toBe("valid-grounded");
    expect(v.status).not.toBe("forged");
  });

  it("target_missing — recorded artifact no longer resolves → BLOCK", () => {
    tp = freshProject();
    const rel = writeStageArtifact(tp.root, "contracts");
    appendApprovalReceipt(tp.paths, { stage: "contracts", producerIdentity: "x" });
    fs.rmSync(path.join(tp.root, rel)); // delete the governing artifact
    expect(readApprovalValidated(tp.paths, "contracts").status).toBe("target_missing");
  });

  it("target_mismatch — artifact resolves but its digest changed → BLOCK", () => {
    tp = freshProject();
    const rel = writeStageArtifact(tp.root, "security", "original\n");
    appendApprovalReceipt(tp.paths, { stage: "security", producerIdentity: "x" });
    fs.writeFileSync(path.join(tp.root, rel), "EDITED\n", "utf8"); // content drift
    expect(readApprovalValidated(tp.paths, "security").status).toBe("target_mismatch");
  });

  it("stale — snapshot_coord diverged (gitHead) → BLOCK (requires git)", () => {
    tp = freshProject();
    if (!initGitRepo(tp.root)) return; // skip when git unavailable
    const rel = writeStageArtifact(tp.root, "requirements", "req\n");
    const digest = computeTargetDigest(tp.root, rel)!;
    // Pin a recorded gitHead that differs from the current one → stale.
    appendRawApproval(tp.paths, {
      kind: "human-approval",
      stage: "requirements",
      approval_of: {
        snapshot_coord: { gitHead: "0000000000000000000000000000000000000000", treeDigest: null },
        governing_artifact_digest: digest,
      },
      producer_identity: "x",
      producer_kind: "in-process",
    });
    const v = readApprovalValidated(tp.paths, "requirements");
    expect(v.status).toBe("stale");
    expect(v.staleReasons).toContain("gitHead");
  });

  it("forged — an external CLAIM that cannot be proven (no key/verify in 3a) → BLOCK, never downgraded", () => {
    tp = freshProject();
    const rel = writeStageArtifact(tp.root, "ux-design");
    const digest = computeTargetDigest(tp.root, rel)!;
    // Write an EXTERNAL-claiming line into the external store with a (bogus) signature.
    const ext: Omit<HumanApprovalReceipt, "recordHash"> = {
      kind: "human-approval",
      stage: "ux-design",
      approval_of: { snapshot_coord: { gitHead: null, treeDigest: null }, governing_artifact_digest: digest },
      producer_identity: "external:producer",
      producer_kind: "external",
      key_id: "deadbeef",
      signature: "A".repeat(86) + "==",
      prevHash: GENESIS_PREV_HASH,
    };
    const recordHash = computeApprovalRecordHash(ext);
    const externalPath = externalApprovalsPath(tp.paths);
    fs.writeFileSync(externalPath, JSON.stringify({ ...ext, recordHash }) + "\n", "utf8");
    // Also mint a valid in-process approval for the same stage — the external CLAIM must
    // still win (fail-closed): an unprovable external claim blocks, never downgrades to valid.
    appendApprovalReceipt(tp.paths, { stage: "ux-design", producerIdentity: "x" });
    expect(readApprovalValidated(tp.paths, "ux-design").status).toBe("forged");
  });

  it("tampered — an edited in-process record breaks the chain → BLOCK (never silent absent)", () => {
    tp = freshProject();
    writeStageArtifact(tp.root, "scope");
    appendApprovalReceipt(tp.paths, { stage: "scope", producerIdentity: "x" });
    // Corrupt the stored line's stage WITHOUT recomputing recordHash → chain edited.
    const file = approvalReceiptsPath(tp.paths);
    const line = JSON.parse(fs.readFileSync(file, "utf8").trim());
    line.stage = "security";
    fs.writeFileSync(file, JSON.stringify(line) + "\n", "utf8");
    expect(readApprovalValidated(tp.paths, "security").status).toBe("tampered");
  });

  it("tampered — chain-HEAD truncation (first prevHash ≠ GENESIS) → BLOCK", () => {
    tp = freshProject();
    writeStageArtifact(tp.root, "scope");
    // Two appends; then delete the FIRST line so the surviving line's prevHash ≠ GENESIS.
    appendApprovalReceipt(tp.paths, { stage: "scope", producerIdentity: "x" });
    writeStageArtifact(tp.root, "requirements");
    appendApprovalReceipt(tp.paths, { stage: "requirements", producerIdentity: "x" });
    const file = approvalReceiptsPath(tp.paths);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    fs.writeFileSync(file, lines[1] + "\n", "utf8"); // keep only the SECOND line (head truncated)
    expect(readApprovalValidated(tp.paths, "requirements").status).toBe("tampered");
  });
});

// ---------------------------------------------------------------------------
// Migration / grandfather + fail-closed marker integrity (plan §4 3a-5, R2)
// ---------------------------------------------------------------------------

describe("BSC-7: ensureApprovalMigration + marker integrity", () => {
  it("grandfathers already-advanced humanGate stages as visible `legacy` (gate accepts, ungrounded)", () => {
    tp = freshProject();
    expect(approvalMigrationDone(tp.paths)).toBe(false);
    ensureApprovalMigration(tp.paths, ["requirements", "scope"]);
    expect(approvalMigrationDone(tp.paths)).toBe(true);
    expect([...grandfatheredBaseline(tp.paths)].sort()).toEqual(["requirements", "scope"]);
    // A grandfathered stage with no real approval reads `legacy` (accepted, ungrounded).
    expect(readApprovalValidated(tp.paths, "requirements").status).toBe("legacy");
    expect(readApprovalValidated(tp.paths, "scope").status).toBe("legacy");
    // The legacy stamps are visibly legacy on disk.
    const recs = readApprovalReceipts(tp.paths);
    expect(recs.every((r) => r.legacy === true)).toBe(true);
  });

  it("is idempotent (a re-run is a no-op; the marker guards it)", () => {
    tp = freshProject();
    ensureApprovalMigration(tp.paths, ["requirements"]);
    const before = readApprovalReceipts(tp.paths).length;
    ensureApprovalMigration(tp.paths, ["requirements", "scope"]); // marker present → ignored
    expect(readApprovalReceipts(tp.paths).length).toBe(before);
    expect([...grandfatheredBaseline(tp.paths)]).toEqual(["requirements"]); // first baseline wins
  });

  it("post-migration: a stage NOT in the baseline with no approval → absent (BLOCK)", () => {
    tp = freshProject();
    ensureApprovalMigration(tp.paths, ["requirements"]);
    expect(readApprovalValidated(tp.paths, "architecture").status).toBe("absent");
  });

  it("does NOT double-stamp a stage that already has a real approval", () => {
    tp = freshProject();
    writeStageArtifact(tp.root, "requirements");
    appendApprovalReceipt(tp.paths, { stage: "requirements", producerIdentity: "x" });
    ensureApprovalMigration(tp.paths, ["requirements", "scope"]);
    const recs = readApprovalReceipts(tp.paths);
    const reqRecs = recs.filter((r) => r.stage === "requirements");
    expect(reqRecs).toHaveLength(1); // not double-stamped
    expect(reqRecs[0]!.legacy).toBeUndefined(); // the real one, not a legacy stamp
  });

  it("FAIL-CLOSED: deleting the migration marker does NOT downgrade unreceipted stages to legacy-PASS", () => {
    tp = freshProject();
    ensureApprovalMigration(tp.paths, ["requirements"]);
    // Delete the marker (the R2-ii full-bypass attempt).
    const marker = path.join(tp.paths.stateDir, ".approval-receipts-migration");
    fs.rmSync(marker);
    expect(approvalMigrationDone(tp.paths)).toBe(false);
    // The legacy stamp for `requirements` still exists on disk → it reads legacy (a real
    // grandfather record, not a marker-derived pass). But a stage with NO record and an
    // empty baseline (marker gone) classifies `absent` → BLOCK, NOT legacy-PASS.
    expect(readApprovalValidated(tp.paths, "architecture").status).toBe("absent");
    expect(grandfatheredBaseline(tp.paths).size).toBe(0); // marker gone → empty baseline
  });
});
