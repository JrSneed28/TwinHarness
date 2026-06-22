/**
 * Terminal-transition receipt store (Axis-B slice-1a / BSC-4 — the keystone the
 * other 8 blind-spot classes copy). An irreversible ledger flip — a drift
 * resolved, a simulation retired, a decision approved — currently clears the
 * completion gate from a marker/attestation alone, with NO correspondence to
 * source. This module mints a schema-registered `TerminalTransitionReceipt` whose
 * *ground* (a content digest of the named source target + the repository snapshot
 * coordinate it was minted at) is recomputable at gate time, so a flip that does
 * not actually resolve in source is mechanically detectable.
 *
 * Storage mirrors `src/core/decisions.ts` EXACTLY: append-only, SHA-256
 * hash-chained `<stateDir>/terminal-receipts.jsonl`, one receipt per line, a
 * tolerant reader that never throws (`readTerminalReceipts`), a tail-scan for the
 * next `prevHash` (`readLastReceiptRecordHash`), an atomic-append writer that runs
 * under the CALLER's `withStateLock` span (`appendTerminalReceipt`), and a
 * tamper-detecting chain walk (`verifyReceiptChain`). A dedicated store gives the
 * gate one validated reader and slice-1b's external (un-writable) producer a
 * distinct location.
 *
 * The shared digest formula (`computeTargetDigest`) is modeled on
 * `tester.ts:computeReceiptDigest` (F8 content-bound-digest) but DOES NOT import
 * or modify it — F8's call path stays byte-identical and F8 tests stay green. It
 * is the SINGLE formula used by BOTH the producer (at creation) and the validator
 * (at gate time), so the two sides can never drift apart on the binding.
 *
 * `producer_identity` carries ZERO trust weight in-process (execution doc §2.4):
 * it is an audit breadcrumb only. The genuine un-forgeable property arrives in
 * slice-1b (an external keyed producer at a write-surface TwinHarness cannot
 * reach). Documented as such so a reviewer never mistakes it for a trust anchor.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { assertGovernedWriteSurface, resolveWithinRoot } from "./paths";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";
import { readJsonlValues, scanTailValid, safeParseJson } from "./jsonl";
import { gitHead, dirtyTreeDigest } from "./git-revision";
import { parseDriftEntries } from "./drift-log";
import { readDecisionEvents, reduceDecisions } from "./decisions";

// ---------------------------------------------------------------------------
// Schema (execution doc §2.5)
// ---------------------------------------------------------------------------

/**
 * Which kind of irreversible ledger flip a receipt grounds. One value per
 * terminal ledger: a resolved requirement-layer drift, a retired simulation
 * entry, an approved decision.
 */
export type TerminalTransitionKind = "drift-resolve" | "sim-retire" | "decision-approve";

/**
 * The content-bound ground: the source path the flip claims to resolve in, and a
 * content digest of that file at mint time. `path` is the project-root-relative
 * path; `digest` is {@link computeTargetDigest} over it. Both are `""` on a
 * build-coordinate-only receipt (a decision-approve with no linked artifact, and
 * the legacy backfill stamp).
 */
export interface TargetResolvesInSource {
  path: string;
  digest: string;
}

/**
 * The repository snapshot coordinate the receipt was minted at (reuses
 * `git-revision.ts`). Both null on a non-git checkout — F8 honesty: a null
 * coordinate is NON-DISCRIMINATING (it cannot prove staleness it has no
 * coordinate for), so the validator only treats a coordinate as stale when BOTH
 * the recorded and the current value are non-null.
 */
export interface SnapshotCoord {
  gitHead: string | null;
  treeDigest: string | null;
}

/**
 * One terminal-transition receipt (execution doc §2.5). Append-only and
 * hash-chained like a {@link import("./decisions").DecisionEvent}: any single
 * field edit breaks `recordHash`, and an insert/delete/reorder breaks the next
 * `prevHash`, so a forged or tampered receipt is detectable by
 * {@link verifyReceiptChain}.
 */
export interface TerminalTransitionReceipt {
  /** The terminal-ledger kind this receipt grounds. */
  kind: TerminalTransitionKind;
  /** The terminal entity id: `DRIFT-NNN` / `SIM-NNN` / `DECISION-NNN`. */
  refId: string;
  /** The content-bound ground (source path + its digest at mint time). */
  target_resolves_in_source: TargetResolvesInSource;
  /** The repository snapshot coordinate at mint time. */
  snapshot_coord: SnapshotCoord;
  /**
   * The producer's self-asserted identity. ZERO trust weight in-process — an
   * audit breadcrumb only (execution doc §2.4). The un-forgeable property is a
   * slice-1b concern (external keyed producer).
   */
  producer_identity: string;
  /**
   * `true` ONLY on a one-time backfill stamp (migration §4). A `legacy` receipt
   * is grandfathered: the gate ACCEPTS it but the validator reports it as
   * ungrounded-`legacy`. Omit-when-absent so a real receipt's canonical text
   * never carries it.
   */
  legacy?: boolean;
  /** SHA-256 hex (64) of the prior line's canonical text, or GENESIS for the first. */
  prevHash: string;
  /** SHA-256 hex (64) of THIS receipt's canonical text (computed before set). */
  recordHash: string;
}

// ---------------------------------------------------------------------------
// Canonical text + hashing (mirrors decisions.ts) — the tamper-evidence core
// ---------------------------------------------------------------------------

/**
 * The fixed canonical field order for hashing. Mirrors decisions.ts: copy fields
 * into a fresh object in THIS order, omit any `undefined` key, omit `recordHash`
 * entirely. The two nested objects (`target_resolves_in_source`, `snapshot_coord`)
 * are re-emitted in a FIXED key order so the canonical text is byte-stable (the
 * `canonicalProvenance` technique from decisions.ts).
 */
const CANONICAL_FIELD_ORDER: ReadonlyArray<keyof TerminalTransitionReceipt> = [
  "kind",
  "refId",
  "target_resolves_in_source",
  "snapshot_coord",
  "producer_identity",
  "legacy",
  "prevHash",
];

/** Canonical key order for {@link TargetResolvesInSource} (byte-stable nested JSON). */
const TARGET_FIELD_ORDER: ReadonlyArray<keyof TargetResolvesInSource> = ["path", "digest"];

/** Canonical key order for {@link SnapshotCoord} (byte-stable nested JSON). */
const SNAPSHOT_FIELD_ORDER: ReadonlyArray<keyof SnapshotCoord> = ["gitHead", "treeDigest"];

/** Re-emit a nested object in a fixed key order (deterministic JSON). */
function reorder<T extends object>(obj: T, order: ReadonlyArray<keyof T>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) out[key as string] = obj[key];
  return out;
}

/**
 * Deterministic canonical text of a receipt for hashing. Field order is fixed;
 * `undefined` keys and `recordHash` are dropped; the two nested objects are
 * re-emitted in their fixed key order; `JSON.stringify` with no indentation.
 * `hashContent` then CRLF→LF normalizes (harmless — the canonical text contains
 * no CRLF).
 */
export function canonicalText(receipt: Omit<TerminalTransitionReceipt, "recordHash">): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CANONICAL_FIELD_ORDER) {
    const val = (receipt as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (key === "target_resolves_in_source") {
      ordered[key] = reorder(val as TargetResolvesInSource, TARGET_FIELD_ORDER);
    } else if (key === "snapshot_coord") {
      ordered[key] = reorder(val as SnapshotCoord, SNAPSHOT_FIELD_ORDER);
    } else {
      ordered[key] = val;
    }
  }
  return JSON.stringify(ordered);
}

/** `recordHash` for a receipt = SHA-256 of its canonical text (recordHash omitted). */
export function computeRecordHash(receipt: Omit<TerminalTransitionReceipt, "recordHash">): string {
  return hashContent(canonicalText(receipt));
}

// ---------------------------------------------------------------------------
// Storage (mirrors decisions.ts)
// ---------------------------------------------------------------------------

/** `<stateDir>/terminal-receipts.jsonl` — the terminal-receipt ledger's location. */
export function terminalReceiptsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "terminal-receipts.jsonl");
}

const KIND_VALUES = new Set<TerminalTransitionKind>(["drift-resolve", "sim-retire", "decision-approve"]);

/** Validate the shape of a parsed line; malformed lines are skipped (tolerant). */
function isValidReceipt(parsed: unknown): parsed is TerminalTransitionReceipt {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (typeof r.kind !== "string" || !KIND_VALUES.has(r.kind as TerminalTransitionKind)) return false;
  if (typeof r.refId !== "string" || r.refId === "") return false;
  if (typeof r.producer_identity !== "string") return false;
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  if (r.legacy !== undefined && typeof r.legacy !== "boolean") return false;
  // Nested ground objects must be present and shaped.
  const tgt = r.target_resolves_in_source;
  if (typeof tgt !== "object" || tgt === null) return false;
  const t = tgt as Record<string, unknown>;
  if (typeof t.path !== "string" || typeof t.digest !== "string") return false;
  const snap = r.snapshot_coord;
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (!(s.gitHead === null || typeof s.gitHead === "string")) return false;
  if (!(s.treeDigest === null || typeof s.treeDigest === "string")) return false;
  return true;
}

/**
 * Read + parse every receipt in file order. Missing file → `[]`. Bad lines
 * (non-JSON, partial-tail, schema-invalid) are silently skipped — tolerant, never
 * throws (mirrors `readDecisionEvents`). Chain breaks surface via
 * {@link verifyReceiptChain}, not here.
 */
export function readTerminalReceipts(paths: ProjectPaths): TerminalTransitionReceipt[] {
  return readJsonlValues(terminalReceiptsPath(paths), isValidReceipt);
}

/**
 * The `recordHash` of the ledger's last VALID receipt — the only thing
 * {@link appendTerminalReceipt} needs to seal the next link. Tail-scans the file
 * (parses only down to the last valid line) so N appends stay O(N) total.
 * Missing/empty file, or no valid tail line → `GENESIS_PREV_HASH`.
 */
export function readLastReceiptRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(terminalReceiptsPath(paths), isValidReceipt);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

// ---------------------------------------------------------------------------
// verifyChain (mirrors decisions.verifyChain) — tamper-detecting walk
// ---------------------------------------------------------------------------

export type VerifyChainResult =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: "edited" | "prev_mismatch" };

/**
 * Walk receipts in file order with a running `expectedPrev = GENESIS`. For each
 * receipt: recompute `recordHash` from its canonical text — a mismatch means the
 * record was edited. If `prevHash !== expectedPrev` the line was inserted,
 * deleted, or reordered. Return `{ ok:false, brokenAt:N }` at the FIRST break;
 * else advance `expectedPrev = receipt.recordHash`. Byte-identical posture to
 * `decisions.verifyChain`.
 */
export function verifyReceiptChain(receipts: TerminalTransitionReceipt[]): VerifyChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    const { recordHash, ...rest } = r;
    const recomputed = computeRecordHash(rest);
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
// Shared digest / snapshot helpers — the SINGLE formula used by producer AND validator
// ---------------------------------------------------------------------------

/**
 * True iff `relPath` resolves to a readable, REGULAR file CONTAINED within
 * `root`. Uses {@link resolveWithinRoot} for the same cross-platform containment
 * posture the rest of TwinHarness takes (rejects absolute-elsewhere, `..`,
 * symlink/junction escape). A directory, a missing path, or a path-escape → false.
 */
export function targetResolvesInSource(root: string, relPath: string): boolean {
  return computeTargetDigest(root, relPath) !== null;
}

/**
 * The SINGLE shared content-binding formula (modeled on
 * `tester.ts:computeReceiptDigest`, NOT importing it). Resolve `relPath` within
 * `root` (path-escape → null), require a readable regular file (else null), and
 * return `hashContent(<file utf8>)` — CRLF-normalized, since these are text
 * targets. Returns `null` whenever the target does not resolve, which is the
 * negative signal both the producer (refuse-at-creation) and the validator
 * (`target_missing`) key on.
 */
export function computeTargetDigest(root: string, relPath: string): string | null {
  if (relPath === "") return null;
  const abs = resolveWithinRoot(root, relPath);
  if (abs === null) return null; // path-escape / absolute-elsewhere / junction escape
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return hashContent(fs.readFileSync(abs, "utf8"));
  } catch {
    return null; // unreadable → does not resolve
  }
}

/**
 * The current repository snapshot coordinate (reuses `git-revision.ts`). Both
 * fields null on a non-git checkout — non-discriminating (F8 honesty). The single
 * helper the producer calls at mint time and the validator calls at gate time.
 */
export function currentSnapshotCoord(root: string): SnapshotCoord {
  return { gitHead: gitHead(root), treeDigest: dirtyTreeDigest(root) };
}

/**
 * Receipt snapshots bind to the source tree, not TwinHarness's own mutable
 * governance ledgers. Excluding the selected state directory and drift log keeps a
 * terminal command from invalidating its receipt merely by recording the flip.
 */
function currentReceiptSnapshotCoord(paths: ProjectPaths): SnapshotCoord {
  const excludePaths = [paths.stateDir, paths.driftLog]
    .map((p) => path.relative(paths.root, p))
    .filter((p) => p !== "" && !path.isAbsolute(p) && p !== ".." && !p.startsWith(`..${path.sep}`));
  return {
    gitHead: gitHead(paths.root),
    treeDigest: dirtyTreeDigest(paths.root, excludePaths),
  };
}

// ---------------------------------------------------------------------------
// Producer API (caller already holds withStateLock)
// ---------------------------------------------------------------------------

/** Input to {@link appendTerminalReceipt}. */
export interface MintReceiptInput {
  kind: TerminalTransitionKind;
  refId: string;
  /**
   * The source path the flip resolves in. REQUIRED for `drift-resolve` &
   * `sim-retire` (the requirement-layer ground). OPTIONAL for `decision-approve`
   * (build-coordinate-only when the decision links no artifact). When supplied it
   * MUST resolve, or {@link appendTerminalReceipt} throws {@link TargetUnresolvedError}.
   */
  targetPath?: string;
  /** Self-asserted producer identity (zero in-process trust weight). */
  producerIdentity: string;
}

/**
 * Thrown by {@link appendTerminalReceipt} when `targetPath` is supplied but does
 * NOT resolve in source (negative-control **c** at creation: a producer refuses
 * to mint a receipt whose ground is already missing).
 */
export class TargetUnresolvedError extends Error {
  /** Stable machine token for the CLI failure envelope. */
  readonly code = "receipt_target_unresolved";
  constructor(
    message: string,
    /** The offending (root-relative) target path. */
    public readonly target: string,
  ) {
    super(message);
    this.name = "TargetUnresolvedError";
  }
}

/**
 * Append one terminal-transition receipt, sealing the hash chain. The caller MUST
 * already hold the `withStateLock` span (read-modify-append is serialized there),
 * exactly like `appendDecisionEvent`.
 *
 * If `targetPath` is supplied it MUST resolve in source (negative-control **c**):
 * a non-resolving target throws {@link TargetUnresolvedError} BEFORE any write, so
 * a flip whose ground is already missing cannot be minted. The receipt records the
 * digest of that target and the current snapshot coordinate, then derives
 * `prevHash` from the tail, computes `recordHash`, asserts the write-surface, and
 * atomically appends `JSON.stringify(sealed) + "\n"`. Returns the sealed receipt.
 */
export function appendTerminalReceipt(
  paths: ProjectPaths,
  input: MintReceiptInput,
): TerminalTransitionReceipt {
  let targetPath = "";
  let digest = "";
  if (input.targetPath !== undefined && input.targetPath !== "") {
    const d = computeTargetDigest(paths.root, input.targetPath);
    if (d === null) {
      throw new TargetUnresolvedError(
        `Refusing to mint a ${input.kind} receipt for ${input.refId}: target "${input.targetPath}" does not resolve in source.`,
        input.targetPath,
      );
    }
    targetPath = input.targetPath;
    digest = d;
  }
  return sealAndAppend(paths, {
    kind: input.kind,
    refId: input.refId,
    target_resolves_in_source: { path: targetPath, digest },
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: input.producerIdentity,
  });
}

/**
 * Append a one-time `legacy:true` backfill stamp (migration §4). A legacy receipt
 * carries an EMPTY target (it grounds nothing — it is grandfathered), the snapshot
 * coordinate of the moment, and `producer_identity: "legacy-backfill"`. Internal:
 * only {@link ensureReceiptMigration} mints these.
 */
function appendLegacyReceipt(
  paths: ProjectPaths,
  kind: TerminalTransitionKind,
  refId: string,
): TerminalTransitionReceipt {
  return sealAndAppend(paths, {
    kind,
    refId,
    target_resolves_in_source: { path: "", digest: "" },
    snapshot_coord: currentReceiptSnapshotCoord(paths),
    producer_identity: "legacy-backfill",
    legacy: true,
  });
}

/**
 * The shared seal+append chokepoint: derive `prevHash` from the tail, compute
 * `recordHash`, assert the governed write-surface, mkdir, atomically append. The
 * single place a receipt line is written, so the real and legacy producers stay
 * byte-consistent on the chain mechanics.
 */
function sealAndAppend(
  paths: ProjectPaths,
  receipt: Omit<TerminalTransitionReceipt, "prevHash" | "recordHash">,
): TerminalTransitionReceipt {
  // AC#1 write-surface chokepoint: terminalReceiptsPath is under stateDir; the
  // guard fires here (propagating, not best-effort) so a non-governed target throws.
  assertGovernedWriteSurface(paths.root, terminalReceiptsPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const prevHash = readLastReceiptRecordHash(paths);
  const withPrev: Omit<TerminalTransitionReceipt, "recordHash"> = { ...receipt, prevHash };
  const recordHash = computeRecordHash(withPrev);
  const sealed: TerminalTransitionReceipt = { ...withPrev, recordHash };
  fs.appendFileSync(terminalReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

// ---------------------------------------------------------------------------
// Validation (execution doc §3) — readReceiptValidated → status
// ---------------------------------------------------------------------------

/**
 * The validated status of the receipt backing a terminal flip (execution doc §3):
 *  - `absent`         — no receipt AND the entity is not grandfathered → BLOCK
 *                       (negative-control **b**: post-upgrade bypass).
 *  - `tampered`       — the receipt hash chain does not verify → BLOCK.
 *  - `target_missing` — recorded `path` no longer resolves in source → BLOCK (c).
 *  - `target_mismatch`— `path` resolves but its digest ≠ recorded → BLOCK.
 *  - `stale`          — `snapshot_coord` diverged (gitHead/treeDigest) → BLOCK (a).
 *  - `legacy`         — a grandfathered backfill stamp → gate ACCEPTS, reported as
 *                       ungrounded-legacy.
 *  - `valid`          — present, non-legacy, target resolves + matches, not stale.
 */
export type ReceiptValidationStatus =
  | "absent"
  | "tampered"
  | "target_missing"
  | "target_mismatch"
  | "stale"
  | "legacy"
  | "valid";

/** The validated receipt + its status (and any staleness reasons). */
export interface ValidatedReceipt {
  status: ReceiptValidationStatus;
  /** The latest receipt found for (kind, refId); omitted on `absent`. */
  receipt?: TerminalTransitionReceipt;
  /** On `stale`: which coordinate(s) diverged (`gitHead` / `treeDigest`). */
  staleReasons?: string[];
}

/**
 * Compare a recorded coordinate against the current one under the F8 rule: a
 * coordinate discriminates ONLY when BOTH the recorded and the current value are
 * non-null. A null on either side is non-discriminating (a non-git checkout, or a
 * receipt minted before the coordinate existed) and never contributes staleness.
 * Returns the list of diverged coordinate names (empty = not stale).
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
 * Validate the receipt backing the terminal flip `(kind, refId)` (execution doc
 * §3 / §6). Finds the LATEST receipt matching `(kind, refId)` in file order, then
 * classifies it.
 *
 * ABSENT classification (the load-bearing negative-control **b** / migration §4):
 * when NO receipt is found —
 *   - `!receiptMigrationDone(paths)` → `legacy`. The project never ran the new
 *     producer code: it is genuinely pre-upgrade, so treat a flip as
 *     grandfathered-implicitly. Keeps existing complete projects / existing gate
 *     tests green.
 *   - migrated AND `${kind}:${refId}` is in {@link grandfatheredBaseline} → `legacy`.
 *   - migrated AND NOT in the baseline → `absent` → BLOCK. This is the
 *     post-upgrade bypass via `--emergency` / raw `state set`.
 *
 * KIND-SPECIFIC branch (execution doc §6 — decision-approve):
 *   `decision-approve` is build-coordinate-only. A decision approved at an earlier
 *   build STAYS approved, so we do NOT block on a target (it may be empty) and do
 *   NOT treat snapshot drift as `stale`. Validity is simply: a present, non-legacy
 *   receipt → `valid`. (drift-resolve / sim-retire are the requirement-layer kinds
 *   that DO carry the full target + snapshot discrimination.)
 */
export function readReceiptValidated(
  paths: ProjectPaths,
  kind: TerminalTransitionKind,
  refId: string,
): ValidatedReceipt {
  const receipts = readTerminalReceipts(paths);
  if (!verifyReceiptChain(receipts).ok) return { status: "tampered" };
  // LATEST matching receipt in file order (a re-flip mints a newer receipt).
  let found: TerminalTransitionReceipt | undefined;
  for (const r of receipts) {
    if (r.kind === kind && r.refId === refId) found = r;
  }

  if (!found) {
    // Negative-control (b) / migration §4 absent-classification.
    if (!receiptMigrationDone(paths)) return { status: "legacy" }; // genuinely pre-upgrade
    if (grandfatheredBaseline(paths).has(baselineKey(kind, refId))) return { status: "legacy" };
    return { status: "absent" }; // migrated + not grandfathered → BLOCK
  }

  if (found.legacy === true) return { status: "legacy", receipt: found };

  // decision-approve (execution doc §6): build-coordinate-only — no target block,
  // no snapshot staleness. A present non-legacy receipt is valid.
  if (kind === "decision-approve") return { status: "valid", receipt: found };

  // drift-resolve / sim-retire: full requirement-layer discrimination.
  const recordedPath = found.target_resolves_in_source.path;
  const recordedDigest = found.target_resolves_in_source.digest;
  const currentDigest = computeTargetDigest(paths.root, recordedPath);
  if (currentDigest === null) return { status: "target_missing", receipt: found }; // (c)
  if (currentDigest !== recordedDigest) return { status: "target_mismatch", receipt: found };

  const staleReasons = snapshotStaleReasons(found.snapshot_coord, currentReceiptSnapshotCoord(paths));
  if (staleReasons.length > 0) return { status: "stale", receipt: found, staleReasons }; // (a)

  return { status: "valid", receipt: found };
}

// ---------------------------------------------------------------------------
// Migration / grandfather (execution doc §4) — closes negative-control (b)
// ---------------------------------------------------------------------------

/** A reference to a currently-terminal ledger entity (kind + its id). */
export interface TerminalEntityRef {
  kind: TerminalTransitionKind;
  refId: string;
}

/** `<stateDir>/.terminal-receipts-migration` — the migration marker file. */
function migrationMarkerPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, ".terminal-receipts-migration");
}

/** The grandfathered-baseline membership key for an entity. */
function baselineKey(kind: TerminalTransitionKind, refId: string): string {
  return `${kind}:${refId}`;
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
 * True once {@link ensureReceiptMigration} has run for this project (the marker
 * file is present + well-shaped). The gate's absent-classification keys on this to
 * tell "genuinely pre-upgrade" (no marker → grandfather implicitly) from
 * "post-upgrade bypass" (marker present, entity not in baseline → BLOCK).
 */
export function receiptMigrationDone(paths: ProjectPaths): boolean {
  return readMigrationMarker(paths) !== undefined;
}

/**
 * The grandfathered baseline id-set captured at migration time. Members are
 * `${kind}:${refId}`. Empty set when not yet migrated. These entities were already
 * terminal BEFORE the receipt regime began, so an absent receipt for them is
 * grandfathered (`legacy`) rather than a bypass.
 */
export function grandfatheredBaseline(paths: ProjectPaths): Set<string> {
  const marker = readMigrationMarker(paths);
  return new Set(marker ? marker.baseline : []);
}

/**
 * Minimal, tolerant read of `<stateDir>/simulation-ledger.json` for the migration
 * baseline ONLY — reads the RAW file (no `commands/sim.ts` import, which would be
 * an import cycle: commands import receipts.ts, not vice-versa). Returns the ids
 * of every entry whose `status === "retired"`. A missing/corrupt/non-array file
 * yields `[]` (the migration is best-effort; a damaged ledger simply contributes
 * no grandfathered sim ids).
 */
function readRetiredSimIds(paths: ProjectPaths): string[] {
  const file = path.join(paths.stateDir, "simulation-ledger.json");
  if (!fs.existsSync(file)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const parsed = safeParseJson(raw);
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const row of parsed) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id === "string" && r.id !== "" && r.status === "retired") ids.push(r.id);
  }
  return ids;
}

/**
 * The currently-terminal entities across the three ledgers (execution doc §4),
 * read from the RAW source files (no command imports):
 *   - `drift-resolve` — `paths.driftLog` entries that carry a `## DRIFT-NNN —
 *     resolved` note in the file. refId = the `DRIFT-NNN`.
 *   - `sim-retire`    — `<stateDir>/simulation-ledger.json` entries with
 *     `status === "retired"`. refId = the `SIM-NNN`.
 *   - `decision-approve` — `readDecisionEvents` → `reduceDecisions` decisions with
 *     `status === "approved"`. refId = the `DECISION-NNN`.
 */
export function collectTerminalEntities(paths: ProjectPaths): TerminalEntityRef[] {
  const out: TerminalEntityRef[] = [];

  // drift-resolve: a resolved drift has a `## DRIFT-NNN — resolved` note line
  // (em-dash U+2014, exactly as runDriftResolve writes it). parseDriftEntries
  // gives us the set of known DRIFT ids; the resolution note is what marks them
  // terminal. We scan the raw file lines for the resolution notes directly.
  let driftText = "";
  try {
    driftText = fs.readFileSync(paths.driftLog, "utf8");
  } catch {
    driftText = ""; // no drift log → no resolved drifts
  }
  if (driftText !== "") {
    const blockingDriftIds = new Set(
      parseDriftEntries(driftText)
        .filter((e) => e.layer === "requirement")
        .map((e) => e.id),
    );
    const seen = new Set<string>();
    for (const line of driftText.split(/\r?\n/)) {
      const m = /^##\s+(DRIFT-\d+)\s+—\s+resolved\s*$/.exec(line.trim());
      if (!m) continue;
      const id = m[1]!;
      // Only count a resolution note that corresponds to a real drift entry, and
      // only once per id.
      if (blockingDriftIds.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push({ kind: "drift-resolve", refId: id });
      }
    }
  }

  // sim-retire: retired entries in the simulation ledger.
  for (const id of readRetiredSimIds(paths)) {
    out.push({ kind: "sim-retire", refId: id });
  }

  // decision-approve: approved decisions.
  for (const d of reduceDecisions(readDecisionEvents(paths))) {
    if (d.status === "approved") out.push({ kind: "decision-approve", refId: d.id });
  }

  return out;
}

/**
 * Idempotent, marker-guarded migration (execution doc §4). MUST be called holding
 * the state lock (it appends receipts + writes the marker). On the FIRST call it
 * stamps a `legacy:true` receipt for every currently-terminal ledger entity that
 * lacks ANY receipt, then writes the marker recording the full grandfathered
 * baseline id-set. A re-run is a no-op (the marker is present).
 *
 * Double-stamp guard: even within the first run, an entity that ALREADY has a
 * receipt (found by scanning the receipts file) is skipped — so a partial prior
 * run, or a real receipt minted before migration, is never double-stamped.
 */
export function ensureReceiptMigration(paths: ProjectPaths): void {
  if (receiptMigrationDone(paths)) return; // marker present → already migrated

  const terminalEntities = collectTerminalEntities(paths);

  // The set of (kind:refId) that already have ANY receipt — so we never double-stamp.
  const existing = new Set<string>();
  for (const r of readTerminalReceipts(paths)) existing.add(baselineKey(r.kind, r.refId));

  for (const ent of terminalEntities) {
    const key = baselineKey(ent.kind, ent.refId);
    if (existing.has(key)) continue; // already has a receipt — do not double-stamp
    appendLegacyReceipt(paths, ent.kind, ent.refId);
    existing.add(key);
  }

  // Write the marker LAST, recording the full baseline (every currently-terminal
  // entity id), so a crash mid-stamp leaves no marker and the next run re-attempts
  // (the double-stamp guard makes the retry safe).
  const baseline = terminalEntities.map((e) => baselineKey(e.kind, e.refId));
  const marker: MigrationMarker = { migratedAt: new Date().toISOString(), baseline };
  assertGovernedWriteSurface(paths.root, migrationMarkerPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(migrationMarkerPath(paths), JSON.stringify(marker), "utf8");
}
