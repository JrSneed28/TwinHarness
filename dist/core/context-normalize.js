"use strict";
/**
 * context-normalize.ts — S3 normalize→fingerprint→delta pipeline (D-14).
 *
 * `normalize(raw): string` strips volatile tokens (timestamps, temp-paths,
 * ports, durations, IP addresses, UUIDs, ANSI escapes, hex addresses) so
 * that identical logical content in different runs produces the same string.
 *
 * `buildFingerprint(raw, paths, sensitive): Fingerprint` always cold-stores
 * the raw bytes first, then returns `{ normalized, raw_objref }`.
 *
 * `deltaNormalized(baseRaw, currentRaw, opts)` computes the delta over the
 * NORMALIZED forms of both inputs (D-14: delta-over-normalized).
 *
 * `DebugEpisodeCapsule` (spec Ontology line 157): durable debug state across
 * turns, keyed by failure fingerprint.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalize = normalize;
exports.deduplicateStackFrames = deduplicateStackFrames;
exports.buildFingerprint = buildFingerprint;
exports.hashNormalized = hashNormalized;
exports.deltaNormalized = deltaNormalized;
const hash_1 = require("./hash");
const context_page_1 = require("./context-page");
const context_diff_1 = require("./context-diff");
// ---------------------------------------------------------------------------
// normalize — deterministic volatile-stripping (D-14)
// ---------------------------------------------------------------------------
/**
 * Deterministic normalization pass.  Every substitution is order-stable and
 * idempotent: running normalize twice produces the same result as running it
 * once.
 *
 * Stripped / canonicalized:
 *   1. ANSI escape sequences (CSI, OSC, etc.)
 *   2. ISO 8601 timestamps and combined date-time strings
 *   3. Unix epoch values (13-digit ms, 10-digit s) — only isolated numerics
 *   4. Duration literals (123ms, 4.5s, 2m3s, 1h2m3s, 500ns, 200µs)
 *   5. Temp-path tokens (/tmp/…, /var/folders/…, Windows %TEMP%/…)
 *   6. UUIDs (any RFC 4122 variant, uppercase or lowercase)
 *   7. IPv4 addresses
 *   8. Hex memory addresses (0x…)
 *   9. Port patterns in host:port references (:NNNN / :NNNNN)
 */
function normalize(raw) {
    let s = raw;
    // 1. ANSI / VT escape sequences
    //    CSI sequences: ESC [ … final-byte
    // eslint-disable-next-line no-control-regex
    s = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    //    Remaining two-char ESC sequences (ESC + one char that is not '[')
    // eslint-disable-next-line no-control-regex
    s = s.replace(/\x1b[^[]/g, "");
    // 2. ISO 8601 combined date-time
    //    2024-01-15T09:32:11.456Z  |  2024-01-15T09:32:11+05:30
    //    2024-01-15 09:32:11       (space separator)
    s = s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<timestamp>");
    // 3. Epoch numerics — only when surrounded by non-digits to avoid partial
    //    matches inside longer numbers (hash strings, etc.)
    s = s.replace(/(?<!\d)\d{13}(?!\d)/g, "<epoch-ms>");
    s = s.replace(/(?<!\d)\d{10}(?!\d)/g, "<epoch-s>");
    // 4. Duration literals
    //    Combined forms first (longer patterns before shorter)
    s = s.replace(/\b\d+h\d+m\d+s\b/g, "<duration>"); // 1h2m3s
    s = s.replace(/\b\d+h\d+m\b/g, "<duration>"); // 1h2m
    s = s.replace(/\b\d+m\d+s\b/g, "<duration>"); // 2m3s
    //    Simple unit suffixes
    s = s.replace(/\b\d+(?:\.\d+)?(?:ms|ns|µs|us|s)\b/g, "<duration>");
    // 5. Temp-path tokens (POSIX and Windows)
    s = s.replace(/(?:\/(?:tmp|temp|var\/folders)|[A-Za-z]:[/\\](?:temp|tmp))[/\\][^\s,;)'"}\]>]*/gi, "<tmp-path>");
    // 6. UUIDs (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
    // 7. IPv4 addresses (before port stripping so "1.2.3.4:8080" → "<ip>:<port>")
    s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>");
    // 8. Hex memory addresses (0x followed by ≥4 hex digits)
    s = s.replace(/\b0x[0-9a-f]{4,}\b/gi, "<addr>");
    // 9. Port patterns — :NNNN or :NNNNN not preceded by another digit
    //    Matches patterns like "localhost:3000", "<ip>:8080", ":443"
    s = s.replace(/(?<!\d):\d{4,5}(?!\d)/g, ":<port>");
    return s;
}
// ---------------------------------------------------------------------------
// Stack-frame deduplication
// ---------------------------------------------------------------------------
/**
 * Collapse consecutive identical stack-frame lines within a trace.
 *
 * Recognizes Node.js (`    at …`), Python (`  File "…", line …`), and
 * similar indented frame patterns.  Repeated frames are replaced with a
 * single occurrence followed by `<N repeated>`.
 *
 * No-op on content that contains no recognizable stack frames (fast path).
 */
function deduplicateStackFrames(content) {
    // Fast path: skip if no stack-frame indicators present
    if (!/^\s+at\s+|^\s+File\s+"/m.test(content))
        return content;
    const lines = content.split(/\r?\n/);
    const out = [];
    let prevFrame = null;
    let repeatCount = 0;
    const isFrame = (line) => /^\s+at\s+/.test(line) || /^\s+File\s+"/.test(line);
    for (const line of lines) {
        if (isFrame(line)) {
            if (line === prevFrame) {
                repeatCount++;
            }
            else {
                if (prevFrame !== null && repeatCount > 0) {
                    out.push(`<${repeatCount} repeated>`);
                }
                out.push(line);
                prevFrame = line;
                repeatCount = 0;
            }
        }
        else {
            if (prevFrame !== null && repeatCount > 0) {
                out.push(`<${repeatCount} repeated>`);
            }
            prevFrame = null;
            repeatCount = 0;
            out.push(line);
        }
    }
    if (prevFrame !== null && repeatCount > 0) {
        out.push(`<${repeatCount} repeated>`);
    }
    return out.join("\n");
}
// ---------------------------------------------------------------------------
// Fingerprint builder
// ---------------------------------------------------------------------------
/**
 * D-14: Build a Fingerprint from raw content.
 *
 * The raw bytes are ALWAYS submitted to coldStorePut (which handles
 * sensitive content by returning the hash without writing bytes to disk).
 * The normalized form is produced via normalize + deduplicateStackFrames.
 */
function buildFingerprint(raw, paths, sensitive) {
    // Raw always cold-stored (D-14)
    const raw_objref = (0, context_page_1.coldStorePut)(paths, raw, sensitive);
    const normalized = deduplicateStackFrames(normalize(raw));
    return { normalized, raw_objref };
}
// ---------------------------------------------------------------------------
// hashNormalized — stable fingerprint hash
// ---------------------------------------------------------------------------
/**
 * Returns the SHA-256 hex hash of the normalized form of `raw`.
 * Stable across runs for identical logical content (AC-8).
 */
function hashNormalized(raw) {
    return (0, hash_1.hashContent)(deduplicateStackFrames(normalize(raw)));
}
// ---------------------------------------------------------------------------
// Delta-over-normalized (D-14)
// ---------------------------------------------------------------------------
/**
 * D-14: Compute a delta over the NORMALIZED forms of baseRaw and currentRaw.
 *
 * Both inputs are normalized before diffing so that volatile tokens (ports,
 * timestamps, addresses) do not inflate the diff or trigger FULL fallbacks.
 * The caller is responsible for separately cold-storing the raw bytes of each
 * via buildFingerprint or coldStorePut.
 */
function deltaNormalized(baseRaw, currentRaw, opts = {}) {
    const normalizedBase = deduplicateStackFrames(normalize(baseRaw));
    const normalizedCurrent = deduplicateStackFrames(normalize(currentRaw));
    return (0, context_diff_1.computeDelta)(normalizedBase, normalizedCurrent, opts);
}
