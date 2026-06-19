import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import {
  readVerifyConfig,
  writeVerifyConfig,
  writeVerifyReport,
  runCommands,
  commandSetHash,
  isCommandSetApproved,
  type VerifyReport,
  type VerifyConfig,
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
 *   th verify approve         Human-confirm the current command set for execution
 *   th verify run             Execute every configured command; exit 1 on any failure
 *
 * Phase 6 hardening (#19): every `add` records provenance (actor + timestamp); the
 * command SET must be human-approved (hash-pinned) before its first execution, so
 * a new/changed set cannot run until `th verify approve` confirms it; `run`
 * supports `--read-only` to refuse repo-mutating commands on untrusted projects.
 */

/** Resolve the actor attribution for a verify mutation (provenance, #19, P6-2). */
function resolveVerifyActor(explicit?: string): string {
  return (explicit ?? process.env.TH_VERIFY_ACTOR ?? "unknown").trim() || "unknown";
}

export interface VerifyAddOptions {
  /** Explicit actor attribution; falls back to TH_VERIFY_ACTOR, then "unknown". */
  as?: string;
  /** Injectable clock for deterministic provenance timestamps (REQ-NFR-002). */
  now?: () => Date;
}

/** `th verify add "<command>"` — append a command to verify.json (with provenance). */
export function runVerifyAdd(paths: ProjectPaths, command?: string, opts: VerifyAddOptions = {}): CommandResult {
  const trimmed = command?.trim();
  if (!trimmed) return failure({ human: 'usage: th verify add "<command>"' });
  const config = readVerifyConfig(paths);
  config.commands.push(trimmed);

  // Record provenance (#19, P6-2): who added this command, and when.
  const actor = resolveVerifyActor(opts.as);
  const addedAt = (opts.now ?? (() => new Date()))().toISOString();
  config.provenance = [...(config.provenance ?? []), { command: trimmed, actor, addedAt }];

  // Adding a command CHANGES the set: the prior approval (if any) no longer covers
  // it, so the set is now unapproved until `th verify approve` re-confirms it.
  // (isCommandSetApproved compares against approvedHash; leaving a stale hash here
  // means it simply won't match the new set — but we clear it for an honest read.)
  if (config.approvedHash !== commandSetHash(config.commands)) {
    delete config.approvedHash;
    delete config.approvedBy;
    delete config.approvedAt;
  }

  writeVerifyConfig(paths, config);
  structuredLog({ cmd: "verify add", command: trimmed, actor, count: config.commands.length });
  return success({
    data: { commands: config.commands, provenance: config.provenance, approved: isCommandSetApproved(config) },
    human:
      `added: ${trimmed} (by ${actor})\n${config.commands.length} command(s) configured.\n` +
      `This command set is UNAPPROVED for execution — run \`th verify approve\` to confirm it before \`th verify run\`.`,
  });
}

/** `th verify list` — show configured commands (with provenance + approval status). */
export function runVerifyList(paths: ProjectPaths): CommandResult {
  const config = readVerifyConfig(paths);
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
      (isCommandSetApproved(config)
        ? `\nSet APPROVED for execution${config.approvedBy ? ` (by ${config.approvedBy} at ${config.approvedAt})` : ""}.`
        : "\nSet UNAPPROVED — run `th verify approve` before `th verify run`.")
    : "(no verify commands configured — add one with `th verify add \"<command>\"`)";
  return success({
    data: {
      commands: config.commands,
      provenance: config.provenance ?? [],
      approved: isCommandSetApproved(config),
    },
    human,
  });
}

/** `th verify clear` — remove all configured commands (and any approval). */
export function runVerifyClear(paths: ProjectPaths): CommandResult {
  writeVerifyConfig(paths, { commands: [] });
  structuredLog({ cmd: "verify clear" });
  return success({ data: { commands: [] }, human: "verify commands cleared." });
}

export interface VerifyApproveOptions {
  as?: string;
  now?: () => Date;
}

/**
 * `th verify approve` — human-confirm the CURRENT command set for execution
 * (#19, P6-2). Pins the set hash so a later add/change re-requires confirmation.
 * Attribution comes from `--as` / TH_VERIFY_ACTOR. With no commands configured
 * there is nothing to approve.
 */
export function runVerifyApprove(paths: ProjectPaths, opts: VerifyApproveOptions = {}): CommandResult {
  const config = readVerifyConfig(paths);
  if (config.commands.length === 0) {
    return failure({
      human: "No verify commands configured — nothing to approve. Add one with `th verify add \"<command>\"`.",
      data: { error: "no_verify_commands" },
    });
  }
  const actor = resolveVerifyActor(opts.as);
  const approvedAt = (opts.now ?? (() => new Date()))().toISOString();
  const hash = commandSetHash(config.commands);
  const next: VerifyConfig = { ...config, approvedHash: hash, approvedBy: actor, approvedAt };
  writeVerifyConfig(paths, next);
  structuredLog({ cmd: "verify approve", actor, commands: config.commands.length, hash });
  return success({
    data: { approved: true, approvedHash: hash, approvedBy: actor, commands: config.commands },
    human: `Approved ${config.commands.length} verify command(s) for execution (by ${actor}). \`th verify run\` may now execute this set.`,
  });
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

export interface VerifyRunOptions {
  /** Refuse to execute repo-mutating commands (#19, P6-5). */
  readOnly?: boolean;
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
export function runVerifyRun(paths: ProjectPaths, opts: VerifyRunOptions = {}): CommandResult {
  const config = readVerifyConfig(paths);
  if (config.commands.length === 0) {
    return failure({
      human: 'No verify commands configured. Add one with `th verify add "<command>"` (e.g. `th verify add "npm test"`).',
      data: { error: "no_verify_commands" },
    });
  }

  // P6-2: a new/changed command set must be human-confirmed before its first run.
  if (!isCommandSetApproved(config)) {
    return failure({
      human:
        "This verify command set is UNAPPROVED for execution. A new or changed command set must be human-confirmed " +
        "before the first run (defense against an injected/changed command running silently). " +
        "Review it with `th verify list`, then run `th verify approve` to confirm, then `th verify run`.",
      data: { error: "unapproved_command_set", commandHash: commandSetHash(config.commands) },
    });
  }

  const report = runCommands(paths.root, config.commands, { readOnly: opts.readOnly });
  writeVerifyReport(paths, report);
  structuredLog({ cmd: "verify run", ok: report.ok, commands: report.results.length, readOnly: Boolean(opts.readOnly) });

  const data = { ok: report.ok, ranAt: report.ranAt, results: report.results };
  return report.ok
    ? success({ data, human: renderReport(report) })
    : failure({ data, human: renderReport(report) });
}
