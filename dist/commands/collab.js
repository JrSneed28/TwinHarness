"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCollabInit = runCollabInit;
exports.runCollabFragment = runCollabFragment;
exports.runCollabList = runCollabList;
exports.runCollabMerge = runCollabMerge;
const output_1 = require("../core/output");
const collab_1 = require("../core/collab");
const log_1 = require("../core/log");
/**
 * `th collab init --stage <stage>` — report the resolved collab directory for a
 * stage. Path construction only (dirs are created on the first fragment write),
 * so callers can confirm where fragments will land without side effects.
 */
function runCollabInit(paths, opts) {
    if (!opts.stage) {
        return (0, output_1.failure)({
            human: "usage: th collab init --stage <stage>",
            data: { error: "missing_stage" },
        });
    }
    const dir = (0, collab_1.collabDir)(paths, opts.stage);
    (0, log_1.structuredLog)({ cmd: "collab init", stage: opts.stage });
    return (0, output_1.success)({
        data: { stage: opts.stage, dir },
        human: `collab stage '${opts.stage}' → ${dir}`,
    });
}
/**
 * `th collab fragment --stage <stage> --round <round> --name <name> --text <text>`
 * Drop a fragment file into the round, creating the round directory on demand.
 * Returns the absolute path written.
 */
function runCollabFragment(paths, opts) {
    if (!opts.stage || !opts.round || !opts.name) {
        return (0, output_1.failure)({
            human: "usage: th collab fragment --stage <stage> --round <round> --name <name> [--text <text>] [--force]",
            data: { error: "missing_args" },
        });
    }
    // writeFragment throws a FragmentExistsError on a collision (existing fragment,
    // no --force) — convert ONLY that to a structured failure. Path-validation errors
    // (absolute / ".." / separator segments) are a distinct, security-relevant failure
    // mode and must keep propagating as throws (preserved behavior), so they are
    // re-thrown rather than mislabeled as a collision.
    let file;
    try {
        file = (0, collab_1.writeFragment)(paths, {
            stage: opts.stage,
            round: opts.round,
            name: opts.name,
            content: opts.text ?? "",
            force: opts.force ?? false,
        });
    }
    catch (e) {
        if (!(e instanceof collab_1.FragmentExistsError))
            throw e;
        (0, log_1.structuredLog)({ cmd: "collab fragment", stage: opts.stage, round: opts.round, name: opts.name, error: "fragment_exists" });
        return (0, output_1.failure)({
            human: e.message,
            data: { error: "fragment_exists", stage: opts.stage, round: opts.round, name: opts.name },
        });
    }
    (0, log_1.structuredLog)({ cmd: "collab fragment", stage: opts.stage, round: opts.round, name: opts.name, force: opts.force === true });
    return (0, output_1.success)({
        data: { stage: opts.stage, round: opts.round, name: opts.name, path: file },
        human: `fragment written: ${file}`,
    });
}
/**
 * `th collab list --stage <stage> [--round <round>]` — list fragment descriptors
 * for a stage (optionally scoped to one round) in deterministic sorted order.
 */
function runCollabList(paths, opts) {
    if (!opts.stage) {
        return (0, output_1.failure)({
            human: "usage: th collab list --stage <stage> [--round <round>]",
            data: { error: "missing_stage" },
        });
    }
    const fragments = (0, collab_1.listFragments)(paths, opts.stage, opts.round);
    const human = fragments.length
        ? fragments.map((f) => `${f.round}/${f.name}`).join("\n")
        : "(no fragments)";
    (0, log_1.structuredLog)({ cmd: "collab list", stage: opts.stage, round: opts.round, count: fragments.length });
    return (0, output_1.success)({ data: { stage: opts.stage, round: opts.round, fragments }, human });
}
/**
 * `th collab merge --stage <stage> --round <round>` — reconcile a round by
 * concatenating its fragments in deterministic order. Surfaces the anchor
 * validation failure as `ok:false` with the missing fragment names in `data`
 * (traceability §17: every fragment must carry ≥1 REQ-ID anchor). Idempotent.
 */
function runCollabMerge(paths, opts) {
    if (!opts.stage || !opts.round) {
        return (0, output_1.failure)({
            human: "usage: th collab merge --stage <stage> --round <round>",
            data: { error: "missing_args" },
        });
    }
    const result = (0, collab_1.mergeFragments)(paths, opts.stage, opts.round);
    if (!result.ok) {
        (0, log_1.structuredLog)({
            cmd: "collab merge",
            stage: opts.stage,
            round: opts.round,
            ok: false,
            unanchored: result.unanchored,
        });
        return (0, output_1.failure)({
            human: `merge rejected: fragments missing a REQ-ID anchor: ${result.unanchored.join(", ")}`,
            data: { error: "unanchored_fragments", stage: opts.stage, round: opts.round, unanchored: result.unanchored },
        });
    }
    (0, log_1.structuredLog)({
        cmd: "collab merge",
        stage: opts.stage,
        round: opts.round,
        ok: true,
        count: result.fragments.length,
    });
    return (0, output_1.success)({
        data: {
            stage: opts.stage,
            round: opts.round,
            merged: result.merged,
            fragments: result.fragments,
        },
        human: result.merged,
    });
}
