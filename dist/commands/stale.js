"use strict";
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
exports.runStale = runStale;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const hash_1 = require("../core/hash");
const pipeline_1 = require("../core/pipeline");
const log_1 = require("../core/log");
/**
 * `th stale --since <hash>` — diff-scoped cascade re-verification (spec §18).
 *
 * Mechanical only (plan §3 boundary rule): given the recorded hash of an upstream
 * artifact, it computes whether that artifact's file has changed on disk and which
 * REGISTERED downstream artifacts are therefore stale. It NEVER persists anything
 * and never re-verifies — cascade re-verification is orchestrator-driven; this
 * command only computes the diff-scoped downstream set so the Critic can re-run
 * "only against the diff" rather than the whole project (§18).
 */
function formatIssues(issues) {
    return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}
const NOT_INIT = (0, output_1.failure)({
    human: "No state.json found. Run `th init` first.",
    data: { error: "not_initialized" },
});
/**
 * `th stale --since <hash>` — find the registered artifact whose recorded hash is
 * `sinceHash`, recompute its current file hash, and report the downstream
 * registered artifacts that are now stale. Exit 0 (computation only); failure
 * (exit 1) when `--since` is missing, the project is not initialized, or no
 * registered artifact has that hash.
 */
function runStale(paths, sinceHash) {
    if (!sinceHash)
        return (0, output_1.failure)({ human: "usage: th stale --since <hash>" });
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid:\n${formatIssues(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const artifacts = r.state.approved_artifacts;
    const upstream = artifacts.find((a) => a.hash === sinceHash);
    if (!upstream) {
        return (0, output_1.failure)({
            human: `unknown hash: no registered artifact has hash ${sinceHash}.`,
            data: { error: "unknown_hash", since: sinceHash },
        });
    }
    // Recompute the upstream file's CURRENT hash. A missing file is treated as a
    // change (its content no longer matches the recorded version).
    const abs = path.resolve(paths.root, upstream.file);
    let currentHash;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        currentHash = (0, hash_1.shortHash)(fs.readFileSync(abs, "utf8"));
    }
    const changed = currentHash !== sinceHash;
    // Downstream registered artifacts only — an unregistered downstream file has no
    // approved version to be stale against (§18).
    const registered = new Set(artifacts.map((a) => a.file));
    const stale = (0, pipeline_1.downstreamOf)(upstream.file).filter((f) => registered.has(f));
    (0, log_1.structuredLog)({ cmd: "stale", upstream: upstream.file, changed, stale: stale.length });
    const human = changed
        ? `Upstream ${upstream.file} changed; downstream stale (re-verify against the diff): ${stale.length ? stale.join(", ") : "(none)"}`
        : `Upstream ${upstream.file} unchanged; nothing downstream is stale.`;
    return (0, output_1.success)({ data: { upstream: upstream.file, changed, stale }, human });
}
