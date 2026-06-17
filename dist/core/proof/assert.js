"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.rollUpCard = void 0;
exports.diagnosticFor = diagnosticFor;
exports.diagnosticsFor = diagnosticsFor;
exports.buildReportCard = buildReportCard;
exports.assertOperational = assertOperational;
exports.operationalCard = operationalCard;
exports.assertOrchestration = assertOrchestration;
exports.orchestrationCard = orchestrationCard;
const schedule_1 = require("../schedule");
const wave_1 = require("../wave");
const stages_1 = require("../stages");
const types_1 = require("./types");
// ---------------------------------------------------------------------------
// Assertion + card primitives (shared by all components)
// ---------------------------------------------------------------------------
/** Build one assertion record. */
function mk(component, name, expected, actual, pass) {
    return { name, component, expected, actual, pass };
}
/** Compact, never-throwing stringifier for diagnostic messages. */
function fmt(v) {
    try {
        const s = JSON.stringify(v);
        return s.length > 160 ? s.slice(0, 157) + "…" : s;
    }
    catch {
        return String(v);
    }
}
/** The AI-actionable diagnostic for a single FAILED assertion. */
function diagnosticFor(assertion) {
    const n = types_1.PROOF_COMPONENT_NUMBERS[assertion.component];
    return {
        component: assertion.component,
        location: `${assertion.component}#${assertion.name}`,
        severity: "error",
        hint: `Component ${n} (${assertion.component}) assertion "${assertion.name}" did not hold: ` +
            `expected ${fmt(assertion.expected)}, harvested ${fmt(assertion.actual)}. ` +
            `Inspect the live ${assertion.component} artifacts for this scenario.`,
    };
}
/** Map a list of FAILED assertions to AI-actionable diagnostics ({component, location, severity, hint}). */
function diagnosticsFor(failed) {
    return failed.map(diagnosticFor);
}
/**
 * Roll a component's assertions + stats into a report card. Verdict is `fail` iff
 * any assertion failed, else `pass` (a `skip` verdict is the caller's to assign when
 * the component legitimately did not run on this host). Diagnostics default to one
 * per failed assertion; a caller may supply an explicit set instead.
 */
function buildReportCard(component, assertions, stats, diagnostics) {
    const verdict = assertions.some((a) => !a.pass) ? "fail" : "pass";
    const diags = diagnostics ?? diagnosticsFor(assertions.filter((a) => !a.pass));
    return { component, verdict, assertions, stats, diagnostics: diags };
}
/** @deprecated Use {@link buildReportCard}. Retained as a stable alias for early consumers. */
exports.rollUpCard = buildReportCard;
// ---------------------------------------------------------------------------
// Component 1 — Operational (real full-pipeline run end-to-end)
// ---------------------------------------------------------------------------
/**
 * Assert the operational invariants over harvested LIVE artifacts: the pipeline
 * reached final-verification, stop/write gates held (no open blocking drift/debate),
 * state validated clean with intact tamper chains (no silent crash mid-write), and
 * governing artifacts were produced and are present.
 */
function assertOperational(a) {
    const C = "operational";
    const openBlocking = (a.state?.drift_open_blocking ?? 0) + (a.state?.debate_open_blocking ?? 0);
    const reachedFinal = a.state
        ? (0, stages_1.isFinalVerification)(a.state.current_stage) || (a.sliceProgress?.allSettled ?? false)
        : false;
    const artifactCount = a.state?.approved_artifacts.length ?? 0;
    const missing = a.artifactIntegrity.filter((i) => i.status === "missing").length;
    return [
        mk(C, "state_present_and_valid", true, a.stateValid, a.stateValid),
        mk(C, "tamper_chains_intact", true, { ledger: a.ledgerChainValid, decisions: a.decisionsChainValid }, a.ledgerChainValid && a.decisionsChainValid),
        mk(C, "stop_write_gates_held", 0, openBlocking, openBlocking === 0),
        mk(C, "reached_final_verification", true, reachedFinal, reachedFinal),
        mk(C, "artifacts_produced", ">=1", artifactCount, artifactCount > 0),
        mk(C, "no_missing_artifacts", 0, missing, missing === 0),
    ];
}
/** Operational report card (component 1). */
function operationalCard(a) {
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
function doubleHeldComponents(leases) {
    const owner = new Map();
    const doubled = new Set();
    for (const lease of leases) {
        for (const c of lease.components) {
            const prev = owner.get(c);
            if (prev === undefined)
                owner.set(c, lease.slice);
            else if (prev !== lease.slice)
                doubled.add(c);
        }
    }
    return [...doubled];
}
/** Within-wave component collisions (a wave that schedules two slices sharing a component). */
function waveConflicts(slices, waves) {
    const componentsById = new Map(slices.map((s) => [s.id, s.components]));
    const conflicts = [];
    for (const wave of waves) {
        const seen = new Map();
        for (const id of wave) {
            for (const c of componentsById.get(id) ?? []) {
                const prev = seen.get(c);
                if (prev !== undefined && prev !== id)
                    conflicts.push(c);
                else
                    seen.set(c, id);
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
function occupiedFromHarvest(slices, liveLeases) {
    const occ = new Map();
    for (const s of slices) {
        if (s.status === "in-progress")
            for (const c of s.components)
                if (!occ.has(c))
                    occ.set(c, s.id);
    }
    for (const lease of liveLeases) {
        for (const c of lease.components)
            if (!occ.has(c))
                occ.set(c, lease.slice);
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
function assertOrchestration(a) {
    const C = "orchestration";
    const slices = a.state?.slices ?? [];
    const dep = (0, wave_1.validateDeps)(slices);
    const depsClean = dep.dangling.length === 0 && dep.cycles.length === 0;
    const waves = (0, schedule_1.scheduleWaves)(slices);
    const conflicts = waveConflicts(slices, waves);
    const occupied = occupiedFromHarvest(slices, a.liveLeases);
    const anyInProgress = slices.some((s) => s.status === "in-progress");
    const wavePlan = (0, wave_1.computeWave)(slices, occupied, anyInProgress);
    const doubled = doubleHeldComponents(a.liveLeases);
    return [
        mk(C, "deps_acyclic_and_resolved", { dangling: 0, cycles: 0 }, { dangling: dep.dangling.length, cycles: dep.cycles.length }, depsClean),
        mk(C, "waves_conflict_free", [], conflicts, conflicts.length === 0),
        mk(C, "no_dispatch_deadlock", false, wavePlan.stalled, !wavePlan.stalled),
        mk(C, "no_double_held_leases", [], doubled, doubled.length === 0),
        mk(C, "dispatch_routing_emitted", ">=1", a.routing.events, a.routing.events > 0),
        mk(C, "gate_ledger_intact", true, a.ledgerChainValid, a.ledgerChainValid),
    ];
}
/** Orchestration report card (component 2). */
function orchestrationCard(a) {
    const assertions = assertOrchestration(a);
    const slices = a.state?.slices ?? [];
    const waves = (0, schedule_1.scheduleWaves)(slices);
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
