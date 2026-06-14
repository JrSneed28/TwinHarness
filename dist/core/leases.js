"use strict";
/**
 * Dynamic component leases for safe parallel builds (spec §16, extended).
 *
 * `th build plan` schedules slices into conflict-free waves from the *static*
 * plan. But a slice's component set can grow mid-build (drift expands what it
 * touches), so two slices the plan thought disjoint can start colliding. A lease
 * is a *live* claim: while slice A holds a lease on component `auth`, no other
 * slice may claim `auth`. `th build claim` enforces this mechanically (it refuses
 * an overlapping claim); `th build next-wave` consults live leases so it never
 * dispatches a slice whose components are already held.
 *
 * The ledger is append-only JSONL next to the state it guards
 * (`<stateDir>/build-leases.jsonl`), one event per line, mirroring the gate
 * ledger. It records and computes; it never decides which Builder runs.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.leasesPath = leasesPath;
exports.readLeaseEvents = readLeaseEvents;
exports.appendLeaseEvent = appendLeaseEvent;
exports.activeLeases = activeLeases;
exports.activeTopLeases = activeTopLeases;
exports.subLeasesOf = subLeasesOf;
exports.leasedComponents = leasedComponents;
exports.liveLeases = liveLeases;
exports.staleLeases = staleLeases;
exports.occupiedComponents = occupiedComponents;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/** `<stateDir>/build-leases.jsonl` — the lease ledger's location. */
function leasesPath(paths) {
    return path.join(paths.stateDir, "build-leases.jsonl");
}
/** Read + parse every lease event. Missing file → empty. Bad lines skipped. */
function readLeaseEvents(paths) {
    const file = leasesPath(paths);
    if (!fs.existsSync(file))
        return [];
    const out = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && (parsed.event === "claim" || parsed.event === "release") && typeof parsed.slice === "string") {
                const ev = { ...parsed, components: Array.isArray(parsed.components) ? parsed.components : [] };
                // Carry `parent` only when it's a real string; otherwise drop the key so a
                // top-level lease round-trips without an undefined/null parent field.
                if (typeof parsed.parent === "string")
                    ev.parent = parsed.parent;
                else
                    delete ev.parent;
                out.push(ev);
            }
        }
        catch {
            // Tolerant: skip malformed lines.
        }
    }
    return out;
}
/** Append one lease event. Clock-injectable for deterministic tests. */
function appendLeaseEvent(paths, event, now = () => new Date()) {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    // JSON.stringify drops `undefined`-valued keys, so a top-level lease (no
    // `parent`) serializes byte-identically to the pre-sub-lease format; only a
    // sub-lease (parent set to a string) carries the extra field.
    const line = JSON.stringify({ ts: now().toISOString(), ...event }) + "\n";
    fs.appendFileSync(leasesPath(paths), line, "utf8");
}
/**
 * Reduce the event log to the currently-held leases: a `claim` opens a lease for
 * a slice; a later `release` for that slice closes it. The last event per slice
 * wins, so a re-claim after release re-opens with the new component set. The
 * `slice` key is the (unique) owner id — for a sub-lease that is the sub-owner
 * id, so a sub-lease reduces independently of its parent's top-level lease.
 */
function activeLeases(paths) {
    // Track the latest claim's components AND parent per owner id; null = released.
    const byOwner = new Map();
    for (const e of readLeaseEvents(paths)) {
        byOwner.set(e.slice, e.event === "claim" ? { components: e.components, parent: e.parent } : null);
    }
    const out = [];
    for (const [slice, held] of byOwner) {
        if (held === null)
            continue;
        const lease = { slice, components: held.components };
        if (typeof held.parent === "string")
            lease.parent = held.parent;
        out.push(lease);
    }
    return out;
}
/** Active TOP-LEVEL leases only (no `parent`) — the original lease semantics. */
function activeTopLeases(paths) {
    return activeLeases(paths).filter((l) => l.parent === undefined);
}
/** Active SUB-leases nested under `parentSlice` (the sibling set for a parent). */
function subLeasesOf(paths, parentSlice) {
    return activeLeases(paths).filter((l) => l.parent === parentSlice);
}
/**
 * Map of component → slice that currently holds it (from {@link activeLeases}).
 * The first claimant of a component owns it (claims that would overlap are
 * refused at claim time, so in practice each component maps to one slice).
 */
function leasedComponents(paths) {
    const map = new Map();
    for (const lease of activeLeases(paths)) {
        for (const c of lease.components) {
            if (!map.has(c))
                map.set(c, lease.slice);
        }
    }
    return map;
}
/** A slice still owes work iff it's pending or in-progress; done/blocked/absent do not. */
function isLiveSlice(status) {
    return status === "pending" || status === "in-progress";
}
/**
 * Whether a single lease is LIVE, reconciled against the relevant slice's status:
 *   - top-level lease (no `parent`): live iff the slice named by `l.slice` is
 *     pending/in-progress — the original rule.
 *   - sub-lease (has `parent`): live iff the PARENT slice is pending/in-progress.
 *     The sub-owner id is never a real slice, so reconciling it against itself
 *     would always read `undefined`; a sub-lease's lifetime is its parent's.
 * Either way, a settled (done/blocked) or missing governing slice ⇒ STALE.
 */
function isLeaseLive(lease, statusById) {
    const governing = lease.parent ?? lease.slice;
    return isLiveSlice(statusById.get(governing));
}
/**
 * The leases that should still hold components, reconciled against slice state: a
 * lease whose governing slice has reached `done`/`blocked` — or no longer exists —
 * is STALE (a Builder that crashed or finished without `th build release`) and is
 * dropped. This is the safety net that stops a stale lease from wedging the build
 * forever even when the explicit release never ran. A SUB-lease is reconciled
 * against its PARENT slice (so the parent settling makes all its sub-leases stale
 * with no extra auto-release step); a top-level lease against itself.
 */
function liveLeases(paths, slices) {
    const statusById = new Map(slices.map((s) => [s.id, s.status]));
    return activeLeases(paths).filter((l) => isLeaseLive(l, statusById));
}
/** The complement of {@link liveLeases}: leases held by a settled/missing governing slice. */
function staleLeases(paths, slices) {
    const statusById = new Map(slices.map((s) => [s.id, s.status]));
    return activeLeases(paths).filter((l) => !isLeaseLive(l, statusById));
}
/**
 * Component → owning id, combining in-progress slices and reconciled live leases
 * (stale leases excluded). This is the "occupied" map the live wave-runner
 * consults; the first owner of a component wins. Live SUB-leases are included via
 * {@link liveLeases} (which reconciles them against their parent), so a live
 * sub-lease's components count as occupied — mapped to the sub-owner id when no
 * in-progress slice already claims them.
 */
function occupiedComponents(paths, slices) {
    const occ = new Map();
    for (const s of slices) {
        if (s.status === "in-progress")
            for (const c of s.components)
                if (!occ.has(c))
                    occ.set(c, s.id);
    }
    for (const lease of liveLeases(paths, slices)) {
        for (const c of lease.components)
            if (!occ.has(c))
                occ.set(c, lease.slice);
    }
    return occ;
}
