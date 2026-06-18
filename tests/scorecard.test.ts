/**
 * `th scorecard` — the post-run one-screen summary (G6) — REQ-anchored.
 *
 * Verifies that the scorecard composes the durable signals (tier/stage,
 * coverage, slice progress, suite status, drift, revise escalations, artifact
 * integrity) correctly, and that it appends a local telemetry snapshot iff
 * telemetry is enabled. Read-only except for that opt-in snapshot.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { readState, writeState } from "../src/core/state-store";
import { writeVerifyReport } from "../src/core/verify";
import { writeTelemetryConfig, readTelemetryLog } from "../src/core/telemetry";
import type { SliceState } from "../src/core/state-schema";
import { runScorecard, runScorecardHotspots } from "../src/commands/scorecard";
import { runRoute } from "../src/commands/route";
import { appendTelemetry } from "../src/core/telemetry";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

function writeFile(t: TempProject, rel: string, content: string): void {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** Seed slices onto the durable state (slices are otherwise sync-managed). */
function seedSlices(t: TempProject, slices: SliceState[]): void {
  const s = readState(t.paths).state!;
  writeState(t.paths, { ...s, slices });
}

interface SliceSummary {
  total: number;
  done: number;
  blocked: number;
  inProgress: number;
  pending: number;
}
const sliceData = (data: unknown): SliceSummary => (data as { slices: SliceSummary }).slices;

describe("REQ-SCORECARD-001: composes tier, coverage, slices, suite, drift", () => {
  it("reports tier/stage and slice progress (done/total/blocked)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    runStateSet(tp.paths, "current_stage", "implementation");
    seedSlices(tp, [
      { id: "SLICE-1", status: "done", components: ["a"] },
      { id: "SLICE-2", status: "blocked", components: ["b"] },
      { id: "SLICE-3", status: "in-progress", components: ["c"] },
    ]);

    const res = runScorecard(tp.paths, {});
    expect(res.ok).toBe(true);
    expect(res.data?.tier).toBe("T2");
    expect(res.data?.stage).toBe("implementation");
    const sl = sliceData(res.data);
    expect(sl).toMatchObject({ total: 3, done: 1, blocked: 1, inProgress: 1 });
    expect(res.human).toContain("1 done / 3 total / 1 blocked");
  });

  it("reports coverage planned/implemented/tested counts from the docs", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    writeFile(tp, "docs/01-requirements.md", "REQ-001 and REQ-002.\n");
    writeFile(tp, "docs/09-implementation-plan.md", "Plan covers REQ-001 and REQ-002.\n");
    writeFile(tp, "tests/foo.test.ts", "// covers REQ-001\n");

    const res = runScorecard(tp.paths, {});
    const cov = res.data?.coverage as { total: number; planned: number; tested: number } | null;
    expect(cov?.total).toBe(2);
    expect(cov?.planned).toBe(2); // both REQ-IDs are in the plan
    expect(cov?.tested).toBe(1); // only REQ-001 is anchored in a test
    expect(res.human).toContain("2/0/1 of 2");
  });

  it("suite shows '—' when no verify report, and 'green'/'FAILING' when present", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");

    expect(runScorecard(tp.paths, {}).data?.suite).toBe("—");

    writeVerifyReport(tp.paths, {
      ok: true,
      ranAt: new Date().toISOString(),
      results: [{ command: "npm test", exitCode: 0, ok: true, durationMs: 1, outputTail: "" }],
    });
    expect(runScorecard(tp.paths, {}).data?.suite).toBe("green");

    writeVerifyReport(tp.paths, {
      ok: false,
      ranAt: new Date().toISOString(),
      results: [{ command: "npm test", exitCode: 1, ok: false, durationMs: 1, outputTail: "boom" }],
    });
    const failing = runScorecard(tp.paths, {});
    expect(failing.data?.suite).toBe("failing");
    expect(failing.data?.suiteFailures).toBe(1);
    expect(failing.human).toMatch(/FAILING/);
  });

  it("summarizes drift: open-blocking count from state", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    // Open blocking drift is a managed field — drive it through the owning flow.
    // Here we assert the scorecard surfaces it once state carries it.
    const s = readState(tp.paths).state!;
    writeState(tp.paths, { ...s, drift_open_blocking: 2 });
    const res = runScorecard(tp.paths, {});
    expect((res.data?.drift as { openBlocking: number }).openBlocking).toBe(2);
    expect(res.human).toContain("2 open blocking");
  });

  it("fails cleanly on an uninitialized dir", () => {
    tp = makeTempProject();
    const res = runScorecard(tp.paths, {});
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });
});

describe("REQ-SCORECARD-002: opt-in telemetry snapshot", () => {
  it("appends one snapshot line when telemetry is enabled", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    writeTelemetryConfig(tp.paths, { enabled: true });

    expect(readTelemetryLog(tp.paths)).toHaveLength(0);
    runScorecard(tp.paths, {});
    const log = readTelemetryLog(tp.paths) as { event: string; ts: string; tier: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]?.event).toBe("scorecard");
    expect(log[0]?.tier).toBe("T2");
    expect(typeof log[0]?.ts).toBe("string"); // ISO timestamp present

    // A second run appends a second snapshot (append-only).
    runScorecard(tp.paths, {});
    expect(readTelemetryLog(tp.paths)).toHaveLength(2);
  });

  it("records nothing when telemetry is disabled (the default)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    runScorecard(tp.paths, {});
    runScorecard(tp.paths, {});
    expect(readTelemetryLog(tp.paths)).toHaveLength(0);
  });
});

interface RoutingSummary {
  events: number;
  models: Record<string, number>;
}
const routingData = (data: unknown): RoutingSummary => (data as { routing: RoutingSummary }).routing;

describe("REQ-SCORECARD-003: Routing line summarizes recorded th route telemetry", () => {
  it("shows '—' when no route telemetry has been recorded", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2");
    const res = runScorecard(tp.paths, {});
    const routing = routingData(res.data);
    expect(routing.events).toBe(0);
    expect(routing.models).toEqual({});
    expect(res.human).toMatch(/Routing\s+: —/);
  });

  it("tallies recorded route events by model (read-only; --json-compatible)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Blast-radius flags route a blast-component Builder to opus; a plain spec stays sonnet.
    runStateSet(tp.paths, "tier", "T3");
    runStateSet(tp.paths, "blast_radius_flags", JSON.stringify(["authentication"]));
    writeTelemetryConfig(tp.paths, { enabled: true });

    // Record three route calls (each appends a "route" telemetry event).
    runRoute(tp.paths, { agent: "builder", mode: "code-review", componentBlast: true });
    runRoute(tp.paths, { agent: "builder", mode: "code-review", componentBlast: true });
    runRoute(tp.paths, { agent: "spec", mode: "scope" });

    const res = runScorecard(tp.paths, { json: true });
    const routing = routingData(res.data);
    expect(routing.events).toBe(3);
    // Per-model tally totals the number of route events.
    const total = Object.values(routing.models).reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
    // The human line names the per-model counts (e.g. "opus×2").
    expect(res.human).toMatch(/Routing\s+: 3 route calls \(/);
    expect(res.human).toMatch(/×\d/);

    // The scorecard's own snapshot append (telemetry on) must NOT be counted as a route event.
    runScorecard(tp.paths, {});
    expect(routingData(runScorecard(tp.paths, {}).data).events).toBe(3);
  });
});

interface Hotspot {
  stage: string;
  events: number;
  tokens: number;
  wallMs: number;
}

describe("REQ-SCORECARD-004: --hotspots per-stage token + wall-clock table", () => {
  it("degrades gracefully (empty table, exit 0, clear message) with no telemetry", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runScorecardHotspots(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    const data = res.data as { hotspots: Hotspot[]; totalTokens: number; recordsScanned: number };
    expect(data.hotspots).toEqual([]);
    expect(data.totalTokens).toBe(0);
    expect(data.recordsScanned).toBe(0);
    expect(res.human).toMatch(/no stage telemetry/i);
  });

  it("aggregates token + wall-clock per stage from the local telemetry log", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    writeTelemetryConfig(tp.paths, { enabled: true });

    // Stage-bearing cost records (the shape a stage emitter would append).
    appendTelemetry(tp.paths, { ts: "t1", event: "stage-cost", stage: "implementation", tokens: 1000, wallMs: 4000 });
    appendTelemetry(tp.paths, { ts: "t2", event: "stage-cost", stage: "implementation", tokens: 500, durationMs: 1000 });
    appendTelemetry(tp.paths, { ts: "t3", event: "stage-cost", stage: "design", estTokens: 200, wallMs: 800 });
    // A record without a stage (e.g. a route event) is ignored by the table but still scanned.
    appendTelemetry(tp.paths, { ts: "t4", event: "route", model: "opus" });

    const res = runScorecardHotspots(tp.paths);
    expect(res.ok).toBe(true);
    const data = res.data as { hotspots: Hotspot[]; totalTokens: number; totalWallMs: number; recordsScanned: number };
    expect(data.recordsScanned).toBe(4);
    expect(data.totalTokens).toBe(1700);
    expect(data.totalWallMs).toBe(5800);
    // Sorted by tokens desc → implementation first.
    expect(data.hotspots[0]).toMatchObject({ stage: "implementation", events: 2, tokens: 1500, wallMs: 5000 });
    expect(data.hotspots[1]).toMatchObject({ stage: "design", events: 1, tokens: 200, wallMs: 800 });
    expect(res.human).toContain("implementation");
    expect(res.human).toMatch(/TOTAL/);
  });

  it("is reachable through runScorecard({ hotspots: true })", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runScorecard(tp.paths, { hotspots: true });
    expect(res.ok).toBe(true);
    expect((res.data as { hotspots: Hotspot[] }).hotspots).toEqual([]);
  });
});
