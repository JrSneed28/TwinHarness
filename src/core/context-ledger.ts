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
import { readJsonlValues, scanTailValid, safeParseJson } from "./jsonl";
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
  // seq/epoch are turn-monotone ordinals consumed by deriveResidency's TTL
  // comparison; a NaN/Infinity/negative/float value must be rejected here so it
  // can never bypass the `nowTurn - seq <= TTL` check downstream.
  if (!Number.isInteger(r.seq) || (r.seq as number) < 0) return false;
  if (typeof r.ts !== "string" || r.ts === "") return false;
  if (typeof r.session_id !== "string" || r.session_id === "") return false;
  if (typeof r.agent_id !== "string") return false;
  if (typeof r.agent_type !== "string") return false;
  if (!Number.isInteger(r.epoch) || (r.epoch as number) < 0) return false;
  if (typeof r.op !== "string" || !OP_VALUES.has(r.op as LedgerOp)) return false;
  if (typeof r.page_id !== "string" || r.page_id === "") return false;
  if (typeof r.logical_key !== "string") return false;
  if (typeof r.content_hash !== "string") return false;
  if (r.base_hash !== undefined && typeof r.base_hash !== "string") return false;
  if (typeof r.complete !== "boolean") return false;
  if (!Number.isFinite(r.est_tokens) || (r.est_tokens as number) < 0) return false;
  if (typeof r.reduction_kind !== "string") return false;
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) return false;
  if (typeof r.recordHash !== "string" || !HEX64.test(r.recordHash)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Tolerant readers (mirror readJsonlValues / scanTailValid from jsonl.ts)
// ---------------------------------------------------------------------------

/**
 * Bytes read from the end of a shard by readShardRecordsTail. 256 KB holds many
 * hundreds of typical ledger lines — comfortably more than any residency window
 * needs — while keeping per-call cost constant regardless of total shard size.
 */
const TAIL_READ_BYTES = 256 * 1024;

/**
 * Read all valid records from a shard in file order. Missing file → [].
 * Unparseable / schema-invalid lines are silently skipped — tolerant, never throws.
 * Chain integrity is NOT checked here; use verifyLedgerChain for that (audit-only).
 */
export function readShardRecords(paths: ProjectPaths, scope: LedgerScope): LedgerRecord[] {
  return readJsonlValues(ledgerShardPath(paths, scope), isValidLedgerRecord);
}

/**
 * Bounded tail read: the last `maxRecords` valid records of a shard, in file
 * order. Missing file → []. Unparseable / schema-invalid lines are skipped and
 * a torn (partial) first line of the read window is dropped, exactly like
 * readShardRecords — tolerant, never throws.
 *
 * Why bounded: the live residency path (PostToolUse) previously read+parsed the
 * ENTIRE shard on every tool call — O(N) per call, O(N²) per session, unbounded
 * as the shard grows. This reader bounds the BYTES read: it reads only the last
 * window of the file (TAIL_READ_BYTES) via a file descriptor, so cost is constant
 * regardless of shard size. Because deriveResidency only matches pages within the
 * RESIDENCY_TTL_TURNS window, a caller passing maxRecords comfortably larger than
 * that window observes identical residency outcomes to a full read for any
 * realistic shard.
 */
export function readShardRecordsTail(
  paths: ProjectPaths,
  scope: LedgerScope,
  maxRecords: number,
): LedgerRecord[] {
  if (maxRecords <= 0) return [];
  const file = ledgerShardPath(paths, scope);

  let buf: Buffer;
  let readWholeFile: boolean;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_READ_BYTES);
    readWholeFile = start === 0;
    const length = size - start;
    if (length <= 0) return [];
    buf = Buffer.allocUnsafe(length);
    const fd = fs.openSync(file, "r");
    try {
      let off = 0;
      while (off < length) {
        const n = fs.readSync(fd, buf, off, length - off, start + off);
        if (n <= 0) break;
        off += n;
      }
      buf = buf.subarray(0, off);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return []; // missing file → []
    // Any other I/O failure → fall back to the tolerant full reader, then bound.
    const all = readJsonlValues(file, isValidLedgerRecord);
    return all.length > maxRecords ? all.slice(all.length - maxRecords) : all;
  }

  const lines = buf.toString("utf8").split(/\r?\n/);
  // If we did NOT read from byte 0, the first line is almost certainly a partial
  // (torn) line straddling the read window boundary — drop it. readJsonlValues
  // would skip it as unparseable anyway; dropping explicitly avoids accidentally
  // accepting a fragment that happens to parse.
  const startIdx = readWholeFile ? 0 : 1;
  const out: LedgerRecord[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    const parsed = safeParseJson(trimmed);
    if (parsed !== undefined && isValidLedgerRecord(parsed)) out.push(parsed);
  }
  return out.length > maxRecords ? out.slice(out.length - maxRecords) : out;
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

/**
 * Milliseconds we wait to acquire the shard lock before falling back to an
 * unlocked appendFileSync. A shorter ceiling than the state lock (25s) because
 * a ledger append is a fast, lock-scope-narrow operation.
 */
const SHARD_LOCK_TIMEOUT_MS = 5_000;

/**
 * Milliseconds before the shard lock dir is considered stale and may be stolen.
 * Deliberately MUCH greater than SHARD_LOCK_TIMEOUT_MS: a holder that is still
 * within its acquire-and-write window must NEVER have its lock reclaimed, or two
 * writers would interleave appends and fork the chain. Only a genuinely crashed
 * holder (no progress for ≥30s, far beyond any single fast append) is reclaimed.
 */
const SHARD_LOCK_STALE_MS = 30_000;

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
 * On lock-timeout: falls back to a single-syscall appendFileSync, but FIRST does
 * a best-effort tail re-read (readLastShardRecord) to derive prevHash/seq from
 * the current tail, minimizing forks and seq collisions even on the unlocked
 * path. Only if that read throws do we fall back to GENESIS_PREV_HASH / seq=0.
 * The record is always written, never silently dropped (forked chain links are
 * tolerated — matches external-receipts precedent in receipts.ts §682–684).
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
    // Read the accurate tail to seed prevHash/seq. Under the lock this is
    // authoritative; on lock-timeout it is best-effort (a concurrent writer may
    // append between our read and write) but still far better than forcing
    // GENESIS/seq=0, which guarantees a fork + seq collision on every fallback.
    let last: LedgerRecord | undefined;
    if (acquiredLock) {
      last = readLastShardRecord(paths, scope);
    } else {
      try {
        last = readLastShardRecord(paths, scope);
      } catch {
        last = undefined; // read failed → safe GENESIS / seq=0 fallback below
      }
    }
    const prevHash = last ? last.recordHash : GENESIS_PREV_HASH;
    const seq = last ? last.seq + 1 : 0;

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
