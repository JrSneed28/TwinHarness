/**
 * Telemetry enablement per scenario (plan Step 1 / AC, §11 — M3).
 *
 * Telemetry is opt-in / default-OFF, so harvested routing + token stats would be
 * empty unless a scenario turns it on. `startScenario` must enable telemetry; a
 * subsequent real `th route` event must land in `telemetry.jsonl`; and the harvest
 * must surface a non-empty `routing` summary.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { runRoute } from "../src/commands/route";
import { readTelemetryConfig, readTelemetryLog, writeTelemetryConfig } from "../src/core/telemetry";
import { startScenario } from "../src/core/proof/scenario";
import { harvestScenario } from "../src/core/proof/harvest";
import type { SampleBrief } from "../src/core/proof/types";

const GREENFIELD: SampleBrief = {
  id: "tiny-cli-greenfield",
  size: "tiny",
  domain: "cli",
  tierHint: "T1",
  type: "greenfield",
  acceptanceCriteria: [],
};

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    fs.rmSync(created.pop()!, { recursive: true, force: true });
  }
});

describe("startScenario enables telemetry (M3)", () => {
  it("turns telemetry ON so a later route event is recorded and harvested", () => {
    const { scenarioRoot, scenarioPaths } = startScenario(GREENFIELD);
    created.push(scenarioRoot);

    // Telemetry opt-in switch is ON after startScenario.
    expect(readTelemetryConfig(scenarioPaths).enabled).toBe(true);

    // A real route decision appends a "route" event (only because telemetry is on).
    const res = runRoute(scenarioPaths, { agent: "orchestrator", mode: "architecture" });
    expect(res.ok).toBe(true);

    // The event landed in telemetry.jsonl.
    const log = readTelemetryLog(scenarioPaths) as Array<{ event?: unknown }>;
    expect(log.some((r) => r.event === "route")).toBe(true);

    // Harvest surfaces it as a non-empty routing summary.
    const a = harvestScenario(scenarioPaths, GREENFIELD.id);
    expect(a.routing.events).toBeGreaterThanOrEqual(1);
    expect(Object.keys(a.routing.models).length).toBeGreaterThanOrEqual(1);
  });

  it("records NOTHING when telemetry is off (decoupling baseline)", () => {
    // A scenario starts with telemetry ON; flipping it OFF makes route a no-op,
    // proving the route signal is gated by the opt-in (the C1 trail is separate).
    const { scenarioRoot, scenarioPaths } = startScenario(GREENFIELD);
    created.push(scenarioRoot);

    // Force telemetry off and confirm a route appends nothing.
    writeTelemetryConfig(scenarioPaths, { enabled: false });
    expect(readTelemetryConfig(scenarioPaths).enabled).toBe(false);

    runRoute(scenarioPaths, { agent: "orchestrator", mode: "architecture" });
    const a = harvestScenario(scenarioPaths, GREENFIELD.id);
    expect(a.routing.events).toBe(0);
  });
});
