/**
 * context-pages.ts — Pure `CommandResult` handlers for the `th context-pages`
 * command group (D-19, S0 OBSERVE-only + S1+ mechanisms).
 *
 * Shared dispatcher `runContextPagesCommand` is the ONE entry point reused by
 * both the CLI and the `th_context` MCP tool (AC-10 parity invariant).
 *
 * Human-only ops (gc, baseline, purge) are dispatched through CLI only — they
 * are absent from the MCP enum and listed in MCP_EXCLUDED.
 *
 * S0 operations (CLI + MCP, read-only):
 *   page-status  — shard inventory: file count, record counts, unique pages.
 *   residency    — records with op="deliver" (no suppressions at S0).
 *   telemetry    — raw telemetry.jsonl records (tail, bounded by `limit`).
 *   savings      — aggregate telemetry dedup savings (0% at S0).
 *
 * S1+ operations (CLI + MCP, read-only):
 *   verify       — verifyLedgerChain audit on all shard records.
 *   rehydrate    — fetch a page from cold store by page_id or logical_key;
 *                  GC-evicted or sensitive objects → re-derive FULL (never errors).
 *   compare      — runEquivalence on two corpus RunArtifacts.
 *
 * Human-only operations (CLI only, MCP_EXCLUDED):
 *   baseline     — S0 token denominator + optional RunArtifact corpus write.
 *   gc           — remove cold objects older than N days (default 5); NEVER
 *                  removes ledger records (5d).
 *   purge        — remove all context-pages data.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { contextPagesRoot, coldStoreGet } from "../core/context-page";
import { type LedgerRecord, verifyLedgerChain } from "../core/context-ledger";
import { type TelemetryRecord, telemetryFilePath, transcriptActuals } from "../core/context-telemetry";
import { readJsonlValues } from "../core/jsonl";
import {
  runEquivalence,
  readCorpusEntry,
  writeCorpusEntry,
  WORKLOAD_CATEGORIES,
  type RunArtifact,
} from "../core/context-equivalence";
import { computeSavings, type SavingsResult } from "../core/savings";
import { priceAvoided, parseTranscriptModelId } from "../core/pricing";
import { renderDetail } from "../core/savings-render";

// ---------------------------------------------------------------------------
// Valid operation set (CLI + MCP-shared; gc/baseline/purge are CLI-only)
// ---------------------------------------------------------------------------

const ALL_OPS = new Set([
  // S0 (CLI + MCP)
  "page-status", "residency", "telemetry", "savings", "savings-detail",
  // S1+ (CLI + MCP)
  "verify", "rehydrate", "compare",
  // Human-only (CLI only)
  "baseline", "gc", "purge",
]);

// ---------------------------------------------------------------------------
// Local validators (tolerant — mirror context-ledger / context-telemetry shapes)
// ---------------------------------------------------------------------------

/** Minimal shape predicate for LedgerRecord lines (tolerant reader). */
function isLedgerRec(v: unknown): v is LedgerRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.seq === "number" &&
    typeof r.ts === "string" &&
    typeof r.session_id === "string" &&
    typeof r.page_id === "string" &&
    typeof r.op === "string" &&
    typeof r.recordHash === "string"
  );
}

/** Minimal shape predicate for TelemetryRecord lines (tolerant reader). */
function isTelemetryRec(v: unknown): v is TelemetryRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.ts === "string" && typeof r.session_id === "string" && typeof r.epoch === "number";
}

// ---------------------------------------------------------------------------
// Helpers — enumerate shards and read all records
// ---------------------------------------------------------------------------

/**
 * Enumerate all `ledger-*.jsonl` shard file paths inside the context-pages
 * directory.  Returns [] when the directory is absent (first run).
 */
function listShardFiles(pagesRoot: string): string[] {
  try {
    if (!fs.existsSync(pagesRoot)) return [];
    return fs
      .readdirSync(pagesRoot)
      .filter((name) => name.startsWith("ledger-") && name.endsWith(".jsonl"))
      .map((name) => path.join(pagesRoot, name));
  } catch {
    return [];
  }
}

/**
 * Read all valid LedgerRecord lines from every shard file.
 * Tolerant: missing dir, unreadable file, garbled lines — all skipped.
 */
function readAllLedgerRecords(paths: ProjectPaths): LedgerRecord[] {
  const pagesRoot = contextPagesRoot(paths);
  const shards = listShardFiles(pagesRoot);
  const out: LedgerRecord[] = [];
  for (const file of shards) {
    const records = readJsonlValues(file, isLedgerRec);
    out.push(...records);
  }
  return out;
}

/**
 * Order two ledger records by recency: ts (ISO-8601, lexical == chronological),
 * then per-shard seq, then recordHash as a stable content-addressed tiebreaker.
 * Returns >0 when `a` is newer than `b`. Deterministic regardless of the order
 * shards were read from disk. (#5)
 */
function ledgerRecencyCompare(a: LedgerRecord, b: LedgerRecord): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.recordHash !== b.recordHash) return a.recordHash < b.recordHash ? -1 : 1;
  return 0;
}

/**
 * Read all valid TelemetryRecord lines from telemetry.jsonl.
 * Tolerant: missing file, garbled lines — returns [].
 */
function readAllTelemetryRecords(paths: ProjectPaths): TelemetryRecord[] {
  return readJsonlValues(telemetryFilePath(paths), isTelemetryRec);
}

// ---------------------------------------------------------------------------
// Handler: page-status
// ---------------------------------------------------------------------------

/**
 * Report the ledger shard inventory: one row per shard file with its record
 * count, plus totals (total_records, unique_pages).  S0-safe read.
 *
 * data: { shards, total_records, unique_pages, pages_root }
 */
function handlePageStatus(
  _args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const pagesRoot = contextPagesRoot(paths);
  const shardFiles = listShardFiles(pagesRoot);

  const shards: Array<{ file: string; records: number }> = [];
  const allPageIds = new Set<string>();
  let totalRecords = 0;

  for (const file of shardFiles) {
    const records = readJsonlValues(file, isLedgerRec);
    for (const r of records) allPageIds.add(r.page_id);
    shards.push({ file: path.basename(file), records: records.length });
    totalRecords += records.length;
  }

  const uniquePages = allPageIds.size;

  const human = [
    `Context-pages directory: ${pagesRoot}`,
    `Shards: ${shards.length}`,
    ...shards.map((s) => `  ${s.file}: ${s.records} record(s)`),
    `Total records : ${totalRecords}`,
    `Unique page_ids: ${uniquePages}`,
  ].join("\n");

  return success({
    data: { shards, total_records: totalRecords, unique_pages: uniquePages, pages_root: pagesRoot },
    human,
  });
}

// ---------------------------------------------------------------------------
// Handler: residency
// ---------------------------------------------------------------------------

/**
 * List pages currently considered resident (op="deliver"; at S0 no invalidations
 * exist, so all deliver records are resident).  Optionally filtered by session_id
 * when `args.session_id` is present.
 *
 * data: { resident_count, records: [{ page_id, logical_key, content_hash, est_tokens, reduction_kind, session_id, ts }] }
 */
function handleResidency(
  args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const sessionFilter = typeof args.session_id === "string" ? args.session_id : undefined;

  let records = readAllLedgerRecords(paths).filter((r) => r.op === "deliver");
  if (sessionFilter !== undefined) {
    records = records.filter((r) => r.session_id === sessionFilter);
  }

  // Deduplicate: if the same page_id appears multiple times, keep the latest.
  const byPageId = new Map<string, LedgerRecord>();
  for (const r of records) byPageId.set(r.page_id, r);
  const resident = [...byPageId.values()].sort((a, b) => a.seq - b.seq);

  const summary = resident.map((r) => ({
    page_id: r.page_id,
    logical_key: r.logical_key,
    content_hash: r.content_hash,
    est_tokens: r.est_tokens,
    reduction_kind: r.reduction_kind,
    session_id: r.session_id,
    ts: r.ts,
  }));

  const human = [
    `Resident pages: ${resident.length}${sessionFilter ? ` (session: ${sessionFilter})` : ""}`,
    ...summary.map((r) => `  ${r.page_id}  ${r.logical_key}  (${r.est_tokens} tok, ${r.reduction_kind})`),
  ].join("\n");

  return success({ data: { resident_count: resident.length, records: summary }, human });
}

// ---------------------------------------------------------------------------
// Handler: telemetry
// ---------------------------------------------------------------------------

/**
 * Dump recent telemetry records from telemetry.jsonl.  `args.limit` (default 50)
 * caps the number of records returned (tail of the file).
 *
 * data: { count, total, records: [...] }
 */
function handleTelemetry(
  args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 50;
  const all = readAllTelemetryRecords(paths);
  const tail = all.slice(-limit);

  const human = [
    `Telemetry records: ${all.length} total (showing last ${tail.length})`,
    `File: ${telemetryFilePath(paths)}`,
    ...tail.map(
      (r) =>
        `  [${r.ts}] sess=${r.session_id} epoch=${r.epoch}` +
        (r.tool_type ? ` tool=${r.tool_type}` : "") +
        (r.orig_tokens !== undefined ? ` orig=${r.orig_tokens}tok` : "") +
        (r.dup_avoided ? " DUP_AVOIDED" : ""),
    ),
  ].join("\n");

  return success({ data: { count: tail.length, total: all.length, records: tail }, human });
}

// ---------------------------------------------------------------------------
// Handler: savings
// ---------------------------------------------------------------------------

/**
 * Aggregate deduplication savings from telemetry.jsonl.  At S0 savings are
 * always 0% because no suppression is applied — this is intentional: S0 is
 * OBSERVE-only with savings target = 0%.
 *
 * Accepts an optional `session_id` to scope the savings calc to a single
 * session (AC-22, AC-26).  `TH_EXACT_SUPPRESS=1` activates suppress mode.
 *
 * data: {
 *   savings_pct,          — deprecated-in-place (I3/M6); old all-records/no-payback formula
 *   saved_pct,            — new session-scoped figure (result.saved_pct)
 *   orig_tokens, returned_tokens, delta_tokens, dup_avoided_count, record_count,
 *   savings,              — full SavingsResult (B1 shape)
 * }
 */
function handleSavings(
  args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const records = readAllTelemetryRecords(paths);
  const session_id = typeof args.session_id === "string" ? args.session_id : undefined;
  const suppressMode = process.env.TH_EXACT_SUPPRESS === "1";

  // Deprecated-in-place legacy aggregates (I3/M6 — do not rename savings_pct).
  // Old formula: all-records, no payback, no session filter.
  let origTokens = 0;
  let returnedTokens = 0;
  let deltaTokens = 0;
  let dupAvoidedCount = 0;

  for (const r of records) {
    origTokens += r.orig_tokens ?? 0;
    returnedTokens += r.returned_tokens ?? r.orig_tokens ?? 0;
    deltaTokens += r.delta_tokens ?? 0;
    if (r.dup_avoided) dupAvoidedCount++;
  }

  // S0: no suppression, so savings_pct is always 0.
  const savingsPct = origTokens > 0 ? Math.round(((origTokens - returnedTokens) / origTokens) * 10000) / 100 : 0;

  // New session-scoped, per-cycle-netted savings calculation (B1).
  const result: SavingsResult = computeSavings(records, { session_id, suppressMode });

  const human = [
    `Savings: ${result.saved_pct}% — ${result.headline_label}`,
    `  Original tokens : ${origTokens}`,
    `  Returned tokens : ${returnedTokens}`,
    `  Delta tokens    : ${deltaTokens}`,
    `  Dups avoided    : ${dupAvoidedCount}`,
    `  Records         : ${records.length}`,
  ].join("\n");

  return success({
    data: {
      // Deprecated-in-place (I3/M6 — do not rename; old all-records/no-payback semantics).
      savings_pct: savingsPct,
      // New session-scoped savings fields (AC-22, AC-26).
      saved_pct: result.saved_pct,
      orig_tokens: origTokens,
      returned_tokens: returnedTokens,
      delta_tokens: deltaTokens,
      dup_avoided_count: dupAvoidedCount,
      record_count: records.length,
      savings: result,
    },
    human,
  });
}

// ---------------------------------------------------------------------------
// Handler: savings-detail
// ---------------------------------------------------------------------------

/**
 * Extended savings view: everything `savings` returns, plus a whole-window
 * estimate (from an optional `transcript_path`), per-category breakdown, a
 * separately-labeled provider prompt-cache line, and a USD cost estimate.
 *
 * Privacy: only aggregate numbers, category names, and labels are emitted —
 * never raw content, logical keys, or transcript path contents (AC-24).
 *
 * data: {
 *   savings_pct, saved_pct, orig_tokens, returned_tokens, record_count, savings,
 *   whole_window, cost_usd, cost_label, model_id, cache_label
 * }
 */
function handleSavingsDetail(
  args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const records = readAllTelemetryRecords(paths);
  const session_id = typeof args.session_id === "string" ? args.session_id : undefined;
  const suppressMode = process.env.TH_EXACT_SUPPRESS === "1";
  const transcriptPath = typeof args.transcript_path === "string" ? args.transcript_path : undefined;

  const result: SavingsResult = computeSavings(records, { session_id, suppressMode });

  // Whole-window estimate from transcript (labeled [estimated] per plan Principle 1).
  const actuals = transcriptPath !== undefined ? transcriptActuals(transcriptPath) : undefined;

  // USD cost: priced against avoided input tokens (AC-10–13).
  const modelId = transcriptPath !== undefined ? parseTranscriptModelId(transcriptPath) : undefined;
  const pricing = priceAvoided(result.avoided_input_tokens, modelId);

  // Provider prompt-cache is a separately-labeled line (AC-13): NOT part of
  // avoided dedup savings. Label [estimated] when a transcript was supplied
  // (the file exists and we could read it), [unavailable] when not.
  const cacheLabel = transcriptPath !== undefined ? "[estimated]" : "[unavailable]";

  // Deprecated-in-place legacy aggregates (I3/M6 — do not rename savings_pct).
  let origTokens = 0;
  let returnedTokens = 0;
  for (const r of records) {
    origTokens += r.orig_tokens ?? 0;
    returnedTokens += r.returned_tokens ?? r.orig_tokens ?? 0;
  }
  const savingsPct = origTokens > 0 ? Math.round(((origTokens - returnedTokens) / origTokens) * 10000) / 100 : 0;

  const human = [
    renderDetail(result, pricing.label),
    `  whole-window:   ${
      actuals !== undefined
        ? `input=${actuals.input_tokens} tok, output=${actuals.output_tokens} tok` +
          (actuals.context_window !== undefined ? `, window=${actuals.context_window}` : "") +
          " [estimated]"
        : "[unavailable]"
    }`,
    `  provider-cache: ${cacheLabel} (separate from dedup savings)`,
    `  cost:           ${pricing.label}${pricing.cost_usd !== null ? ` ($${pricing.cost_usd.toFixed(4)} USD)` : ""}`,
  ].join("\n");

  return success({
    data: {
      // Deprecated-in-place (I3/M6 — do not rename; old all-records/no-payback semantics).
      savings_pct: savingsPct,
      // New session-scoped savings fields (AC-22, AC-26).
      saved_pct: result.saved_pct,
      orig_tokens: origTokens,
      returned_tokens: returnedTokens,
      record_count: records.length,
      savings: result,
      // Whole-window estimate (transcript-derived, labeled [estimated]/[unavailable]).
      whole_window: actuals !== undefined
        ? {
            input_tokens: actuals.input_tokens,
            output_tokens: actuals.output_tokens,
            ...(actuals.context_window !== undefined ? { context_window: actuals.context_window } : {}),
            label: "[estimated]",
          }
        : { label: "[unavailable]" },
      // USD cost estimate (pricing snapshot, separately labeled).
      cost_usd: pricing.cost_usd,
      cost_label: pricing.label,
      model_id: pricing.model_id,
      // Provider prompt-cache line (AC-13): separate from dedup savings.
      cache_label: cacheLabel,
    },
    human,
  });
}

// ---------------------------------------------------------------------------
// Handler: baseline (CLI-only / human-only)
// ---------------------------------------------------------------------------

/**
 * S0 baseline denominator: total orig_tokens and record count from telemetry.
 * Also writes a RunArtifact to the corpus when `args.session_id` is supplied,
 * enabling future `compare` and equivalence-harness runs.
 *
 * Human-only / CLI-only (absent from the MCP enum).
 *
 * data: { baseline_tokens, record_count, tier, epoch, pages_root, corpus_written }
 */
function handleBaseline(
  args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const records = readAllTelemetryRecords(paths);
  const baselineTokens = records.reduce((acc, r) => acc + (r.orig_tokens ?? 0), 0);
  const pagesRoot = contextPagesRoot(paths);

  // S1+: optionally write a RunArtifact baseline to the corpus.
  const sessionId = typeof args.session_id === "string" && args.session_id.length > 0
    ? args.session_id
    : undefined;
  let corpusWritten = false;
  if (sessionId) {
    const artifact: RunArtifact = {
      session_id: sessionId,
      workload_category: "planning",
      ts: new Date().toISOString(),
      token_usage: {
        origTokens: baselineTokens,
        returnedTokens: baselineTokens, // S0: no reduction
      },
    };
    corpusWritten = writeCorpusEntry(paths, artifact);
  }

  const human = [
    `S0 baseline (OBSERVE-only, savings target = 0%)`,
    `  Baseline tokens : ${baselineTokens}`,
    `  Record count    : ${records.length}`,
    `  Tier            : s0`,
    `  Pages root      : ${pagesRoot}`,
    ...(sessionId
      ? [`  Corpus entry    : ${corpusWritten ? "written" : "write failed"} (session=${sessionId})`]
      : []),
  ].join("\n");

  return success({
    data: {
      baseline_tokens: baselineTokens,
      record_count: records.length,
      tier: "s0",
      epoch: 0,
      pages_root: pagesRoot,
      corpus_written: corpusWritten,
    },
    human,
  });
}

// ---------------------------------------------------------------------------
// Handler: verify (S1+)
// ---------------------------------------------------------------------------

/**
 * Audit-only ledger chain verification.  Reads ALL shard records and calls
 * `verifyLedgerChain` to recompute every hash and check the prevHash links.
 * A forked chain (concurrent writers using GENESIS_PREV_HASH) surfaces as
 * `prev_mismatch` — diagnostic, not data loss.
 *
 * States are distinguishable via `status`: "verified" (chains intact),
 * "empty" (no shards to verify), "broken" (a chain failed), and "unknown" (a
 * read/verify error — reported as ok:false/verified:false, NOT a false PASS).
 * Always non-blocking (advisory): the command exits zero in every state.
 *
 * data: { ok, status, verified, record_count, shard_count?, broken_at?, reason?, blocking? }
 */
function handleVerify(
  _args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  try {
    // Each shard is an independent GENESIS-anchored chain, so verify shard-by-shard.
    // Flattening all shards into one verifyLedgerChain call false-failed with
    // prev_mismatch the moment a second shard existed (its first record re-anchors
    // at GENESIS, which never matches the prior shard's tail). (#5)
    const pagesRoot = contextPagesRoot(paths);
    const shardFiles = listShardFiles(pagesRoot);
    let recordCount = 0;
    for (const file of shardFiles) {
      const records = readJsonlValues(file, isLedgerRec);
      recordCount += records.length;
      const result = verifyLedgerChain(records);
      if (!result.ok) {
        const shard = path.basename(file);
        return success({
          data: {
            ok: false,
            status: "broken",
            verified: false,
            record_count: recordCount,
            shard_count: shardFiles.length,
            shard,
            broken_at: result.brokenAt,
            reason: result.reason,
          },
          human: `Ledger chain: FAIL — shard ${shard} broken at record ${result.brokenAt} (${result.reason}).`,
        });
      }
    }
    // Distinguish a genuinely-empty store from a verified one. An empty store has
    // nothing to verify; a non-empty store passed every shard's chain check.
    const empty = shardFiles.length === 0;
    return success({
      data: {
        ok: true,
        status: empty ? "empty" : "verified",
        verified: true,
        record_count: recordCount,
        shard_count: shardFiles.length,
      },
      human: empty
        ? "Ledger chain: no ledger shards found (empty store)."
        : `Ledger chain: PASS — ${shardFiles.length} shard(s), ${recordCount} record(s) verified.`,
    });
  } catch {
    // Fail-safe: never throw across a handler boundary (D-16). A read/verify
    // failure is NOT proof of a clean ledger — surfacing ok:true here would let
    // automation mistake "could not read" for "verified", violating the broader
    // rule that unknown evidence must never be presented as proof. Return a
    // DISTINCT unknown/unverified state instead. Still non-blocking (advisory):
    // CommandResult stays a success() so the command exits zero. (#3)
    return success({
      data: {
        ok: false,
        status: "unknown",
        verified: false,
        blocking: false,
        record_count: 0,
        reason: "read_error_passthrough",
      },
      human: "Ledger chain: UNKNOWN — could not read or verify ledger (advisory, non-blocking).",
    });
  }
}

// ---------------------------------------------------------------------------
// Handler: rehydrate (S1+)
// ---------------------------------------------------------------------------

/**
 * Fetch a page's content from the CAS cold store by `page_id` or `logical_key`.
 * The most recent matching ledger record is used to resolve the `content_hash`.
 *
 * GC-evicted or sensitive objects (absent from cold store) → never errors:
 * returns `gc_evicted: true` with the `logical_key` so the caller can re-derive
 * the page FULL from its source (D-06 — never throws, fail-safe).
 *
 * data: { found, gc_evicted, page_id, logical_key, content_hash, content?, est_tokens? }
 */
function handleRehydrate(
  args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const pageId = typeof args.page_id === "string" && args.page_id.length > 0 ? args.page_id : undefined;
  const logicalKey = typeof args.logical_key === "string" && args.logical_key.length > 0 ? args.logical_key : undefined;

  if (!pageId && !logicalKey) {
    return failure({
      human: "rehydrate requires page_id or logical_key.",
      data: { error: "missing_args" },
    });
  }

  try {
    const records = readAllLedgerRecords(paths);

    // Select the most recent matching record DETERMINISTICALLY. The previous
    // tail-to-head scan trusted the flattened shard order (readdir order), which
    // is not chronological — so "latest" could vary by filesystem. Rank by ts
    // (ISO-8601, lexical == chronological), then per-shard seq, then recordHash
    // as a stable content-addressed tiebreaker. (#5)
    let match: LedgerRecord | undefined;
    for (const r of records) {
      if (!((pageId && r.page_id === pageId) || (logicalKey && r.logical_key === logicalKey))) continue;
      if (match === undefined || ledgerRecencyCompare(r, match) > 0) match = r;
    }

    if (!match) {
      return success({
        data: { found: false, page_id: pageId ?? null, logical_key: logicalKey ?? null },
        human: `No ledger record found for ${pageId ? `page_id=${pageId}` : `logical_key=${logicalKey}`}.`,
      });
    }

    // Try to fetch content from cold store.
    const content = coldStoreGet(paths, match.content_hash);
    if (content === undefined) {
      // GC-evicted or sensitive: re-derive FULL from logical_key (D-06), never error.
      return success({
        data: {
          found: true,
          gc_evicted: true,
          page_id: match.page_id,
          logical_key: match.logical_key,
          content_hash: match.content_hash,
          action: "re-derive FULL from logical_key",
        },
        human: [
          `Page ${match.page_id} (${match.logical_key}): cold object absent (GC-evicted or sensitive).`,
          `Re-derive FULL: re-read source via logical_key "${match.logical_key}".`,
        ].join("\n"),
      });
    }

    const estTokens = Math.ceil(content.length / 4);
    return success({
      data: {
        found: true,
        gc_evicted: false,
        page_id: match.page_id,
        logical_key: match.logical_key,
        content_hash: match.content_hash,
        content,
        est_tokens: estTokens,
      },
      human: `Rehydrated page ${match.page_id} (${match.logical_key}): ${estTokens} token(s).`,
    });
  } catch {
    // Fail-safe: any error → passthrough (D-16).
    return success({
      data: { found: false, page_id: pageId ?? null, logical_key: logicalKey ?? null, note: "read_error_passthrough" },
      human: "Rehydrate: read error — fail-safe passthrough.",
    });
  }
}

// ---------------------------------------------------------------------------
// Handler: compare (S1+)
// ---------------------------------------------------------------------------

/**
 * Run the S7 equivalence harness on two corpus RunArtifacts.  Searches all
 * workload categories for the supplied session IDs.
 *
 * args.baseline_id — session_id of the baseline RunArtifact.
 * args.context_id  — session_id of the context (reduced) RunArtifact.
 * args.category    — (optional) workload category to narrow the search.
 *
 * data: { verdict, baseline_id, context_id }
 */
function handleCompare(
  args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const baselineId = typeof args.baseline_id === "string" && args.baseline_id.length > 0
    ? args.baseline_id
    : undefined;
  const contextId = typeof args.context_id === "string" && args.context_id.length > 0
    ? args.context_id
    : undefined;

  if (!baselineId || !contextId) {
    return failure({
      human: "compare requires baseline_id and context_id.",
      data: { error: "missing_args" },
    });
  }

  const rawCategory = typeof args.category === "string" ? args.category : undefined;
  const cats = (rawCategory && (WORKLOAD_CATEGORIES as readonly string[]).includes(rawCategory))
    ? [rawCategory as typeof WORKLOAD_CATEGORIES[number]]
    : WORKLOAD_CATEGORIES;

  // Search all (or the specified) categories for each entry.
  let baselineRun: RunArtifact | undefined;
  let contextRun: RunArtifact | undefined;
  for (const cat of cats) {
    if (!baselineRun) baselineRun = readCorpusEntry(paths, cat, baselineId);
    if (!contextRun) contextRun = readCorpusEntry(paths, cat, contextId);
    if (baselineRun && contextRun) break;
  }

  if (!baselineRun) {
    return failure({
      human: `Baseline corpus entry not found: session_id=${baselineId}. Run 'th context-pages baseline --session-id <id>' first.`,
      data: { error: "baseline_not_found", baseline_id: baselineId },
    });
  }
  if (!contextRun) {
    return failure({
      human: `Context corpus entry not found: session_id=${contextId}.`,
      data: { error: "context_not_found", context_id: contextId },
    });
  }

  try {
    const verdict = runEquivalence(baselineRun, contextRun);
    const diverged = verdict.dimensions.filter((d) => d.diverged).map((d) => d.dimension);
    const human = [
      `Equivalence: ${verdict.clean ? "CLEAN — zero divergence across all 7 dimensions" : `DIVERGED on: ${diverged.join(", ")}`}`,
      ...(verdict.reduction
        ? [
            `  Token savings   : ${verdict.reduction.savingsPercent.toFixed(1)}%`,
            `  Saved tokens    : ${verdict.reduction.savedTokens}`,
          ]
        : []),
      `  Dimensions      : ${verdict.dimensions.map((d) => `${d.dimension}=${d.diverged ? "DIVERGED" : "ok"}`).join(", ")}`,
    ].join("\n");
    return success({ data: { verdict, baseline_id: baselineId, context_id: contextId }, human });
  } catch {
    // Fail-safe: equivalence errors never block (D-16).
    return success({
      data: {
        verdict: null,
        baseline_id: baselineId,
        context_id: contextId,
        note: "equivalence_error_passthrough",
      },
      human: "Compare: equivalence harness error — fail-safe passthrough.",
    });
  }
}

// ---------------------------------------------------------------------------
// Handler: gc (CLI-only / human-only)
// ---------------------------------------------------------------------------

/** Default GC retention period: 5 days (D-06 / 5d constraint). */
const GC_DEFAULT_AGE_DAYS = 5;

/**
 * Garbage-collect cold CAS objects older than `age_days` days (default 5).
 *
 * ONLY removes files under `objects/<hh>/<hash>` — NEVER touches ledger shard
 * files (`ledger-*.jsonl`) or any other metadata (D-06 / 5d constraint).
 *
 * A rehydrate whose object was GC'd returns `gc_evicted:true` and re-derives
 * FULL from the logical_key — the ledger record is preserved for this purpose.
 *
 * Human-only / CLI-only (absent from the MCP enum).
 *
 * data: { removed_count, bytes_freed, age_days }
 */
function handleGc(
  args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const ageDays = typeof args.age_days === "number" && args.age_days > 0
    ? Math.floor(args.age_days)
    : GC_DEFAULT_AGE_DAYS;
  const maxAgeMs = ageDays * 24 * 60 * 60 * 1000;
  const cutoffMs = Date.now() - maxAgeMs;

  const pagesRoot = contextPagesRoot(paths);
  const objectsDir = path.join(pagesRoot, "objects");

  let removedCount = 0;
  let bytesFreed = 0;

  try {
    if (!fs.existsSync(objectsDir)) {
      return success({
        data: { removed_count: 0, bytes_freed: 0, age_days: ageDays },
        human: `GC: objects directory absent — nothing to collect (${ageDays}d threshold).`,
      });
    }

    // Walk objects/<hh>/<hash> two-level tree.
    for (const hh of fs.readdirSync(objectsDir)) {
      const hhDir = path.join(objectsDir, hh);
      let stat: fs.Stats;
      try { stat = fs.statSync(hhDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      for (const hash of fs.readdirSync(hhDir)) {
        const objPath = path.join(hhDir, hash);
        try {
          const objStat = fs.statSync(objPath);
          if (objStat.isFile() && objStat.mtimeMs < cutoffMs) {
            bytesFreed += objStat.size;
            fs.unlinkSync(objPath);
            removedCount++;
          }
        } catch {
          // Skip unreadable / already-deleted entries — fail-safe.
        }
      }
    }
  } catch {
    // Fail-safe: return partial results on any scan error (D-16).
    return success({
      data: { removed_count: removedCount, bytes_freed: bytesFreed, age_days: ageDays, note: "partial_gc" },
      human: `GC (partial): removed ${removedCount} object(s) (${bytesFreed} B). Scan error after partial walk.`,
    });
  }

  return success({
    data: { removed_count: removedCount, bytes_freed: bytesFreed, age_days: ageDays },
    human: `GC: removed ${removedCount} cold object(s) older than ${ageDays}d (${bytesFreed} B freed). Ledger records untouched.`,
  });
}

// ---------------------------------------------------------------------------
// Handler: purge (CLI-only / human-only)
// ---------------------------------------------------------------------------

/**
 * Remove the entire context-pages directory, clearing all cold objects, ledger
 * shards, telemetry, and corpus data.  Destructive; human-only / CLI-only.
 *
 * data: { purged, pages_root }
 */
function handlePurge(
  _args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const pagesRoot = contextPagesRoot(paths);
  try {
    if (!fs.existsSync(pagesRoot)) {
      return success({
        data: { purged: false, pages_root: pagesRoot, note: "already_absent" },
        human: `Purge: context-pages directory not found — nothing to remove (${pagesRoot}).`,
      });
    }
    fs.rmSync(pagesRoot, { recursive: true, force: true });
    return success({
      data: { purged: true, pages_root: pagesRoot },
      human: `Purge: removed all context-pages data at ${pagesRoot}.`,
    });
  } catch (err) {
    // Fail-safe: report error without throwing (D-16).
    return failure({
      human: `Purge failed: ${err instanceof Error ? err.message : String(err)}`,
      data: { error: "purge_failed", pages_root: pagesRoot },
    });
  }
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

type Handler = (args: Record<string, unknown>, paths: ProjectPaths) => CommandResult;

const HANDLERS: Record<string, Handler> = {
  // S0 (CLI + MCP)
  "page-status": handlePageStatus,
  residency: handleResidency,
  telemetry: handleTelemetry,
  savings: handleSavings,
  "savings-detail": handleSavingsDetail,
  // S1+ (CLI + MCP)
  verify: handleVerify,
  rehydrate: handleRehydrate,
  compare: handleCompare,
  // Human-only (CLI only)
  baseline: handleBaseline,
  gc: handleGc,
  purge: handlePurge,
};

// ---------------------------------------------------------------------------
// Public entry point — ONE function shared by CLI and MCP (AC-10)
// ---------------------------------------------------------------------------

/**
 * Dispatch a `th context-pages` operation.
 *
 * @param op    Operation name; see ALL_OPS.  Human-only ops (baseline/gc/purge)
 *              are wired through the CLI only — the MCP tool rejects them via
 *              the operation enum.
 * @param args  Caller-supplied arguments.  CLI and MCP pass the same shape —
 *              parity is guaranteed by calling this one function (AC-10).
 * @param paths Resolved project paths (never mutated by read-only ops).
 */
export function runContextPagesCommand(
  op: string,
  args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const handler = HANDLERS[op];
  if (handler === undefined) {
    return failure({
      data: { op, valid_ops: [...ALL_OPS] },
      human: `Unknown context-pages operation: "${op}". Valid ops: ${[...ALL_OPS].join(", ")}.`,
    });
  }
  return handler(args, paths);
}
