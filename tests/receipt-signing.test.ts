/**
 * Axis-B slice-1b (BSC-4) — the receipt HMAC signing primitive
 * (src/core/receipt-signing.ts).
 *
 * Unit tests for the four exported helpers: sign/verify round-trip, wrong-key and
 * tampered-signature rejection, the fail-SOFT keyfile loader (null when the env is
 * unset / the file is missing / empty), the stable non-secret key id, and the
 * timing-safe verifier's never-throws contract on malformed input. No project
 * fixture needed — these are pure crypto + a single env/file read. The env var is
 * restored in afterEach so no test leaks `TH_RECEIPT_HMAC_KEYFILE`.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  signCanonical,
  verifyCanonical,
  loadExternalKey,
  externalKeyId,
} from "../src/core/receipt-signing";

const SAVED_KEYFILE = process.env.TH_RECEIPT_HMAC_KEYFILE;
const tmpFiles: string[] = [];

afterEach(() => {
  if (SAVED_KEYFILE === undefined) delete process.env.TH_RECEIPT_HMAC_KEYFILE;
  else process.env.TH_RECEIPT_HMAC_KEYFILE = SAVED_KEYFILE;
  for (const f of tmpFiles.splice(0)) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** Write a temp key file with the given bytes; tracked for cleanup. Returns its path. */
function writeKeyFile(bytes: Buffer | string): string {
  const f = path.join(os.tmpdir(), `th-key-${Math.random().toString(36).slice(2)}.key`);
  fs.writeFileSync(f, bytes);
  tmpFiles.push(f);
  return f;
}

const K1 = Buffer.from("key-one-0123456789abcdef-0123456789abcdef");
const K2 = Buffer.from("key-two-fedcba9876543210-fedcba9876543210");
const CANON = '{"kind":"drift-resolve","refId":"DRIFT-001"}';

describe("receipt-signing — sign / verify", () => {
  it("round-trips: a signature from signCanonical verifies under the same key", () => {
    const sig = signCanonical(CANON, K1);
    expect(sig).toMatch(/^[0-9a-f]{64}$/); // hex HMAC-SHA256
    expect(verifyCanonical(CANON, sig, K1)).toBe(true);
  });

  it("is deterministic: same (text, key) → same signature", () => {
    expect(signCanonical(CANON, K1)).toBe(signCanonical(CANON, K1));
  });

  it("wrong key ⇒ false (a signature made with K2 does not verify under K1)", () => {
    const sig = signCanonical(CANON, K2);
    expect(verifyCanonical(CANON, sig, K1)).toBe(false);
  });

  it("tampered signature ⇒ false (flip one hex char)", () => {
    const sig = signCanonical(CANON, K1);
    const c = sig[0] === "a" ? "b" : "a";
    const tampered = c + sig.slice(1);
    expect(verifyCanonical(CANON, tampered, K1)).toBe(false);
  });

  it("tampered payload ⇒ false (the canonical text changed after signing)", () => {
    const sig = signCanonical(CANON, K1);
    expect(verifyCanonical(CANON + " ", sig, K1)).toBe(false);
  });

  it("verifyCanonical NEVER throws on a malformed signature (wrong length / non-hex / empty)", () => {
    expect(() => verifyCanonical(CANON, "", K1)).not.toThrow();
    expect(verifyCanonical(CANON, "", K1)).toBe(false);
    expect(verifyCanonical(CANON, "zz", K1)).toBe(false); // non-hex
    expect(verifyCanonical(CANON, "abcd", K1)).toBe(false); // wrong length
    expect(verifyCanonical(CANON, "g".repeat(64), K1)).toBe(false); // 64 chars but non-hex
    // a 64-hex but non-matching signature is simply false, never a throw
    expect(verifyCanonical(CANON, "0".repeat(64), K1)).toBe(false);
  });
});

describe("receipt-signing — loadExternalKey (fail-soft)", () => {
  it("null when the env var is unset", () => {
    delete process.env.TH_RECEIPT_HMAC_KEYFILE;
    expect(loadExternalKey()).toBeNull();
  });

  it("null when the keyfile is missing", () => {
    process.env.TH_RECEIPT_HMAC_KEYFILE = path.join(os.tmpdir(), "definitely-not-a-real-key-file.key");
    expect(loadExternalKey()).toBeNull();
  });

  it("null when the keyfile is empty (zero bytes ⇒ no usable key)", () => {
    process.env.TH_RECEIPT_HMAC_KEYFILE = writeKeyFile("");
    expect(loadExternalKey()).toBeNull();
  });

  it("returns the RAW bytes when present (an opaque byte key — no decode, no trim)", () => {
    const raw = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x0a]); // includes a newline + a NUL
    process.env.TH_RECEIPT_HMAC_KEYFILE = writeKeyFile(raw);
    const loaded = loadExternalKey();
    expect(loaded).not.toBeNull();
    expect(Buffer.compare(loaded!, raw)).toBe(0);
  });

  it("a key loaded from disk verifies a signature it made (end-to-end through the loader)", () => {
    process.env.TH_RECEIPT_HMAC_KEYFILE = writeKeyFile(K1);
    const key = loadExternalKey()!;
    const sig = signCanonical(CANON, key);
    expect(verifyCanonical(CANON, sig, key)).toBe(true);
  });
});

describe("receipt-signing — externalKeyId", () => {
  it("is a short stable 8-hex id derived from the key (deterministic)", () => {
    const id = externalKeyId(K1);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(externalKeyId(K1)).toBe(id);
  });

  it("differs for different keys (so rotation is distinguishable)", () => {
    expect(externalKeyId(K1)).not.toBe(externalKeyId(K2));
  });

  it("does not leak the key (the id is a one-way SHA-256 prefix, not the key bytes)", () => {
    const id = externalKeyId(K1);
    expect(id).not.toContain(K1.toString("utf8").slice(0, 8));
  });
});
