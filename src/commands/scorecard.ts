import * as fs from "node:fs";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState } from "../core/state-store";
import { sliceProgress, reviseEscalations, artifactIntegrity } from "../core/health";
import { computeBreakdown } from "../core/coverage";
import { readVerifyReport } from "../core/verify";
import { parseDriftEntries } from "../core/drift-log";
import { readLedger } from "../core/ledger";
import { readTelemetryConfig, appendTelemetry } from "../core/telemetry";

/**
 * `th scorecard` — a post-run, one-screen summary of where the run stands.
 *
 * It is the read-only counterpart to `th doctor` (the diagnostic) and `th next`
 * (the oracle): instead of a check-by-check audit or the single next obligation,
 * it composes the durable signals the CLI already owns — tier/stage, coverage
 * counts, slice progress, suite status, drift, revise escalations, artifact
 * integrity — into one glanceable scorecard a human can read at the end of (or
 * partway through) a run.
 *
 * Records and computes; never decides and never runs anything (plan §3). The one
 * side effect is OPT-IN telemetry: if (and only if) the operator has enabled it
 * (`th telemetry on`), the composed summary numbers are appended as a local
 * snapshot to `<stateDir>/telemetry.jsonl` (never sent anywhere — see
 * core/telemetry.ts). While telemetry is off, the append is a no-op.
 */

interface DriftSummary {
  /** Total parsed drift-log entries. */
  entries: number;
  /** Open blocking (requirement-layer) drift from durable state (the stop-gate count). */
  openBlocking: number;
}

interface CoverageSummary {
  total: number;
  planned: number;
  implemented: number;
  tested: number;
}

export function runScorecard(paths: ProjectPaths, opts: { json?: boolean }): CommandResult {
  const r = readState(paths);
  if (!r.exists) {
    return failure({ human: "No TwinHarness run here. Run `th init` first.", data: { error: "not_initialized" } });
  }
  if (!r.state) {
    return failure({ human: "state.json is invalid (`th state verify` for details).", data: { error: "invalid_state", issues: r.issues } });
  }
  const s = r.state;

  // --- Coverage (planned / implemented / tested) ---
  const breakdown = computeBreakdown(paths.root);
  const coverage: CoverageSummary | null =
    "error" in breakdown
      ? null
      : { total: breakdown.total, planned: breakdown.planned, implemented: breakdown.implemented, tested: breakdown.tested };

  // --- Slice progress ---
  const prog = sliceProgress(s);

  // --- Suite status (from the optional verify report; "—" when never run) ---
  const report = readVerifyReport(paths);
  const suite: "green" | "failing" | "—" = report ? (report.ok ? "green" : "failing") : "—";
  const suiteFailures = report ? report.results.filter((x) => !x.ok).length : 0;

  // --- Drift summary (log entries + open blocking from durable state) ---
  let driftEntries = 0;
  try {
    if (fs.existsSync(paths.driftLog)) {
      driftEntries = parseDriftEntries(fs.readFileSync(paths.driftLog, "utf8")).length;
    }
  } catch {
    // Unreadable drift log → treat as zero entries (never crash the scorecard).
  }
  const drift: DriftSummary = { entries: driftEntries, openBlocking: s.drift_open_blocking };

  // --- Revise escalations (loops at cap → a human owes a decision) ---
  const escalations = reviseEscalations(s);

  // --- Artifact integrity (changed/missing governed docs) ---
  const integrity = artifactIntegrity(paths, s);
  const artifactsChanged = integrity.filter((i) => i.status === "changed").length;
  const artifactsMissing = integrity.filter((i) => i.status === "missing").length;

  const ledgerEntries = readLedger(paths).length;

  const data = {
    tier: s.tier,
    stage: s.current_stage,
    implementationAllowed: s.implementation_allowed,
    coverage,
    slices: { total: prog.total, done: prog.done, blocked: prog.blocked, inProgress: prog.inProgress, pending: prog.pending },
    suite,
    suiteFailures,
    drift,
    reviseEscalations: escalations,
    artifacts: { registered: integrity.length, changed: artifactsChanged, missing: artifactsMissing },
    ledgerEntries,
  };

  // --- Opt-in local telemetry snapshot (no-op when telemetry is disabled) ---
  if (readTelemetryConfig(paths).enabled) {
    appendTelemetry(paths, {
      ts: new Date().toISOString(),
      event: "scorecard",
      tier: s.tier,
      stage: s.current_stage,
      coverage,
      slices: data.slices,
      suite,
      drift,
      reviseEscalations: escalations.length,
      artifactsChanged,
      artifactsMissing,
    });
  }

  const human = renderScorecard(data);
  return success({ data, human });
}

function renderScorecard(d: {
  tier: string | null;
  stage: string;
  implementationAllowed: boolean;
  coverage: CoverageSummary | null;
  slices: { total: number; done: number; blocked: number; inProgress: number; pending: number };
  suite: "green" | "failing" | "—";
  suiteFailures: number;
  drift: DriftSummary;
  reviseEscalations: { mode: string; count: number; cap: number }[];
  artifacts: { registered: number; changed: number; missing: number };
}): string {
  const cov = d.coverage
    ? `${d.coverage.planned}/${d.coverage.implemented}/${d.coverage.tested} of ${d.coverage.total} (planned/implemented/tested)`
    : "requirements not authored yet";

  const suite =
    d.suite === "—"
      ? "— (run `th verify run`)"
      : d.suite === "green"
        ? "green"
        : `FAILING (${d.suiteFailures} command${d.suiteFailures === 1 ? "" : "s"})`;

  const slices =
    d.slices.total === 0
      ? "no slices synced"
      : `${d.slices.done} done / ${d.slices.total} total / ${d.slices.blocked} blocked` +
        (d.slices.inProgress + d.slices.pending > 0 ? ` (${d.slices.inProgress} in-progress, ${d.slices.pending} pending)` : "");

  const drift =
    d.drift.entries === 0 && d.drift.openBlocking === 0
      ? "none"
      : `${d.drift.entries} entr${d.drift.entries === 1 ? "y" : "ies"}, ${d.drift.openBlocking} open blocking`;

  const revise =
    d.reviseEscalations.length === 0
      ? "none at cap"
      : `at cap: ${d.reviseEscalations.map((e) => `${e.mode} (${e.count}/${e.cap})`).join(", ")}`;

  const artifacts =
    d.artifacts.changed + d.artifacts.missing === 0
      ? `${d.artifacts.registered} registered, all match`
      : `${d.artifacts.registered} registered, ${d.artifacts.changed} changed, ${d.artifacts.missing} missing`;

  return [
    `Tier / stage : ${d.tier ?? "unclassified"} / ${d.stage}${d.implementationAllowed ? " (implementation allowed)" : ""}`,
    `Coverage     : ${cov}`,
    `Slices       : ${slices}`,
    `Suite        : ${suite}`,
    `Drift        : ${drift}`,
    `Revise loops : ${revise}`,
    `Artifacts    : ${artifacts}`,
  ].join("\n");
}
