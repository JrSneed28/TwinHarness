"use strict";
/**
 * `state.json` schema, validator, canonical serializer, and the initial state.
 *
 * Shape is taken verbatim from the spec §18. Validation is hand-rolled (zero
 * runtime dependencies — plan Principle 3) and returns a precise issue list so
 * `th state verify` and the stop-gate can explain *what* is wrong.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATE_FIELD_ORDER = exports.WRITE_GATE_VALUES = exports.SLICE_STATUSES = exports.BLAST_RADIUS_FLAGS = exports.TIERS = exports.CURRENT_SCHEMA_VERSION = void 0;
exports.initialState = initialState;
exports.validateState = validateState;
exports.serializeState = serializeState;
/**
 * Current state-schema version (Phase 4 — schema versioning). New projects stamp
 * this in `state.json`; legacy files without the field are treated as v1 and can
 * be upgraded with `th migrate`. Bump this (and add a migration step) whenever a
 * breaking state-shape change ships.
 */
exports.CURRENT_SCHEMA_VERSION = 1;
exports.TIERS = ["T0", "T1", "T2", "T3"];
/** The blast-radius set (spec §5): these can never be Tier 0. */
exports.BLAST_RADIUS_FLAGS = [
    "authentication",
    "authorization",
    "data-integrity",
    "money",
    "migrations",
];
exports.SLICE_STATUSES = ["pending", "in-progress", "done", "blocked"];
/** Valid values for the optional write-gate field (design doc §State schema change). */
exports.WRITE_GATE_VALUES = ["ask", "deny", "off"];
/** Canonical field order → deterministic serialization → stable content hashes. */
exports.STATE_FIELD_ORDER = [
    "schema_version",
    "tier",
    "complexity_rationale",
    "blast_radius_flags",
    "current_stage",
    "approved_artifacts",
    "summaries_index",
    "slices",
    "implementation_allowed",
    "open_questions",
    "drift_open_blocking",
    "revise_loop_counts",
    "write_gate",
];
/** Fresh state written by `th init` — unclassified, implementation not yet allowed. */
function initialState() {
    return {
        schema_version: exports.CURRENT_SCHEMA_VERSION,
        tier: null,
        complexity_rationale: "",
        blast_radius_flags: [],
        current_stage: "init",
        approved_artifacts: [],
        summaries_index: "00-project-summary.md",
        slices: [],
        implementation_allowed: false,
        open_questions: [],
        drift_open_blocking: 0,
        revise_loop_counts: {},
    };
}
function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isInteger(v) {
    return typeof v === "number" && Number.isInteger(v);
}
/** Validate an arbitrary parsed value against the state schema. */
function validateState(value) {
    const issues = [];
    if (!isPlainObject(value)) {
        return { ok: false, issues: [{ path: "$", message: "state must be a JSON object" }] };
    }
    const v = value;
    // Optional schema_version: absent ⇒ legacy v1. When present it must be a
    // positive integer. A version newer than CURRENT is still structurally valid
    // here; `th migrate` is responsible for refusing to downgrade.
    if (v.schema_version !== undefined && (!isInteger(v.schema_version) || v.schema_version < 1)) {
        issues.push({ path: "schema_version", message: "must be a positive integer or absent" });
    }
    if (!(v.tier === null || (typeof v.tier === "string" && exports.TIERS.includes(v.tier)))) {
        issues.push({ path: "tier", message: `must be null or one of ${exports.TIERS.join(", ")}` });
    }
    if (typeof v.complexity_rationale !== "string") {
        issues.push({ path: "complexity_rationale", message: "must be a string" });
    }
    if (!Array.isArray(v.blast_radius_flags)) {
        issues.push({ path: "blast_radius_flags", message: "must be an array" });
    }
    else {
        v.blast_radius_flags.forEach((f, i) => {
            if (typeof f !== "string" || !exports.BLAST_RADIUS_FLAGS.includes(f)) {
                issues.push({ path: `blast_radius_flags[${i}]`, message: `invalid flag "${String(f)}"` });
            }
        });
    }
    if (typeof v.current_stage !== "string" || v.current_stage.length === 0) {
        issues.push({ path: "current_stage", message: "must be a non-empty string" });
    }
    if (!Array.isArray(v.approved_artifacts)) {
        issues.push({ path: "approved_artifacts", message: "must be an array" });
    }
    else {
        v.approved_artifacts.forEach((a, i) => {
            if (!isPlainObject(a)) {
                issues.push({ path: `approved_artifacts[${i}]`, message: "must be an object" });
                return;
            }
            if (typeof a.file !== "string" || a.file.length === 0) {
                issues.push({ path: `approved_artifacts[${i}].file`, message: "must be a non-empty string" });
            }
            if (!isInteger(a.version) || a.version < 1) {
                issues.push({ path: `approved_artifacts[${i}].version`, message: "must be a positive integer" });
            }
            if (typeof a.hash !== "string" || a.hash.length === 0) {
                issues.push({ path: `approved_artifacts[${i}].hash`, message: "must be a non-empty string" });
            }
        });
    }
    if (typeof v.summaries_index !== "string") {
        issues.push({ path: "summaries_index", message: "must be a string" });
    }
    if (!Array.isArray(v.slices)) {
        issues.push({ path: "slices", message: "must be an array" });
    }
    else {
        v.slices.forEach((s, i) => {
            if (!isPlainObject(s)) {
                issues.push({ path: `slices[${i}]`, message: "must be an object" });
                return;
            }
            if (typeof s.id !== "string" || s.id.length === 0) {
                issues.push({ path: `slices[${i}].id`, message: "must be a non-empty string" });
            }
            if (typeof s.status !== "string" || !exports.SLICE_STATUSES.includes(s.status)) {
                issues.push({ path: `slices[${i}].status`, message: `must be one of ${exports.SLICE_STATUSES.join(", ")}` });
            }
            if (!Array.isArray(s.components) || s.components.some((c) => typeof c !== "string")) {
                issues.push({ path: `slices[${i}].components`, message: "must be an array of strings" });
            }
        });
    }
    if (typeof v.implementation_allowed !== "boolean") {
        issues.push({ path: "implementation_allowed", message: "must be a boolean" });
    }
    if (!Array.isArray(v.open_questions) || v.open_questions.some((q) => typeof q !== "string")) {
        issues.push({ path: "open_questions", message: "must be an array of strings" });
    }
    if (!isInteger(v.drift_open_blocking) || v.drift_open_blocking < 0) {
        issues.push({ path: "drift_open_blocking", message: "must be a non-negative integer" });
    }
    if (!isPlainObject(v.revise_loop_counts)) {
        issues.push({ path: "revise_loop_counts", message: "must be an object" });
    }
    else {
        for (const [k, val] of Object.entries(v.revise_loop_counts)) {
            if (!isInteger(val) || val < 0) {
                issues.push({ path: `revise_loop_counts.${k}`, message: "must be a non-negative integer" });
            }
        }
    }
    // Optional write_gate field (design doc §State schema change).
    if (v.write_gate !== undefined) {
        if (typeof v.write_gate !== "string" || !exports.WRITE_GATE_VALUES.includes(v.write_gate)) {
            issues.push({ path: "write_gate", message: `must be one of ${exports.WRITE_GATE_VALUES.join(", ")} or absent` });
        }
    }
    // Cross-field invariant — the veto FLOOR (spec §5): Tier 0 is forbidden when
    // any blast-radius flag is present. This makes `th state set tier T0`
    // mechanically refuse with flags set, and makes the stop-gate block such a
    // state (evaluateStopGate rejects invalid state). Guarded on the per-field
    // checks above so it never fires on already-malformed input.
    if (v.tier === "T0" &&
        Array.isArray(v.blast_radius_flags) &&
        v.blast_radius_flags.length > 0) {
        issues.push({ path: "tier", message: "Tier 0 is vetoed when blast-radius flags are present (§5)" });
    }
    if (issues.length > 0)
        return { ok: false, issues };
    return { ok: true, issues: [], state: value };
}
/**
 * Deterministic serialization in canonical field order, trailing newline.
 * Optional fields (e.g. write_gate) are omitted when undefined so that existing
 * state files serialize byte-identically — preserving content-hash stability (§18).
 */
function serializeState(state) {
    const ordered = {};
    for (const key of exports.STATE_FIELD_ORDER) {
        const val = state[key];
        if (val !== undefined) {
            ordered[key] = val;
        }
    }
    return JSON.stringify(ordered, null, 2) + "\n";
}
