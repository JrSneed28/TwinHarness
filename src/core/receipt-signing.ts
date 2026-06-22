/**
 * Receipt HMAC signing (Axis-B slice-1b / BSC-4 — the INDEPENDENCE primitive).
 *
 * Slice-1a's `TerminalTransitionReceipt` is content-bound but in-process
 * SELF-ATTESTED: the very agent the completion gate constrains can mint a "valid"
 * receipt, so `producer_identity` carries ZERO trust weight (receipts.ts §2.4).
 * Slice-1b adds an EXTERNAL, KEYED producer whose receipts the gate recognizes as
 * INDEPENDENTLY-grounded: the producer signs the receipt's canonical text with an
 * HMAC key held at a write-surface TwinHarness's in-process code CANNOT reach (a
 * file pointed at by `TH_RECEIPT_HMAC_KEYFILE`), and the validator verifies that
 * MAC. A signature the in-process agent cannot forge (it has no signing code path
 * AND, in the threat model, no access to the key) is the genuine un-forgeable
 * property — the asymmetry between an externally-keyed receipt (`valid-grounded`)
 * and an in-process-attested or claimed-but-unverifiable one (`valid` / `forged`).
 *
 * SECURITY BOUNDARY: the key, not the file path. The external producer writes to a
 * SEPARATE store for lock-isolation only; what makes a receipt independent is that
 * the signature verifies under a key the in-process surface does not possess. This
 * module is therefore the ONLY place a MAC is computed or checked.
 *
 * Imports `node:crypto` ONLY — no TwinHarness write-surface, no project paths, and
 * crucially NO key-WRITING anywhere (a key is read, never minted/persisted here).
 * Key I/O is deliberately kept OUT of receipts.ts so the receipt schema/chain core
 * stays free of secret handling. Mirrors `git-revision.ts`'s fail-SOFT posture for
 * the dev/no-key common case: a missing/unreadable/empty keyfile yields `null`, not
 * a throw — the validator then treats an external CLAIM it cannot verify as `forged`
 * (fail-CLOSED at the gate), while an in-process attested receipt stays `valid`.
 */

import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import * as fs from "node:fs";

/** Lowercase 64-hex — the shape of a SHA-256 HMAC signature (mirrors hash.ts HEX64). */
const SIGNATURE_HEX = /^[0-9a-f]{64}$/;

/**
 * The HMAC-SHA256 of `canonicalText` under `key`, hex-encoded. This is the SINGLE
 * signing formula; the external producer calls it at mint time and {@link
 * verifyCanonical} re-derives it at gate time, so producer and validator can never
 * drift on the binding. The input is the receipt's canonical text (recordHash and
 * signature both excluded — see receipts.ts canonicalText), so the MAC covers
 * exactly the same bytes the `recordHash` covers.
 */
export function signCanonical(canonicalText: string, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalText, "utf8").digest("hex");
}

/**
 * Timing-safe verification that `signature` is the HMAC-SHA256 of `canonicalText`
 * under `key`. Returns `false` on ANY shape/length error and NEVER throws: a
 * non-hex / wrong-length / malformed signature is simply not a match (fail-closed),
 * so a tampered or replayed signature is rejected rather than crashing the gate.
 * The compare is constant-time ({@link timingSafeEqual}) so a partial-match timing
 * side-channel cannot leak how many leading bytes were correct.
 */
export function verifyCanonical(canonicalText: string, signature: string, key: Buffer): boolean {
  try {
    if (typeof signature !== "string" || !SIGNATURE_HEX.test(signature)) return false;
    const expected = createHmac("sha256", key).update(canonicalText, "utf8").digest();
    const provided = Buffer.from(signature, "hex");
    // Equal length is guaranteed by SIGNATURE_HEX (64 hex → 32 bytes) matching
    // SHA-256's 32-byte digest, but compare lengths first so timingSafeEqual (which
    // THROWS on a length mismatch) can never throw — a defensive belt for any future
    // signature shape change.
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  } catch {
    return false; // any unexpected error ⇒ not a match (fail-closed)
  }
}

/**
 * Load the external HMAC key from the file at `TH_RECEIPT_HMAC_KEYFILE`, or `null`
 * when the env var is unset, the file is missing/unreadable, or the file is empty.
 * Fail-SOFT exactly like `git-revision.ts`: the common dev case has no key, and the
 * validator treats an absent key as "cannot verify external claims" (so an external
 * CLAIM ⇒ `forged`/BLOCK, while in-process attested receipts stay `valid`). The
 * RAW bytes are the key (an HMAC key is an opaque byte string — no decode, no trim,
 * so a key file's exact bytes are the secret); only a ZERO-length file is rejected
 * as "no key".
 */
export function loadExternalKey(): Buffer | null {
  const file = process.env.TH_RECEIPT_HMAC_KEYFILE;
  if (typeof file !== "string" || file === "") return null;
  try {
    const buf = fs.readFileSync(file);
    if (buf.length === 0) return null; // empty file ⇒ no usable key
    return buf;
  } catch {
    return null; // missing / unreadable ⇒ fail-soft to no-key
  }
}

/**
 * A short, stable, NON-secret id for `key` — the first 8 hex of `sha256(key)`. A
 * receipt records this as `key_id` so a verifier can tell WHICH key signed it (key
 * rotation: an old key id can be retired) without the receipt ever carrying the key
 * itself. SHA-256 is one-way, so publishing 8 hex of the digest leaks nothing usable
 * about the secret. Computed over the same raw key bytes {@link loadExternalKey}
 * returns, so the producer and a verifier compute the IDENTICAL id for one key.
 */
export function externalKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}
