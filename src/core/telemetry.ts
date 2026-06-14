/**
 * Opt-in, LOCAL-ONLY run telemetry (G7).
 *
 * This module records nothing unless the operator explicitly enables it
 * (`th telemetry on`) and it NEVER leaves the machine: there is no network call
 * anywhere in this file or its callers. It exists so a team that wants a local
 * history of run health (e.g. how coverage/drift trended across `th scorecard`
 * snapshots) can keep one, without TwinHarness ever phoning home.
 *
 * Two files live under the state dir, alongside the verify.json/report.json pair
 * (and, like them, never inside state.json so the state schema and its
 * content-hash stability are untouched):
 *   - telemetry.json   → { "enabled": boolean }   (the opt-in switch)
 *   - telemetry.jsonl  → append-only log, one JSON object per line
 *
 * Boundary (plan §3): this is a pure data layer. It writes config and appends
 * log lines; it NEVER reads project commands, never executes anything, and never
 * opens a socket. `appendTelemetry` is a no-op while telemetry is disabled, so a
 * caller can unconditionally offer a snapshot and the switch decides.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";

export interface TelemetryConfig {
  enabled: boolean;
}

/** `<stateDir>/telemetry.json` — the opt-in switch. */
export function telemetryConfigPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "telemetry.json");
}

/** `<stateDir>/telemetry.jsonl` — the append-only local log. */
export function telemetryLogPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "telemetry.jsonl");
}

/**
 * Read the opt-in config. A missing file (or any malformed/partial content)
 * reads as DISABLED — telemetry is off until the operator turns it on, and a
 * corrupt switch must never accidentally start recording.
 */
export function readTelemetryConfig(paths: ProjectPaths): TelemetryConfig {
  const file = telemetryConfigPath(paths);
  if (!fs.existsSync(file)) return { enabled: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as TelemetryConfig).enabled === "boolean") {
      return { enabled: (parsed as TelemetryConfig).enabled };
    }
  } catch {
    // Fall through to disabled.
  }
  return { enabled: false };
}

/**
 * Write the opt-in config atomically (write temp, then rename over the target),
 * mirroring the state-store's durable-write pattern so a crashed/partial write
 * is never observed as a half-flipped switch.
 */
export function writeTelemetryConfig(paths: ProjectPaths, cfg: TelemetryConfig): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const serialized = JSON.stringify({ enabled: cfg.enabled }, null, 2) + "\n";
  const tmp = path.join(paths.stateDir, `telemetry.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, serialized, "utf8");
  fs.renameSync(tmp, telemetryConfigPath(paths));
}

/**
 * Append one record (as a single JSON line) to the local log — but ONLY when
 * telemetry is enabled. While disabled this is a complete no-op: nothing is read
 * from the network and nothing is written to disk. Best-effort like the audit
 * ledger: a logging failure must never crash the command that offered the
 * snapshot.
 */
export function appendTelemetry(paths: ProjectPaths, record: object): void {
  if (!readTelemetryConfig(paths).enabled) return;
  try {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.appendFileSync(telemetryLogPath(paths), JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Never throw from the (opt-in, local) telemetry path.
  }
}

/** Read + parse every log record. Missing file → empty. Malformed lines skipped. */
export function readTelemetryLog(paths: ProjectPaths): object[] {
  const file = telemetryLogPath(paths);
  if (!fs.existsSync(file)) return [];
  const out: object[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null) out.push(parsed as object);
    } catch {
      // Skip malformed lines; the log is append-only and tolerant.
    }
  }
  return out;
}
