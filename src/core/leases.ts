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
