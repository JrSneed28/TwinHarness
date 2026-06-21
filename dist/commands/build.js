"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBuildPlan = runBuildPlan;
exports.runBuildNextWave = runBuildNextWave;
exports.runBuildDispatch = runBuildDispatch;
exports.runBuildClaim = runBuildClaim;
exports.runBuildRelease = runBuildRelease;
exports.runBuildSubClaim = runBuildSubClaim;
exports.runBuildSubRelease = runBuildSubRelease;
exports.runBuildLeases = runBuildLeases;
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const schedule_1 = require("../core/schedule");
const leases_1 = require("../core/leases");
const wave_1 = require("../core/wave");
const routing_1 = require("../core/routing");
const log_1 = require("../core/log");
const guards_1 = require("../core/guards");
const tier_1 = require("./tier");
/**
 * `th build plan [--include-done]` — schedule the slices into conflict-free
 * build waves. By default only unfinished slices (pending/in-progress/blocked)
 * are scheduled; `--include-done` schedules all of them.
 */
function runBuildPlan(paths, opts = {}) {
    const sr = (0, guards_1.requireState)(paths);
    if (sr.result)
        return sr.result;
    const state = sr.state;
    const selected = opts.includeDone
        ? state.slices
        : state.slices.filter((s) => s.status !== "done");
    const waves = (0, schedule_1.scheduleWaves)(selected);
    const conflicts = (0, schedule_1.conflictPairs)(selected);
    const parallelism = waves.reduce((max, w) => Math.max(max, w.length), 0);
    // Anchor: ARCH-001 — validate the `depends_on` graph alongside the static plan.
    // `scheduleWaves` orders waves by hard deps but silently tolerates an
    // unsatisfiable graph (it can't order a cycle, and a dangling ref names a slice
    // that doesn't exist); surface both here so a structurally-broken plan fails the
    // command instead of emitting a misleading "schedule" — mirroring how the live
    // next-wave/dispatch path reports cycles/dangling. Validate the FULL slice set
    // (not just `selected`): a dangling/cyclic edge is a plan defect regardless of
    // whether the planner happens to skip a `done` slice this run.
    const deps = (0, wave_1.validateDeps)(state.slices);
    const depIssues = (0, wave_1.hasDepIssues)(deps);
    (0, log_1.structuredLog)({
        cmd: "build plan",
        slices: selected.length,
        waves: waves.length,
        conflicts: conflicts.length,
        parallelism,
        depIssues,
    });
    const waveLines = waves.length
        ? waves.map((w, i) => `Wave ${i + 1} (parallel): ${w.join(", ")}`)
        : ["(no slices to schedule)"];
    const conflictLines = conflicts.length
        ? ["Serialized conflicts (shared components):", ...conflicts.map((c) => `  ${c.a} × ${c.b} (shared: ${c.shared.join(", ")})`)]
        : ["Serialized conflicts (shared components): (none)"];
    const adviseLines = opts.advise
        ? [
            "",
            `ADVISORY (parallelism optimizer, REQ-PCO-030): current max wave width = ${parallelism} ` +
                `across ${waves.length} wave${waves.length === 1 ? "" : "s"}; ` +
                `${conflicts.length} conflict pair${conflicts.length === 1 ? "" : "s"} serialize the plan. ` +
                `To widen build waves, re-cut slices to MINIMIZE shared components and depends_on edges ` +
                `(the coverage hard-gate and vertical-slice integrity stay unchanged).`,
        ]
        : [];
    // ARCH-001 — surface an unsatisfiable dependency graph in the human view (a
    // cycle deadlocks the build forever; a dangling ref names a slice that can
    // never go `done`). Same wording as the live next-wave/dispatch path.
    const depLines = [];
    for (const c of deps.cycles)
        depLines.push(`DEPENDENCY CYCLE: ${c.join(" → ")} → ${c[0]} (unsatisfiable — break the cycle in the plan)`);
    for (const d of deps.dangling)
        depLines.push(`DANGLING DEPENDENCY: ${d.slice} depends on unknown slice(s): ${d.missing.join(", ")}`);
    const depBlock = depIssues ? ["", ...depLines] : [];
    const human = [
        ...waveLines,
        "",
        ...conflictLines,
        "",
        "Within a wave Builders may run concurrently (§16); across waves they serialize.",
        ...adviseLines,
        ...depBlock,
    ].join("\n");
    const data = { waves, conflicts, parallelism, advise: opts.advise === true, deps, depIssues };
    // ARCH-001 — a structurally-broken dependency graph fails the command (exit 7):
    // the emitted wave order can't be honored (a cycle has no valid order; a
    // dangling dep can never complete), so it must not read as a clean plan. The
    // full plan data is still returned so `--json` consumers see both at once.
    if (depIssues) {
        return (0, output_1.failure)({ exitCode: 7, data: { ...data, error: "dependency_graph_unsatisfiable" }, human });
    }
    return (0, output_1.success)({ data, human });
}
/* ------------------------------------------------------------------ *
 * Live build coordination: next-wave oracle + dynamic component leases *
 * ------------------------------------------------------------------ */
/**
 * `th build next-wave` — the live wave-runner oracle. Returns the set of slices
 * that are dispatchable IN PARALLEL right now: status `pending`, all `depends_on`
 * slices `done`, and components free of (a) in-progress slices, (b) live leases,
 * and (c) each other within the wave. Held slices are reported with the reason
 * they wait. It also validates the dependency graph (cycles / dangling refs) and
 * flags a STALL — pending slices that can never dispatch with nothing running to
 * unblock them — so a deadlock surfaces instead of an empty wave forever.
 */
function runBuildNextWave(paths) {
    const sr = (0, guards_1.requireState)(paths);
    if (sr.result)
        return sr.result;
    const state = sr.state;
    const slices = state.slices;
    const anyInProgress = slices.some((s) => s.status === "in-progress");
    // "occupied" excludes stale leases (a finished/crashed slice never releases) so
    // a stale lease can't wedge the wave — see core/leases.ts occupiedComponents.
    const occupied = (0, leases_1.occupiedComponents)(paths, slices);
    const { wave, held, stalled } = (0, wave_1.computeWave)(slices, occupied, anyInProgress);
    const deps = (0, wave_1.validateDeps)(slices);
    (0, log_1.structuredLog)({ cmd: "build next-wave", dispatch: wave.length, held: held.length, stalled, depIssues: (0, wave_1.hasDepIssues)(deps) });
    const lines = [
        wave.length ? `Dispatch now (parallel): ${wave.join(", ")}` : "Dispatch now: (none ready)",
        ...(held.length
            ? ["Held:", ...held.map((h) => `  ${h.id} — ${h.reason}: ${h.detail.join(", ")}`)]
            : ["Held: (none)"]),
    ];
    for (const c of deps.cycles)
        lines.push(`DEPENDENCY CYCLE: ${c.join(" → ")} → ${c[0]} (unsatisfiable — break the cycle in the plan)`);
    for (const d of deps.dangling)
        lines.push(`DANGLING DEPENDENCY: ${d.slice} depends on unknown slice(s): ${d.missing.join(", ")}`);
    if (stalled)
        lines.push("STALLED: pending slices exist but none can dispatch and none are in progress — resolve the dependency/component deadlock above.");
    lines.push("", "Set each dispatched slice in-progress and `th build claim <ID>` before spawning its Builder.");
    return (0, output_1.success)({ data: { wave, held, stalled, deps }, human: lines.join("\n") });
}
/**
 * `th build dispatch` — the single-payload parallel-dispatch oracle (REQ-PCO-001).
 *
 * Where `th build next-wave` emits the dispatchable slice IDs, `dispatch` emits
 * the FULL spawn set in ONE payload so the Orchestrator can launch every wave
 * Builder in a single message (a single-message batch spawn) instead of round-
 * tripping per slice. It is a thin wrapper over the same live-wave computation
 * (`readState` → `occupiedComponents` → `computeWave`/`validateDeps`, identical to
 * {@link runBuildNextWave}) — it never recomputes or duplicates the wave logic;
 * it only enriches each dispatchable slice with a `{ model, effort }` spawn
 * recommendation from the §2 routing table ({@link computeRoute}).
 *
 * `data` = `{ wave: DispatchDescriptor[], held: [...with reasons...], warnings:
 * [...] }`. `warnings` carries the dependency-graph problems (cycles / dangling
 * refs) and a STALL note so a deadlock surfaces in the same payload rather than as
 * a silently empty wave. Per-slice routing uses the project-level blast-radius
 * flags as the Builder's `componentBlast` signal (the only blast signal readily
 * available at slice granularity — slice components are plain names, not flags),
 * so a blast-radius project escalates its Builders; a `note` records that scope.
 */
function runBuildDispatch(paths) {
    const sr = (0, guards_1.requireState)(paths);
    if (sr.result)
        return sr.result;
    const state = sr.state;
    const slices = state.slices;
    const anyInProgress = slices.some((s) => s.status === "in-progress");
    const occupied = (0, leases_1.occupiedComponents)(paths, slices);
    // Anchor: REQ-PCO-001 — reuse the next-wave computation; do NOT duplicate it.
    const { wave, held, stalled } = (0, wave_1.computeWave)(slices, occupied, anyInProgress);
    const deps = (0, wave_1.validateDeps)(slices);
    // Project-level blast flags drive Builder escalation (slice components are plain
    // names, not blast flags, so this is the readily-available component-blast signal).
    const componentBlast = state.blast_radius_flags.length > 0;
    const byId = new Map(slices.map((s) => [s.id, s]));
    const dispatch = wave.map((id) => {
        const slice = byId.get(id);
        const route = (0, routing_1.computeRoute)({
            agent: "builder",
            mode: "slice",
            tier: state.tier,
            blastFlags: state.blast_radius_flags,
            componentBlast,
        });
        return { sliceId: id, components: slice.components, model: route.model, effort: route.effort };
    });
    const warnings = [];
    for (const c of deps.cycles)
        warnings.push(`DEPENDENCY CYCLE: ${c.join(" → ")} → ${c[0]} (unsatisfiable — break the cycle in the plan)`);
    for (const d of deps.dangling)
        warnings.push(`DANGLING DEPENDENCY: ${d.slice} depends on unknown slice(s): ${d.missing.join(", ")}`);
    if (stalled)
        warnings.push("STALLED: pending slices exist but none can dispatch and none are in progress — resolve the dependency/component deadlock.");
    (0, log_1.structuredLog)({ cmd: "build dispatch", dispatch: dispatch.length, held: held.length, stalled, depIssues: (0, wave_1.hasDepIssues)(deps) });
    const lines = [
        dispatch.length
            ? "Dispatch now (spawn all in ONE message):"
            : "Dispatch now: (none ready)",
        ...dispatch.map((d) => `  ${d.sliceId} → ${d.model}/${d.effort} [${d.components.join(", ") || "(no components)"}]`),
        ...(held.length
            ? ["Held:", ...held.map((h) => `  ${h.id} — ${h.reason}: ${h.detail.join(", ")}`)]
            : ["Held: (none)"]),
        ...warnings,
        "",
        "Set each dispatched slice in-progress and `th build claim <ID>` before spawning its Builder.",
    ];
    return (0, output_1.success)({
        data: {
            wave: dispatch,
            held,
            warnings,
            note: "per-slice model/effort routes Builders via the §2 table; componentBlast reflects project-level blast_radius_flags",
        },
        human: lines.join("\n"),
    });
}
function leaseUsage(action) {
    return (0, output_1.failure)({ human: `usage: th build ${action} <SLICE-ID>` });
}
/**
 * `th build claim <SLICE-ID>` — take a live lease on the slice's components. The
 * collision guard: refuses (exit 1) if any component is already leased to a
 * DIFFERENT slice, even if the static plan thought them disjoint (drift can grow
 * a component set mid-build). Serialized under the state lock so two concurrent
 * claims can't both win an overlapping component.
 */
function runBuildClaim(paths, sliceId) {
    if (!sliceId)
        return leaseUsage("claim");
    return (0, state_store_1.withStateLock)(paths, () => {
        const sr = (0, guards_1.requireState)(paths);
        if (sr.result)
            return sr.result;
        const state = sr.state;
        const slice = state.slices.find((s) => s.id === sliceId);
        if (!slice) {
            return (0, output_1.failure)({ human: `Slice not found: ${sliceId}. Known: ${state.slices.map((s) => s.id).join(", ") || "(none)"}`, data: { error: "slice_not_found", sliceId } });
        }
        // A slice must be in-progress to hold a lease: the documented protocol is
        // "set in-progress, then claim" (mirrors runBuildSubClaim's parent check and
        // the Phase-B write-gate, which only grants writes to an in-progress slice's
        // components). A pending/done/blocked slice has no business holding components.
        if (slice.status !== "in-progress") {
            return (0, output_1.failure)({
                human: `Cannot claim ${sliceId}: it is "${slice.status}", not in-progress. Set it in-progress first (\`th slice set-status ${sliceId} in-progress\`), then claim (§16).`,
                data: { error: "slice_not_in_progress", sliceId, status: slice.status },
            });
        }
        // Only LIVE leases (held by a pending/in-progress slice) block a claim — a
        // stale lease from a done/blocked/crashed slice is ignored, not a permanent wall.
        const owners = new Map();
        for (const lease of (0, leases_1.liveLeases)(paths, state.slices)) {
            for (const c of lease.components)
                if (!owners.has(c))
                    owners.set(c, lease.slice);
        }
        const conflicts = slice.components
            .map((c) => ({ component: c, owner: owners.get(c) }))
            .filter((x) => x.owner !== undefined && x.owner !== sliceId);
        if (conflicts.length > 0) {
            return (0, output_1.failure)({
                human: `Cannot claim ${sliceId}: ${conflicts.map((c) => `${c.component} held by ${c.owner}`).join(", ")}. Serialize behind it (§16).`,
                data: { error: "lease_conflict", conflicts },
            });
        }
        (0, leases_1.appendLeaseEvent)(paths, { event: "claim", slice: sliceId, components: slice.components });
        (0, log_1.structuredLog)({ cmd: "build claim", slice: sliceId, components: slice.components });
        return (0, output_1.success)({ data: { slice: sliceId, components: slice.components }, human: `claimed ${sliceId}: ${slice.components.join(", ") || "(no components)"}` });
    });
}
/** `th build release <SLICE-ID>` — release the slice's lease (after it finishes/blocks). */
function runBuildRelease(paths, sliceId) {
    if (!sliceId)
        return leaseUsage("release");
    return (0, state_store_1.withStateLock)(paths, () => {
        const sr = (0, guards_1.requireState)(paths);
        if (sr.result)
            return sr.result;
        const held = (0, leases_1.activeLeases)(paths).find((l) => l.slice === sliceId);
        (0, leases_1.appendLeaseEvent)(paths, { event: "release", slice: sliceId, components: held?.components ?? [] });
        (0, log_1.structuredLog)({ cmd: "build release", slice: sliceId });
        return (0, output_1.success)({ data: { slice: sliceId, released: held?.components ?? [] }, human: `released ${sliceId}.` });
    });
}
/* ------------------------------------------------------------------ *
 * Sub-leases (Phase 5): a scoped sub-Builder works on a SUBSET of an  *
 * in-progress parent slice's components, nested under the parent's     *
 * already-held top-level lease.                                        *
 * ------------------------------------------------------------------ */
/**
 * `th build sub-claim <PARENT-SLICE> --components <c1,c2,...>` — open a SUB-lease
 * nested under an in-progress parent's top-level lease, scoping a sub-Builder to a
 * subset of the parent's components (Phase 5). The parent already holds those
 * components, so a plain `th build claim` would refuse them; the sub-lease instead
 * guards only against OVERLAPPING SIBLING sub-leases under the same parent (so two
 * concurrent sub-Builders can't touch the same component). Serialized under the
 * state lock — mirrors {@link runBuildClaim}'s collision-guard semantics.
 *
 *   - parent must exist and be `in-progress` (it holds the top-level lease), else
 *     `slice_not_found` / `parent_not_in_progress`.
 *   - `components` must be a non-empty SUBSET of the parent's declared components,
 *     else `not_a_subset`.
 *   - `components` must be DISJOINT from every LIVE sibling sub-lease, else
 *     `sub_lease_conflict` (exit 1).
 */
function runBuildSubClaim(paths, parentSlice, components) {
    const locked = (0, tier_1.assertFeatureUnlocked)(paths, "sub-lease");
    if (locked)
        return locked;
    if (!parentSlice)
        return (0, output_1.failure)({ human: "usage: th build sub-claim <PARENT-SLICE> --components <c1,c2,...>" });
    if (!components || components.length === 0) {
        return (0, output_1.failure)({ human: "usage: th build sub-claim <PARENT-SLICE> --components <c1,c2,...>", data: { error: "no_components" } });
    }
    return (0, state_store_1.withStateLock)(paths, () => {
        const sr = (0, guards_1.requireState)(paths);
        if (sr.result)
            return sr.result;
        const state = sr.state;
        const parent = state.slices.find((s) => s.id === parentSlice);
        if (!parent) {
            return (0, output_1.failure)({ human: `Parent slice not found: ${parentSlice}. Known: ${state.slices.map((s) => s.id).join(", ") || "(none)"}`, data: { error: "slice_not_found", parent: parentSlice } });
        }
        if (parent.status !== "in-progress") {
            return (0, output_1.failure)({
                human: `Cannot sub-claim under ${parentSlice}: it is "${parent.status}", not in-progress (the parent must hold the top-level lease).`,
                data: { error: "parent_not_in_progress", parent: parentSlice, status: parent.status },
            });
        }
        // Must be a non-empty SUBSET of the parent's declared components.
        const parentComponents = new Set(parent.components);
        const notInParent = components.filter((c) => !parentComponents.has(c));
        if (notInParent.length > 0) {
            return (0, output_1.failure)({
                human: `Cannot sub-claim under ${parentSlice}: ${notInParent.join(", ")} not in the parent's components (${parent.components.join(", ") || "(none)"}). A sub-lease must be a subset.`,
                data: { error: "not_a_subset", parent: parentSlice, requested: components, parentComponents: parent.components, extra: notInParent },
            });
        }
        // Must be DISJOINT from every LIVE sibling sub-lease under the same parent.
        // A sibling sub-lease is live exactly when the parent is in-progress (which it
        // is here), so the active sibling set is the live set — mirror runBuildClaim.
        const siblings = (0, leases_1.subLeasesOf)(paths, parentSlice);
        const live = new Set((0, leases_1.liveLeases)(paths, state.slices).map((l) => l.slice));
        const owners = new Map();
        for (const sib of siblings) {
            if (!live.has(sib.slice))
                continue; // ignore a released/stale sibling
            for (const c of sib.components)
                if (!owners.has(c))
                    owners.set(c, sib.slice);
        }
        const conflicts = components
            .map((c) => ({ component: c, owner: owners.get(c) }))
            .filter((x) => x.owner !== undefined);
        if (conflicts.length > 0) {
            return (0, output_1.failure)({
                exitCode: 1,
                human: `Cannot sub-claim under ${parentSlice}: ${conflicts.map((c) => `${c.component} held by sibling ${c.owner}`).join(", ")}. Serialize behind it.`,
                data: { error: "sub_lease_conflict", parent: parentSlice, conflicts },
            });
        }
        // Generate a unique sub-owner id: `${parent}#sub-${n}`, n = existing sub-leases + 1.
        // Count by distinct sub-owner ids ever opened under this parent (claims +
        // releases), so a re-claim after a release never reuses a retired id.
        const everSubIds = new Set(readLeaseEventsForParent(paths, parentSlice));
        const subId = `${parentSlice}#sub-${everSubIds.size + 1}`;
        (0, leases_1.appendLeaseEvent)(paths, { event: "claim", slice: subId, components, parent: parentSlice });
        (0, log_1.structuredLog)({ cmd: "build sub-claim", subId, parent: parentSlice, components });
        return (0, output_1.success)({
            data: { subId, parent: parentSlice, components },
            human: `sub-claimed ${subId} under ${parentSlice}: ${components.join(", ")}`,
        });
    });
}
/**
 * `th build sub-release <SUB-ID>` — close a sub-lease. Verifies the id names an
 * ACTIVE sub-lease (a claim with a `parent`, not yet released), then appends a
 * `release` event. A parent reaching done/blocked already makes its sub-leases
 * STALE via reconciliation (no extra auto-release), so this is the explicit
 * "sub-Builder finished cleanly" path.
 */
function runBuildSubRelease(paths, subId) {
    const locked = (0, tier_1.assertFeatureUnlocked)(paths, "sub-lease");
    if (locked)
        return locked;
    if (!subId)
        return (0, output_1.failure)({ human: "usage: th build sub-release <SUB-ID>" });
    return (0, state_store_1.withStateLock)(paths, () => {
        const sr = (0, guards_1.requireState)(paths);
        if (sr.result)
            return sr.result;
        const held = (0, leases_1.activeLeases)(paths).find((l) => l.slice === subId && l.parent !== undefined);
        if (!held) {
            return (0, output_1.failure)({
                human: `No active sub-lease: ${subId}. Active sub-leases: ${(0, leases_1.activeLeases)(paths).filter((l) => l.parent !== undefined).map((l) => l.slice).join(", ") || "(none)"}`,
                data: { error: "sub_lease_not_found", subId },
            });
        }
        (0, leases_1.appendLeaseEvent)(paths, { event: "release", slice: subId, components: held.components, parent: held.parent });
        (0, log_1.structuredLog)({ cmd: "build sub-release", subId, parent: held.parent });
        return (0, output_1.success)({ data: { subId, parent: held.parent, released: held.components }, human: `released sub-lease ${subId}.` });
    });
}
/** Distinct sub-owner ids ever opened under `parentSlice` (claim events), for id minting. */
function readLeaseEventsForParent(paths, parentSlice) {
    const ids = new Set();
    for (const e of (0, leases_1.readLeaseEvents)(paths)) {
        if (e.event === "claim" && e.parent === parentSlice)
            ids.add(e.slice);
    }
    return [...ids];
}
/**
 * `th build leases` — list the live component leases, reconciled against slice
 * state. Leases whose owning slice has settled (done/blocked) or vanished are
 * reported separately as STALE so they can be cleaned up (`th build release`),
 * rather than silently occupying components.
 */
function runBuildLeases(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    // Without valid state we cannot reconcile; fall back to the raw active set.
    if (!r.state) {
        const leases = (0, leases_1.activeLeases)(paths);
        const human = leases.length ? leases.map((l) => `${l.slice}: ${l.components.join(", ") || "(no components)"}`).join("\n") : "(no active leases)";
        return (0, output_1.success)({ data: { leases, stale: [] }, human });
    }
    const live = (0, leases_1.liveLeases)(paths, r.state.slices);
    const stale = (0, leases_1.staleLeases)(paths, r.state.slices);
    // liveLeases/staleLeases reconcile top-level AND sub-leases together (a sub-lease
    // against its parent); split them so each kind reports in a labeled section.
    const isSub = (l) => l.parent !== undefined;
    const liveTop = live.filter((l) => !isSub(l));
    const liveSub = live.filter(isSub);
    const staleTop = stale.filter((l) => !isSub(l));
    const staleSub = stale.filter(isSub);
    const lines = [];
    lines.push(liveTop.length ? "Live leases:" : "Live leases: (none)");
    for (const l of liveTop)
        lines.push(`  ${l.slice}: ${l.components.join(", ") || "(no components)"}`);
    lines.push(liveSub.length ? "Live sub-leases:" : "Live sub-leases: (none)");
    for (const l of liveSub)
        lines.push(`  ${l.slice} (under ${l.parent}): ${l.components.join(", ") || "(no components)"}`);
    if (staleTop.length) {
        lines.push("STALE leases (owning slice is done/blocked/missing — `th build release <ID>` to clear):");
        for (const l of staleTop)
            lines.push(`  ${l.slice}: ${l.components.join(", ")}`);
    }
    if (staleSub.length) {
        lines.push("STALE sub-leases (parent slice is done/blocked/missing — `th build sub-release <ID>` to clear):");
        for (const l of staleSub)
            lines.push(`  ${l.slice} (under ${l.parent}): ${l.components.join(", ")}`);
    }
    return (0, output_1.success)({ data: { leases: liveTop, subLeases: liveSub, stale: staleTop, staleSubLeases: staleSub }, human: lines.join("\n") });
}
