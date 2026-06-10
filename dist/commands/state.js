"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStateGet = runStateGet;
exports.runStateSet = runStateSet;
exports.runStateStatus = runStateStatus;
exports.runStateVerify = runStateVerify;
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const state_schema_1 = require("../core/state-schema");
const log_1 = require("../core/log");
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function formatIssues(issues) {
    return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}
function parseValue(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw; // bare string
    }
}
function getByPath(obj, dotted) {
    const parts = dotted.split(".");
    let cur = obj;
    for (const p of parts) {
        if (Array.isArray(cur)) {
            // Support numeric array indices, e.g. `approved_artifacts.0.hash`.
            const idx = Number(p);
            if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length)
                return undefined;
            cur = cur[idx];
        }
        else if (isRecord(cur)) {
            cur = cur[p];
        }
        else {
            return undefined;
        }
        if (cur === undefined)
            return undefined;
    }
    return cur;
}
function setByPath(obj, dotted, value) {
    const parts = dotted.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!isRecord(cur[p]))
            cur[p] = {};
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
}
const NOT_INIT = (0, output_1.failure)({
    human: "No state.json found. Run `th init` first.",
    data: { error: "not_initialized" },
});
/** `th state get [dotted.path]` */
function runStateGet(paths, dottedPath) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state)
        return (0, output_1.failure)({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
    if (!dottedPath) {
        return (0, output_1.success)({ data: { state: r.state }, human: JSON.stringify(r.state, null, 2) });
    }
    const value = getByPath(r.state, dottedPath);
    if (value === undefined) {
        return (0, output_1.failure)({ human: `Path not found: ${dottedPath}`, data: { error: "path_not_found", path: dottedPath } });
    }
    return (0, output_1.success)({
        data: { path: dottedPath, value },
        human: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    });
}
/** `th state set <dotted.key> <value>` — refuses to persist an invalid result. */
function runStateSet(paths, key, rawValue) {
    // Reject paths whose first segment is not a known state field (catches typos
    // like `implementaton_allowed` that would silently write nothing).
    const firstSegment = key.split(".")[0];
    if (!state_schema_1.STATE_FIELD_ORDER.includes(firstSegment)) {
        return (0, output_1.failure)({
            human: `Unknown state field: "${firstSegment}". Valid top-level keys: ${state_schema_1.STATE_FIELD_ORDER.join(", ")}`,
            data: { error: "unknown_field", field: firstSegment, validFields: state_schema_1.STATE_FIELD_ORDER },
        });
    }
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state)
        return (0, output_1.failure)({ human: `Existing state.json is invalid; fix it before setting values:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
    const value = parseValue(rawValue);
    const next = JSON.parse(JSON.stringify(r.state));
    setByPath(next, key, value);
    const validation = (0, state_schema_1.validateState)(next);
    if (!validation.ok) {
        return (0, output_1.failure)({
            human: `Refusing to write: result would be invalid:\n${formatIssues(validation.issues)}`,
            data: { error: "would_be_invalid", issues: validation.issues },
        });
    }
    (0, state_store_1.writeState)(paths, validation.state);
    (0, log_1.structuredLog)({ cmd: "state set", key });
    return (0, output_1.success)({ data: { key, value }, human: `Set ${key} = ${JSON.stringify(value)}` });
}
/** `th state status` — human-readable snapshot of tier/stage/gates. */
function runStateStatus(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state)
        return (0, output_1.failure)({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
    const s = r.state;
    const human = [
        `Tier:                ${s.tier ?? "(unclassified)"}`,
        `Current stage:       ${s.current_stage}`,
        `Implementation:      ${s.implementation_allowed ? "allowed" : "not allowed"}`,
        `Blast-radius flags:  ${s.blast_radius_flags.length ? s.blast_radius_flags.join(", ") : "(none)"}`,
        `Open blocking drift: ${s.drift_open_blocking}`,
        `Approved artifacts:  ${s.approved_artifacts.length}`,
        `Slices:              ${s.slices.length ? s.slices.map((sl) => `${sl.id}=${sl.status}`).join(", ") : "(none)"}`,
        `Revise-loop counts:  ${Object.keys(s.revise_loop_counts).length ? Object.entries(s.revise_loop_counts).map(([k, v]) => `${k}:${v}`).join(", ") : "(none)"}`,
        `Open questions:      ${s.open_questions.length}`,
    ].join("\n");
    return (0, output_1.success)({ data: { status: s }, human });
}
/** `th state verify` — exit 0 if valid, non-zero if not. Wired into the stop-gate. */
function runStateVerify(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return (0, output_1.failure)({ human: "No state.json found.", data: { valid: false, error: "not_initialized" } });
    if (!r.state)
        return (0, output_1.failure)({ human: `state.json INVALID:\n${formatIssues(r.issues)}`, data: { valid: false, issues: r.issues } });
    return (0, output_1.success)({ data: { valid: true }, human: "state.json is valid." });
}
