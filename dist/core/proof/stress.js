"use strict";
/**
 * Component 3 (Stress) — real, multi-process lock contention + large-repo scanner
 * load (plan Step 3). These are the SOLE source of the stress/concurrency verdict:
 * concurrent LIVE agentic pipelines are out of scope (live scenarios run
 * serialized), so the genuine concurrency proof is mechanical and process-level.
 *
 * {@link runLockContention} spawns N real `node dist/cli.js drift add` OS processes
 * (the exact pattern of `tests/concurrency.test.ts:32-61`) that all contend the
 * real `mkdir` state lock, then asserts no update was lost (final blocking count
 * === N), every id is unique, nothing deadlocked, and the contended batch finished
 * within a bound. {@link runScannerLoad} times a real `scanRepo` walk over a large
 * generated tree (respecting the scanner's FILE_COUNT/TOTAL_BYTES caps) and records
 * completion + a within-bound flag.
 *
 * R7: this module NEVER imports `src/mcp-server.ts`. It spawns the compiled CLI by
 * path (injected, default `dist/cli.js` resolved relative to this module) so it adds
 * no bundle coupling.
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
exports.defaultCliPath = defaultCliPath;
exports.runLockContention = runLockContention;
exports.runScannerLoad = runScannerLoad;
const os = __importStar(require("node:os"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const node_perf_hooks_1 = require("node:perf_hooks");
const paths_1 = require("../paths");
const state_store_1 = require("../state-store");
const scanner_1 = require("../repo-map/scanner");
const init_1 = require("../../commands/init");
const execFileP = (0, node_util_1.promisify)(node_child_process_1.execFile);
/** Default compiled CLI path: `<repo>/dist/cli.js`, resolved relative to this module. */
function defaultCliPath() {
    // Compiled: dist/core/proof/stress.js → dist/cli.js. Source (vitest): callers pass
    // an explicit path, so this best-effort default targets the dist layout.
    return path.resolve(__dirname, "..", "..", "cli.js");
}
/**
 * Spawn N real `node <cli> drift add` processes against ONE project and assert the
 * `withStateLock` serialization holds: every requirement-layer drift increments the
 * blocking counter and mints a unique `DRIFT-NNN` id (no lost read-modify-write).
 *
 * Returns a {@link StressResult}; never throws on contention — a spawn failure /
 * lock timeout surfaces as `deadlock:true` (a failed proof), not an exception.
 */
async function runLockContention(opts = {}) {
    const writers = Math.max(1, Math.floor(opts.writers ?? 8));
    const cliPath = opts.cliPath ?? defaultCliPath();
    const timeoutMs = opts.timeoutMs ?? 45_000;
    // Self-contained isolation: create+init a temp project unless one was supplied.
    let paths = opts.paths;
    let ownTemp = null;
    if (!paths) {
        ownTemp = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-stress-"));
        paths = (0, paths_1.resolveProjectPaths)(ownTemp);
        (0, init_1.runInit)(paths, {});
    }
    const started = node_perf_hooks_1.performance.now();
    let deadlock = false;
    try {
        const tasks = Array.from({ length: writers }, (_, i) => execFileP("node", [
            cliPath, "drift", "add",
            "--layer", "requirement",
            "--ref", `SLICE-${i}`,
            "--discovery", `stress discovery ${i}`,
            "--action", "build paused",
            "--cwd", paths.root,
        ], { env: { ...process.env, TH_NO_LOG: "1" }, timeout: timeoutMs }));
        const settled = await Promise.allSettled(tasks);
        // A rejected spawn means a process timed out / lock never released / CLI errored
        // — i.e. the contention was NOT bounded-and-resolved → a deadlock for the proof.
        deadlock = settled.some((r) => r.status === "rejected");
    }
    catch {
        deadlock = true;
    }
    const elapsedMs = node_perf_hooks_1.performance.now() - started;
    // No lost increment: every requirement-layer drift must have counted.
    const finalCount = (0, state_store_1.readState)(paths).state?.drift_open_blocking ?? 0;
    // No id collision: the serialized id minter produced `writers` distinct ids.
    let uniqueIds = 0;
    try {
        const log = fs.readFileSync(paths.driftLog, "utf8");
        uniqueIds = new Set([...log.matchAll(/DRIFT-(\d+)/g)].map((m) => m[1])).size;
    }
    catch {
        uniqueIds = 0;
    }
    if (ownTemp) {
        try {
            fs.rmSync(ownTemp, { recursive: true, force: true });
        }
        catch {
            /* best-effort cleanup */
        }
    }
    const lostUpdates = finalCount < writers;
    const pass = !lostUpdates && !deadlock && finalCount === writers && uniqueIds === writers;
    return {
        name: "lock-contention",
        writers,
        finalCount,
        uniqueIds,
        lostUpdates,
        deadlock,
        elapsedMs,
        pass,
    };
}
/** Sum the byte size of every regular file under `root` (best-effort; skips the
 *  scanner's generated/producer dirs so the total mirrors what the walk accounted). */
function sumFileBytes(root) {
    const SKIP = new Set([
        "node_modules", "dist", "build", "target", "out", ".git", ".cache",
        ".twinharness", ".agentic-sdlc", "coverage", "vendor",
    ]);
    let total = 0;
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (SKIP.has(e.name))
                    continue;
                stack.push(path.join(dir, e.name));
            }
            else if (e.isFile()) {
                try {
                    total += fs.statSync(path.join(dir, e.name)).size;
                }
                catch {
                    /* unreadable — skip */
                }
            }
        }
    }
    return total;
}
/**
 * Walk a large generated tree through the REAL `scanRepo` (respecting its
 * FILE_COUNT_CAP/TOTAL_BYTES_CAP), recording files scanned, bytes, elapsed time,
 * completion (no cap hit), and whether it finished within the provisional bound.
 */
function runScannerLoad(largeFixtureRoot, opts = {}) {
    const boundMs = opts.boundMs ?? 30_000;
    const started = node_perf_hooks_1.performance.now();
    const map = (0, scanner_1.scanRepo)(largeFixtureRoot);
    const ms = node_perf_hooks_1.performance.now() - started;
    return {
        files: map.files.length,
        bytes: sumFileBytes(largeFixtureRoot),
        ms,
        completed: map.scanReport.capHit === null,
        withinBound: ms <= boundMs,
    };
}
