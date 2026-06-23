/**
 * BSC-10 external-reference grounding enforcement flag (Axis-B slice-A / BSC-10).
 *
 * Mirrors `src/core/bsc2-flag.ts` / `src/core/bsc3-flag.ts` / `src/core/bsc1-flag.ts` (the
 * env-var rollout-switch precedent): the single switch the grounding rung in
 * `checkProductionReality` consults. The flag governs ENFORCEMENT ONLY — never which verbs
 * exist (the `th grounding record` / `th grounding check` verbs are always registered; the
 * Integrator owns that). When enforcement is OFF the rung still COMPUTES + reports the
 * grounding summary (attaching a non-blocking `notice`), it just does not BLOCK on it.
 *
 * WARN → ENFORCE TWO-COMMIT INTENT: this lands in TWO ordinary commits. COMMIT 1 (WARN —
 * THIS commit, Slice A) defaults this flag OFF — the rung observes (attaching a non-blocking
 * `notice` + grounding summary) but never blocks. COMMIT 2 (ENFORCE — Slice B) will flip the
 * default to ON (mirroring bsc2-flag.ts exactly), making the rung a hard production-reality
 * block. The flip is a one-line revertable unit so a reviewer can `git revert` that commit
 * back to this green warn state.
 *
 * EXPLICIT ENV VALUES ARE HONORED IN BOTH STATES: in EITHER commit, an explicit
 * `TH_BSC10_ENFORCE=1`/`true` forces ON and `=0`/`false` forces OFF (case-insensitive,
 * surrounding whitespace ignored), so the probe + tests can force either leg regardless of
 * the compiled default. Only an ABSENT value falls through to the compiled default (OFF in
 * Slice A / WARN; ON in Slice B / ENFORCE).
 *
 * DEFAULTS OFF (Slice A / WARN): the grounding rung observes but never blocks UNLESS
 * explicitly enabled with `TH_BSC10_ENFORCE=1` (or `true`, case-insensitive).
 */

/**
 * Whether the BSC-10 external-reference grounding rung ENFORCES (blocks) this run.
 * Defaults to `false` in Slice A (WARN commit); returns `true` ONLY when
 * `TH_BSC10_ENFORCE` is explicitly `"1"` or `"true"` (case-insensitive, surrounding
 * whitespace ignored). Slice B flips the default to ON as a one-line revertable unit.
 */
export function bsc10EnforcementEnabled(): boolean {
  const raw = process.env.TH_BSC10_ENFORCE;
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}
