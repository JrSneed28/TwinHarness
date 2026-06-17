/**
 * Append-only gate-mutation ledger (audit finding F5).
 *
 * The mechanical gates (Stop-gate, write-gate) only bind a *compliant* agent:
 * the orchestrator legitimately sets `implementation_allowed`, the blast-radius
 * `tier`, and resolves blocking drift via the same `th` CLI. The CLI cannot tell
 * *who* invoked it (the agent runs every `th` command), so this ledger does NOT
 * claim provenance — it provides a timestamped, append-only RECORD of every
 * gate-relevant state change so a human reviewing afterwards can see exactly
 * when `implementation_allowed` flipped, when blocking drift opened/closed, etc.
 *
 * It is observability, not enforcement: it never blocks a mutation. Writes are
 * best-effort and must never crash a command. The ledger lives next to the state
 * it audits (`<stateDir>/gate-ledger.jsonl`), one JSON object per line.
 *
 * TAMPER-EVIDENCE (GOV-2). Each NEW entry is sealed into a SHA-256 hash chain —
 * `prevHash` (the previous sealed entry's `recordHash`, GENESIS for the first)
 * plus `recordHash` (this entry's own canonical-text hash) — mirroring the
 * decision ledger (`src/core/decisions.ts`). An actor who edits, reorders, or
 * deletes a sealed entry breaks the chain detectably (`verifyLedgerChain`).
 *
 * Two deliberate differences from the decision ledger:
 *   1. Payload keys are DYNAMIC (`[key]: unknown`), so the canonical text sorts
 *      keys lexicographically instead of using a fixed field order.
 *   2. `ts` is PART of the sealed content (the gate ledger is intentionally
 *      clock-bearing), so backdating `ts` on a sealed entry is itself a tamper
 *      signal. Determinism (REQ-NFR-001) still holds: for a GIVEN entry (its `ts`
 *      included) the hash is identical on every OS — `hashContent` is clock-free
 *      and CRLF→LF-normalized; the only non-determinism is the `ts` captured at
 *      append time, which becomes immutable sealed content thereafter.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";

// GENESIS_PREV_HASH + HEX64 are shared with the decision ledger and now live in
// core/hash.ts (#14 dedup). Re-export GENESIS_PREV_HASH so existing importers
// (`import { GENESIS_PREV_HASH } from "./ledger"`) keep working unchanged.
export { GENESIS_PREV_HASH };

/** Top-level state keys whose mutation is gate-relevant and therefore audited. */
export const GATE_LEDGER_KEYS = new Set<string>([
  "implementation_allowed",
  "drift_open_blocking",
  "debate_open_blocking",
  "write_gate",
  "tier",
  "blast_radius_flags",
]);

export interface LedgerEntry {
  /** ISO-8601 UTC timestamp (audit record — intentionally clock-bearing). */
  ts: string;
  /** Event kind, e.g. "gate-state-change", "drift-blocking-opened". */
  event: string;
  /**
   * SHA-256 hex (64) of the prior SEALED entry's `recordHash`, or GENESIS for the
   * first sealed entry. Optional so legacy (pre-migration) lines stay readable.
   */
  prevHash?: string;
  /**
   * SHA-256 hex (64) of THIS entry's canonical text (computed before set, with
   * `recordHash` excluded). Optional so legacy lines stay readable; its presence
   * is what marks an entry as SEALED.
   */
  recordHash?: string;
  [key: string]: unknown;
}

/** `<stateDir>/gate-ledger.jsonl` — the audit record's location. */
export function ledgerPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "gate-ledger.jsonl");
}

// ---------------------------------------------------------------------------
// Canonical text + hashing (GOV-2) — the tamper-evidence core
// ---------------------------------------------------------------------------

/**
 * Deterministic canonical text of an entry for hashing. Because payload keys are
 * DYNAMIC (unlike the decision ledger's fixed field order), every own key is
 * emitted with keys SORTED lexicographically — `recordHash` is EXCLUDED (it is
 * the hash output, not input), `prevHash` is INCLUDED (it chains the record).
 * `JSON.stringify` with no indentation; `hashContent` then CRLF→LF normalizes
 * (harmless — the canonical text contains no CRLF). Key-order-independent: the
 * same logical entry hashes identically regardless of property insertion order.
 */
export function ledgerCanonicalText(entry: Omit<LedgerEntry, "recordHash">): string {
  const ordered: Record<string, unknown> = {};
  // Only TOP-LEVEL keys are sorted. Payload values must be primitives or flat
  // arrays (all callers pass string/number/boolean/string[] — e.g.
  // blast_radius_flags); a nested OBJECT value would NOT be key-normalized, so do
  // not seal one without extending this canonicalizer.
  for (const key of Object.keys(entry).sort()) {
    if (key === "recordHash") continue; // never an input to its own hash
    const val = (entry as Record<string, unknown>)[key];
    if (val === undefined) continue; // omit absent keys (mirrors decisions)
    ordered[key] = val;
  }
  return JSON.stringify(ordered);
}

/** `recordHash` for an entry = SHA-256 of its canonical text (recordHash omitted). */
export function computeLedgerRecordHash(entry: Omit<LedgerEntry, "recordHash">): string {
  return hashContent(ledgerCanonicalText(entry));
}

// ---------------------------------------------------------------------------
// Tail read (PERF — mirrors readLastDecisionRecordHash) — last sealed link only
// ---------------------------------------------------------------------------

/**
 * The `recordHash` of the ledger's last SEALED entry — the only thing
 * `appendLedger` needs to chain the next link. Reads the file once but parses
 * only the TAIL: it walks lines from the end and `JSON.parse`s just enough to
 * find the last non-empty line that carries a valid `recordHash`, returning it.
 * Missing/empty file, or no sealed tail line (a fully-legacy ledger), →
 * `GENESIS_PREV_HASH` (so the first NEW sealed entry anchors the chain).
 *
 * Tail-only (not a full `readLedger`) so N appends stay O(N) total, not O(N²)
 * (mirrors `readLastDecisionRecordHash`). Tolerant: a malformed / partial-tail
 * line, or a legacy unsealed line, is skipped while scanning upward.
 */
export function readLastLedgerRecordHash(paths: ProjectPaths): string {
  const file = ledgerPath(paths);
  if (!fs.existsSync(file)) return GENESIS_PREV_HASH;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const rh = (parsed as Record<string, unknown>).recordHash;
        if (typeof rh === "string" && HEX64.test(rh)) return rh;
        // A legacy (unsealed) line — keep scanning upward for a sealed one.
      }
    } catch {
      // Tolerant: skip a malformed / partial-tail line and keep scanning.
    }
  }
  return GENESIS_PREV_HASH;
}

/**
 * Append one entry to the gate ledger, sealing it into the hash chain.
 * Best-effort: a ledger failure must NEVER crash the command that triggered it
 * (mirrors `structuredLog`). The `ts` is captured here and becomes part of the
 * sealed content. `prevHash` is the last sealed entry's `recordHash` (GENESIS
 * when none — the migration anchor for a fresh or fully-legacy ledger), derived
 * from a tail read so N appends are O(N) total. The serialized line stores every
 * field INCLUDING `recordHash`; the hash itself is over the canonical text
 * WITHOUT `recordHash`.
 */
export function appendLedger(paths: ProjectPaths, entry: Omit<LedgerEntry, "ts" | "prevHash" | "recordHash">): void {
  try {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const prevHash = readLastLedgerRecordHash(paths);
    // Build the unsealed entry first (the ts captured here becomes sealed
    // content), hash it, then seal. LedgerEntry's index signature (`[key]:
    // unknown`) widens the spread of `entry`'s keys to `unknown`, so we assemble a
    // plain record and assert the LedgerEntry shape — ts/event/prevHash/recordHash
    // are provably present and string-typed below.
    const withPrev: Record<string, unknown> = { ts: new Date().toISOString(), ...entry, prevHash };
    const recordHash = computeLedgerRecordHash(withPrev as Omit<LedgerEntry, "recordHash">);
    const sealed = { ...withPrev, recordHash } as LedgerEntry;
    fs.appendFileSync(ledgerPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  } catch {
    // Never throw from the audit path.
  }
}

/** Read + parse every ledger entry. Missing file → empty. Bad lines skipped. */
export function readLedger(paths: ProjectPaths): LedgerEntry[] {
  const file = ledgerPath(paths);
  if (!fs.existsSync(file)) return [];
  const out: LedgerEntry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null) out.push(parsed as LedgerEntry);
    } catch {
      // Skip malformed lines; the ledger is append-only and tolerant.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// verifyLedgerChain (GOV-2) — tamper-detecting chain walk with migration anchor
// ---------------------------------------------------------------------------

export type VerifyLedgerResult =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: "edited" | "prev_mismatch" };

/**
 * Verify the tamper-evidence chain over the ledger's SEALED entries.
 *
 * MIGRATION / BACK-COMPAT (CRITICAL). Existing ledgers predate sealing: their
 * leading lines have NO `recordHash`. Those legacy/unsealed entries form an
 * unverifiable PRE-MIGRATION PREFIX that is NOT a tamper signal — we cannot
 * recompute a chain that was never written. So this walks only the CONTIGUOUS
 * RUN OF SEALED entries (those carrying a `recordHash`): it skips the leading
 * legacy prefix, then anchors the first sealed entry's `prevHash` to GENESIS
 * (the migration anchor — the first seal starts a fresh chain) and walks the
 * rest. A sealed entry appearing AFTER the run begins but missing its own
 * `recordHash` is treated as a deletion/tamper within the sealed run
 * ("prev_mismatch" surfaces at the next sealed line whose `prevHash` no longer
 * matches). Indices in the result are absolute (into the passed `entries`).
 *
 * Within the sealed run: recompute each entry's `recordHash` from its canonical
 * text — a mismatch means the record was edited (a forged/swapped/backdated
 * field, since `ts` is sealed) → "edited". If `prevHash !== expectedPrev` the
 * line was inserted, deleted, or reordered → "prev_mismatch". Return the first
 * break; else advance `expectedPrev = entry.recordHash`. Any single-record
 * mutation breaks that record's `recordHash` AND every subsequent `prevHash`, so
 * one linear pass detects tampering.
 */
export function verifyLedgerChain(entries: LedgerEntry[]): VerifyLedgerResult {
  // Locate the first SEALED entry; everything before it is the legacy prefix.
  let start = -1;
  for (let i = 0; i < entries.length; i++) {
    const rh = entries[i]!.recordHash;
    if (typeof rh === "string" && HEX64.test(rh)) {
      start = i;
      break;
    }
  }
  if (start === -1) return { ok: true }; // fully-legacy (unsealed) ledger — nothing to verify

  let expectedPrev = GENESIS_PREV_HASH; // first sealed entry anchors to GENESIS
  for (let i = start; i < entries.length; i++) {
    const e = entries[i]!;
    const { recordHash, ...rest } = e;
    // A sealed run must remain sealed: a missing/invalid recordHash inside the run
    // is itself tamper (a deleted seal). recomputed !== (undefined) → "edited".
    const recomputed = computeLedgerRecordHash(rest);
    if (recomputed !== recordHash) {
      return { ok: false, brokenAt: i, reason: "edited" };
    }
    if ((e.prevHash ?? GENESIS_PREV_HASH) !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: "prev_mismatch" };
    }
    expectedPrev = recordHash!;
  }
  return { ok: true };
}
