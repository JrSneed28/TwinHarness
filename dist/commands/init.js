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
exports.runInit = runInit;
const fs = __importStar(require("node:fs"));
const output_1 = require("../core/output");
const state_schema_1 = require("../core/state-schema");
const state_store_1 = require("../core/state-store");
const log_1 = require("../core/log");
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
/**
 * `th init` — scaffold `docs/`, `.agentic-sdlc/state.json`, and `drift-log.md`.
 * Idempotent: existing state.json is preserved unless `--force` is given.
 *
 * `--brownfield` (G5) records `project_mode: "brownfield"` on the fresh state so
 * downstream stages adopt the existing-codebase variants (characterization Slice 0,
 * reuse-first drift, overlay architecture). Default (greenfield) leaves the field
 * undefined so the serialized state hashes byte-identically to a pre-G5 init.
 */
function runInit(paths, opts) {
    const created = [];
    const skipped = [];
    if (!fs.existsSync(paths.docsDir)) {
        fs.mkdirSync(paths.docsDir, { recursive: true });
        created.push("docs/");
    }
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const existing = (0, state_store_1.readState)(paths);
    if (existing.exists && !opts.force) {
        skipped.push(".twinharness/state.json (already exists; use --force to reset)");
    }
    else {
        // Greenfield is the default: leave `project_mode` undefined so serialization
        // is byte-identical to a pre-brownfield init. Only stamp the field when
        // brownfield is explicitly requested.
        const state = (0, state_schema_1.initialState)();
        if (opts.brownfield)
            state.project_mode = "brownfield";
        (0, state_store_1.writeState)(paths, state);
        created.push(".twinharness/state.json");
    }
    if (!fs.existsSync(paths.driftLog)) {
        fs.writeFileSync(paths.driftLog, DRIFT_LOG_HEADER, "utf8");
        created.push("drift-log.md");
    }
    else {
        skipped.push("drift-log.md (already exists)");
    }
    (0, log_1.structuredLog)({ cmd: "init", created, skipped, ...(opts.brownfield ? { project_mode: "brownfield" } : {}) });
    const data = { created, skipped };
    if (opts.brownfield)
        data.project_mode = "brownfield";
    const human = [
        "TwinHarness initialized.",
        ...(opts.brownfield ? ["  project_mode: brownfield (adopting an existing codebase)"] : []),
        ...created.map((c) => `  created: ${c}`),
        ...skipped.map((s) => `  skipped: ${s}`),
    ].join("\n");
    return (0, output_1.success)({ data, human });
}
