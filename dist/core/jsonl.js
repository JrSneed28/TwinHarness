"use strict";
/**
 * Tolerant JSONL primitives (#11 dedup) — the append-only-log read patterns shared
 * by the decision ledger (`core/decisions.ts`), the gate ledger (`core/ledger.ts`),
 * and the local telemetry log (`core/telemetry.ts`).
 *
 * All three logs are append-only and TOLERANT: a torn last write, a malformed
 * line, or a legacy/unsealed line must be SKIPPED, never crash a read. Each module
 * previously inlined its own copy of (a) a tolerant full forward read and/or (b) a
 * tolerant tail scan for the last valid line. They are unified here.
 *
 * SCOPE: bound to those three modules deliberately. The tolerant-read shape appears
 * in ~18 files across the codebase; chasing all of them is a separate follow-up and
 * is explicitly NOT done here (finding #11). Pure, dependency-light, never throws.
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
exports.safeParseJson = safeParseJson;
exports.readJsonlValues = readJsonlValues;
exports.readJsonlAudit = readJsonlAudit;
exports.scanTailValid = scanTailValid;
const fs = __importStar(require("node:fs"));
/** Tolerant JSON parse: the parsed value, or `undefined` on any parse error. */
function safeParseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/**
 * Tolerant FULL forward read of a JSONL file: every line that parses AND satisfies
 * `isValid`, in file order. Missing file → `[]`. Malformed / partial-tail /
 * schema-invalid lines are silently skipped (append-only, tolerant). Never throws.
 */
function readJsonlValues(file, isValid) {
    if (!fs.existsSync(file))
        return [];
    const out = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const parsed = safeParseJson(trimmed);
        if (parsed !== undefined && isValid(parsed))
            out.push(parsed);
    }
    return out;
}
/**
 * STRICT audit read of a JSONL file. Unlike {@link readJsonlValues}, which is the
 * tolerant live-path reader that silently skips bad lines, this reader counts
 * every anomaly so an auditor can distinguish:
 *   - a missing file          → all counters 0, read_error=false
 *   - an unreadable file       → read_error=true (e.g. the path is a directory)
 *   - a corrupt file           → malformed_lines / schema_invalid_lines > 0
 *   - a clean file             → valid_lines === total_lines
 *
 * Blank lines are ignored (never counted). Never throws.
 */
function readJsonlAudit(file, isValid) {
    const out = {
        values: [],
        total_lines: 0,
        valid_lines: 0,
        malformed_lines: 0,
        schema_invalid_lines: 0,
        read_error: false,
    };
    let text;
    try {
        if (!fs.existsSync(file))
            return out; // absent → genuinely empty, not an error
        text = fs.readFileSync(file, "utf8");
    }
    catch {
        out.read_error = true; // exists but unreadable (a directory, permissions, …)
        return out;
    }
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        out.total_lines++;
        const parsed = safeParseJson(trimmed);
        if (parsed === undefined) {
            out.malformed_lines++;
            continue;
        }
        if (!isValid(parsed)) {
            out.schema_invalid_lines++;
            continue;
        }
        out.valid_lines++;
        out.values.push(parsed);
    }
    return out;
}
/**
 * Tolerant TAIL scan of a JSONL file: walks lines from the END and returns the LAST
 * line that parses AND satisfies `isValid`, or `undefined` if none (or the file is
 * missing). Reads the file once but only parses the tail down to the last valid
 * line, so N appends that each do a tail read stay O(N) total. Tolerant: a
 * malformed / partial-tail / non-matching line is skipped while scanning upward.
 * Never throws.
 */
function scanTailValid(file, isValid) {
    if (!fs.existsSync(file))
        return undefined;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed)
            continue;
        const parsed = safeParseJson(trimmed);
        if (parsed !== undefined && isValid(parsed))
            return parsed;
    }
    return undefined;
}
