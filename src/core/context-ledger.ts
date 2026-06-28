/**
 * Context ledger: sharded, append-only JSONL hash chain recording every page
 * delivered into a session. Mirrors receipts.ts external-store + jsonl.ts
 * tolerant-reader patterns (plan §D-09).
 *
 * LOCK ISOLATION: dedicated per-shard mkdir lock under context-pages/ — NOT
 * .state.lock / withStateLock — so ledger appends never contend with the main
 * state read-modify-write path.
 *
 * S0 = record-only: only op="deliver" is emitted by callers. Other op values
 * are valid enum entries for later slices.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";
import { readJsonlValues, scanTailValid } from "./jsonl";
import { sleepSync } from "./sleep";

const SHARD_COMPONENT_FALLBACK = "unknown";

/**
 * Encode untrusted session / agent identifiers into one filesystem-safe segment.
 * Hook payloads are external input; raw ids must never be interpolated into a path
 * because `/`, `\\`, `..`, drive prefixes, or reserved characters can escape the
 * context-pages directory.  Base64url is deterministic, compact, and contains no
 * path separators; very long ids fall back to a full content hash to keep path
 * lengths bounded.
 */
function encodeShardComponent(raw: string): string {
  const value = raw.length > 0 ? raw : SHARD_COMPONENT_FALLBACK;
  const encoded = Buffer.from(value, "utf8").toString("base64url");
  return encoded.length <= 120 ? encoded : `sha256-${hashContent(value)}`;
}

function assertUnderContextPages(pagesDir: string, candidate: string): string {
  const resolvedRoot = path.resolve(pagesDir);
  const resolvedCandidate = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return resolvedCandidate;
  }
  throw new Error("context ledger shard path escaped context-pages directory");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Operations emitted into the ledger. S0 callers only emit "deliver". */
export type LedgerOp =
  | "deliver"
  | "attest"
  | "delta"
  | "rehydrate"
  | "invalidate"
  | "epoch-bump";

/** One sealed line in a ledger shard (D-09 field set). */
export interface LedgerRecord {
  seq: number;
  ts: string;
  session_id: string;
  agent_id: string;
  agent_type: string;
  epoch: number;
  op: LedgerOp;
  page_id: string;
  logical_key: string;
  content_hash: string;
  base_hash?: string;
  complete: boolean;
  est_tokens: number;
  reduction_kind: string;
  /** SHA-256 of the previous record's recordHash; GENESIS_PREV_HASH for the first. */
  prevHash: string;
  /** SHA-256 of the canonical JSON of this record with recordHash omitted. */
  recordHash: string;
}

/**
 * Caller-supplied scope identifying which shard to write or read.
 * agentOrRoot = positively-confirmed agent_id, or "root" when root is
 * positively confirmed. Callers MUST NOT pass "root" for indeterminate scope.
 */
export interface LedgerScope {
  session_id: string;
  agentOrRoot: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `<stateDir>/context-pages/` — all page data lives here, never in state.json. */
export function contextPagesDir(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "context-pages");
}

/** `<contextPagesDir>/ledger-<encoded-session>-<encoded-agentOrRoot>.jsonl`. */
export function ledgerShardPath(paths: ProjectPaths, scope: LedgerScope): string {
  const pagesDir = contextPagesDir(paths);
  const shard = `ledger-${encodeShardComponent(scope.session_id)}-${encodeShardComponent(scope.agentOrRoot)}.jsonl`;
  return assertUnderContextPages(pagesDir, path.join(pagesDir, shard));
}

// ---------------------------------------------------------------------------
// Canonical serialization + record hash (mirrors computeRecordHash in receipts.ts)
// ---------------------------------------------------------------------------

/**
 * Field order for deterministic JSON serialization. recordHash is excluded —
 * it is the SHA-256 of the canonical text of the rest of the record.
 */
const CANONICAL_FIELD_ORDER: ReadonlyArray<keyof Omit<LedgerRecord, "recordHash">> = [
  "seq",
  "ts",
  "session_id",
  "agent_id",
  "agent_type",
  "epoch",
  "op",
  "page_id",
  "logical_key",
  "content_hash",
  "base_hash",
  "complete",
  "est_tokens",
  "reduction_kind",
  "prevHash",
];

function canonicalText(rec: Omit<LedgerRecord, "recordHash">): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CANONICAL_FIELD_ORDER) {
    const val = (rec as Record<string, unknown>)[key];
    if (val === undefined) continue; // omit absent optional fields (e.g. base_hash)
    ordered[key] = val;
  }
  return JSON.stringify(ordered);
}

/** recordHash = SHA-256 of the canonical text of the record without recordHash. */
export function computeLedgerRecordHash(rec: Omit<LedgerRecord, "recordHash">): string {
  return hashContent(canonicalText(rec));
}

// ---------------------------------------------------------------------------
// Validation — shape predicate for the tolerant readers
// ---------------------------------------------------------------------------

const OP_VALUES = new Set<LedgerOp>([
  "deliver",
  "attest",
  "delta",
  "rehydrate",
  "invalidate",
  "epoch-bump",
]);

function isValidLedgerRecord(parsed: unknown): parsed is LedgerRecord {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (typeof r.seq !== "number") return false;
  if (typeof r.ts !== "string" || r.ts === "") return false;
  if (typeof r.session_id !== "string" || r.session_id === "") return false;
  if (typeof r.agent_id !== "string") return false;
  if (typeof r.agent_type !== "string") return false;
  if (typeof r.epoch !== "number") return false;
  if (typeof r.op !== "string" || !OP_VALUES.has(r.op as LedgerOp)) return false;
  if (typeof r.page_id !== "string" || r.page_id === "") return false;
  if (typeof r.logical_key !== "string") return false;
  if (typeof r.content_hash !== "string") return false;
  if (r.base_hash !== undefined && typeof r.base_hash !== "string") return false;
  if (typeof r.complete !== "boolean") return false;
  if (typeof r.est_tokens !== "number") return false;
  if (typeof r.reduction_kind !== "string") return false;
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Tolerant readers (mirror readJsonlValues / scanTailValid from jsonl.ts)
// ---------------------------------------------------------------------------

/**
 * Read all valid records from a shard in file order. Missing file → [].
 * Unparseable / schema-invalid lines are silently skipped — tolerant, never throws.
 * Chain integrity is NOT checked here; use verifyLedgerChain for that (audit-only).
 */
export function readShardRecords(paths: ProjectPaths, scope: LedgerScope): LedgerRecord[] {
  return readJsonlValues(ledgerShardPath(paths, scope), isValidLedgerRecord);
}

function readLastShardRecord(paths: ProjectPaths, scope: LedgerScope): LedgerRecord | undefined {
  return scanTailValid(ledgerShardPath(paths, scope), isValidLedgerRecord) ?? undefined;
}

/**
 * The recordHash of the last valid record in the shard — the prevHash seed for the
 * next append. Missing / empty / no-valid-tail → GENESIS_PREV_HASH. Tail-scans so
 * N sequential appends stay O(N) total. Never throws.
 */
export function readLastShardRecordHash(paths: ProjectPaths, scope: LedgerScope): string {
  const last = readLastShardRecord(paths, scope);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

// ---------------------------------------------------------------------------
// Per-shard lock (dedicated mkdir lock — NOT .state.lock / withStateLock)
// ---------------------------------------------------------------------------

/** Milliseconds before the shard lock dir is considered stale and may be stolen. */
const SHARD_LOCK_STALE_MS = 3_000;

/**
 * Milliseconds we wait to acquire the shard lock before falling back to an
 * unlocked appendFileSync. A shorter ceiling than the state lock (25s) because
 * a ledger append is a fast, lock-scope-narrow operation.
 */
const SHARD_LOCK_TIMEOUT_MS = 5_000;

/**
 * Classify a mkdirSync failure as "lock already held" vs. a real error.
 * Mirrors isLockHeldError in state-store.ts for cross-platform correctness
 * (Windows can surface EPERM / EACCES instead of EEXIST on a contended mkdir).
 */
function isShardLockHeldError(code: string | undefined): boolean {
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}

/**
 * Try to acquire the per-shard mkdir lock, waiting up to SHARD_LOCK_TIMEOUT_MS.
 * Returns true when the lock is acquired (caller MUST release via rmSync).
 * Returns false on timeout — caller falls back to direct appendFileSync;
 * the resulting forked prevHash is tolerated (external-store precedent, receipts.ts).
 */
function acquireShardLock(lockDir: string): boolean {
  const deadline = Date.now() + SHARD_LOCK_TIMEOUT_MS;
  let backoff = 5;
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      return true; // acquired
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!isShardLockHeldError(code)) throw e; // real error — propagate
    }

    if (Date.now() >= deadline) return false; // timed out

    // Steal a stale lock left by a crashed holder (mirrors withStateLock steal logic)
    try {
      const mtime = fs.statSync(lockDir).mtimeMs;
      if (Date.now() - mtime > SHARD_LOCK_STALE_MS) {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {
      // lock may have been released between statSync and rmSync — ignore
    }

    // Exponential backoff with full jitter (mirrors withStateLock PERF-008)
    sleepSync(Math.floor(Math.random() * backoff));
    backoff = Math.min(backoff * 2, 80);
  }
}

// ---------------------------------------------------------------------------
// Append (the write path)
// ---------------------------------------------------------------------------

/**
 * Seal and append one record to the appropriate shard.
 *
 * Derives prevHash from the shard tail (GENESIS_PREV_HASH when empty) and
 * computes recordHash before writing. Uses a dedicated per-shard mkdir lock
 * under context-pages/ so shard appends are serialized without touching the
 * main .state.lock span.
 *
 * On lock-timeout: falls back to a single-syscall appendFileSync with
 * GENESIS_PREV_HASH as prevHash. The resulting forked chain link is tolerated
 * (matches external-receipts precedent in receipts.ts §682–684). The record is
 * written, never silently dropped.
 *
 * The caller provides all fields except prevHash and recordHash.
 */
export function appendLedgerRecord(
  paths: ProjectPaths,
  scope: LedgerScope,
  rec: Omit<LedgerRecord, "prevHash" | "recordHash">,
): LedgerRecord {
  const pagesDir = contextPagesDir(paths);
  const shardFile = ledgerShardPath(paths, scope);
  const lockDir = shardFile + ".lock";

  // Ensure the context-pages directory exists (idempotent; first append creates it)
  fs.mkdirSync(pagesDir, { recursive: true });

  const acquiredLock = acquireShardLock(lockDir);
  try {
    // Inside the lock: read the accurate tail. On timeout: use GENESIS_PREV_HASH
    // (forked prevHash is acceptable — chain is advisory, not a gate).
    const last = acquiredLock ? readLastShardRecord(paths, scope) : undefined;
    const prevHash = acquiredLock
      ? (last ? last.recordHash : GENESIS_PREV_HASH)
      : GENESIS_PREV_HASH;
    const seq = acquiredLock ? (last ? last.seq + 1 : 0) : rec.seq;

    const withPrev: Omit<LedgerRecord, "recordHash"> = { ...rec, seq, prevHash };
    const recordHash = computeLedgerRecordHash(withPrev);
    const sealed: LedgerRecord = { ...withPrev, recordHash };

    // Single-syscall append — atomic for one \n-terminated line on all major FSes.
    fs.appendFileSync(shardFile, JSON.stringify(sealed) + "\n", "utf8");
    return sealed;
  } finally {
    if (acquiredLock) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // ignore — lock cleanup failure does not affect the written record
      }
    }
  }
}

// ---------------------------------------------------------------------------
// verifyLedgerChain — AUDIT-ONLY (mirrors verifyReceiptChain in receipts.ts)
// ---------------------------------------------------------------------------

export type VerifyChainResult =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: "edited" | "prev_mismatch" };

/**
 * Walk records in file order and verify the SHA-256 hash chain.
 *
 * For each record: recompute recordHash from its canonical text — a mismatch
 * means the record was edited after it was appended. Then check
 * prevHash === expectedPrev — a mismatch means a record was inserted, deleted,
 * or reordered. Returns { ok:false, brokenAt:N } at the first break;
 * { ok:true } when every link is intact.
 *
 * AUDIT-ONLY: must NOT be called on the live residency path. readShardRecords
 * is the tolerant live reader; this function exists for offline integrity checks.
 * A forked chain (parallel writers using GENESIS_PREV_HASH) will surface here
 * as prev_mismatch, which is expected and diagnostic — it does not indicate
 * data loss, only that concurrent appends raced.
 */
export function verifyLedgerChain(records: LedgerRecord[]): VerifyChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const { recordHash, ...rest } = r;
    const recomputed = computeLedgerRecordHash(rest);
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
