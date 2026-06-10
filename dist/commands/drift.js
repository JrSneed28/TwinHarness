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
exports.runDriftAdd = runDriftAdd;
exports.runDriftList = runDriftList;
exports.runDriftResolve = runDriftResolve;
const fs = __importStar(require("node:fs"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const drift_log_1 = require("../core/drift-log");
const log_1 = require("../core/log");
/**
 * `th drift` — append-only access to the bidirectional drift log (spec §10).
 * Mechanical only (plan §3 boundary rule): the CLI records discoveries and tracks
 * the BLOCKING count; it never decides whether a requirement is contradicted —
 * the caller declares the layer. DERIVED-layer drift auto-applies (non-blocking);
 * REQUIREMENT-layer drift is BLOCKING and increments `state.drift_open_blocking`,
 * which the stop-gate (§10) reads to refuse premature completion.
 */
/**
 * Replicated from init.ts so `drift add` can self-heal a missing drift-log.md
 * (e.g. a project where init's drift-log was deleted). Kept byte-for-byte
 * identical to the header init.ts writes.
 */
const DRIFT_LOG_HEADER = `# Drift Log

Append-only record of implementation discoveries (spec §10). Each entry records the
discovery, the affected layer (derived vs. requirement), the action taken, and the
escalation status.

Format:

\`\`\`
## DRIFT-NNN  (SLICE-x / TASK-yyy, Builder)  — <layer>, <action>
Discovery : ...
Action    : ...
Escalation: ...
\`\`\`
`;
function formatIssues(issues) {
    return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}
const NOT_INIT = (0, output_1.failure)({
    human: "No state.json found. Run `th init` first.",
    data: { error: "not_initialized" },
});
/** Read drift-log.md, creating it from the header if absent. */
function readDriftLog(paths) {
    if (!fs.existsSync(paths.driftLog)) {
        fs.writeFileSync(paths.driftLog, DRIFT_LOG_HEADER, "utf8");
        return DRIFT_LOG_HEADER;
    }
    return fs.readFileSync(paths.driftLog, "utf8");
}
/** Append a block to drift-log.md (append-only — never rewrites history). */
function appendDriftLog(paths, block) {
    const current = readDriftLog(paths);
    // Ensure a separating newline before the appended block.
    const sep = current.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(paths.driftLog, `${current}${sep}${block}`, "utf8");
}
/**
 * `th drift add --layer derived|requirement [--ref ...] [--discovery ...] [--action ...] [--escalation ...]`
 * Compute the next DRIFT id, append the formatted entry. A `requirement`-layer
 * entry is BLOCKING: it increments `state.drift_open_blocking` and defaults its
 * escalation to "awaiting human decision".
 */
function runDriftAdd(paths, opts) {
    const layer = opts.layer;
    if (layer !== "derived" && layer !== "requirement") {
        return (0, output_1.failure)({
            human: "usage: th drift add --layer <derived|requirement> [--ref ...] [--discovery ...] [--action ...] [--escalation ...]",
            data: { error: "invalid_layer" },
        });
    }
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `Existing state.json is invalid; fix it before logging drift:\n${formatIssues(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const blocking = layer === "requirement";
    const current = readDriftLog(paths);
    const id = (0, drift_log_1.nextDriftId)(current);
    const escalation = opts.escalation ?? (blocking ? "awaiting human decision" : "none (no requirement contradicted).");
    const block = (0, drift_log_1.formatDriftEntry)({
        id,
        ref: opts.ref ?? "SLICE-? / TASK-?",
        layer,
        discovery: opts.discovery ?? "",
        action: opts.action ?? "",
        escalation,
        source: opts.source,
    });
    appendDriftLog(paths, block);
    let driftOpenBlocking = r.state.drift_open_blocking;
    if (blocking) {
        driftOpenBlocking += 1;
        (0, state_store_1.writeState)(paths, { ...r.state, drift_open_blocking: driftOpenBlocking });
    }
    (0, log_1.structuredLog)({ cmd: "drift add", id, layer, blocking, drift_open_blocking: driftOpenBlocking });
    return (0, output_1.success)({
        data: { id, layer, blocking, drift_open_blocking: driftOpenBlocking },
        human: blocking
            ? `${id} logged (requirement layer, BLOCKING). Open blocking drift: ${driftOpenBlocking}.`
            : `${id} logged (derived layer, auto-applied).`,
    });
}
/** `th drift list` — parse + report every entry plus the open BLOCKING count. */
function runDriftList(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid:\n${formatIssues(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const text = fs.existsSync(paths.driftLog) ? fs.readFileSync(paths.driftLog, "utf8") : "";
    const entries = (0, drift_log_1.parseDriftEntries)(text);
    const openBlocking = r.state.drift_open_blocking;
    const human = entries.length
        ? entries.map((e) => `${e.id}  (${e.ref})  ${e.layer} layer${e.layer === "requirement" ? " [BLOCKING]" : ""}`).join("\n")
        : "(no drift entries)";
    return (0, output_1.success)({ data: { entries, open_blocking: openBlocking }, human });
}
/**
 * `th drift resolve <id>` — append an append-only resolution note. Only
 * decrements `state.drift_open_blocking` when the resolved entry is a
 * `requirement`-layer entry (derived entries get the note but no counter change).
 *
 * Hardened validations:
 * - The id must match an existing drift entry (no unknown ids).
 * - Double-resolving (a `## <id> — resolved` note already present) is rejected.
 * - Derived-layer entries: counter unchanged, human output says so explicitly.
 */
function runDriftResolve(paths, id) {
    if (!id)
        return (0, output_1.failure)({ human: "usage: th drift resolve <DRIFT-NNN>" });
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `Existing state.json is invalid; fix it before resolving drift:\n${formatIssues(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    // Parse the drift log to validate the id and detect double-resolves.
    const text = fs.existsSync(paths.driftLog) ? fs.readFileSync(paths.driftLog, "utf8") : "";
    const entries = (0, drift_log_1.parseDriftEntries)(text);
    const entry = entries.find((e) => e.id === id);
    if (!entry) {
        return (0, output_1.failure)({
            human: `Drift entry not found: ${id}. Known entries: ${entries.map((e) => e.id).join(", ") || "(none)"}`,
            data: { error: "drift_not_found", id },
        });
    }
    // Check for a pre-existing resolution note (double-resolve guard).
    const alreadyResolved = text
        .split(/\r?\n/)
        .some((line) => line.trim() === `## ${id} — resolved`);
    if (alreadyResolved) {
        return (0, output_1.failure)({
            human: `${id} is already resolved. Double-resolving is not allowed.`,
            data: { error: "already_resolved", id },
        });
    }
    appendDriftLog(paths, `## ${id} — resolved\n`);
    const isBlocking = entry.layer === "requirement";
    let driftOpenBlocking = r.state.drift_open_blocking;
    if (isBlocking) {
        driftOpenBlocking = Math.max(0, driftOpenBlocking - 1);
        (0, state_store_1.writeState)(paths, { ...r.state, drift_open_blocking: driftOpenBlocking });
    }
    (0, log_1.structuredLog)({ cmd: "drift resolve", id, layer: entry.layer, drift_open_blocking: driftOpenBlocking });
    const human = isBlocking
        ? `${id} marked resolved (requirement layer, blocking cleared). Open blocking drift: ${driftOpenBlocking}.`
        : `${id} marked resolved (derived layer — no blocking counter change). Open blocking drift: ${driftOpenBlocking}.`;
    return (0, output_1.success)({
        data: { id, layer: entry.layer, drift_open_blocking: driftOpenBlocking },
        human,
    });
}
