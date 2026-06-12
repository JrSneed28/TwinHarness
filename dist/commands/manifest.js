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
exports.buildManifest = buildManifest;
exports.runManifestExport = runManifestExport;
const fs = __importStar(require("node:fs"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const drift_log_1 = require("../core/drift-log");
const ledger_1 = require("../core/ledger");
/** Sort an object's keys for deterministic serialization. */
function sortedRecord(obj) {
    const out = {};
    for (const k of Object.keys(obj).sort())
        out[k] = obj[k];
    return out;
}
function buildManifest(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists || !r.state)
        return null;
    const s = r.state;
    const driftText = fs.existsSync(paths.driftLog) ? fs.readFileSync(paths.driftLog, "utf8") : "";
    const driftEntries = (0, drift_log_1.parseDriftEntries)(driftText).map((e) => ({ id: e.id, ref: e.ref, layer: e.layer }));
    const ledger = (0, ledger_1.readLedger)(paths).map((e) => {
        // Drop the volatile timestamp so the manifest is deterministic.
        const { ts: _ts, ...rest } = e;
        void _ts;
        return rest;
    });
    return {
        schema_version: s.schema_version ?? null,
        tier: s.tier,
        current_stage: s.current_stage,
        implementation_allowed: s.implementation_allowed,
        write_gate: s.write_gate ?? "ask",
        blast_radius_flags: [...s.blast_radius_flags].sort(),
        approved_artifacts: s.approved_artifacts.map((a) => ({ file: a.file, version: a.version, hash: a.hash })),
        slices: s.slices.map((sl) => ({ id: sl.id, status: sl.status, components: sl.components })),
        drift_open_blocking: s.drift_open_blocking,
        drift_entries: driftEntries,
        revise_loop_counts: sortedRecord(s.revise_loop_counts),
        open_questions: s.open_questions,
        gate_ledger: { count: ledger.length, events: ledger },
    };
}
/** `th manifest export` — emit the deterministic run snapshot. */
function runManifestExport(paths) {
    const manifest = buildManifest(paths);
    if (manifest === null) {
        const r = (0, state_store_1.readState)(paths);
        if (!r.exists)
            return (0, output_1.failure)({ human: "No state.json found. Run `th init` first.", data: { error: "not_initialized" } });
        return (0, output_1.failure)({ human: "state.json is invalid; cannot export a manifest.", data: { error: "invalid_state", issues: r.issues } });
    }
    const human = [
        `Run manifest (schema v${manifest.schema_version ?? "legacy"})`,
        `  Tier:            ${manifest.tier ?? "(unclassified)"}`,
        `  Stage:           ${manifest.current_stage}`,
        `  Implementation:  ${manifest.implementation_allowed ? "allowed" : "not allowed"}`,
        `  Blast-radius:    ${manifest.blast_radius_flags.length ? manifest.blast_radius_flags.join(", ") : "(none)"}`,
        `  Artifacts:       ${manifest.approved_artifacts.length}`,
        `  Slices:          ${manifest.slices.length} (${manifest.slices.filter((s) => s.status === "done").length} done)`,
        `  Open drift:      ${manifest.drift_open_blocking} blocking, ${manifest.drift_entries.length} total`,
        `  Gate ledger:     ${manifest.gate_ledger.count} entries`,
        "",
        "Pass --json for the full deterministic manifest.",
    ].join("\n");
    return (0, output_1.success)({ data: { manifest }, human });
}
