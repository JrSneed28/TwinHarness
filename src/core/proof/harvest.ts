/**
 * Scenario harvest (plan Step 1 — the producer→engine boundary).
 *
 * {@link harvestScenario} reads a finished scenario sandbox and normalizes the
 * REAL artifacts a live run left behind into one VERSIONED {@link ScenarioArtifacts}
 * snapshot — the single thing the deterministic engine (assert / coverage-matrix /
 * regression / report) consumes. It COMPOSES the existing read/build validators and
 * recomputes nothing (plan Principle 3): `readState`, `buildManifest`,
 * `runScorecard(...).data`, `readLedger`+`verifyLedgerChain`,
 * `readDecisionEvents`+`verifyChain`, `readTelemetryLog`, `activeLeases`/`liveLeases`,
 * `sliceProgress`/`artifactIntegrity`, plus the dedicated `proof-calls.jsonl` trail.
 *
 * PATH-AGNOSTIC (MINOR fix): every artifact is sourced via `paths.stateDir` /
 * `paths.stateFile`, never a literal `.twinharness/...`, so an `.agentic-sdlc`-seeded
 * brownfield root harvests identically to a `.twinharness` one.
 *
 * The live MCP-tool-call set comes ONLY from the dedicated `proof-calls.jsonl` trail
 * (C1/A1) — NOT telemetry route events, NOT `telemetry.jsonl`, NOT the self-test
 * loop — so coverage evidence is decoupled from the M3 telemetry opt-in.
 */

import * as path from "node:path";
import type { ProjectPaths } from "../paths";
import { readState } from "../state-store";
import { readLedger, verifyLedgerChain } from "../ledger";
import { readDecisionEvents, verifyChain } from "../decisions";
import { readTelemetryLog } from "../telemetry";
import { activeLeases, liveLeases } from "../leases";
import { sliceProgress, artifactIntegrity } from "../health";
import { readJsonlValues } from "../jsonl";
import { buildManifest } from "../../commands/manifest";
import { runScorecard } from "../../commands/scorecard";
import { HARVEST_VERSION } from "./types";
import type { ProofCall, RoutingSummary, ScenarioArtifacts } from "./types";

/** `<stateDir>/proof-calls.jsonl` — the dedicated producer-side MCP call trail (C1/A1). */
export function proofCallsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "proof-calls.jsonl");
}

/** Shape-guard for one `proof-calls.jsonl` line ({tool,ts,ok}); malformed lines are skipped. */
function isProofCall(parsed: unknown): parsed is ProofCall {
  if (typeof parsed !== "object" || parsed === null) return false;
  const c = parsed as Record<string, unknown>;
  return typeof c.tool === "string" && typeof c.ts === "string" && typeof c.ok === "boolean";
}

/**
 * Read the dedicated MCP call trail (C1/A1/A2). Missing file → `[]`; malformed
 * lines skipped — tolerant, mirroring `readLedger`/`readTelemetryLog`. The producer
 * (mcp-server CallTool handler) writes `{tool,ts,ok}` at BOTH the success and catch
 * sites, so `ok:false` calls are recorded too.
 */
export function readProofCalls(paths: ProjectPaths): ProofCall[] {
  return readJsonlValues(proofCallsPath(paths), isProofCall);
}

/**
 * Summarize recorded `th route` telemetry: count "route" events and tally them by
 * chosen model. Local-only — operates over the already-read telemetry records, never
 * the network. Mirrors the (unexported) scorecard summarizer.
 */
function summarizeRouting(records: object[]): RoutingSummary {
  const models: Record<string, number> = {};
  let events = 0;
  for (const rec of records as Array<{ event?: unknown; model?: unknown }>) {
    if (rec.event !== "route") continue;
    events++;
    if (typeof rec.model === "string" && rec.model.length > 0) {
      models[rec.model] = (models[rec.model] ?? 0) + 1;
    }
  }
  return { events, models };
}

/**
 * Harvest one scenario sandbox into a normalized {@link ScenarioArtifacts} snapshot.
 * Pure composition of existing validators (no SUT re-run). `briefId` may be supplied
 * when the caller knows which brief produced the run; absent → null.
 */
export function harvestScenario(paths: ProjectPaths, briefId: string | null = null): ScenarioArtifacts {
  const r = readState(paths);
  const state = r.state ?? null;
  const stateValid = r.exists && r.state !== undefined;
  const stateIssues = r.issues ?? [];

  const manifest = buildManifest(paths);

  // Composite run stats. runScorecard returns a CommandResult; harvest takes its
  // `data` payload on success, null otherwise (e.g. uninitialized root).
  let scorecard: Record<string, unknown> | null = null;
  const sc = runScorecard(paths, { json: true });
  if (sc.ok && sc.data) scorecard = sc.data;

  const ledger = readLedger(paths);
  const ledgerChainValid = verifyLedgerChain(ledger).ok;

  const decisions = readDecisionEvents(paths);
  const decisionsChainValid = verifyChain(decisions).ok;

  const telemetry = readTelemetryLog(paths);
  const routing = summarizeRouting(telemetry);

  const leases = activeLeases(paths);
  const live = state ? liveLeases(paths, state.slices) : [];

  const progress = state ? sliceProgress(state) : null;
  const integrity = state ? artifactIntegrity(paths, state) : [];

  const mcpCalls = readProofCalls(paths);

  return {
    harvestVersion: HARVEST_VERSION,
    briefId,
    scenarioRoot: paths.root,
    stateDir: paths.stateDir,
    state,
    stateValid,
    stateIssues,
    manifest,
    scorecard,
    ledger,
    ledgerChainValid,
    decisions,
    decisionsChainValid,
    telemetry,
    routing,
    leases,
    liveLeases: live,
    sliceProgress: progress,
    artifactIntegrity: integrity,
    mcpCalls,
  };
}
