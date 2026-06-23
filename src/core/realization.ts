/**
 * RealizationReceipt store + the REQ→slice ownership join (Axis-B slice-5 / BSC-1 —
 * the slice-completion grounding row).
 *
 * THE BLIND SPOT (BSC-1): a slice can be marked `done` while a REQ-ID it owns has NO
 * bound, reachable, digest-fresh source anchor — "done" is asserted with no
 * correspondence to realized code. The completion gate clears anyway.
 *
 * THE GROUND (consensus plan §0.2 — an INDEPENDENT, time-separated claim surface):
 *   - The independent CLAIM already exists in state: `SliceState.status === "done"`
 *     (`state-schema.ts`), authored at the slice→done transition — a DIFFERENT act, at
 *     a DIFFERENT time, than the realize/referent binding.
 *   - The REFERENT is a digest-bound anchor in a non-plan SOURCE file, recorded by the
 *     `th realize <REQ-ID> --artifact <path>` verb (caller supplies the path, BSC-4 /
 *     `th driver record` style). `th realize` does NOT set slice status — claim and
 *     referent stay SEPARATELY authored (this separability is the whole point; co-
 *     authoring them is self-grounding = the rejected v2 ground).
 *   - The gate ranges over every REQ-ID owned by a `done` slice and fails when the claim
 *     exists but a fresh, bound referent does not.
 *
 * THE OWNERSHIP JOIN (Lane 0b — REUSE the join that already exists, do NOT invent
 * primitives): REQ-ID → files carrying it via `FileEntry.req_ids` → those files'
 * `FileEntry.component` → name-match against `SliceState.components`. The impact engine
 * already performs both halves of this join (`repo-map/query.ts`); this module reuses
 * the SAME `FileEntry` fields. A normalization rule reconciles the token-vs-POSIX-id
 * mismatch (slice "commands" vs repo-map "src/commands"), and the resolver FAILS CLOSED:
 * a done-slice REQ that maps to no owning component is REPORTED (and blocks), never
 * silently dropped ("unobserved ≠ clean").
 *
 * Storage mirrors `src/core/verification-driver.ts` EXACTLY: a DEDICATED, lock-isolated
 * append-only SHA-256 hash-chained `<stateDir>/realization-receipts.jsonl`, a tolerant
 * reader, a tail-scan for the next `prevHash`, an atomic-append writer that runs under
 * the CALLER's `withStateLock` span, and a tamper-detecting chain walk. A dedicated
 * store gives the gate one validated reader and slice-1b-style external (un-writable)
 * production a distinct location (`external-realization-receipts.jsonl`).
 *
 * GATE_OWNED (Lane 0e): the referent binding lives in THIS append store, NOT a free
 * state field — so it never reopens the `STATE_FIELD_POLICY` / MCP `th_state_set`
 * refusal surface (program history: BSC-7 marker-injection bypass). No state field is
 * added by this slice.
 *
 * REUSE (avoid F8 regression): the shared digest path (`computeTargetDigest`), snapshot
 * coordinate (`currentReceiptSnapshotCoord`, `SnapshotCoord`), and signing infra
 * (`receipt-signing.ts`) come from `receipts.ts` — NO new digest formula. It does NOT
 * import or touch `tester.ts` (the F8 call path stays byte-identical, F8 tests green).
 *
 * `producer_identity` carries ZERO trust weight in-process (consensus §2 driver 2): an
 * audit breadcrumb only. The in-process pass status is `valid` NEVER `valid-grounded`,
 * so the status itself encodes the trust level. The genuine un-forgeable property
 * arrives via the slice-1b-style external Ed25519 producer — and even THAT is honestly
 * scoped as SIGNATURE-PROVENANCE independence only: the referent anchor is still agent-
 * authored, so the external producer proves the receipt was not forged in-process, NOT
 * that the referent is independent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { assertGovernedWriteSurface } from "./paths";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";
import { readJsonlValues, scanTailValid, safeParseJson } from "./jsonl";
import {
  type SnapshotCoord,
  computeTargetDigest,
  currentReceiptSnapshotCoord,
} from "./receipts";
import { externalKeyId, loadExternalPublicKey, verifyCanonical } from "./receipt-signing";
import type { TwinHarnessState, SliceState } from "./state-schema";
import { parseRepoMap, type RepoMap, type FileEntry } from "./repo-map/schema";
import { readState, withStateLock } from "./state-store";

// ---------------------------------------------------------------------------
// Schema (plan Lane 1)
// ---------------------------------------------------------------------------

/**
 * Fixed discriminator — the receipt `kind` (matching `TerminalTransitionReceipt` /
 * `DriverDimensionReceipt`: the field is named `kind`, NOT `producer_kind`).
 */
export type RealizationKind = "realization";

/**
 * The content-bound referent: the source path the realization claims, and a content
 * digest of that file at mint time. `path` is the project-root-relative path; `digest`
 * is {@link computeTargetDigest} over it. Both `""` only on a `legacy` backfill stamp
 * (it grounds nothing — it is grandfathered).
 */
export interface RealizationReferent {
  path: string;
  digest: string;
}

/**
 * One realization receipt (plan Lane 1). Append-only and hash-chained like a
 * {@link import("./receipts").TerminalTransitionReceipt}: any single field edit breaks
 * `recordHash`, and an insert/delete/reorder breaks the next `prevHash`, so a forged or
 * tampered receipt is detectable by {@link verifyRealizationChain}.
 *
 * Field order mirrors the terminal/driver receipts; the slice-1b signing trailers
 * (`producer_kind`/`key_id`/`signature`) are OPTIONAL + omit-when-absent so an
 * in-process receipt's canonical text — and therefore its `recordHash` — is byte-stable.
 */
export interface RealizationReceipt {
  /** Fixed discriminator. */
  kind: RealizationKind;
  /** The REQ-ID this receipt grounds (the enumerator/validator key). */
  req_id: string;
  /**
   * The `done` slice that OWNS `req_id` at mint time (audit breadcrumb; the gate
   * recomputes ownership fresh from the repo-map, it does not trust this field).
   */
  owning_slice: string;
  /** The content-bound referent (source path + its digest at mint time). */
  referent: RealizationReferent;
  /** The repository snapshot coordinate at mint time (reuses `git-revision.ts`). */
  snapshot_coord: SnapshotCoord;
  /**
   * The producer's self-asserted identity. ZERO trust weight in-process — an audit
   * breadcrumb only. The un-forgeable property arrives via the external keyed producer
   * (`producer_kind:"external"` + a verifying `signature`), NOT this field.
   */
  producer_identity: string;
  /**
   * Slice-1b — which PRODUCER minted this receipt. `"external"` marks a receipt from the
   * keyed out-of-process producer (it MUST carry a verifying `signature`); `"in-process"`
   * (or absent) marks an in-process attested receipt (NEVER signed). Part of the canonical
   * hash input (after `producer_identity`).
   */
  producer_kind?: "external" | "in-process";
  /**
   * Slice-1b — the short, NON-secret id of the public key that verifies an external
   * receipt (`receipt-signing.externalKeyId`). Absent on in-process receipts. Part of the
   * canonical hash input (after `producer_kind`), so a key_id swap breaks the signature.
   */
  key_id?: string;
  /**
   * Slice-1b — the base64 Ed25519 signature over this receipt's canonical text. A
   * TRAILER, EXCLUDED from {@link realizationCanonicalText} exactly like `recordHash`:
   * both are computed over the IDENTICAL canonical input, so the signature covers every
   * signed field. Absent on in-process receipts.
   */
  signature?: string;
  /**
   * `true` ONLY on a one-time backfill stamp (migration). A `legacy` receipt is
   * grandfathered: the gate ACCEPTS it but the validator reports it as ungrounded-legacy.
   * Omit-when-absent so a real receipt's canonical text never carries it.
   */
  legacy?: boolean;
  /**
   * Axis-B slice-BSC10a / BSC-10 — the evidence-spine continuity thread (the `manifest_digest`
   * of the signed EvidenceManifest this realization was grounded against). ADDITIVE-OPTIONAL +
   * omit-when-absent AND deliberately NOT in {@link CANONICAL_FIELD_ORDER}, so a pre-BSC-10
   * receipt's canonical text — and `recordHash` — is BYTE-IDENTICAL and shipped BSC-1 probes stay
   * green. Becomes load-bearing only under the Slice-B cross-receipt chain-mismatch enforce.
   */
  manifest_digest?: string;
  /** SHA-256 hex (64) of the prior line's canonical text, or GENESIS for the first. */
  prevHash: string;
  /** SHA-256 hex (64) of THIS receipt's canonical text (computed before set). */
  recordHash: string;
}

// ---------------------------------------------------------------------------
// Canonical text + hashing (mirrors receipts.ts / verification-driver.ts)
// ---------------------------------------------------------------------------

/**
 * The fixed canonical field order for hashing/signing. `signature` and `recordHash` are
 * EXCLUDED trailers (computed over the IDENTICAL bytes); `undefined` keys are dropped, so
 * an in-process receipt (the three signing fields absent) is byte-stable. The two nested
 * objects (`referent`, `snapshot_coord`) are re-emitted in a fixed key order.
 */
const CANONICAL_FIELD_ORDER: ReadonlyArray<keyof RealizationReceipt> = [
  "kind",
  "req_id",
  "owning_slice",
  "referent",
  "snapshot_coord",
  "producer_identity",
  "producer_kind",
  "key_id",
  "legacy",
  // BSC-10 evidence-spine thread: IN the canonical order (just before `prevHash`) so a PRESENT
  // `manifest_digest` is signature/hash-bound (tamper-evident). Omit-when-absent ⇒ a pre-BSC-10
  // receipt (the field absent) is byte-identical, so shipped BSC-1 probes + receipts-parity hold.
  "manifest_digest",
  "prevHash",
];

/** Canonical key order for {@link RealizationReferent} (byte-stable nested JSON). */
const REFERENT_FIELD_ORDER: ReadonlyArray<keyof RealizationReferent> = ["path", "digest"];

/** Canonical key order for {@link SnapshotCoord} (byte-stable nested JSON). */
const SNAPSHOT_FIELD_ORDER: ReadonlyArray<keyof SnapshotCoord> = ["gitHead", "treeDigest"];

/** Re-emit a nested object in a fixed key order (deterministic JSON). */
function reorder<T extends object>(obj: T, order: ReadonlyArray<keyof T>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) out[key as string] = obj[key];
  return out;
}

/**
 * Deterministic canonical text of a realization receipt for hashing/signing. Field order
 * is fixed; `undefined` keys and `recordHash` are dropped; the two nested objects are
 * re-emitted in their fixed key order; `JSON.stringify` with no indentation. `signature`
 * is excluded (a trailer). `hashContent` then CRLF→LF normalizes (harmless — no CRLF).
 */
export function realizationCanonicalText(receipt: Omit<RealizationReceipt, "recordHash">): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CANONICAL_FIELD_ORDER) {
    const val = (receipt as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (key === "referent") {
      ordered[key] = reorder(val as RealizationReferent, REFERENT_FIELD_ORDER);
    } else if (key === "snapshot_coord") {
      ordered[key] = reorder(val as SnapshotCoord, SNAPSHOT_FIELD_ORDER);
    } else {
      ordered[key] = val;
    }
  }
  return JSON.stringify(ordered);
}

/** `recordHash` for a realization receipt = SHA-256 of its canonical text (recordHash omitted). */
export function computeRealizationRecordHash(receipt: Omit<RealizationReceipt, "recordHash">): string {
  return hashContent(realizationCanonicalText(receipt));
}

// ---------------------------------------------------------------------------
// Storage (mirrors verification-driver.ts)
// ---------------------------------------------------------------------------

/** `<stateDir>/realization-receipts.jsonl` — the in-process realization-receipt ledger. */
export function realizationReceiptsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "realization-receipts.jsonl");
}

/**
 * `<stateDir>/external-realization-receipts.jsonl` — the EXTERNAL keyed producer's store
 * (slice-1b). A SEPARATE file for LOCK-ISOLATION (parallel to the driver/approval external
 * stores): the out-of-process producer appends here without taking the in-process
 * `withStateLock` span. The SECURITY boundary is NOT this path — it is the private key held
 * only by the producer; a forged line written here is rejected by
 * {@link readRealizationReceiptValidated} (no verifying signature ⇒ `forged`).
 */
export function externalRealizationReceiptsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "external-realization-receipts.jsonl");
}

const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/** Validate the shape of a parsed realization-receipt line; malformed lines are skipped (tolerant). */
export function isValidRealizationReceipt(parsed: unknown): parsed is RealizationReceipt {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (r.kind !== "realization") return false;
  if (typeof r.req_id !== "string" || r.req_id === "") return false;
  if (typeof r.owning_slice !== "string") return false;
  if (typeof r.producer_identity !== "string") return false;
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  if (r.legacy !== undefined && typeof r.legacy !== "boolean") return false;
  // Slice-1b OPTIONAL signing fields: accepted when present, NEVER required.
  if (r.producer_kind !== undefined && r.producer_kind !== "external" && r.producer_kind !== "in-process") return false;
  if (r.key_id !== undefined && typeof r.key_id !== "string") return false;
  if (
    r.signature !== undefined &&
    (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))
  ) {
    return false;
  }
  // Nested referent must be present + shaped.
  const ref = r.referent;
  if (typeof ref !== "object" || ref === null) return false;
  const f = ref as Record<string, unknown>;
  if (typeof f.path !== "string" || typeof f.digest !== "string") return false;
  // Snapshot coordinate must be present + shaped.
  const snap = r.snapshot_coord;
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (!(s.gitHead === null || typeof s.gitHead === "string")) return false;
  if (!(s.treeDigest === null || typeof s.treeDigest === "string")) return false;
  return true;
}

/**
 * Read + parse every realization receipt in the in-process store, in file order. Missing
 * file → `[]`. Bad lines (non-JSON, partial-tail, schema-invalid) are silently skipped —
 * tolerant, never throws. Chain breaks surface via {@link verifyRealizationChain}.
 */
export function readRealizationReceipts(paths: ProjectPaths): RealizationReceipt[] {
  return readJsonlValues(realizationReceiptsPath(paths), isValidRealizationReceipt);
}

/**
 * Read + parse every realization receipt in the EXTERNAL store (slice-1b), same tolerant
 * shape as {@link readRealizationReceipts}. The signature on a line is verified at gate time
 * by {@link readRealizationReceiptValidated}, NOT here — this reader is shape-only, so a
 * forged-but-well-shaped line is returned and then classified `forged` downstream.
 */
export function readExternalRealizationReceipts(paths: ProjectPaths): RealizationReceipt[] {
  return readJsonlValues(externalRealizationReceiptsPath(paths), isValidRealizationReceipt);
}

/**
 * The `recordHash` of the EXTERNAL store's last valid realization receipt — the `prevHash`
 * seed for the external producer's own append-only chain. Missing/empty/no-valid-tail →
 * `GENESIS_PREV_HASH`. Used by the slice-1b standalone producer.
 */
export function readLastExternalRealizationRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(externalRealizationReceiptsPath(paths), isValidRealizationReceipt);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

/**
 * The `recordHash` of the in-process ledger's last VALID realization receipt — the seed
 * {@link appendRealizationReceipt} needs to seal the next link. Tail-scans the file so N
 * appends stay O(N) total. Missing/empty/no-valid-tail → `GENESIS_PREV_HASH`.
 */
export function readLastRealizationRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(realizationReceiptsPath(paths), isValidRealizationReceipt);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

// ---------------------------------------------------------------------------
// verifyChain (mirrors receipts.verifyReceiptChain) — tamper-detecting walk
// ---------------------------------------------------------------------------

export type VerifyChainResult =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: "edited" | "prev_mismatch" };

/**
 * Walk realization receipts in file order with a running `expectedPrev = GENESIS`. For
 * each: recompute `recordHash` from its canonical text — a mismatch means the record was
 * edited; if `prevHash !== expectedPrev` the line was inserted/deleted/reordered. Return
 * `{ ok:false, brokenAt:N }` at the FIRST break; else advance. Byte-identical posture to
 * `receipts.verifyReceiptChain`.
 */
export function verifyRealizationChain(receipts: RealizationReceipt[]): VerifyChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    const { recordHash, ...rest } = r;
    const recomputed = computeRealizationRecordHash(rest);
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
// REQ→slice ownership join (Lane 0b) + done-slice REQ enumerator (Lane 0c)
// ---------------------------------------------------------------------------

/**
 * Normalize a component-identity token for the slice-vs-repo-map name match (Lane 0b).
 * `SliceState.components` are free-text tokens parsed from the plan markdown (e.g.
 * "commands"); repo-map `Component.name` / `FileEntry.component` may be POSIX-ish ids
 * (e.g. "src/commands"). We reconcile them by taking the LAST path segment, lowercasing,
 * and stripping a trailing slash — so "src/commands", "commands", and "Commands/" all
 * normalize to "commands". Deterministic + platform-independent. An empty/whitespace
 * token normalizes to "" and never matches (it is reported as unresolved, fail-closed).
 */
export function normalizeComponentToken(token: string): string {
  const trimmed = token.trim().replace(/[\\/]+$/, "");
  if (trimmed === "") return "";
  const segs = trimmed.split(/[\\/]+/);
  return (segs[segs.length - 1] ?? "").toLowerCase();
}

/** The `done` slices in a state (the independent claim surface — Lane 0a). */
export function doneSlices(state: TwinHarnessState): SliceState[] {
  return state.slices.filter((s) => s.status === "done");
}

/**
 * One REQ-ID owned by a `done` slice + the ownership-join outcome (Lane 0b/0c). The
 * enumerator ranges over these INDEPENDENT of receipt presence, so "absent receipt blocks"
 * is reachable.
 */
export interface OwnedReq {
  /** The REQ-ID (carried by ≥1 `FileEntry.req_ids` in the repo-map). */
  reqId: string;
  /** The `done` slice id(s) that own it (owned-by-ANY-`done` ⇒ must be backed). */
  owningSlices: string[];
  /**
   * `true` when the join FAILED CLOSED: the REQ is carried by files whose component does
   * NOT normalize-match any `done` slice component, yet the REQ appears in a context that
   * required resolution. Reported, never silently dropped (control 11f).
   *
   * NOTE: in the primary enumeration path this is always `false` (we only enumerate REQs we
   * could join to a done slice). The fail-closed UNRESOLVED set is enumerated separately by
   * {@link unresolvedDoneSliceReqs} so the gate can block on it distinctly.
   */
  unresolved: false;
}

/**
 * Build the set of component-name normalizations a set of slices declares (Lane 0b). Maps
 * the normalized token back to the slice ids that contributed it, so a matched file's
 * component resolves to the owning done slice(s).
 */
function doneSliceComponentIndex(done: SliceState[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const slice of done) {
    for (const comp of slice.components) {
      const norm = normalizeComponentToken(comp);
      if (norm === "") continue;
      const owners = index.get(norm) ?? [];
      if (!owners.includes(slice.id)) owners.push(slice.id);
      index.set(norm, owners);
    }
  }
  return index;
}

/**
 * The REQ-IDs OWNED by a `done` slice (Lane 0c — the gate enumerator). For each REQ-ID
 * carried by any `FileEntry.req_ids` in the repo-map, take that file's `component`,
 * normalize it, and match against the `done` slices' normalized component set. A REQ owned
 * by ANY done slice (via any of its carrying files) must be backed.
 *
 * This REUSES the impact engine's join halves (`FileEntry.req_ids` → `FileEntry.component`)
 * over the same `RepoMap`. Returns the resolved owned set; the UNRESOLVED fail-closed set
 * (a REQ carried only by files whose component matched no done slice) is computed by
 * {@link unresolvedDoneSliceReqs}.
 */
export function ownedReqsForDoneSlices(map: RepoMap, state: TwinHarnessState): OwnedReq[] {
  const done = doneSlices(state);
  if (done.length === 0) return [];
  const compIndex = doneSliceComponentIndex(done);

  // reqId → set of owning done-slice ids (resolved via component normalization).
  const owners = new Map<string, Set<string>>();
  for (const file of map.files) {
    if (file.req_ids.length === 0) continue;
    const norm = file.component === null ? "" : normalizeComponentToken(file.component);
    const sliceIds = norm === "" ? undefined : compIndex.get(norm);
    if (sliceIds === undefined) continue;
    for (const reqId of file.req_ids) {
      const set = owners.get(reqId) ?? new Set<string>();
      for (const id of sliceIds) set.add(id);
      owners.set(reqId, set);
    }
  }

  const out: OwnedReq[] = [];
  for (const [reqId, set] of owners) {
    out.push({ reqId, owningSlices: [...set].sort(), unresolved: false });
  }
  out.sort((a, b) => (a.reqId < b.reqId ? -1 : a.reqId > b.reqId ? 1 : 0));
  return out;
}

/**
 * The fail-closed UNRESOLVED set (Lane 0b / control 11f): a REQ-ID that is carried by repo-
 * map files AND appears in a `done` slice's coverage obligation, but whose carrying files'
 * components do NOT normalize-match any done slice component — so the ownership join could
 * not place it under a known component. Such a REQ is REPORTED (and blocks), never silently
 * dropped ("unobserved ≠ clean").
 *
 * We approximate "appears in a done slice's obligation" by: a REQ carried by ≥1 file in the
 * repo-map, NOT resolved by {@link ownedReqsForDoneSlices}, AND carried by a file whose
 * component is null/unmatched while some done slice exists. To avoid blocking on the entire
 * repo's REQ universe (most REQs belong to non-done slices), we ONLY flag a REQ as
 * fail-closed-unresolved when at least one of its carrying files has a `null` component
 * (genuinely unowned-in-map) — the precise name-fidelity hole the guard closes. A REQ whose
 * files all carry a non-null component that simply belongs to a non-done slice is correctly
 * NOT our obligation and is excluded.
 */
export function unresolvedDoneSliceReqs(map: RepoMap, state: TwinHarnessState): string[] {
  const done = doneSlices(state);
  if (done.length === 0) return [];
  const resolved = new Set(ownedReqsForDoneSlices(map, state).map((o) => o.reqId));
  const unresolved = new Set<string>();
  for (const file of map.files) {
    if (file.req_ids.length === 0) continue;
    if (file.component !== null) continue; // owned-in-map; not a name-fidelity hole
    for (const reqId of file.req_ids) {
      if (!resolved.has(reqId)) unresolved.add(reqId);
    }
  }
  return [...unresolved].sort();
}

/**
 * Load + parse the persisted `<stateDir>/repo-map.json` for the gate's ownership join.
 * Returns the parsed map, or `null` when the map is absent/invalid (the gate treats a
 * missing map as "no owned REQs to enforce" — the brownfield `checkRepoMap` rung already
 * owns repo-map freshness; we do not double-block here). Tolerant: never throws.
 */
export function loadRepoMapForRealization(paths: ProjectPaths): RepoMap | null {
  const mapJsonPath = path.join(paths.stateDir, "repo-map.json");
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(mapJsonPath, "utf8");
  } catch {
    return null;
  }
  const parsed = parseRepoMap(raw);
  return parsed.ok && parsed.map ? parsed.map : null;
}

// ---------------------------------------------------------------------------
// Producer API (caller already holds withStateLock)
// ---------------------------------------------------------------------------

/** Input to {@link appendRealizationReceipt}. */
export interface MintRealizationInput {
  /** The REQ-ID being realized. */
  reqId: string;
  /** The `done` slice that owns it at mint time (audit breadcrumb). */
  owningSlice: string;
  /** The referent source path the realization binds. MUST resolve in source. */
  artifactPath: string;
  /** Self-asserted producer identity (zero in-process trust weight). */
  producerIdentity: string;
}

/**
 * Thrown by {@link appendRealizationReceipt} when `artifactPath` does NOT resolve in
 * source (refuse-at-creation: a realization whose referent is already missing must not be
 * minted — mirrors the terminal/driver flows).
 */
export class ReferentUnresolvedError extends Error {
  /** Stable machine token for the CLI failure envelope. */
  readonly code = "realization_referent_unresolved";
  constructor(
    message: string,
    /** The offending (root-relative) referent path. */
    public readonly referent: string,
  ) {
    super(message);
    this.name = "ReferentUnresolvedError";
  }
}

/**
 * Append one in-process realization receipt, sealing the hash chain. The caller MUST
 * already hold the `withStateLock` span (read-modify-append is serialized there), exactly
 * like `appendDriverReceipt`.
 *
 * Refuse-at-creation: `artifactPath` MUST resolve in source (its digest is the recomputable
 * referent ground) — else {@link ReferentUnresolvedError}. The receipt records the referent
 * digest + the current snapshot coordinate, derives `prevHash` from the tail, computes
 * `recordHash`, asserts the write-surface, and atomically appends. `producer_kind` is
 * `"in-process"` (zero trust weight). It does NOT set slice status — claim and referent stay
 * separately authored. Returns the sealed receipt.
 */
export function appendRealizationReceipt(
  paths: ProjectPaths,
  input: MintRealizationInput,
): RealizationReceipt {
  const digest = computeTargetDigest(paths.root, input.artifactPath);
  if (digest === null) {
    throw new ReferentUnresolvedError(
      `Refusing to mint a realization receipt for ${input.reqId}: artifact "${input.artifactPath}" does not resolve in source.`,
      input.artifactPath,
    );
  }
  return sealAndAppend(paths, {
    kind: "realization",
    req_id: input.reqId,
    owning_slice: input.owningSlice,
    referent: { path: input.artifactPath, digest },
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: input.producerIdentity,
    producer_kind: "in-process",
  });
}

/**
 * Append a one-time `legacy:true` backfill stamp (migration). A legacy receipt carries an
 * EMPTY referent (it grounds nothing — it is grandfathered), the snapshot coordinate of the
 * moment, and `producer_identity: "legacy-backfill"`. Internal: only
 * {@link ensureRealizationMigration} mints these.
 */
function appendLegacyRealizationReceipt(
  paths: ProjectPaths,
  reqId: string,
  owningSlice: string,
): RealizationReceipt {
  return sealAndAppend(paths, {
    kind: "realization",
    req_id: reqId,
    owning_slice: owningSlice,
    referent: { path: "", digest: "" },
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: "legacy-backfill",
    legacy: true,
  });
}

/**
 * The shared seal+append chokepoint: derive `prevHash` from the tail, compute `recordHash`,
 * assert the governed write-surface, mkdir, atomically append. The single place a
 * realization receipt line is written, so the real and legacy producers stay byte-consistent
 * on the chain mechanics.
 */
function sealAndAppend(
  paths: ProjectPaths,
  receipt: Omit<RealizationReceipt, "prevHash" | "recordHash">,
): RealizationReceipt {
  assertGovernedWriteSurface(paths.root, realizationReceiptsPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const prevHash = readLastRealizationRecordHash(paths);
  const withPrev: Omit<RealizationReceipt, "recordHash"> = { ...receipt, prevHash };
  const recordHash = computeRealizationRecordHash(withPrev);
  const sealed: RealizationReceipt = { ...withPrev, recordHash };
  fs.appendFileSync(realizationReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

// ---------------------------------------------------------------------------
// Validation (plan Lane 1 step 4) — readRealizationReceiptValidated → status
// ---------------------------------------------------------------------------

/**
 * The validated status of the receipt backing a realization claim. Mirrors
 * `receipts.ReceiptValidationStatus`:
 *  - `absent`         — no receipt AND not grandfathered → BLOCK.
 *  - `tampered`       — the receipt hash chain does not verify → BLOCK.
 *  - `target_missing` — recorded `referent.path` no longer resolves in source → BLOCK.
 *  - `target_mismatch`— `path` resolves but its digest ≠ recorded → BLOCK.
 *  - `stale`          — `snapshot_coord` diverged (gitHead/treeDigest) → BLOCK.
 *  - `legacy`         — a grandfathered backfill stamp → gate ACCEPTS, ungrounded-legacy.
 *  - `valid`          — present, non-legacy, in-process/attested receipt whose content
 *                       passes (referent resolves + matches, not stale). The gate ACCEPTS.
 *  - `valid-grounded` — slice-1b: an EXTERNAL keyed receipt whose signature verifies AND
 *                       whose content passes. The gate ACCEPTS (stronger form of `valid`).
 *  - `forged`         — slice-1b: a receipt CLAIMS `producer_kind:"external"` but no
 *                       external candidate's signature verifies → BLOCK.
 */
export type RealizationValidationStatus =
  | "absent"
  | "tampered"
  | "target_missing"
  | "target_mismatch"
  | "stale"
  | "legacy"
  | "valid"
  | "valid-grounded"
  | "forged";

/** The validated receipt + its status (and any staleness reasons). */
export interface ValidatedRealization {
  status: RealizationValidationStatus;
  /** The latest receipt found for the REQ-ID; omitted on `absent`. */
  receipt?: RealizationReceipt;
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
 * Apply the CONTENT checks to a present, non-legacy receipt, returning a pass/fail status.
 * On PASS the caller-supplied `passStatus` is returned (`valid` in-process / `valid-grounded`
 * external). On FAIL the specific token (`target_missing`/`target_mismatch`/`stale`) —
 * IDENTICAL discrimination for both producer kinds.
 */
function classifyRealizationContent(
  paths: ProjectPaths,
  receipt: RealizationReceipt,
  passStatus: "valid" | "valid-grounded",
): ValidatedRealization {
  const recordedPath = receipt.referent.path;
  const recordedDigest = receipt.referent.digest;
  const currentDigest = computeTargetDigest(paths.root, recordedPath);
  if (currentDigest === null) return { status: "target_missing", receipt };
  if (currentDigest !== recordedDigest) return { status: "target_mismatch", receipt };

  const staleReasons = snapshotStaleReasons(receipt.snapshot_coord, currentReceiptSnapshotCoord(paths));
  if (staleReasons.length > 0) return { status: "stale", receipt, staleReasons };

  return { status: passStatus, receipt };
}

/**
 * True iff a receipt CLAIMS to be external/signed — i.e. it carries EITHER a `signature`
 * trailer OR a `key_id`. Such a receipt MUST prove itself with a verifying Ed25519
 * signature; a claim that fails verification is `forged`.
 */
function claimsExternal(r: RealizationReceipt): boolean {
  return typeof r.signature === "string" || typeof r.key_id === "string";
}

/** Verify a realization receipt's Ed25519 signature against the loaded external public key. */
function signatureVerifies(receipt: RealizationReceipt): boolean {
  const publicKey = loadExternalPublicKey();
  if (publicKey === null) return false;
  if (typeof receipt.signature !== "string") return false;
  if (receipt.key_id !== externalKeyId(publicKey)) return false;
  const { recordHash: _rh, signature: _sig, ...signedView } = receipt;
  return verifyCanonical(realizationCanonicalText(signedView), receipt.signature, publicKey);
}

/**
 * Validate the receipt backing a realization claim for `reqId` (plan Lane 1 step 4). Reads
 * BOTH stores — the in-process `realization-receipts.jsonl` AND the external store — and
 * gathers every candidate matching `reqId`. Mirrors `readReceiptValidated` precedence
 * EXACTLY: external decisive (verify-or-`forged`) → in-process `valid` → `legacy`
 * grandfather → block set.
 */
export function readRealizationReceiptValidated(
  paths: ProjectPaths,
  reqId: string,
): ValidatedRealization {
  const matches = (r: RealizationReceipt): boolean => r.req_id === reqId;
  const inProcessReceipts = readRealizationReceipts(paths);
  if (!verifyRealizationChain(inProcessReceipts).ok) return { status: "tampered" };
  // LATEST in-process candidate in file order (a re-realize mints a newer receipt).
  let inProcess: RealizationReceipt | undefined;
  for (const r of inProcessReceipts) {
    if (matches(r)) inProcess = r;
  }
  // ALL external candidates claiming this reqId. The external chain is walked ONCE here:
  // a tampered external chain is fail-closed (do not trust any external line) — a present
  // external CLAIM below then cannot verify and forces `forged`, never a silent downgrade.
  const externalReceipts = readExternalRealizationReceipts(paths);
  const externalChainOk = verifyRealizationChain(externalReceipts).ok;
  const externalCandidates = externalReceipts.filter((r) => matches(r) && claimsExternal(r));

  // (1) An external CLAIM exists → it must PROVE itself with a verifying signature.
  if (externalCandidates.length > 0) {
    const publicKey = loadExternalPublicKey();
    if (publicKey !== null && externalChainOk) {
      // The LAST verifying external candidate in file order (a re-mint wins).
      let verified: RealizationReceipt | undefined;
      for (const cand of externalCandidates) {
        if (signatureVerifies(cand)) verified = cand;
      }
      if (verified) {
        if (verified.legacy === true) return { status: "legacy", receipt: verified };
        return classifyRealizationContent(paths, verified, "valid-grounded");
      }
    }
    // No external candidate verified (key absent, chain broken, or all signatures bad) → forged.
    return { status: "forged", receipt: externalCandidates[externalCandidates.length - 1] };
  }

  // (2) No external claim → the in-process classification on the latest line.
  if (!inProcess) {
    // absent-classification / migration: pre-upgrade ⇒ legacy; migrated-baseline ⇒ legacy;
    // migrated + not in baseline ⇒ absent → BLOCK.
    if (!realizationMigrationDone(paths)) return { status: "legacy" };
    if (grandfatheredRealizationBaseline(paths).has(reqId)) return { status: "legacy" };
    return { status: "absent" };
  }
  if (inProcess.legacy === true) return { status: "legacy", receipt: inProcess };
  return classifyRealizationContent(paths, inProcess, "valid");
}

// ---------------------------------------------------------------------------
// Migration / grandfather — idempotent, resume-safe
// ---------------------------------------------------------------------------

/** `<stateDir>/.realization-receipts-migration` — the migration marker file. */
function migrationMarkerPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, ".realization-receipts-migration");
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
 * True once {@link ensureRealizationMigration} has run for this project (the marker file is
 * present + well-shaped). The gate's absent-classification keys on this to tell "genuinely
 * pre-upgrade" (no marker → grandfather implicitly) from "post-upgrade bypass" (marker
 * present, REQ not in baseline → BLOCK).
 */
export function realizationMigrationDone(paths: ProjectPaths): boolean {
  return readMigrationMarker(paths) !== undefined;
}

/**
 * The grandfathered baseline REQ-ID set captured at migration time. Empty when not yet
 * migrated. These REQs were already owned by `done` slices BEFORE the receipt regime
 * began, so an absent receipt for them is grandfathered (`legacy`) rather than a bypass.
 */
export function grandfatheredRealizationBaseline(paths: ProjectPaths): Set<string> {
  const marker = readMigrationMarker(paths);
  return new Set(marker ? marker.baseline : []);
}

/**
 * Idempotent, marker-guarded migration. MUST be called holding the state lock (it appends
 * receipts + writes the marker). On the FIRST call it stamps a `legacy:true` receipt for
 * every REQ-ID currently owned by a `done` slice that lacks ANY receipt, then writes the
 * marker recording the full grandfathered baseline REQ-ID set. A re-run is a no-op (the
 * marker is present).
 *
 * Double-stamp guard: even within the first run, a REQ that ALREADY has a receipt (scanning
 * the receipts file) is skipped — so a partial prior run, or a real receipt minted before
 * migration, is never double-stamped. The marker is written LAST, so a crash mid-stamp
 * leaves no marker and the next run re-attempts (the guard makes the retry safe).
 */
export function ensureRealizationMigration(
  paths: ProjectPaths,
  state: TwinHarnessState,
  map: RepoMap | null,
): void {
  if (realizationMigrationDone(paths)) return;
  const owned = map === null ? [] : ownedReqsForDoneSlices(map, state);

  // The REQ-IDs that already have ANY receipt — so we never double-stamp.
  const existing = new Set<string>();
  for (const r of readRealizationReceipts(paths)) existing.add(r.req_id);

  for (const o of owned) {
    if (existing.has(o.reqId)) continue;
    appendLegacyRealizationReceipt(paths, o.reqId, o.owningSlices[0] ?? "");
    existing.add(o.reqId);
  }

  const baseline = owned.map((o) => o.reqId);
  const marker: MigrationMarker = { migratedAt: new Date().toISOString(), baseline };
  assertGovernedWriteSurface(paths.root, migrationMarkerPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(migrationMarkerPath(paths), JSON.stringify(marker), "utf8");
}

/**
 * SELF-LOCKING opportunistic grandfather stamp — the fail-open closure (team-fix #8).
 *
 * THE WINDOW IT CLOSES: {@link ensureRealizationMigration} is otherwise stamped ONLY at the
 * `th slice set-status … done` transition (`commands/slices.ts`). A project that reaches a
 * `done` slice via ANY OTHER path — an `--emergency` raw `state set`, an imported/pre-existing
 * state file, a state hand-edited then adopted — never stamps the marker. With no marker,
 * {@link readRealizationReceiptValidated} grandfathers EVERY REQ as `legacy`, so the
 * realization rung silently never enforces (a fail-open: the gate that exists to catch an
 * unbacked done-slice REQ would pass it). This stamps the baseline the FIRST time the GATE
 * observes a `done` slice, regardless of how that slice became done — the gate is the
 * universal chokepoint every completion path funnels through.
 *
 * SAFE FROM A READER: the gate (`checkProductionReality`) is a PURE READER invoked from
 * surfaces that do NOT hold the state lock (`th gate production-reality`, `th next`, the
 * stop-gate, the MCP gate tools). This therefore takes its OWN `withStateLock` span — it must
 * NOT be called from a context already holding the lock (`withStateLock` is a non-reentrant
 * mkdir mutex; the slice→done path already holds it and calls the UN-locked
 * {@link ensureRealizationMigration} directly). It is a ONE-TIME write: after the first stamp
 * the marker fast-path returns WITHOUT locking, so the lock is taken at most once per project.
 *
 * It only stamps when a `done` slice actually exists (mirrors the slice→done trigger's
 * semantics: the obligation begins when the first done slice appears) — a project with no done
 * slices is left un-stamped so its baseline is not frozen empty before the regime is relevant.
 * Best-effort + fail-soft: a lock-timeout / read failure does NOT throw into the gate (the
 * gate then sees no marker and grandfathers `legacy` for this run — the SAME pre-fix posture,
 * never a crash; the next gate observation re-attempts the stamp).
 */
export function ensureRealizationMigrationOpportunistic(paths: ProjectPaths): void {
  if (realizationMigrationDone(paths)) return; // fast-path: already stamped, no lock

  const r = readState(paths);
  if (!r.exists || !r.state) return; // not an initialized project → nothing to grandfather
  const state = r.state;
  if (doneSlices(state).length === 0) return; // no done slice yet → obligation not live

  try {
    withStateLock(paths, () => {
      // Re-check UNDER the lock: another writer (or the slice→done path) may have stamped
      // between the unlocked fast-path and acquiring the lock. The marker write is the
      // single source of truth; this guard makes the stamp idempotent across racers.
      if (realizationMigrationDone(paths)) return;
      const fresh = readState(paths);
      if (!fresh.exists || !fresh.state) return;
      if (doneSlices(fresh.state).length === 0) return;
      ensureRealizationMigration(paths, fresh.state, loadRepoMapForRealization(paths));
    });
  } catch {
    // Fail-soft: never let a lock-timeout / transient write error crash the gate. The marker
    // simply stays unstamped for this observation (legacy-grandfathered, the pre-fix posture)
    // and the NEXT gate observation re-attempts — the stamp is idempotent + resume-safe.
  }
}
