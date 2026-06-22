/**
 * Scan-completeness stores (Axis-B slice-2 / BSC-6). TWO append-only JSONL stores,
 * both under `<stateDir>` (already on the governed write-surface — the first path
 * segment is the state dir; {@link assertGovernedWriteSurface} keys on that, NOT the
 * filename, so no allow-list change is needed):
 *
 *   1. `scan-completeness.jsonl` — the INCOMPLETE-SCAN RECEIPT (slice-2a). A structured
 *      result log naming, for an incomplete `dist/` scan, WHICH limit was reached, WHAT
 *      remained unscanned (paths + digests), and WHICH coverage dimensions are therefore
 *      unproven (seeds BSC-3/BSC-5 observability). It carries **ZERO gate authority**:
 *      the completion gate RECOMPUTES coverage every run and never reads this file to
 *      decide — trusting a persisted "complete" summary is the EXACT bug class BSC-6 is.
 *      This is the audit trail + the `th sim scan` human surface, not a trusted source.
 *
 *   2. `scan-exceptions.jsonl` — the EXTERNAL-SIGNED EXCEPTION ACK (slice-2b — the
 *      independence increment). The ONLY trust-bearing input: an `unobserved` `dist/`
 *      file is exonerated ONLY by an Ed25519-signed, path-and-digest-scoped ack produced
 *      OUT of process (the in-process surface holds the verify-only public key and
 *      provably cannot forge one — the slice-1b grounded/forged asymmetry applied to
 *      exceptions). Signature verification, NOT chain order, is authoritative (mirrors
 *      the slice-1b external store), so the producer may append without the state lock.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { assertGovernedWriteSurface } from "./paths";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";
import { readJsonlValues, scanTailValid } from "./jsonl";
import { type SnapshotCoord, currentReceiptSnapshotCoord } from "./receipts";
import { externalKeyId, loadExternalPublicKey, verifyCanonical } from "./receipt-signing";

/** Why an enumerated `dist/` path could not be deep-inspected (the fixed reason set). */
export type UnobservedReason = "file_limit" | "aggregate_limit" | "watchdog" | "read_error";

const UNOBSERVED_REASONS: ReadonlySet<string> = new Set<UnobservedReason>([
  "file_limit",
  "aggregate_limit",
  "watchdog",
  "read_error",
]);

const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

// ===========================================================================
// 1. Incomplete-scan receipt (slice-2a) — zero gate authority, result log only
// ===========================================================================

/** One unscanned coordinate in an incomplete-scan receipt. */
export interface ScanUnobservedEntry {
  path: string;
  /** The Pass-A streaming digest; `null` only when the digest itself could not be computed. */
  digest: string | null;
  reason: UnobservedReason;
}

/**
 * The incomplete-scan receipt (zero gate authority). Names the limit(s) reached, the
 * unscanned coordinates, and the unproven coverage dimensions. Deliberately NOT
 * hash-chained: it is a result log, never a gate input, so there is no chain trust to
 * be load-bearing. It mirrors the receipts store's APPEND discipline (governed
 * write-surface assertion, atomic append under the caller's `withStateLock`) purely for
 * durability + concurrency-suite coverage.
 */
export interface ScanCompletenessReceipt {
  unobserved: ScanUnobservedEntry[];
  /** The distinct limits reached (sorted), e.g. `["aggregate_limit","file_limit"]`. */
  limits_reached: UnobservedReason[];
  /** Which coverage dimensions are unproven — `simulation-token-coverage:<path>` per gap. */
  unproven_dimensions: string[];
  snapshot_coord: SnapshotCoord;
  recordedAt: string;
}

/** `<stateDir>/scan-completeness.jsonl` — the incomplete-scan receipt store. */
export function scanCompletenessPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "scan-completeness.jsonl");
}

/** Tolerant shape check for an incomplete-scan receipt line (bad lines are skipped). */
function isValidScanCompletenessReceipt(parsed: unknown): parsed is ScanCompletenessReceipt {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (!Array.isArray(r.unobserved)) return false;
  for (const u of r.unobserved) {
    if (typeof u !== "object" || u === null) return false;
    const e = u as Record<string, unknown>;
    if (typeof e.path !== "string" || e.path === "") return false;
    if (!(e.digest === null || typeof e.digest === "string")) return false;
    if (typeof e.reason !== "string" || !UNOBSERVED_REASONS.has(e.reason)) return false;
  }
  if (!Array.isArray(r.limits_reached) || !r.limits_reached.every((x) => typeof x === "string" && UNOBSERVED_REASONS.has(x))) {
    return false;
  }
  if (!Array.isArray(r.unproven_dimensions) || !r.unproven_dimensions.every((x) => typeof x === "string")) return false;
  if (typeof r.recordedAt !== "string") return false;
  const snap = r.snapshot_coord;
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (!(s.gitHead === null || typeof s.gitHead === "string")) return false;
  if (!(s.treeDigest === null || typeof s.treeDigest === "string")) return false;
  return true;
}

/** Read every incomplete-scan receipt (file order). Missing file → `[]`; tolerant; never throws. */
export function readScanCompletenessReceipts(paths: ProjectPaths): ScanCompletenessReceipt[] {
  return readJsonlValues(scanCompletenessPath(paths), isValidScanCompletenessReceipt);
}

/**
 * Append one incomplete-scan receipt. The caller MUST already hold the `withStateLock`
 * span (mirrors `appendTerminalReceipt`). Asserts the governed write-surface, derives
 * the distinct limits + unproven dimensions, stamps the snapshot coordinate + time, and
 * atomically appends one JSON line. Returns the sealed receipt.
 */
export function appendScanCompletenessReceipt(
  paths: ProjectPaths,
  unobserved: ScanUnobservedEntry[],
): ScanCompletenessReceipt {
  assertGovernedWriteSurface(paths.root, scanCompletenessPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const limits_reached = [...new Set(unobserved.map((u) => u.reason))].sort() as UnobservedReason[];
  const unproven_dimensions = unobserved.map((u) => `simulation-token-coverage:${u.path}`);
  const receipt: ScanCompletenessReceipt = {
    unobserved,
    limits_reached,
    unproven_dimensions,
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    recordedAt: new Date().toISOString(),
  };
  fs.appendFileSync(scanCompletenessPath(paths), JSON.stringify(receipt) + "\n", "utf8");
  return receipt;
}

// ===========================================================================
// 2. External-signed exception ack (slice-2b) — the only trust-bearing input
// ===========================================================================

/**
 * An external-signed, path-and-digest-scoped exception ack. Binds a SPECIFIC
 * `(path, digest)` — the enumerated coordinate from the scan's Pass A. `signature` and
 * `recordHash` are TRAILERS excluded from the canonical text (both are computed over the
 * IDENTICAL canonical input), exactly like a terminal receipt.
 */
export interface ScanExceptionAck {
  path: string;
  digest: string;
  snapshot_coord: SnapshotCoord;
  producer_kind: "external";
  key_id: string;
  signature: string;
  prevHash: string;
  recordHash: string;
}

/** `<stateDir>/scan-exceptions.jsonl` — the external-signed exception ack store. */
export function scanExceptionsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "scan-exceptions.jsonl");
}

/** Canonical field order for the ack (signature + recordHash excluded — they are trailers). */
const ACK_CANONICAL_FIELD_ORDER = ["path", "digest", "snapshot_coord", "producer_kind", "key_id", "prevHash"] as const;
const SNAPSHOT_FIELD_ORDER: ReadonlyArray<keyof SnapshotCoord> = ["gitHead", "treeDigest"];

/**
 * Deterministic canonical text of an ack for signing + hashing: fixed field order, the
 * nested `snapshot_coord` re-emitted in a fixed key order, `signature`/`recordHash`
 * dropped. The SINGLE formula the external producer (at sign time) and the in-process
 * validator (at gate time) both use, so they can never diverge on the binding.
 */
export function scanExceptionCanonicalText(ack: Omit<ScanExceptionAck, "signature" | "recordHash">): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ACK_CANONICAL_FIELD_ORDER) {
    const val = (ack as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (key === "snapshot_coord") {
      const snap = val as SnapshotCoord;
      const reordered: Record<string, unknown> = {};
      for (const k of SNAPSHOT_FIELD_ORDER) reordered[k as string] = snap[k];
      ordered[key] = reordered;
    } else {
      ordered[key] = val;
    }
  }
  return JSON.stringify(ordered);
}

/** `recordHash` for an ack = SHA-256 of its canonical text. */
export function computeScanExceptionRecordHash(ack: Omit<ScanExceptionAck, "signature" | "recordHash">): string {
  return hashContent(scanExceptionCanonicalText(ack));
}

/** Tolerant shape check for an ack line (a malformed line is skipped, never trusted). */
function isValidScanExceptionAck(parsed: unknown): parsed is ScanExceptionAck {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (typeof r.path !== "string" || r.path === "") return false;
  if (typeof r.digest !== "string" || !HEX64.test(r.digest)) return false;
  if (r.producer_kind !== "external") return false;
  if (typeof r.key_id !== "string" || r.key_id === "") return false;
  if (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature)) return false;
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  const snap = r.snapshot_coord;
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (!(s.gitHead === null || typeof s.gitHead === "string")) return false;
  if (!(s.treeDigest === null || typeof s.treeDigest === "string")) return false;
  return true;
}

/** Read every (well-shaped) ack. Signatures are verified at gate time, NOT here. */
export function readScanExceptions(paths: ProjectPaths): ScanExceptionAck[] {
  return readJsonlValues(scanExceptionsPath(paths), isValidScanExceptionAck);
}

/** The `recordHash` of the ack store's last valid line — the producer's `prevHash` seed. */
export function readLastScanExceptionRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(scanExceptionsPath(paths), isValidScanExceptionAck);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

/**
 * The validated status of the exception ack covering a `(path, digest)` coordinate:
 *  - `accepted` — a verifying external ack signs EXACTLY this `(path, current digest)` →
 *                 exonerates the file (the only status that does).
 *  - `stale`    — a verifying ack exists for this path but over a DIFFERENT digest (the
 *                 file changed since the ack) → does NOT exonerate.
 *  - `forged`   — an ack line exists for this path but NO candidate's signature verifies
 *                 (key absent, or every signature is bad/tampered) → does NOT exonerate.
 *  - `absent`   — no ack line names this path → does NOT exonerate.
 */
export type ScanExceptionStatus = "accepted" | "stale" | "forged" | "absent";

export interface ValidatedScanException {
  status: ScanExceptionStatus;
  ack?: ScanExceptionAck;
}

/**
 * Validate the exception ack for `(targetPath, targetDigest)` (the enumerated
 * coordinate). Mirrors `readReceiptValidated`'s external precedence: an external CLAIM
 * must PROVE itself with a verifying Ed25519 signature over its canonical text under the
 * configured public key; only then, and only if the signed digest equals the CURRENT
 * digest, is the file exonerated. A path-mismatch never reaches here (filtered out);
 * a digest-mismatch is `stale`; an unverifiable line is `forged`. An in-process forge
 * cannot produce a verifying signature (the in-process surface holds no private key).
 */
export function readScanExceptionValidated(
  paths: ProjectPaths,
  targetPath: string,
  targetDigest: string,
): ValidatedScanException {
  const candidates = readScanExceptions(paths).filter((a) => a.path === targetPath);
  if (candidates.length === 0) return { status: "absent" };

  const publicKey = loadExternalPublicKey();
  if (publicKey !== null) {
    const configuredKeyId = externalKeyId(publicKey);
    // The LAST verifying candidate in file order wins (a re-mint supersedes).
    let verified: ScanExceptionAck | undefined;
    for (const cand of candidates) {
      if (cand.key_id !== configuredKeyId) continue;
      const { recordHash: _rh, signature, ...signedView } = cand;
      if (verifyCanonical(scanExceptionCanonicalText(signedView), signature, publicKey)) verified = cand;
    }
    if (verified) {
      // Path matches (filtered above); the ack exonerates ONLY the digest it signed.
      if (verified.digest === targetDigest) return { status: "accepted", ack: verified };
      return { status: "stale", ack: verified };
    }
  }
  // Candidate line(s) exist for this path but none verify (key absent / bad signature).
  return { status: "forged", ack: candidates[candidates.length - 1] };
}
