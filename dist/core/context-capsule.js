"use strict";
/**
 * context-capsule.ts — Control Capsule generation (S1; D-01/D-02/D-17).
 *
 * Pure + deterministic: same inputs → same capsule → same hash. No I/O beyond
 * reading the state values passed in. Reuses `estimateTokens` from
 * context-telemetry.ts and `hashContent` from hash.ts.
 *
 * Budget tiers (D-02): micro ~1.5K tok / standard ~2K; hard-capped < 10K (D-17).
 * The safety subset (mandatory:true) is never dropped under any budget (D-01).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MANDATORY_CAPSULE_FIELDS = exports.HARD_CAP_TOKENS = exports.STANDARD_BUDGET_TOKENS = exports.MICRO_BUDGET_TOKENS = void 0;
exports.capsuleFromState = capsuleFromState;
const hash_1 = require("./hash");
const context_telemetry_1 = require("./context-telemetry");
// ---------------------------------------------------------------------------
// Token budgets (D-02 / D-17)
// ---------------------------------------------------------------------------
/** Micro capsule budget: ~1 500 tokens (T0/T1 auto-run, no blast-radius). */
exports.MICRO_BUDGET_TOKENS = 1_500;
/** Standard capsule budget: ~2 000 tokens. */
exports.STANDARD_BUDGET_TOKENS = 2_000;
/**
 * Absolute hard cap (D-17): capsule MUST stay under this token count.
 * Narrative fields collapse to an overflow pointer when the cap is breached.
 */
exports.HARD_CAP_TOKENS = 9_999;
const BUDGET_TOKENS_BY_PRESET = {
    micro: exports.MICRO_BUDGET_TOKENS,
    standard: exports.STANDARD_BUDGET_TOKENS,
};
/**
 * Fields in the mandatory (safety) subset — never dropped or overflowed under
 * budget pressure (policies, approvals, blast-radius, gate status, completion
 * criteria, open blocking drift, exact IDs/hashes/limits/dates).
 */
exports.MANDATORY_CAPSULE_FIELDS = new Set([
    "tier",
    "stage",
    "requirement_ids",
    "approved_constraints",
    "blast_radius_flags",
    "open_blocking_drift",
    "completion_criteria",
    "capsule_hash",
    "epoch",
    "generated_at",
]);
/**
 * Narrative fields, ordered by drop priority (least critical first).
 * These are replaced with an overflow pointer when the capsule exceeds its budget.
 */
const NARRATIVE_FIELDS_DROP_ORDER = [
    "objective",
    "side_effects_performed",
    "failures_blockers",
    "open_decisions",
    "next_action",
    "slice_or_wave",
];
/** Overflow pointer injected when a narrative field is collapsed due to budget. */
const OVERFLOW_POINTER = "[overflow — `th context rehydrate` to restore full capsule]";
/**
 * Mandatory string-array fields (the safety subset). These are never collapsed
 * to an overflow pointer (D-01), but when the narrative collapse alone cannot
 * bring the capsule under {@link HARD_CAP_TOKENS} they are *truncated* — a
 * bounded prefix of the exact IDs is kept and a marker is appended. The field
 * stays present and the retained IDs stay exact; only the overflow is elided.
 */
const MANDATORY_ARRAY_FIELDS = [
    "open_blocking_drift",
    "blast_radius_flags",
    "approved_constraints",
    "requirement_ids",
];
/** Appended to a mandatory array when budget pressure forces truncation. */
const TRUNCATION_MARKER = "[truncated — `th context rehydrate` for full list]";
/** Keep at most `max` elements of an array, appending the marker when elided. */
function truncateArrayField(value, max) {
    if (!Array.isArray(value))
        return value;
    if (value.length <= max)
        return value;
    return [...value.slice(0, max), TRUNCATION_MARKER];
}
// ---------------------------------------------------------------------------
// Canonical serialization (for capsule_hash)
// ---------------------------------------------------------------------------
/**
 * Recursive canonical JSON: object keys sorted alphabetically, no whitespace.
 * Deterministic regardless of insertion order — used to derive `capsule_hash`.
 */
function canonicalJson(v) {
    if (v === null || typeof v !== "object")
        return JSON.stringify(v);
    if (Array.isArray(v))
        return `[${v.map(canonicalJson).join(",")}]`;
    const rec = v;
    const pairs = Object.keys(rec)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`);
    return `{${pairs.join(",")}}`;
}
// ---------------------------------------------------------------------------
// State → capsule body helpers (pure, no I/O)
// ---------------------------------------------------------------------------
function deriveSliceOrWave(state) {
    const active = state.slices.filter((s) => s.status === "in-progress").map((s) => s.id);
    if (active.length > 0)
        return active.join(", ");
    const pending = state.slices.filter((s) => s.status === "pending").map((s) => s.id);
    if (pending.length > 0) {
        const shown = pending.slice(0, 5).join(", ");
        const extra = pending.length > 5 ? ` (+${pending.length - 5} more)` : "";
        return `pending: ${shown}${extra}`;
    }
    return "none";
}
function deriveOpenBlockingDrift(state) {
    const items = [];
    const drift = state.drift_open_blocking ?? 0;
    const debate = state.debate_open_blocking ?? 0;
    if (drift > 0)
        items.push(`drift_open_blocking=${drift}`);
    if (debate > 0)
        items.push(`debate_open_blocking=${debate}`);
    return items;
}
function deriveApprovedConstraints(state) {
    return state.approved_artifacts.map((a) => `${a.file}:v${a.version}:${a.hash.slice(0, 12)}`);
}
function deriveNextAction(state) {
    if (!state.implementation_allowed) {
        return `Complete stage "${state.current_stage}" gates — implementation not yet allowed.`;
    }
    const inProgress = state.slices.filter((s) => s.status === "in-progress");
    if (inProgress.length > 0) {
        return `Complete in-progress slices: ${inProgress.map((s) => s.id).join(", ")}.`;
    }
    const pending = state.slices.filter((s) => s.status === "pending");
    if (pending.length > 0) {
        const shown = pending.slice(0, 3).map((s) => s.id).join(", ");
        const extra = pending.length > 3 ? ` (+${pending.length - 3} more)` : "";
        return `Start pending slices: ${shown}${extra}.`;
    }
    return `All slices complete — advance past stage "${state.current_stage}".`;
}
function deriveCompletionCriteria(state, stage) {
    const parts = [`stage="${stage}" gates pass`];
    const drift = (state.drift_open_blocking ?? 0) + (state.debate_open_blocking ?? 0);
    if (drift > 0)
        parts.push(`resolve ${drift} blocking drift(s)`);
    if (state.open_questions.length > 0) {
        parts.push(`close ${state.open_questions.length} open question(s)`);
    }
    const notDone = state.slices.filter((s) => s.status !== "done").length;
    if (notDone > 0)
        parts.push(`complete ${notDone} remaining slice(s)`);
    if (state.blast_radius_flags.length > 0) {
        parts.push(`all blast-radius gates cleared (${state.blast_radius_flags.join(", ")})`);
    }
    return parts.join("; ");
}
function estimateBodyTokens(body) {
    return (0, context_telemetry_1.estimateTokens)(JSON.stringify(body));
}
function collapseField(value) {
    if (Array.isArray(value))
        return [OVERFLOW_POINTER];
    return OVERFLOW_POINTER;
}
/**
 * Enforce the soft budget and the D-17 hard cap.
 *
 * Narrative fields are collapsed to an overflow pointer in drop-priority order
 * until the capsule fits within `budgetTokens`. A second pass over all narrative
 * fields runs if the result still exceeds {@link HARD_CAP_TOKENS}.
 */
function enforceBudget(body, budgetTokens) {
    if (estimateBodyTokens(body) <= budgetTokens)
        return body;
    // Soft-budget pass: collapse narrative fields from least critical first.
    let current = body;
    for (const field of NARRATIVE_FIELDS_DROP_ORDER) {
        if (estimateBodyTokens(current) <= budgetTokens)
            break;
        current = { ...current, [field]: collapseField(current[field]) };
    }
    // Hard-cap pass: if still over the absolute limit, collapse all remaining narrative fields.
    if (estimateBodyTokens(current) > exports.HARD_CAP_TOKENS) {
        for (const field of NARRATIVE_FIELDS_DROP_ORDER) {
            current = { ...current, [field]: collapseField(current[field]) };
        }
    }
    // Mandatory-array truncation pass: with all narrative fields collapsed, the
    // only remaining unbounded vector is the mandatory string arrays. Collapsing
    // them to a pointer is forbidden (D-01), so truncate to a shrinking prefix
    // until the body fits. D-17 (the hard cap) MUST hold; this guarantees it for
    // any input array sizes. Deterministic: fixed field order, fixed max sequence.
    if (estimateBodyTokens(current) > exports.HARD_CAP_TOKENS) {
        let max = 64;
        while (estimateBodyTokens(current) > exports.HARD_CAP_TOKENS && max >= 0) {
            for (const field of MANDATORY_ARRAY_FIELDS) {
                current = {
                    ...current,
                    [field]: truncateArrayField(current[field], max),
                };
            }
            max = max === 0 ? -1 : Math.floor(max / 2);
        }
    }
    return current;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * D-01/D-02 — generate a Control Capsule from the current project state.
 *
 * Pure and deterministic: same `state` + `tier` + `stage` + fixed `opts.generatedAt`
 * always yields the same {@link Capsule} and the same `capsule_hash`.
 *
 * @param state   Validated project state (read from `state.json`).
 * @param tier    Effective tier string to embed (e.g. "T2", "unclassified").
 * @param stage   Active workflow stage (e.g. "implementation").
 * @param opts    Budget preset, epoch, and timestamp overrides.
 */
function capsuleFromState(state, tier, stage, opts = {}) {
    const budgetPreset = opts.budget ?? "standard";
    const budgetTokens = BUDGET_TOKENS_BY_PRESET[budgetPreset];
    const epoch = opts.epoch ?? 0;
    const generatedAt = opts.generatedAt ?? new Date().toISOString();
    // Build the full capsule body (all narrative fields populated).
    const fullBody = {
        objective: state.complexity_rationale || "No objective recorded.",
        tier,
        stage,
        slice_or_wave: deriveSliceOrWave(state),
        requirement_ids: state.slices.map((s) => s.id),
        approved_constraints: deriveApprovedConstraints(state),
        blast_radius_flags: [...state.blast_radius_flags],
        open_blocking_drift: deriveOpenBlockingDrift(state),
        open_decisions: [...state.open_questions],
        failures_blockers: state.slices.filter((s) => s.status === "blocked").map((s) => s.id),
        side_effects_performed: state.slices
            .filter((s) => s.status === "done")
            .map((s) => `${s.id}(${s.components.join(",")})`),
        next_action: deriveNextAction(state),
        completion_criteria: deriveCompletionCriteria(state, stage),
        epoch,
        generated_at: generatedAt,
    };
    // Apply budget enforcement — narrative fields may be collapsed; mandatory fields never are.
    const body = enforceBudget(fullBody, budgetTokens);
    // capsule_hash covers the full budget-enforced body (D-01: canonical, without hash field).
    const capsule_hash = (0, hash_1.hashContent)(canonicalJson(body));
    return { ...body, capsule_hash };
}
