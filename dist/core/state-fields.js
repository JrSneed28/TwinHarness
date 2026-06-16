"use strict";
/**
 * Canonical state-field ownership registry (H-2).
 *
 * One table answers "who owns this field, and may a raw setter move it?". Two
 * surfaces consume it:
 *   - `th state set` (CLI) refuses fields whose owning command maintains an
 *     invariant a raw set would corrupt (the drift/debate counters). Gate-owned
 *     fields are NOT refused at the CLI — setting them is the documented
 *     unlock/advance path — but they are validated + audit-ledgered.
 *   - the MCP server (F-7) must NOT expose a raw setter for any GATE_OWNED field:
 *     an agent must never flip implementation_allowed / tier / current_stage /
 *     write_gate through `th_state_set`. This is the proven H-2 closure.
 *
 * Boundary note (plan §3): the CLI still only records/computes — gate-owned
 * fields remain settable by the human-driven CLI flow; we constrain only the
 * agent-facing MCP surface and validate/normalize what the CLI accepts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GATE_OWNED = exports.STATE_FIELD_POLICY = void 0;
exports.fieldPolicy = fieldPolicy;
exports.STATE_FIELD_POLICY = {
    drift_open_blocking: {
        managed: true,
        gateOwned: false,
        owner: "Use `th drift add` / `th drift resolve` — this counter is owned by the drift flow.",
        refusedByStateSet: true,
    },
    debate_open_blocking: {
        managed: true,
        gateOwned: false,
        owner: "Use `th debate add` / `th debate resolve` — this counter is owned by the debate flow.",
        refusedByStateSet: true,
    },
    implementation_allowed: {
        managed: true,
        gateOwned: true,
        owner: "orchestrator unlock flow (`th state set implementation_allowed true` on the CLI)",
        refusedByStateSet: false,
    },
    tier: {
        managed: true,
        gateOwned: true,
        owner: "`th tier classify`",
        refusedByStateSet: false,
    },
    current_stage: {
        managed: true,
        gateOwned: true,
        owner: "`th next` / stage advance",
        refusedByStateSet: false,
    },
    write_gate: {
        managed: true,
        gateOwned: true,
        owner: "operator policy",
        refusedByStateSet: false,
    },
    blast_radius_flags: {
        managed: true,
        gateOwned: true,
        owner: "operator policy",
        refusedByStateSet: false,
    },
};
/** Fields the MCP raw setter must refuse (the proven H-2 surface). */
exports.GATE_OWNED = new Set(Object.entries(exports.STATE_FIELD_POLICY)
    .filter(([, p]) => p.gateOwned)
    .map(([k]) => k));
/** Look up a field's policy by its top-level (first-segment) key. */
function fieldPolicy(field) {
    return Object.prototype.hasOwnProperty.call(exports.STATE_FIELD_POLICY, field)
        ? exports.STATE_FIELD_POLICY[field]
        : undefined;
}
