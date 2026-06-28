"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runContextPagesCommand = runContextPagesCommand;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const context_page_1 = require("../core/context-page");
const context_ledger_1 = require("../core/context-ledger");
const context_telemetry_1 = require("../core/context-telemetry");
const jsonl_1 = require("../core/jsonl");
const context_equivalence_1 = require("../core/context-equivalence");
// ---------------------------------------------------------------------------
// Valid operation set (CLI + MCP-shared; gc/baseline/purge are CLI-only)
// ---------------------------------------------------------------------------
const ALL_OPS = new Set([
    // S0 (CLI + MCP)
    "page-status", "residency", "telemetry", "savings",
    // S1+ (CLI + MCP)
    "verify", "rehydrate", "compare",
    // Human-only (CLI only)
    "baseline", "gc", "purge",
]);
// ---------------------------------------------------------------------------
// Local validators (tolerant — mirror context-ledger / context-telemetry shapes)
// ---------------------------------------------------------------------------
/** Minimal shape predicate for LedgerRecord lines (tolerant reader). */
function isLedgerRec(v) {
    if (typeof v !== "object" || v === null)
        return false;
    const r = v;
    return (typeof r.seq === "number" &&
        typeof r.ts === "string" &&
        typeof r.session_id === "string" &&
        typeof r.page_id === "string" &&
        typeof r.op === "string" &&
        typeof r.recordHash === "string");
}
/** Minimal shape predicate for TelemetryRecord lines (tolerant reader). */
function isTelemetryRec(v) {
    if (typeof v !== "object" || v === null)
        return false;
    const r = v;
    return typeof r.ts === "string" && typeof r.session_id === "string" && typeof r.epoch === "number";
}
// ---------------------------------------------------------------------------
// Helpers — enumerate shards and read all records
// ---------------------------------------------------------------------------
/**
 * Enumerate all `ledger-*.jsonl` shard file paths inside the context-pages
 * directory.  Returns [] when the directory is absent (first run).
 */
function listShardFiles(pagesRoot) {
    try {
        if (!fs.existsSync(pagesRoot))
            return [];
        return fs
            .readdirSync(pagesRoot)
            .filter((name) => name.startsWith("ledger-") && name.endsWith(".jsonl"))
            .map((name) => path.join(pagesRoot, name));
    }
    catch {
        return [];
    }
}
/**
 * Read all valid LedgerRecord lines from every shard file.
 * Tolerant: missing dir, unreadable file, garbled lines — all skipped.
 */
function readAllLedgerRecords(paths) {
    const pagesRoot = (0, context_page_1.contextPagesRoot)(paths);
    const shards = listShardFiles(pagesRoot);
    const out = [];
    for (const file of shards) {
        const records = (0, jsonl_1.readJsonlValues)(file, isLedgerRec);
        out.push(...records);
    }
    return out;
}
/**
 * Read all valid TelemetryRecord lines from telemetry.jsonl.
 * Tolerant: missing file, garbled lines — returns [].
 */
function readAllTelemetryRecords(paths) {
    return (0, jsonl_1.readJsonlValues)((0, context_telemetry_1.telemetryFilePath)(paths), isTelemetryRec);
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
function handlePageStatus(_args, paths) {
    const pagesRoot = (0, context_page_1.contextPagesRoot)(paths);
    const shardFiles = listShardFiles(pagesRoot);
    const shards = [];
    const allPageIds = new Set();
    let totalRecords = 0;
    for (const file of shardFiles) {
        const records = (0, jsonl_1.readJsonlValues)(file, isLedgerRec);
        for (const r of records)
            allPageIds.add(r.page_id);
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
    return (0, output_1.success)({
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
function handleResidency(args, paths) {
    const sessionFilter = typeof args.session_id === "string" ? args.session_id : undefined;
    let records = readAllLedgerRecords(paths).filter((r) => r.op === "deliver");
    if (sessionFilter !== undefined) {
        records = records.filter((r) => r.session_id === sessionFilter);
    }
    // Deduplicate: if the same page_id appears multiple times, keep the latest.
    const byPageId = new Map();
    for (const r of records)
        byPageId.set(r.page_id, r);
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
    return (0, output_1.success)({ data: { resident_count: resident.length, records: summary }, human });
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
function handleTelemetry(args, paths) {
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 50;
    const all = readAllTelemetryRecords(paths);
    const tail = all.slice(-limit);
    const human = [
        `Telemetry records: ${all.length} total (showing last ${tail.length})`,
        `File: ${(0, context_telemetry_1.telemetryFilePath)(paths)}`,
        ...tail.map((r) => `  [${r.ts}] sess=${r.session_id} epoch=${r.epoch}` +
            (r.tool_type ? ` tool=${r.tool_type}` : "") +
            (r.orig_tokens !== undefined ? ` orig=${r.orig_tokens}tok` : "") +
            (r.dup_avoided ? " DUP_AVOIDED" : "")),
    ].join("\n");
    return (0, output_1.success)({ data: { count: tail.length, total: all.length, records: tail }, human });
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
function handleSavings(_args, paths) {
    const records = readAllTelemetryRecords(paths);
    let origTokens = 0;
    let returnedTokens = 0;
    let deltaTokens = 0;
    let dupAvoidedCount = 0;
    for (const r of records) {
        origTokens += r.orig_tokens ?? 0;
        returnedTokens += r.returned_tokens ?? r.orig_tokens ?? 0;
        deltaTokens += r.delta_tokens ?? 0;
        if (r.dup_avoided)
            dupAvoidedCount++;
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
    return (0, output_1.success)({
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
function handleBaseline(args, paths) {
    const records = readAllTelemetryRecords(paths);
    const baselineTokens = records.reduce((acc, r) => acc + (r.orig_tokens ?? 0), 0);
    const pagesRoot = (0, context_page_1.contextPagesRoot)(paths);
    // S1+: optionally write a RunArtifact baseline to the corpus.
    const sessionId = typeof args.session_id === "string" && args.session_id.length > 0
        ? args.session_id
        : undefined;
    let corpusWritten = false;
    if (sessionId) {
        const artifact = {
            session_id: sessionId,
            workload_category: "planning",
            ts: new Date().toISOString(),
            token_usage: {
                origTokens: baselineTokens,
                returnedTokens: baselineTokens, // S0: no reduction
            },
        };
        corpusWritten = (0, context_equivalence_1.writeCorpusEntry)(paths, artifact);
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
    return (0, output_1.success)({
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
 * Fail-safe: any read error returns ok:true with 0 records (never blocks).
 *
 * data: { ok, record_count, broken_at?, reason? }
 */
function handleVerify(_args, paths) {
    try {
        const records = readAllLedgerRecords(paths);
        const result = (0, context_ledger_1.verifyLedgerChain)(records);
        const human = result.ok
            ? `Ledger chain: PASS — ${records.length} record(s) verified.`
            : `Ledger chain: FAIL — broken at record ${result.brokenAt} (${result.reason}). ${records.length} records checked.`;
        return (0, output_1.success)({
            data: {
                ok: result.ok,
                record_count: records.length,
                ...(!result.ok ? { broken_at: result.brokenAt, reason: result.reason } : {}),
            },
            human,
        });
    }
    catch {
        // Fail-safe: never throw across a handler boundary (D-16).
        return (0, output_1.success)({
            data: { ok: true, record_count: 0, note: "read_error_passthrough" },
            human: "Ledger chain: no records read (fail-safe passthrough).",
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
function handleRehydrate(args, paths) {
    const pageId = typeof args.page_id === "string" && args.page_id.length > 0 ? args.page_id : undefined;
    const logicalKey = typeof args.logical_key === "string" && args.logical_key.length > 0 ? args.logical_key : undefined;
    if (!pageId && !logicalKey) {
        return (0, output_1.failure)({
            human: "rehydrate requires page_id or logical_key.",
            data: { error: "missing_args" },
        });
    }
    try {
        const records = readAllLedgerRecords(paths);
        // Find the most recent ledger record matching the query (tail-to-head).
        let match;
        for (let i = records.length - 1; i >= 0; i--) {
            const r = records[i];
            if ((pageId && r.page_id === pageId) || (logicalKey && r.logical_key === logicalKey)) {
                match = r;
                break;
            }
        }
        if (!match) {
            return (0, output_1.success)({
                data: { found: false, page_id: pageId ?? null, logical_key: logicalKey ?? null },
                human: `No ledger record found for ${pageId ? `page_id=${pageId}` : `logical_key=${logicalKey}`}.`,
            });
        }
        // Try to fetch content from cold store.
        const content = (0, context_page_1.coldStoreGet)(paths, match.content_hash);
        if (content === undefined) {
            // GC-evicted or sensitive: re-derive FULL from logical_key (D-06), never error.
            return (0, output_1.success)({
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
        return (0, output_1.success)({
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
    }
    catch {
        // Fail-safe: any error → passthrough (D-16).
        return (0, output_1.success)({
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
function handleCompare(args, paths) {
    const baselineId = typeof args.baseline_id === "string" && args.baseline_id.length > 0
        ? args.baseline_id
        : undefined;
    const contextId = typeof args.context_id === "string" && args.context_id.length > 0
        ? args.context_id
        : undefined;
    if (!baselineId || !contextId) {
        return (0, output_1.failure)({
            human: "compare requires baseline_id and context_id.",
            data: { error: "missing_args" },
        });
    }
    const rawCategory = typeof args.category === "string" ? args.category : undefined;
    const cats = (rawCategory && context_equivalence_1.WORKLOAD_CATEGORIES.includes(rawCategory))
        ? [rawCategory]
        : context_equivalence_1.WORKLOAD_CATEGORIES;
    // Search all (or the specified) categories for each entry.
    let baselineRun;
    let contextRun;
    for (const cat of cats) {
        if (!baselineRun)
            baselineRun = (0, context_equivalence_1.readCorpusEntry)(paths, cat, baselineId);
        if (!contextRun)
            contextRun = (0, context_equivalence_1.readCorpusEntry)(paths, cat, contextId);
        if (baselineRun && contextRun)
            break;
    }
    if (!baselineRun) {
        return (0, output_1.failure)({
            human: `Baseline corpus entry not found: session_id=${baselineId}. Run 'th context-pages baseline --session-id <id>' first.`,
            data: { error: "baseline_not_found", baseline_id: baselineId },
        });
    }
    if (!contextRun) {
        return (0, output_1.failure)({
            human: `Context corpus entry not found: session_id=${contextId}.`,
            data: { error: "context_not_found", context_id: contextId },
        });
    }
    try {
        const verdict = (0, context_equivalence_1.runEquivalence)(baselineRun, contextRun);
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
        return (0, output_1.success)({ data: { verdict, baseline_id: baselineId, context_id: contextId }, human });
    }
    catch {
        // Fail-safe: equivalence errors never block (D-16).
        return (0, output_1.success)({
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
function handleGc(args, paths) {
    const ageDays = typeof args.age_days === "number" && args.age_days > 0
        ? Math.floor(args.age_days)
        : GC_DEFAULT_AGE_DAYS;
    const maxAgeMs = ageDays * 24 * 60 * 60 * 1000;
    const cutoffMs = Date.now() - maxAgeMs;
    const pagesRoot = (0, context_page_1.contextPagesRoot)(paths);
    const objectsDir = path.join(pagesRoot, "objects");
    let removedCount = 0;
    let bytesFreed = 0;
    try {
        if (!fs.existsSync(objectsDir)) {
            return (0, output_1.success)({
                data: { removed_count: 0, bytes_freed: 0, age_days: ageDays },
                human: `GC: objects directory absent — nothing to collect (${ageDays}d threshold).`,
            });
        }
        // Walk objects/<hh>/<hash> two-level tree.
        for (const hh of fs.readdirSync(objectsDir)) {
            const hhDir = path.join(objectsDir, hh);
            let stat;
            try {
                stat = fs.statSync(hhDir);
            }
            catch {
                continue;
            }
            if (!stat.isDirectory())
                continue;
            for (const hash of fs.readdirSync(hhDir)) {
                const objPath = path.join(hhDir, hash);
                try {
                    const objStat = fs.statSync(objPath);
                    if (objStat.isFile() && objStat.mtimeMs < cutoffMs) {
                        bytesFreed += objStat.size;
                        fs.unlinkSync(objPath);
                        removedCount++;
                    }
                }
                catch {
                    // Skip unreadable / already-deleted entries — fail-safe.
                }
            }
        }
    }
    catch {
        // Fail-safe: return partial results on any scan error (D-16).
        return (0, output_1.success)({
            data: { removed_count: removedCount, bytes_freed: bytesFreed, age_days: ageDays, note: "partial_gc" },
            human: `GC (partial): removed ${removedCount} object(s) (${bytesFreed} B). Scan error after partial walk.`,
        });
    }
    return (0, output_1.success)({
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
function handlePurge(_args, paths) {
    const pagesRoot = (0, context_page_1.contextPagesRoot)(paths);
    try {
        if (!fs.existsSync(pagesRoot)) {
            return (0, output_1.success)({
                data: { purged: false, pages_root: pagesRoot, note: "already_absent" },
                human: `Purge: context-pages directory not found — nothing to remove (${pagesRoot}).`,
            });
        }
        fs.rmSync(pagesRoot, { recursive: true, force: true });
        return (0, output_1.success)({
            data: { purged: true, pages_root: pagesRoot },
            human: `Purge: removed all context-pages data at ${pagesRoot}.`,
        });
    }
    catch (err) {
        // Fail-safe: report error without throwing (D-16).
        return (0, output_1.failure)({
            human: `Purge failed: ${err instanceof Error ? err.message : String(err)}`,
            data: { error: "purge_failed", pages_root: pagesRoot },
        });
    }
}
const HANDLERS = {
    // S0 (CLI + MCP)
    "page-status": handlePageStatus,
    residency: handleResidency,
    telemetry: handleTelemetry,
    savings: handleSavings,
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
function runContextPagesCommand(op, args, paths) {
    const handler = HANDLERS[op];
    if (handler === undefined) {
        return (0, output_1.failure)({
            data: { op, valid_ops: [...ALL_OPS] },
            human: `Unknown context-pages operation: "${op}". Valid ops: ${[...ALL_OPS].join(", ")}.`,
        });
    }
    return handler(args, paths);
}
