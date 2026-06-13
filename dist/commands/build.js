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
const log_1 = require("../core/log");
/**
 * `th build plan` — the mechanical parallel-build serializer (spec §16; build
 * plan §4 Slice 7 (b)). It computes a deterministic wave schedule over the
 * slices: disjoint-component slices share a wave (Builders may run concurrently),
 * shared-component slices are split across waves (serialized to avoid merge
 * conflicts / drift races). Pure traceability arithmetic over `state.slices` —
 * it never decides *whether* a Builder runs, only the conflict-free ordering.
 */
function formatIssues(issues) {
    return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}
const NOT_INIT = (0, output_1.failure)({
    human: "No state.json found. Run `th init` first.",
    data: { error: "not_initialized" },
});
/**
 * `th build plan [--include-done]` — schedule the slices into conflict-free
 * build waves. By default only unfinished slices (pending/in-progress/blocked)
 * are scheduled; `--include-done` schedules all of them.
 */
function runBuildPlan(paths, opts = {}) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid:\n${formatIssues(r.issues)}`,
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
/**
 * `th build next-wave` — the live wave-runner oracle. Returns the set of slices
 * that are dispatchable IN PARALLEL right now: status `pending`, all `depends_on`
 * slices `done`, and components free of (a) in-progress slices, (b) active
 * leases, and (c) each other within the wave. The held slices are reported with
 * the reason they wait (unmet dependency or a component conflict). Reuses the
 * §16 disjointness rule but over the *current* run state, not the static plan.
 */
function runBuildNextWave(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
    }
    const slices = r.state.slices;
    const statusById = new Map(slices.map((s) => [s.id, s.status]));
    // Component → the slice that currently occupies it: an in-progress slice owns
    // its components; an active lease owns its components. A component is busy FOR a
    // candidate only when occupied by a DIFFERENT slice (a slice never blocks itself).
    const ownerByComponent = new Map();
    for (const s of slices)
        if (s.status === "in-progress")
            for (const c of s.components)
                if (!ownerByComponent.has(c))
                    ownerByComponent.set(c, s.id);
    for (const [component, owner] of (0, leases_1.leasedComponents)(paths))
        if (!ownerByComponent.has(component))
            ownerByComponent.set(component, owner);
    const wave = [];
    const claimedInWave = new Set();
    const held = [];
    for (const s of slices) {
        if (s.status !== "pending")
            continue;
        // Dependency gate: every declared dependency must be done.
        const unmet = (s.depends_on ?? []).filter((d) => statusById.get(d) !== "done");
        if (unmet.length > 0) {
            held.push({ id: s.id, reason: "dependency", detail: unmet });
            continue;
        }
        // Component gate: free of components owned by another slice AND of components
        // already taken earlier in this same wave.
        const conflicts = s.components.filter((c) => {
            const owner = ownerByComponent.get(c);
            return (owner !== undefined && owner !== s.id) || claimedInWave.has(c);
        });
        if (conflicts.length > 0) {
            held.push({ id: s.id, reason: "component-conflict", detail: conflicts });
            continue;
        }
        wave.push(s.id);
        for (const c of s.components)
            claimedInWave.add(c);
    }
    (0, log_1.structuredLog)({ cmd: "build next-wave", dispatch: wave.length, held: held.length });
    const human = [
        wave.length ? `Dispatch now (parallel): ${wave.join(", ")}` : "Dispatch now: (none ready)",
        ...(held.length
            ? ["Held:", ...held.map((h) => `  ${h.id} — ${h.reason}: ${h.detail.join(", ")}`)]
            : ["Held: (none)"]),
        "",
        "Set each dispatched slice in-progress and `th build claim <ID>` before spawning its Builder.",
    ].join("\n");
    return (0, output_1.success)({ data: { wave, held }, human });
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
            return NOT_INIT;
        if (!r.state)
            return (0, output_1.failure)({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
        const slice = r.state.slices.find((s) => s.id === sliceId);
        if (!slice) {
            return (0, output_1.failure)({ human: `Slice not found: ${sliceId}. Known: ${r.state.slices.map((s) => s.id).join(", ") || "(none)"}`, data: { error: "slice_not_found", sliceId } });
        }
        const owners = (0, leases_1.leasedComponents)(paths);
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
            return NOT_INIT;
        if (!r.state)
            return (0, output_1.failure)({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
        const held = (0, leases_1.activeLeases)(paths).find((l) => l.slice === sliceId);
        (0, leases_1.appendLeaseEvent)(paths, { event: "release", slice: sliceId, components: held?.components ?? [] });
        (0, log_1.structuredLog)({ cmd: "build release", slice: sliceId });
        return (0, output_1.success)({ data: { slice: sliceId, released: held?.components ?? [] }, human: `released ${sliceId}.` });
    });
}
/** `th build leases` — list the live component leases. */
function runBuildLeases(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return NOT_INIT;
    const leases = (0, leases_1.activeLeases)(paths);
    const human = leases.length
        ? leases.map((l) => `${l.slice}: ${l.components.join(", ") || "(no components)"}`).join("\n")
        : "(no active leases)";
    return (0, output_1.success)({ data: { leases }, human });
}
