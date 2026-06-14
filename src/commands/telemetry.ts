import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success } from "../core/output";
import {
  readTelemetryConfig,
  writeTelemetryConfig,
  readTelemetryLog,
  telemetryConfigPath,
  telemetryLogPath,
} from "../core/telemetry";

/**
 * `th telemetry on|off|status` — manage the opt-in, LOCAL-ONLY telemetry switch
 * (G7). Turning telemetry on lets read-only views (e.g. `th scorecard`) append a
 * local snapshot to `<stateDir>/telemetry.jsonl`; it NEVER sends anything off the
 * machine. Off (the default) means nothing is ever recorded.
 *
 * Records and computes; never decides. The switch is a plain operator choice,
 * stored next to state.json (not inside it) so the state schema is untouched.
 */

/** `th telemetry on` / `th telemetry off` — write the opt-in switch. */
export function runTelemetrySet(paths: ProjectPaths, mode: "on" | "off"): CommandResult {
  const enabled = mode === "on";
  writeTelemetryConfig(paths, { enabled });
  const human = enabled
    ? `Telemetry enabled (local-only). Snapshots will be appended to ${telemetryLogPath(paths)}. Nothing leaves this machine. Disable with \`th telemetry off\`.`
    : "Telemetry disabled. No run snapshots will be recorded.";
  return success({ data: { enabled, configPath: telemetryConfigPath(paths) }, human });
}

/** `th telemetry status` — report enabled state + recorded snapshot count. */
export function runTelemetryStatus(paths: ProjectPaths): CommandResult {
  const { enabled } = readTelemetryConfig(paths);
  const records = readTelemetryLog(paths).length;
  const human = [
    `Telemetry: ${enabled ? "enabled" : "disabled"} (local-only; never sent off this machine)`,
    `Records:   ${records}`,
    `Config:    ${telemetryConfigPath(paths)}`,
    `Log:       ${telemetryLogPath(paths)}`,
  ].join("\n");
  return success({ data: { enabled, records, configPath: telemetryConfigPath(paths), logPath: telemetryLogPath(paths) }, human });
}
