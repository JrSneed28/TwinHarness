import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import {
  readVerifyConfig,
  writeVerifyConfig,
  writeVerifyReport,
  runCommands,
  type VerifyReport,
} from "../core/verify";
import { structuredLog } from "../core/log";

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
export function runVerifyAdd(paths: ProjectPaths, command?: string): CommandResult {
  const trimmed = command?.trim();
  if (!trimmed) return failure({ human: 'usage: th verify add "<command>"' });
  const config = readVerifyConfig(paths);
  config.commands.push(trimmed);
  writeVerifyConfig(paths, config);
  structuredLog({ cmd: "verify add", command: trimmed, count: config.commands.length });
  return success({
    data: { commands: config.commands },
    human: `added: ${trimmed}\n${config.commands.length} command(s) configured.`,
  });
}

/** `th verify list` — show configured commands. */
export function runVerifyList(paths: ProjectPaths): CommandResult {
  const config = readVerifyConfig(paths);
  const human = config.commands.length
    ? config.commands.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
    : "(no verify commands configured — add one with `th verify add \"<command>\"`)";
  return success({ data: { commands: config.commands }, human });
}

/** `th verify clear` — remove all configured commands. */
export function runVerifyClear(paths: ProjectPaths): CommandResult {
  writeVerifyConfig(paths, { commands: [] });
  structuredLog({ cmd: "verify clear" });
  return success({ data: { commands: [] }, human: "verify commands cleared." });
}

function renderReport(report: VerifyReport): string {
  const lines = report.results.map((r) => `  ${r.ok ? "✓" : "✗"} (${r.exitCode}) ${r.command}  [${r.durationMs}ms]`);
  const failed = report.results.filter((r) => !r.ok);
  const tail = failed.length
    ? ["", "First failure output (tail):", ...failed[0]!.outputTail.split(/\r?\n/).map((l) => `    ${l}`)]
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
export function runVerifyRun(paths: ProjectPaths): CommandResult {
  const config = readVerifyConfig(paths);
  if (config.commands.length === 0) {
    return failure({
      human: 'No verify commands configured. Add one with `th verify add "<command>"` (e.g. `th verify add "npm test"`).',
      data: { error: "no_verify_commands" },
    });
  }

  const report = runCommands(paths.root, config.commands);
  writeVerifyReport(paths, report);
  structuredLog({ cmd: "verify run", ok: report.ok, commands: report.results.length });

  const data = { ok: report.ok, ranAt: report.ranAt, results: report.results };
  return report.ok
    ? success({ data, human: renderReport(report) })
    : failure({ data, human: renderReport(report) });
}
