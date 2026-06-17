/**
 * Project verification config + report (the data layer for `th verify`).
 *
 * `th verify run` is the ONE command that executes configured project test
 * commands. It is deliberately quarantined here, away from every other `th`
 * command, because executing project commands is the single exception to the
 * CLI's "records and computes; never re-runs" boundary (plan §3) — it exists so
 * the run-health view (`th coverage report`, `th doctor`) can reflect whether the
 * suite is actually green, not just whether tests are anchored.
 *
 * Two small JSON files live under the state dir, never inside state.json (so the
 * state schema and its content-hash stability are untouched):
 *   - verify.json        → { commands: string[] }  (the configured commands)
 *   - verify-report.json → the last run's results
 *
 * Security note (see SECURITY.md): the configured commands are run with the
 * shell, in the project root. They are operator-authored, exactly like the
 * scripts a developer would run by hand; `th verify run` never sources commands
 * from untrusted artifact content.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ProjectPaths } from "./paths";
import { atomicWriteFile, readFileWithRetry } from "./atomic-io";

export interface VerifyConfig {
  commands: string[];
}

export interface VerifyResult {
  command: string;
  exitCode: number;
  ok: boolean;
  durationMs: number;
  /** Last ~2000 chars of combined stdout+stderr (for a glanceable failure tail). */
  outputTail: string;
}

export interface VerifyReport {
  ok: boolean;
  ranAt: string;
  results: VerifyResult[];
}

const OUTPUT_TAIL_CHARS = 2000;

/**
 * Per-command wall-clock budget (ms). A configured command that hangs (a watch
 * mode, a server, a process waiting on stdin, a deadlocked test) would otherwise
 * block `th verify run` forever; the timeout kills it and records a failure so
 * the run always terminates. 5 minutes is generous for a real test suite.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

export function verifyConfigPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "verify.json");
}

export function verifyReportPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "verify-report.json");
}

/** Read the configured commands. Missing/invalid file → empty command list. */
export function readVerifyConfig(paths: ProjectPaths): VerifyConfig {
  const file = verifyConfigPath(paths);
  if (!fs.existsSync(file)) return { commands: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as VerifyConfig).commands)) {
      const commands = (parsed as VerifyConfig).commands.filter((c): c is string => typeof c === "string");
      return { commands };
    }
  } catch {
    // Fall through to empty.
  }
  return { commands: [] };
}

export function writeVerifyConfig(paths: ProjectPaths, config: VerifyConfig): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(verifyConfigPath(paths), JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Read the last verify report, or null when none has been written.
 *
 * The read goes through {@link readFileWithRetry} so a transient contention error
 * (a reader colliding with a concurrent atomic rename of the report — see
 * {@link writeVerifyReport}) is retried rather than swallowed as "absent". Without
 * this, a present-but-momentarily-contended report read null and made callers like
 * `th next` re-emit a spurious `run-verify` obligation (the REQ-NEXT-011 flake):
 * a settled run was intermittently judged un-verified. A genuinely missing or
 * corrupt report still returns null — the real staleness signal is unchanged.
 */
export function readVerifyReport(paths: ProjectPaths): VerifyReport | null {
  const file = verifyReportPath(paths);
  if (!fs.existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileWithRetry(file);
  } catch {
    // The file existed a moment ago but the read still failed after the retry
    // budget (e.g. it was removed mid-read) → treat as absent.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as VerifyReport).ok === "boolean") {
      return parsed as VerifyReport;
    }
  } catch {
    // Corrupt report → treat as absent.
  }
  return null;
}

/**
 * Write the verify report atomically (write temp, then rename over the target) so
 * a concurrent {@link readVerifyReport} can never observe a torn/partial file —
 * it sees either the old report or the new one, never a half-written blob. This
 * pairs with the retrying reader to keep a freshly-written report from reading as
 * absent (the REQ-NEXT-011 flake).
 */
export function writeVerifyReport(paths: ProjectPaths, report: VerifyReport): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  atomicWriteFile(verifyReportPath(paths), JSON.stringify(report, null, 2) + "\n");
}

/**
 * Execute each command in order via the shell, in `root`. Stops nothing — every
 * command runs so the report is complete — but `ok` is false if any fail. A
 * command that cannot be spawned is recorded as a failure (exit 127) rather than
 * throwing. Each command is bounded by `timeoutMs` (default
 * {@link DEFAULT_COMMAND_TIMEOUT_MS}): a process that exceeds it is killed and
 * recorded as a failure, so a hanging command can never block the run forever.
 * stdin is closed (`input: ""`) so a command that reads stdin gets EOF instead of
 * blocking. `now` is injectable so callers/tests control the timestamp.
 */
export function runCommands(
  root: string,
  commands: string[],
  now: () => Date = () => new Date(),
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): VerifyReport {
  const results: VerifyResult[] = [];
  for (const command of commands) {
    const start = Date.now();
    const proc = spawnSync(command, {
      cwd: root,
      shell: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      input: "",
    });
    const durationMs = Date.now() - start;
    // A timeout kill surfaces as proc.error with code ETIMEDOUT and a null status.
    const timedOut = (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const combined = `${proc.stdout ?? ""}${proc.stderr ?? ""}${timedOut ? `\n[th verify] command killed after ${timeoutMs}ms timeout` : ""}`;
    const outputTail = combined.length > OUTPUT_TAIL_CHARS ? combined.slice(-OUTPUT_TAIL_CHARS) : combined;
    // spawnSync returns status null when the process was killed or failed to spawn.
    const exitCode = proc.status ?? 124; // 124 = conventional timeout/kill exit code
    results.push({ command, exitCode, ok: proc.status === 0, durationMs, outputTail });
  }
  return {
    ok: results.every((r) => r.ok),
    ranAt: now().toISOString(),
    results,
  };
}
