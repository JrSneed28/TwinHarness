"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runVerifyAdd = runVerifyAdd;
exports.runVerifyList = runVerifyList;
exports.runVerifyClear = runVerifyClear;
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
 *   th verify run             Execute every configured command; exit 1 on any failure
 */
/** `th verify add "<command>"` — append a command to verify.json. */
function runVerifyAdd(paths, command) {
    const trimmed = command?.trim();
    if (!trimmed)
        return (0, output_1.failure)({ human: 'usage: th verify add "<command>"' });
    const config = (0, verify_1.readVerifyConfig)(paths);
    config.commands.push(trimmed);
    (0, verify_1.writeVerifyConfig)(paths, config);
    (0, log_1.structuredLog)({ cmd: "verify add", command: trimmed, count: config.commands.length });
    return (0, output_1.success)({
        data: { commands: config.commands },
        human: `added: ${trimmed}\n${config.commands.length} command(s) configured.`,
    });
}
/** `th verify list` — show configured commands. */
function runVerifyList(paths) {
    const config = (0, verify_1.readVerifyConfig)(paths);
    const human = config.commands.length
        ? config.commands.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
        : "(no verify commands configured — add one with `th verify add \"<command>\"`)";
    return (0, output_1.success)({ data: { commands: config.commands }, human });
}
/** `th verify clear` — remove all configured commands. */
function runVerifyClear(paths) {
    (0, verify_1.writeVerifyConfig)(paths, { commands: [] });
    (0, log_1.structuredLog)({ cmd: "verify clear" });
    return (0, output_1.success)({ data: { commands: [] }, human: "verify commands cleared." });
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
 */
function runVerifyRun(paths) {
    const config = (0, verify_1.readVerifyConfig)(paths);
    if (config.commands.length === 0) {
        return (0, output_1.failure)({
            human: 'No verify commands configured. Add one with `th verify add "<command>"` (e.g. `th verify add "npm test"`).',
            data: { error: "no_verify_commands" },
        });
    }
    const report = (0, verify_1.runCommands)(paths.root, config.commands);
    (0, verify_1.writeVerifyReport)(paths, report);
    (0, log_1.structuredLog)({ cmd: "verify run", ok: report.ok, commands: report.results.length });
    const data = { ok: report.ok, ranAt: report.ranAt, results: report.results };
    return report.ok
        ? (0, output_1.success)({ data, human: renderReport(report) })
        : (0, output_1.failure)({ data, human: renderReport(report) });
}
