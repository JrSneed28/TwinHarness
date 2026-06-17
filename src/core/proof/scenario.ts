/**
 * Proof scenario lifecycle (plan Step 1 — C2 isolation + M3 telemetry).
 *
 * A "scenario" is one isolated sandbox for a real, live, in-session full-pipeline
 * TwinHarness run over a corpus brief. {@link startScenario} scaffolds that sandbox
 * in an OS temp dir OUTSIDE any ancestor `.twinharness` (C2: so a live MCP/CLI call
 * can never resolve up into — and corrupt — the developer's real
 * `.twinharness/state.json`), runs the real `th init` there, enables telemetry
 * (M3: otherwise harvested routing/token stats are empty), snapshots a pre-run
 * baseline, and RETURNS the scenario root the skill exports as `CLAUDE_PROJECT_DIR`.
 *
 * Every path is derived from {@link resolveProjectPaths} / `paths.stateDir` — never
 * a literal `.twinharness/...` — so the lifecycle is path-agnostic. The producer
 * that writes the `proof-calls.jsonl` trail lives in the (later) mcp-server R7 phase;
 * this module only prepares and tracks the sandbox.
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProjectPaths, type ProjectPaths } from "../paths";
import { writeTelemetryConfig } from "../telemetry";
import { buildManifest } from "../../commands/manifest";
import { runInit } from "../../commands/init";
import type { ProofScenario, SampleBrief, ScenarioHandle, ScenarioMarker } from "./types";

/**
 * Thrown when a freshly-created scenario temp root resolves to a DIFFERENT project
 * root than itself — i.e. an ancestor directory already holds a `.twinharness`
 * (or legacy `.agentic-sdlc/state.json`) and {@link resolveProjectPaths} climbed up
 * into it. Scaffolding there would route the live run's writes to that ancestor's
 * state, breaking C2 isolation, so we refuse loudly instead.
 */
export class ScenarioIsolationError extends Error {
  readonly code = "scenario_isolation";
  constructor(scenarioRoot: string, resolvedRoot: string) {
    super(
      `scenario root ${scenarioRoot} resolves to an ancestor project root ${resolvedRoot}; ` +
        `it must be isolated (no ancestor .twinharness). Refusing to scaffold.`,
    );
    this.name = "ScenarioIsolationError";
  }
}

/** `<stateDir>/proof-scenario.json` — the scenario lifecycle marker. */
export function scenarioMarkerPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "proof-scenario.json");
}

/**
 * Scaffold an isolated scenario sandbox for `brief` and return its handle.
 *
 * Steps (plan Step 1): create an OS temp root (`th-proof-*`, mirroring
 * `makeTempProject`, tests/helpers.ts:13-19); copy a brownfield seed tree in when
 * the brief declares one; resolve paths and GUARD that the root is its own project
 * (C2); run the real `th init` (`--brownfield` for brownfield briefs); enable
 * telemetry (M3); snapshot a pre-run baseline manifest into the marker.
 */
export function startScenario(brief: SampleBrief): ScenarioHandle {
  const scenarioRoot = fs.mkdtempSync(path.join(os.tmpdir(), "th-proof-"));

  // Brownfield: seed the existing-codebase tree BEFORE init so the run adopts it.
  if (brief.type === "brownfield" && brief.seedDir && fs.existsSync(brief.seedDir)) {
    fs.cpSync(brief.seedDir, scenarioRoot, { recursive: true });
  }

  const scenarioPaths = resolveProjectPaths(scenarioRoot);

  // C2 guard: the temp root MUST be its own project root. If resolveProjectPaths
  // walked UP to an ancestor `.twinharness`/`.agentic-sdlc`, scaffolding here would
  // corrupt that ancestor's state — refuse instead.
  if (path.resolve(scenarioPaths.root) !== path.resolve(scenarioRoot)) {
    fs.rmSync(scenarioRoot, { recursive: true, force: true });
    throw new ScenarioIsolationError(scenarioRoot, scenarioPaths.root);
  }

  // Real `th init` in the sandbox (greenfield by default; brownfield stamps the mode).
  runInit(scenarioPaths, { brownfield: brief.type === "brownfield" });

  // M3: enable local telemetry so the live run's route/scorecard stats are captured.
  writeTelemetryConfig(scenarioPaths, { enabled: true });

  // Pre-run baseline snapshot (deterministic manifest of the freshly-init'd state).
  const scenario: ProofScenario = {
    id: path.basename(scenarioRoot),
    briefId: brief.id,
    tier: brief.tierHint,
    type: brief.type,
    status: "prepared",
    scenarioRoot,
  };
  const marker: ScenarioMarker = {
    scenario,
    baselineManifest: buildManifest(scenarioPaths),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(scenarioMarkerPath(scenarioPaths), JSON.stringify(marker, null, 2) + "\n", "utf8");

  return { scenarioRoot, scenarioPaths, brief };
}

/**
 * Mark a scenario finished: advance its marker status to `finished` and stamp
 * `finishedAt`. Returns the updated {@link ProofScenario}. Idempotent — a missing
 * or unreadable marker yields a minimal `finished` record rather than throwing.
 */
export function finishScenario(paths: ProjectPaths): ProofScenario {
  const file = scenarioMarkerPath(paths);
  let marker: ScenarioMarker | undefined;
  try {
    marker = JSON.parse(fs.readFileSync(file, "utf8")) as ScenarioMarker;
  } catch {
    marker = undefined;
  }
  if (!marker) {
    return {
      id: path.basename(paths.root),
      briefId: "",
      tier: null,
      type: "greenfield",
      status: "finished",
      scenarioRoot: paths.root,
    };
  }
  marker.scenario.status = "finished";
  marker.finishedAt = new Date().toISOString();
  try {
    fs.writeFileSync(file, JSON.stringify(marker, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort: the returned record is still authoritative for the caller.
  }
  return marker.scenario;
}

/**
 * Enumerate every prepared/finished scenario sandbox still on disk under the OS
 * temp dir (`th-proof-*` roots carrying a marker). Tolerant: a sandbox with no
 * marker, or an unreadable one, is skipped — never throws.
 */
export function listScenarios(): ProofScenario[] {
  const tmp = os.tmpdir();
  const out: ProofScenario[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.startsWith("th-proof-")) continue;
    const root = path.join(tmp, name);
    try {
      if (!fs.statSync(root).isDirectory()) continue;
      const paths = resolveProjectPaths(root);
      const file = scenarioMarkerPath(paths);
      if (!fs.existsSync(file)) continue;
      const marker = JSON.parse(fs.readFileSync(file, "utf8")) as ScenarioMarker;
      if (marker && marker.scenario && typeof marker.scenario.id === "string") {
        out.push(marker.scenario);
      }
    } catch {
      // Skip an unreadable/partial sandbox.
    }
  }
  return out;
}
