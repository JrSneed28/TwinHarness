"use strict";
/**
 * BSC-3 driver-dimension enforcement flag (Axis-B slice-4a / BSC-3).
 *
 * Following the EXISTING env-var precedent (`state-store.lockTimeoutMs()` reads
 * `process.env.TH_LOCK_TIMEOUT_MS` with an inline default), this exposes the single
 * rollout switch the driver-dimension gate rung consults. The flag governs ENFORCEMENT
 * ONLY — never which verbs exist (verb registration is always-on; the Integrator owns
 * that). When enforcement is OFF the rung still COMPUTES + reports the per-dimension
 * trust labels (the observability hook), it simply does not BLOCK on them.
 *
 * DEFAULTS ON: enforcement runs in CI/verify and everywhere else UNLESS explicitly
 * disabled with `TH_BSC3_ENFORCE=0` (or `false`, case-insensitive). Any other value —
 * including absent, "1", "true", or an unrecognized string — keeps enforcement ON
 * (fail-closed posture: a typo never silently disables the gate).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.bsc3EnforcementEnabled = bsc3EnforcementEnabled;
/**
 * Whether the BSC-3 driver-dimension rung ENFORCES (blocks) this run. Defaults to
 * `true`; returns `false` ONLY when `TH_BSC3_ENFORCE` is explicitly `"0"` or `"false"`
 * (case-insensitive, surrounding whitespace ignored).
 */
function bsc3EnforcementEnabled() {
    const raw = process.env.TH_BSC3_ENFORCE;
    if (raw === undefined)
        return true;
    const normalized = raw.trim().toLowerCase();
    return !(normalized === "0" || normalized === "false");
}
