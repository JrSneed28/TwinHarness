"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyBrief = classifyBrief;
/**
 * The five Tier-0 conditions plus the blast-radius veto, computed mechanically
 * (spec §5).
 *
 * Lifted out of `commands/tier.ts` into `core/` so the gate (`core/`) can consume
 * the same min-tier classifier WITHOUT a `core → commands` layering inversion. This
 * is the single source of truth for "is this brief Tier-0 eligible?"; both
 * `commands/tier.ts` (the `th tier classify` advisory) and any `core/` gate rung
 * import THIS function, so they can never drift apart about what T0-eligibility means.
 *
 * Pure: it reads only the brief and decides nothing about the run.
 */
function classifyBrief(brief) {
    const reasons = [];
    if (!brief.single_file_or_local)
        reasons.push("not a single file / tightly local area");
    if (brief.changes_public_interface)
        reasons.push("changes a public interface, schema, or contract");
    if (brief.adds_dependency)
        reasons.push("adds a new dependency");
    if (!brief.obvious_testable_answer)
        reasons.push("no obvious, testable correct answer");
    const blocked_by_veto = brief.blast_radius_flags.length > 0;
    if (blocked_by_veto) {
        reasons.push(`blast-radius flag(s) force ≥T1 (§5 veto): ${brief.blast_radius_flags.join(", ")}`);
    }
    const tier0_eligible = brief.single_file_or_local &&
        !brief.changes_public_interface &&
        !brief.adds_dependency &&
        brief.obvious_testable_answer &&
        brief.blast_radius_flags.length === 0;
    return { tier0_eligible, blocked_by_veto, reasons };
}
