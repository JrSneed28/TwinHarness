/**
 * External-reference grounding sensor + receipt store + the work-class classifier and the
 * sibling external-signed budget/exception/carve-out stores (Axis-B slice-BSC10a / BSC-10).
 *
 * THE BLIND SPOT: TwinHarness can mint downstream realization (BSC-1) but has NO mechanical
 * record that the real EXTERNAL reference a piece of work was supposed to match — a pinned
 * dependency version, a content/symbol manifest, a rendered surface — was ACTUALLY CHECKED.
 * "We grounded against the reference" is asserted with no recomputable correspondence. This
 * module is the upstream input-grounding counterpart to BSC-1: it derives the recomputable
 * computable ground for a piece of work and mints a schema-registered {@link GroundingReceipt}
 * whose ground is re-derivable at gate time, so a work-class that REQUIRES a grounding kind but
 * carries none (or an over-budget / unobserved one) is mechanically detectable.
 *
 * Storage mirrors `src/core/assertion-presence.ts` / `src/core/realization.ts` EXACTLY: a
 * DEDICATED, lock-isolated append-only SHA-256 hash-chained `<stateDir>/grounding-receipts.jsonl`,
 * a tolerant reader that never throws, a tail-scan for the next `prevHash`, an atomic-append
 * writer that runs under the CALLER's `withStateLock` span, and a tamper-detecting chain walk.
 * The external producer's store is a SEPARATE lock-isolated `<stateDir>/external-grounding-
 * receipts.jsonl` (parallel to the external driver/mutation stores) — the out-of-process keyed
 * producer (Slice B) appends there without taking the in-process lock; the security boundary is
 * the private key, not the path.
 *
 * THE SIGNED SIBLING STORES (PCC-4): the conformance BUDGETS, the `SignedException`s, and the
 * permitted-difference CARVE-OUTs are NOT receipt fields — they live in three sibling external-
 * signed stores (`grounding-budgets.jsonl` / `grounding-exceptions.jsonl` / `grounding-
 * carveouts.jsonl`), modeled symbol-for-symbol on `assertion-waivers.jsonl` and `scan-exceptions`.
 * In slice-BSC10a these stores carry a SCHEMA + a TOLERANT READER ONLY — there is NO in-process
 * producer (an agent cannot self-sign its own budget — 3-party authority), and an UNSIGNED /
 * wrong-key line exempts NOTHING (fail-closed M4: the gate treats the required ground as
 * ungrounded/over-budget, never a passing budget). The Slice-B Ed25519 producer fills them.
 *
 * BINDING CONTRACT (mirrors the BSC-2 sensor determinism rule): the ground serialization is
 * DETERMINISTIC — every nested object is re-emitted in a FIXED key order, `entries[]` are sorted
 * lexically by POSIX-normalized `path`, `conformance[]` is sorted by `metric`, NO clock / NO
 * random / NO `Date` in any canonical text. There is NO `typescript`/AST/renderer/axe runtime
 * dependency: `visual-hash` + `a11y` MEASUREMENT is a documented STUB that emits
 * `conformance: unobserved` (fail-closed under forced enforce; real measurement is Slice C).
 *
 * `producer_identity` carries ZERO trust weight in-process; the genuine un-forgeable property is
 * the Slice-B external Ed25519 signature (a write-surface TwinHarness cannot reach). Absence ≠
 * forgery: an in-process-only grounding receipt is `ungrounded` where a kind is required, NEVER
 * `forged` (mirrors `valid` vs `valid-grounded` in `receipts.ts`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { KeyObject } from "node:crypto";
import type { ProjectPaths } from "./paths";
import { assertGovernedWriteSurface } from "./paths";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";
import { readJsonlValues, scanTailValid } from "./jsonl";
import {
  type GroundKind,
  type GroundingGround,
  type GroundingReceipt,
  type ConformanceMetric,
  type SnapshotCoord,
  currentReceiptSnapshotCoord,
} from "./receipts";
import { externalKeyId, loadExternalPublicKey, verifyCanonical } from "./receipt-signing";

// Re-export the schema types so the gate + the Slice-B producer import the grounding surface
// from ONE module (mirrors the assertion-presence re-export header).
export type {
  GroundKind,
  GroundingGround,
  GroundingReceipt,
  ConformanceMetric,
  DigestManifestGround,
  VersionPinGround,
  VisualHashGround,
} from "./receipts";

const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

// ---------------------------------------------------------------------------
// Work-class → required-ground-kinds classifier (the fixed matrix + the rules)
// ---------------------------------------------------------------------------

/**
 * The fixed, ratified work-class → required-ground-kinds matrix (spec R2; gap 9 maps the spec's
 * `digest` shorthand → the schema literal `"digest-manifest"`). One row per ground-bearing
 * work-class; `pure-greenfield` is INERT (empty required-set ⇒ the gate is not-required/PASS).
 * A `greenfield+dep` (a greenfield with declared dependencies) requires a `version-pin` per the
 * UX/dep rules below. Frozen so producer and validator can never drift on what a class requires.
 */
const WORK_CLASS_GROUND_MATRIX: Readonly<Record<string, ReadonlyArray<GroundKind>>> = {
  redesign: ["digest-manifest", "visual-hash"],
  recreation: ["digest-manifest", "visual-hash", "version-pin"],
  integration: ["digest-manifest", "version-pin"],
  migration: ["version-pin", "digest-manifest"],
  "greenfield+dep": ["version-pin"],
  greenfield: [],
};

/**
 * The surface labels that FORCE a `visual-hash` requirement regardless of the declared work-class
 * (spec R2: label ≠ surface). An interactive/screen/TUI surface is grounded visually even when a
 * task is labelled "CLI": the LABEL is the agent's claim, the SURFACE is the observable fact.
 */
const UX_SURFACE_LABELS: ReadonlySet<string> = new Set(["ux", "ui", "tui", "screen", "interactive", "visual"]);

/** True iff any of `surfaces` is a UX/screen surface that forces a `visual-hash` ground. */
function hasUxSurface(surfaces: ReadonlyArray<string>): boolean {
  return surfaces.some((s) => UX_SURFACE_LABELS.has(s.trim().toLowerCase()));
}

/**
 * The classifier result: the required ground-kinds for a work-class + its surfaces, PLUS any
 * cross-check conflict flag. The flag literal `"class-cross-check-mismatch"` is surfaced (never
 * silently resolved) so the human ratifies the declared-vs-derived class divergence at BSC-7.
 */
export interface RequiredGroundKinds {
  /** The required ground-kinds (lexically sorted, de-duplicated). Empty ⇒ not-required/inert. */
  required: GroundKind[];
  /**
   * `"class-cross-check-mismatch"` when the declared class ≠ the evidence-derived class — the
   * gate then requires the STRICTER UNION of both classes' kinds (fail-closed, never under-
   * require) AND surfaces this flag for human ratification. Absent when declared === derived.
   */
  crossCheckFlag?: "class-cross-check-mismatch";
}

/**
 * The fixed work-class → required-ground-kinds resolution (spec R2 + the UX-surface force-rule +
 * the cross-check conflict rule). `workClass` is the DECLARED class; `surfaces` is the observed
 * surface set (which may force `visual-hash`); `derivedClass` is the OPTIONAL evidence-derived
 * class (the BSC-8-style cross-check). The rules, in order:
 *
 *  1. Base required-set = the matrix row for `workClass` (unknown class ⇒ empty, treated inert).
 *  2. UX-surface force-rule: a UX/screen surface FORCES `visual-hash` into the set for ANY class.
 *  3. Cross-check conflict rule: when `derivedClass` is supplied AND differs from `workClass`, the
 *     required-set becomes the STRICTER UNION of BOTH rows (fail-closed — never silently pick one)
 *     and `crossCheckFlag` is set so the human ratifies the divergence. Same class ⇒ no flag.
 *
 * The result is lexically sorted + de-duplicated so it is deterministic.
 */
export function requiredGroundKindsForWorkClass(
  workClass: string,
  surfaces: ReadonlyArray<string> = [],
  derivedClass?: string,
): RequiredGroundKinds {
  const set = new Set<GroundKind>(WORK_CLASS_GROUND_MATRIX[workClass] ?? []);

  // (2) UX-surface force-rule — a screen/interactive surface forces visual grounding.
  if (hasUxSurface(surfaces)) set.add("visual-hash");

  // (3) Cross-check conflict rule — declared ≠ derived ⇒ stricter union + a surfaced flag.
  let crossCheckFlag: "class-cross-check-mismatch" | undefined;
  if (derivedClass !== undefined && derivedClass !== "" && derivedClass !== workClass) {
    for (const k of WORK_CLASS_GROUND_MATRIX[derivedClass] ?? []) set.add(k);
    crossCheckFlag = "class-cross-check-mismatch";
  }

  const required = [...set].sort();
  return crossCheckFlag ? { required, crossCheckFlag } : { required };
}

// ---------------------------------------------------------------------------
// Ground serialization + digest (deterministic, byte-stable — sort+POSIX-normalize)
// ---------------------------------------------------------------------------

/** Canonical key order for {@link SnapshotCoord} (byte-stable nested JSON). */
const SNAPSHOT_FIELD_ORDER: ReadonlyArray<keyof SnapshotCoord> = ["gitHead", "treeDigest"];

/** Re-emit a nested object in a fixed key order (deterministic JSON). */
function reorder<T extends object>(obj: T, order: ReadonlyArray<keyof T>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) out[key as string] = obj[key];
  return out;
}

/** POSIX-normalize a path (backslashes → forward slashes) so a Windows-captured entry is stable. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Canonical JSON of one computable ground, byte-stable regardless of object-key insertion order
 * or `entries[]` capture order. Each variant re-emits its fields in a FIXED order; a digest-
 * manifest's `entries` are POSIX-normalized + lexically sorted by `path` (the determinism axis);
 * `undefined` optionals are omitted (omit-when-absent so a digest-only ground is byte-identical).
 */
export function serializeGroundingGround(ground: GroundingGround): string {
  switch (ground.groundKind) {
    case "digest-manifest": {
      const ordered: Record<string, unknown> = {
        groundKind: ground.groundKind,
        manifestDigest: ground.manifestDigest,
      };
      if (ground.entries !== undefined) {
        ordered.entries = [...ground.entries]
          .map((e) => ({ path: toPosix(e.path), digest: e.digest }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      }
      return JSON.stringify(ordered);
    }
    case "version-pin": {
      return JSON.stringify({ groundKind: ground.groundKind, pkg: ground.pkg, version: ground.version });
    }
    case "visual-hash": {
      const ordered: Record<string, unknown> = {
        groundKind: ground.groundKind,
        perceptualHash: ground.perceptualHash,
      };
      if (ground.renderer !== undefined) ordered.renderer = ground.renderer;
      return JSON.stringify(ordered);
    }
  }
}

/** Content digest of a computable ground = SHA-256 of its canonical serialization. */
export function groundingGroundDigest(ground: GroundingGround): string {
  return hashContent(serializeGroundingGround(ground));
}

/** Canonical key order for one {@link ConformanceMetric} (byte-stable nested JSON). */
const CONFORMANCE_FIELD_ORDER: ReadonlyArray<keyof ConformanceMetric> = ["metric", "observed", "status"];

/** Re-emit the conformance metrics in a deterministic order (sorted by `metric`, fixed key order). */
function serializeConformance(conformance: ReadonlyArray<ConformanceMetric>): Record<string, unknown>[] {
  return [...conformance]
    .sort((a, b) => (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0))
    .map((m) => reorder(m, CONFORMANCE_FIELD_ORDER));
}

// ---------------------------------------------------------------------------
// GroundingReceipt — canonical text + hashing (mirrors assertion-presence.ts)
// ---------------------------------------------------------------------------

/**
 * The fixed canonical field order for hashing/signing a {@link GroundingReceipt}. `signature`
 * and `recordHash` are EXCLUDED trailers (computed over the IDENTICAL canonical input, so a
 * Slice-B signature covers every signed field). `undefined` keys are dropped (so an in-process
 * receipt with all the honesty/signing optionals absent is byte-stable); the `ground` re-emits
 * via {@link serializeGroundingGround}'s element ordering, the `conformance` via the sorted
 * fixed-key order, and the snapshot in its fixed key order.
 */
const GROUNDING_CANONICAL_FIELD_ORDER: ReadonlyArray<keyof GroundingReceipt> = [
  "kind",
  "refId",
  "workClass",
  "ground",
  "conformance",
  "snapshot_coord",
  "producer_identity",
  "fidelityTier",
  "diffBand",
  "legacy",
  "producer_kind",
  "key_id",
  "prevHash",
];

/**
 * Deterministic canonical text of a grounding receipt for hashing/signing. Field order is fixed;
 * `undefined` keys, `recordHash`, and `signature` are dropped; the `ground` is re-emitted via the
 * deterministic ground serializer, the `conformance` via its sorted fixed-key serializer, and the
 * snapshot in its fixed key order; `JSON.stringify` with no indentation. `hashContent` then
 * CRLF→LF normalizes (harmless). A receipt with every optional absent produces byte-identical text.
 */
export function groundingCanonicalText(receipt: Omit<GroundingReceipt, "recordHash">): string {
  const ordered: Record<string, unknown> = {};
  for (const key of GROUNDING_CANONICAL_FIELD_ORDER) {
    const val = (receipt as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (key === "ground") {
      // Re-emit the ground deterministically by round-tripping through the canonical serializer.
      ordered[key] = JSON.parse(serializeGroundingGround(val as GroundingGround));
    } else if (key === "conformance") {
      ordered[key] = serializeConformance(val as ConformanceMetric[]);
    } else if (key === "snapshot_coord") {
      ordered[key] = reorder(val as SnapshotCoord, SNAPSHOT_FIELD_ORDER);
    } else {
      ordered[key] = val;
    }
  }
  return JSON.stringify(ordered);
}

/** `recordHash` for a grounding receipt = SHA-256 of its canonical text (signature excluded). */
export function computeGroundingRecordHash(receipt: Omit<GroundingReceipt, "recordHash">): string {
  return hashContent(groundingCanonicalText(receipt));
}

// ---------------------------------------------------------------------------
// Store paths (in-process + external + the three sibling external-signed stores)
// ---------------------------------------------------------------------------

/** `<stateDir>/grounding-receipts.jsonl` — the in-process grounding ledger. */
export function groundingReceiptsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "grounding-receipts.jsonl");
}

/**
 * `<stateDir>/external-grounding-receipts.jsonl` — the EXTERNAL keyed producer's store (Slice B).
 * A SEPARATE file for LOCK-ISOLATION (parallel to `external-mutation-receipts.jsonl`): the
 * out-of-process producer appends here without taking the in-process `withStateLock` span. The
 * SECURITY boundary is NOT this path — it is the private key; a forged line is rejected by the
 * gate validator (no verifying signature ⇒ `ungrounded`, never trusted).
 */
export function externalGroundingReceiptsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "external-grounding-receipts.jsonl");
}

/** `<stateDir>/grounding-budgets.jsonl` — the EXTERNAL-signed conformance-budget store (PCC-4). */
export function groundingBudgetsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "grounding-budgets.jsonl");
}

/** `<stateDir>/grounding-exceptions.jsonl` — the EXTERNAL-signed SignedException store (PCC-4). */
export function groundingExceptionsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "grounding-exceptions.jsonl");
}

/** `<stateDir>/grounding-carveouts.jsonl` — the EXTERNAL-signed permitted-difference store (PCC-4). */
export function groundingCarveoutsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "grounding-carveouts.jsonl");
}

// ---------------------------------------------------------------------------
// GroundingReceipt — shape validation + tolerant readers
// ---------------------------------------------------------------------------

/** Tolerant shape check for a parsed computable ground (each variant's required fields). */
function isValidGround(parsed: unknown): parsed is GroundingGround {
  if (typeof parsed !== "object" || parsed === null) return false;
  const g = parsed as Record<string, unknown>;
  switch (g.groundKind) {
    case "digest-manifest": {
      if (typeof g.manifestDigest !== "string" || g.manifestDigest === "") return false;
      if (g.entries !== undefined) {
        if (!Array.isArray(g.entries)) return false;
        for (const e of g.entries) {
          if (typeof e !== "object" || e === null) return false;
          const em = e as Record<string, unknown>;
          if (typeof em.path !== "string" || typeof em.digest !== "string") return false;
        }
      }
      return true;
    }
    case "version-pin":
      return typeof g.pkg === "string" && g.pkg !== "" && typeof g.version === "string" && g.version !== "";
    case "visual-hash":
      return (
        typeof g.perceptualHash === "string" &&
        g.perceptualHash !== "" &&
        (g.renderer === undefined || typeof g.renderer === "string")
      );
    default:
      return false;
  }
}

/** Tolerant shape check for one parsed conformance metric. */
function isValidConformanceMetric(parsed: unknown): parsed is ConformanceMetric {
  if (typeof parsed !== "object" || parsed === null) return false;
  const m = parsed as Record<string, unknown>;
  if (m.metric !== "version" && m.metric !== "api" && m.metric !== "visual" && m.metric !== "a11y") return false;
  // A numeric `observed` must be FINITE (mirrors the `isValidGroundingBudget` threshold guard) so a
  // non-finite value can never reach the C4c `observed > threshold` arithmetic as a numeric input.
  if (typeof m.observed === "number") {
    if (!Number.isFinite(m.observed)) return false;
  } else if (typeof m.observed !== "string") return false;
  if (m.status !== "within-budget" && m.status !== "over-budget" && m.status !== "unobserved") return false;
  return true;
}

/** Validate the shape of a parsed grounding line; malformed/cross-shaped lines are skipped (tolerant). */
export function isValidGroundingReceipt(parsed: unknown): parsed is GroundingReceipt {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (r.kind !== "grounding") return false;
  if (typeof r.refId !== "string" || r.refId === "") return false;
  if (typeof r.workClass !== "string" || r.workClass === "") return false;
  if (typeof r.producer_identity !== "string") return false;
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  if (!isValidGround(r.ground)) return false;
  if (!Array.isArray(r.conformance) || !r.conformance.every(isValidConformanceMetric)) return false;
  // Optional honesty fields — present ⇒ well-shaped, absent ⇒ byte-stable. (The evidence-spine
  // `manifest_digest` thread lives on the BSC-1/3/7 receipts, NOT here — a GroundingReceipt carries
  // its digest inside `ground` via DigestManifestGround.manifestDigest.)
  if (r.fidelityTier !== undefined && typeof r.fidelityTier !== "string") return false;
  if (r.diffBand !== undefined && typeof r.diffBand !== "string") return false;
  if (r.legacy !== undefined && typeof r.legacy !== "boolean") return false;
  // Optional signing trailer (Slice-B). A present-but-malformed field tolerant-skips the line.
  if (r.producer_kind !== undefined && r.producer_kind !== "external" && r.producer_kind !== "in-process") return false;
  if (r.key_id !== undefined && typeof r.key_id !== "string") return false;
  if (r.signature !== undefined && (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))) {
    return false;
  }
  // Snapshot coordinate must be present + shaped.
  const snap = r.snapshot_coord;
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (!(s.gitHead === null || typeof s.gitHead === "string")) return false;
  if (!(s.treeDigest === null || typeof s.treeDigest === "string")) return false;
  return true;
}

/**
 * Read + parse every grounding receipt in the in-process store, in file order. Missing file →
 * `[]`. Bad lines are silently skipped — tolerant, never throws. Chain breaks surface via
 * {@link verifyGroundingChain}.
 */
export function readGroundingReceipts(paths: ProjectPaths): GroundingReceipt[] {
  return readJsonlValues(groundingReceiptsPath(paths), isValidGroundingReceipt);
}

/**
 * Read + parse every grounding receipt in the EXTERNAL store, in file order. Missing file → `[]`.
 * Bad lines skipped — tolerant, never throws. The signature is verified at gate time, NOT here.
 */
export function readExternalGroundingReceipts(paths: ProjectPaths): GroundingReceipt[] {
  return readJsonlValues(externalGroundingReceiptsPath(paths), isValidGroundingReceipt);
}

/**
 * The `recordHash` of the in-process store's last VALID grounding receipt — the `prevHash` seed
 * {@link appendGroundingReceipt} needs to seal the next link. Tail-scans the file so N appends
 * stay O(N) total. Missing/empty/no-valid-tail → `GENESIS_PREV_HASH`.
 */
export function readLastGroundingRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(groundingReceiptsPath(paths), isValidGroundingReceipt);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

/**
 * The `recordHash` of the EXTERNAL store's last valid grounding receipt — the `prevHash` seed for
 * the Slice-B producer's own append-only chain. Missing/empty/no-valid-tail → `GENESIS_PREV_HASH`.
 */
export function readLastExternalGroundingRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(externalGroundingReceiptsPath(paths), isValidGroundingReceipt);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

export type VerifyChainResult =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: "edited" | "prev_mismatch" };

/**
 * Walk grounding receipts in file order with a running `expectedPrev = GENESIS`. For each:
 * recompute `recordHash` from its canonical text — a mismatch means the record was edited; if
 * `prevHash !== expectedPrev` the line was inserted/deleted/reordered. Return
 * `{ ok:false, brokenAt:N }` at the FIRST break; else advance. Byte-identical posture to
 * `verifyAssertionPresenceChain`.
 */
export function verifyGroundingChain(receipts: GroundingReceipt[]): VerifyChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    const { recordHash, signature: _sig, ...rest } = r;
    const recomputed = computeGroundingRecordHash(rest);
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
// GroundingReceipt — producer API (caller already holds withStateLock)
// ---------------------------------------------------------------------------

/** Input to {@link appendGroundingReceipt}. */
export interface MintGroundingInput {
  /** The work-class this grounding receipt is minted for (drives the required-ground matrix). */
  workClass: string;
  /** The discriminated computable ground (digest-manifest / version-pin / visual-hash). */
  ground: GroundingGround;
  /** The typed conformance metrics (fail-closed on `unobserved`). Defaults to `[]`. */
  conformance?: ConformanceMetric[];
  /** Self-asserted producer identity (zero in-process trust weight). */
  producerIdentity: string;
  /** Optional fidelity tier the ground was captured at (`tight`/`medium`/`loose`). */
  fidelityTier?: string;
  /** Optional conformance diff-band label. */
  diffBand?: string;
}

/**
 * Append one in-process grounding receipt, sealing the hash chain. The caller MUST already hold
 * the `withStateLock` span (read-modify-append is serialized there), exactly like
 * `appendAssertionPresenceReceipt`. The receipt records the supplied ground + conformance + the
 * current snapshot coordinate, derives `prevHash` from the tail, computes `recordHash`, asserts
 * the write-surface, and atomically appends. In-process-only (no signing fields). Returns the
 * sealed receipt.
 */
export function appendGroundingReceipt(paths: ProjectPaths, input: MintGroundingInput): GroundingReceipt {
  const receipt: Omit<GroundingReceipt, "prevHash" | "recordHash"> = {
    kind: "grounding",
    refId: groundingRefId(paths),
    workClass: input.workClass,
    ground: input.ground,
    conformance: input.conformance ?? [],
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: input.producerIdentity,
    ...(input.fidelityTier !== undefined ? { fidelityTier: input.fidelityTier } : {}),
    ...(input.diffBand !== undefined ? { diffBand: input.diffBand } : {}),
  };
  assertGovernedWriteSurface(paths.root, groundingReceiptsPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const prevHash = readLastGroundingRecordHash(paths);
  const withPrev: Omit<GroundingReceipt, "recordHash"> = { ...receipt, prevHash };
  const recordHash = computeGroundingRecordHash(withPrev);
  const sealed: GroundingReceipt = { ...withPrev, recordHash };
  fs.appendFileSync(groundingReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

/**
 * The run identity a fresh receipt grounds: the current `gitHead`, or `"no-git"` on a non-git
 * checkout — so a re-run at a new HEAD mints a receipt under a new refId and the gate finds the
 * LATEST receipt for the current snapshot (mirrors `assertionRefId`).
 */
function groundingRefId(paths: ProjectPaths): string {
  return currentReceiptSnapshotCoord(paths).gitHead ?? "no-git";
}

// ---------------------------------------------------------------------------
// GroundingReceipt — content validation (recompute-don't-trust)
// ---------------------------------------------------------------------------

/**
 * The content-validation status of a grounding receipt's GROUND, independent of the gate's
 * higher-level required/missing/over-budget classification (which the gate owns):
 *  - `target_mismatch` — the recorded ground's digest ≠ a fresh recompute would expect (RESERVED;
 *                        the digest-thread recompute is wired in Slice B — in slice-BSC10a the
 *                        receipt's own ground is internally consistent so this is not emitted).
 *  - `stale`           — the recorded `snapshot_coord` diverged (gitHead/treeDigest).
 *  - `unobserved`      — at least one conformance metric is `unobserved` (fail-closed under
 *                        forced enforce — never a silent pass).
 *  - `over-budget`     — at least one conformance metric is `over-budget`.
 *  - `valid`           — every conformance metric is `within-budget` and the snapshot matches.
 */
export type GroundingContentStatus = "target_mismatch" | "stale" | "unobserved" | "over-budget" | "valid";

/** The content-validation outcome + diagnostics. */
export interface GroundingContentValidation {
  status: GroundingContentStatus;
  /** On `stale`: which coordinate(s) diverged (`gitHead` / `treeDigest`). */
  staleReasons?: string[];
  /** The conformance metric names that are `unobserved` (lexically sorted). */
  unobservedMetrics?: string[];
  /** The conformance metric names that are `over-budget` (lexically sorted). */
  overBudgetMetrics?: string[];
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
  if (recorded.treeDigest !== null && current.treeDigest !== null && recorded.treeDigest !== current.treeDigest) {
    reasons.push("treeDigest");
  }
  return reasons;
}

/**
 * Classify a grounding receipt's CONTENT (tolerant — never throws). The conformance verdict is
 * fail-closed: ANY `unobserved` metric ⇒ `unobserved` (the highest-precedence soft-fail, so a
 * stubbed visual/a11y measurement blocks under forced enforce); else ANY `over-budget` metric ⇒
 * `over-budget`; else a diverged snapshot ⇒ `stale`; else `valid`. The unobserved/over-budget
 * metric names ride on the result for the gate's diagnostics.
 */
export function validateGroundingContent(
  paths: ProjectPaths,
  receipt: GroundingReceipt,
): GroundingContentValidation {
  const unobservedMetrics = receipt.conformance
    .filter((m) => m.status === "unobserved")
    .map((m) => m.metric)
    .sort();
  const overBudgetMetrics = receipt.conformance
    .filter((m) => m.status === "over-budget")
    .map((m) => m.metric)
    .sort();

  if (unobservedMetrics.length > 0) return { status: "unobserved", unobservedMetrics };
  if (overBudgetMetrics.length > 0) return { status: "over-budget", overBudgetMetrics };

  // Stale dimension (F8 honesty): a recorded coordinate is NON-DISCRIMINATING unless it actually
  // carries a value. A receipt with NO meaningful coordinate — `snapshot_coord` null/undefined, OR
  // a `{ gitHead: null, treeDigest: null }` object — has nothing to be stale AGAINST, so it must
  // not be spuriously flagged stale (and must not crash). Guard the whole branch so we ONLY call
  // `currentReceiptSnapshotCoord` (which throws on a path-less `paths`/empty coord) when at least
  // one recorded field is present. Loose `== null` covers both null and undefined fields. A
  // no-coord receipt ⇒ the stale dimension is satisfied (treated `valid`), exactly the documented
  // "snapshot_coord null ⇒ no stale" semantics.
  const recorded = receipt.snapshot_coord;
  const hasRecordedCoord = recorded != null && (recorded.gitHead != null || recorded.treeDigest != null);
  if (hasRecordedCoord) {
    const staleReasons = snapshotStaleReasons(recorded, currentReceiptSnapshotCoord(paths));
    if (staleReasons.length > 0) return { status: "stale", staleReasons };
  }

  return { status: "valid" };
}

/**
 * The validated grounding result the gate consumes: the LATEST in-process + external candidate
 * per ground-kind, plus the trust label. Reads BOTH stores. An EXTERNAL claim
 * (`producer_kind:"external"`) is decisive: a verifying external receipt ⇒ `valid-grounded`; an
 * unverifiable one ⇒ `ungrounded` (absence ≠ forgery — an unprovable independence claim is NEVER
 * `forged` here, it simply does not count as grounded). An in-process receipt ⇒ `valid`
 * (attribution-only). No candidate for a kind ⇒ `absent`.
 */
export interface ValidatedGrounding {
  /** Per-ground-kind validated entry (the LATEST candidate the gate trusts for that kind). */
  byKind: Map<GroundKind, { receipt: GroundingReceipt; trustLabel: "valid" | "valid-grounded" }>;
  /** True iff the in-process chain verifies (a tampered chain trusts NOTHING from it). */
  inProcessChainOk: boolean;
  /**
   * True iff the EXTERNAL store's hash chain verifies (Slice B). A broken/reordered/duplicated
   * external chain trusts NOTHING from the external store — the same fail-closed posture as the
   * in-process M-1 path. Empty/missing external store verifies (`{ok:true}`), so absence stays
   * inert (absence ≠ forgery). Exposed for diagnostics + the external-chain negative control.
   */
  externalChainOk: boolean;
}

/** Verify a grounding receipt's Ed25519 signature against the loaded external public key. */
function groundingSignatureVerifies(receipt: GroundingReceipt, publicKey: KeyObject): boolean {
  if (typeof receipt.signature !== "string") return false;
  if (receipt.key_id !== externalKeyId(publicKey)) return false;
  const { recordHash: _rh, signature, ...signedView } = receipt;
  return verifyCanonical(groundingCanonicalText(signedView), signature, publicKey);
}

/**
 * Read + validate BOTH grounding stores and resolve, per ground-kind, the LATEST trusted
 * candidate (recompute-don't-trust posture). BOTH chains are walked once and BOTH fail closed:
 * a tampered IN-PROCESS chain trusts NOTHING from the in-process store (`inProcessChainOk:false`),
 * and a tampered EXTERNAL chain trusts NOTHING from the external store (`externalChainOk:false`).
 * For each kind, a signature-verified EXTERNAL receipt (`valid-grounded`) supersedes an in-process
 * one (`valid`); an external receipt that does NOT verify is simply ignored (ungrounded — absence ≠
 * forgery).
 *
 * EXTERNAL CHAIN INTEGRITY (Slice B — asymmetry CLOSED): the external store's hash chain is now
 * walked here with {@link verifyGroundingChain} (same prevHash-link + recordHash-recompute walk as
 * the in-process M-1 path). Each external line is ALSO verified independently by its own Ed25519
 * signature, BUT signature-validity alone does not establish CHAIN position: `prevHash` is inside
 * the signed canonical input, yet a party with file-write (but not the key) could otherwise REORDER
 * or DUPLICATE validly-signed lines to resurface a STALE signed grounding as the "latest per kind."
 * The chain walk closes that: a reorder/duplicate/edit breaks the `prevHash → prior recordHash`
 * linkage ⇒ `externalChainOk:false` ⇒ the external store is dropped wholesale (fail-closed,
 * symmetric with the in-process M-1 posture). A SINGLE validly-signed line is a trivial chain
 * (genesis `prevHash` + its own `recordHash`) and verifies. The COMPLEMENTARY cross-receipt
 * `manifest_digest` mismatch (a threaded BSC-1/3/7 digest disagreeing with the grounding manifest)
 * is enforced separately by the gate's `chain_mismatch` reason ({@link evaluateGrounding}).
 */
export function readGroundingValidated(paths: ProjectPaths): ValidatedGrounding {
  const inProcess = readGroundingReceipts(paths);
  const inProcessChainOk = verifyGroundingChain(inProcess).ok;

  // External chain integrity (Slice B): walk the external store's hash chain BEFORE trusting any of
  // its lines. A broken/reordered/duplicated chain ⇒ trust NOTHING from the external store (fail-
  // closed, mirroring the in-process M-1 posture). An empty/missing store verifies (`{ok:true}`).
  const external = readExternalGroundingReceipts(paths);
  const externalChainOk = verifyGroundingChain(external).ok;

  const byKind = new Map<GroundKind, { receipt: GroundingReceipt; trustLabel: "valid" | "valid-grounded" }>();

  // In-process candidates (attribution-only `valid`), only when the chain is intact.
  if (inProcessChainOk) {
    for (const r of inProcess) {
      byKind.set(r.ground.groundKind, { receipt: r, trustLabel: "valid" });
    }
  }

  // External candidates supersede when the external chain is intact AND their signature verifies
  // (independently grounded). A tampered external chain drops the whole store — a forged file-write
  // reorder/dup of validly-signed lines can no longer resurface a stale grounding.
  const publicKey = loadExternalPublicKey();
  if (externalChainOk && publicKey !== null) {
    for (const r of external) {
      if (r.producer_kind !== "external") continue;
      if (!groundingSignatureVerifies(r, publicKey)) continue; // unverifiable ⇒ ungrounded, ignore
      byKind.set(r.ground.groundKind, { receipt: r, trustLabel: "valid-grounded" });
    }
  }

  return { byKind, inProcessChainOk, externalChainOk };
}

// ---------------------------------------------------------------------------
// Sibling external-signed stores (PCC-4) — schema + TOLERANT READER ONLY (Slice A)
// ---------------------------------------------------------------------------
//
// These three stores carry the conformance BUDGETS, the SignedExceptions, and the permitted-
// difference CARVE-OUTs. In slice-BSC10a there is NO in-process producer (3-party authority: an
// agent cannot self-sign its own budget); the Slice-B Ed25519 producer fills them. The reader is
// SHAPE-ONLY + signature-aware at validation time: an UNSIGNED / wrong-key line exempts NOTHING
// (fail-closed M4), exactly like `validWaivedReqs` (`assertion-presence.ts`).

/**
 * One external-signed conformance budget: the maximum tolerance for a `(workClass, groundKind,
 * metric)` axis. `signature` + `recordHash` are EXCLUDED trailers. NOT agent-self-issuable — the
 * security boundary is the Ed25519 PRIVATE key held only by the external producer.
 */
export interface GroundingBudget {
  kind: "grounding-budget";
  /** The work-class this budget scopes (must be non-empty). */
  workClass: string;
  /** The ground-kind this budget scopes. */
  groundKind: GroundKind;
  /** The conformance metric this budget bounds. */
  metric: ConformanceMetric["metric"];
  /** The numeric budget threshold (e.g. max symbol-delta, max perceptual-diff, max a11y count). */
  threshold: number;
  /** The repository snapshot coordinate at sign time (audit context). */
  snapshot_coord: SnapshotCoord;
  /** ALWAYS `"external"` — there is no in-process producer. Part of the signed canonical input. */
  producer_kind: "external";
  /** Short, non-secret id of the public key that verifies this budget (`externalKeyId`). */
  key_id: string;
  /** Ed25519 signature over the canonical text (excluded trailer). Absent ⇒ exempts NOTHING. */
  signature?: string;
  /** SHA-256 hex (64) of the prior line's canonical text, or GENESIS for the first. */
  prevHash: string;
  /** SHA-256 hex (64) of THIS budget's canonical text (signature excluded). */
  recordHash: string;
}

/**
 * One external-signed SignedException that suspends exactly one `(workClass, groundKind)` ground's
 * budget under a stated reason (e.g. `"reference-unreachable"`). `signature` + `recordHash` are
 * EXCLUDED trailers. An UNSIGNED exception exempts NOTHING (fail-closed).
 */
export interface GroundingException {
  kind: "grounding-exception";
  /** The work-class this exception scopes (must be non-empty). */
  workClass: string;
  /** The ground-kind whose budget this exception suspends. */
  groundKind: GroundKind;
  /** The stated reason (audit; e.g. `"reference-unreachable"`). */
  reason: string;
  /** The repository snapshot coordinate at sign time. */
  snapshot_coord: SnapshotCoord;
  producer_kind: "external";
  key_id: string;
  signature?: string;
  prevHash: string;
  recordHash: string;
}

/**
 * One external-signed permitted-difference CARVE-OUT that masks a digest-scoped region from a
 * perceptual/visual diff (the permitted-difference escape valve). `signature` + `recordHash` are
 * EXCLUDED trailers. An UNSIGNED carve-out masks NOTHING (mirrors the unsigned-waiver rule).
 */
export interface GroundingCarveout {
  kind: "grounding-carveout";
  /** The work-class this carve-out scopes (must be non-empty). */
  workClass: string;
  /** The digest of the ground region this carve-out permits to differ (re-derivable, path-bound). */
  regionDigest: string;
  /** The stated reason (audit). */
  reason: string;
  /** The repository snapshot coordinate at sign time. */
  snapshot_coord: SnapshotCoord;
  producer_kind: "external";
  key_id: string;
  signature?: string;
  prevHash: string;
  recordHash: string;
}

/** Shared tolerant shape check for the snapshot coordinate + the external signing trailer. */
function hasValidExternalTrailer(r: Record<string, unknown>): boolean {
  if (r.producer_kind !== "external") return false;
  if (typeof r.key_id !== "string" || r.key_id === "") return false;
  if (r.signature !== undefined && (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))) {
    return false;
  }
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  const snap = r.snapshot_coord;
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (!(s.gitHead === null || typeof s.gitHead === "string")) return false;
  if (!(s.treeDigest === null || typeof s.treeDigest === "string")) return false;
  return true;
}

/** True iff `g` is one of the three ground-kind literals (shared sibling-store guard). */
function isGroundKindValue(g: unknown): g is GroundKind {
  return g === "digest-manifest" || g === "version-pin" || g === "visual-hash";
}

/** Tolerant shape check for a budget line (a malformed line is skipped, never trusted). */
export function isValidGroundingBudget(parsed: unknown): parsed is GroundingBudget {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (r.kind !== "grounding-budget") return false;
  if (typeof r.workClass !== "string" || r.workClass === "") return false;
  if (!isGroundKindValue(r.groundKind)) return false;
  if (r.metric !== "version" && r.metric !== "api" && r.metric !== "visual" && r.metric !== "a11y") return false;
  if (typeof r.threshold !== "number" || !Number.isFinite(r.threshold)) return false;
  return hasValidExternalTrailer(r);
}

/** Tolerant shape check for an exception line. */
export function isValidGroundingException(parsed: unknown): parsed is GroundingException {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (r.kind !== "grounding-exception") return false;
  if (typeof r.workClass !== "string" || r.workClass === "") return false;
  if (!isGroundKindValue(r.groundKind)) return false;
  if (typeof r.reason !== "string") return false;
  return hasValidExternalTrailer(r);
}

/** Tolerant shape check for a carve-out line. */
export function isValidGroundingCarveout(parsed: unknown): parsed is GroundingCarveout {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (r.kind !== "grounding-carveout") return false;
  if (typeof r.workClass !== "string" || r.workClass === "") return false;
  if (typeof r.regionDigest !== "string" || !HEX64.test(r.regionDigest)) return false;
  if (typeof r.reason !== "string") return false;
  return hasValidExternalTrailer(r);
}

/**
 * Read every (well-shaped) budget line, file order. Signatures are verified at gate time, NOT
 * here — this reader is shape-only, so an UNSIGNED/wrong-key line is RETURNED and then exempts
 * NOTHING downstream (fail-closed M4). Missing file → `[]`; never throws.
 */
export function readGroundingBudgets(paths: ProjectPaths): GroundingBudget[] {
  return readJsonlValues(groundingBudgetsPath(paths), isValidGroundingBudget);
}

/** Read every (well-shaped) exception line, file order. Signatures verified at gate time, NOT here. */
export function readGroundingExceptions(paths: ProjectPaths): GroundingException[] {
  return readJsonlValues(groundingExceptionsPath(paths), isValidGroundingException);
}

/** Read every (well-shaped) carve-out line, file order. Signatures verified at gate time, NOT here. */
export function readGroundingCarveouts(paths: ProjectPaths): GroundingCarveout[] {
  return readJsonlValues(groundingCarveoutsPath(paths), isValidGroundingCarveout);
}

// ---------------------------------------------------------------------------
// Sibling-store canonical text + chain walk + signature verify (Slice B / M4)
// ---------------------------------------------------------------------------
//
// The Slice-B Ed25519 producer signs each sibling line over its CANONICAL TEXT (the ONE formula
// the producer at sign time and the gate at validation time both use, so they can never diverge on
// the binding). `signature` + `recordHash` are EXCLUDED trailers — the signature covers every other
// field including `prevHash`. The verify path is VERIFY-ONLY (the in-process surface holds no
// private key — `receipt-signing.ts` exports no signer), exactly like `validWaivedReqs` /
// approvals / scan-exceptions: an UNSIGNED / wrong-key / chain-tampered line exempts NOTHING (M4).

/** Canonical field order for a {@link GroundingBudget} (signature + recordHash excluded — trailers). */
const GROUNDING_BUDGET_CANONICAL_FIELD_ORDER: ReadonlyArray<keyof GroundingBudget> = [
  "kind",
  "workClass",
  "groundKind",
  "metric",
  "threshold",
  "snapshot_coord",
  "producer_kind",
  "key_id",
  "prevHash",
];

/** Canonical field order for a {@link GroundingException} (signature + recordHash excluded). */
const GROUNDING_EXCEPTION_CANONICAL_FIELD_ORDER: ReadonlyArray<keyof GroundingException> = [
  "kind",
  "workClass",
  "groundKind",
  "reason",
  "snapshot_coord",
  "producer_kind",
  "key_id",
  "prevHash",
];

/** Canonical field order for a {@link GroundingCarveout} (signature + recordHash excluded). */
const GROUNDING_CARVEOUT_CANONICAL_FIELD_ORDER: ReadonlyArray<keyof GroundingCarveout> = [
  "kind",
  "workClass",
  "regionDigest",
  "reason",
  "snapshot_coord",
  "producer_kind",
  "key_id",
  "prevHash",
];

/**
 * One sibling-store line as a plain record (the three sibling lines share the signing-trailer +
 * snapshot shape, so the canonical text is computed structurally over a fixed field-order list).
 */
type SiblingLine = {
  snapshot_coord: SnapshotCoord;
  key_id: string;
  signature?: string;
  prevHash: string;
  recordHash: string;
};

/**
 * Deterministic canonical text of one sibling-store line: emit `order`'s fields in sequence, the
 * nested `snapshot_coord` re-emitted in its fixed key order, `undefined`/`signature`/`recordHash`
 * dropped; `JSON.stringify` with no indentation. `hashContent` then CRLF→LF normalizes (harmless).
 * The SINGLE formula both the producer (sign) and the gate (verify) use. `order` MUST exclude the
 * `signature`/`recordHash` trailers (the three FIELD_ORDER constants already do).
 */
function siblingCanonicalText(line: Record<string, unknown>, order: ReadonlyArray<string>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of order) {
    const val = line[key];
    if (val === undefined) continue;
    if (key === "snapshot_coord") {
      ordered[key] = reorder(val as SnapshotCoord, SNAPSHOT_FIELD_ORDER);
    } else {
      ordered[key] = val;
    }
  }
  return JSON.stringify(ordered);
}

/** Canonical text of a budget (signature + recordHash excluded). */
export function groundingBudgetCanonicalText(budget: Omit<GroundingBudget, "signature" | "recordHash">): string {
  return siblingCanonicalText(budget as Record<string, unknown>, GROUNDING_BUDGET_CANONICAL_FIELD_ORDER as string[]);
}

/** Canonical text of an exception (signature + recordHash excluded). */
export function groundingExceptionCanonicalText(
  exception: Omit<GroundingException, "signature" | "recordHash">,
): string {
  return siblingCanonicalText(
    exception as Record<string, unknown>,
    GROUNDING_EXCEPTION_CANONICAL_FIELD_ORDER as string[],
  );
}

/** Canonical text of a carve-out (signature + recordHash excluded). */
export function groundingCarveoutCanonicalText(
  carveout: Omit<GroundingCarveout, "signature" | "recordHash">,
): string {
  return siblingCanonicalText(
    carveout as Record<string, unknown>,
    GROUNDING_CARVEOUT_CANONICAL_FIELD_ORDER as string[],
  );
}

/**
 * Walk a sibling store in file order with a running `expectedPrev = GENESIS`. Recompute each
 * line's `recordHash` from its canonical text (mismatch ⇒ edited) and assert `prevHash` links to
 * the prior `recordHash` (mismatch ⇒ inserted/deleted/reordered). Return `{ ok:false, brokenAt:N }`
 * at the FIRST break; else `{ ok:true }`. Byte-identical posture to `verifyAssertionWaiverChain` —
 * a tampered sibling store exempts NOTHING (fail-closed).
 */
function verifySiblingChain<T extends SiblingLine>(
  lines: T[],
  canonical: (line: T) => string,
): VerifyChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const recomputed = hashContent(canonical(line));
    if (recomputed !== line.recordHash) return { ok: false, brokenAt: i, reason: "edited" };
    if (line.prevHash !== expectedPrev) return { ok: false, brokenAt: i, reason: "prev_mismatch" };
    expectedPrev = line.recordHash;
  }
  return { ok: true };
}

/** Verify a sibling line's Ed25519 signature against the loaded external public key (verify-only). */
function siblingSignatureVerifies<T extends SiblingLine>(
  line: T,
  publicKey: KeyObject,
  canonical: (line: T) => string,
): boolean {
  const signature = line.signature;
  if (typeof signature !== "string") return false;
  if (line.key_id !== externalKeyId(publicKey)) return false;
  return verifyCanonical(canonical(line), signature, publicKey);
}

/**
 * One validly-exempted `(workClass, groundKind)` axis — a SignedException whose chain + Ed25519
 * signature verify under the loaded external key. Carries the reason for the gate's diagnostics.
 */
export interface GroundingExemption {
  workClass: string;
  groundKind: GroundKind;
  reason: string;
}

/**
 * The set of validly-exempted grounding axes for the current run (the gate subtracts these from the
 * over-budget offender set — the I5 SignedException path). A `GroundingException` exempts its
 * `(workClass, groundKind)` ONLY when ALL of (mirroring `validWaivedReqs` symbol-for-symbol):
 *   1. The exception store's chain verifies (a tampered chain exempts NOTHING — fail-closed).
 *   2. An external public key is loaded AND the line's Ed25519 signature verifies under it with a
 *      matching `key_id` (an UNSIGNED / wrong-key / self-signed line exempts NOTHING — the in-
 *      process surface holds no private key, M4 3-party authority).
 *
 * With NO key loaded (the default fork/local/test path) NO exception verifies, so the set is empty
 * and the gate enforces fully. The result is keyed `"${workClass}::${groundKind}"` so the gate
 * can test membership by scope without ambiguity (the `::` separator + the fixed matrix's space-
 * free class labels and kind literals make a key collision impossible).
 */
export function validGroundingExemptions(paths: ProjectPaths): Map<string, GroundingExemption> {
  const exempt = new Map<string, GroundingExemption>();
  const exceptions = readGroundingExceptions(paths);
  if (exceptions.length === 0) return exempt;
  // Fail-closed: a tampered chain exempts NOTHING (no line from a tampered store is trusted).
  if (!verifySiblingChain(exceptions, groundingExceptionCanonicalText).ok) return exempt;
  const publicKey = loadExternalPublicKey();
  if (publicKey === null) return exempt; // no key ⇒ nothing verifies ⇒ exempt NOTHING
  for (const ex of exceptions) {
    if (!siblingSignatureVerifies(ex, publicKey, groundingExceptionCanonicalText)) continue;
    exempt.set(groundingExemptionKey(ex.workClass, ex.groundKind), {
      workClass: ex.workClass,
      groundKind: ex.groundKind,
      reason: ex.reason,
    });
  }
  return exempt;
}

/** The scope key for a `(workClass, groundKind)` exemption (`::`-separated, collision-free). */
export function groundingExemptionKey(workClass: string, groundKind: GroundKind): string {
  return `${workClass}::${groundKind}`;
}

/**
 * The set of validly-signed conformance BUDGETS for the current run, keyed
 * `"${workClass}::${groundKind}::${metric}"`. A budget counts ONLY when the budget store's
 * chain verifies AND the line's Ed25519 signature verifies under the loaded external key (3-party
 * authority, E4: an agent cannot self-issue a passing budget — the security boundary is the private
 * key). An UNSIGNED / wrong-key / tampered budget is INERT (M4). With no key loaded the set is empty.
 * Exposed so the gate (and the producer-authority test E4) can confirm a threshold was externally
 * authorized rather than agent-asserted.
 */
export function validGroundingBudgets(paths: ProjectPaths): Map<string, GroundingBudget> {
  const valid = new Map<string, GroundingBudget>();
  const budgets = readGroundingBudgets(paths);
  if (budgets.length === 0) return valid;
  if (!verifySiblingChain(budgets, groundingBudgetCanonicalText).ok) return valid;
  const publicKey = loadExternalPublicKey();
  if (publicKey === null) return valid;
  for (const b of budgets) {
    if (!siblingSignatureVerifies(b, publicKey, groundingBudgetCanonicalText)) continue;
    valid.set(`${b.workClass}::${b.groundKind}::${b.metric}`, b);
  }
  return valid;
}

/**
 * The set of validly-signed permitted-difference CARVE-OUTs for the current run, keyed by
 * `regionDigest`. A carve-out counts ONLY when the carve-out store's chain verifies AND the line's
 * Ed25519 signature verifies under the loaded external key. An UNSIGNED / wrong-key / tampered
 * carve-out masks NOTHING (M4). The perceptual-region masking it authorizes is consumed by the
 * Slice-C visual measurement; exposed here so the verify path is symmetric across all three stores.
 */
export function validGroundingCarveouts(paths: ProjectPaths): Map<string, GroundingCarveout> {
  const valid = new Map<string, GroundingCarveout>();
  const carveouts = readGroundingCarveouts(paths);
  if (carveouts.length === 0) return valid;
  if (!verifySiblingChain(carveouts, groundingCarveoutCanonicalText).ok) return valid;
  const publicKey = loadExternalPublicKey();
  if (publicKey === null) return valid;
  for (const c of carveouts) {
    if (!siblingSignatureVerifies(c, publicKey, groundingCarveoutCanonicalText)) continue;
    valid.set(c.regionDigest, c);
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Tolerance-kind threshold comparison (C4c — observed-vs-SIGNED-budget, Slice C)
// ---------------------------------------------------------------------------
//
// The deferred MED-1 the deterministic-kind enforce-flip (Slice B) left open: for the RUNNER-
// SENSITIVE TOLERANCE kinds (`visual-hash`, carrying the `visual` perceptual-diff + `a11y` scan-
// count conformance metrics) the over-budget verdict in `groundingConformanceOf` comes from the
// receipt's OWN signed `conformance[].status` — the signed budget THRESHOLD is verified for
// AUTHENTICITY (3-party authority, E4) but NEVER compared against the metric's `observed` value.
// That makes the budget INERT: a producer that signs a generous `status:"within-budget"` over an
// observed value that EXCEEDS the separately-signed threshold would pass. C4c closes that with an
// INDEPENDENT gate-side arithmetic comparison: `observed > signed_threshold ⇒ over-budget`,
// computed HERE (the gate), not trusted from the receipt's self-reported `status`.
//
// This is DETERMINISTIC arithmetic only — the `observed` value comes from the externally-signed
// receipt and the `threshold` from the externally-signed budget store; NO renderer/axe runs here
// (that toolchain stays in the producer/CI). Fail-closed: an `unobserved` observed value under
// enforce, or a required tolerance metric with NO matching signed budget under enforce, is a hard
// FAIL (never a silent pass). The `version`/`api` metrics on the DETERMINISTIC kinds are NOT
// re-compared here — they are binary exact-equality the signed receipt status fully decides (the
// Slice-B posture is unchanged for them).

/** The conformance metrics that are TOLERANCE-based (a numeric `observed ≤ threshold` band). */
const TOLERANCE_METRICS: ReadonlySet<ConformanceMetric["metric"]> = new Set(["visual", "a11y"]);

/**
 * One tolerance metric's INDEPENDENT threshold verdict for a `visual-hash` ground (C4c). Reports
 * the observed value, the signed threshold it was compared against, and the fail-closed status:
 *  - `within-budget` — a numeric `observed` ≤ a validly-signed `threshold`.
 *  - `over-budget`   — a numeric `observed` > the signed `threshold` (the gate's OWN arithmetic,
 *                      independent of the receipt's self-reported `status`).
 *  - `unobserved`    — the metric's `observed` is the `"unobserved"` stub (fail-closed: blocks
 *                      under enforce, never a silent pass).
 *  - `unpinned`      — the metric is observed (numeric) but NO validly-signed budget threshold
 *                      exists for its `(workClass, groundKind, metric)` axis (fail-closed under
 *                      enforce: a tolerance kind with no signed tolerance cannot be gated as passing).
 */
export interface ToleranceMetricVerdict {
  metric: ConformanceMetric["metric"];
  /** The receipt's measured value (numeric), or the `"unobserved"` stub literal. */
  observed: number | "unobserved";
  /** The signed budget threshold compared against, or `null` when no signed budget exists (unpinned). */
  threshold: number | null;
  status: "within-budget" | "over-budget" | "unobserved" | "unpinned";
}

/**
 * The independent tolerance-threshold verdict for a `visual-hash` grounding receipt (C4c). For each
 * TOLERANCE conformance metric (`visual` / `a11y`) on the receipt, look up the validly-signed
 * budget for `(receipt.workClass, "visual-hash", metric)` and compute `observed ≤ threshold` with
 * the gate's OWN arithmetic (recompute-don't-trust — the receipt's self-reported `status` is NOT
 * consulted here). `validBudgets` is the caller-resolved `validGroundingBudgets(paths)` map (passed
 * in so the gate resolves it ONCE per run, not per receipt). A non-`visual-hash` ground ⇒ `[]`
 * (deterministic kinds are not tolerance-gated). A `visual-hash` ground with NO tolerance metric on
 * its conformance list ⇒ `[]`. The CALLER (`evaluateGrounding`) fail-closes that case: a required
 * `visual-hash` ground with no `visual`/`a11y` tolerance verdict is forced to `unobserved` (a
 * producer that OMITS the measurement must not slip through as `within-budget`).
 *
 * Fail-closed precedence within a metric: `unobserved` (the stub) and `unpinned` (no signed
 * tolerance) are BOTH soft-fails the gate blocks under enforce; a numeric `observed` over its
 * signed `threshold` is `over-budget`. Only a numeric `observed` at-or-under a SIGNED threshold is
 * `within-budget`. The verdicts are emitted in `metric` order for determinism.
 *
 * TRUST SCOPE (review-fix, sec HIGH): the THRESHOLD is externally-signed / 3-party
 * (`validGroundingBudgets`), but `observed` comes from the trusted receipt. For an EXTERNAL
 * (`valid-grounded`) visual-hash receipt `observed` is producer-measured (renderer/axe in CI) and
 * 3-party. For an IN-PROCESS (`valid`) receipt `observed` is AGENT-AUTHORED — so this recompute
 * defends against a lying `status` given an honest `observed`, NOT against a lying `observed`.
 * In-process tolerance conformance is therefore ATTRIBUTION-TRUST ONLY (mirrors realization.ts:47-52).
 * Requiring tolerance grounds to be external (`valid-grounded`) to count under enforce is the P4
 * `require-grounded` tightening, deferred uniformly with the other Axis-B rows.
 */
export function toleranceThresholdVerdicts(
  receipt: GroundingReceipt,
  validBudgets: Map<string, GroundingBudget>,
): ToleranceMetricVerdict[] {
  if (receipt.ground.groundKind !== "visual-hash") return [];
  const verdicts: ToleranceMetricVerdict[] = [];
  for (const m of receipt.conformance) {
    if (!TOLERANCE_METRICS.has(m.metric)) continue;
    if (m.observed === "unobserved" || typeof m.observed !== "number") {
      // The stubbed / non-numeric measurement — fail-closed (never a silent pass under enforce).
      verdicts.push({ metric: m.metric, observed: "unobserved", threshold: null, status: "unobserved" });
      continue;
    }
    const observed = m.observed;
    const budget = validBudgets.get(`${receipt.workClass}::visual-hash::${m.metric}`);
    if (budget === undefined) {
      // Observed but UNPINNED: no validly-signed tolerance for this axis ⇒ cannot be gated as
      // passing (fail-closed under enforce). The threshold is unknown, so `null`.
      verdicts.push({ metric: m.metric, observed, threshold: null, status: "unpinned" });
      continue;
    }
    verdicts.push({
      metric: m.metric,
      observed,
      threshold: budget.threshold,
      status: observed > budget.threshold ? "over-budget" : "within-budget",
    });
  }
  return verdicts.sort((a, b) => a.metric.localeCompare(b.metric));
}
