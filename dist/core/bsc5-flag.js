"use strict";
/**
 * BSC-5 dimension-set-coverage enforcement flag (Axis-B slice-7 / BSC-5).
 *
 * Mirrors the EXISTING `bsc3-flag.ts` / `bsc1-flag.ts` precedent (an env-var rollout switch
 * with an inline default). The flag governs ENFORCEMENT ONLY — the dimension-set-coverage
 * rung ALWAYS computes the `declared ⊆ observed` verdict (so the coverage posture is visible
 * for observability) and simply does not BLOCK on it when enforcement is off.
 *
 * DEFAULTS ON: enforcement runs in CI/verify and everywhere else UNLESS explicitly disabled
 * with `TH_BSC5_ENFORCE=0` (or `false`, case-insensitive). Any other value — including absent,
 * "1", "true", or an unrecognized string — keeps enforcement ON (fail-closed posture: a typo
 * never silently disables the gate).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.bsc5EnforcementEnabled = bsc5EnforcementEnabled;
/**
 * Whether the BSC-5 dimension-set-coverage rung ENFORCES (blocks) this run. Defaults to
 * `true`; returns `false` ONLY when `TH_BSC5_ENFORCE` is explicitly `"0"` or `"false"`
 * (case-insensitive, surrounding whitespace ignored).
 */
function bsc5EnforcementEnabled() {
    const raw = process.env.TH_BSC5_ENFORCE;
    if (raw === undefined)
        return true;
    const normalized = raw.trim().toLowerCase();
    return !(normalized === "0" || normalized === "false");
}
