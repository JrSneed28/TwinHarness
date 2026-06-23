/**
 * Human-approval receipt store (Axis-B slice-3a / BSC-7 — authenticated human
 * approvals). `humanGate` was a declarative-only flag with ZERO predicate
 * consumers (pure gate theater): every reader was a help/render string. This
 * module converts it into an enforceable precondition backed by a schema-registered
 * `HumanApprovalReceipt` — a per-stage approval bound to
 * `{stage, snapshot_coord (gitHead, treeDigest), governing_artifact_digest}` where
 * `governing_artifact_digest` is MANDATORY (snapshot_coord alone is whole-tree and
 * free to mint in-process, which would make the stale/replay controls vacuous).
 *
 * This is the FOURTH instance of the shipped receipt shape (BSC-4 terminal receipts
 * slice-1a/1b, BSC-6 scan exceptions slice-2): it REUSES the shared hash-chain
 * helpers (`computeRecordHash`, `canonicalText`, `CANONICAL_FIELD_ORDER`) and the
 * digest/snapshot primitives from `receipts.ts`, and the signing infra from
 * `receipt-signing.ts` — it does NOT import or touch `tester.ts` (F8 invariant: the
 * tester call path stays byte-identical).
 *
 * It is a DISTINCT entity from `TerminalTransitionReceipt`: an approval is keyed by
 * `stage` (no `refId`), so a focused module + a parallel `readApprovalValidated(stage)`
 * validator keep the F8 lesson (small single-purpose receipt files) and avoid
 * conflating two receipt domains. Storage mirrors `receipts.ts` EXACTLY: append-only,
 * SHA-256 hash-chained `<stateDir>/approval-receipts.jsonl`, a tolerant reader, a
 * tail-scan for the next `prevHash`, an atomic-append writer under the CALLER's
 * `withStateLock` span, and a tamper-detecting chain walk.
 *
 * `producer_identity` carries ZERO trust weight in-process (consensus §3 S1): it is
 * an audit breadcrumb only. The in-process record is hash-chained + stage/snapshot
 * -bound and LOOKS authoritative, but the agent can still mint it with `th approve`,
 * so the genuine un-forgeable property arrives only in slice-3b (an external keyed
 * producer at a write-surface TwinHarness cannot reach). The in-process pass status
 * is `valid` NEVER `valid-grounded` so the status itself encodes the trust level.
 * Documented as such so a reviewer never mistakes it for a trust anchor.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { assertGovernedWriteSurface } from "./paths";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";
import { readJsonlValues, scanTailValid, safeParseJson } from "./jsonl";
import { stageContract, STAGE_PIPELINE } from "./stages";
import {
  type SnapshotCoord,
  computeTargetDigest,
  currentReceiptSnapshotCoord,
} from "./receipts";
import {
  loadExternalPublicKey,
  verifyCanonical,
  externalKeyId,
} from "./receipt-signing";

// ---------------------------------------------------------------------------
// Schema (plan §4 step 3a-1)
// ---------------------------------------------------------------------------

/**
 * The canonical ids of the 8 `humanGate:true` stages, derived from STAGE_PIPELINE so
 * a flag flip in `stages.ts` is the single source of truth (the set can never drift
 * from the contract table). An approval's `stage` MUST be one of these.
 */
export const HUMAN_GATE_STAGES: ReadonlySet<string> = new Set(
  STAGE_PIPELINE.filter((s) => s.humanGate).map((s) => s.stage),
);

/** True iff `stage` is one of the 8 `humanGate` stages (validated against STAGE_PIPELINE). */
export function isHumanGateStage(stage: string): boolean {
  return HUMAN_GATE_STAGES.has(stage);
}

/**
 * The content-bound ground of an approval (plan §4 3a-1, R3). The approval is bound
 * to the digest of the stage's `produces` artifact at mint time — MANDATORY, never
 * empty, so a wrong-stage / stale / replay binding is mechanically detectable. (A
 * snapshot_coord-only ground is whole-tree and free to mint in-process, which would
 * make controls (c)/(e) vacuous.) The validator re-derives this digest at gate time
 * via the diff-bearing `target_resolves_in_source` path — NOT the `decision-approve`
 * build-coordinate shortcut.
 */
export interface ApprovalGround {
  /** The repository snapshot coordinate at mint time (reuses `git-revision.ts`). */
  snapshot_coord: SnapshotCoord;
  /**
   * The digest of the stage's `produces` artifact at mint time — `computeTargetDigest`
   * over the artifact path. MANDATORY (R3). The validator re-reads the artifact and
   * blocks on `target_missing` / `target_mismatch` if it no longer matches.
   */
  governing_artifact_digest: string;
}

/**
 * One human-approval receipt (plan §4 3a-1). Append-only and hash-chained like a
 * {@link import("./receipts").TerminalTransitionReceipt}: any single field edit breaks
 * `recordHash`, and an insert/delete/reorder breaks the next `prevHash`, so a forged
 * or tampered approval is detectable by {@link verifyApprovalChain}.
 */
export interface HumanApprovalReceipt {
  /** Fixed discriminator. */
  kind: "human-approval";
  /** The `humanGate` stage this approval authorizes (∈ {@link HUMAN_GATE_STAGES}). */
  stage: string;
  /** The mandatory content-bound ground (snapshot coordinate + governing-artifact digest). */
  approval_of: ApprovalGround;
  /**
   * The producer's self-asserted identity. ZERO trust weight in-process — an audit
   * breadcrumb ONLY (consensus §3 S1 / RALPLAN-DR principle #3). The un-forgeable
   * property arrives via the slice-3b external keyed producer (`producer_kind:"external"`
   * + a verifying `signature`), NOT this field. Part of the canonical hash input.
   */
  producer_identity: string;
  /**
   * Slice-3b — which PRODUCER minted this approval. `"external"` marks an approval from
   * the keyed out-of-process producer (it MUST carry a verifying `signature`);
   * `"in-process"` (or absent) marks an in-process self-attested approval (NEVER signed).
   * Optional + omit-when-absent so a 3a approval's canonical text — and therefore its
   * `recordHash` — is byte-stable. Part of the canonical hash input (after
   * `producer_identity`). Absent ⇒ in-process `valid` path (the external verify/forge
   * branch fires ONLY on an explicit `"external"` claim).
   */
  producer_kind?: "external" | "in-process";
  /**
   * Slice-3b — the short, NON-secret id of the public key that verifies an external
   * approval (`receipt-signing.externalKeyId`). Absent on in-process approvals. Part of
   * the canonical hash input (after `producer_kind`), so a key_id swap changes the
   * canonical text and breaks the signature.
   */
  key_id?: string;
  /**
   * Slice-3b — the base64 Ed25519 signature over this approval's canonical text. A
   * TRAILER, EXCLUDED from {@link approvalCanonicalText} exactly like `recordHash`: both
   * are computed over the IDENTICAL canonical input, so the signature covers every signed
   * field (including `stage`, R5). Absent on in-process approvals.
   */
  signature?: string;
  /**
   * `true` ONLY on a one-time backfill stamp (migration §4). A `legacy` approval is
   * grandfathered: the gate ACCEPTS it but the validator reports it as ungrounded-legacy.
   * Omit-when-absent so a real approval's canonical text never carries it.
   */
  legacy?: boolean;
  /**
   * Axis-B slice-BSC10a / BSC-10 — the evidence-spine continuity thread (the `manifest_digest`
   * of the signed EvidenceManifest this approval was grounded against). ADDITIVE-OPTIONAL +
   * omit-when-absent, AND IN {@link APPROVAL_CANONICAL_FIELD_ORDER} (just before `prevHash`) so a
   * PRESENT value is signature/hash-bound (tamper-evident — a swapped digest breaks `recordHash`
   * and the signature). Omit-when-absent keeps a pre-BSC-10 approval's canonical text — and
   * `recordHash` — BYTE-IDENTICAL, so shipped BSC-7 probes + receipts-parity stay green. Becomes
   * load-bearing (a producer actually sets it) under the Slice-B/C cross-receipt chain-mismatch +
   * BSC-7 conformance-precondition enforce.
   */
  manifest_digest?: string;
  /**
   * Axis-B slice-BSC10c / BSC-10 (C4a) — the evidence-spine BINDING OPT-IN. `true` declares this
   * approval PARTICIPATES in the BSC-10 evidence-spine and is therefore REQUIRED to carry a
   * `manifest_digest`. The gate blocks under enforce with reason `manifest_digest_absent` when
   * `grounding_bound === true` AND `manifest_digest` is absent. ADDITIVE-OPTIONAL + omit-when-absent,
   * AND IN {@link APPROVAL_CANONICAL_FIELD_ORDER} (just before `manifest_digest`) so a PRESENT value
   * is signature/hash-bound. Absent OR `false` ⇒ NOT bound ⇒ back-compat PASS (byte-identical for a
   * pre-BSC-10 / unenrolled approval; absence ≠ forgery — keeps shipped BSC-7 probes + parity green).
   */
  grounding_bound?: boolean;
  /** SHA-256 hex (64) of the prior line's canonical text, or GENESIS for the first. */
  prevHash: string;
  /** SHA-256 hex (64) of THIS approval's canonical text (computed before set). */
  recordHash: string;
}

// ---------------------------------------------------------------------------
// Canonical text + hashing — `stage` IS in the signed order (R5)
// ---------------------------------------------------------------------------

/**
 * The fixed canonical field order for hashing/signing (plan §4 3a-1, R5). Mirrors
 * `receipts.ts:155-170`, but `stage` JOINS the order (right after `kind`) so an
 * Ed25519 signature over the payload is BOUND to the stage — otherwise a valid
 * signature over a stage-less payload would be liftable to another stage, defeating
 * cross-stage replay protection (control c). `signature` and `recordHash` are
 * EXCLUDED trailers (the canonical text is signature-free + deterministic), computed
 * over the IDENTICAL bytes — exactly like `receipts.ts:162-166`.
 */
const APPROVAL_CANONICAL_FIELD_ORDER: ReadonlyArray<keyof HumanApprovalReceipt> = [
  "kind",
  "stage",
  "approval_of",
  "producer_identity",
  "producer_kind",
  "key_id",
  "legacy",
  // BSC-10 (C4a) evidence-spine BINDING OPT-IN: IN the canonical order just BEFORE `manifest_digest`
  // so a PRESENT `grounding_bound` is signature/hash-bound. Omit-when-absent ⇒ a pre-BSC-10 / un-
  // enrolled approval (the field absent) is byte-identical, so shipped BSC-7 probes + parity hold.
  "grounding_bound",
  // BSC-10 evidence-spine thread: IN the canonical order (just before `prevHash`) so a PRESENT
  // `manifest_digest` is signature/hash-bound (tamper-evident). Omit-when-absent ⇒ a pre-BSC-10
  // approval (the field absent) is byte-identical, so shipped BSC-7 probes + receipts-parity hold.
  "manifest_digest",
  "prevHash",
];

/** Canonical key order for {@link ApprovalGround} (byte-stable nested JSON). */
const GROUND_FIELD_ORDER: ReadonlyArray<keyof ApprovalGround> = [
  "snapshot_coord",
  "governing_artifact_digest",
];

/** Canonical key order for {@link SnapshotCoord} (byte-stable nested JSON). */
const SNAPSHOT_FIELD_ORDER: ReadonlyArray<keyof SnapshotCoord> = ["gitHead", "treeDigest"];

/** Re-emit a nested object in a fixed key order (deterministic JSON). */
function reorder<T extends object>(obj: T, order: ReadonlyArray<keyof T>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) out[key as string] = obj[key];
  return out;
}

/**
 * Deterministic canonical text of an approval for hashing/signing. Field order is
 * fixed (with `stage` IN the order, R5); `undefined` keys and `recordHash` are
 * dropped; the nested ground + snapshot objects are re-emitted in their fixed key
 * order; `JSON.stringify` with no indentation. `signature` is excluded (a trailer).
 */
export function approvalCanonicalText(receipt: Omit<HumanApprovalReceipt, "recordHash">): string {
  const ordered: Record<string, unknown> = {};
  for (const key of APPROVAL_CANONICAL_FIELD_ORDER) {
    const val = (receipt as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (key === "approval_of") {
      const g = val as ApprovalGround;
      // Re-emit the ground AND its nested snapshot in fixed key order (byte-stable).
      const normalized = {
        snapshot_coord: reorder(g.snapshot_coord, SNAPSHOT_FIELD_ORDER),
        governing_artifact_digest: g.governing_artifact_digest,
      };
      ordered[key] = reorder(normalized, GROUND_FIELD_ORDER);
    } else {
      ordered[key] = val;
    }
  }
  return JSON.stringify(ordered);
}

/**
 * `recordHash` for an approval = SHA-256 of its canonical text (recordHash omitted).
 * Hashes the approval's OWN canonical text through the SAME shared `hashContent`
 * primitive `receipts.computeRecordHash` wraps — so the two chains are byte-consistent
 * on the digest mechanics while each binds its own (terminal vs approval) field order.
 */
export function computeApprovalRecordHash(receipt: Omit<HumanApprovalReceipt, "recordHash">): string {
  return hashContent(approvalCanonicalText(receipt));
}

// ---------------------------------------------------------------------------
// Storage (mirrors receipts.ts)
// ---------------------------------------------------------------------------

/** `<stateDir>/approval-receipts.jsonl` — the in-process human-approval ledger. */
export function approvalReceiptsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "approval-receipts.jsonl");
}

/**
 * `<stateDir>/external-approvals.jsonl` — the EXTERNAL keyed producer's store
 * (slice-3b). A SEPARATE file for LOCK-ISOLATION (parallel to `external-receipts.jsonl`
 * / `scan-exceptions.jsonl`): the out-of-process producer appends here without taking
 * the in-process `withStateLock` span. The SECURITY boundary is NOT this path — it is
 * the private key held only by the producer; a forged line written here is rejected by
 * {@link readApprovalValidated} (no verifying signature ⇒ `forged`).
 */
export function externalApprovalsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "external-approvals.jsonl");
}

const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/** Validate the shape of a parsed approval line; malformed lines are skipped (tolerant). */
function isValidApproval(parsed: unknown): parsed is HumanApprovalReceipt {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (r.kind !== "human-approval") return false;
  if (typeof r.stage !== "string" || r.stage === "") return false;
  if (typeof r.producer_identity !== "string") return false;
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  if (r.legacy !== undefined && typeof r.legacy !== "boolean") return false;
  // Slice-3b OPTIONAL signing fields: accepted when present, NEVER required.
  if (r.producer_kind !== undefined && r.producer_kind !== "external" && r.producer_kind !== "in-process") return false;
  if (r.key_id !== undefined && typeof r.key_id !== "string") return false;
  if (
    r.signature !== undefined &&
    (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))
  ) {
    return false;
  }
  // Nested ground must be present + shaped; `governing_artifact_digest` is MANDATORY.
  const ground = r.approval_of;
  if (typeof ground !== "object" || ground === null) return false;
  const g = ground as Record<string, unknown>;
  if (typeof g.governing_artifact_digest !== "string") return false;
  const snap = g.snapshot_coord;
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (!(s.gitHead === null || typeof s.gitHead === "string")) return false;
  if (!(s.treeDigest === null || typeof s.treeDigest === "string")) return false;
  return true;
}

/**
 * Read + parse every approval in the in-process store, in file order. Missing file →
 * `[]`. Bad lines (non-JSON, partial-tail, schema-invalid) are silently skipped —
 * tolerant, never throws. Chain breaks surface via {@link verifyApprovalChain}.
 */
export function readApprovalReceipts(paths: ProjectPaths): HumanApprovalReceipt[] {
  return readJsonlValues(approvalReceiptsPath(paths), isValidApproval);
}

/**
 * Read + parse every approval in the EXTERNAL store (slice-3b), same tolerant shape
 * as {@link readApprovalReceipts}. The signature on a line is verified at gate time by
 * {@link readApprovalValidated}, NOT here — this reader is shape-only.
 */
export function readExternalApprovals(paths: ProjectPaths): HumanApprovalReceipt[] {
  return readJsonlValues(externalApprovalsPath(paths), isValidApproval);
}

/**
 * The `recordHash` of the EXTERNAL store's last valid approval — the `prevHash` seed
 * for the external producer's own append-only chain. Missing/empty/no-valid-tail →
 * `GENESIS_PREV_HASH`. Used by the slice-3b standalone producer.
 */
export function readLastExternalApprovalRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(externalApprovalsPath(paths), isValidApproval);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

/**
 * The `recordHash` of the in-process ledger's last VALID approval — the seed
 * {@link appendApprovalReceipt} needs to seal the next link. Tail-scans the file so N
 * appends stay O(N) total. Missing/empty/no-valid-tail → `GENESIS_PREV_HASH`.
 */
export function readLastApprovalRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(approvalReceiptsPath(paths), isValidApproval);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

// ---------------------------------------------------------------------------
// verifyChain (mirrors receipts.verifyReceiptChain) — tamper-detecting walk
// ---------------------------------------------------------------------------

export type VerifyChainResult =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: "edited" | "prev_mismatch" };

/**
 * Walk approvals in file order with a running `expectedPrev = GENESIS`. For each:
 * recompute `recordHash` from its canonical text — a mismatch means the record was
 * edited; if `prevHash !== expectedPrev` the line was inserted, deleted, or reordered;
 * a truncated chain head (the first line's `prevHash !== GENESIS`) breaks here too.
 * Return `{ ok:false, brokenAt:N }` at the FIRST break; else advance. Byte-identical
 * posture to `receipts.verifyReceiptChain` (so a tampered store → `tampered`, never a
 * silent `absent`).
 */
export function verifyApprovalChain(receipts: HumanApprovalReceipt[]): VerifyChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    const { recordHash, ...rest } = r;
    const recomputed = computeApprovalRecordHash(rest);
    if (recomputed !== recordHash) {
      return { ok: false, brokenAt: i, reason: "edited" };
    }
    if (r.prevHash !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: "prev_mismatch" };
    }
    expectedPrev = r.recordHash;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Producer API (caller already holds withStateLock)
// ---------------------------------------------------------------------------

/** Input to {@link appendApprovalReceipt}. */
export interface MintApprovalInput {
  /** The `humanGate` stage being approved (∈ {@link HUMAN_GATE_STAGES}). */
  stage: string;
  /** Self-asserted producer identity (zero in-process trust weight). */
  producerIdentity: string;
}

/**
 * Thrown by {@link appendApprovalReceipt} when the stage is not a `humanGate` stage,
 * or its governing artifact (`produces`) does not resolve in source (refuse-at-creation:
 * a producer refuses to mint an approval whose ground is already missing).
 */
export class ApprovalUnmintableError extends Error {
  /** Stable machine token for the CLI failure envelope. */
  readonly code: "approval_stage_not_human_gate" | "approval_artifact_unresolved";
  constructor(
    message: string,
    code: "approval_stage_not_human_gate" | "approval_artifact_unresolved",
    /** The offending stage. */
    public readonly stage: string,
    /** The governing-artifact path (when the failure is an unresolved artifact). */
    public readonly artifact?: string,
  ) {
    super(message);
    this.name = "ApprovalUnmintableError";
    this.code = code;
  }
}

/**
 * Append one in-process human-approval receipt, sealing the hash chain. The caller MUST
 * already hold the `withStateLock` span (read-modify-append is serialized there).
 *
 * Refuse-at-creation (plan §4 3a-2): the stage MUST be a `humanGate` stage AND its
 * governing artifact (`produces`) MUST resolve in source — else throws
 * {@link ApprovalUnmintableError} BEFORE any write, so an approval whose ground is
 * already missing cannot be minted. The approval records the digest of that artifact +
 * the current snapshot coordinate, derives `prevHash` from the tail, computes
 * `recordHash`, asserts the write-surface, and atomically appends. `producer_kind` is
 * `"in-process"` (zero trust weight). Returns the sealed approval.
 */
export function appendApprovalReceipt(
  paths: ProjectPaths,
  input: MintApprovalInput,
): HumanApprovalReceipt {
  const contract = stageContract(input.stage);
  if (!contract || !contract.humanGate) {
    throw new ApprovalUnmintableError(
      `Refusing to mint an approval for "${input.stage}": not a humanGate stage.`,
      "approval_stage_not_human_gate",
      input.stage,
    );
  }
  const artifact = contract.produces;
  const digest = computeTargetDigest(paths.root, artifact);
  if (digest === null) {
    throw new ApprovalUnmintableError(
      `Refusing to mint an approval for "${input.stage}": governing artifact "${artifact}" does not resolve in source.`,
      "approval_artifact_unresolved",
      input.stage,
      artifact,
    );
  }
  return sealAndAppend(paths, {
    kind: "human-approval",
    stage: input.stage,
    approval_of: {
      snapshot_coord: currentReceiptSnapshotCoord(paths),
      governing_artifact_digest: digest,
    },
    producer_identity: input.producerIdentity,
    producer_kind: "in-process",
  });
}

/**
 * Append a one-time `legacy:true` backfill stamp (migration §4). A legacy approval
 * carries an EMPTY governing digest (it grounds nothing — it is grandfathered), the
 * snapshot coordinate of the moment, and `producer_identity: "legacy-backfill"`.
 * Internal: only {@link ensureApprovalMigration} mints these.
 */
function appendLegacyApproval(paths: ProjectPaths, stage: string): HumanApprovalReceipt {
  return sealAndAppend(paths, {
    kind: "human-approval",
    stage,
    approval_of: {
      snapshot_coord: currentReceiptSnapshotCoord(paths),
      governing_artifact_digest: "",
    },
    producer_identity: "legacy-backfill",
    legacy: true,
  });
}

/**
 * The shared seal+append chokepoint: derive `prevHash` from the tail, compute
 * `recordHash`, assert the governed write-surface, mkdir, atomically append. The single
 * place an approval line is written, so the real and legacy producers stay byte-consistent
 * on the chain mechanics.
 */
function sealAndAppend(
  paths: ProjectPaths,
  receipt: Omit<HumanApprovalReceipt, "prevHash" | "recordHash">,
): HumanApprovalReceipt {
  assertGovernedWriteSurface(paths.root, approvalReceiptsPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const prevHash = readLastApprovalRecordHash(paths);
  const withPrev: Omit<HumanApprovalReceipt, "recordHash"> = { ...receipt, prevHash };
  const recordHash = computeApprovalRecordHash(withPrev);
  const sealed: HumanApprovalReceipt = { ...withPrev, recordHash };
  fs.appendFileSync(approvalReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

// ---------------------------------------------------------------------------
// Validation (plan §4 3a-4 / 3a-5) — readApprovalValidated → status
// ---------------------------------------------------------------------------

/**
 * The validated status of the approval backing a `humanGate` stage. Parallels
 * {@link import("./receipts").ReceiptValidationStatus} (`receipts.ts:563-572`):
 *  - `absent`         — no approval AND the stage is not grandfathered → BLOCK.
 *  - `tampered`       — the approval hash chain does not verify (incl. head truncation) → BLOCK.
 *  - `target_missing` — the recorded governing artifact no longer resolves in source → BLOCK.
 *  - `target_mismatch`— the artifact resolves but its digest ≠ recorded → BLOCK.
 *  - `stale`          — `snapshot_coord` diverged (gitHead/treeDigest) → BLOCK.
 *  - `legacy`         — a grandfathered backfill stamp → gate ACCEPTS, reported ungrounded-legacy.
 *  - `valid`          — present, non-legacy, in-process approval whose content passes. The
 *                       gate ACCEPTS it. NEVER promoted to `valid-grounded` (the forgeable
 *                       in-process record cannot read back as independently grounded).
 *  - `valid-grounded` — slice-3b: an EXTERNAL keyed approval whose signature verifies AND
 *                       whose content passes. The STRONGER form of `valid`. (3a never emits it.)
 *  - `forged`         — slice-3b: an approval CLAIMS `producer_kind:"external"` but no external
 *                       candidate's signature verifies → BLOCK. An unprovable independence claim
 *                       is rejected, never silently downgraded.
 */
export type ApprovalValidationStatus =
  | "absent"
  | "tampered"
  | "target_missing"
  | "target_mismatch"
  | "stale"
  | "legacy"
  | "valid"
  | "valid-grounded"
  | "forged";

/** The validated approval + its status (and any staleness reasons). */
export interface ValidatedApproval {
  status: ApprovalValidationStatus;
  /** The latest approval found for the stage; omitted on `absent`. */
  receipt?: HumanApprovalReceipt;
  /** On `stale`: which coordinate(s) diverged (`gitHead` / `treeDigest`). */
  staleReasons?: string[];
}

/**
 * Compare a recorded coordinate against the current one under the F8 rule: a coordinate
 * discriminates ONLY when BOTH the recorded and the current value are non-null. A null on
 * either side is non-discriminating and never contributes staleness.
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
 * Apply the content checks to a present, non-legacy approval (plan §4 3a-1 / R3). Uses
 * the DIFF-BEARING `target_resolves_in_source` path — re-read the stage's governing
 * artifact and compare its digest — NOT the `decision-approve` build-coordinate shortcut.
 * On PASS, the caller-supplied `passStatus` is returned (`valid` in-process, `valid-grounded`
 * external). On FAIL, the specific fail token.
 */
function classifyApprovalContent(
  paths: ProjectPaths,
  receipt: HumanApprovalReceipt,
  passStatus: "valid" | "valid-grounded",
): ValidatedApproval {
  const contract = stageContract(receipt.stage);
  // A well-formed approval names a real humanGate stage; if the contract is gone the
  // governing artifact cannot be re-derived → treat as target_missing (fail-closed).
  if (!contract || !contract.humanGate) return { status: "target_missing", receipt };

  const recordedDigest = receipt.approval_of.governing_artifact_digest;
  const currentDigest = computeTargetDigest(paths.root, contract.produces);
  if (currentDigest === null) return { status: "target_missing", receipt };
  if (currentDigest !== recordedDigest) return { status: "target_mismatch", receipt };

  const staleReasons = snapshotStaleReasons(
    receipt.approval_of.snapshot_coord,
    currentReceiptSnapshotCoord(paths),
  );
  if (staleReasons.length > 0) return { status: "stale", receipt, staleReasons };

  return { status: passStatus, receipt };
}

/**
 * Validate the approval backing the `humanGate` stage `stage` (plan §4 3a-4 / 3a-5).
 * Reads BOTH stores — the in-process `approval-receipts.jsonl` AND the external
 * `external-approvals.jsonl` — and gathers every candidate for `stage`.
 *
 * SLICE-3B PRECEDENCE (the grounded/forged asymmetry, mirrors `receipts.ts:649-721`):
 *   1. If ANY candidate CLAIMS `producer_kind:"external"`, it must PROVE itself.
 *      - MED-1 (external chain): the external store's append-only hash chain MUST verify
 *        first; a tampered/reordered/truncated `external-approvals.jsonl` → `tampered` →
 *        BLOCK (never honored).
 *      - Then load `loadExternalPublicKey()` and `verifyCanonical` each candidate's
 *        signature over `approvalCanonicalText(candidate)`; a verifying one → content
 *        checks → `valid-grounded`; no external candidate verifies (key absent / wrong
 *        key / tampered / replayed) → `forged` → BLOCK (NEVER silently downgraded to the
 *        in-process `valid`, and NEVER deferred to the in-process `tampered` path).
 *   2. Else (NO external claim for `stage`): the UNCHANGED slice-3a classification on the
 *      LATEST in-process candidate — absent / legacy / target_* / stale / `valid`.
 *
 * MED-2 (ordering): external precedence is evaluated FIRST. The in-process
 * `verifyApprovalChain`/`tampered` check fires ONLY in branch (2) (no external claim for
 * `stage`), so a verifying external-signed approval for stage S is NOT masked by an
 * UNRELATED in-process tamper (the external store outranks the forgeable in-process
 * ledger). The common in-process-only path (no external claim) is byte-identical to
 * slice-3a — every existing approval/fixture/neg-control test stays green.
 *
 * MARKER-INTEGRITY FAIL-CLOSED (plan §4 3a-5, R2): unlike `receipts.ts:710-715`, an
 * ABSENT migration marker does NOT blanket-`legacy`-PASS. The absent-classification keys
 * on the grandfathered baseline ONLY: a stage in the baseline → `legacy`; otherwise →
 * `absent` → BLOCK. So deleting the marker (so the baseline reads empty) downgrades NO
 * stage to a free pass — every engaged unreceipted stage classifies `absent`.
 *
 * CHAIN-TAMPER (R2-iii): a non-verifying in-process chain (incl. head truncation) →
 * `tampered`, never a silent `absent` (branch (2) only — see MED-2).
 */
export function readApprovalValidated(paths: ProjectPaths, stage: string): ValidatedApproval {
  const canonicalStage = stage;
  const matches = (r: HumanApprovalReceipt): boolean => r.stage === canonicalStage;

  // SLICE-3B MED-2 — ORDERING. External precedence is evaluated FIRST, BEFORE the
  // in-process chain/`tampered` classification. The external store outranks the
  // forgeable in-process ledger, so a genuine external-signed approval for stage S must
  // NOT be masked by an UNRELATED in-process tamper. We therefore read the external
  // store for this stage up front and only fall through to the in-process path (incl. its
  // `verifyApprovalChain` head/tamper check) when there is NO external claim for `stage` —
  // which keeps the common in-process-only path byte-identical to slice-3a behavior.
  const externalAll = readExternalApprovals(paths);
  const externalCandidates = externalAll.filter(
    (r) => matches(r) && r.producer_kind === "external",
  );

  // (1) An external CLAIM exists → it must PROVE itself with a verifying Ed25519
  // signature AND a verifying external chain (MED-1). This branch is DECISIVE: a
  // verifying external approval grounds; a non-verifying one is `forged` and BLOCKS —
  // never silently downgraded to the in-process `valid` path, and never deferred to the
  // in-process `tampered` classification.
  if (externalCandidates.length > 0) {
    // MED-1 — external chain verification. A tampered/reordered/truncated
    // external-approvals.jsonl must NOT be honored: if the external store's own
    // append-only hash chain does not verify, no external candidate can be trusted →
    // `tampered` → BLOCK (mirrors the in-process chain posture, applied to the external
    // store before any signature is accepted).
    if (!verifyApprovalChain(externalAll).ok) {
      return { status: "tampered", receipt: externalCandidates[externalCandidates.length - 1] };
    }
    const verified = verifyExternalApproval(externalCandidates);
    if (verified) {
      if (verified.legacy === true) return { status: "legacy", receipt: verified };
      return classifyApprovalContent(paths, verified, "valid-grounded");
    }
    // No external candidate verified (key absent, wrong key, or all signatures
    // bad/tampered/replayed) → forged.
    return { status: "forged", receipt: externalCandidates[externalCandidates.length - 1] };
  }

  // (2) No external claim → the UNCHANGED slice-3a classification on the in-process line.
  // The in-process chain/`tampered` check lives HERE (after the no-external-claim gate),
  // so an unrelated in-process tamper can only affect a stage with no external claim.
  const inProcessReceipts = readApprovalReceipts(paths);
  if (!verifyApprovalChain(inProcessReceipts).ok) return { status: "tampered" };
  // LATEST in-process candidate in file order (a re-approval mints a newer record).
  let inProcess: HumanApprovalReceipt | undefined;
  for (const r of inProcessReceipts) {
    if (matches(r)) inProcess = r;
  }
  if (!inProcess) {
    // Absent-classification, fail-closed marker integrity (R2): grandfathered baseline ONLY.
    if (grandfatheredBaseline(paths).has(stage)) return { status: "legacy" };
    return { status: "absent" };
  }
  if (inProcess.legacy === true) return { status: "legacy", receipt: inProcess };
  return classifyApprovalContent(paths, inProcess, "valid");
}

/**
 * Slice-3b external verification: return the LAST external candidate (file order, so a
 * re-mint wins) whose Ed25519 signature authentically verifies under the loaded public
 * key, or `undefined` when none verify.
 *
 * Mirrors `receipts.ts:690-707` exactly: load the verifier's public key
 * ({@link loadExternalPublicKey}, env `TH_RECEIPT_PUBLIC_KEYFILE`). With NO key the
 * external claim is unprovable ⇒ `undefined` ⇒ the caller classifies `forged`
 * (fail-closed; this is the default CI path for tests that set no key). For each
 * candidate: require its `key_id` to match {@link externalKeyId} of the loaded key, then
 * recompute the signed canonical text via {@link approvalCanonicalText} over the
 * candidate with the `recordHash`/`signature` trailers stripped, and
 * {@link verifyCanonical} the `signature`. Because the C-H producer signs the IDENTICAL
 * `approvalCanonicalText` bytes, a genuine external approval verifies; any tamper to a
 * signed field, a wrong-key signature, or a replayed signature over a different stage
 * fails the check.
 */
function verifyExternalApproval(candidates: HumanApprovalReceipt[]): HumanApprovalReceipt | undefined {
  const publicKey = loadExternalPublicKey();
  if (publicKey === null) return undefined;
  const configuredKeyId = externalKeyId(publicKey);
  let verified: HumanApprovalReceipt | undefined;
  for (const cand of candidates) {
    if (typeof cand.signature !== "string") continue; // no trailer ⇒ unverifiable
    if (cand.key_id !== configuredKeyId) continue;
    const { recordHash: _rh, signature: _sig, ...signedView } = cand;
    if (verifyCanonical(approvalCanonicalText(signedView), cand.signature, publicKey)) {
      verified = cand;
    }
  }
  return verified;
}

// ---------------------------------------------------------------------------
// Migration / grandfather (plan §4 3a-5) — fail-closed marker integrity (R2)
// ---------------------------------------------------------------------------

/** `<stateDir>/.approval-receipts-migration` — the migration marker file. */
function migrationMarkerPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, ".approval-receipts-migration");
}

/** The persisted migration marker shape. */
interface MigrationMarker {
  migratedAt: string;
  baseline: string[];
}

/** Tolerantly read the migration marker, or `undefined` when absent/malformed. */
function readMigrationMarker(paths: ProjectPaths): MigrationMarker | undefined {
  const file = migrationMarkerPath(paths);
  if (!fs.existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = safeParseJson(raw);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const m = parsed as Record<string, unknown>;
  if (typeof m.migratedAt !== "string") return undefined;
  if (!Array.isArray(m.baseline) || !m.baseline.every((x) => typeof x === "string")) return undefined;
  return { migratedAt: m.migratedAt, baseline: m.baseline as string[] };
}

/**
 * True once {@link ensureApprovalMigration} has run for this project. Unlike receipts.ts,
 * the absent-classification does NOT key on this to grant a blanket pass (R2 fail-closed):
 * a missing marker grants NOTHING — only stages in the grandfathered baseline pass as
 * `legacy`, and an absent marker yields an EMPTY baseline (every unreceipted stage blocks).
 */
export function approvalMigrationDone(paths: ProjectPaths): boolean {
  return readMigrationMarker(paths) !== undefined;
}

/**
 * The grandfathered baseline stage-set captured at migration time — CROSS-CHECKED
 * against the on-disk ledger (carry-forward review hardening). Members are stage ids.
 * Empty set when not yet migrated — which (with the fail-closed absent-classification)
 * means an absent marker downgrades NO stage to a free pass.
 *
 * The marker's `baseline[]` array is NOT trusted verbatim: a hand-edited marker that
 * names a stage with no on-disk chain-sealed `legacy:true` stamp would otherwise
 * manufacture a bogus `legacy`-PASS (the `ensureApprovalMigration` writer always seals a
 * real `legacy:true` stamp for every baseline member, so a legitimate baseline member
 * ALWAYS has one). So each baseline member is intersected with the set of stages that
 * carry an actual chain-sealed `legacy:true` approval in the in-process ledger; a
 * baseline entry with no matching stamp is dropped (fail-closed). A tampered chain (the
 * walk does not verify) contributes NOTHING, so a forged stamp cannot smuggle a stage in.
 */
export function grandfatheredBaseline(paths: ProjectPaths): Set<string> {
  const marker = readMigrationMarker(paths);
  if (!marker) return new Set();
  // Stages with a REAL chain-sealed `legacy:true` stamp on disk. A non-verifying chain
  // contributes nothing — a forged/edited stamp cannot manufacture a legacy stage.
  const receipts = readApprovalReceipts(paths);
  if (!verifyApprovalChain(receipts).ok) return new Set();
  const stampedLegacy = new Set<string>();
  for (const r of receipts) {
    if (r.legacy === true) stampedLegacy.add(r.stage);
  }
  return new Set(marker.baseline.filter((s) => stampedLegacy.has(s)));
}

/**
 * Idempotent, marker-guarded migration (plan §4 3a-5). MUST be called holding the state
 * lock. On the FIRST call it stamps a `legacy:true` approval for every `humanGate` stage
 * the run has ALREADY advanced past (engaged AND ordinal-≤-current) that lacks any approval,
 * then writes the marker recording the grandfathered baseline. A re-run is a no-op.
 *
 * The set of "already-advanced humanGate stages" is supplied by the caller (the gate owns the
 * required-set computation via `engagedStagesFor` + `stageOrdinal`); this keeps `approvals.ts`
 * free of the gate-precondition traversal (no import cycle: gate-preconditions imports approvals,
 * not vice-versa). The caller passes the already-advanced humanGate stage ids.
 *
 * Double-stamp guard: a stage that ALREADY has an approval is skipped — so a partial prior run,
 * or a real approval minted before migration, is never double-stamped.
 */
export function ensureApprovalMigration(paths: ProjectPaths, alreadyAdvancedHumanGateStages: readonly string[]): void {
  if (approvalMigrationDone(paths)) return; // marker present → already migrated

  const baselineStages = alreadyAdvancedHumanGateStages.filter((s) => isHumanGateStage(s));

  // Stages that already have ANY in-process approval — never double-stamp.
  const existing = new Set<string>();
  for (const r of readApprovalReceipts(paths)) existing.add(r.stage);

  for (const stage of baselineStages) {
    if (existing.has(stage)) continue;
    appendLegacyApproval(paths, stage);
    existing.add(stage);
  }

  // Write the marker LAST, recording the baseline, so a crash mid-stamp leaves no marker
  // and the next run re-attempts (the double-stamp guard makes the retry safe).
  const marker: MigrationMarker = { migratedAt: new Date().toISOString(), baseline: [...baselineStages] };
  assertGovernedWriteSurface(paths.root, migrationMarkerPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(migrationMarkerPath(paths), JSON.stringify(marker), "utf8");
}
