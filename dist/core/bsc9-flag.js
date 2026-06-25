"use strict";
/**
 * BSC-9 projection-oracle + interview-readiness enforcement flag (Axis-B slice-7 / BSC-9).
 *
 * Mirrors `src/core/bsc1-flag.ts` / `bsc3-flag.ts` EXACTLY (the env-var rollout-switch
 * precedent): the single switch the BSC-9 rung in `checkProductionReality` consults. The
 * flag governs ENFORCEMENT ONLY — never which verbs/tools exist (the interview + MCP tool
 * surfaces are always registered). When enforcement is OFF the rung still COMPUTES + reports
 * the projection-oracle / readiness verdict (the observability hook), it just does not BLOCK.
 *
 * DEFAULTS ON: enforcement runs in CI/verify and everywhere else UNLESS explicitly disabled
 * with `TH_BSC9_ENFORCE=0` (or `false`, case-insensitive). Any other value — including
 * absent, "1", "true", or an unrecognized string — keeps enforcement ON (fail-closed
 * posture: a typo never silently disables the gate).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.bsc9EnforcementEnabled = bsc9EnforcementEnabled;
/**
 * Whether the BSC-9 rung ENFORCES (blocks) this run. Defaults to `true`; returns `false`
 * ONLY when `TH_BSC9_ENFORCE` is explicitly `"0"` or `"false"` (case-insensitive,
 * surrounding whitespace ignored).
 */
function bsc9EnforcementEnabled() {
    const raw = process.env.TH_BSC9_ENFORCE;
    if (raw === undefined)
        return true;
    const normalized = raw.trim().toLowerCase();
    return !(normalized === "0" || normalized === "false");
}
