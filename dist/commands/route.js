"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runRoute = runRoute;
const paths_1 = require("../core/paths");
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const brief_1 = require("../core/brief");
const routing_1 = require("../core/routing");
const telemetry_1 = require("../core/telemetry");
const log_1 = require("../core/log");
function runRoute(paths, opts) {
    let tier = opts.tier ?? null;
    let blastFlags = [];
    let mode = opts.mode;
    // Default tier / blast flags / mode from the live run when present (advisory:
    // routing works even before a run exists — it just falls back to defaults).
    const r = (0, state_store_1.readState)(paths);
    if (r.state) {
        if (!opts.tier)
            tier = r.state.tier;
        blastFlags = [...r.state.blast_radius_flags];
        if (!mode)
            mode = r.state.current_stage;
    }
    // `--brief` overrides blast flags (e.g. at tier time, before state records them).
    if (opts.brief) {
        const briefFile = (0, paths_1.resolveWithinRoot)(paths.root, opts.brief);
        if (briefFile === null) {
            return (0, output_1.failure)({
                human: `Brief path outside project root: ${opts.brief}`,
                data: { error: "path_outside_root", file: opts.brief },
            });
        }
        const loaded = (0, brief_1.loadBriefFromFile)(briefFile);
        if (!loaded.ok || !loaded.brief) {
            return (0, output_1.failure)({
                human: `Could not load brief "${opts.brief}".`,
                data: { error: "invalid_brief", issues: loaded.issues },
            });
        }
        blastFlags = [...loaded.brief.blast_radius_flags];
    }
    const decision = (0, routing_1.computeRoute)({
        agent: opts.agent,
        mode,
        tier,
        blastFlags,
        componentBlast: opts.componentBlast,
        summarization: opts.summarization,
    });
    (0, telemetry_1.appendTelemetry)(paths, {
        ts: new Date().toISOString(),
        event: "route",
        agent: opts.agent ?? null,
        mode: mode ?? null,
        tier,
        blastFlags,
        model: decision.model,
        effort: decision.effort,
    });
    (0, log_1.structuredLog)({ cmd: "route", agent: opts.agent, mode, model: decision.model, effort: decision.effort });
    return (0, output_1.success)({
        data: { model: decision.model, effort: decision.effort, rationale: decision.rationale },
        human: `${decision.model} / ${decision.effort} — ${decision.rationale}`,
    });
}
