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
/** Heavy design modes that escalate to opus on a T3 or blast-radius project. */
const OPUS_DESIGN_MODES = new Set(["architecture", "security", "failure-modes", "technical-design"]);
/** Critic modes that escalate to opus on a blast-radius project. */
const OPUS_CRITIC_MODES = new Set(["slice", "code-review"]);
/** Agents whose frontmatter default is already opus. */
const OPUS_DEFAULT_AGENTS = new Set(["orchestrator", "vertical-slice"]);
/**
 * Map the prose routing table to a {model, effort} decision. The effort ladder:
 * haiku→low; default sonnet→medium (high on T3); opus escalations→high, →xhigh
 * when T3 AND blast, →max for the single most extreme case (a security model on a
 * T3 blast-radius project).
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
    // Spec (or stage producer) in a heavy design mode on a T3 / blast-radius project.
    if (mode && OPUS_DESIGN_MODES.has(mode) && (t3 || blast) && agent !== "critic") {
        if (mode === "security" && t3 && blast) {
            return { model: "opus", effort: "max", rationale: `security design on a T3 blast-radius project (${mode}, §2/§15.S)` };
        }
        return {
            model: "opus",
            effort: t3 && blast ? "xhigh" : "high",
            rationale: `heavy design mode "${mode}" on ${t3 ? "T3" : "a blast-radius project"} (§2)`,
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
    // Builder on a slice touching a blast-radius component.
    if (agent === "builder" && (input.componentBlast || blast)) {
        return { model: "opus", effort: "high", rationale: "builder on a blast-radius component (§2)" };
    }
    // Orchestrator & Vertical-Slice default to opus (frontmatter default).
    if (agent && OPUS_DEFAULT_AGENTS.has(agent)) {
        return { model: "opus", effort: t3 || blast ? "high" : "medium", rationale: `${agent} default (opus)` };
    }
    // Default: cheap by default, a notch more effort on T3.
    return { model: "sonnet", effort: t3 ? "high" : "medium", rationale: "default (sonnet)" };
}
