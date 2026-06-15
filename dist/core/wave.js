"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeWave = computeWave;
exports.hasDepIssues = hasDepIssues;
exports.validateDeps = validateDeps;
/**
 * Compute the dispatchable wave. `occupied` maps a component to the slice that
 * currently owns it (in-progress slices + live leases); a component is busy for a
 * candidate only when owned by a DIFFERENT slice (a slice never blocks itself).
 * `anyInProgress` tells us whether something running could free components later,
 * which distinguishes "waiting" (not stalled) from a true deadlock.
 */
function computeWave(slices, occupied, anyInProgress) {
    const statusById = new Map(slices.map((s) => [s.id, s.status]));
    const wave = [];
    const claimedInWave = new Set();
    const held = [];
    let pending = 0;
    for (const s of slices) {
        if (s.status !== "pending")
            continue;
        pending++;
        // HARD deps (`depends_on`) gate as always: every one must be `done` before
        // the slice can dispatch. `depends_on_soft` deliberately does NOT gate —
        // soft (interface-only) deps may still be pending and the slice is dispatched
        // SPECULATIVELY against the upstream contract (REQ-PCO-070); a bad speculation
        // is caught downstream by the merge-conflict-as-BLOCKING-drift backstop. So a
        // slice's dispatchability depends ONLY on its HARD deps here, and a slice with
        // no depends_on_soft is wholly unaffected.
        const unmet = (s.depends_on ?? []).filter((d) => statusById.get(d) !== "done");
        if (unmet.length > 0) {
            held.push({ id: s.id, reason: "dependency", detail: unmet });
            continue;
        }
        const conflicts = s.components.filter((c) => {
            const owner = occupied.get(c);
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
    const stalled = pending > 0 && wave.length === 0 && !anyInProgress;
    return { wave, held, stalled };
}
/** True when there is any dependency problem worth surfacing. */
function hasDepIssues(d) {
    return d.dangling.length > 0 || d.cycles.length > 0;
}
/**
 * Validate the `depends_on` graph: report dangling references (a dep on a slice
 * that doesn't exist) and cycles (which deadlock `next-wave` forever). Pure DFS
 * with a GRAY/BLACK coloring; dangling edges are excluded from cycle search.
 */
function validateDeps(slices) {
    const ids = new Set(slices.map((s) => s.id));
    const dangling = [];
    for (const s of slices) {
        const missing = (s.depends_on ?? []).filter((d) => !ids.has(d));
        if (missing.length > 0)
            dangling.push({ slice: s.id, missing });
    }
    const adj = new Map(slices.map((s) => [s.id, (s.depends_on ?? []).filter((d) => ids.has(d))]));
    const cycles = [];
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    const stack = [];
    const visit = (u) => {
        color.set(u, GRAY);
        stack.push(u);
        for (const v of adj.get(u) ?? []) {
            const c = color.get(v) ?? WHITE;
            if (c === WHITE)
                visit(v);
            else if (c === GRAY) {
                const i = stack.indexOf(v);
                if (i >= 0)
                    cycles.push(stack.slice(i));
            }
        }
        stack.pop();
        color.set(u, BLACK);
    };
    for (const s of slices)
        if ((color.get(s.id) ?? WHITE) === WHITE)
            visit(s.id);
    return { dangling, cycles };
}
