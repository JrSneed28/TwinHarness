"use strict";
/**
 * BSC-1 realization-receipt enforcement flag (Axis-B slice-5 / BSC-1).
 *
 * Mirrors `src/core/bsc3-flag.ts` EXACTLY (the env-var rollout-switch precedent): the
 * single switch the realization rung in `checkProductionReality` consults. The flag
 * governs ENFORCEMENT ONLY — never which verbs exist (the `th realize` verb is always
 * registered; the Integrator owns that). When enforcement is OFF the rung still COMPUTES
 * + reports the per-REQ realization verdict (the observability hook), it just does not
 * BLOCK on it.
 *
 * DEFAULTS ON: enforcement runs in CI/verify and everywhere else UNLESS explicitly
 * disabled with `TH_BSC1_ENFORCE=0` (or `false`, case-insensitive). Any other value —
 * including absent, "1", "true", or an unrecognized string — keeps enforcement ON
 * (fail-closed posture: a typo never silently disables the gate).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.realizationEnforcementEnabled = realizationEnforcementEnabled;
/**
 * Whether the BSC-1 realization rung ENFORCES (blocks) this run. Defaults to `true`;
 * returns `false` ONLY when `TH_BSC1_ENFORCE` is explicitly `"0"` or `"false"`
 * (case-insensitive, surrounding whitespace ignored).
 */
function realizationEnforcementEnabled() {
    const raw = process.env.TH_BSC1_ENFORCE;
    if (raw === undefined)
        return true;
    const normalized = raw.trim().toLowerCase();
    return !(normalized === "0" || normalized === "false");
}
