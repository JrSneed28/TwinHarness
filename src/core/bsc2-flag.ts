/**
 * BSC-2 assertion-presence enforcement flag (Axis-B slice-6 / BSC-2).
 *
 * Mirrors `src/core/bsc3-flag.ts` / `src/core/bsc1-flag.ts` (the env-var rollout-switch
 * precedent): the single switch the assertion-presence rung in `checkProductionReality`
 * consults. The flag governs ENFORCEMENT ONLY — never which verbs exist (the
 * `th assertion-presence record` verb is always registered; the Integrator owns that).
 * When enforcement is OFF the rung still COMPUTES + reports the per-REQ observability
 * summary (the I1 hook), it just does not BLOCK on it.
 *
 * WARN → ENFORCE TWO-COMMIT INTENT: this lands in TWO ordinary commits. COMMIT 1 (WARN)
 * defaulted this flag OFF — the rung observed (attaching a non-blocking `notice` + the
 * observability `summary`) but never blocked. COMMIT 2 (ENFORCE — THIS commit) flips the
 * default to ON (mirroring bsc3-flag.ts exactly), making the rung a hard production-reality
 * block. The flip is a one-line revertable unit so a reviewer can `git revert` this commit
 * back to the green warn state.
 *
 * EXPLICIT ENV VALUES ARE HONORED IN BOTH STATES: in EITHER commit, an explicit
 * `TH_BSC2_ENFORCE=0`/`false` forces OFF and `=1`/`true` forces ON (case-insensitive), so
 * the probe + tests can force either leg regardless of the compiled default. Only an ABSENT
 * value falls through to the compiled default (OFF in commit 1, ON in commit 2).
 *
 * DEFAULTS ON: enforcement runs in CI/verify and everywhere else UNLESS explicitly disabled
 * with `TH_BSC2_ENFORCE=0` (or `false`, case-insensitive). Any other value — including
 * absent, "1", "true", or an unrecognized string — keeps enforcement ON (fail-closed
 * posture: a typo never silently disables the gate).
 */

/**
 * Whether the BSC-2 assertion-presence rung ENFORCES (blocks) this run. Defaults to `true`;
 * returns `false` ONLY when `TH_BSC2_ENFORCE` is explicitly `"0"` or `"false"`
 * (case-insensitive, surrounding whitespace ignored).
 */
export function bsc2EnforcementEnabled(): boolean {
  const raw = process.env.TH_BSC2_ENFORCE;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === "0" || normalized === "false");
}
