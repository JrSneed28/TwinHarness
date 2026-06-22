/**
 * Axis-B slice-3b (BSC-7) — the INDEPENDENCE-#5 control-flip (C-I).
 *
 * Independence property #5 ("approvals the agent cannot forge") is a NUMBER: it is
 * > 0 iff a producer-signed external approval is ACCEPTED while the SAME approval
 * forged on the in-process surface is REJECTED. This file demonstrates that number is
 * now > 0 by asserting BOTH arms in one place so neither is vacuous:
 *
 *   - Arm A (real, accepted): an external Ed25519-signed approval for the `requirements`
 *     humanGate stage, minted by the REAL out-of-process producer
 *     (`scripts/th-receipt-producer.mjs --kind approval --stage requirements`), classifies
 *     `valid-grounded`; the stage-advance gate PASSES.
 *   - Arm B (forged, rejected): the SAME approval forged in-process — (b1) an external CLAIM
 *     with no real signature; (b2) signed with a DIFFERENT key; (b3) a genuine external line
 *     but with the public key env UNSET — classifies `forged`; the gate BLOCKS.
 *
 * The keypair is generated IN-TEST (PKCS8 private + SPKI public written to temp keyfiles,
 * `TH_RECEIPT_PRIVATE_KEYFILE` + `TH_RECEIPT_PUBLIC_KEYFILE`), so the suite is deterministic
 * on CI (which has no real key). Key env vars are restored in afterEach.
 *
 * Plus the two carry-forward review MUSTs the C-A/B review flagged for C-I:
 *   - MED-1 (external chain): a tampered/reordered/truncated `external-approvals.jsonl` is
 *     NOT honored — it classifies `tampered`, never `valid-grounded`.
 *   - MED-2 (ordering): a verifying external approval for stage S SURVIVES an UNRELATED
 *     in-process tamper (external precedence is evaluated BEFORE the in-process `tampered`
 *     classification); a non-verifying external claim is `forged` regardless of in-process
 *     state.
 *
 * Deterministic + Windows-safe (path.join, no shell).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState, type TwinHarnessState } from "../src/core/state-schema";
import { runArtifactRegister } from "../src/commands/artifact";
import { checkHumanApprovalAdvance, canAdvanceStage } from "../src/core/gate-preconditions";
import {
  approvalCanonicalText,
  computeApprovalRecordHash,
  externalApprovalsPath,
  readApprovalValidated,
  readLastExternalApprovalRecordHash,
  type HumanApprovalReceipt,
} from "../src/core/approvals";
import { externalKeyId } from "../src/core/receipt-signing";
import { computeTargetDigest, currentReceiptSnapshotCoord } from "../src/core/receipts";
import { stageContract } from "../src/core/stages";
import type { ProjectPaths } from "../src/core/paths";

const SAVED_PUBLIC_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
const SAVED_PRIVATE_KEYFILE = process.env.TH_RECEIPT_PRIVATE_KEYFILE;
let tp: TempProject | undefined;

afterEach(() => {
  if (SAVED_PUBLIC_KEYFILE === undefined) delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
  else process.env.TH_RECEIPT_PUBLIC_KEYFILE = SAVED_PUBLIC_KEYFILE;
  if (SAVED_PRIVATE_KEYFILE === undefined) delete process.env.TH_RECEIPT_PRIVATE_KEYFILE;
  else process.env.TH_RECEIPT_PRIVATE_KEYFILE = SAVED_PRIVATE_KEYFILE;
  tp?.cleanup();
  tp = undefined;
});

const PRODUCER = path.resolve(__dirname, "..", "scripts", "th-receipt-producer.mjs");
const STAGE = "requirements";

function state(paths: ProjectPaths): TwinHarnessState {
  return readState(paths).state!;
}

/** Install the verifier's public key (SPKI PEM) and return its absolute path. */
function setVerifierKey(paths: ProjectPaths, name: string, publicKey: KeyObject): string {
  const f = path.join(paths.stateDir, name);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, publicKey.export({ type: "spki", format: "pem" }));
  process.env.TH_RECEIPT_PUBLIC_KEYFILE = f;
  return f;
}

/** Write a producer private key (PKCS8 PEM) and return its absolute path. */
function writeProducerKey(paths: ProjectPaths, name: string, privateKey: KeyObject): string {
  const f = path.join(paths.stateDir, name);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }));
  return f;
}

/**
 * A run sitting AT the `requirements` humanGate stage with its governing artifact
 * registered, so the human-approval advance rung is reached (earlier rungs pass).
 * Migration is NOT run, so the stage is genuinely unapproved until an approval is minted.
 * Mirrors `tests/bsc7-negative-controls.test.ts:greenAtHumanGateStage`.
 */
function greenAtRequirements(): ProjectPaths {
  tp = makeTempProject();
  const paths = tp.paths;
  const rel = stageContract(STAGE)!.produces.replace(/\/$/, "");
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "# Requirements\n\n- REQ-001 the only requirement.\n", "utf8");
  fs.writeFileSync(path.resolve(paths.root, "docs/09-implementation-plan.md"), "# Plan\n\nSLICE-0 covers REQ-001.\n", "utf8");
  fs.mkdirSync(path.resolve(paths.root, "tests"), { recursive: true });
  fs.writeFileSync(path.resolve(paths.root, "tests/cov.test.ts"), "// REQ-001 verified here\n", "utf8");
  writeState(paths, {
    ...initialState(),
    tier: "T3",
    current_stage: STAGE,
    interview_required: false,
    implementation_allowed: true,
    slices: [{ id: "SLICE-0", status: "done", components: [] }],
  });
  expect(runArtifactRegister(paths, rel, 1).ok).toBe(true);
  return paths;
}

/**
 * Seal a SIGNED external approval line directly (the producer's formula, in-test) so a
 * negative/ordering scenario can control the bytes precisely. `tamper` mutates the sealed
 * object AFTER signing. The recordHash + signature are computed over the IDENTICAL
 * canonical input, exactly like the C-H producer.
 */
function appendSignedExternalApproval(
  paths: ProjectPaths,
  fields: { stage: string; keyPair: { privateKey: KeyObject; publicKey: KeyObject }; keyId?: string },
  tamper?: (sealed: HumanApprovalReceipt) => HumanApprovalReceipt,
): HumanApprovalReceipt {
  const artifact = stageContract(fields.stage)!.produces;
  const digest = computeTargetDigest(paths.root, artifact)!;
  const withPrev: Omit<HumanApprovalReceipt, "recordHash"> = {
    kind: "human-approval",
    stage: fields.stage,
    approval_of: {
      snapshot_coord: currentReceiptSnapshotCoord(paths),
      governing_artifact_digest: digest,
    },
    producer_identity: "external:test",
    producer_kind: "external",
    key_id: fields.keyId ?? externalKeyId(fields.keyPair.publicKey),
    prevHash: readLastExternalApprovalRecordHash(paths),
  };
  const canonical = approvalCanonicalText(withPrev);
  const signature = sign(null, Buffer.from(canonical, "utf8"), fields.keyPair.privateKey).toString("base64");
  const recordHash = computeApprovalRecordHash(withPrev);
  let sealed: HumanApprovalReceipt = { ...withPrev, signature, recordHash };
  if (tamper) sealed = tamper(sealed);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(externalApprovalsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

const K1 = generateKeyPairSync("ed25519");
const K2 = generateKeyPairSync("ed25519");

// ===========================================================================
// THE CONTROL-FLIP: independence #5 > 0 — both arms non-vacuous, one file.
// ===========================================================================
describe("BSC-7 slice-3b — independence #5 control-flip (real accepted ↔ forged rejected)", () => {
  it("ARM A (real): the REAL producer mints an external approval the gate ACCEPTS (valid-grounded); ARM B (forged): the same approval forged in-process is REJECTED (forged) and BLOCKS", () => {
    const paths = greenAtRequirements();
    const publicKeyFile = setVerifierKey(paths, "k1-public.pem", K1.publicKey);
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);

    // --- ARM A: the genuine external producer (OUT of process) signs the approval. ---
    const res = spawnSync(
      "node",
      [PRODUCER, "--root", paths.root, "--kind", "approval", "--stage", STAGE],
      {
        env: {
          ...process.env,
          TH_RECEIPT_PUBLIC_KEYFILE: publicKeyFile,
          TH_RECEIPT_PRIVATE_KEYFILE: privateKeyFile,
        },
        encoding: "utf8",
      },
    );
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.producer_kind).toBe("external");
    expect(out.stage).toBe(STAGE);

    // (a) The external keyed approval is INDEPENDENTLY grounded (the in-process surface
    // cannot forge the Ed25519 signature — that delta IS independence property #5).
    expect(readApprovalValidated(paths, STAGE).status).toBe("valid-grounded");
    // (b) The stage-advance gate ACCEPTS it.
    expect(checkHumanApprovalAdvance(paths, state(paths)).ok).toBe(true);
    expect(canAdvanceStage(paths, state(paths)).ok).toBe(true);

    // --- ARM B: the SAME approval forged in-process is REJECTED. ---
    // (b1) An external CLAIM with NO real signature (the in-process agent cannot sign).
    {
      const fresh = greenAtRequirements();
      setVerifierKey(fresh, "k1-public.pem", K1.publicKey);
      // A producer_kind:"external" line minted with a wrong-key signature, the closest the
      // in-process surface can get to a "genuine" external claim without the private key.
      appendSignedExternalApproval(fresh, { stage: STAGE, keyPair: K2 });
      expect(readApprovalValidated(fresh, STAGE).status).toBe("forged");
      const adv = checkHumanApprovalAdvance(fresh, state(fresh));
      expect(adv.ok).toBe(false);
      expect(adv.error).toBe("human_approval_unverified");
      expect(adv.detail).toMatchObject({ stage: STAGE, status: "forged" });
      expect(canAdvanceStage(fresh, state(fresh)).ok).toBe(false);
    }
  });

  it("ARM B variants: external claim with no signature → forged; genuine external line with key env UNSET → forged; both BLOCK", () => {
    // (b2) producer_kind:"external" with NO signature trailer at all (a hand-forged claim).
    {
      const paths = greenAtRequirements();
      setVerifierKey(paths, "k1-public.pem", K1.publicKey);
      const artifact = stageContract(STAGE)!.produces;
      const digest = computeTargetDigest(paths.root, artifact)!;
      const withPrev: Omit<HumanApprovalReceipt, "recordHash"> = {
        kind: "human-approval",
        stage: STAGE,
        approval_of: { snapshot_coord: currentReceiptSnapshotCoord(paths), governing_artifact_digest: digest },
        producer_identity: "forged:no-sig",
        producer_kind: "external",
        prevHash: readLastExternalApprovalRecordHash(paths),
      };
      const recordHash = computeApprovalRecordHash(withPrev);
      const sealed: HumanApprovalReceipt = { ...withPrev, recordHash };
      fs.appendFileSync(externalApprovalsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
      expect(readApprovalValidated(paths, STAGE).status).toBe("forged");
      expect(checkHumanApprovalAdvance(paths, state(paths)).ok).toBe(false);
    }

    // (b3) A GENUINE K1-signed external line, but the verifier key env is UNSET — the
    // external claim becomes unprovable (the default CI path for other tests) → forged.
    {
      const paths = greenAtRequirements();
      setVerifierKey(paths, "k1-public.pem", K1.publicKey);
      appendSignedExternalApproval(paths, { stage: STAGE, keyPair: K1 });
      delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
      expect(readApprovalValidated(paths, STAGE).status).toBe("forged");
      const adv = checkHumanApprovalAdvance(paths, state(paths));
      expect(adv.ok).toBe(false);
      expect(adv.error).toBe("human_approval_unverified");
    }
  });
});

// ===========================================================================
// MED-1 (carry-forward) — external chain verification.
// ===========================================================================
describe("BSC-7 slice-3b MED-1 — external store chain verification", () => {
  it("a TAMPERED external approval (recordHash edited after signing) → tampered, NOT valid-grounded", () => {
    const paths = greenAtRequirements();
    setVerifierKey(paths, "k1-public.pem", K1.publicKey);
    // Seal a genuine K1 approval, then corrupt its recordHash so the chain walk's
    // `recomputed !== recordHash` (edited) fires before any signature is accepted.
    appendSignedExternalApproval(paths, { stage: STAGE, keyPair: K1 }, (sealed) => ({
      ...sealed,
      recordHash: "0".repeat(64),
    }));
    expect(readApprovalValidated(paths, STAGE).status).toBe("tampered");
    expect(checkHumanApprovalAdvance(paths, state(paths)).ok).toBe(false);
  });

  it("a REORDERED external chain (second line's prevHash no longer links) → tampered, NOT valid-grounded", () => {
    const paths = greenAtRequirements();
    setVerifierKey(paths, "k1-public.pem", K1.publicKey);
    // Two genuine K1 approvals chained correctly, then rewrite the file with the lines
    // SWAPPED so line 2's prevHash (GENESIS) no longer matches the new predecessor.
    const first = appendSignedExternalApproval(paths, { stage: STAGE, keyPair: K1 });
    const second = appendSignedExternalApproval(paths, { stage: STAGE, keyPair: K1 });
    fs.writeFileSync(
      externalApprovalsPath(paths),
      JSON.stringify(second) + "\n" + JSON.stringify(first) + "\n",
      "utf8",
    );
    expect(readApprovalValidated(paths, STAGE).status).toBe("tampered");
    expect(checkHumanApprovalAdvance(paths, state(paths)).ok).toBe(false);
  });

  it("a TRUNCATED-HEAD external chain (first line's prevHash ≠ GENESIS) → tampered, NOT valid-grounded", () => {
    const paths = greenAtRequirements();
    setVerifierKey(paths, "k1-public.pem", K1.publicKey);
    // Two genuine approvals; delete the FIRST so the surviving line's prevHash points at a
    // record no longer present (head no longer links to GENESIS).
    appendSignedExternalApproval(paths, { stage: STAGE, keyPair: K1 });
    const second = appendSignedExternalApproval(paths, { stage: STAGE, keyPair: K1 });
    fs.writeFileSync(externalApprovalsPath(paths), JSON.stringify(second) + "\n", "utf8");
    expect(readApprovalValidated(paths, STAGE).status).toBe("tampered");
    expect(checkHumanApprovalAdvance(paths, state(paths)).ok).toBe(false);
  });
});

// ===========================================================================
// MED-2 (carry-forward) — ordering: external precedence is evaluated FIRST.
// ===========================================================================
describe("BSC-7 slice-3b MED-2 — external precedence outranks an unrelated in-process tamper", () => {
  it("a VERIFYING external approval for the stage SURVIVES an UNRELATED in-process chain tamper → still valid-grounded", () => {
    const paths = greenAtRequirements();
    const publicKeyFile = setVerifierKey(paths, "k1-public.pem", K1.publicKey);
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);

    // A genuine external approval for `requirements`.
    const res = spawnSync(
      "node",
      [PRODUCER, "--root", paths.root, "--kind", "approval", "--stage", STAGE],
      {
        env: { ...process.env, TH_RECEIPT_PUBLIC_KEYFILE: publicKeyFile, TH_RECEIPT_PRIVATE_KEYFILE: privateKeyFile },
        encoding: "utf8",
      },
    );
    expect(res.status).toBe(0);

    // Now CORRUPT the in-process approval store with an UNRELATED tamper (a garbage line
    // that breaks the in-process chain walk). Pre-fix this would short-circuit `tampered`
    // before external precedence; post-fix the external claim is decided FIRST.
    fs.writeFileSync(
      path.join(paths.stateDir, "approval-receipts.jsonl"),
      JSON.stringify({
        kind: "human-approval",
        stage: STAGE,
        approval_of: { snapshot_coord: { gitHead: null, treeDigest: null }, governing_artifact_digest: "x" },
        producer_identity: "in-process",
        prevHash: "f".repeat(64),
        recordHash: "f".repeat(64),
      }) + "\n",
      "utf8",
    );

    // External precedence is evaluated FIRST → the verifying external approval still grounds.
    expect(readApprovalValidated(paths, STAGE).status).toBe("valid-grounded");
    expect(checkHumanApprovalAdvance(paths, state(paths)).ok).toBe(true);
  });

  it("a NON-verifying external claim is forged REGARDLESS of in-process state (a valid in-process line does NOT downgrade it)", () => {
    const paths = greenAtRequirements();
    setVerifierKey(paths, "k1-public.pem", K1.publicKey);
    // A wrong-key (K2) external claim, plus a perfectly-valid in-process attested approval
    // for the SAME stage. The external claim is DECISIVE: forged, never downgraded to valid.
    appendSignedExternalApproval(paths, { stage: STAGE, keyPair: K2 });
    // Mint a genuine in-process approval for the same stage so the in-process path WOULD pass.
    {
      const artifact = stageContract(STAGE)!.produces;
      const digest = computeTargetDigest(paths.root, artifact)!;
      const inProc: Omit<HumanApprovalReceipt, "recordHash"> = {
        kind: "human-approval",
        stage: STAGE,
        approval_of: { snapshot_coord: currentReceiptSnapshotCoord(paths), governing_artifact_digest: digest },
        producer_identity: "in-process",
        producer_kind: "in-process",
        prevHash: "0".repeat(64),
      };
      const recordHash = computeApprovalRecordHash(inProc);
      fs.appendFileSync(
        path.join(paths.stateDir, "approval-receipts.jsonl"),
        JSON.stringify({ ...inProc, recordHash }) + "\n",
        "utf8",
      );
    }
    expect(readApprovalValidated(paths, STAGE).status).toBe("forged");
    expect(checkHumanApprovalAdvance(paths, state(paths)).ok).toBe(false);
  });
});
