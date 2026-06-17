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

export interface FieldPolicy {
  /** Owned by a dedicated flow/command rather than being a free-form field. */
  managed: boolean;
  /**
   * A gate-security field. The MCP raw setter (`th_state_set`) must refuse it so
   * an agent cannot move a gate; the CLI may still set it (validated/ledgered).
   */
  gateOwned: boolean;
  /** How the field is changed legitimately (used in the CLI refusal message). */
  owner: string;
  /**
   * Whether `th state set` refuses the field outright. True only for counters
   * with an owning invariant the CLI must not corrupt (drift/debate). Gate-owned
   * fields are false here — the CLI set path is the documented unlock/advance.
   */
  refusedByStateSet: boolean;
}

export const STATE_FIELD_POLICY: Record<string, FieldPolicy> = {
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
export const GATE_OWNED: ReadonlySet<string> = new Set(
  Object.entries(STATE_FIELD_POLICY)
    .filter(([, p]) => p.gateOwned)
    .map(([k]) => k),
);

/** Look up a field's policy by its top-level (first-segment) key. */
export function fieldPolicy(field: string): FieldPolicy | undefined {
  return Object.prototype.hasOwnProperty.call(STATE_FIELD_POLICY, field)
    ? STATE_FIELD_POLICY[field]
    : undefined;
}
