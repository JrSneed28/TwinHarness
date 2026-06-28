/**
 * Context-pages telemetry (S0 — OBSERVE only).
 *
 * Appends structured, secret-free records to
 * `.twinharness/context-pages/telemetry.jsonl`. All fields are counts, hashes,
 * or category labels — never raw content or credentials. Secret-safety is a TYPE
 * invariant: no raw-content field exists in {@link TelemetryRecord}, so there is
 * nothing to scrub at runtime.
 *
 * S0 = record everything, suppress nothing, change no externally visible behaviour.
 * Savings target = 0%.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import type { SourceKind } from "./context-page";
import { safeParseJson } from "./jsonl";

// ---------------------------------------------------------------------------
// Telemetry workload categories (8-value — Savings UI)
// ---------------------------------------------------------------------------

/**
 * The 8 savings-attribution categories assigned to each telemetry record by the
 * write-time classifier (`src/core/savings-classify.ts`, invoked in `hook.ts`).
 *
 * DISTINCT from the 5-value {@link import("./context-equivalence").WorkloadCategory}
 * (which routes corpus directories) — do not conflate. Persisted into the loose
 * `workload_category` string field; new records carry one of these 8 values,
 * legacy records carry older labels and are normalized at read time.
 */
export type TelemetryWorkloadCategory =
  | "file-read"
  | "artifact-summary"
  | "repo-analysis"
  | "test-output"
  | "debug-output"
  | "mcp-result"
  | "rehydration"
  | "compaction";

/** Current telemetry record schema version. Absent on a record ⇒ legacy v1. */
export const TELEMETRY_SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// Token estimator (defined locally — src/core/context.ts does not exist)
// ---------------------------------------------------------------------------

/**
 * Heuristic token estimate: `ceil(chars / 4)`. Deterministic, clock-free.
 * Matches the char/4 convention used across the codebase (plan §3 "token budget").
 */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Absolute path of the context-pages data directory:
 * `<stateDir>/context-pages/` (NEVER inside state.json).
 */
export function contextPagesDir(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "context-pages");
}

/** Absolute path of the session-wide telemetry log. */
export function telemetryFilePath(paths: ProjectPaths): string {
  return path.join(contextPagesDir(paths), "telemetry.jsonl");
}

// ---------------------------------------------------------------------------
// TelemetryRecord (D-20 verbatim field set)
// ---------------------------------------------------------------------------

/**
 * One telemetry sample. ALL fields are counts, hashes, or categorical labels —
 * NEVER raw content, secrets, or PII. The shape is enforced by design so
 * {@link recordTelemetry} never needs to strip fields at runtime.
 *
 * Required: `ts`, `session_id`, `epoch`. All other fields are optional to allow
 * callers to emit partial records without faking values.
 */
export interface TelemetryRecord {
  /**
   * Record schema version. Absent ⇒ legacy v1 (pre-savings-UI). Readers MUST
   * tolerate absence and treat it as 1. New records set
   * {@link TELEMETRY_SCHEMA_VERSION}.
   */
  schema_version?: number;
  /** ISO-8601 timestamp (ms precision). */
  ts: string;
  /** Session identifier (opaque token — not itself a secret value). */
  session_id: string;
  /** Agent identifier when positively confirmed, else omitted. */
  agent_id?: string;
  /** Context epoch counter at record time. */
  epoch: number;
  /** Tool type label (e.g. "Read", "Bash", "mcp__github__…"). */
  tool_type?: string;
  /** Workload category (e.g. "file-read", "search", "bash"). */
  workload_category?: string;
  /** Tier label (e.g. "s0", "s1"). */
  tier?: string;
  /** Stage label within the tier. */
  stage?: string;
  /** Slice label within the stage. */
  slice?: string;
  /** Page identifier — shortHash of page identity composite (never raw content). */
  page_id?: string;
  /** Estimated tokens in the original content (heuristic char/4). */
  orig_tokens?: number;
  /** Estimated tokens in the returned/served content. */
  returned_tokens?: number;
  /** Whether a duplicate was detected. */
  dup_detected?: boolean;
  /** Whether a duplicate was avoided (context saving realised). */
  dup_avoided?: boolean;
  /** Delta tokens saved by deduplication (0 at S0). */
  delta_tokens?: number;
  /** Cumulative count of full rehydrations in this session. */
  full_rehydrations?: number;
  /** Cumulative count of compaction resets in this session. */
  compaction_resets?: number;
  /** Count of parent pages (for delta records). */
  parent_pages?: number;
  /** Count of child pages (for delta records). */
  child_pages?: number;
  /** Cumulative count of assumed-resident misses in this session. */
  assumed_resident_misses?: number;
  /** Outcome of the residency verification (e.g. "ok", "miss", "skip"). */
  verification_outcome?: string;
  /** Turn count at record time. */
  turns?: number;
  /** Retry count for this operation. */
  retries?: number;
  /** Wall-clock runtime in milliseconds for this operation. */
  runtime_ms?: number;
  /** Reduction kind label (e.g. "none", "delta", "hash-only", "lossy"). */
  reduction_kind?: string;
  /**
   * Source kind that produced the underlying page (file/search/bash/mcp/…).
   * Persisted at write time so read-time classification rules 6/7 are
   * reproducible from telemetry.jsonl alone. Never raw content.
   */
  source_kind?: SourceKind;
  /**
   * Short content hash of the page identity (never raw content). Used as part
   * of the rehydration-payback idempotency key `(page_id, epoch, content_hash)`
   * so repeated rehydrations of the same page in one epoch subtract once.
   */
  content_hash?: string;
  /**
   * Full tokens re-served back into context by a rehydration event (the
   * "payback" that offsets earlier suppression credit). Written ONLY by the
   * authoritative R7 post-compact host path. Absent ⇒ payback unmeasured for
   * this page/epoch ⇒ headline is an upper bound.
   */
  rehydrated_full_tokens?: number;
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append one {@link TelemetryRecord} to `telemetry.jsonl`, creating the
 * `context-pages/` directory if it does not yet exist.
 *
 * Fail-safe: any I/O error is swallowed silently — S0 must NEVER block or
 * alter the surrounding tool call on error. No lock is held: the file is
 * append-only and OS-level line appends are atomic for lines < PIPE_BUF
 * (mirrors the external-receipts precedent in `receipts.ts`).
 */
export function recordTelemetry(paths: ProjectPaths, rec: TelemetryRecord): void {
  try {
    const file = telemetryFilePath(paths);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
  } catch {
    // Fail-safe: S0 must never interfere with the surrounding tool call.
  }
}

// ---------------------------------------------------------------------------
// Transcript actuals (best-effort, tolerant)
// ---------------------------------------------------------------------------

/**
 * Headline actuals parsed from a Claude Code transcript file.
 *
 * `input_tokens` / `output_tokens` are the summed per-turn values; `context_window`
 * is the absolute-token watermark denominator (the model's max-context ceiling,
 * taken as the maximum seen across all lines that carry it).
 */
export interface TranscriptActuals {
  /** Summed input tokens across all turns. */
  input_tokens: number;
  /** Summed output tokens across all turns. */
  output_tokens: number;
  /** Model context window ceiling (denominator for watermark %; absent when unknown). */
  context_window?: number;
}

/**
 * Best-effort parse of a transcript JSONL file for headline token actuals.
 *
 * Tolerant: missing file, garbled lines, absent fields → `undefined`, never throw.
 * Looks for `input_tokens` / `output_tokens` directly on each line OR nested under
 * a `"usage"` sub-object, and for `context_window` as the watermark denominator.
 */
export function transcriptActuals(transcript_path: string): TranscriptActuals | undefined {
  try {
    if (!fs.existsSync(transcript_path)) return undefined;
    const raw = fs.readFileSync(transcript_path, "utf8");
    let input_tokens = 0;
    let output_tokens = 0;
    let context_window: number | undefined;
    let found = false;

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = safeParseJson(trimmed);
      if (typeof parsed !== "object" || parsed === null) continue;
      const rec = parsed as Record<string, unknown>;

      // Token usage may live at the top level or nested under "usage".
      const usage =
        typeof rec["usage"] === "object" && rec["usage"] !== null
          ? (rec["usage"] as Record<string, unknown>)
          : undefined;

      const inp =
        typeof rec["input_tokens"] === "number"
          ? rec["input_tokens"]
          : typeof usage?.["input_tokens"] === "number"
            ? (usage["input_tokens"] as number)
            : undefined;

      const out =
        typeof rec["output_tokens"] === "number"
          ? rec["output_tokens"]
          : typeof usage?.["output_tokens"] === "number"
            ? (usage["output_tokens"] as number)
            : undefined;

      if (inp !== undefined) {
        input_tokens += inp;
        found = true;
      }
      if (out !== undefined) {
        output_tokens += out;
        found = true;
      }

      // Context window ceiling — take the maximum seen across all lines.
      const cw =
        typeof rec["context_window"] === "number"
          ? rec["context_window"]
          : typeof usage?.["context_window"] === "number"
            ? (usage["context_window"] as number)
            : undefined;
      if (cw !== undefined && (context_window === undefined || cw > context_window)) {
        context_window = cw;
      }
    }

    if (!found) return undefined;
    return {
      input_tokens,
      output_tokens,
      ...(context_window !== undefined ? { context_window } : {}),
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// S0 probe counters
// ---------------------------------------------------------------------------

/**
 * S0 probes track three signals that inform whether agent-id / session-id
 * attribution is observable from hook payloads. Counters are in-memory
 * (per-process); flushed via {@link recordTelemetry} by the hook handler.
 *
 * (a) agent_id positively present on tool-hook events.
 * (b) session_id shared among subagent hook events.
 * (c) SubagentStart events fired in this process lifetime.
 */
interface S0Probes {
  agentIdPresentOnToolHooks: number;
  sessionIdSharedAmongSubagents: number;
  subagentStartFired: number;
}

const _probes: S0Probes = {
  agentIdPresentOnToolHooks: 0,
  sessionIdSharedAmongSubagents: 0,
  subagentStartFired: 0,
};

/** Return a snapshot of the current probe counters (for telemetry flush / tests). */
export function readS0Probes(): Readonly<S0Probes> {
  return { ..._probes };
}

/**
 * Reset all S0 probe counters to zero.
 * Intended for test isolation only — production code should never call this.
 */
export function resetS0Probes(): void {
  _probes.agentIdPresentOnToolHooks = 0;
  _probes.sessionIdSharedAmongSubagents = 0;
  _probes.subagentStartFired = 0;
}

/**
 * (a) Record that a PostToolUse hook event carried a positively-confirmed
 * `agent_id`. Called by the hook handler in `commands/hook.ts`.
 */
export function probeAgentIdPresentOnToolHook(): void {
  _probes.agentIdPresentOnToolHooks++;
}

/**
 * (b) Record that a subagent hook event observed a `session_id` that matches
 * a known parent session (session-id-sharing is observable in this payload).
 */
export function probeSessionIdShared(): void {
  _probes.sessionIdSharedAmongSubagents++;
}

/**
 * (c) Record that a SubagentStart hook event was fired (the hook was invoked
 * and control reached this counter increment).
 */
export function probeSubagentStartFired(): void {
  _probes.subagentStartFired++;
}
