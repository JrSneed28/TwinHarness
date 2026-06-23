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
 * defaults this flag OFF — the rung observes (attaches a non-blocking `notice` + the
 * observability `summary`) but never blocks. COMMIT 2 (ENFORCE) flips the default to ON
 * (mirroring bsc3-flag.ts exactly), making the rung a hard production-reality block. The
 * flip is a one-line revertable unit so a reviewer can `git revert` it back to the green
 * warn state.
 *
 * EXPLICIT ENV VALUES ARE HONORED IN BOTH STATES: in EITHER commit, an explicit
 * `TH_BSC2_ENFORCE=1`/`true` forces ON and `=0`/`false` forces OFF (case-insensitive),
 * so the probe + tests can force either leg regardless of the compiled default. Only an
 * ABSENT value falls through to the compiled default (OFF in commit 1, ON in commit 2).
 */

/**
 * Whether the BSC-2 assertion-presence rung ENFORCES (blocks) this run.
 *
 * COMMIT 1 (WARN) — defaults to `false` when `TH_BSC2_ENFORCE` is unset; returns `true`
 * ONLY when it is explicitly `"1"` or `"true"`, and `false` on `"0"`/`"false"` or any
 * other value (case-insensitive, surrounding whitespace ignored). The default is flipped
 * to ON in COMMIT 2.
 */
export function bsc2EnforcementEnabled(): boolean {
  const raw = process.env.TH_BSC2_ENFORCE;
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}
