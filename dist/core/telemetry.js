"use strict";
/**
 * Opt-in, LOCAL-ONLY run telemetry (G7).
 *
 * This module records nothing unless the operator explicitly enables it
 * (`th telemetry on`) and it NEVER leaves the machine: there is no network call
 * anywhere in this file or its callers. It exists so a team that wants a local
 * history of run health (e.g. how coverage/drift trended across `th scorecard`
 * snapshots) can keep one, without TwinHarness ever phoning home.
 *
 * Two files live under the state dir, alongside the verify.json/report.json pair
 * (and, like them, never inside state.json so the state schema and its
 * content-hash stability are untouched):
 *   - telemetry.json   → { "enabled": boolean }   (the opt-in switch)
 *   - telemetry.jsonl  → append-only log, one JSON object per line
 *
 * Boundary (plan §3): this is a pure data layer. It writes config and appends
 * log lines; it NEVER reads project commands, never executes anything, and never
 * opens a socket. `appendTelemetry` is a no-op while telemetry is disabled, so a
 * caller can unconditionally offer a snapshot and the switch decides.
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
exports.telemetryConfigPath = telemetryConfigPath;
exports.telemetryLogPath = telemetryLogPath;
exports.readTelemetryConfig = readTelemetryConfig;
exports.writeTelemetryConfig = writeTelemetryConfig;
exports.appendTelemetry = appendTelemetry;
exports.readTelemetryLog = readTelemetryLog;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const atomic_io_1 = require("./atomic-io");
/** `<stateDir>/telemetry.json` — the opt-in switch. */
function telemetryConfigPath(paths) {
    return path.join(paths.stateDir, "telemetry.json");
}
/** `<stateDir>/telemetry.jsonl` — the append-only local log. */
function telemetryLogPath(paths) {
    return path.join(paths.stateDir, "telemetry.jsonl");
}
/**
 * Read the opt-in config. A missing file (or any malformed/partial content)
 * reads as DISABLED — telemetry is off until the operator turns it on, and a
 * corrupt switch must never accidentally start recording.
 */
function readTelemetryConfig(paths) {
    const file = telemetryConfigPath(paths);
    if (!fs.existsSync(file))
        return { enabled: false };
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object" && typeof parsed.enabled === "boolean") {
            return { enabled: parsed.enabled };
        }
    }
    catch {
        // Fall through to disabled.
    }
    return { enabled: false };
}
/**
 * Write the opt-in config atomically (write temp, then rename over the target),
 * mirroring the state-store's durable-write pattern so a crashed/partial write
 * is never observed as a half-flipped switch.
 */
function writeTelemetryConfig(paths, cfg) {
    const serialized = JSON.stringify({ enabled: cfg.enabled }, null, 2) + "\n";
    // atomicWriteFile creates parent dirs and uses temp+rename with bounded retry (C-2 / S-C).
    (0, atomic_io_1.atomicWriteFile)(telemetryConfigPath(paths), serialized);
}
/**
 * Append one record (as a single JSON line) to the local log — but ONLY when
 * telemetry is enabled. While disabled this is a complete no-op: nothing is read
 * from the network and nothing is written to disk. Best-effort like the audit
 * ledger: a logging failure must never crash the command that offered the
 * snapshot.
 */
function appendTelemetry(paths, record) {
    if (!readTelemetryConfig(paths).enabled)
        return;
    try {
        fs.mkdirSync(paths.stateDir, { recursive: true });
        fs.appendFileSync(telemetryLogPath(paths), JSON.stringify(record) + "\n", "utf8");
    }
    catch {
        // Never throw from the (opt-in, local) telemetry path.
    }
}
/** Read + parse every log record. Missing file → empty. Malformed lines skipped. */
function readTelemetryLog(paths) {
    const file = telemetryLogPath(paths);
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
            // Skip malformed lines; the log is append-only and tolerant.
        }
    }
    return out;
}
