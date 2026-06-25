/**
 * Interview-readiness receipt store (Axis-B slice-7 / BSC-9 — readiness-from-scores).
 *
 * `interviewReady(paths)` (`commands/interview.ts`) is consumed by the soft interview
 * gate (`checkInterview` in `gate-preconditions.ts`) as the SINGLE source of "the
 * interview reached confidence". It is SELF-ASSERTED: it re-reads `interview.json` and
 * returns `confidence >= cutoff`, with NO correspondence artifact recording that a real
 * scored round produced the readiness — a run can flip `ready` by editing the store and
 * the gate has no receipt to validate against. This module mints a schema-registered
 * {@link InterviewReadinessReceipt} whose *ground* (the recomputed `{confidence, cutoff,
 * ready}` over a content digest of the interview store + the repository snapshot
 * coordinate it was minted at) is re-derivable at gate time, so a readiness asserted
 * without a backing receipt — or with `confidence < cutoff` — is mechanically detectable.
 *
 * Storage mirrors `src/core/realization.ts` EXACTLY (the FIFTH+ instance of the shipped
 * receipt shape): a DEDICATED, lock-isolated append-only SHA-256 hash-chained
 * `<stateDir>/interview-readiness-receipts.jsonl`, a tolerant reader, a tail-scan for the
 * next `prevHash`, an atomic-append writer that runs under the CALLER's `withStateLock`
 * span, and a tamper-detecting chain walk. A dedicated store gives the gate one validated
 * reader and the external (un-writable) producer a distinct location.
 *
 * The readiness GROUND is keyed to the interview store, NOT a free `targetPath`: it binds
 * to `interview.json`'s digest at mint time, and the validator re-reads the store and
 * RECOMPUTES `ready = confidence >= cutoff` (the SAME `computeReadinessGround` formula
 * used at mint), so a flipped/edited store is `target_mismatch`/`not-ready` rather than
 * silently accepted (the F8 "diffable ground" lesson).
 *
 * REUSE (avoid F8 regression): the shared digest path (`computeTargetDigest`), snapshot
 * coordinate (`currentReceiptSnapshotCoord`, `SnapshotCoord`) come from `receipts.ts` and
 * the signing infra from `receipt-signing.ts` — NO new digest formula, NO touch to
 * `tester.ts`.
 *
 * `producer_identity` carries ZERO trust weight in-process (consensus §3): an audit
 * breadcrumb only. The in-process pass status is `valid` NEVER `valid-grounded`, so the
 * status itself encodes the trust level. The genuine un-forgeable property arrives via the
 * external Ed25519 producer — and even THAT is SIGNATURE-PROVENANCE independence only (the
 * scored judgment is still agent-authored; the external producer proves the receipt was
 * not forged in-process, NOT that the judgment is independent).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { assertGovernedWriteSurface } from "./paths";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";
import { readJsonlValues, scanTailValid } from "./jsonl";
import {
  type SnapshotCoord,
  computeTargetDigest,
  currentReceiptSnapshotCoord,
} from "./receipts";
import { externalKeyId, loadExternalPublicKey, verifyCanonical } from "./receipt-signing";

// ---------------------------------------------------------------------------
// Schema (slice-7 / BSC-9)
// ---------------------------------------------------------------------------

/**
 * Fixed discriminator — the receipt `kind` (matching `RealizationReceipt` /
 * `DriverDimensionReceipt`: the field is named `kind`, NOT `producer_kind`).
 */
export type InterviewReadinessKind = "interview-readiness";

/**
 * The recomputable readiness ground — the resolved confidence gate at mint time. Every
 * field is deterministic from the interview store: `confidence` is the latest round's
 * confidence (null until the first round), `cutoff` is the resolved gate, and `ready` is
 * the SINGLE computed value `confidence !== null && confidence >= cutoff` — the EXACT same
 * predicate `computeReady`/`interviewReady` apply. The validator re-derives this from the
 * store at gate time, so a flipped store is mechanically detectable.
 */
export interface ReadinessGround {
  /** The latest round's confidence (null until the first round is recorded). */
  confidence: number | null;
  /** The resolved confidence-gate cutoff (`ready` requires `confidence >= cutoff`). */
  cutoff: number;
  /** The resolved gate: `confidence !== null && confidence >= cutoff`. */
  ready: boolean;
}

/**
 * One interview-readiness receipt (slice-7 / BSC-9). Append-only and hash-chained like a
 * {@link import("./realization").RealizationReceipt}: any single field edit breaks
 * `recordHash`, and an insert/delete/reorder breaks the next `prevHash`, so a forged or
 * tampered receipt is detectable by {@link verifyReadinessChain}.
 *
 * Field order mirrors the realization/terminal receipts; the signing trailers
 * (`producer_kind`/`key_id`/`signature`) are OPTIONAL + omit-when-absent so an in-process
 * receipt's canonical text — and therefore its `recordHash` — is byte-stable.
 */
export interface InterviewReadinessReceipt {
  /** Fixed discriminator. */
  kind: InterviewReadinessKind;
  /**
   * The run identity this receipt grounds — the snapshot coordinate's `gitHead` (or
   * `"no-git"` on a non-git checkout), so a re-interview at a new HEAD mints a fresh
   * receipt and the gate finds the LATEST for the current snapshot.
   */
  refId: string;
  /**
   * The recomputable readiness ground (`{confidence, cutoff, ready}`) — re-derived at
   * gate time from the interview store via {@link computeReadinessGround}.
   */
  ground: ReadinessGround;
  /**
   * The content-bound state-snapshot coordinate: the interview-store source path the
   * readiness binds, and a content digest of that file at mint time (the diffable ground
   * — a flipped store is `target_mismatch`). `path` is project-root-relative; `digest` is
   * {@link computeTargetDigest} over it. Both `""` only on a `legacy` backfill stamp.
   */
  store_coord: { path: string; digest: string };
  /** The repository snapshot coordinate at mint time (reuses `git-revision.ts`). */
  snapshot_coord: SnapshotCoord;
  /**
   * The producer's self-asserted identity. ZERO trust weight in-process — an audit
   * breadcrumb only. The un-forgeable property arrives via the external keyed producer
   * (`producer_kind:"external"` + a verifying `signature`), NOT this field.
   */
  producer_identity: string;
  /**
   * Which PRODUCER minted this receipt. `"external"` marks a receipt from the keyed
   * out-of-process producer (it MUST carry a verifying `signature`); `"in-process"` (or
   * absent) marks an in-process attested receipt (NEVER signed). Part of the canonical
   * hash input (after `producer_identity`).
   */
  producer_kind?: "external" | "in-process";
  /**
   * The short, NON-secret id of the public key that verifies an external receipt
   * (`receipt-signing.externalKeyId`). Absent on in-process receipts. Part of the
   * canonical hash input (after `producer_kind`), so a key_id swap breaks the signature.
   */
  key_id?: string;
  /**
   * The base64 Ed25519 signature over this receipt's canonical text. A TRAILER, EXCLUDED
   * from {@link readinessCanonicalText} exactly like `recordHash`: both are computed over
   * the IDENTICAL canonical input, so the signature covers every signed field. Absent on
   * in-process receipts.
   */
  signature?: string;
  /**
   * `true` ONLY on a one-time backfill stamp (migration). A `legacy` receipt is
   * grandfathered: the gate ACCEPTS it but the validator reports it as ungrounded-legacy.
   * Omit-when-absent so a real receipt's canonical text never carries it.
   */
  legacy?: boolean;
  /** SHA-256 hex (64) of the prior line's canonical text, or GENESIS for the first. */
  prevHash: string;
  /** SHA-256 hex (64) of THIS receipt's canonical text (computed before set). */
  recordHash: string;
}

// ---------------------------------------------------------------------------
// Shared readiness-ground formula — used by BOTH the producer AND the validator
// ---------------------------------------------------------------------------

/**
 * The SINGLE shared readiness-ground formula. `ready` is the EXACT predicate
 * `computeReady`/`interviewReady` apply (`confidence !== null && confidence >= cutoff`),
 * so the mint side and the gate side can never drift apart on what "ready" means.
 */
export function computeReadinessGround(confidence: number | null, cutoff: number): ReadinessGround {
  return { confidence, cutoff, ready: confidence !== null && confidence >= cutoff };
}

// ---------------------------------------------------------------------------
// Canonical text + hashing (mirrors realization.ts)
// ---------------------------------------------------------------------------

/**
 * The fixed canonical field order for hashing/signing. `signature` and `recordHash` are
 * EXCLUDED trailers (computed over the IDENTICAL bytes); `undefined` keys are dropped, so
 * an in-process receipt (the three signing fields absent) is byte-stable. The nested
 * objects (`ground`, `store_coord`, `snapshot_coord`) are re-emitted in a fixed key order.
 */
const CANONICAL_FIELD_ORDER: ReadonlyArray<keyof InterviewReadinessReceipt> = [
  "kind",
  "refId",
  "ground",
  "store_coord",
  "snapshot_coord",
  "producer_identity",
  "producer_kind",
  "key_id",
  "legacy",
  "prevHash",
];

/** Canonical key order for {@link ReadinessGround} (byte-stable nested JSON). */
const GROUND_FIELD_ORDER: ReadonlyArray<keyof ReadinessGround> = ["confidence", "cutoff", "ready"];

/** Canonical key order for the store coordinate (byte-stable nested JSON). */
const STORE_FIELD_ORDER: ReadonlyArray<"path" | "digest"> = ["path", "digest"];

/** Canonical key order for {@link SnapshotCoord} (byte-stable nested JSON). */
const SNAPSHOT_FIELD_ORDER: ReadonlyArray<keyof SnapshotCoord> = ["gitHead", "treeDigest"];

/** Re-emit a nested object in a fixed key order (deterministic JSON). */
function reorder<T extends object>(obj: T, order: ReadonlyArray<keyof T>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) out[key as string] = obj[key];
  return out;
}

/**
 * Deterministic canonical text of a readiness receipt for hashing/signing. Field order is
 * fixed; `undefined` keys and `recordHash` are dropped; the three nested objects are
 * re-emitted in their fixed key order; `JSON.stringify` with no indentation. `signature`
 * is excluded (a trailer). `hashContent` then CRLF→LF normalizes (harmless — no CRLF).
 */
export function readinessCanonicalText(receipt: Omit<InterviewReadinessReceipt, "recordHash">): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CANONICAL_FIELD_ORDER) {
    const val = (receipt as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (key === "ground") {
      ordered[key] = reorder(val as ReadinessGround, GROUND_FIELD_ORDER);
    } else if (key === "store_coord") {
      ordered[key] = reorder(val as { path: string; digest: string }, STORE_FIELD_ORDER);
    } else if (key === "snapshot_coord") {
      ordered[key] = reorder(val as SnapshotCoord, SNAPSHOT_FIELD_ORDER);
    } else {
      ordered[key] = val;
    }
  }
  return JSON.stringify(ordered);
}

/** `recordHash` for a readiness receipt = SHA-256 of its canonical text (recordHash omitted). */
export function computeReadinessRecordHash(receipt: Omit<InterviewReadinessReceipt, "recordHash">): string {
  return hashContent(readinessCanonicalText(receipt));
}

// ---------------------------------------------------------------------------
// Storage (mirrors realization.ts)
// ---------------------------------------------------------------------------

/** `<stateDir>/interview-readiness-receipts.jsonl` — the in-process readiness-receipt ledger. */
export function readinessReceiptsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "interview-readiness-receipts.jsonl");
}

/**
 * `<stateDir>/external-interview-readiness-receipts.jsonl` — the EXTERNAL keyed producer's
 * store. A SEPARATE file for LOCK-ISOLATION (parallel to the realization/driver/approval
 * external stores): the out-of-process producer appends here without taking the in-process
 * `withStateLock` span. The SECURITY boundary is NOT this path — it is the private key held
 * only by the producer; a forged line written here is rejected by
 * {@link readReadinessReceiptValidated} (no verifying signature ⇒ `forged`).
 */
export function externalReadinessReceiptsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "external-interview-readiness-receipts.jsonl");
}

const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/** Validate the shape of a parsed readiness-receipt line; malformed lines are skipped (tolerant). */
export function isValidReadinessReceipt(parsed: unknown): parsed is InterviewReadinessReceipt {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (r.kind !== "interview-readiness") return false;
  if (typeof r.refId !== "string" || r.refId === "") return false;
  if (typeof r.producer_identity !== "string") return false;
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  if (r.legacy !== undefined && typeof r.legacy !== "boolean") return false;
  // OPTIONAL signing fields: accepted when present, NEVER required.
  if (r.producer_kind !== undefined && r.producer_kind !== "external" && r.producer_kind !== "in-process") return false;
  if (r.key_id !== undefined && typeof r.key_id !== "string") return false;
  if (
    r.signature !== undefined &&
    (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))
  ) {
    return false;
  }
  // Nested ground must be present + shaped.
  const g = r.ground;
  if (typeof g !== "object" || g === null) return false;
  const gr = g as Record<string, unknown>;
  if (!(gr.confidence === null || (typeof gr.confidence === "number" && Number.isFinite(gr.confidence)))) return false;
  if (typeof gr.cutoff !== "number" || !Number.isFinite(gr.cutoff)) return false;
  if (typeof gr.ready !== "boolean") return false;
  // Nested store coordinate must be present + shaped.
  const sc = r.store_coord;
  if (typeof sc !== "object" || sc === null) return false;
  const s2 = sc as Record<string, unknown>;
  if (typeof s2.path !== "string" || typeof s2.digest !== "string") return false;
  // Snapshot coordinate must be present + shaped.
  const snap = r.snapshot_coord;
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (!(s.gitHead === null || typeof s.gitHead === "string")) return false;
  if (!(s.treeDigest === null || typeof s.treeDigest === "string")) return false;
  return true;
}

/**
 * Read + parse every readiness receipt in the in-process store, in file order. Missing
 * file → `[]`. Bad lines are silently skipped — tolerant, never throws. Chain breaks
 * surface via {@link verifyReadinessChain}.
 */
export function readReadinessReceipts(paths: ProjectPaths): InterviewReadinessReceipt[] {
  return readJsonlValues(readinessReceiptsPath(paths), isValidReadinessReceipt);
}

/**
 * Read + parse every readiness receipt in the EXTERNAL store, same tolerant shape as
 * {@link readReadinessReceipts}. The signature on a line is verified at gate time by
 * {@link readReadinessReceiptValidated}, NOT here — this reader is shape-only, so a
 * forged-but-well-shaped line is returned and then classified `forged` downstream.
 */
export function readExternalReadinessReceipts(paths: ProjectPaths): InterviewReadinessReceipt[] {
  return readJsonlValues(externalReadinessReceiptsPath(paths), isValidReadinessReceipt);
}

/**
 * The `recordHash` of the EXTERNAL store's last valid readiness receipt — the `prevHash`
 * seed for the external producer's own append-only chain. Missing/empty/no-valid-tail →
 * `GENESIS_PREV_HASH`. Used by the standalone producer.
 */
export function readLastExternalReadinessRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(externalReadinessReceiptsPath(paths), isValidReadinessReceipt);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

/**
 * The `recordHash` of the in-process ledger's last VALID readiness receipt — the seed
 * {@link appendReadinessReceipt} needs to seal the next link. Tail-scans the file so N
 * appends stay O(N) total. Missing/empty/no-valid-tail → `GENESIS_PREV_HASH`.
 */
export function readLastReadinessRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(readinessReceiptsPath(paths), isValidReadinessReceipt);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

// ---------------------------------------------------------------------------
// verifyChain (mirrors realization.verifyRealizationChain) — tamper-detecting walk
// ---------------------------------------------------------------------------

export type VerifyChainResult =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: "edited" | "prev_mismatch" };

/**
 * Walk readiness receipts in file order with a running `expectedPrev = GENESIS`. For each
 * receipt: recompute `recordHash` from its canonical text — a mismatch means the record
 * was edited. If `prevHash !== expectedPrev` the line was inserted/deleted/reordered.
 * Return `{ ok:false, brokenAt:N }` at the FIRST break; else advance. Byte-identical
 * posture to `realization.verifyRealizationChain`.
 */
export function verifyReadinessChain(receipts: InterviewReadinessReceipt[]): VerifyChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    const { recordHash, ...rest } = r;
    const recomputed = computeReadinessRecordHash(rest);
    if (recomputed !== recordHash) return { ok: false, brokenAt: i, reason: "edited" };
    if (r.prevHash !== expectedPrev) return { ok: false, brokenAt: i, reason: "prev_mismatch" };
    expectedPrev = r.recordHash;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Producer API (caller already holds withStateLock)
// ---------------------------------------------------------------------------

/**
 * The run identity a readiness receipt is keyed by — the snapshot coordinate's `gitHead`,
 * or `"no-git"` on a non-git checkout. A re-interview at a new HEAD mints a receipt under a
 * new refId, so the gate finds the LATEST receipt for the current snapshot. The SINGLE
 * helper the mint side and the gate side both call, so the lookup key can never drift.
 */
export function readinessRefId(paths: ProjectPaths): string {
  return currentReceiptSnapshotCoord(paths).gitHead ?? "no-git";
}

/** Input to {@link appendReadinessReceipt}. */
export interface MintReadinessInput {
  /** The run identity (snapshot `gitHead`, or `"no-git"`). */
  refId: string;
  /** The latest round's confidence (null until the first round). */
  confidence: number | null;
  /** The resolved confidence-gate cutoff. */
  cutoff: number;
  /** The interview-store source path the readiness binds (MUST resolve in source). */
  storePath: string;
  /** Self-asserted producer identity (zero in-process trust weight). */
  producerIdentity: string;
}

/**
 * Thrown by {@link appendReadinessReceipt} when `storePath` does NOT resolve in source
 * (refuse-at-creation: a readiness whose store is already missing must not be minted —
 * mirrors the terminal/realization flows).
 */
export class StoreUnresolvedError extends Error {
  /** Stable machine token for the CLI failure envelope. */
  readonly code = "readiness_store_unresolved";
  constructor(
    message: string,
    /** The offending (root-relative) store path. */
    public readonly store: string,
  ) {
    super(message);
    this.name = "StoreUnresolvedError";
  }
}

/**
 * Append one in-process readiness receipt, sealing the hash chain. The caller MUST already
 * hold the `withStateLock` span (read-modify-append is serialized there), exactly like
 * `appendRealizationReceipt`.
 *
 * Refuse-at-creation: `storePath` MUST resolve in source (its digest is the recomputable
 * store ground) — else {@link StoreUnresolvedError}. The receipt records the readiness
 * ground (recomputed via {@link computeReadinessGround}), the store digest + the current
 * snapshot coordinate, derives `prevHash` from the tail, computes `recordHash`, asserts the
 * write-surface, and atomically appends. `producer_kind` is `"in-process"` (zero trust
 * weight). Returns the sealed receipt.
 */
export function appendReadinessReceipt(
  paths: ProjectPaths,
  input: MintReadinessInput,
): InterviewReadinessReceipt {
  const digest = computeTargetDigest(paths.root, input.storePath);
  if (digest === null) {
    throw new StoreUnresolvedError(
      `Refusing to mint an interview-readiness receipt for ${input.refId}: store "${input.storePath}" does not resolve in source.`,
      input.storePath,
    );
  }
  return sealAndAppend(paths, {
    kind: "interview-readiness",
    refId: input.refId,
    ground: computeReadinessGround(input.confidence, input.cutoff),
    store_coord: { path: input.storePath, digest },
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: input.producerIdentity,
    producer_kind: "in-process",
  });
}

/**
 * The shared seal+append chokepoint: derive `prevHash` from the tail, compute `recordHash`,
 * assert the governed write-surface, mkdir, atomically append. The single place a readiness
 * receipt line is written.
 */
function sealAndAppend(
  paths: ProjectPaths,
  receipt: Omit<InterviewReadinessReceipt, "prevHash" | "recordHash">,
): InterviewReadinessReceipt {
  assertGovernedWriteSurface(paths.root, readinessReceiptsPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const prevHash = readLastReadinessRecordHash(paths);
  const withPrev: Omit<InterviewReadinessReceipt, "recordHash"> = { ...receipt, prevHash };
  const recordHash = computeReadinessRecordHash(withPrev);
  const sealed: InterviewReadinessReceipt = { ...withPrev, recordHash };
  fs.appendFileSync(readinessReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

// ---------------------------------------------------------------------------
// Validation (slice-7 / BSC-9) — readReadinessReceiptValidated → status
// ---------------------------------------------------------------------------

/**
 * The validated status of the receipt backing a readiness claim. Mirrors
 * `realization.RealizationValidationStatus`:
 *  - `absent`         — no receipt → BLOCK (readiness asserted without a backing receipt).
 *  - `tampered`       — the receipt hash chain does not verify → BLOCK.
 *  - `store_missing`  — recorded `store_coord.path` no longer resolves in source → BLOCK.
 *  - `store_mismatch` — `path` resolves but its digest ≠ recorded → BLOCK (a flipped store).
 *  - `stale`          — `snapshot_coord` diverged (gitHead/treeDigest) → BLOCK.
 *  - `not-ready`      — the recomputed readiness ground is NOT ready (`confidence < cutoff`
 *                       or null) → BLOCK (sub-cutoff readiness).
 *  - `legacy`         — a grandfathered backfill stamp → gate ACCEPTS, ungrounded-legacy.
 *  - `valid`          — present, non-legacy, in-process/attested receipt whose content
 *                       passes (store resolves + matches, not stale, recomputed ready). ACCEPT.
 *  - `valid-grounded` — an EXTERNAL keyed receipt whose signature verifies AND whose content
 *                       passes. ACCEPT (stronger form of `valid`).
 *  - `forged`         — a receipt CLAIMS `producer_kind:"external"` but no external
 *                       candidate's signature verifies → BLOCK.
 */
export type ReadinessValidationStatus =
  | "absent"
  | "tampered"
  | "store_missing"
  | "store_mismatch"
  | "stale"
  | "not-ready"
  | "legacy"
  | "valid"
  | "valid-grounded"
  | "forged";

/** The validated receipt + its status (and any staleness reasons). */
export interface ValidatedReadiness {
  status: ReadinessValidationStatus;
  /** The latest receipt found for the run; omitted on `absent`. */
  receipt?: InterviewReadinessReceipt;
  /** On `stale`: which coordinate(s) diverged (`gitHead` / `treeDigest`). */
  staleReasons?: string[];
}

/**
 * Compare a recorded coordinate against the current one under the F8 rule: a coordinate
 * discriminates ONLY when BOTH the recorded and the current value are non-null.
 */
function snapshotStaleReasons(recorded: SnapshotCoord, current: SnapshotCoord): string[] {
  const reasons: string[] = [];
  if (recorded.gitHead !== null && current.gitHead !== null && recorded.gitHead !== current.gitHead) {
    reasons.push("gitHead");
  }
  if (
    recorded.treeDigest !== null &&
    current.treeDigest !== null &&
    recorded.treeDigest !== current.treeDigest
  ) {
    reasons.push("treeDigest");
  }
  return reasons;
}

/**
 * Apply the CONTENT checks to a present, non-legacy receipt, returning a pass/fail status.
 * On PASS the caller-supplied `passStatus` is returned (`valid` in-process / `valid-grounded`
 * external). On FAIL the specific token (`store_missing`/`store_mismatch`/`stale`/`not-ready`)
 * — IDENTICAL discrimination for both producer kinds. The readiness ground is re-derived
 * FRESH from the recorded `{confidence, cutoff}` (the receipt's stored `ready` is the F8
 * correspondence artifact; the live recompute is the verdict) so a hand-edited `ready:true`
 * over a sub-cutoff confidence is `not-ready`.
 */
function classifyReadinessContent(
  paths: ProjectPaths,
  receipt: InterviewReadinessReceipt,
  passStatus: "valid" | "valid-grounded",
): ValidatedReadiness {
  const recordedPath = receipt.store_coord.path;
  const recordedDigest = receipt.store_coord.digest;
  const currentDigest = computeTargetDigest(paths.root, recordedPath);
  if (currentDigest === null) return { status: "store_missing", receipt };
  if (currentDigest !== recordedDigest) return { status: "store_mismatch", receipt };

  const staleReasons = snapshotStaleReasons(receipt.snapshot_coord, currentReceiptSnapshotCoord(paths));
  if (staleReasons.length > 0) return { status: "stale", receipt, staleReasons };

  // Re-derive readiness FRESH from the recorded confidence/cutoff — do not trust the stored
  // `ready` flag. A sub-cutoff (or null) confidence is `not-ready` regardless of the flag.
  const reground = computeReadinessGround(receipt.ground.confidence, receipt.ground.cutoff);
  if (!reground.ready) return { status: "not-ready", receipt };

  return { status: passStatus, receipt };
}

/**
 * True iff a receipt CLAIMS to be external/signed — it carries EITHER a `signature` trailer
 * OR a `key_id`. Such a receipt MUST prove itself with a verifying Ed25519 signature; a
 * claim that fails verification is `forged`.
 */
function claimsExternal(r: InterviewReadinessReceipt): boolean {
  return typeof r.signature === "string" || typeof r.key_id === "string";
}

/** Verify a readiness receipt's Ed25519 signature against the loaded external public key. */
function signatureVerifies(receipt: InterviewReadinessReceipt): boolean {
  const publicKey = loadExternalPublicKey();
  if (publicKey === null) return false;
  if (typeof receipt.signature !== "string") return false;
  if (receipt.key_id !== externalKeyId(publicKey)) return false;
  const { recordHash: _rh, signature: _sig, ...signedView } = receipt;
  return verifyCanonical(readinessCanonicalText(signedView), receipt.signature, publicKey);
}

/**
 * Validate the receipt backing the readiness claim for `refId`. Reads BOTH stores — the
 * in-process `interview-readiness-receipts.jsonl` AND the external store — and gathers every
 * candidate matching `refId`. Mirrors `readRealizationReceiptValidated` precedence EXACTLY:
 * external decisive (verify-or-`forged`) → in-process `valid` → `legacy` grandfather → block
 * set.
 */
export function readReadinessReceiptValidated(
  paths: ProjectPaths,
  refId: string,
): ValidatedReadiness {
  const matches = (r: InterviewReadinessReceipt): boolean => r.refId === refId;
  const inProcessReceipts = readReadinessReceipts(paths);
  if (!verifyReadinessChain(inProcessReceipts).ok) return { status: "tampered" };
  // LATEST in-process candidate in file order (a re-interview mints a newer receipt).
  let inProcess: InterviewReadinessReceipt | undefined;
  for (const r of inProcessReceipts) {
    if (matches(r)) inProcess = r;
  }
  // ALL external candidates claiming this refId. A tampered external chain is fail-closed.
  const externalReceipts = readExternalReadinessReceipts(paths);
  const externalChainOk = verifyReadinessChain(externalReceipts).ok;
  const externalCandidates = externalReceipts.filter((r) => matches(r) && claimsExternal(r));

  // (1) An external CLAIM exists → it must PROVE itself with a verifying signature.
  if (externalCandidates.length > 0) {
    const publicKey = loadExternalPublicKey();
    if (publicKey !== null && externalChainOk) {
      // The LAST verifying external candidate in file order (a re-mint wins).
      let verified: InterviewReadinessReceipt | undefined;
      for (const cand of externalCandidates) {
        if (signatureVerifies(cand)) verified = cand;
      }
      if (verified) {
        if (verified.legacy === true) return { status: "legacy", receipt: verified };
        return classifyReadinessContent(paths, verified, "valid-grounded");
      }
    }
    // No external candidate verified (key absent, chain broken, or all signatures bad) → forged.
    return { status: "forged", receipt: externalCandidates[externalCandidates.length - 1] };
  }

  // (2) No external claim → the in-process classification on the latest line.
  if (!inProcess) return { status: "absent" };
  if (inProcess.legacy === true) return { status: "legacy", receipt: inProcess };
  return classifyReadinessContent(paths, inProcess, "valid");
}
