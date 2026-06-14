"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPreview = runPreview;
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const stages_1 = require("../core/stages");
function toPreviewStage(c) {
    return { stage: c.stage, produces: c.produces, criticMode: c.criticMode, humanGate: c.humanGate, summary: c.summary };
}
function runPreview(paths, opts) {
    // Resolve tier: explicit flag → recorded state → T2 default.
    let tier = opts.tier?.trim() || undefined;
    let source;
    if (tier) {
        source = "flag";
    }
    else {
        const recorded = (0, state_store_1.readState)(paths).state?.tier ?? null;
        if (recorded) {
            tier = recorded;
            source = "state";
        }
        else {
            tier = "T2";
            source = "default";
        }
    }
    const stages = (0, stages_1.engagedStages)(tier).map(toPreviewStage);
    const humanGates = stages.filter((s) => s.humanGate).length;
    const criticReviews = stages.filter((s) => s.criticMode.length > 0).length;
    const summary = `${tier}: ${stages.length} stages, ${humanGates} human gates, ${criticReviews} Critic reviews`;
    // T0 (or an unknown tier) engages nothing — say so plainly.
    if (stages.length === 0) {
        const note = tier === "T0"
            ? "Tier 0 bypasses the engaged pipeline — no stages, no gates, no Critic reviews."
            : `Tier "${tier}" engages no pipeline stages.`;
        const humanLines = [summary, note];
        if (source === "default")
            humanLines.push("(no tier resolved — defaulted to T2 then noted this tier engages nothing)");
        return (0, output_1.success)({
            data: { tier, tierSource: source, stages, humanGates, criticReviews, summary },
            human: humanLines.join("\n"),
        });
    }
    const rows = stages.map((s, i) => {
        const gate = s.humanGate ? "[gate]" : "      ";
        return `${String(i + 1).padStart(2)}. ${s.stage.padEnd(22)} ${gate} critic:${s.criticMode.padEnd(20)} ${s.produces || "(no artifact)"}`;
    });
    const header = [summary];
    if (source === "default")
        header.push("(no tier specified or recorded — showing the default T2 pipeline; pass --tier T<n> to change)");
    const human = [...header, "", ...rows].join("\n");
    return (0, output_1.success)({
        data: { tier, tierSource: source, stages, humanGates, criticReviews, summary },
        human,
    });
}
