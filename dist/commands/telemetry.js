"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runTelemetrySet = runTelemetrySet;
exports.runTelemetryStatus = runTelemetryStatus;
const output_1 = require("../core/output");
const telemetry_1 = require("../core/telemetry");
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
function runTelemetrySet(paths, mode) {
    const enabled = mode === "on";
    (0, telemetry_1.writeTelemetryConfig)(paths, { enabled });
    const human = enabled
        ? `Telemetry enabled (local-only). Snapshots will be appended to ${(0, telemetry_1.telemetryLogPath)(paths)}. Nothing leaves this machine. Disable with \`th telemetry off\`.`
        : "Telemetry disabled. No run snapshots will be recorded.";
    return (0, output_1.success)({ data: { enabled, configPath: (0, telemetry_1.telemetryConfigPath)(paths) }, human });
}
/** `th telemetry status` — report enabled state + recorded snapshot count. */
function runTelemetryStatus(paths) {
    const { enabled } = (0, telemetry_1.readTelemetryConfig)(paths);
    const records = (0, telemetry_1.readTelemetryLog)(paths).length;
    const human = [
        `Telemetry: ${enabled ? "enabled" : "disabled"} (local-only; never sent off this machine)`,
        `Records:   ${records}`,
        `Config:    ${(0, telemetry_1.telemetryConfigPath)(paths)}`,
        `Log:       ${(0, telemetry_1.telemetryLogPath)(paths)}`,
    ].join("\n");
    return (0, output_1.success)({ data: { enabled, records, configPath: (0, telemetry_1.telemetryConfigPath)(paths), logPath: (0, telemetry_1.telemetryLogPath)(paths) }, human });
}
