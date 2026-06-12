"use strict";
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
exports.GATE_LEDGER_KEYS = void 0;
exports.ledgerPath = ledgerPath;
exports.appendLedger = appendLedger;
exports.readLedger = readLedger;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/** Top-level state keys whose mutation is gate-relevant and therefore audited. */
exports.GATE_LEDGER_KEYS = new Set([
    "implementation_allowed",
    "drift_open_blocking",
    "write_gate",
    "tier",
    "blast_radius_flags",
]);
/** `<stateDir>/gate-ledger.jsonl` — the audit record's location. */
function ledgerPath(paths) {
    return path.join(paths.stateDir, "gate-ledger.jsonl");
}
/**
 * Append one entry to the gate ledger. Best-effort: a ledger failure must never
 * crash the command that triggered it (mirrors `structuredLog`).
 */
function appendLedger(paths, entry) {
    try {
        fs.mkdirSync(paths.stateDir, { recursive: true });
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
        fs.appendFileSync(ledgerPath(paths), line, "utf8");
    }
    catch {
        // Never throw from the audit path.
    }
}
/** Read + parse every ledger entry. Missing file → empty. Bad lines skipped. */
function readLedger(paths) {
    const file = ledgerPath(paths);
    if (!fs.existsSync(file))
        return [];
    const out = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === "object" && parsed !== null)
                out.push(parsed);
        }
        catch {
            // Skip malformed lines; the ledger is append-only and tolerant.
        }
    }
    return out;
}
