"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runVerifyAdd = runVerifyAdd;
exports.runVerifyList = runVerifyList;
exports.runVerifyClear = runVerifyClear;
exports.runVerifyApprove = runVerifyApprove;
exports.runVerifyRun = runVerifyRun;
const output_1 = require("../core/output");
const verify_1 = require("../core/verify");
const log_1 = require("../core/log");
/**
 * `th verify` — configure and run the project's own test/check commands.
 *
 * This is the deliberate single exception to the CLI's no-execution boundary
 * (see core/verify.ts). It records a list of operator-authored commands and runs
 * them on demand, writing a report the run-health views consume. It still does
 * NOT decide anything: the orchestrator decides when to verify; this command
 * runs what it is told and records the result.
 *
 *   th verify add <command>   Append a command to the verify list
 *   th verify list            Show the configured commands
 *   th verify clear           Remove all configured commands
 *   th verify approve         Human-confirm the current command set for execution
 *   th verify run             Execute every configured command; exit 1 on any failure
 *
 * Phase 6 hardening (#19): every `add` records provenance (actor + timestamp); the
 * command SET must be human-approved (hash-pinned) before its first execution, so
 * a new/changed set cannot run until `th verify approve` confirms it; `run`
 * supports `--read-only` to refuse repo-mutating commands on untrusted projects.
 */
/** Resolve the actor attribution for a verify mutation (provenance, #19, P6-2). */
function resolveVerifyActor(explicit) {
    return (explicit ?? process.env.TH_VERIFY_ACTOR ?? "unknown").trim() || "unknown";
}
/** `th verify add "<command>"` — append a command to verify.json (with provenance). */
function runVerifyAdd(paths, command, opts = {}) {
    const trimmed = command?.trim();
    if (!trimmed)
        return (0, output_1.failure)({ human: 'usage: th verify add "<command>"' });
    const config = (0, verify_1.readVerifyConfig)(paths);
    config.commands.push(trimmed);
    // Record provenance (#19, P6-2): who added this command, and when.
    const actor = resolveVerifyActor(opts.as);
    const addedAt = (opts.now ?? (() => new Date()))().toISOString();
    config.provenance = [...(config.provenance ?? []), { command: trimmed, actor, addedAt }];
    // Adding a command CHANGES the set: the prior approval (if any) no longer covers
    // it, so the set is now unapproved until `th verify approve` re-confirms it.
    // (isCommandSetApproved compares against approvedHash; leaving a stale hash here
    // means it simply won't match the new set — but we clear it for an honest read.)
    if (config.approvedHash !== (0, verify_1.commandSetHash)(config.commands)) {
        delete config.approvedHash;
        delete config.approvedBy;
        delete config.approvedAt;
    }
    (0, verify_1.writeVerifyConfig)(paths, config);
    (0, log_1.structuredLog)({ cmd: "verify add", command: trimmed, actor, count: config.commands.length });
    return (0, output_1.success)({
        data: { commands: config.commands, provenance: config.provenance, approved: (0, verify_1.isCommandSetApproved)(config) },
        human: `added: ${trimmed} (by ${actor})\n${config.commands.length} command(s) configured.\n` +
            `This command set is UNAPPROVED for execution — run \`th verify approve\` to confirm it before \`th verify run\`.`,
    });
}
/** `th verify list` — show configured commands (with provenance + approval status). */
function runVerifyList(paths) {
    const config = (0, verify_1.readVerifyConfig)(paths);
    const provByCommand = new Map((config.provenance ?? []).map((p) => [p.command, p]));
    const human = config.commands.length
        ? config.commands
            .map((c, i) => {
            const p = provByCommand.get(c);
            const prov = p ? `  (added by ${p.actor} at ${p.addedAt})` : "";
            return `  ${i + 1}. ${c}${prov}`;
        })
            .join("\n") +
            "\n" +
            ((0, verify_1.isCommandSetApproved)(config)
                ? `\nSet APPROVED for execution${config.approvedBy ? ` (by ${config.approvedBy} at ${config.approvedAt})` : ""}.`
                : "\nSet UNAPPROVED — run `th verify approve` before `th verify run`.")
        : "(no verify commands configured — add one with `th verify add \"<command>\"`)";
    return (0, output_1.success)({
        data: {
            commands: config.commands,
            provenance: config.provenance ?? [],
            approved: (0, verify_1.isCommandSetApproved)(config),
        },
        human,
    });
}
/** `th verify clear` — remove all configured commands (and any approval). */
function runVerifyClear(paths) {
    (0, verify_1.writeVerifyConfig)(paths, { commands: [] });
    (0, log_1.structuredLog)({ cmd: "verify clear" });
    return (0, output_1.success)({ data: { commands: [] }, human: "verify commands cleared." });
}
/**
 * `th verify approve` — human-confirm the CURRENT command set for execution
 * (#19, P6-2). Pins the set hash so a later add/change re-requires confirmation.
 * Attribution comes from `--as` / TH_VERIFY_ACTOR. With no commands configured
 * there is nothing to approve.
 */
function runVerifyApprove(paths, opts = {}) {
    const config = (0, verify_1.readVerifyConfig)(paths);
    if (config.commands.length === 0) {
        return (0, output_1.failure)({
            human: "No verify commands configured — nothing to approve. Add one with `th verify add \"<command>\"`.",
            data: { error: "no_verify_commands" },
        });
    }
    const actor = resolveVerifyActor(opts.as);
    const approvedAt = (opts.now ?? (() => new Date()))().toISOString();
    const hash = (0, verify_1.commandSetHash)(config.commands);
    const next = { ...config, approvedHash: hash, approvedBy: actor, approvedAt };
    (0, verify_1.writeVerifyConfig)(paths, next);
    (0, log_1.structuredLog)({ cmd: "verify approve", actor, commands: config.commands.length, hash });
    return (0, output_1.success)({
        data: { approved: true, approvedHash: hash, approvedBy: actor, commands: config.commands },
        human: `Approved ${config.commands.length} verify command(s) for execution (by ${actor}). \`th verify run\` may now execute this set.`,
    });
}
function renderReport(report) {
    const lines = report.results.map((r) => `  ${r.ok ? "✓" : "✗"} (${r.exitCode}) ${r.command}  [${r.durationMs}ms]`);
    const failed = report.results.filter((r) => !r.ok);
    const tail = failed.length
        ? ["", "First failure output (tail):", ...failed[0].outputTail.split(/\r?\n/).map((l) => `    ${l}`)]
        : [];
    return [
        report.ok ? `verify PASS — ${report.results.length} command(s) green` : `verify FAIL — ${failed.length}/${report.results.length} command(s) failed`,
        ...lines,
        ...tail,
    ].join("\n");
}
/**
 * `th verify run` — execute every configured command in order, write the report,
 * and exit non-zero if any command failed. With no commands configured it is a
 * usage failure (nothing to verify).
 *
 * Phase 6 (#19): refuses to run an UNAPPROVED command set (P6-2) — a new/changed
 * set must be confirmed via `th verify approve` first; passes a curated env and
 * redacts secrets from the report (P6-3, in core/verify); and supports
 * `--read-only` (P6-5) to refuse repo-mutating commands on untrusted projects.
 */
function runVerifyRun(paths, opts = {}) {
    const config = (0, verify_1.readVerifyConfig)(paths);
    if (config.commands.length === 0) {
        return (0, output_1.failure)({
            human: 'No verify commands configured. Add one with `th verify add "<command>"` (e.g. `th verify add "npm test"`).',
            data: { error: "no_verify_commands" },
        });
    }
    // P6-2: a new/changed command set must be human-confirmed before its first run.
    if (!(0, verify_1.isCommandSetApproved)(config)) {
        return (0, output_1.failure)({
            human: "This verify command set is UNAPPROVED for execution. A new or changed command set must be human-confirmed " +
                "before the first run (defense against an injected/changed command running silently). " +
                "Review it with `th verify list`, then run `th verify approve` to confirm, then `th verify run`.",
            data: { error: "unapproved_command_set", commandHash: (0, verify_1.commandSetHash)(config.commands) },
        });
    }
    const report = (0, verify_1.runCommands)(paths.root, config.commands, { readOnly: opts.readOnly });
    (0, verify_1.writeVerifyReport)(paths, report);
    (0, log_1.structuredLog)({ cmd: "verify run", ok: report.ok, commands: report.results.length, readOnly: Boolean(opts.readOnly) });
    const data = { ok: report.ok, ranAt: report.ranAt, results: report.results };
    return report.ok
        ? (0, output_1.success)({ data, human: renderReport(report) })
        : (0, output_1.failure)({ data, human: renderReport(report) });
}
