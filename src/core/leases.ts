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

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import type { SliceState } from "./state-schema";

export interface LeaseEvent {
  /** ISO-8601 UTC timestamp (audit record — intentionally clock-bearing). */
  ts: string;
  event: "claim" | "release";
  slice: string;
  /** Components claimed/released (recorded on claim; informational on release). */
  components: string[];
}

/** `<stateDir>/build-leases.jsonl` — the lease ledger's location. */
export function leasesPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "build-leases.jsonl");
}

/** Read + parse every lease event. Missing file → empty. Bad lines skipped. */
export function readLeaseEvents(paths: ProjectPaths): LeaseEvent[] {
  const file = leasesPath(paths);
  if (!fs.existsSync(file)) return [];
  const out: LeaseEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as LeaseEvent;
      if (parsed && (parsed.event === "claim" || parsed.event === "release") && typeof parsed.slice === "string") {
        out.push({ ...parsed, components: Array.isArray(parsed.components) ? parsed.components : [] });
      }
    } catch {
      // Tolerant: skip malformed lines.
    }
  }
  return out;
}

/** Append one lease event. Clock-injectable for deterministic tests. */
export function appendLeaseEvent(
  paths: ProjectPaths,
  event: Omit<LeaseEvent, "ts">,
  now: () => Date = () => new Date(),
): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const line = JSON.stringify({ ts: now().toISOString(), ...event }) + "\n";
  fs.appendFileSync(leasesPath(paths), line, "utf8");
}

export interface ActiveLease {
  slice: string;
  components: string[];
}

/**
 * Reduce the event log to the currently-held leases: a `claim` opens a lease for
 * a slice; a later `release` for that slice closes it. The last event per slice
 * wins, so a re-claim after release re-opens with the new component set.
 */
export function activeLeases(paths: ProjectPaths): ActiveLease[] {
  const bySlice = new Map<string, string[] | null>(); // null = released
  for (const e of readLeaseEvents(paths)) {
    bySlice.set(e.slice, e.event === "claim" ? e.components : null);
  }
  const out: ActiveLease[] = [];
  for (const [slice, components] of bySlice) {
    if (components !== null) out.push({ slice, components });
  }
  return out;
}

/**
 * Map of component → slice that currently holds it (from {@link activeLeases}).
 * The first claimant of a component owns it (claims that would overlap are
 * refused at claim time, so in practice each component maps to one slice).
 */
export function leasedComponents(paths: ProjectPaths): Map<string, string> {
  const map = new Map<string, string>();
  for (const lease of activeLeases(paths)) {
    for (const c of lease.components) {
      if (!map.has(c)) map.set(c, lease.slice);
    }
  }
  return map;
}

type SliceLike = Pick<SliceState, "id" | "status">;

/** A slice still owes work iff it's pending or in-progress; done/blocked/absent do not. */
function isLiveSlice(status: string | undefined): boolean {
  return status === "pending" || status === "in-progress";
}

/**
 * The leases that should still hold components, reconciled against slice state: a
 * lease whose owning slice has reached `done`/`blocked` — or no longer exists —
 * is STALE (a Builder that crashed or finished without `th build release`) and is
 * dropped. This is the safety net that stops a stale lease from wedging the build
 * forever even when the explicit release never ran.
 */
export function liveLeases(paths: ProjectPaths, slices: SliceLike[]): ActiveLease[] {
  const statusById = new Map(slices.map((s) => [s.id, s.status]));
  return activeLeases(paths).filter((l) => isLiveSlice(statusById.get(l.slice)));
}

/** The complement of {@link liveLeases}: leases held by a settled/missing slice. */
export function staleLeases(paths: ProjectPaths, slices: SliceLike[]): ActiveLease[] {
  const statusById = new Map(slices.map((s) => [s.id, s.status]));
  return activeLeases(paths).filter((l) => !isLiveSlice(statusById.get(l.slice)));
}

/**
 * Component → owning slice, combining in-progress slices and reconciled live
 * leases (stale leases excluded). This is the "occupied" map the live wave-runner
 * consults; the first owner of a component wins.
 */
export function occupiedComponents(paths: ProjectPaths, slices: SliceState[]): Map<string, string> {
  const occ = new Map<string, string>();
  for (const s of slices) {
    if (s.status === "in-progress") for (const c of s.components) if (!occ.has(c)) occ.set(c, s.id);
  }
  for (const lease of liveLeases(paths, slices)) {
    for (const c of lease.components) if (!occ.has(c)) occ.set(c, lease.slice);
  }
  return occ;
}
