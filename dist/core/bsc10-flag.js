"use strict";
/**
 * BSC-10 external-reference grounding enforcement flag (Axis-B slice-BSC10a/b / BSC-10).
 *
 * Mirrors `src/core/bsc2-flag.ts` / `src/core/bsc3-flag.ts` / `src/core/bsc1-flag.ts` (the
 * env-var rollout-switch precedent): the single switch the grounding rung in
 * `checkProductionReality` consults. The flag governs ENFORCEMENT ONLY — never which verbs
 * exist (the `th grounding record` / `th grounding check` verbs are always registered; the
 * Integrator owns that). When enforcement is OFF the rung still COMPUTES + reports the
 * grounding summary (attaching a non-blocking `notice`), it just does not BLOCK on it.
 *
 * PER-KIND WARN → ENFORCE (Slice B, M2): the master switch {@link bsc10EnforcementEnabled} is
 * the env reader, but enforcement is promoted ONE GROUND-KIND AT A TIME via
 * {@link bsc10KindEnforced}. In Slice B ONLY the DETERMINISTIC kinds (`digest-manifest`,
 * `version-pin`) flip to ENFORCE — they reproduce identically on any runner (exact-equality /
 * symbol-set / pinned version), so gating them is CI-deterministic. The runner-sensitive kind
 * (`visual-hash`, and the `a11y` conformance metric it carries) STAYS WARN until Slice C lands
 * the pinned-renderer / pinned-scan-rule measurement, at which point a SECOND one-commit flip
 * promotes it. So a `visual-hash` over-budget/missing is a non-blocking `notice` in Slice B even
 * when the master switch is ON; a `digest-manifest`/`version-pin` failure BLOCKS.
 *
 * WARN → ENFORCE TWO-COMMIT INTENT (the compiled default, owned by the Integrator): this lands
 * in TWO ordinary commits. COMMIT 1 (WARN) defaults the master switch OFF — the rung observes
 * (attaching a non-blocking `notice` + grounding summary) but never blocks. COMMIT 2 (ENFORCE —
 * the deterministic-kinds flip) flips the compiled default to ON (mirroring bsc2-flag.ts exactly),
 * making the deterministic-kind rungs a hard production-reality block while `visual-hash` rides on
 * the per-kind WARN of {@link bsc10KindEnforced}. The flip is a one-line revertable unit
 * (`return true` ⇆ `return false` on the unset branch below) so a reviewer can `git revert` that
 * commit back to the green warn state.
 *
 * EXPLICIT ENV VALUES ARE HONORED IN BOTH STATES: in EITHER commit, an explicit
 * `TH_BSC10_ENFORCE=1`/`true` forces ON and `=0`/`false` forces OFF (case-insensitive,
 * surrounding whitespace ignored), so the probe + tests can force either leg regardless of
 * the compiled default. Only an ABSENT value falls through to the compiled default.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.bsc10EnforcementEnabled = bsc10EnforcementEnabled;
exports.bsc10KindEnforced = bsc10KindEnforced;
/**
 * The ground-kinds that ENFORCE (block). `digest-manifest` (exact content/symbol-set equality)
 * and `version-pin` (exact version equality) flipped in Slice B (M2) — deterministic, runner-stable.
 * Slice C (C4d) ADDS `visual-hash`: its conformance is gated by the C4c observed-vs-signed-budget
 * threshold — DETERMINISTIC arithmetic over the externally-signed receipt's `observed` value and the
 * signed budget threshold, with NO in-process renderer/axe (the perceptual-diff / a11y-scan
 * measurement runs in the producer/CI and is signed into the receipt). `a11y` rides as a tolerance
 * metric WITHIN visual-hash grounds, so it enforces via this same kind. Enforce-sim: the real
 * TwinHarness project declares no grounding receipts ⇒ 0 unwaived offenders; blast radius bounded
 * (CI does not dogfood `th gate`). Revertable: `git revert` of the C4d commit restores the WARN set.
 */
const ENFORCED_GROUND_KINDS = new Set(["digest-manifest", "version-pin", "visual-hash"]);
/**
 * Whether the BSC-10 external-reference grounding rung ENFORCES (blocks) this run — the MASTER
 * switch, NOT the per-kind decision (see {@link bsc10KindEnforced} for that). Returns `true`
 * UNLESS `TH_BSC10_ENFORCE` is explicitly `"0"`/`"false"` (case-insensitive, surrounding
 * whitespace ignored); an absent value falls through to the COMPILED DEFAULT.
 *
 * BUILD-TWICE COMPILED DEFAULT (Integrator-owned one-liner — the `raw === undefined` branch):
 * Slice-A WARN ships `return false`; the Slice-B ENFORCE commit ships `return true` (byte-mirror
 * of `bsc2-flag.ts:36`). DO NOT hand-edit the env-normalization below — only the unset-branch
 * return is the two-commit toggle.
 */
function bsc10EnforcementEnabled() {
    const raw = process.env.TH_BSC10_ENFORCE;
    // ── COMPILED DEFAULT (two-commit toggle, Integrator-owned) ──────────────────────────────
    // Slice-A WARN: `return false`.  Slice-B ENFORCE: `return true` (mirrors bsc2-flag.ts:36).
    if (raw === undefined)
        return true;
    // ────────────────────────────────────────────────────────────────────────────────────────
    const normalized = raw.trim().toLowerCase();
    return !(normalized === "0" || normalized === "false");
}
/**
 * Whether enforcement BLOCKS for a SPECIFIC ground-kind this run (M2 per-kind flip). True ONLY
 * when the master switch {@link bsc10EnforcementEnabled} is ON AND `kind` is in
 * {@link ENFORCED_GROUND_KINDS}: `digest-manifest` + `version-pin` (Slice B, deterministic) and
 * `visual-hash` (Slice C / C4d, gated by the C4c observed-vs-signed-budget tolerance threshold; a11y
 * rides within visual-hash grounds). The gate consults this per offending kind so an enforced failure
 * BLOCKS while any not-yet-promoted kind would ride as a non-blocking `notice` in the SAME run.
 */
function bsc10KindEnforced(kind) {
    return bsc10EnforcementEnabled() && ENFORCED_GROUND_KINDS.has(kind);
}
