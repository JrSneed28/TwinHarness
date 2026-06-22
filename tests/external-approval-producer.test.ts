/**
 * Axis-B slice-3b (BSC-7) — the EXTERNAL Ed25519 `--kind approval` producer
 * (`scripts/th-receipt-producer.mjs`). C-H: the keyed, out-of-process surface that mints a
 * signed `HumanApprovalReceipt` the in-process agent provably cannot forge (it holds no key).
 *
 * These tests drive the REAL standalone producer (`spawnSync('node', [producer.mjs, ...])`)
 * with a test Ed25519 keypair, exactly like the slice-1b/2b external-producer harness
 * (`receipts-external-asymmetry.test.ts` / `scan-exception-validate.test.ts`):
 *   - a signed line lands in `external-approvals.jsonl` with `producer_kind:"external"`, a
 *     `key_id`, a verifying `signature`, and a GENESIS chain seed;
 *   - the make-or-break C-I contract: the SIGNED canonical text is byte-identical to the 3a
 *     in-process `approvalCanonicalText` re-derivation (with `stage` IN the signed order, R5),
 *     so the signature verifies under the producer's public key AND `recordHash` matches
 *     `computeApprovalRecordHash` — proven here so C-I's gate verify is grounded;
 *   - refuse-at-creation: a non-humanGate `--stage` and an unresolved governing artifact both
 *     refuse (nonzero exit, no line written);
 *   - the terminal-receipt flow output is byte-identical to the slice-1b pre-change shape
 *     (the approval branch is added BEFORE the terminal machinery, which stays untouched).
 *
 * NOTE (slice-3a stub): the in-process `verifyExternalApproval` still returns `undefined`,
 * so a freshly-produced external approval classifies `forged` (BLOCK) until C-I wires the
 * public-key verify. This file does NOT assert grounding — only that the producer emits a
 * line whose signature/hash a C-I verifier WILL accept (verified here directly, out of band).
 *
 * Deterministic + Windows-safe (path.join, no shell). Every `TH_RECEIPT_*` env var restored.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, createPublicKey, verify, type KeyObject } from "node:crypto";
import { makeTempProject, type TempProject } from "./helpers";
import { approvalCanonicalText, computeApprovalRecordHash, externalApprovalsPath } from "../src/core/approvals";
import { externalKeyId } from "../src/core/receipt-signing";
import { computeTargetDigest } from "../src/core/receipts";
import { GENESIS_PREV_HASH } from "../src/core/hash";
import { stageContract } from "../src/core/stages";
import type { ProjectPaths } from "../src/core/paths";

const SAVED_PUBLIC_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
const SAVED_PRIVATE_KEYFILE = process.env.TH_RECEIPT_PRIVATE_KEYFILE;

let tp: TempProject | undefined;

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) delete process.env[name];
  else process.env[name] = saved;
}

afterEach(() => {
  restoreEnv("TH_RECEIPT_PUBLIC_KEYFILE", SAVED_PUBLIC_KEYFILE);
  restoreEnv("TH_RECEIPT_PRIVATE_KEYFILE", SAVED_PRIVATE_KEYFILE);
  tp?.cleanup();
  tp = undefined;
});

const PRODUCER = path.resolve(__dirname, "..", "scripts", "th-receipt-producer.mjs");

function writeFile(paths: ProjectPaths, rel: string, body: string): void {
  const abs = path.resolve(paths.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

/** Write the producer's Ed25519 private key to a pem and return its absolute path. */
function writeProducerKey(paths: ProjectPaths, name: string, privateKey: KeyObject): string {
  const f = path.join(paths.stateDir, name);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }));
  return f;
}

/** Write the governing artifact for a humanGate stage so an approval can be minted. */
function writeStageArtifact(paths: ProjectPaths, stage: string, content = "x\n"): string {
  const rel = stageContract(stage)!.produces;
  writeFile(paths, rel, content);
  return rel;
}

/** The exact spawn the producer expects; `expectOk` asserts a clean exit. */
function runProducer(args: string[], privateKeyFile: string): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env, TH_RECEIPT_PRIVATE_KEYFILE: privateKeyFile };
  return spawnSync("node", [PRODUCER, ...args], { env, encoding: "utf8" });
}

const K1 = generateKeyPairSync("ed25519");

// ===========================================================================
// HAPPY PATH — one signed external-approvals line, signature/hash match 3a.
// ===========================================================================
describe("slice-3b — external --kind approval producer", () => {
  it("writes exactly ONE signed line to external-approvals.jsonl (producer_kind:external, key_id, signature, GENESIS chain seed)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    writeStageArtifact(paths, "requirements", "req body\n");

    const res = runProducer(["--root", paths.root, "--kind", "approval", "--stage", "requirements"], privateKeyFile);
    expect(res.status, res.stderr as string).toBe(0);
    const out = JSON.parse((res.stdout as string).trim());
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("approval");
    expect(out.producer_kind).toBe("external");

    const file = externalApprovalsPath(paths);
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1); // EXACTLY one line

    const line = JSON.parse(lines[0]!);
    expect(line.kind).toBe("human-approval");
    expect(line.stage).toBe("requirements");
    expect(line.producer_kind).toBe("external");
    expect(typeof line.key_id).toBe("string");
    expect(line.key_id).toBe(externalKeyId(K1.publicKey));
    expect(typeof line.signature).toBe("string");
    expect(line.prevHash).toBe(GENESIS_PREV_HASH); // first line seeds from GENESIS
    // The recorded ground digest is the live artifact digest (content-bound, R3).
    expect(line.approval_of.governing_artifact_digest).toBe(
      computeTargetDigest(paths.root, "docs/01-requirements.md"),
    );
  });

  it("MAKE-OR-BREAK (C-I): the signed canonical text is byte-identical to the 3a approvalCanonicalText, so the signature verifies and recordHash matches", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    writeStageArtifact(paths, "requirements", "req body\n");

    const res = runProducer(["--root", paths.root, "--kind", "approval", "--stage", "requirements"], privateKeyFile);
    expect(res.status, res.stderr as string).toBe(0);

    const line = JSON.parse(fs.readFileSync(externalApprovalsPath(paths), "utf8").trim());
    const { signature, recordHash, ...rest } = line;

    // Re-derive the canonical text with the SAME 3a helper the C-I validator will use.
    const canonical = approvalCanonicalText(rest);
    // `stage` is in the signed order (R5) — a signature over a stage-less payload would not bind.
    expect(canonical).toContain('"stage":"requirements"');
    // signature + recordHash are EXCLUDED trailers (canonical text is signature-free).
    expect(canonical).not.toContain("signature");
    expect(canonical).not.toContain("recordHash");

    // The signature verifies under the producer's PUBLIC key over the 3a canonical bytes.
    const pub = createPublicKey(K1.publicKey.export({ type: "spki", format: "pem" }));
    expect(verify(null, Buffer.from(canonical, "utf8"), pub, Buffer.from(signature, "base64"))).toBe(true);
    // The recordHash matches the 3a hash binding (chain link valid for C-I).
    expect(computeApprovalRecordHash(rest)).toBe(recordHash);
  });

  it("chains a second approval off the first (prevHash = the first line's recordHash)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    writeStageArtifact(paths, "requirements", "req body\n");

    const r1 = runProducer(["--root", paths.root, "--kind", "approval", "--stage", "requirements"], privateKeyFile);
    expect(r1.status, r1.stderr as string).toBe(0);
    const r2 = runProducer(["--root", paths.root, "--kind", "approval", "--stage", "requirements"], privateKeyFile);
    expect(r2.status, r2.stderr as string).toBe(0);

    const lines = fs.readFileSync(externalApprovalsPath(paths), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.prevHash).toBe(GENESIS_PREV_HASH);
    expect(second.prevHash).toBe(first.recordHash); // append-only chain link
  });
});

// ===========================================================================
// REFUSE-AT-CREATION — symmetric with the terminal flow's target-resolve refusal.
// ===========================================================================
describe("slice-3b — external --kind approval refuse-at-creation", () => {
  it("refuses a non-humanGate --stage (domain-model) with nonzero exit and no line", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    // domain-model IS produced (write its artifact) — refusal is purely the humanGate check.
    writeStageArtifact(paths, "requirements", "req\n");

    const res = runProducer(["--root", paths.root, "--kind", "approval", "--stage", "domain-model"], privateKeyFile);
    expect(res.status).not.toBe(0);
    expect((res.stderr as string)).toContain("not a humanGate stage");
    expect(fs.existsSync(externalApprovalsPath(paths))).toBe(false); // nothing written
  });

  it("refuses when the governing artifact does not resolve in source (nonzero exit, no line)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    // No docs/01-requirements.md written → the requirements ground is unresolved.

    const res = runProducer(["--root", paths.root, "--kind", "approval", "--stage", "requirements"], privateKeyFile);
    expect(res.status).not.toBe(0);
    expect((res.stderr as string)).toContain("does not resolve in source");
    expect(fs.existsSync(externalApprovalsPath(paths))).toBe(false);
  });

  it("refuses when --stage is omitted (nonzero exit)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);
    const res = runProducer(["--root", paths.root, "--kind", "approval"], privateKeyFile);
    expect(res.status).not.toBe(0);
    expect((res.stderr as string)).toContain("--stage");
  });
});

// ===========================================================================
// TERMINAL-FLOW PIN — the approval branch is added BEFORE the terminal machinery,
// so a terminal-receipt kind still writes external-receipts.jsonl with the SAME
// slice-1b shape (the byte-identical pin: adding `approval` changed nothing here).
// ===========================================================================
describe("slice-3b — terminal-receipt flow unchanged by the approval branch", () => {
  it("decision-approve still writes external-receipts.jsonl with the slice-1b shape (NOT external-approvals.jsonl)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    const privateKeyFile = writeProducerKey(paths, "k1-private.pem", K1.privateKey);

    const res = runProducer(
      ["--root", paths.root, "--kind", "decision-approve", "--ref-id", "DEC-001"],
      privateKeyFile,
    );
    expect(res.status, res.stderr as string).toBe(0);
    const out = JSON.parse((res.stdout as string).trim());
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("decision-approve");
    expect(out.producer_kind).toBe("external");
    expect(out.refId).toBe("DEC-001");

    // The terminal store is written; the approval store is NOT touched by this kind.
    expect(fs.existsSync(path.join(paths.stateDir, "external-receipts.jsonl"))).toBe(true);
    expect(fs.existsSync(externalApprovalsPath(paths))).toBe(false);

    // The terminal line keeps its slice-1b field shape (kind/refId/target_resolves_in_source).
    const line = JSON.parse(
      fs.readFileSync(path.join(paths.stateDir, "external-receipts.jsonl"), "utf8").trim(),
    );
    expect(line.kind).toBe("decision-approve");
    expect(line.refId).toBe("DEC-001");
    expect(line.target_resolves_in_source).toEqual({ path: "", digest: "" });
    expect(line.producer_kind).toBe("external");
    expect(typeof line.signature).toBe("string");
    expect(line.prevHash).toBe(GENESIS_PREV_HASH);
  });
});
