/**
 * Assert engine + dogfood (plan Steps 2 & 5 / §11 — components 1, 2, 5).
 *
 * A real "completed run" is built with the real spine (init / artifact register /
 * route / state) and harvested; the three component cards must PASS over it. Each
 * negative case perturbs exactly ONE harvested invariant (valid state / open gate /
 * cyclic deps / double-held lease / routing / working-code) and asserts the card
 * flips to `fail` with a diagnostic naming the violated assertion.
 *
 * The base artifacts come from the real spine (zero simulation); only the specific
 * field under test is mutated on a structured clone.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runArtifactRegister } from "../src/commands/artifact";
import { runRoute } from "../src/commands/route";
import { readState, writeState } from "../src/core/state-store";
import { writeTelemetryConfig } from "../src/core/telemetry";
import type { SliceState, TwinHarnessState } from "../src/core/state-schema";
import { harvestScenario } from "../src/core/proof/harvest";
import { operationalCard, orchestrationCard } from "../src/core/proof/assert";
import { dogfoodCard, buildCaseStudy } from "../src/core/proof/dogfood";
import type { SampleBrief, ScenarioArtifacts } from "../src/core/proof/types";

const BRIEF: SampleBrief = {
  id: "tiny-cli-greenfield",
  size: "tiny",
  domain: "cli",
  tierHint: "T1",
  type: "greenfield",
  acceptanceCriteria: ["counts match wc", "missing-file exits non-zero"],
};

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

/** Build + harvest a real, completed pipeline run (all invariants satisfied). */
function completedRun(): ScenarioArtifacts {
  tp = makeTempProject();
  const { paths } = tp;

  runInit(paths, {});
  writeTelemetryConfig(paths, { enabled: true });

  // A real approved artifact (content-hashed) so artifacts_produced / no_missing hold.
  fs.mkdirSync(paths.docsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.docsDir, "04-architecture.md"), "# Architecture\n\nComponents and data flow.\n", "utf8");
  expect(runArtifactRegister(paths, "docs/04-architecture.md", 1).ok).toBe(true);

  // Advance to a completed, gate-clean state with dep-ordered, conflict-free slices.
  const cur = readState(paths).state!;
  const slices: SliceState[] = [
    { id: "SLICE-1", status: "done", components: ["cli"] },
    { id: "SLICE-2", status: "done", components: ["core"], depends_on: ["SLICE-1"] },
  ];
  writeState(paths, {
    ...cur,
    tier: "T1",
    current_stage: "final-verification",
    implementation_allowed: true,
    slices,
    drift_open_blocking: 0,
  });

  // Real dispatch routing → telemetry route event (telemetry enabled above).
  expect(runRoute(paths, { agent: "orchestrator", mode: "architecture" }).ok).toBe(true);

  return harvestScenario(paths, BRIEF.id);
}

/** Names of the assertions that FAILED on a card. */
function failed(card: { assertions: { name: string; pass: boolean }[] }): string[] {
  return card.assertions.filter((x) => !x.pass).map((x) => x.name);
}

describe("component cards over a real completed run", () => {
  it("operational (1), orchestration (2), dogfood (5) all PASS", () => {
    const a = completedRun();

    const op = operationalCard(a);
    expect(op.component).toBe("operational");
    expect(op.verdict).toBe("pass");
    expect(failed(op)).toEqual([]);
    expect(op.diagnostics).toEqual([]);

    const orch = orchestrationCard(a);
    expect(orch.component).toBe("orchestration");
    expect(orch.verdict).toBe("pass");
    expect(failed(orch)).toEqual([]);
    expect(orch.stats.waveCount).toBe(2); // SLICE-2 depends_on SLICE-1 → two waves
    expect(orch.stats.routeEvents).toBe(1);

    const dog = dogfoodCard(a, BRIEF);
    expect(dog.component).toBe("dogfood");
    expect(dog.verdict).toBe("pass");
    expect(failed(dog)).toEqual([]);
    const cs = buildCaseStudy(a, BRIEF);
    expect(cs.briefId).toBe(BRIEF.id);
    expect(cs.reachedWorkingCode).toBe(true);
    expect(cs.acceptanceCriteriaMet).toBe(true);
    expect(cs.narrative.length).toBeGreaterThan(0);
    expect(cs.outcome.slicesCompleted).toBe(2);
  });
});

describe("operational (component 1) fails on a violated invariant", () => {
  it("fails when state is invalid", () => {
    const a = structuredClone(completedRun());
    a.stateValid = false;
    const card = operationalCard(a);
    expect(card.verdict).toBe("fail");
    expect(failed(card)).toContain("state_present_and_valid");
    expect(card.diagnostics.some((d) => d.location === "operational#state_present_and_valid")).toBe(true);
  });

  it("fails when a stop/write gate is still open (blocking drift)", () => {
    const a = structuredClone(completedRun());
    (a.state as TwinHarnessState).drift_open_blocking = 2;
    const card = operationalCard(a);
    expect(card.verdict).toBe("fail");
    expect(failed(card)).toContain("stop_write_gates_held");
  });

  it("fails when the ledger tamper chain is broken", () => {
    const a = structuredClone(completedRun());
    a.ledgerChainValid = false;
    const card = operationalCard(a);
    expect(card.verdict).toBe("fail");
    expect(failed(card)).toContain("tamper_chains_intact");
  });
});

describe("orchestration (component 2) fails on a violated invariant", () => {
  it("fails on a dependency cycle", () => {
    const a = structuredClone(completedRun());
    a.state!.slices = [
      { id: "A", status: "pending", components: [], depends_on: ["B"] },
      { id: "B", status: "pending", components: [], depends_on: ["A"] },
    ];
    const card = orchestrationCard(a);
    expect(card.verdict).toBe("fail");
    expect(failed(card)).toContain("deps_acyclic_and_resolved");
  });

  it("fails when a component is double-held across live leases", () => {
    const a = structuredClone(completedRun());
    a.liveLeases = [
      { slice: "SLICE-A", components: ["auth"] },
      { slice: "SLICE-B", components: ["auth"] },
    ];
    const card = orchestrationCard(a);
    expect(card.verdict).toBe("fail");
    expect(failed(card)).toContain("no_double_held_leases");
  });

  it("fails when no dispatch routing was emitted", () => {
    const a = structuredClone(completedRun());
    a.routing = { events: 0, models: {} };
    const card = orchestrationCard(a);
    expect(card.verdict).toBe("fail");
    expect(failed(card)).toContain("dispatch_routing_emitted");
  });
});

describe("dogfood (component 5) fails on a violated invariant", () => {
  it("fails when the run did not reach working code (unsettled slices)", () => {
    const a = structuredClone(completedRun());
    a.sliceProgress = { total: 2, done: 1, blocked: 0, inProgress: 1, pending: 0, allSettled: false };
    const card = dogfoodCard(a, BRIEF);
    expect(card.verdict).toBe("fail");
    expect(failed(card)).toContain("reached_working_code");
    expect(failed(card)).toContain("acceptance_criteria_satisfied");
  });

  it("fails when the brief declares no acceptance criteria", () => {
    const a = completedRun();
    const card = dogfoodCard(a, { ...BRIEF, acceptanceCriteria: [] });
    expect(card.verdict).toBe("fail");
    expect(failed(card)).toContain("acceptance_criteria_declared");
  });
});
