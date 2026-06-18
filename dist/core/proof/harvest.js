"use strict";
/**
 * Scenario harvest (plan Step 1 — the producer→engine boundary).
 *
 * {@link harvestScenario} reads a finished scenario sandbox and normalizes the
 * REAL artifacts a live run left behind into one VERSIONED {@link ScenarioArtifacts}
 * snapshot — the single thing the deterministic engine (assert / coverage-matrix /
 * regression / report) consumes. It COMPOSES the existing read/build validators and
 * recomputes nothing (plan Principle 3): `readState`, `buildManifest`,
 * `runScorecard(...).data`, `readLedger`+`verifyLedgerChain`,
 * `readDecisionEvents`+`verifyChain`, `readTelemetryLog`, `activeLeases`/`liveLeases`,
 * `sliceProgress`/`artifactIntegrity`, plus the dedicated `proof-calls.jsonl` trail.
 *
 * PATH-AGNOSTIC (MINOR fix): every artifact is sourced via `paths.stateDir` /
 * `paths.stateFile`, never a literal `.twinharness/...`, so an `.agentic-sdlc`-seeded
 * brownfield root harvests identically to a `.twinharness` one.
 *
 * The live MCP-tool-call set comes ONLY from the dedicated `proof-calls.jsonl` trail
 * (C1/A1) — NOT telemetry route events, NOT `telemetry.jsonl`, NOT the self-test
 * loop — so coverage evidence is decoupled from the M3 telemetry opt-in.
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
exports.proofCallsPath = proofCallsPath;
exports.readProofCalls = readProofCalls;
exports.harvestScenario = harvestScenario;
const path = __importStar(require("node:path"));
const state_store_1 = require("../state-store");
const ledger_1 = require("../ledger");
const decisions_1 = require("../decisions");
const telemetry_1 = require("../telemetry");
const leases_1 = require("../leases");
const health_1 = require("../health");
const jsonl_1 = require("../jsonl");
const manifest_1 = require("../../commands/manifest");
const scorecard_1 = require("../../commands/scorecard");
const types_1 = require("./types");
/** `<stateDir>/proof-calls.jsonl` — the dedicated producer-side MCP call trail (C1/A1). */
function proofCallsPath(paths) {
    return path.join(paths.stateDir, "proof-calls.jsonl");
}
/** Shape-guard for one `proof-calls.jsonl` line ({tool,ts,ok,reason?}); malformed lines are skipped. */
function isProofCall(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const c = parsed;
    if (typeof c.tool !== "string" || typeof c.ts !== "string" || typeof c.ok !== "boolean")
        return false;
    // `reason` is optional; when present it must be a string (the failure cause for #5).
    return c.reason === undefined || typeof c.reason === "string";
}
/**
 * Read the dedicated MCP call trail (C1/A1/A2). Missing file → `[]`; malformed
 * lines skipped — tolerant, mirroring `readLedger`/`readTelemetryLog`. The producer
 * (mcp-server CallTool handler) writes `{tool,ts,ok}` at BOTH the success and catch
 * sites, so `ok:false` calls are recorded too.
 */
function readProofCalls(paths) {
    return (0, jsonl_1.readJsonlValues)(proofCallsPath(paths), isProofCall);
}
/**
 * Summarize recorded `th route` telemetry: count "route" events and tally them by
 * chosen model. Local-only — operates over the already-read telemetry records, never
 * the network. Mirrors the (unexported) scorecard summarizer.
 */
function summarizeRouting(records) {
    const models = {};
    let events = 0;
    for (const rec of records) {
        if (rec.event !== "route")
            continue;
        events++;
        if (typeof rec.model === "string" && rec.model.length > 0) {
            models[rec.model] = (models[rec.model] ?? 0) + 1;
        }
    }
    return { events, models };
}
/**
 * Harvest one scenario sandbox into a normalized {@link ScenarioArtifacts} snapshot.
 * Pure composition of existing validators (no SUT re-run). `briefId` may be supplied
 * when the caller knows which brief produced the run; absent → null.
 */
function harvestScenario(paths, briefId = null) {
    const r = (0, state_store_1.readState)(paths);
    const state = r.state ?? null;
    const stateValid = r.exists && r.state !== undefined;
    const stateIssues = r.issues ?? [];
    const manifest = (0, manifest_1.buildManifest)(paths);
    // Composite run stats. runScorecard returns a CommandResult; harvest takes its
    // `data` payload on success, null otherwise (e.g. uninitialized root).
    let scorecard = null;
    const sc = (0, scorecard_1.runScorecard)(paths, { json: true });
    if (sc.ok && sc.data)
        scorecard = sc.data;
    const ledger = (0, ledger_1.readLedger)(paths);
    const ledgerChainValid = (0, ledger_1.verifyLedgerChain)(ledger).ok;
    const decisions = (0, decisions_1.readDecisionEvents)(paths);
    const decisionsChainValid = (0, decisions_1.verifyChain)(decisions).ok;
    const telemetry = (0, telemetry_1.readTelemetryLog)(paths);
    const routing = summarizeRouting(telemetry);
    const leases = (0, leases_1.activeLeases)(paths);
    const live = state ? (0, leases_1.liveLeases)(paths, state.slices) : [];
    const progress = state ? (0, health_1.sliceProgress)(state) : null;
    const integrity = state ? (0, health_1.artifactIntegrity)(paths, state) : [];
    const mcpCalls = readProofCalls(paths);
    return {
        harvestVersion: types_1.HARVEST_VERSION,
        briefId,
        scenarioRoot: paths.root,
        stateDir: paths.stateDir,
        state,
        stateValid,
        stateIssues,
        manifest,
        scorecard,
        ledger,
        ledgerChainValid,
        decisions,
        decisionsChainValid,
        telemetry,
        routing,
        leases,
        liveLeases: live,
        sliceProgress: progress,
        artifactIntegrity: integrity,
        mcpCalls,
    };
}
