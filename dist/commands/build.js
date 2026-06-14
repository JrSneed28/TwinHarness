"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBuildPlan = runBuildPlan;
exports.runBuildNextWave = runBuildNextWave;
exports.runBuildClaim = runBuildClaim;
exports.runBuildRelease = runBuildRelease;
exports.runBuildLeases = runBuildLeases;
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const schedule_1 = require("../core/schedule");
const leases_1 = require("../core/leases");
const wave_1 = require("../core/wave");
const log_1 = require("../core/log");
const guards_1 = require("../core/guards");
/**
 * `th build plan [--include-done]` — schedule the slices into conflict-free
 * build waves. By default only unfinished slices (pending/in-progress/blocked)
 * are scheduled; `--include-done` schedules all of them.
 */
function runBuildPlan(paths, opts = {}) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid:\n${(0, guards_1.formatIssues)(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const selected = opts.includeDone
        ? r.state.slices
        : r.state.slices.filter((s) => s.status !== "done");
    const waves = (0, schedule_1.scheduleWaves)(selected);
    const conflicts = (0, schedule_1.conflictPairs)(selected);
    const parallelism = waves.reduce((max, w) => Math.max(max, w.length), 0);
    (0, log_1.structuredLog)({
        cmd: "build plan",
        slices: selected.length,
        waves: waves.length,
        conflicts: conflicts.length,
        parallelism,
    });
    const waveLines = waves.length
        ? waves.map((w, i) => `Wave ${i + 1} (parallel): ${w.join(", ")}`)
        : ["(no slices to schedule)"];
    const conflictLines = conflicts.length
        ? ["Serialized conflicts (shared components):", ...conflicts.map((c) => `  ${c.a} × ${c.b} (shared: ${c.shared.join(", ")})`)]
        : ["Serialized conflicts (shared components): (none)"];
    const human = [
        ...waveLines,
        "",
        ...conflictLines,
        "",
        "Within a wave Builders may run concurrently (§16); across waves they serialize.",
    ].join("\n");
    return (0, output_1.success)({ data: { waves, conflicts, parallelism }, human });
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
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({ human: `state.json is invalid:\n${(0, guards_1.formatIssues)(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
    }
    const slices = r.state.slices;
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
        const r = (0, state_store_1.readState)(paths);
        if (!r.exists)
            return guards_1.NOT_INIT;
        if (!r.state)
            return (0, output_1.failure)({ human: `state.json is invalid:\n${(0, guards_1.formatIssues)(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
        const slice = r.state.slices.find((s) => s.id === sliceId);
        if (!slice) {
            return (0, output_1.failure)({ human: `Slice not found: ${sliceId}. Known: ${r.state.slices.map((s) => s.id).join(", ") || "(none)"}`, data: { error: "slice_not_found", sliceId } });
        }
        // Only LIVE leases (held by a pending/in-progress slice) block a claim — a
        // stale lease from a done/blocked/crashed slice is ignored, not a permanent wall.
        const owners = new Map();
        for (const lease of (0, leases_1.liveLeases)(paths, r.state.slices)) {
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
        const r = (0, state_store_1.readState)(paths);
        if (!r.exists)
            return guards_1.NOT_INIT;
        if (!r.state)
            return (0, output_1.failure)({ human: `state.json is invalid:\n${(0, guards_1.formatIssues)(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
        const held = (0, leases_1.activeLeases)(paths).find((l) => l.slice === sliceId);
        (0, leases_1.appendLeaseEvent)(paths, { event: "release", slice: sliceId, components: held?.components ?? [] });
        (0, log_1.structuredLog)({ cmd: "build release", slice: sliceId });
        return (0, output_1.success)({ data: { slice: sliceId, released: held?.components ?? [] }, human: `released ${sliceId}.` });
    });
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
    const lines = [];
    lines.push(live.length ? "Live leases:" : "Live leases: (none)");
    for (const l of live)
        lines.push(`  ${l.slice}: ${l.components.join(", ") || "(no components)"}`);
    if (stale.length) {
        lines.push("STALE leases (owning slice is done/blocked/missing — `th build release <ID>` to clear):");
        for (const l of stale)
            lines.push(`  ${l.slice}: ${l.components.join(", ")}`);
    }
    return (0, output_1.success)({ data: { leases: live, stale }, human: lines.join("\n") });
}
