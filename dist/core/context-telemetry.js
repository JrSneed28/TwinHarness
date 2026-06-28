"use strict";
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
exports.TELEMETRY_SCHEMA_VERSION = void 0;
exports.estimateTokens = estimateTokens;
exports.contextPagesDir = contextPagesDir;
exports.telemetryFilePath = telemetryFilePath;
exports.recordTelemetry = recordTelemetry;
exports.transcriptActuals = transcriptActuals;
exports.readS0Probes = readS0Probes;
exports.resetS0Probes = resetS0Probes;
exports.probeAgentIdPresentOnToolHook = probeAgentIdPresentOnToolHook;
exports.probeSessionIdShared = probeSessionIdShared;
exports.probeSubagentStartFired = probeSubagentStartFired;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const jsonl_1 = require("./jsonl");
/** Current telemetry record schema version. Absent on a record ⇒ legacy v1. */
exports.TELEMETRY_SCHEMA_VERSION = 2;
// ---------------------------------------------------------------------------
// Token estimator (defined locally — src/core/context.ts does not exist)
// ---------------------------------------------------------------------------
/**
 * Heuristic token estimate: `ceil(chars / 4)`. Deterministic, clock-free.
 * Matches the char/4 convention used across the codebase (plan §3 "token budget").
 */
function estimateTokens(s) {
    return Math.ceil(s.length / 4);
}
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
/**
 * Absolute path of the context-pages data directory:
 * `<stateDir>/context-pages/` (NEVER inside state.json).
 */
function contextPagesDir(paths) {
    return path.join(paths.stateDir, "context-pages");
}
/** Absolute path of the session-wide telemetry log. */
function telemetryFilePath(paths) {
    return path.join(contextPagesDir(paths), "telemetry.jsonl");
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
function recordTelemetry(paths, rec) {
    try {
        const file = telemetryFilePath(paths);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
    }
    catch {
        // Fail-safe: S0 must never interfere with the surrounding tool call.
    }
}
/**
 * Best-effort parse of a transcript JSONL file for headline token actuals.
 *
 * Tolerant: missing file, garbled lines, absent fields → `undefined`, never throw.
 * Looks for `input_tokens` / `output_tokens` directly on each line OR nested under
 * a `"usage"` sub-object, and for `context_window` as the watermark denominator.
 */
function transcriptActuals(transcript_path) {
    try {
        if (!fs.existsSync(transcript_path))
            return undefined;
        const raw = fs.readFileSync(transcript_path, "utf8");
        let input_tokens = 0;
        let output_tokens = 0;
        let context_window;
        let found = false;
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            const parsed = (0, jsonl_1.safeParseJson)(trimmed);
            if (typeof parsed !== "object" || parsed === null)
                continue;
            const rec = parsed;
            // Token usage may live at the top level or nested under "usage".
            const usage = typeof rec["usage"] === "object" && rec["usage"] !== null
                ? rec["usage"]
                : undefined;
            const inp = typeof rec["input_tokens"] === "number"
                ? rec["input_tokens"]
                : typeof usage?.["input_tokens"] === "number"
                    ? usage["input_tokens"]
                    : undefined;
            const out = typeof rec["output_tokens"] === "number"
                ? rec["output_tokens"]
                : typeof usage?.["output_tokens"] === "number"
                    ? usage["output_tokens"]
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
            const cw = typeof rec["context_window"] === "number"
                ? rec["context_window"]
                : typeof usage?.["context_window"] === "number"
                    ? usage["context_window"]
                    : undefined;
            if (cw !== undefined && (context_window === undefined || cw > context_window)) {
                context_window = cw;
            }
        }
        if (!found)
            return undefined;
        return {
            input_tokens,
            output_tokens,
            ...(context_window !== undefined ? { context_window } : {}),
        };
    }
    catch {
        return undefined;
    }
}
const _probes = {
    agentIdPresentOnToolHooks: 0,
    sessionIdSharedAmongSubagents: 0,
    subagentStartFired: 0,
};
/** Return a snapshot of the current probe counters (for telemetry flush / tests). */
function readS0Probes() {
    return { ..._probes };
}
/**
 * Reset all S0 probe counters to zero.
 * Intended for test isolation only — production code should never call this.
 */
function resetS0Probes() {
    _probes.agentIdPresentOnToolHooks = 0;
    _probes.sessionIdSharedAmongSubagents = 0;
    _probes.subagentStartFired = 0;
}
/**
 * (a) Record that a PostToolUse hook event carried a positively-confirmed
 * `agent_id`. Called by the hook handler in `commands/hook.ts`.
 */
function probeAgentIdPresentOnToolHook() {
    _probes.agentIdPresentOnToolHooks++;
}
/**
 * (b) Record that a subagent hook event observed a `session_id` that matches
 * a known parent session (session-id-sharing is observable in this payload).
 */
function probeSessionIdShared() {
    _probes.sessionIdSharedAmongSubagents++;
}
/**
 * (c) Record that a SubagentStart hook event was fired (the hook was invoked
 * and control reached this counter increment).
 */
function probeSubagentStartFired() {
    _probes.subagentStartFired++;
}
