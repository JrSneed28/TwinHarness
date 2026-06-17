/**
 * Assertion engine + report-card roll-up (plan Step 2 — components 1 & 2).
 *
 * Pure functions over a harvested {@link ScenarioArtifacts} snapshot. Each
 * `assert<Component>` returns the explicit {@link Assertion}s for that component;
 * {@link buildReportCard} turns assertions + stats into a {@link ReportCard} whose
 * verdict is `fail` iff any assertion failed, with an AI-actionable
 * {@link Diagnostic} per failure.
 *
 * Components 1 (operational) and 2 (orchestration) derive their verdict ONLY from
 * harvested LIVE artifacts (state.json, gate-ledger.jsonl, telemetry, leases) —
 * NEVER from the deterministic `--self-test` loop (plan §3/§4: the self-test proves
 * mechanical reachability only and is never counted as the live 1/2/5 verdict).
 *
 * Determinism: every check is a STRUCTURAL invariant over the harvest (gates held,
 * valid state, conflict-free dep-ordered waves, no double-held lease, routing
 * emitted, no dispatch deadlock), NOT exact text/timing — so a flaky live run
 * surfaces as a real failed assertion + diagnostic, never as engine noise (plan §6).
 */

import type { SliceState } from "../state-schema";
import { scheduleWaves } from "../schedule";
import { validateDeps, computeWave } from "../wave";
import { isFinalVerification } from "../stages";
import {
  PROOF_COMPONENT_NUMBERS,
  type Assertion,
  type Diagnostic,
  type ProofComponent,
  type ReportCard,
  type ScenarioArtifacts,
  type Verdict,
} from "./types";

// ---------------------------------------------------------------------------
// Assertion + card primitives (shared by all components)
// ---------------------------------------------------------------------------

/** Build one assertion record. */
function mk(component: ProofComponent, name: string, expected: unknown, actual: unknown, pass: boolean): Assertion {
  return { name, component, expected, actual, pass };
}

/** Compact, never-throwing stringifier for diagnostic messages. */
function fmt(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 160 ? s.slice(0, 157) + "…" : s;
  } catch {
    return String(v);
  }
}

/** The AI-actionable diagnostic for a single FAILED assertion. */
export function diagnosticFor(assertion: Assertion): Diagnostic {
  const n = PROOF_COMPONENT_NUMBERS[assertion.component];
  return {
    component: assertion.component,
    location: `${assertion.component}#${assertion.name}`,
    severity: "error",
    hint:
      `Component ${n} (${assertion.component}) assertion "${assertion.name}" did not hold: ` +
      `expected ${fmt(assertion.expected)}, harvested ${fmt(assertion.actual)}. ` +
      `Inspect the live ${assertion.component} artifacts for this scenario.`,
  };
}

/** Map a list of FAILED assertions to AI-actionable diagnostics ({component, location, severity, hint}). */
export function diagnosticsFor(failed: Assertion[]): Diagnostic[] {
  return failed.map(diagnosticFor);
}

/**
 * Roll a component's assertions + stats into a report card. Verdict is `fail` iff
 * any assertion failed, else `pass` (a `skip` verdict is the caller's to assign when
 * the component legitimately did not run on this host). Diagnostics default to one
 * per failed assertion; a caller may supply an explicit set instead.
 */
export function buildReportCard(
  component: ProofComponent,
  assertions: Assertion[],
  stats: Record<string, unknown>,
  diagnostics?: Diagnostic[],
): ReportCard {
  const verdict: Verdict = assertions.some((a) => !a.pass) ? "fail" : "pass";
  const diags = diagnostics ?? diagnosticsFor(assertions.filter((a) => !a.pass));
  return { component, verdict, assertions, stats, diagnostics: diags };
}

/** @deprecated Use {@link buildReportCard}. Retained as a stable alias for early consumers. */
export const rollUpCard = buildReportCard;

// ---------------------------------------------------------------------------
// Component 1 — Operational (real full-pipeline run end-to-end)
// ---------------------------------------------------------------------------

/**
 * Assert the operational invariants over harvested LIVE artifacts: the pipeline
 * reached final-verification, stop/write gates held (no open blocking drift/debate),
 * state validated clean with intact tamper chains (no silent crash mid-write), and
 * governing artifacts were produced and are present.
 */
export function assertOperational(a: ScenarioArtifacts): Assertion[] {
  const C: ProofComponent = "operational";
  const openBlocking = (a.state?.drift_open_blocking ?? 0) + (a.state?.debate_open_blocking ?? 0);
  const reachedFinal = a.state
    ? isFinalVerification(a.state.current_stage) || (a.sliceProgress?.allSettled ?? false)
    : false;
  const artifactCount = a.state?.approved_artifacts.length ?? 0;
  const missing = a.artifactIntegrity.filter((i) => i.status === "missing").length;

  return [
    mk(C, "state_present_and_valid", true, a.stateValid, a.stateValid),
    mk(
      C,
      "tamper_chains_intact",
      true,
      { ledger: a.ledgerChainValid, decisions: a.decisionsChainValid },
      a.ledgerChainValid && a.decisionsChainValid,
    ),
    mk(C, "stop_write_gates_held", 0, openBlocking, openBlocking === 0),
    mk(C, "reached_final_verification", true, reachedFinal, reachedFinal),
    mk(C, "artifacts_produced", ">=1", artifactCount, artifactCount > 0),
    mk(C, "no_missing_artifacts", 0, missing, missing === 0),
  ];
}

/** Operational report card (component 1). */
export function operationalCard(a: ScenarioArtifacts): ReportCard {
  const assertions = assertOperational(a);
  const stats = {
    tier: a.state?.tier ?? null,
    stage: a.state?.current_stage ?? null,
    implementationAllowed: a.state?.implementation_allowed ?? false,
    approvedArtifacts: a.state?.approved_artifacts.length ?? 0,
    artifactsChanged: a.artifactIntegrity.filter((i) => i.status === "changed").length,
    artifactsMissing: a.artifactIntegrity.filter((i) => i.status === "missing").length,
    driftOpenBlocking: a.state?.drift_open_blocking ?? 0,
    debateOpenBlocking: a.state?.debate_open_blocking ?? 0,
    slices: a.sliceProgress,
    ledgerEntries: a.ledger.length,
    decisionEvents: a.decisions.length,
  };
  return buildReportCard("operational", assertions, stats);
}

// ---------------------------------------------------------------------------
// Component 2 — Orchestration (coordination logic of the real run)
// ---------------------------------------------------------------------------

/** Components held by more than one DIFFERENT owner across the live leases (double-held). */
function doubleHeldComponents(leases: ScenarioArtifacts["liveLeases"]): string[] {
  const owner = new Map<string, string>();
  const doubled = new Set<string>();
  for (const lease of leases) {
    for (const c of lease.components) {
      const prev = owner.get(c);
      if (prev === undefined) owner.set(c, lease.slice);
      else if (prev !== lease.slice) doubled.add(c);
    }
  }
  return [...doubled];
}

/** Within-wave component collisions (a wave that schedules two slices sharing a component). */
function waveConflicts(slices: SliceState[], waves: string[][]): string[] {
  const componentsById = new Map(slices.map((s) => [s.id, s.components]));
  const conflicts: string[] = [];
  for (const wave of waves) {
    const seen = new Map<string, string>();
    for (const id of wave) {
      for (const c of componentsById.get(id) ?? []) {
        const prev = seen.get(c);
        if (prev !== undefined && prev !== id) conflicts.push(c);
        else seen.set(c, id);
      }
    }
  }
  return conflicts;
}

/**
 * Build the live "occupied" component map the way the wave-runner does: in-progress
 * slices first, then live leases (first owner of a component wins). Pure over the
 * harvested snapshot (mirrors `occupiedComponents`, which would otherwise re-read
 * the lease ledger from disk).
 */
function occupiedFromHarvest(slices: SliceState[], liveLeases: ScenarioArtifacts["liveLeases"]): Map<string, string> {
  const occ = new Map<string, string>();
  for (const s of slices) {
    if (s.status === "in-progress") for (const c of s.components) if (!occ.has(c)) occ.set(c, s.id);
  }
  for (const lease of liveLeases) {
    for (const c of lease.components) if (!occ.has(c)) occ.set(c, lease.slice);
  }
  return occ;
}

/**
 * Assert the orchestration invariants over harvested LIVE artifacts: the dependency
 * graph is acyclic + fully resolved, the scheduled waves are conflict-free, the live
 * dispatch graph is not deadlocked (computeWave), no component is double-held across
 * live leases, dispatch routing was emitted to telemetry, and the gate ledger's
 * tamper chain is intact.
 */
export function assertOrchestration(a: ScenarioArtifacts): Assertion[] {
  const C: ProofComponent = "orchestration";
  const slices: SliceState[] = a.state?.slices ?? [];

  const dep = validateDeps(slices);
  const depsClean = dep.dangling.length === 0 && dep.cycles.length === 0;

  const waves = scheduleWaves(slices);
  const conflicts = waveConflicts(slices, waves);

  const occupied = occupiedFromHarvest(slices, a.liveLeases);
  const anyInProgress = slices.some((s) => s.status === "in-progress");
  const wavePlan = computeWave(slices, occupied, anyInProgress);

  const doubled = doubleHeldComponents(a.liveLeases);

  return [
    mk(
      C,
      "deps_acyclic_and_resolved",
      { dangling: 0, cycles: 0 },
      { dangling: dep.dangling.length, cycles: dep.cycles.length },
      depsClean,
    ),
    mk(C, "waves_conflict_free", [], conflicts, conflicts.length === 0),
    mk(C, "no_dispatch_deadlock", false, wavePlan.stalled, !wavePlan.stalled),
    mk(C, "no_double_held_leases", [], doubled, doubled.length === 0),
    mk(C, "dispatch_routing_emitted", ">=1", a.routing.events, a.routing.events > 0),
    mk(C, "gate_ledger_intact", true, a.ledgerChainValid, a.ledgerChainValid),
  ];
}

/** Orchestration report card (component 2). */
export function orchestrationCard(a: ScenarioArtifacts): ReportCard {
  const assertions = assertOrchestration(a);
  const slices: SliceState[] = a.state?.slices ?? [];
  const waves = scheduleWaves(slices);
  const stats = {
    waveCount: waves.length,
    slicesPerWave: waves.map((w) => w.length),
    sliceCount: slices.length,
    liveLeaseCount: a.liveLeases.length,
    activeLeaseCount: a.leases.length,
    gateLedgerEntries: a.ledger.length,
    routeEvents: a.routing.events,
    routeModels: a.routing.models,
  };
  return buildReportCard("orchestration", assertions, stats);
}
