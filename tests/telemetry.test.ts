/**
 * Opt-in, LOCAL-ONLY telemetry (G7) — REQ-anchored.
 *
 * Verifies the privacy default (off ⇒ append is a complete no-op), that turning
 * it on makes `appendTelemetry` write exactly one JSON line per record, that the
 * config write lands at the right place (never inside state.json), and that
 * `th telemetry status` reports the enabled flag + record count.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import {
  readTelemetryConfig,
  writeTelemetryConfig,
  appendTelemetry,
  readTelemetryLog,
  telemetryConfigPath,
  telemetryLogPath,
} from "../src/core/telemetry";
import { runTelemetrySet, runTelemetryStatus } from "../src/commands/telemetry";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-TELEMETRY-001: opt-in switch defaults off and toggles", () => {
  it("a missing config reads as disabled", () => {
    tp = makeTempProject();
    expect(readTelemetryConfig(tp.paths).enabled).toBe(false);
  });

  it("a corrupt config reads as disabled (fail-closed)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    fs.writeFileSync(telemetryConfigPath(tp.paths), "{ not json", "utf8");
    expect(readTelemetryConfig(tp.paths).enabled).toBe(false);
  });

  it("`th telemetry on` enables; `off` disables — stored outside state.json", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const before = fs.readFileSync(tp.paths.stateFile, "utf8");

    expect(runTelemetrySet(tp.paths, "on").data?.enabled).toBe(true);
    expect(readTelemetryConfig(tp.paths).enabled).toBe(true);

    expect(runTelemetrySet(tp.paths, "off").data?.enabled).toBe(false);
    expect(readTelemetryConfig(tp.paths).enabled).toBe(false);

    // The switch never touches state.json (schema-stability invariant).
    expect(fs.readFileSync(tp.paths.stateFile, "utf8")).toBe(before);
  });
});

describe("REQ-TELEMETRY-002: append respects the switch", () => {
  it("on → appendTelemetry writes exactly one JSON line per record", () => {
    tp = makeTempProject();
    writeTelemetryConfig(tp.paths, { enabled: true });

    appendTelemetry(tp.paths, { event: "scorecard", coverage: 3 });
    appendTelemetry(tp.paths, { event: "scorecard", coverage: 5 });

    const lines = fs.readFileSync(telemetryLogPath(tp.paths), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const records = readTelemetryLog(tp.paths) as { event: string; coverage: number }[];
    expect(records).toHaveLength(2);
    expect(records[0]?.coverage).toBe(3);
    expect(records[1]?.coverage).toBe(5);
  });

  it("off → appendTelemetry is a complete no-op (no log file created)", () => {
    tp = makeTempProject();
    writeTelemetryConfig(tp.paths, { enabled: false });

    appendTelemetry(tp.paths, { event: "scorecard", coverage: 1 });

    expect(fs.existsSync(telemetryLogPath(tp.paths))).toBe(false);
    expect(readTelemetryLog(tp.paths)).toEqual([]);
  });

  it("readTelemetryLog skips malformed lines", () => {
    tp = makeTempProject();
    writeTelemetryConfig(tp.paths, { enabled: true });
    appendTelemetry(tp.paths, { ok: 1 });
    fs.appendFileSync(telemetryLogPath(tp.paths), "not json\n", "utf8");
    appendTelemetry(tp.paths, { ok: 2 });
    expect(readTelemetryLog(tp.paths)).toHaveLength(2);
  });
});

describe("REQ-TELEMETRY-003: status reports enabled state + record count", () => {
  it("reports disabled / 0 records on a fresh project", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runTelemetryStatus(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.enabled).toBe(false);
    expect(res.data?.records).toBe(0);
    expect(res.human).toMatch(/disabled/);
  });

  it("reports enabled and the running record count after appends", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runTelemetrySet(tp.paths, "on");
    appendTelemetry(tp.paths, { event: "scorecard" });
    appendTelemetry(tp.paths, { event: "scorecard" });
    const res = runTelemetryStatus(tp.paths);
    expect(res.data?.enabled).toBe(true);
    expect(res.data?.records).toBe(2);
    expect(res.human).toMatch(/enabled/);
    expect(res.human).toMatch(/2/);
  });
});
