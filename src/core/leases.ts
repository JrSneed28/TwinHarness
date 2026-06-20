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
import { assertGovernedWriteSurface } from "./paths";
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

/**
 * Canonical field order for a serialized lease line (ARCH-004). This makes the
 * ledger's on-disk byte layout an EXPLICIT, compile-time-visible contract instead
 * of relying on the `{ ts, ...event }` spread's insertion order. It is byte-identical
 * to the historical implicit order (`ts`, then the event's own keys), so existing
 * lease ledgers and their hashes are unaffected. `parent` is last and omitted when
 * undefined (the optional-field convention mirroring `STATE_FIELD_ORDER`).
 */
export const LEASE_FIELD_ORDER: ReadonlyArray<keyof LeaseEvent> = [
  "ts",
  "event",
  "slice",
  "components",
  "parent",
];

/**
 * Deterministic single-line serialization of a lease event in {@link LEASE_FIELD_ORDER}.
 * Copies fields into a fresh object in canonical order and drops any `undefined` key
 * (so a top-level lease without `parent` round-trips to the pre-sub-lease format).
 * `JSON.stringify` with no indentation — one event per JSONL line. Byte-identical to
 * the previous `JSON.stringify({ ts, ...event })` for every caller's key order.
 */
export function serializeLeaseEvent(event: LeaseEvent): string {
  const ordered: Record<string, unknown> = {};
  const src = event as unknown as Record<string, unknown>;
  for (const key of LEASE_FIELD_ORDER) {
    const val = src[key];
    if (val !== undefined) ordered[key] = val;
  }
  return JSON.stringify(ordered);
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
  // AC#1 write-surface chokepoint: leasesPath is under stateDir; the guard fires
  // here (this writer propagates) so a non-governed target throws WriteSurfaceError.
  assertGovernedWriteSurface(paths.root, leasesPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  // Explicit canonical serialization (LEASE_FIELD_ORDER): drops `undefined`-valued
  // keys, so a top-level lease (no `parent`) serializes byte-identically to the
  // pre-sub-lease format; only a sub-lease (parent set to a string) carries the
  // extra field. Byte-identical to the historical `{ ts, ...event }` spread.
  const line = serializeLeaseEvent({ ts: now().toISOString(), ...event }) + "\n";
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
 *
 * The returned shape is intentionally STABLE (no timestamp) so `toEqual`-style
 * consumers and the deterministic `th ... leases` output are unaffected; the
 * claim timestamps used by the TTL sweep (P5-3) are read separately via
 * {@link claimTimestamps} so they never leak into the active-lease shape.
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

/**
 * Owner-id → the ISO timestamp of its CURRENTLY-HELD claim (the last `claim` not
 * followed by a `release`). Released owners are absent. This is the timestamp
 * source the TTL stale-recovery sweep (P5-3) consults WITHOUT polluting the stable
 * {@link ActiveLease}/{@link ActiveSectionLease} shapes. Pure: it reduces the
 * ledger the same way {@link activeLeases} does, but keeps the `ts`.
 */
export function claimTimestamps(paths: ProjectPaths): Map<string, string> {
  const byOwner = new Map<string, string | null>();
  for (const e of readLeaseEvents(paths)) {
    byOwner.set(e.slice, e.event === "claim" ? e.ts : null);
  }
  const out = new Map<string, string>();
  for (const [slice, ts] of byOwner) {
    if (typeof ts === "string") out.set(slice, ts);
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

/* ------------------------------------------------------------------ *
 * Section-level artifact leases (Phase 4 Slice 6, REQ-PCO-041).       *
 *                                                                      *
 * Same append-only ledger and the same collision-guard mechanism as   *
 * component leases — only the lease KEY differs: instead of a slice id *
 * naming a component set, the key is a SECTION id of the form          *
 * `<file>#<section>` and the lease records the HOLDER (the claiming     *
 * agent/task). Two agents may co-edit DIFFERENT sections of the same    *
 * file, but never the SAME section concurrently. A section lease reuses *
 * {@link appendLeaseEvent}: the section id goes in the `slice` field    *
 * (the ledger's lease key) and the holder is stored as the sole entry  *
 * of `components` (`[holder]`), so a section lease round-trips through  *
 * the existing JSONL format without any schema change. Section leases   *
 * are top-level (never carry `parent`), which is how they are told      *
 * apart from sub-leases that also use `#` in their owner id.            *
 * ------------------------------------------------------------------ */

/** A section id is `<file>#<section>` with a non-empty file and section. */
const SECTION_ID = /^[^#\n]+#[^#\n]+$/;

/** Whether `id` has the valid `<file>#<section>` shape (single `#`, both sides non-empty). */
export function isSectionId(id: string): boolean {
  return SECTION_ID.test(id);
}

/** Split a `<file>#<section>` id into its parts; `undefined` if malformed. */
export function parseSectionId(id: string): { file: string; section: string } | undefined {
  if (!isSectionId(id)) return undefined;
  const hash = id.indexOf("#");
  return { file: id.slice(0, hash), section: id.slice(hash + 1) };
}

/** An active section lease: the `<file>#<section>` id and the holder that owns it. */
export interface ActiveSectionLease {
  /** The `<file>#<section>` lease key. */
  section: string;
  /** The agent/task id currently holding the section. */
  holder: string;
}

/**
 * The currently-held SECTION leases, reduced from the SAME event ledger as
 * component leases. A section lease is an active top-level lease (no `parent`)
 * whose `slice` key is a valid `<file>#<section>` id; its holder is the first
 * entry of `components`. Pure: it reads/reduces the ledger and decides nothing.
 * The shape is intentionally stable (no timestamp) — the TTL sweep reads claim
 * timestamps separately via {@link claimTimestamps}.
 */
export function activeSectionLeases(paths: ProjectPaths): ActiveSectionLease[] {
  const out: ActiveSectionLease[] = [];
  for (const lease of activeLeases(paths)) {
    if (lease.parent !== undefined) continue; // sub-lease, not a section lease
    if (!isSectionId(lease.slice)) continue; // not a section id
    out.push({ section: lease.slice, holder: lease.components[0] ?? "" });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Section-lease + sub-lease TTL stale-recovery (Phase 5 / P5-3).       *
 *                                                                      *
 * A component lease reconciles against its governing SLICE (settled    *
 * slice ⇒ stale). A SECTION lease has no governing slice — its holder  *
 * is an agent/task id, not a slice — so a dead/crashed holder that      *
 * never ran `th artifact release` would wedge that section FOREVER.     *
 * P5-3 closes that bug with a TTL sweep mirroring {@link staleLeases}:   *
 * a section lease whose CLAIM is older than the TTL is treated as a      *
 * dead holder and is recoverable. This never auto-releases anything on  *
 * its own — it is a pure predicate the command layer consults (e.g.     *
 * `th artifact leases` surfaces stale leases, a future sweep releases    *
 * them); a live holder simply re-claims to refresh its timestamp.       *
 * ------------------------------------------------------------------ */

/** Default section-lease TTL: 2 hours in ms. A holder older than this is presumed dead. */
export const SECTION_LEASE_TTL_MS = 2 * 60 * 60 * 1000;

/** Whether the claim at `claimedAt` (ISO ts) is older than `ttlMs` relative to `now` (epoch ms). Missing/unparseable ts ⇒ stale. */
function isExpired(claimedAt: string | undefined, ttlMs: number, now: number): boolean {
  if (claimedAt === undefined) return true;
  const t = Date.parse(claimedAt);
  if (Number.isNaN(t)) return true;
  return now - t > ttlMs;
}

/**
 * The STALE section leases: active section leases whose CURRENT claim is older than
 * `ttlMs` (a dead/crashed holder that never released). Mirrors {@link staleLeases}
 * but keyed on a TTL rather than a governing slice, because a section lease's holder
 * is an agent, not a slice. The claim timestamp is read via {@link claimTimestamps}
 * so the {@link ActiveSectionLease} shape stays timestamp-free. Clock-injectable.
 */
export function staleSectionLeases(
  paths: ProjectPaths,
  ttlMs: number = SECTION_LEASE_TTL_MS,
  now: () => Date = () => new Date(),
): ActiveSectionLease[] {
  const t = now().getTime();
  const ts = claimTimestamps(paths);
  return activeSectionLeases(paths).filter((l) => isExpired(ts.get(l.section), ttlMs, t));
}

/** The complement of {@link staleSectionLeases}: section leases whose current claim is within the TTL. */
export function liveSectionLeases(
  paths: ProjectPaths,
  ttlMs: number = SECTION_LEASE_TTL_MS,
  now: () => Date = () => new Date(),
): ActiveSectionLease[] {
  const t = now().getTime();
  const ts = claimTimestamps(paths);
  return activeSectionLeases(paths).filter((l) => !isExpired(ts.get(l.section), ttlMs, t));
}

/**
 * Reconcile + RECOVER stale section leases: for every section lease past the TTL,
 * append a `release` event so the section is freed for a new holder, and return the
 * swept leases. Idempotent (a second sweep finds none) and append-only (it never
 * rewrites the ledger). This is the explicit recovery action behind
 * {@link staleSectionLeases}; the caller (e.g. `th artifact leases --reap`) decides
 * WHEN to run it — this function only records the releases. Clock-injectable.
 */
export function sweepStaleSectionLeases(
  paths: ProjectPaths,
  ttlMs: number = SECTION_LEASE_TTL_MS,
  now: () => Date = () => new Date(),
): ActiveSectionLease[] {
  const stale = staleSectionLeases(paths, ttlMs, now);
  for (const l of stale) {
    appendLeaseEvent(paths, { event: "release", slice: l.section, components: [l.holder] }, now);
  }
  return stale;
}

/**
 * Whether `section` (`<file>#<section>`) is currently leased. With `holder`,
 * tests "held by a DIFFERENT holder" — the collision-guard predicate a claim
 * uses to refuse a concurrent claim on the SAME section (a re-claim by the same
 * holder is not a collision). Without `holder`, tests "held by anyone".
 */
export function isSectionLeased(paths: ProjectPaths, section: string, holder?: string): boolean {
  for (const lease of activeSectionLeases(paths)) {
    if (lease.section !== section) continue;
    if (holder === undefined) return true;
    if (lease.holder !== holder) return true;
  }
  return false;
}

/** The holder currently leasing `section`, or `undefined` if it is free. */
export function sectionLeaseHolder(paths: ProjectPaths, section: string): string | undefined {
  return activeSectionLeases(paths).find((l) => l.section === section)?.holder;
}
