"use strict";
/**
 * Canonical state-field ownership registry (H-2).
 *
 * One table answers "who owns this field, and may a raw setter move it?". Two
 * surfaces consume it:
 *   - `th state set` (CLI) refuses fields whose owning command maintains an
 *     invariant a raw set would corrupt (the drift/debate counters, via
 *     `refusedByStateSet`). It ALSO refuses gate-owned fields unless `--emergency`
 *     is passed (audit finding #11): the typed gate commands (`th tier record`,
 *     `th stage advance`, `th implementation unlock`) are the gate-checked path,
 *     and a forced `--emergency` raw write is loud + audit-ledgered.
 *   - the MCP server (F-7) must NOT expose a raw setter for any GATE_OWNED field:
 *     an agent must never flip implementation_allowed / tier / current_stage /
 *     write_gate through `th_state_set`. This is the proven H-2 closure.
 *
 * Boundary note (plan §3): the CLI still only records/computes. Gate-owned fields
 * move through the human-driven typed gate commands (or `--emergency` for a raw
 * override); we constrain the agent-facing MCP surface and validate/normalize what
 * the CLI accepts.
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
        owner: "typed gate command `th implementation unlock` (raw `th state set` requires --emergency)",
        refusedByStateSet: false,
    },
    tier: {
        managed: true,
        gateOwned: true,
        owner: "`th tier classify` then `th tier record` (raw `th state set` requires --emergency)",
        refusedByStateSet: false,
    },
    current_stage: {
        managed: true,
        gateOwned: true,
        owner: "typed gate command `th stage advance` (raw `th state set` requires --emergency)",
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
    // RC-C / R-04 (DR-02): the gate-DEFINING config tier. Each of these four fields
    // either removes a gate or makes it vacuous, so a raw agent write must never move
    // one silently. They have NO typed runtime write site (they default to the SAFE
    // value when absent and no agent prompt sets them — DR-02 evidence), so the only
    // legitimate writer is `th init` at creation time. Bringing them under the
    // gate-owned/audited guard means: MCP `th_state_set` refuses them, and a raw CLI
    // `th state set` requires `--emergency` (loud + gate-ledger-sealed).
    delivery_mode: {
        managed: true,
        gateOwned: true,
        owner: "set once at creation via `th init --delivery-mode <code|no-code|documentation-only>` (raw `th state set` requires --emergency)",
        refusedByStateSet: false,
    },
    has_ui: {
        managed: true,
        gateOwned: true,
        owner: "set once at creation via `th init --no-ui` / `--has-ui` (raw `th state set` requires --emergency)",
        refusedByStateSet: false,
    },
    interview_required: {
        managed: true,
        gateOwned: true,
        owner: "set once at creation via `th init --interview-required` / `--no-interview-required` (raw `th state set` requires --emergency)",
        refusedByStateSet: false,
    },
    interview_cutoff: {
        managed: true,
        gateOwned: true,
        owner: "set once at creation via `th init --interview-cutoff <0..1>` (raw `th state set` requires --emergency)",
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
