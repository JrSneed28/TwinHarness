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
exports.parsePlanSlices = parsePlanSlices;
exports.runSlicesSync = runSlicesSync;
exports.runSliceSetStatus = runSliceSetStatus;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const state_schema_1 = require("../core/state-schema");
const leases_1 = require("../core/leases");
const log_1 = require("../core/log");
/** Extract backtick-quoted tokens or comma-separated bare words from a component line/cell. */
function parseComponentTokens(raw) {
    // First try backtick-quoted tokens: `foo`, `bar`.
    const quoted = [];
    for (const m of raw.matchAll(/`([^`]+)`/g)) {
        const tok = m[1].trim();
        if (tok)
            quoted.push(tok);
    }
    if (quoted.length > 0)
        return quoted;
    // Fall back to comma-separated plain tokens (strip any leading dash/bullet).
    const stripped = raw.replace(/^[\s\-*]+/, "");
    return stripped
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
}
/**
 * Parse the implementation plan markdown for SLICE-N headings and their
 * "components touched" lines. Tolerant: accepts `## Slice 0 — ...`,
 * `### SLICE-2 — ...`, mixed case in the heading word.
 *
 * For each slice heading found, scans forward until the next slice heading for
 * a line matching /components?\s+touched/i. The component names are extracted
 * from that line or the immediately following list/table line.
 */
function parsePlanSlices(planContent) {
    // Match headings: `## Slice 0`, `## SLICE-1 — name`, `### SLICE-2 — name`
    // Normalize "Slice N" → "SLICE-N" so the id is canonical.
    const SLICE_HEADING_RE = /^#{1,6}\s+(?:SLICE-(\d+)|Slice\s+(\d+))(?:\s|—|$)/i;
    const COMPONENTS_RE = /components?\s+touched/i;
    const DEPENDS_RE = /depends?\s+on/i;
    const lines = planContent.split(/\r?\n/);
    const slices = [];
    // First pass: collect the line index of each slice heading + its id.
    const headings = [];
    for (let i = 0; i < lines.length; i++) {
        const m = SLICE_HEADING_RE.exec(lines[i]);
        if (m) {
            const n = m[1] ?? m[2];
            headings.push({ lineIdx: i, id: `SLICE-${n}` });
        }
    }
    // Second pass: for each slice heading, scan its section for "components touched".
    for (let hi = 0; hi < headings.length; hi++) {
        const { lineIdx, id } = headings[hi];
        const sectionEnd = headings[hi + 1]?.lineIdx ?? lines.length;
        let components = [];
        let dependsOn = [];
        for (let li = lineIdx + 1; li < sectionEnd; li++) {
            const line = lines[li];
            if (components.length === 0 && COMPONENTS_RE.test(line)) {
                // The line itself may contain the component names after a colon.
                const afterColon = line.replace(COMPONENTS_RE, "").replace(/^[^:]*:\s*/, "").trim();
                if (afterColon) {
                    components = parseComponentTokens(afterColon);
                }
                else if (li + 1 < sectionEnd) {
                    // Try the immediately following line (list item or table cell).
                    components = parseComponentTokens(lines[li + 1]);
                }
            }
            else if (dependsOn.length === 0 && DEPENDS_RE.test(line)) {
                // Capture canonical SLICE-N tokens from a "Depends on: SLICE-1, SLICE-2" line.
                for (const m of line.matchAll(/SLICE-\d+/gi))
                    dependsOn.push(m[0].toUpperCase());
            }
        }
        slices.push({ id, components, dependsOn });
    }
    return slices;
}
function formatIssues(issues) {
    return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}
const NOT_INIT = (0, output_1.failure)({
    human: "No state.json found. Run `th init` first.",
    data: { error: "not_initialized" },
});
/**
 * `th slices sync [--plan <file>] [--dry-run] [--remove-missing]`
 *
 * Upsert plan slices into state.slices. Existing slice ids keep their status;
 * new ids get "pending"; obsolete ids are reported (and removed only with
 * `--remove-missing`). `--dry-run` computes but does not write.
 */
function runSlicesSync(paths, opts = {}) {
    return (0, state_store_1.withStateLock)(paths, () => runSlicesSyncLocked(paths, opts));
}
function runSlicesSyncLocked(paths, opts = {}) {
    const planAbs = path.resolve(paths.root, opts.planFile ?? "docs/09-implementation-plan.md");
    if (!fs.existsSync(planAbs) || !fs.statSync(planAbs).isFile()) {
        const rel = path.relative(paths.root, planAbs).split(path.sep).join("/");
        return (0, output_1.failure)({
            human: `Plan file not found: ${rel}. Provide the path with --plan or author the implementation plan first.`,
            data: { error: "plan_file_not_found", planFile: rel },
        });
    }
    const planContent = fs.readFileSync(planAbs, "utf8");
    const planSlices = parsePlanSlices(planContent);
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid:\n${formatIssues(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    // Build a lookup of existing state slices by id.
    const stateById = new Map();
    for (const s of r.state.slices)
        stateById.set(s.id, s);
    const planIds = new Set(planSlices.map((s) => s.id));
    // Slices in state but no longer in the plan.
    const missing = r.state.slices.filter((s) => !planIds.has(s.id)).map((s) => s.id);
    // Build the upserted slice list.
    const upserted = planSlices.map((ps) => {
        const existing = stateById.get(ps.id);
        const slice = {
            id: ps.id,
            status: existing?.status ?? "pending",
            components: ps.components,
        };
        // Only attach depends_on when the plan declares one, so slices without
        // dependencies serialize byte-identically to pre-feature state (§18).
        if (ps.dependsOn.length > 0)
            slice.depends_on = ps.dependsOn;
        return slice;
    });
    // If not removing missing, append them unchanged.
    let finalSlices;
    if (opts.removeMissing) {
        finalSlices = upserted;
    }
    else {
        const missingEntries = r.state.slices.filter((s) => !planIds.has(s.id));
        finalSlices = [...upserted, ...missingEntries];
    }
    const nextState = { ...r.state, slices: finalSlices };
    const validation = (0, state_schema_1.validateState)(nextState);
    if (!validation.ok) {
        return (0, output_1.failure)({
            human: `Refusing to write: result would be invalid:\n${formatIssues(validation.issues)}`,
            data: { error: "would_be_invalid", issues: validation.issues },
        });
    }
    const added = planSlices.filter((ps) => !stateById.has(ps.id)).map((ps) => ps.id);
    const updated = planSlices.filter((ps) => stateById.has(ps.id)).map((ps) => ps.id);
    const data = {
        added,
        updated,
        missing,
        removed: opts.removeMissing ? missing : [],
        total: finalSlices.length,
        dryRun: opts.dryRun ?? false,
    };
    if (!opts.dryRun) {
        (0, state_store_1.writeState)(paths, validation.state);
    }
    (0, log_1.structuredLog)({ cmd: "slices sync", ...data });
    const missingNote = missing.length
        ? `\n  ${missing.length} slice(s) in state but absent from plan (${missing.join(", ")})` +
            (opts.removeMissing ? " — removed." : " — kept (pass --remove-missing to delete).")
        : "";
    const dryNote = opts.dryRun ? " (dry run — no write)" : "";
    const human = `slices sync: ${added.length} added, ${updated.length} kept, total ${finalSlices.length}${dryNote}.${missingNote}`;
    return (0, output_1.success)({ data, human });
}
/**
 * `th slice set-status <SLICE-ID> <status>` — convenience command to update a
 * single slice's status without editing the whole slices array by hand.
 * Validates the slice exists and status is one of pending|in-progress|done|blocked.
 */
function runSliceSetStatus(paths, sliceId, status) {
    return (0, state_store_1.withStateLock)(paths, () => runSliceSetStatusLocked(paths, sliceId, status));
}
function runSliceSetStatusLocked(paths, sliceId, status) {
    if (!sliceId) {
        return (0, output_1.failure)({ human: "usage: th slice set-status <SLICE-ID> <status>" });
    }
    if (!status || !state_schema_1.SLICE_STATUSES.includes(status)) {
        return (0, output_1.failure)({
            human: `Invalid status "${status ?? ""}". Must be one of: ${state_schema_1.SLICE_STATUSES.join(", ")}`,
            data: { error: "invalid_status", validStatuses: [...state_schema_1.SLICE_STATUSES] },
        });
    }
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid; fix it before updating slice status:\n${formatIssues(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const idx = r.state.slices.findIndex((s) => s.id === sliceId);
    if (idx < 0) {
        return (0, output_1.failure)({
            human: `Slice not found: ${sliceId}. Known slices: ${r.state.slices.map((s) => s.id).join(", ") || "(none)"}`,
            data: { error: "slice_not_found", sliceId },
        });
    }
    const slices = r.state.slices.map((s, i) => i === idx ? { ...s, status: status } : s);
    const nextState = { ...r.state, slices };
    const validation = (0, state_schema_1.validateState)(nextState);
    if (!validation.ok) {
        return (0, output_1.failure)({
            human: `Refusing to write: result would be invalid:\n${formatIssues(validation.issues)}`,
            data: { error: "would_be_invalid", issues: validation.issues },
        });
    }
    (0, state_store_1.writeState)(paths, validation.state);
    // Auto-release the slice's component lease the moment it reaches a terminal
    // state, so a forgotten `th build release` can't leave a stale lease wedging
    // the next wave. Only emit a release when the slice actually holds a live lease.
    let releasedLease;
    if (status === "done" || status === "blocked") {
        const held = (0, leases_1.activeLeases)(paths).find((l) => l.slice === sliceId);
        if (held) {
            (0, leases_1.appendLeaseEvent)(paths, { event: "release", slice: sliceId, components: held.components });
            releasedLease = held.components;
        }
    }
    (0, log_1.structuredLog)({ cmd: "slice set-status", sliceId, status, releasedLease: releasedLease ?? null });
    return (0, output_1.success)({
        data: { sliceId, status, ...(releasedLease ? { releasedLease } : {}) },
        human: `${sliceId} status set to "${status}".${releasedLease ? ` Released lease on: ${releasedLease.join(", ") || "(none)"}.` : ""}`,
    });
}
