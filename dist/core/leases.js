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
                out.push({ ...parsed, components: Array.isArray(parsed.components) ? parsed.components : [] });
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
    const line = JSON.stringify({ ts: now().toISOString(), ...event }) + "\n";
    fs.appendFileSync(leasesPath(paths), line, "utf8");
}
/**
 * Reduce the event log to the currently-held leases: a `claim` opens a lease for
 * a slice; a later `release` for that slice closes it. The last event per slice
 * wins, so a re-claim after release re-opens with the new component set.
 */
function activeLeases(paths) {
    const bySlice = new Map(); // null = released
    for (const e of readLeaseEvents(paths)) {
        bySlice.set(e.slice, e.event === "claim" ? e.components : null);
    }
    const out = [];
    for (const [slice, components] of bySlice) {
        if (components !== null)
            out.push({ slice, components });
    }
    return out;
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
 * The leases that should still hold components, reconciled against slice state: a
 * lease whose owning slice has reached `done`/`blocked` — or no longer exists —
 * is STALE (a Builder that crashed or finished without `th build release`) and is
 * dropped. This is the safety net that stops a stale lease from wedging the build
 * forever even when the explicit release never ran.
 */
function liveLeases(paths, slices) {
    const statusById = new Map(slices.map((s) => [s.id, s.status]));
    return activeLeases(paths).filter((l) => isLiveSlice(statusById.get(l.slice)));
}
/** The complement of {@link liveLeases}: leases held by a settled/missing slice. */
function staleLeases(paths, slices) {
    const statusById = new Map(slices.map((s) => [s.id, s.status]));
    return activeLeases(paths).filter((l) => !isLiveSlice(statusById.get(l.slice)));
}
/**
 * Component → owning slice, combining in-progress slices and reconciled live
 * leases (stale leases excluded). This is the "occupied" map the live wave-runner
 * consults; the first owner of a component wins.
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
