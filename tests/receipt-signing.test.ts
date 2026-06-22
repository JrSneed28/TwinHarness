/**
 * Axis-B slice-1b — verifier-only Ed25519 receipt signatures.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import * as signingModule from "../src/core/receipt-signing";
import {
  verifyCanonical,
  loadExternalPublicKey,
  externalKeyId,
} from "../src/core/receipt-signing";

const SAVED_KEYFILE = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
const tmpFiles: string[] = [];

afterEach(() => {
  if (SAVED_KEYFILE === undefined) delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
  else process.env.TH_RECEIPT_PUBLIC_KEYFILE = SAVED_KEYFILE;
  for (const f of tmpFiles.splice(0)) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function writeFile(content: string | Buffer): string {
  const f = path.join(os.tmpdir(), `th-key-${Math.random().toString(36).slice(2)}.pem`);
  fs.writeFileSync(f, content);
  tmpFiles.push(f);
  return f;
}

function signature(text: string, privateKey: KeyObject): string {
  return sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64");
}

const K1 = generateKeyPairSync("ed25519");
const K2 = generateKeyPairSync("ed25519");
const CANON = '{"kind":"drift-resolve","refId":"DRIFT-001"}';

describe("receipt-signing — verifier-only surface", () => {
  it("exports verification and public-key helpers, but no signing primitive or private-key loader", () => {
    expect(signingModule).not.toHaveProperty("signCanonical");
    expect(signingModule).not.toHaveProperty("loadExternalKey");
    expect(signingModule).not.toHaveProperty("loadExternalPrivateKey");
  });

  it("verifies an Ed25519 signature under the matching public key", () => {
    const sig = signature(CANON, K1.privateKey);
    expect(Buffer.from(sig, "base64")).toHaveLength(64);
    expect(verifyCanonical(CANON, sig, K1.publicKey)).toBe(true);
  });

  it("rejects the wrong public key, tampered payload, and tampered signature", () => {
    const sig = signature(CANON, K1.privateKey);
    expect(verifyCanonical(CANON, sig, K2.publicKey)).toBe(false);
    expect(verifyCanonical(CANON + " ", sig, K1.publicKey)).toBe(false);
    const bytes = Buffer.from(sig, "base64");
    bytes[0] ^= 0xff;
    expect(verifyCanonical(CANON, bytes.toString("base64"), K1.publicKey)).toBe(false);
  });

  it("never throws on malformed signatures", () => {
    for (const malformed of ["", "not-base64", "abcd", "A".repeat(88)]) {
      expect(() => verifyCanonical(CANON, malformed, K1.publicKey)).not.toThrow();
      expect(verifyCanonical(CANON, malformed, K1.publicKey)).toBe(false);
    }
  });
});

describe("receipt-signing — loadExternalPublicKey", () => {
  it("fails soft when the env var is unset, missing, empty, or invalid", () => {
    delete process.env.TH_RECEIPT_PUBLIC_KEYFILE;
    expect(loadExternalPublicKey()).toBeNull();
    process.env.TH_RECEIPT_PUBLIC_KEYFILE = path.join(os.tmpdir(), "missing-th-public.pem");
    expect(loadExternalPublicKey()).toBeNull();
    process.env.TH_RECEIPT_PUBLIC_KEYFILE = writeFile("");
    expect(loadExternalPublicKey()).toBeNull();
    process.env.TH_RECEIPT_PUBLIC_KEYFILE = writeFile("not a public key");
    expect(loadExternalPublicKey()).toBeNull();
  });

  it("loads an Ed25519 public key and rejects private-key input", () => {
    process.env.TH_RECEIPT_PUBLIC_KEYFILE = writeFile(
      K1.publicKey.export({ type: "spki", format: "pem" }),
    );
    const loaded = loadExternalPublicKey();
    expect(loaded?.type).toBe("public");
    expect(loaded?.asymmetricKeyType).toBe("ed25519");
    expect(verifyCanonical(CANON, signature(CANON, K1.privateKey), loaded!)).toBe(true);

    process.env.TH_RECEIPT_PUBLIC_KEYFILE = writeFile(
      K1.privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    expect(loadExternalPublicKey()).toBeNull();
  });
});

describe("receipt-signing — externalKeyId", () => {
  it("is stable for one public key and differs across keys", () => {
    const id = externalKeyId(K1.publicKey);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(externalKeyId(K1.publicKey)).toBe(id);
    expect(externalKeyId(K2.publicKey)).not.toBe(id);
  });
});
