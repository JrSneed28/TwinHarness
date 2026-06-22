/**
 * Receipt public-key verification (Axis-B slice-1b / BSC-4).
 *
 * The completion-gate runtime receives only an Ed25519 PUBLIC key. The external
 * producer holds the corresponding PRIVATE key and performs signing out of
 * process. This module intentionally exports no signing primitive and no private
 * key loader, so code controlling the verifier cannot mint a trusted receipt.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import * as fs from "node:fs";

/** Base64-encoded Ed25519 signatures are exactly 64 bytes. */
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/**
 * Verify an Ed25519 signature over the receipt's canonical text. Returns false on
 * malformed input, the wrong key type, or any crypto error; never throws.
 */
export function verifyCanonical(
  canonicalText: string,
  signature: string,
  publicKey: KeyObject,
): boolean {
  try {
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") return false;
    if (typeof signature !== "string" || !SIGNATURE_BASE64.test(signature)) return false;
    const bytes = Buffer.from(signature, "base64");
    if (bytes.length !== 64) return false;
    return verify(null, Buffer.from(canonicalText, "utf8"), publicKey, bytes);
  } catch {
    return false;
  }
}

/**
 * Load the verifier's Ed25519 public key from `TH_RECEIPT_PUBLIC_KEYFILE`.
 * Missing, unreadable, malformed, private, or non-Ed25519 keys fail soft to null;
 * an external claim then classifies as forged and blocks.
 */
export function loadExternalPublicKey(): KeyObject | null {
  const file = process.env.TH_RECEIPT_PUBLIC_KEYFILE;
  if (typeof file !== "string" || file === "") return null;
  try {
    const raw = fs.readFileSync(file);
    try {
      createPrivateKey(raw);
      return null;
    } catch {
      // Expected for public-only material.
    }
    const key = createPublicKey(raw);
    if (key.asymmetricKeyType !== "ed25519") return null;
    return key;
  } catch {
    return null;
  }
}

/**
 * Stable non-secret key id: first eight hex characters of SHA-256 over the public
 * SubjectPublicKeyInfo DER encoding. Private material is never required.
 */
export function externalKeyId(publicKey: KeyObject): string {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("externalKeyId requires an Ed25519 public key");
  }
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 8);
}
