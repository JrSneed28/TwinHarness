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
exports.runInitMcp = runInitMcp;
const fs = __importStar(require("node:fs"));
const output_1 = require("../core/output");
const state_schema_1 = require("../core/state-schema");
const state_store_1 = require("../core/state-store");
const log_1 = require("../core/log");
const guards_1 = require("../core/guards");
const budget_1 = require("./budget");
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
 * Stamp the gate-defining config fields (R-04 capture path) onto a fresh state, in
 * place. Each is applied ONLY when the operator passed it; an unset field is left
 * absent so the serialized state stays byte-identical to a plain init and the safe
 * default applies. `delivery_mode` gets a focused enum pre-check (clearer than the
 * generic `would_be_invalid` from `validateState`); the boolean/number fields are
 * stamped verbatim and left for `validateState` to range-check. Returns a failure
 * CommandResult on a bad value, else null.
 */
function applyGateDefiningFields(state, opts) {
    if (opts.deliveryMode !== undefined) {
        if (!state_schema_1.DELIVERY_MODES.includes(opts.deliveryMode)) {
            return (0, output_1.failure)({
                human: `Invalid --delivery-mode "${opts.deliveryMode}". Valid: ${state_schema_1.DELIVERY_MODES.join(", ")}.`,
                data: { error: "invalid_delivery_mode", value: opts.deliveryMode, validModes: state_schema_1.DELIVERY_MODES },
            });
        }
        state.delivery_mode = opts.deliveryMode;
    }
    if (opts.hasUi !== undefined)
        state.has_ui = opts.hasUi;
    if (opts.interviewRequired !== undefined)
        state.interview_required = opts.interviewRequired;
    if (opts.interviewCutoff !== undefined)
        state.interview_cutoff = opts.interviewCutoff;
    return null;
}
/**
 * `th init` — scaffold `docs/`, `.agentic-sdlc/state.json`, and `drift-log.md`.
 * Idempotent: existing state.json is preserved unless `--force` is given.
 *
 * `--brownfield` (G5) records `project_mode: "brownfield"` on the fresh state so
 * downstream stages adopt the existing-codebase variants (characterization Slice 0,
 * reuse-first drift, overlay architecture). Default (greenfield) leaves the field
 * undefined so the serialized state hashes byte-identically to a pre-G5 init.
 *
 * `--max-tokens <k>` (Track A-2) records the per-session context budget. The flag
 * is given in THOUSANDS; the ×1000 conversion happens HERE (the write site, via
 * `kToTokens`), never in the parser — so `--max-tokens 150` persists as
 * `max_tokens: 150000`. It is applied on a fresh init AND as a targeted update on
 * an already-initialized run (so a resume can re-set the budget without --force).
 *
 * The four gate-DEFINING config fields (R-04 / DR-02) — `deliveryMode`, `hasUi`,
 * `interviewRequired`, `interviewCutoff` — are the typed CAPTURE PATH for fields that
 * are otherwise gate-owned (refused over MCP, `--emergency`-only via raw `state
 * set`). They are CREATION-time only: applied on a fresh init, ignored on a
 * preserve-existing re-init (a project's nature is fixed once; change it later only
 * via the loud `--emergency` raw write). Each is stamped only when the operator
 * passes it (absent ⇒ field omitted ⇒ the safe default applies), and the assembled
 * state is run through `validateState` before writing so a bad enum / out-of-range
 * cutoff is refused cleanly rather than persisting an invalid file.
 */
function runInit(paths, opts) {
    const created = [];
    const skipped = [];
    const maxTokens = opts.maxTokens !== undefined && Number.isFinite(opts.maxTokens) && opts.maxTokens > 0
        ? (0, budget_1.kToTokens)(opts.maxTokens)
        : undefined;
    if (!fs.existsSync(paths.docsDir)) {
        fs.mkdirSync(paths.docsDir, { recursive: true });
        created.push("docs/");
    }
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const existing = (0, state_store_1.readState)(paths);
    if (existing.exists && !opts.force) {
        // Non-destructive: preserve state.json, but a --max-tokens override is a free
        // (non-gate) policy value, so apply it as a targeted single-field update.
        if (maxTokens !== undefined && existing.state) {
            (0, state_store_1.writeState)(paths, { ...existing.state, max_tokens: maxTokens });
            skipped.push(".twinharness/state.json (already exists; updated max_tokens only)");
        }
        else {
            skipped.push(".twinharness/state.json (already exists; use --force to reset)");
        }
    }
    else {
        // Greenfield is the default: leave `project_mode` undefined so serialization
        // is byte-identical to a pre-brownfield init. Only stamp the field when
        // brownfield is explicitly requested.
        const state = (0, state_schema_1.initialState)();
        if (opts.brownfield)
            state.project_mode = "brownfield";
        if (maxTokens !== undefined)
            state.max_tokens = maxTokens;
        // R-04 typed capture path: stamp the gate-defining config fields ONLY when the
        // operator passed them (absent ⇒ omitted ⇒ safe default). Each is the typed,
        // non-`--emergency` write site for an otherwise gate-owned field.
        const captureFailure = applyGateDefiningFields(state, opts);
        if (captureFailure)
            return captureFailure;
        // Validate the assembled state before writing (writeState does NOT validate):
        // a bad --delivery-mode enum or an out-of-range --interview-cutoff is refused
        // here rather than persisting an invalid state.json.
        const validation = (0, state_schema_1.validateState)(state);
        if (!validation.ok) {
            return (0, output_1.failure)({
                human: `Refusing to init: the requested gate-defining flags would make state invalid:\n${(0, guards_1.formatIssues)(validation.issues)}`,
                data: { error: "would_be_invalid", issues: validation.issues },
            });
        }
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
    (0, log_1.structuredLog)({
        cmd: "init",
        created,
        skipped,
        ...(opts.brownfield ? { project_mode: "brownfield" } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    });
    const data = { created, skipped };
    if (opts.brownfield)
        data.project_mode = "brownfield";
    if (maxTokens !== undefined)
        data.max_tokens = maxTokens;
    const human = [
        "TwinHarness initialized.",
        ...(opts.brownfield ? ["  project_mode: brownfield (adopting an existing codebase)"] : []),
        ...(maxTokens !== undefined ? [`  max_tokens: ${maxTokens}`] : []),
        ...created.map((c) => `  created: ${c}`),
        ...skipped.map((s) => `  skipped: ${s}`),
    ].join("\n");
    return (0, output_1.success)({ data, human });
}
/**
 * MCP-facing init (`th_init`). Idempotent and NON-destructive by contract: when a
 * project is ALREADY initialized it returns a structured `{ already_initialized:
 * true, … }` summary WITHOUT clobbering state.json. There is NO `force` over MCP —
 * destructive re-init stays CLI/human-only (plan R17). A fresh project delegates to
 * the existing {@link runInit} (with `force:false`) so scaffolding is never
 * duplicated here.
 */
function runInitMcp(paths, opts = {}) {
    const existing = (0, state_store_1.readState)(paths);
    if (existing.exists) {
        const data = { already_initialized: true };
        if (existing.state) {
            data.tier = existing.state.tier;
            data.current_stage = existing.state.current_stage;
            data.implementation_allowed = existing.state.implementation_allowed;
        }
        (0, log_1.structuredLog)({ cmd: "init", already_initialized: true });
        return (0, output_1.success)({
            data,
            human: "TwinHarness already initialized; not re-initializing (use the CLI `th init --force` to reset).",
        });
    }
    return runInit(paths, { force: false, brownfield: opts.brownfield });
}
