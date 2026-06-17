"use strict";
/**
 * Model & effort routing (spec §2 — effort scales with tier and blast radius).
 *
 * This was the last "mechanical truth" still living only as prose: a 5-row table
 * duplicated verbatim in `skills/twinharness/SKILL.md` and `agents/orchestrator.md`.
 * `computeRoute` encodes those exact escalation rules in code. Like `th tier
 * classify`, it COMPUTES a recommendation; the Orchestrator still APPLIES the
 * model/effort override when it spawns the agent (the §3 boundary: records and
 * computes, never decides).
 *
 * Pure and total: same inputs → same decision, no IO, no clock.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROUTE_EFFORTS = exports.ROUTE_MODELS = void 0;
exports.computeRoute = computeRoute;
exports.ROUTE_MODELS = ["haiku", "sonnet", "opus"];
exports.ROUTE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Heavy design modes that route to opus unconditionally (tier/blast may still raise effort). */
const OPUS_DESIGN_MODES = new Set([
    "architecture",
    "technical-design",
    "security",
    "failure-modes",
    "adrs",
    "contracts",
    "ux-design",
    "ui-design",
]);
/** Critic modes that escalate to opus on a blast-radius project. */
const OPUS_CRITIC_MODES = new Set(["slice", "code-review"]);
/** Agents whose frontmatter default is already opus. */
const OPUS_DEFAULT_AGENTS = new Set(["orchestrator", "vertical-slice"]);
/**
 * Map the prose routing table to a {model, effort} decision. The effort ladder:
 * haiku→low; default sonnet→medium (high on T3). Heavy design modes route to opus
 * UNCONDITIONALLY at effort high, raised to xhigh when T3 AND blast, and to max for
 * the single most extreme case (a security model on a T3 blast-radius project).
 * Builder/Tester climb a tier ladder: T0 sonnet/high, T1 opus/medium, T2 opus/high,
 * T3 opus/xhigh; a blast-radius component forces opus regardless of tier.
 */
function computeRoute(input) {
    const agent = input.agent;
    const mode = input.mode;
    const tier = input.tier ?? null;
    const blast = (input.blastFlags?.length ?? 0) > 0;
    const t3 = tier === "T3";
    // Trivial mechanical summarization → cheapest.
    if (input.summarization) {
        return { model: "haiku", effort: "low", rationale: "trivial mechanical summarization (§2)" };
    }
    // Spec (or stage producer) in a heavy design mode → opus unconditionally (tier/blast raise effort).
    if (mode && OPUS_DESIGN_MODES.has(mode) && agent !== "critic") {
        if (mode === "security" && t3 && blast) {
            return { model: "opus", effort: "max", rationale: `security design on a T3 blast-radius project (${mode}, §2/§15.S)` };
        }
        return {
            model: "opus",
            effort: t3 && blast ? "xhigh" : "high",
            rationale: `heavy design mode "${mode}" → opus unconditionally (§2)`,
        };
    }
    // Critic in slice / code-review mode on a blast-radius project.
    if (agent === "critic" && mode && OPUS_CRITIC_MODES.has(mode) && blast) {
        return {
            model: "opus",
            effort: t3 && blast ? "xhigh" : "high",
            rationale: `critic "${mode}" on a blast-radius project (§2)`,
        };
    }
    // Builder / Tester climb a tier ladder; a blast-radius component forces opus.
    if (agent === "builder" || agent === "tester") {
        if (input.componentBlast || blast) {
            const effort = t3 ? "xhigh" : tier === "T2" ? "high" : tier === "T1" ? "medium" : "high";
            return { model: "opus", effort, rationale: `${agent} on a blast-radius component (§2)` };
        }
        if (t3)
            return { model: "opus", effort: "xhigh", rationale: `${agent} T3 tier ladder (§2)` };
        if (tier === "T2")
            return { model: "opus", effort: "high", rationale: `${agent} T2 tier ladder (§2)` };
        if (tier === "T1")
            return { model: "opus", effort: "medium", rationale: `${agent} T1 tier ladder (§2)` };
        return { model: "sonnet", effort: "high", rationale: `${agent} T0 tier floor (§2)` };
    }
    // Orchestrator & Vertical-Slice default to opus (frontmatter default).
    if (agent && OPUS_DEFAULT_AGENTS.has(agent)) {
        return { model: "opus", effort: t3 || blast ? "high" : "medium", rationale: `${agent} default (opus)` };
    }
    // Default: cheap by default, a notch more effort on T3.
    return { model: "sonnet", effort: t3 ? "high" : "medium", rationale: "default (sonnet)" };
}
