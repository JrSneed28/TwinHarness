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

/** Read the last verify report, or null when none has been written. */
export function readVerifyReport(paths: ProjectPaths): VerifyReport | null {
  const file = verifyReportPath(paths);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as VerifyReport).ok === "boolean") {
      return parsed as VerifyReport;
    }
  } catch {
    // Corrupt report → treat as absent.
  }
  return null;
}

export function writeVerifyReport(paths: ProjectPaths, report: VerifyReport): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(verifyReportPath(paths), JSON.stringify(report, null, 2) + "\n", "utf8");
}

/**
 * Execute each command in order via the shell, in `root`. Stops nothing — every
 * command runs so the report is complete — but `ok` is false if any fail. A
 * command that cannot be spawned is recorded as a failure (exit 127) rather than
 * throwing. `now` is injectable so callers/tests control the timestamp.
 */
export function runCommands(root: string, commands: string[], now: () => Date = () => new Date()): VerifyReport {
  const results: VerifyResult[] = [];
  for (const command of commands) {
    const start = Date.now();
    const proc = spawnSync(command, {
      cwd: root,
      shell: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const durationMs = Date.now() - start;
    const combined = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
    const outputTail = combined.length > OUTPUT_TAIL_CHARS ? combined.slice(-OUTPUT_TAIL_CHARS) : combined;
    // spawnSync returns status null when the process was killed or failed to spawn.
    const exitCode = proc.status ?? 127;
    results.push({ command, exitCode, ok: exitCode === 0, durationMs, outputTail });
  }
  return {
    ok: results.every((r) => r.ok),
    ranAt: now().toISOString(),
    results,
  };
}
