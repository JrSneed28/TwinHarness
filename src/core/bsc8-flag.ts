/**
 * BSC-8 tier-correspondence enforcement flag (Axis-B slice-7 / BSC-8).
 *
 * Mirrors `src/core/bsc3-flag.ts` / `src/core/bsc1-flag.ts` / `src/core/bsc2-flag.ts`
 * (the env-var rollout-switch precedent): the single switch the tier-correspondence rung
 * in `checkProductionReality` consults. The flag governs ENFORCEMENT ONLY — never which
 * verbs exist (`th tier record` / `th tier classify` are always registered; the
 * Integrator owns that). When enforcement is OFF the rung still COMPUTES + reports the
 * claimed-tier / computed-min-tier correspondence summary (attaching a non-blocking
 * `notice`), it simply does not BLOCK on it.
 *
 * DEFAULTS ON: enforcement runs in CI/verify and everywhere else UNLESS explicitly
 * disabled with `TH_BSC8_ENFORCE=0` (or `false`, case-insensitive). Any other value —
 * including absent, "1", "true", or an unrecognized string — keeps enforcement ON
 * (fail-closed posture: a typo never silently disables the gate). The probe forces the
 * RED leg with `TH_BSC8_ENFORCE=0` (ship-dark non-blocking notice) and the GREEN leg with
 * the default-on / `=1` (blocks).
 */

/**
 * Whether the BSC-8 tier-correspondence rung ENFORCES (blocks) this run. Defaults to
 * `true`; returns `false` ONLY when `TH_BSC8_ENFORCE` is explicitly `"0"` or `"false"`
 * (case-insensitive, surrounding whitespace ignored).
 */
export function bsc8EnforcementEnabled(): boolean {
  const raw = process.env.TH_BSC8_ENFORCE;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === "0" || normalized === "false");
}
