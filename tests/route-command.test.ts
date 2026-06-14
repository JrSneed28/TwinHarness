import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { runRoute } from "../src/commands/route";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runTelemetrySet } from "../src/commands/telemetry";
import { telemetryLogPath } from "../src/core/telemetry";
import { makeTempProject, type TempProject } from "./helpers";

let tp: TempProject;
afterEach(() => tp?.cleanup());

describe("th route command", () => {
  it("returns sonnet/medium by default when there is no run", () => {
    tp = makeTempProject();
    const r = runRoute(tp.paths, {});
    expect(r.ok).toBe(true);
    expect((r.data as any).model).toBe("sonnet");
    expect((r.data as any).effort).toBe("medium");
  });

  it("sources tier + blast flags from state (spec security on T3+blast → opus/max)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "blast_radius_flags", '["authentication"]');
    runStateSet(tp.paths, "tier", "T3");
    const r = runRoute(tp.paths, { agent: "spec", mode: "security" });
    expect((r.data as any).model).toBe("opus");
    expect((r.data as any).effort).toBe("max");
  });

  it("--tier overrides state/default", () => {
    tp = makeTempProject();
    const r = runRoute(tp.paths, { agent: "spec", mode: "architecture", tier: "T3" });
    expect((r.data as any).model).toBe("opus");
    expect((r.data as any).effort).toBe("high");
  });

  it("records a route telemetry snapshot only when telemetry is enabled", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runRoute(tp.paths, { agent: "builder" }); // telemetry off → no file
    expect(fs.existsSync(telemetryLogPath(tp.paths))).toBe(false);

    runTelemetrySet(tp.paths, "on");
    runRoute(tp.paths, { agent: "builder", componentBlast: true });
    const log = fs.readFileSync(telemetryLogPath(tp.paths), "utf8");
    expect(log).toContain('"event":"route"');
    expect(log).toContain('"model":"opus"');
  });
});
