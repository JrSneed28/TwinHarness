/**
 * Harvest over REAL artifacts (plan Step 1 / §11 — no simulation).
 *
 * Each case drives the real spine (init / drift / decision / route / lease /
 * scorecard) in an isolated temp project, drops the committed `proof-calls.jsonl`
 * trail, then asserts `harvestScenario` normalizes the genuine artifacts into the
 * versioned `ScenarioArtifacts` contract. A PATH-AGNOSTIC case proves a legacy
 * `.agentic-sdlc`-seeded root harvests identically (paths.stateDir, never literal).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { resolveProjectPaths } from "../src/core/paths";
import { runInit } from "../src/commands/init";
import { runDriftAdd } from "../src/commands/drift";
import { runDecisionAdd } from "../src/commands/decision";
import { runRoute } from "../src/commands/route";
import { readState, writeState } from "../src/core/state-store";
import { initialState, serializeState } from "../src/core/state-schema";
import { writeTelemetryConfig } from "../src/core/telemetry";
import { appendLeaseEvent } from "../src/core/leases";
import { harvestScenario } from "../src/core/proof/harvest";
import { HARVEST_VERSION } from "../src/core/proof/types";

const FIXTURE_TRAIL = path.resolve(__dirname, "fixtures/proof/proof-calls.jsonl");

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Drop the committed dedicated MCP call trail into a scenario's state dir. */
function seedProofCalls(stateDir: string): void {
  fs.copyFileSync(FIXTURE_TRAIL, path.join(stateDir, "proof-calls.jsonl"));
}

describe("harvestScenario over real spine artifacts", () => {
  it("normalizes a real greenfield run into the versioned ScenarioArtifacts contract", () => {
    tp = makeTempProject();
    const { paths } = tp;

    // --- Real artifacts from the real spine ---
    runInit(paths, {});
    writeTelemetryConfig(paths, { enabled: true });
    // Requirement-layer drift → gate-ledger entry + blocking count + drift-log.
    runDriftAdd(paths, { layer: "requirement", ref: "SLICE-1", discovery: "missing edge case", action: "build paused" });
    // A proposed decision → hash-chained decisions.jsonl.
    runDecisionAdd(paths, { title: "Adopt the harvest contract", rationale: "single source of truth", links: ["stage:architecture"] });
    // A route decision → telemetry route event (telemetry is enabled above).
    runRoute(paths, { agent: "orchestrator", mode: "architecture" });
    // A live slice + its lease → build-leases.jsonl that reconciles as live.
    const cur = readState(paths).state!;
    writeState(paths, { ...cur, slices: [{ id: "SLICE-1", status: "in-progress", components: ["auth"] }] });
    appendLeaseEvent(paths, { event: "claim", slice: "SLICE-1", components: ["auth"] });
    // The dedicated producer trail (its real producer is a later R7 phase).
    seedProofCalls(paths.stateDir);

    const a = harvestScenario(paths, "tiny-cli-greenfield");

    // Versioned contract.
    expect(a.harvestVersion).toBe(HARVEST_VERSION);
    expect(a.briefId).toBe("tiny-cli-greenfield");
    expect(a.scenarioRoot).toBe(paths.root);
    expect(a.stateDir).toBe(paths.stateDir);

    // State snapshot.
    expect(a.state).not.toBeNull();
    expect(a.stateValid).toBe(true);
    expect(a.stateIssues).toEqual([]);
    expect(a.state?.drift_open_blocking).toBe(1);

    // Manifest + scorecard (composed, never recomputed).
    expect(a.manifest).not.toBeNull();
    expect(a.scorecard).not.toBeNull();
    expect(a.scorecard).toMatchObject({ stage: expect.any(String) });

    // Ledger + decisions, with verified tamper chains.
    expect(a.ledger.length).toBeGreaterThanOrEqual(1);
    expect(a.ledgerChainValid).toBe(true);
    expect(a.decisions.length).toBeGreaterThanOrEqual(1);
    expect(a.decisionsChainValid).toBe(true);

    // Telemetry + routing (non-empty per M3 enablement).
    expect(a.telemetry.length).toBeGreaterThanOrEqual(1);
    expect(a.routing.events).toBeGreaterThanOrEqual(1);

    // Leases (active + reconciled-live).
    expect(a.leases.map((l) => l.slice)).toContain("SLICE-1");
    expect(a.liveLeases.map((l) => l.slice)).toContain("SLICE-1");

    // Slice progress + artifact integrity.
    expect(a.sliceProgress?.total).toBe(1);
    expect(a.sliceProgress?.inProgress).toBe(1);
    expect(Array.isArray(a.artifactIntegrity)).toBe(true);

    // MCP call trail read from the dedicated proof-calls.jsonl (tolerant of the
    // torn line) — includes the ok:false catch-site record.
    const tools = a.mcpCalls.map((c) => c.tool);
    expect(tools).toEqual(["th_state_get", "th_build_plan", "th_route", "th_coverage_check", "th_next"]);
    expect(a.mcpCalls.some((c) => c.ok === false)).toBe(true);
    expect(a.mcpCalls.find((c) => c.tool === "th_coverage_check")?.ok).toBe(false);
  });

  it("is PATH-AGNOSTIC: a legacy `.agentic-sdlc`-seeded root harvests via paths.stateDir", () => {
    tp = makeTempProject();
    const root = tp.root;

    // Seed a legacy project: real state via the real serializer, in `.agentic-sdlc`
    // (NOT `.twinharness`), so resolveProjectPaths selects the legacy state dir.
    const legacyDir = path.join(root, ".agentic-sdlc");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "state.json"), serializeState(initialState()), "utf8");

    const paths = resolveProjectPaths(root);
    expect(paths.stateDir.endsWith(".agentic-sdlc")).toBe(true);

    // Real telemetry + route into the legacy dir, then the dedicated trail.
    writeTelemetryConfig(paths, { enabled: true });
    runRoute(paths, { agent: "orchestrator", mode: "architecture" });
    seedProofCalls(paths.stateDir);

    const a = harvestScenario(paths);

    expect(a.harvestVersion).toBe(HARVEST_VERSION);
    expect(a.stateDir.endsWith(".agentic-sdlc")).toBe(true);
    expect(a.stateValid).toBe(true);
    expect(a.routing.events).toBeGreaterThanOrEqual(1);
    expect(a.mcpCalls.length).toBeGreaterThanOrEqual(3);
    // The trail lived under `.agentic-sdlc`, proving path-agnostic sourcing.
    expect(fs.existsSync(path.join(paths.stateDir, "proof-calls.jsonl"))).toBe(true);
  });

  it("harvests a bare uninitialized root without throwing (null state, empty trails)", () => {
    tp = makeTempProject();
    const paths = resolveProjectPaths(tp.root);

    const a = harvestScenario(paths);

    expect(a.harvestVersion).toBe(HARVEST_VERSION);
    expect(a.state).toBeNull();
    expect(a.stateValid).toBe(false);
    expect(a.manifest).toBeNull();
    expect(a.scorecard).toBeNull();
    expect(a.ledger).toEqual([]);
    expect(a.decisions).toEqual([]);
    expect(a.mcpCalls).toEqual([]);
    expect(a.sliceProgress).toBeNull();
  });
});
