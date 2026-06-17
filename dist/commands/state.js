"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStateGet = runStateGet;
exports.runStateSet = runStateSet;
exports.applyGateMutation = applyGateMutation;
exports.runStateStatus = runStateStatus;
exports.runStateVerify = runStateVerify;
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const state_schema_1 = require("../core/state-schema");
const log_1 = require("../core/log");
const ledger_1 = require("../core/ledger");
const guards_1 = require("../core/guards");
const state_fields_1 = require("../core/state-fields");
const stages_1 = require("../core/stages");
/** Key segments that must never be written through a dotted path (proto-pollution guard, S3). */
const UNSAFE_KEY_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
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
/** `th state get [dotted.path]` */
function runStateGet(paths, dottedPath) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state)
        return (0, output_1.failure)({ human: `state.json is invalid:\n${(0, guards_1.formatIssues)(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
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
    return (0, state_store_1.withStateLock)(paths, () => runStateSetLocked(paths, key, rawValue));
}
function runStateSetLocked(paths, key, rawValue) {
    // Reject paths whose first segment is not a known state field (catches typos
    // like `implementaton_allowed` that would silently write nothing).
    const segments = key.split(".");
    const firstSegment = segments[0];
    if (!state_schema_1.STATE_FIELD_ORDER.includes(firstSegment)) {
        return (0, output_1.failure)({
            human: `Unknown state field: "${firstSegment}". Valid top-level keys: ${state_schema_1.STATE_FIELD_ORDER.join(", ")}`,
            data: { error: "unknown_field", field: firstSegment, validFields: state_schema_1.STATE_FIELD_ORDER },
        });
    }
    // Proto-pollution guard (S3): refuse any dotted segment that could walk into
    // an object's prototype, even under an otherwise-valid first key (e.g.
    // `revise_loop_counts.__proto__.x`). setByPath runs before validation, so this
    // must be rejected up front.
    if (segments.some((s) => UNSAFE_KEY_SEGMENTS.has(s))) {
        return (0, output_1.failure)({
            human: `Refusing to write: unsafe key segment in "${key}".`,
            data: { error: "unsafe_key", key },
        });
    }
    // Managed-field guard (H-2): refuse writes to fields whose owning command keeps
    // an invariant a raw set would corrupt (the drift/debate counters). Gate-owned
    // fields (implementation_allowed/tier/current_stage/write_gate) are NOT refused
    // here — setting them on the CLI is the documented unlock/advance path — but the
    // MCP raw setter refuses them (F-7) and current_stage is enum-normalized below.
    const policy = (0, state_fields_1.fieldPolicy)(firstSegment);
    if (policy?.refusedByStateSet) {
        return (0, output_1.failure)({
            human: `Refusing to set managed field "${firstSegment}". ${policy.owner}`,
            data: { error: "managed_field", field: firstSegment },
        });
    }
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state)
        return (0, output_1.failure)({ human: `Existing state.json is invalid; fix it before setting values:\n${(0, guards_1.formatIssues)(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
    let value = parseValue(rawValue);
    // current_stage enum-normalization (C-1 write-path defense): canonicalize the
    // value and reject anything that is not a known pipeline stage, so near-miss /
    // bogus stage strings (done, complete, Final-Verification, 10-final-verification)
    // can never be stored via the CLI — closing the gate-bypass vector at the source
    // while the schema itself stays permissive (existing tests write non-pipeline
    // stages like `stage-05` directly via writeState; plan §F-5: do NOT tighten the
    // schema). Scoped to the exact `current_stage` key only.
    if (key === "current_stage") {
        const canonical = (0, stages_1.canonicalizeStage)(String(value));
        // `canonical` is already canonical, so membership-test directly rather than
        // calling isKnownStage (which would canonicalize a second time).
        if (!stages_1.STAGE_PIPELINE.some((s) => s.stage === canonical)) {
            return (0, output_1.failure)({
                human: `Refusing to set current_stage to "${String(value)}": not a known pipeline stage. ` +
                    `Valid stages: ${stages_1.STAGE_PIPELINE.map((s) => s.stage).join(", ")}.`,
                data: { error: "unknown_stage", value: String(value), validStages: stages_1.STAGE_PIPELINE.map((s) => s.stage) },
            });
        }
        value = canonical; // persist the canonical id (e.g. "10-final-verification" → "final-verification")
    }
    const next = JSON.parse(JSON.stringify(r.state));
    setByPath(next, key, value);
    const validation = (0, state_schema_1.validateState)(next);
    if (!validation.ok) {
        return (0, output_1.failure)({
            human: `Refusing to write: result would be invalid:\n${(0, guards_1.formatIssues)(validation.issues)}`,
            data: { error: "would_be_invalid", issues: validation.issues },
        });
    }
    (0, state_store_1.writeState)(paths, validation.state);
    (0, log_1.structuredLog)({ cmd: "state set", key });
    // Audit ledger (F5): record gate-relevant mutations so a human can review when
    // implementation_allowed, the tier, the blast-radius flags, the write_gate, or
    // the blocking-drift count changed. Observability only — never blocks.
    if (ledger_1.GATE_LEDGER_KEYS.has(firstSegment)) {
        (0, ledger_1.appendLedger)(paths, { event: "gate-state-change", key, value });
        // Seal an in-chain high-water anchor after the gate flip (#8): a sealed
        // {event:"high-water", count} entry whose count is the sealed-entry count before
        // it. Strengthens edit/reorder/mid-delete evidence for the gate-flip run and
        // keeps the count out of an unsealed sidecar (ADR-001 precedent). It does NOT
        // detect tail truncation (documented residual — see appendHighWater). Best-effort.
        (0, ledger_1.appendHighWater)(paths);
    }
    return (0, output_1.success)({ data: { key, value }, human: `Set ${key} = ${JSON.stringify(value)}` });
}
/**
 * Shared locked + ledgered gate-mutation writer (plan Phase 2 Step 6, AC-B16).
 *
 * The single write path for the typed MCP gate-transition tools (`th_tier_record`,
 * `th_stage_advance`, `th_implementation_unlock`, `th_write_gate_set`,
 * `th_blast_radius_record`). It mirrors `runStateSetLocked`'s persist tail
 * (`withStateLock` → clone → mutate → `validateState` → `writeState` +
 * `appendLedger` + `appendHighWater`) but is GENERIC over the set of gate fields
 * to change, so one call can flip several gate-owned fields atomically under a
 * single lock.
 *
 * SECURITY (AC-B16):
 *  - `source` is supplied by the CALLING TOOL as a hard-coded literal (the tool
 *    name) and is **never** read from tool `args` — an agent cannot spoof
 *    `source="th state set"`. Per `src/core/ledger.ts:5-10` this is observability,
 *    not provenance: it records which entry point fired, not who authorized it.
 *  - One FLAT scalar ledger entry per changed field (`{ event, key, value, source }`),
 *    shaped exactly like the existing `gate-state-change` entries above.
 *    `ledgerCanonicalText` does NOT key-normalize nested objects
 *    (`src/core/ledger.ts:103-105`), so a nested patch blob would break the hash
 *    chain; `blast_radius_flags` is a flat `string[]` and is an acceptable single
 *    value.
 *
 * Preconditions are enforced by the CALLER (the gate-precondition helpers) BEFORE
 * this runs; `applyGateMutation` itself enforces no gate ladder, but it still calls
 * `validateState` and refuses `would_be_invalid`, so an out-of-schema write can
 * never persist through this path.
 */
function applyGateMutation(paths, fields, source) {
    return (0, state_store_1.withStateLock)(paths, () => {
        const r = (0, state_store_1.readState)(paths);
        if (!r.exists)
            return guards_1.NOT_INIT;
        if (!r.state) {
            return (0, output_1.failure)({
                human: `Existing state.json is invalid; fix it before mutating gates:\n${(0, guards_1.formatIssues)(r.issues)}`,
                data: { error: "invalid_state", issues: r.issues },
            });
        }
        const next = JSON.parse(JSON.stringify(r.state));
        for (const [key, value] of Object.entries(fields)) {
            next[key] = value;
        }
        const validation = (0, state_schema_1.validateState)(next);
        if (!validation.ok) {
            return (0, output_1.failure)({
                human: `Refusing to write: result would be invalid:\n${(0, guards_1.formatIssues)(validation.issues)}`,
                data: { error: "would_be_invalid", issues: validation.issues },
            });
        }
        (0, state_store_1.writeState)(paths, validation.state);
        (0, log_1.structuredLog)({ cmd: "gate mutation", source, keys: Object.keys(fields) });
        // Audit ledger (F5 / AC-B16): ONE flat scalar entry per changed gate field,
        // tagged with the hard-coded `source` so a human can see which entry point
        // fired. Flat key/value keeps `ledgerCanonicalText` deterministic (no nested
        // blob). Every field passed here is a deliberate gate mutation, so each is
        // audited (no GATE_LEDGER_KEYS filter — the filter on the CLI path screens
        // arbitrary sets; here the caller passes only gate fields). Best-effort:
        // `appendLedger` never throws.
        for (const [key, value] of Object.entries(fields)) {
            (0, ledger_1.appendLedger)(paths, { event: "gate-state-change", key, value, source });
        }
        // One in-chain high-water anchor after the batch of gate flips (mirrors
        // `runStateSetLocked`'s post-flip seal).
        (0, ledger_1.appendHighWater)(paths);
        return (0, output_1.success)({
            data: { source, fields },
            human: `Applied gate mutation (${source}): ${Object.keys(fields).join(", ")}`,
        });
    });
}
/** `th state status` — human-readable snapshot of tier/stage/gates. */
function runStateStatus(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state)
        return (0, output_1.failure)({ human: `state.json is invalid:\n${(0, guards_1.formatIssues)(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
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
        return (0, output_1.failure)({ human: `state.json INVALID:\n${(0, guards_1.formatIssues)(r.issues)}`, data: { valid: false, issues: r.issues } });
    // A valid file may still carry non-fatal warnings (ARCH-007) — e.g. an unknown
    // top-level key. Surface them WITHOUT failing: the file is still valid (exit 0),
    // the operator just sees the advisory so a typo/forward-compat field is visible.
    const warnings = r.warnings ?? [];
    if (warnings.length > 0) {
        return (0, output_1.success)({
            data: { valid: true, warnings },
            human: `state.json is valid (with ${warnings.length} warning(s)):\n${(0, guards_1.formatIssues)(warnings)}`,
        });
    }
    return (0, output_1.success)({ data: { valid: true }, human: "state.json is valid." });
}
