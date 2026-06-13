"use strict";
/**
 * Project verification config + report (the data layer for `th verify`).
 *
 * `th verify run` is the ONE command that executes configured project test
 * commands. It is deliberately quarantined here, away from every other `th`
 * command, because executing project commands is the single exception to the
 * CLI's "records and computes; never re-runs" boundary (plan §3) — it exists so
 * the run-health view (`th coverage report`, `th doctor`) can reflect whether the
 * suite is actually green, not just whether tests are anchored.
 *
 * Two small JSON files live under the state dir, never inside state.json (so the
 * state schema and its content-hash stability are untouched):
 *   - verify.json        → { commands: string[] }  (the configured commands)
 *   - verify-report.json → the last run's results
 *
 * Security note (see SECURITY.md): the configured commands are run with the
 * shell, in the project root. They are operator-authored, exactly like the
 * scripts a developer would run by hand; `th verify run` never sources commands
 * from untrusted artifact content.
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
exports.verifyConfigPath = verifyConfigPath;
exports.verifyReportPath = verifyReportPath;
exports.readVerifyConfig = readVerifyConfig;
exports.writeVerifyConfig = writeVerifyConfig;
exports.readVerifyReport = readVerifyReport;
exports.writeVerifyReport = writeVerifyReport;
exports.runCommands = runCommands;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const OUTPUT_TAIL_CHARS = 2000;
function verifyConfigPath(paths) {
    return path.join(paths.stateDir, "verify.json");
}
function verifyReportPath(paths) {
    return path.join(paths.stateDir, "verify-report.json");
}
/** Read the configured commands. Missing/invalid file → empty command list. */
function readVerifyConfig(paths) {
    const file = verifyConfigPath(paths);
    if (!fs.existsSync(file))
        return { commands: [] };
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.commands)) {
            const commands = parsed.commands.filter((c) => typeof c === "string");
            return { commands };
        }
    }
    catch {
        // Fall through to empty.
    }
    return { commands: [] };
}
function writeVerifyConfig(paths, config) {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(verifyConfigPath(paths), JSON.stringify(config, null, 2) + "\n", "utf8");
}
/** Read the last verify report, or null when none has been written. */
function readVerifyReport(paths) {
    const file = verifyReportPath(paths);
    if (!fs.existsSync(file))
        return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
            return parsed;
        }
    }
    catch {
        // Corrupt report → treat as absent.
    }
    return null;
}
function writeVerifyReport(paths, report) {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(verifyReportPath(paths), JSON.stringify(report, null, 2) + "\n", "utf8");
}
/**
 * Execute each command in order via the shell, in `root`. Stops nothing — every
 * command runs so the report is complete — but `ok` is false if any fail. A
 * command that cannot be spawned is recorded as a failure (exit 127) rather than
 * throwing. `now` is injectable so callers/tests control the timestamp.
 */
function runCommands(root, commands, now = () => new Date()) {
    const results = [];
    for (const command of commands) {
        const start = Date.now();
        const proc = (0, node_child_process_1.spawnSync)(command, {
            cwd: root,
            shell: true,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
        });
        const durationMs = Date.now() - start;
        const combined = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
        const outputTail = combined.length > OUTPUT_TAIL_CHARS ? combined.slice(-OUTPUT_TAIL_CHARS) : combined;
        // spawnSync returns status null when the process was killed or failed to spawn.
        const exitCode = proc.status ?? 127;
        results.push({ command, exitCode, ok: exitCode === 0, durationMs, outputTail });
    }
    return {
        ok: results.every((r) => r.ok),
        ranAt: now().toISOString(),
        results,
    };
}
