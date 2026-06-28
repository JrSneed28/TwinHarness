/**
 * context-pages.ts — Pure `CommandResult` handlers for the `th context-pages`
 * command group (T4 / D-19, S0 OBSERVE-only).
 *
 * All handlers are read-only: they never mutate state.json or any ledger/CAS
 * file. Each returns a `CommandResult` that the CLI (T6) and the `th_context`
 * MCP tool (T7) call through the ONE shared dispatcher `runContextPagesCommand`
 * — CLI↔MCP parity is a TYPE-LEVEL invariant (AC-10), not a runtime check.
 *
 * S0 operations (read-only):
 *   page-status  — shard inventory: file count, record counts, unique pages.
 *   residency    — records with op="deliver" (no suppressions at S0).
 *   telemetry    — raw telemetry.jsonl records (tail, bounded by `limit`).
 *   savings      — aggregate telemetry for dedup savings (0% at S0).
 *   baseline     — S0 denominator: total orig_tokens and record count.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { contextPagesRoot } from "../core/context-page";
import { type LedgerRecord } from "../core/context-ledger";
import { type TelemetryRecord, telemetryFilePath } from "../core/context-telemetry";
import { readJsonlValues } from "../core/jsonl";

// ---------------------------------------------------------------------------
// Supported S0 operations
// ---------------------------------------------------------------------------

const S0_OPS = new Set(["page-status", "residency", "telemetry", "savings", "baseline"]);

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
 * data: { savings_pct, orig_tokens, returned_tokens, delta_tokens, dup_avoided_count, record_count }
 */
function handleSavings(
  _args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const records = readAllTelemetryRecords(paths);

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

  const human = [
    `Savings: ${savingsPct}% (S0 target = 0%)`,
    `  Original tokens : ${origTokens}`,
    `  Returned tokens : ${returnedTokens}`,
    `  Delta tokens    : ${deltaTokens}`,
    `  Dups avoided    : ${dupAvoidedCount}`,
    `  Records         : ${records.length}`,
  ].join("\n");

  return success({
    data: {
      savings_pct: savingsPct,
      orig_tokens: origTokens,
      returned_tokens: returnedTokens,
      delta_tokens: deltaTokens,
      dup_avoided_count: dupAvoidedCount,
      record_count: records.length,
    },
    human,
  });
}

// ---------------------------------------------------------------------------
// Handler: baseline
// ---------------------------------------------------------------------------

/**
 * S0 baseline denominator: total orig_tokens and record count from telemetry.
 * This is the "before any savings" watermark used by later slices to measure
 * compression rate.  Expected 0% at S0.
 *
 * data: { baseline_tokens, record_count, tier, epoch, pages_root }
 */
function handleBaseline(
  _args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const records = readAllTelemetryRecords(paths);
  const baselineTokens = records.reduce((acc, r) => acc + (r.orig_tokens ?? 0), 0);
  const pagesRoot = contextPagesRoot(paths);

  const human = [
    `S0 baseline (OBSERVE-only, savings target = 0%)`,
    `  Baseline tokens : ${baselineTokens}`,
    `  Record count    : ${records.length}`,
    `  Tier            : s0`,
    `  Pages root      : ${pagesRoot}`,
  ].join("\n");

  return success({
    data: {
      baseline_tokens: baselineTokens,
      record_count: records.length,
      tier: "s0",
      epoch: 0,
      pages_root: pagesRoot,
    },
    human,
  });
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

type Handler = (args: Record<string, unknown>, paths: ProjectPaths) => CommandResult;

const HANDLERS: Record<string, Handler> = {
  "page-status": handlePageStatus,
  residency: handleResidency,
  telemetry: handleTelemetry,
  savings: handleSavings,
  baseline: handleBaseline,
};

// ---------------------------------------------------------------------------
// Public entry point — ONE function shared by CLI (T6) and MCP (T7)
// ---------------------------------------------------------------------------

/**
 * Dispatch a `th context-pages` operation.
 *
 * @param op    One of the S0_OPS: "page-status"|"residency"|"telemetry"|"savings"|"baseline".
 * @param args  Caller-supplied arguments (e.g. session_id, limit).  CLI and MCP
 *              pass the same shape — parity is guaranteed by calling this one function.
 * @param paths Resolved project paths (never mutated).
 */
export function runContextPagesCommand(
  op: string,
  args: Record<string, unknown>,
  paths: ProjectPaths,
): CommandResult {
  const handler = HANDLERS[op];
  if (handler === undefined) {
    return failure({
      data: { op, valid_ops: [...S0_OPS] },
      human: `Unknown context-pages operation: "${op}". Valid S0 ops: ${[...S0_OPS].join(", ")}.`,
    });
  }
  return handler(args, paths);
}
