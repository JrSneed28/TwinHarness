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
  /**
   * For a SUB-lease (Phase 5 scoped sub-Builder): the PARENT slice id whose
   * already-held top-level lease this nests under. `slice` is then a unique
   * sub-owner id, and the sub-lease is reconciled against the PARENT's status
   * (not its own — a sub-owner id is never a real slice). ADDITIVE and
   * backward-compatible: absent for every top-level lease, and omitted from the
   * serialized JSONL when undefined so existing top-level lease lines stay
   * byte-identical (mirrors the optional-field convention in state-schema.ts).
   */
  parent?: string;
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
        const ev: LeaseEvent = { ...parsed, components: Array.isArray(parsed.components) ? parsed.components : [] };
        // Carry `parent` only when it's a real string; otherwise drop the key so a
        // top-level lease round-trips without an undefined/null parent field.
        if (typeof parsed.parent === "string") ev.parent = parsed.parent;
        else delete ev.parent;
        out.push(ev);
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
  // JSON.stringify drops `undefined`-valued keys, so a top-level lease (no
  // `parent`) serializes byte-identically to the pre-sub-lease format; only a
  // sub-lease (parent set to a string) carries the extra field.
  const line = JSON.stringify({ ts: now().toISOString(), ...event }) + "\n";
  fs.appendFileSync(leasesPath(paths), line, "utf8");
}

export interface ActiveLease {
  /** Top-level: the slice id. Sub-lease: the unique sub-owner id. */
  slice: string;
  components: string[];
  /** Present only for a sub-lease — the parent slice id it nests under. */
  parent?: string;
}

/**
 * Reduce the event log to the currently-held leases: a `claim` opens a lease for
 * a slice; a later `release` for that slice closes it. The last event per slice
 * wins, so a re-claim after release re-opens with the new component set. The
 * `slice` key is the (unique) owner id — for a sub-lease that is the sub-owner
 * id, so a sub-lease reduces independently of its parent's top-level lease.
 */
export function activeLeases(paths: ProjectPaths): ActiveLease[] {
  // Track the latest claim's components AND parent per owner id; null = released.
  const byOwner = new Map<string, { components: string[]; parent?: string } | null>();
  for (const e of readLeaseEvents(paths)) {
    byOwner.set(e.slice, e.event === "claim" ? { components: e.components, parent: e.parent } : null);
  }
  const out: ActiveLease[] = [];
  for (const [slice, held] of byOwner) {
    if (held === null) continue;
    const lease: ActiveLease = { slice, components: held.components };
    if (typeof held.parent === "string") lease.parent = held.parent;
    out.push(lease);
  }
  return out;
}

/** Active TOP-LEVEL leases only (no `parent`) — the original lease semantics. */
export function activeTopLeases(paths: ProjectPaths): ActiveLease[] {
  return activeLeases(paths).filter((l) => l.parent === undefined);
}

/** Active SUB-leases nested under `parentSlice` (the sibling set for a parent). */
export function subLeasesOf(paths: ProjectPaths, parentSlice: string): ActiveLease[] {
  return activeLeases(paths).filter((l) => l.parent === parentSlice);
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
 * Whether a single lease is LIVE, reconciled against the relevant slice's status:
 *   - top-level lease (no `parent`): live iff the slice named by `l.slice` is
 *     pending/in-progress — the original rule.
 *   - sub-lease (has `parent`): live iff the PARENT slice is pending/in-progress.
 *     The sub-owner id is never a real slice, so reconciling it against itself
 *     would always read `undefined`; a sub-lease's lifetime is its parent's.
 * Either way, a settled (done/blocked) or missing governing slice ⇒ STALE.
 */
function isLeaseLive(lease: ActiveLease, statusById: Map<string, SliceStatusValue>): boolean {
  const governing = lease.parent ?? lease.slice;
  return isLiveSlice(statusById.get(governing));
}

type SliceStatusValue = SliceLike["status"];

/**
 * The leases that should still hold components, reconciled against slice state: a
 * lease whose governing slice has reached `done`/`blocked` — or no longer exists —
 * is STALE (a Builder that crashed or finished without `th build release`) and is
 * dropped. This is the safety net that stops a stale lease from wedging the build
 * forever even when the explicit release never ran. A SUB-lease is reconciled
 * against its PARENT slice (so the parent settling makes all its sub-leases stale
 * with no extra auto-release step); a top-level lease against itself.
 */
export function liveLeases(paths: ProjectPaths, slices: SliceLike[]): ActiveLease[] {
  const statusById = new Map(slices.map((s) => [s.id, s.status]));
  return activeLeases(paths).filter((l) => isLeaseLive(l, statusById));
}

/** The complement of {@link liveLeases}: leases held by a settled/missing governing slice. */
export function staleLeases(paths: ProjectPaths, slices: SliceLike[]): ActiveLease[] {
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
