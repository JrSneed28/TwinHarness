/**
 * BSC-10 / Axis-B slice-A — EXTERNAL-receipt trust path coverage for `readGroundingValidated`.
 *
 * The external branch of `readGroundingValidated` (signature verification + the `valid-grounded`
 * supersession of an in-process `valid` + the "unverifiable external ⇒ ignored, never forged"
 * rule) is LIVE in Slice A — it is consumed by `evaluateGrounding` and therefore the production-
 * reality gate — but the rest of the BSC-10 suite exercises only the in-process store. This file
 * closes that gap: it is the trust anchor for the whole feature (the `valid-grounded` label), so a
 * regression that trusts an unsigned external receipt, or that drops a valid external
 * supersession, must turn this suite red rather than slip through CI.
 *
 * Mirrors the external-signing fixtures in tests/bsc3-independence-control-flip.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { makeTempProject, type TempProject } from "./helpers";
import { currentReceiptSnapshotCoord } from "../src/core/receipts";
import { externalKeyId } from "../src/core/receipt-signing";
import {
  appendGroundingReceipt,
  readGroundingValidated,
  groundingCanonicalText,
  computeGroundingRecordHash,
  readLastExternalGroundingRecordHash,
  externalGroundingReceiptsPath,
} from "../src/core/grounding";
import type { GroundingGround, GroundingReceipt } from "../src/core/grounding";
import type { ProjectPaths } from "../src/core/paths";

const SAVED_PUBLIC_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
let tp: TempProject | undefined;

afterEach(() => {
  if (SAVED_PUBLIC_KEYFILE === undefined) delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
  else process.env.TH_RECEIPT_PUBLIC_KEYFILE = SAVED_PUBLIC_KEYFILE;
  tp?.cleanup();
  tp = undefined;
});

// The verifier key (K1) and an UNRELATED key (K2) used to forge an unverifiable signature.
const K1 = generateKeyPairSync("ed25519");
const K2 = generateKeyPairSync("ed25519");

const VERSION_PIN: GroundingGround = { groundKind: "version-pin", pkg: "left-pad", version: "1.3.0" };

/** Install K1's public key (SPKI PEM) as the verifier key the gate loads. */
function setVerifierKey(paths: ProjectPaths, publicKey: KeyObject): void {
  const f = path.join(paths.stateDir, "grounding-public.pem");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(f, publicKey.export({ type: "spki", format: "pem" }));
  process.env.TH_RECEIPT_PUBLIC_KEYFILE = f;
}

/**
 * Seal a SIGNED external GroundingReceipt line directly (the Slice-B producer's formula, in-test)
 * so the test controls the signing key + key_id. Mirrors `appendSignedExternalDriver`.
 */
function appendSignedExternalGrounding(
  paths: ProjectPaths,
  opts: { ground?: GroundingGround; workClass?: string; signWith?: KeyObject; keyId?: string },
): GroundingReceipt {
  const coord = currentReceiptSnapshotCoord(paths);
  const withPrev: Omit<GroundingReceipt, "recordHash" | "signature"> = {
    kind: "grounding",
    refId: coord.gitHead ?? "no-git",
    workClass: opts.workClass ?? "integration",
    ground: opts.ground ?? VERSION_PIN,
    conformance: [],
    snapshot_coord: coord,
    producer_identity: "external:ci",
    producer_kind: "external",
    key_id: opts.keyId ?? externalKeyId(K1.publicKey),
    prevHash: readLastExternalGroundingRecordHash(paths),
  };
  const canonical = groundingCanonicalText(withPrev);
  const signature = sign(null, Buffer.from(canonical, "utf8"), opts.signWith ?? K1.privateKey).toString("base64");
  const recordHash = computeGroundingRecordHash(withPrev);
  const sealed: GroundingReceipt = { ...withPrev, signature, recordHash };
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.appendFileSync(externalGroundingReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

describe("BSC-10 external grounding — readGroundingValidated trust path", () => {
  it("a signature-verified external receipt is trustLabel:'valid-grounded'", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    setVerifierKey(paths, K1.publicKey);
    appendSignedExternalGrounding(paths, { ground: VERSION_PIN });

    const validated = readGroundingValidated(paths);
    const entry = validated.byKind.get("version-pin");
    expect(entry).toBeDefined();
    expect(entry!.trustLabel).toBe("valid-grounded");
  });

  it("a verified external receipt SUPERSEDES an in-process 'valid' of the same kind", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    setVerifierKey(paths, K1.publicKey);
    // In-process first (attribution-only `valid`)...
    appendGroundingReceipt(paths, { workClass: "integration", ground: VERSION_PIN, producerIdentity: "agent" });
    expect(readGroundingValidated(paths).byKind.get("version-pin")!.trustLabel).toBe("valid");
    // ...then a verified external one supersedes it.
    appendSignedExternalGrounding(paths, { ground: VERSION_PIN });

    const entry = readGroundingValidated(paths).byKind.get("version-pin")!;
    expect(entry.trustLabel).toBe("valid-grounded");
    expect(entry.receipt.producer_kind).toBe("external");
  });

  it("an external receipt whose signature does NOT verify (signed by a foreign key) is IGNORED — never trusted, never forged", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    setVerifierKey(paths, K1.publicKey);
    // key_id claims K1 but the signature was made with K2 ⇒ verifyCanonical fails.
    appendSignedExternalGrounding(paths, { ground: VERSION_PIN, signWith: K2.privateKey, keyId: externalKeyId(K1.publicKey) });

    // No in-process candidate either ⇒ the kind is simply absent (ungrounded), not present-as-forged.
    expect(readGroundingValidated(paths).byKind.has("version-pin")).toBe(false);
  });

  it("an external receipt with a mismatched key_id is IGNORED (absence ≠ forgery)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    setVerifierKey(paths, K1.publicKey);
    // Correct signing key but the key_id names the wrong key ⇒ groundingSignatureVerifies bails early.
    appendSignedExternalGrounding(paths, { ground: VERSION_PIN, keyId: externalKeyId(K2.publicKey) });

    expect(readGroundingValidated(paths).byKind.has("version-pin")).toBe(false);
  });

  it("an unverifiable external receipt does NOT clobber a valid in-process candidate of the same kind", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    setVerifierKey(paths, K1.publicKey);
    appendGroundingReceipt(paths, { workClass: "integration", ground: VERSION_PIN, producerIdentity: "agent" });
    // Foreign-signed external of the same kind — must be ignored, leaving the in-process `valid` intact.
    appendSignedExternalGrounding(paths, { ground: VERSION_PIN, signWith: K2.privateKey });

    const entry = readGroundingValidated(paths).byKind.get("version-pin")!;
    expect(entry.trustLabel).toBe("valid");
    expect(entry.receipt.producer_kind ?? "in-process").toBe("in-process");
  });

  it("with NO verifier key loaded, an external receipt is ignored (cannot be proven ⇒ ungrounded, not forged)", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    delete process.env.TH_RECEIPT_PUBLIC_KEYFILE; // no key ⇒ loadExternalPublicKey() === null
    appendSignedExternalGrounding(paths, { ground: VERSION_PIN });

    expect(readGroundingValidated(paths).byKind.has("version-pin")).toBe(false);
  });
});
