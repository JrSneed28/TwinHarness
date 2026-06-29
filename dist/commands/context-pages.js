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
exports.fmtBytes = fmtBytes;
exports.storageReport = storageReport;
exports.runContextPagesCommand = runContextPagesCommand;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const context_page_1 = require("../core/context-page");
const hash_1 = require("../core/hash");
const context_ledger_1 = require("../core/context-ledger");
const context_telemetry_1 = require("../core/context-telemetry");
const jsonl_1 = require("../core/jsonl");
const context_equivalence_1 = require("../core/context-equivalence");
const context_residency_1 = require("../core/context-residency");
const savings_1 = require("../core/savings");
const pricing_1 = require("../core/pricing");
const savings_render_1 = require("../core/savings-render");
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
 * STRICT enumeration of ledger shard files for the audit path (#1). Unlike the
 * tolerant {@link listShardFiles}, which swallows a directory-enumeration error
 * and returns `[]` (making an UNREADABLE pages root look like an EMPTY store),
 * this distinguishes three states so `verify` can report them honestly:
 *   - absent:     the pages root does not exist (legitimately empty)
 *   - !enumerable: the root exists but cannot be listed (e.g. it is a regular
 *                  file → ENOTDIR, or a permissions error) → audit "unknown"
 *   - enumerable: the listed shard file paths
 */
function enumerateShardFilesStrict(pagesRoot) {
    if (!fs.existsSync(pagesRoot))
        return { absent: true, enumerable: true, files: [] };
    try {
        const files = fs
            .readdirSync(pagesRoot)
            .filter((name) => name.startsWith("ledger-") && name.endsWith(".jsonl"))
            .map((name) => path.join(pagesRoot, name));
        return { absent: false, enumerable: true, files };
    }
    catch {
        return { absent: false, enumerable: false, files: [] };
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
 * Order two ledger records by recency: ts (ISO-8601, lexical == chronological),
 * then per-shard seq, then recordHash as a stable content-addressed tiebreaker.
 * Returns >0 when `a` is newer than `b`. Deterministic regardless of the order
 * shards were read from disk. (#5)
 */
function ledgerRecencyCompare(a, b) {
    if (a.ts !== b.ts)
        return a.ts < b.ts ? -1 : 1;
    if (a.seq !== b.seq)
        return a.seq - b.seq;
    if (a.recordHash !== b.recordHash)
        return a.recordHash < b.recordHash ? -1 : 1;
    return 0;
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
 * count, plus totals (total_records, unique_pages) AND a storage-usage report
 * (#5): cold-object count/bytes vs. cap, oldest object age, ledger bytes, and
 * whether raw cold storage is enabled.  S0-safe read.
 *
 * data: { shards, total_records, unique_pages, pages_root, storage }
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
    const storage = storageReport(paths);
    const human = [
        `Context-pages directory: ${pagesRoot}`,
        `Shards: ${shards.length}`,
        ...shards.map((s) => `  ${s.file}: ${s.records} record(s)`),
        `Total records : ${totalRecords}`,
        `Unique page_ids: ${uniquePages}`,
        `Storage:`,
        `  Cold objects : ${storage.cold_objects} (${fmtBytes(storage.cold_bytes)})` +
            ` / cap ${fmtBytes(storage.max_bytes)}${storage.over_cap ? "  [OVER CAP — run: th context-pages gc]" : ""}`,
        `  Oldest object: ${storage.oldest_age_days !== null ? `${storage.oldest_age_days}d` : "—"}` +
            ` (age cap ${storage.max_age_days}d)`,
        `  Ledger bytes : ${fmtBytes(storage.ledger_bytes)} (retained for chain verification)`,
        `  Raw storage  : ${storage.raw_store_enabled ? "ENABLED (suppression/opt-in)" : "disabled (metadata-only default)"}`,
    ].join("\n");
    return (0, output_1.success)({
        data: { shards, total_records: totalRecords, unique_pages: uniquePages, pages_root: pagesRoot, storage },
        human,
    });
}
// ---------------------------------------------------------------------------
// Handler: residency
// ---------------------------------------------------------------------------
/** Page-bearing ops that can carry residency (mirror RESIDENT_OPS in context-residency). */
const RESIDENT_BEARING_OPS = new Set(["deliver", "attest", "delta", "rehydrate"]);
/**
 * Group every ledger shard's records by scope, using the STRICT record validator
 * so the records carry the prevHash/recordHash that deriveResidency's tamper
 * check needs (the live reader uses the same validator). A shard whose records
 * carry a non-empty agent_id is an agent scope (suppressible); an empty agent_id
 * is the root shard (recorded but never suppressed — the "Phantom Root" gate).
 */
function readShardGroups(paths) {
    const groups = [];
    for (const file of listShardFiles((0, context_page_1.contextPagesRoot)(paths))) {
        const records = (0, jsonl_1.readJsonlValues)(file, context_ledger_1.isValidLedgerRecord);
        if (records.length === 0)
            continue;
        const session_id = records[0].session_id;
        // resolveScope keys an agent shard by a present agent_id and the root shard
        // by "root"; root-scope records are written with agent_id "". Mirror that.
        const agentId = records[0].agent_id;
        const isAgentScope = agentId !== "" && agentId !== "root";
        const agentOrRoot = isAgentScope ? agentId : "root";
        let nowTurn = 0;
        for (const r of records)
            if (r.seq > nowTurn)
                nowTurn = r.seq;
        groups.push({ scope: { session_id, agentOrRoot }, isAgentScope, records, nowTurn });
    }
    return groups;
}
/** Map a deriveResidency reason + scope onto a stable residency status string. */
function residencyStatus(reason, isAgentScope) {
    if (reason === "ok")
        return isAgentScope ? "resident" : "root_not_suppressible";
    if (reason.startsWith("ttl_expired"))
        return "expired_ttl";
    if (reason === "epoch_mismatch")
        return "prior_epoch";
    if (reason === "hash_mismatch")
        return "invalidated"; // superseded by a newer content version
    if (reason === "incomplete")
        return "incomplete";
    if (reason === "hash_tampered")
        return "hash_tampered";
    if (reason === "no_record")
        return "no_record";
    return "error";
}
/**
 * Report pages and whether each is LIVE-RESIDENT — i.e. whether the real
 * PostToolUse hook would currently suppress against it. This runs the SAME
 * `deriveResidency` logic the live hook runs, per shard, against the current
 * epoch and each shard's absolute current sequence, then applies the agent-only
 * suppression restriction. A page delivered hundreds of turns ago, in a prior
 * epoch, in the root shard, or superseded by a newer content hash is reported
 * with the reason it is NOT resident — never as plain "resident". (#3)
 *
 * Optionally filtered by `args.session_id`.
 *
 * data: {
 *   epoch, resident_count, page_count,
 *   pages: [{ page_id, logical_key, content_hash, est_tokens, reduction_kind,
 *             session_id, scope, status, reason, ts }]
 * }
 */
function handleResidency(args, paths) {
    const sessionFilter = typeof args.session_id === "string" ? args.session_id : undefined;
    const epoch = (0, context_residency_1.currentEpoch)(paths).epoch;
    const groups = readShardGroups(paths).filter((g) => sessionFilter === undefined || g.scope.session_id === sessionFilter);
    const pages = [];
    for (const g of groups) {
        // Candidate pages = latest record per page_id among the page-bearing ops.
        const byPageId = new Map();
        for (const r of g.records) {
            if (!RESIDENT_BEARING_OPS.has(r.op))
                continue;
            const prev = byPageId.get(r.page_id);
            if (prev === undefined || r.seq > prev.seq)
                byPageId.set(r.page_id, r);
        }
        for (const r of [...byPageId.values()].sort((a, b) => a.seq - b.seq)) {
            // Identical inputs to the live hook's suppression check (same shard
            // records, same scope, same epoch, same nowTurn).
            const res = (0, context_residency_1.deriveResidency)(g.records, g.scope, r.logical_key, r.content_hash, epoch, g.nowTurn);
            pages.push({
                page_id: r.page_id,
                logical_key: r.logical_key,
                content_hash: r.content_hash,
                est_tokens: r.est_tokens,
                reduction_kind: r.reduction_kind,
                session_id: r.session_id,
                scope: g.isAgentScope ? "agent" : "root",
                agent_or_root: g.scope.agentOrRoot,
                // The hook only suppresses in an `agent` scope, so a residency-OK page in
                // the root shard is reported observed-but-not-suppressible, not resident.
                status: residencyStatus(res.reason, g.isAgentScope),
                reason: res.reason,
                ts: r.ts,
            });
        }
    }
    const residentCount = pages.filter((p) => p.status === "resident").length;
    const human = [
        `Resident pages: ${residentCount} of ${pages.length} observed` +
            `${sessionFilter ? ` (session: ${sessionFilter})` : ""} — epoch ${epoch}`,
        ...pages.map((p) => `  [${p.status}] ${p.page_id}  ${p.logical_key}  (${p.est_tokens} tok, ${p.scope})`),
    ].join("\n");
    return (0, output_1.success)({
        data: { epoch, resident_count: residentCount, page_count: pages.length, pages },
        human,
    });
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
function handleSavings(args, paths) {
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
        if (r.dup_avoided)
            dupAvoidedCount++;
    }
    // S0: no suppression, so savings_pct is always 0.
    const savingsPct = origTokens > 0 ? Math.round(((origTokens - returnedTokens) / origTokens) * 10000) / 100 : 0;
    // New session-scoped, per-cycle-netted savings calculation (B1).
    const result = (0, savings_1.computeSavings)(records, { session_id, suppressMode });
    // #7: when a session filter is active, the human display MUST show that
    // session's totals — not the all-store legacy aggregates — so the headline
    // percentage and the totals beneath it share one scope. The legacy all-store
    // fields stay in `data` (deprecated-in-place) but are explicitly labelled.
    const scoped = session_id !== undefined;
    const human = scoped
        ? [
            `Savings: ${result.saved_pct}% — ${result.headline_label} (session ${session_id})`,
            `  Baseline tokens : ${result.baseline_tokens}`,
            `  Actual tokens   : ${result.actual_tokens}`,
            `  Avoided tokens  : ${result.avoided_tokens}`,
            `  Records         : ${result.record_count}`,
        ].join("\n")
        : [
            `Savings: ${result.saved_pct}% — ${result.headline_label} (all sessions)`,
            `  Original tokens : ${origTokens}`,
            `  Returned tokens : ${returnedTokens}`,
            `  Delta tokens    : ${deltaTokens}`,
            `  Dups avoided    : ${dupAvoidedCount}`,
            `  Records         : ${records.length}`,
        ].join("\n");
    return (0, output_1.success)({
        data: {
            // Scope of the headline `saved_pct` and the `savings` sub-object (#7).
            scope: scoped ? "session" : "all",
            // Deprecated-in-place (I3/M6 — do not rename; old all-records/no-payback semantics).
            savings_pct: savingsPct,
            // New session-scoped savings fields (AC-22, AC-26).
            saved_pct: result.saved_pct,
            // Legacy ALL-STORE aggregates (unscoped — kept for compatibility; use
            // `savings.*` or the scoped human display for session-correct totals).
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
function handleSavingsDetail(args, paths) {
    const records = readAllTelemetryRecords(paths);
    const session_id = typeof args.session_id === "string" ? args.session_id : undefined;
    const suppressMode = process.env.TH_EXACT_SUPPRESS === "1";
    const transcriptPath = typeof args.transcript_path === "string" ? args.transcript_path : undefined;
    const result = (0, savings_1.computeSavings)(records, { session_id, suppressMode });
    // Whole-window estimate from transcript (labeled [estimated] per plan Principle 1).
    const actuals = transcriptPath !== undefined ? (0, context_telemetry_1.transcriptActuals)(transcriptPath) : undefined;
    // USD cost: priced against avoided input tokens (AC-10–13).
    const modelId = transcriptPath !== undefined ? (0, pricing_1.parseTranscriptModelId)(transcriptPath) : undefined;
    const pricing = (0, pricing_1.priceAvoided)(result.avoided_input_tokens, modelId);
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
        (0, savings_render_1.renderDetail)(result, pricing.label),
        `  whole-window:   ${actuals !== undefined
            ? `input=${actuals.input_tokens} tok, output=${actuals.output_tokens} tok` +
                (actuals.context_window !== undefined ? `, window=${actuals.context_window}` : "") +
                " [estimated]"
            : "[unavailable]"}`,
        `  provider-cache: ${cacheLabel} (separate from dedup savings)`,
        `  cost:           ${pricing.label}${pricing.cost_usd !== null ? ` ($${pricing.cost_usd.toFixed(4)} USD)` : ""}`,
    ].join("\n");
    return (0, output_1.success)({
        data: {
            // Scope of the headline `saved_pct` and the `savings` sub-object (#7). The
            // renderDetail() human block is already session-scoped via `result`.
            scope: session_id !== undefined ? "session" : "all",
            // Deprecated-in-place (I3/M6 — do not rename; old all-records/no-payback semantics).
            savings_pct: savingsPct,
            // New session-scoped savings fields (AC-22, AC-26).
            saved_pct: result.saved_pct,
            // Legacy ALL-STORE aggregates (unscoped — kept for compatibility; use
            // `savings.*` for session-correct totals).
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
 * States are distinguishable via `status`: "verified" (chains intact),
 * "empty" (no shards to verify), "broken" (a chain failed), and "unknown" (a
 * read/verify error — reported as ok:false/verified:false, NOT a false PASS).
 * Always non-blocking (advisory): the command exits zero in every state.
 *
 * data: { ok, status, verified, record_count, shard_count?, broken_at?, reason?, blocking? }
 */
function handleVerify(_args, paths) {
    try {
        const pagesRoot = (0, context_page_1.contextPagesRoot)(paths);
        // #1 — STRICT audit, not the tolerant live read. The previous version used
        // listShardFiles()/readJsonlValues(), both of which SILENTLY swallow
        // failures: an unreadable pages root became an "empty" store, and a shard of
        // pure garbage became a verified ZERO-record shard. Both are false-greens —
        // corrupt or inaccessible evidence presented as proof. The audit reader
        // counts every anomaly so we can map it to a distinct, honest status.
        const enumerated = enumerateShardFilesStrict(pagesRoot);
        // Pages root exists but cannot be enumerated (it is a regular file, or a
        // permissions error) → UNKNOWN, never "empty". (Remaining problem A.)
        if (!enumerated.enumerable) {
            return (0, output_1.success)({
                data: {
                    ok: false,
                    status: "unknown",
                    verified: false,
                    blocking: false,
                    record_count: 0,
                    reason: "pages_root_unreadable",
                },
                human: "Ledger chain: UNKNOWN — context-pages root exists but could not be enumerated (advisory, non-blocking).",
            });
        }
        const shardFiles = enumerated.files;
        let recordCount = 0;
        let totalLines = 0;
        for (const file of shardFiles) {
            const shard = path.basename(file);
            // Strict per-shard audit: distinguishes unreadable from malformed from
            // schema-invalid from clean. readJsonlAudit validates with the canonical
            // strict ledger predicate (not the tolerant 6-field isLedgerRec).
            const audit = (0, jsonl_1.readJsonlAudit)(file, context_ledger_1.isValidLedgerRecord);
            // Shard exists but cannot be read (e.g. a directory where a file is
            // expected) → UNKNOWN. (Required test: unreadable shard file.)
            if (audit.read_error) {
                return (0, output_1.success)({
                    data: {
                        ok: false,
                        status: "unknown",
                        verified: false,
                        blocking: false,
                        record_count: recordCount,
                        shard_count: shardFiles.length,
                        shard,
                        reason: "shard_unreadable",
                    },
                    human: `Ledger chain: UNKNOWN — shard ${shard} could not be read (advisory, non-blocking).`,
                });
            }
            // Any non-blank line that does not parse as JSON, or parses but fails the
            // record schema, makes the shard BROKEN — never a verified zero-record
            // shard. (Remaining problem B.)
            if (audit.malformed_lines > 0 || audit.schema_invalid_lines > 0) {
                const reason = audit.malformed_lines > 0 ? "malformed_json" : "schema_invalid";
                return (0, output_1.success)({
                    data: {
                        ok: false,
                        status: "broken",
                        verified: false,
                        record_count: recordCount,
                        shard_count: shardFiles.length,
                        shard,
                        reason,
                        diagnostics: {
                            total_lines: audit.total_lines,
                            valid_lines: audit.valid_lines,
                            malformed_lines: audit.malformed_lines,
                            schema_invalid_lines: audit.schema_invalid_lines,
                        },
                    },
                    human: `Ledger chain: BROKEN — shard ${shard} has ${audit.malformed_lines} malformed and ` +
                        `${audit.schema_invalid_lines} schema-invalid line(s) out of ${audit.total_lines}.`,
                });
            }
            recordCount += audit.valid_lines;
            totalLines += audit.total_lines;
            // Each shard is an independent GENESIS-anchored chain, so verify
            // shard-by-shard. Flattening all shards into one verifyLedgerChain call
            // false-failed with prev_mismatch the moment a second shard existed (its
            // first record re-anchors at GENESIS, never matching the prior tail).
            const result = (0, context_ledger_1.verifyLedgerChain)(audit.values);
            if (!result.ok) {
                return (0, output_1.success)({
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
        // Distinguish a genuinely-empty store (no records anywhere — whether the
        // pages root is absent or only holds blank shards) from a verified one. With
        // the audit guards above, reaching here with recordCount===0 means there was
        // nothing corrupt to find, so "empty" is honest, not a false-green.
        const empty = recordCount === 0;
        return (0, output_1.success)({
            data: {
                ok: true,
                status: empty ? "empty" : "verified",
                verified: true,
                record_count: recordCount,
                shard_count: shardFiles.length,
                total_lines: totalLines,
            },
            human: empty
                ? "Ledger chain: no ledger records found (empty store)."
                : `Ledger chain: PASS — ${shardFiles.length} shard(s), ${recordCount} record(s) verified.`,
        });
    }
    catch {
        // Fail-safe: never throw across a handler boundary (D-16). A read/verify
        // failure is NOT proof of a clean ledger — surfacing ok:true here would let
        // automation mistake "could not read" for "verified", violating the broader
        // rule that unknown evidence must never be presented as proof. Return a
        // DISTINCT unknown/unverified state instead. Still non-blocking (advisory):
        // CommandResult stays a success() so the command exits zero. (#3)
        return (0, output_1.success)({
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
/**
 * Decide how a GC-evicted / never-stored page may be recovered, based on the
 * SOURCE KIND inferred from its ledger record. (#8)
 *
 * The old behavior returned "re-derive FULL from logical_key" for EVERY page,
 * which is only safe for stable file content. Replaying a Bash command, an MCP
 * call, a web fetch, or a test run may be nondeterministic, side-effecting, or
 * require credentials no longer present — and the re-derived content may not even
 * match the original content hash. So we NEVER instruct automatic replay of Bash
 * or arbitrary MCP calls; those report "unavailable"/"requires_confirmation".
 *
 * source_kind is inferred from the normalized logical_key (see normalizeLocator):
 *   - "hash-only" reduction → sensitive page; logical_key is hashed → unavailable.
 *   - "bash|…"               → bash       → unavailable (nondeterministic/side-effecting)
 *   - "test|…"               → test       → unavailable (time-sensitive output)
 *   - "…|query=…"            → search     → requery (read-only; may differ if repo changed)
 *   - "<tool>|{…}"/"<tool>|[…]" → mcp     → requires_confirmation (side effects / credentials)
 *   - otherwise (no pipe)    → file/range/symbol → reread (re-readable from disk)
 */
function classifyRehydration(record) {
    if (record.reduction_kind === "hash-only") {
        return {
            mode: "unavailable",
            source_kind: "sensitive",
            safe_to_replay: false,
            reason: "sensitive page: logical key is hashed and the source cannot be reconstructed",
        };
    }
    const lk = record.logical_key;
    if (lk.startsWith("bash|")) {
        return {
            mode: "unavailable",
            source_kind: "bash",
            safe_to_replay: false,
            reason: "command output may be nondeterministic or side-effecting; do not replay automatically",
        };
    }
    if (lk.startsWith("test|")) {
        return {
            mode: "unavailable",
            source_kind: "test",
            safe_to_replay: false,
            reason: "test/command output is time-sensitive and may differ on replay",
        };
    }
    if (lk.startsWith("WebFetch|")) {
        return {
            mode: "requires_confirmation",
            source_kind: "web",
            safe_to_replay: false,
            reason: "web content is time-variant: it may have changed or disappeared since the fetch; confirm before re-fetching",
        };
    }
    if (lk.includes("|query=")) {
        return {
            mode: "requery",
            source_kind: "search",
            safe_to_replay: true,
            reason: "read-only query; results may differ if the repository changed since delivery",
        };
    }
    const pipe = lk.indexOf("|");
    if (pipe > 0) {
        const rhs = lk.slice(pipe + 1);
        if (rhs.startsWith("{") || rhs.startsWith("[")) {
            return {
                mode: "requires_confirmation",
                source_kind: "mcp",
                safe_to_replay: false,
                reason: "MCP call may have side effects or require credentials no longer available; confirm before replay",
            };
        }
        return {
            mode: "requires_confirmation",
            source_kind: "unknown",
            safe_to_replay: false,
            reason: "source kind could not be determined from the logical key; confirm before replay",
        };
    }
    return {
        mode: "reread",
        source_kind: "file",
        safe_to_replay: true,
        reason: "file content can be re-read from its path (logical_key)",
    };
}
/**
 * Fetch a page's content from the CAS cold store by `page_id` or `logical_key`.
 * The most recent matching ledger record is used to resolve the `content_hash`.
 *
 * When the cold object is absent (GC-evicted, sensitive, or never raw-stored),
 * never errors: returns `raw_available:false` plus a source-kind-aware
 * `rehydration` policy (#8) so the caller knows whether the page may be safely
 * re-read, re-queried, or must be confirmed/left alone — Bash/MCP/web sources
 * are NEVER auto-replayed.
 *
 * data: { found, raw_available, gc_evicted, page_id, logical_key, content_hash,
 *         content?, est_tokens?, rehydration? }
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
        // Select the most recent matching record DETERMINISTICALLY. The previous
        // tail-to-head scan trusted the flattened shard order (readdir order), which
        // is not chronological — so "latest" could vary by filesystem. Rank by ts
        // (ISO-8601, lexical == chronological), then per-shard seq, then recordHash
        // as a stable content-addressed tiebreaker. (#5)
        let match;
        for (const r of records) {
            if (!((pageId && r.page_id === pageId) || (logicalKey && r.logical_key === logicalKey)))
                continue;
            if (match === undefined || ledgerRecencyCompare(r, match) > 0)
                match = r;
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
            // GC-evicted, sensitive, or never raw-stored: the recovery path depends on
            // the SOURCE KIND. Never blanket-instruct "re-derive FULL" — that is only
            // safe for files. (#8)
            const policy = classifyRehydration(match);
            const safeModes = {
                reread: `Re-read source via logical_key "${match.logical_key}".`,
                requery: `Re-run the read-only query "${match.logical_key}" (results may differ if the repo changed).`,
                requires_confirmation: `Do NOT auto-replay. Confirm with a human before re-running "${match.logical_key}".`,
                unavailable: `Raw content is unavailable and the source cannot be safely replayed (${policy.reason}).`,
            };
            return (0, output_1.success)({
                data: {
                    found: true,
                    raw_available: false,
                    // gc_evicted retained for back-compat; it means "no raw object present".
                    gc_evicted: true,
                    page_id: match.page_id,
                    logical_key: match.logical_key,
                    content_hash: match.content_hash,
                    rehydration: {
                        mode: policy.mode,
                        source_kind: policy.source_kind,
                        safe_to_replay: policy.safe_to_replay,
                        reason: policy.reason,
                    },
                },
                human: [
                    `Page ${match.page_id} (${match.logical_key}): cold object absent.`,
                    `Source kind: ${policy.source_kind} — ${policy.mode}. ${safeModes[policy.mode]}`,
                ].join("\n"),
            });
        }
        // Integrity check (#8): the cold object is addressed by content_hash, but a
        // tampered/corrupted object could still be returned. Recompute and report a
        // mismatch rather than silently handing back content that is not what the
        // ledger attested.
        const actualHash = (0, hash_1.hashContent)(content);
        if (actualHash !== match.content_hash) {
            return (0, output_1.success)({
                data: {
                    found: true,
                    raw_available: false,
                    content_hash_mismatch: true,
                    page_id: match.page_id,
                    logical_key: match.logical_key,
                    content_hash: match.content_hash,
                    actual_hash: actualHash,
                    rehydration: {
                        mode: "unavailable",
                        source_kind: classifyRehydration(match).source_kind,
                        safe_to_replay: false,
                        reason: "stored cold object does not match the attested content hash (corruption/tamper)",
                    },
                },
                human: `Page ${match.page_id} (${match.logical_key}): cold object hash mismatch — ` +
                    `expected ${match.content_hash.slice(0, 12)}…, got ${actualHash.slice(0, 12)}…. Not returned.`,
            });
        }
        const estTokens = Math.ceil(content.length / 4);
        return (0, output_1.success)({
            data: {
                found: true,
                raw_available: true,
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
    // GC enforces the configured size cap too (#5): drop objects older than
    // `age_days`, then evict oldest-first until under the byte cap. Only cold
    // objects are touched — ledger shards are never removed.
    const caps = (0, context_page_1.coldStoreCaps)();
    try {
        const r = (0, context_page_1.coldStoreEnforceRetention)(paths, { maxBytes: caps.maxBytes, maxAgeMs });
        return (0, output_1.success)({
            data: {
                removed_count: r.removed_count,
                bytes_freed: r.removed_bytes,
                age_days: ageDays,
                max_bytes: caps.maxBytes,
                remaining_count: r.remaining_count,
                remaining_bytes: r.remaining_bytes,
            },
            human: `GC: removed ${r.removed_count} cold object(s) (${r.removed_bytes} B freed) — older than ` +
                `${ageDays}d or over the ${caps.maxBytes} B cap. ${r.remaining_count} object(s) / ` +
                `${r.remaining_bytes} B remain. Ledger records untouched.`,
        });
    }
    catch {
        // Fail-safe: never throw across a handler boundary (D-16).
        return (0, output_1.success)({
            data: { removed_count: 0, bytes_freed: 0, age_days: ageDays, note: "gc_error_passthrough" },
            human: `GC: scan error — fail-safe passthrough (${ageDays}d threshold).`,
        });
    }
}
// ---------------------------------------------------------------------------
// Storage usage report (#5) — surfaced via page-status (and th doctor)
// ---------------------------------------------------------------------------
/** Format a byte count as a short human string (B / KiB / MiB / GiB). */
function fmtBytes(n) {
    if (n < 1024)
        return `${n} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(1)} ${units[i]}`;
}
/**
 * Compute the context-pages storage usage report (#5): cold-object count and
 * bytes versus the configured cap, the oldest object's age, ledger shard count
 * and bytes (reported, never pruned — chain verification depends on them), and
 * whether raw cold storage is currently enabled. Used by `page-status` and the
 * `th doctor` storage check.
 */
function storageReport(paths) {
    const caps = (0, context_page_1.coldStoreCaps)();
    const usage = (0, context_page_1.coldStoreUsage)(paths);
    let ledgerBytes = 0;
    const shardFiles = listShardFiles((0, context_page_1.contextPagesRoot)(paths));
    for (const f of shardFiles) {
        try {
            ledgerBytes += fs.statSync(f).size;
        }
        catch { /* skip */ }
    }
    return {
        cold_objects: usage.object_count,
        cold_bytes: usage.total_bytes,
        max_bytes: caps.maxBytes,
        over_cap: caps.maxBytes > 0 && usage.total_bytes > caps.maxBytes,
        oldest_age_days: usage.oldest_mtime_ms !== null
            ? Math.round(((Date.now() - usage.oldest_mtime_ms) / (24 * 60 * 60 * 1000)) * 10) / 10
            : null,
        max_age_days: Math.round(caps.maxAgeMs / (24 * 60 * 60 * 1000)),
        ledger_shards: shardFiles.length,
        ledger_bytes: ledgerBytes,
        raw_store_enabled: (0, context_page_1.rawColdStoreEnabled)(),
    };
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
