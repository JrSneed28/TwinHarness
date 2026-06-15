import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState, withStateLock } from "../core/state-store";
import { type SliceState } from "../core/state-schema";
import { scheduleWaves, conflictPairs } from "../core/schedule";
import {
  activeLeases,
  liveLeases,
  staleLeases,
  occupiedComponents,
  appendLeaseEvent,
  readLeaseEvents,
  subLeasesOf,
  type ActiveLease,
} from "../core/leases";
import { computeWave, validateDeps, hasDepIssues } from "../core/wave";
import { computeRoute } from "../core/routing";
import { structuredLog } from "../core/log";
import { NOT_INIT, formatIssues } from "../core/guards";

/**
 * `th build plan` — the mechanical parallel-build serializer (spec §16; build
 * plan §4 Slice 7 (b)). It computes a deterministic wave schedule over the
 * slices: disjoint-component slices share a wave (Builders may run concurrently),
 * shared-component slices are split across waves (serialized to avoid merge
 * conflicts / drift races). Pure traceability arithmetic over `state.slices` —
 * it never decides *whether* a Builder runs, only the conflict-free ordering.
 */

export interface BuildPlanOptions {
  /** Include slices with status `done` (default: only schedule unfinished slices). */
  includeDone?: boolean;
}

/**
 * `th build plan [--include-done]` — schedule the slices into conflict-free
 * build waves. By default only unfinished slices (pending/in-progress/blocked)
 * are scheduled; `--include-done` schedules all of them.
 */
export function runBuildPlan(paths: ProjectPaths, opts: BuildPlanOptions = {}): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const selected = opts.includeDone
    ? r.state.slices
    : r.state.slices.filter((s) => s.status !== "done");

  const waves = scheduleWaves(selected);
  const conflicts = conflictPairs(selected);
  const parallelism = waves.reduce((max, w) => Math.max(max, w.length), 0);

  structuredLog({
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

  return success({ data: { waves, conflicts, parallelism }, human });
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
export function runBuildNextWave(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
  }

  const slices = r.state.slices;
  const anyInProgress = slices.some((s) => s.status === "in-progress");
  // "occupied" excludes stale leases (a finished/crashed slice never releases) so
  // a stale lease can't wedge the wave — see core/leases.ts occupiedComponents.
  const occupied = occupiedComponents(paths, slices);
  const { wave, held, stalled } = computeWave(slices, occupied, anyInProgress);
  const deps = validateDeps(slices);

  structuredLog({ cmd: "build next-wave", dispatch: wave.length, held: held.length, stalled, depIssues: hasDepIssues(deps) });

  const lines: string[] = [
    wave.length ? `Dispatch now (parallel): ${wave.join(", ")}` : "Dispatch now: (none ready)",
    ...(held.length
      ? ["Held:", ...held.map((h) => `  ${h.id} — ${h.reason}: ${h.detail.join(", ")}`)]
      : ["Held: (none)"]),
  ];
  for (const c of deps.cycles) lines.push(`DEPENDENCY CYCLE: ${c.join(" → ")} → ${c[0]} (unsatisfiable — break the cycle in the plan)`);
  for (const d of deps.dangling) lines.push(`DANGLING DEPENDENCY: ${d.slice} depends on unknown slice(s): ${d.missing.join(", ")}`);
  if (stalled) lines.push("STALLED: pending slices exist but none can dispatch and none are in progress — resolve the dependency/component deadlock above.");
  lines.push("", "Set each dispatched slice in-progress and `th build claim <ID>` before spawning its Builder.");

  return success({ data: { wave, held, stalled, deps }, human: lines.join("\n") });
}

/** A per-slice spawn descriptor: what a single wave Builder needs to be launched. */
export interface DispatchDescriptor {
  sliceId: string;
  /** Components the Builder will touch (its lease set). */
  components: string[];
  /** Recommended spawn model (reuses the §2 routing table; Orchestrator applies). */
  model: string;
  /** Recommended spawn effort. */
  effort: string;
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
export function runBuildDispatch(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
  }

  const slices = r.state.slices;
  const anyInProgress = slices.some((s) => s.status === "in-progress");
  const occupied = occupiedComponents(paths, slices);
  // Anchor: REQ-PCO-001 — reuse the next-wave computation; do NOT duplicate it.
  const { wave, held, stalled } = computeWave(slices, occupied, anyInProgress);
  const deps = validateDeps(slices);

  // Project-level blast flags drive Builder escalation (slice components are plain
  // names, not blast flags, so this is the readily-available component-blast signal).
  const componentBlast = r.state.blast_radius_flags.length > 0;
  const byId = new Map(slices.map((s) => [s.id, s]));
  const dispatch: DispatchDescriptor[] = wave.map((id) => {
    const slice = byId.get(id)!;
    const route = computeRoute({
      agent: "builder",
      mode: "slice",
      tier: r.state!.tier,
      blastFlags: r.state!.blast_radius_flags,
      componentBlast,
    });
    return { sliceId: id, components: slice.components, model: route.model, effort: route.effort };
  });

  const warnings: string[] = [];
  for (const c of deps.cycles) warnings.push(`DEPENDENCY CYCLE: ${c.join(" → ")} → ${c[0]} (unsatisfiable — break the cycle in the plan)`);
  for (const d of deps.dangling) warnings.push(`DANGLING DEPENDENCY: ${d.slice} depends on unknown slice(s): ${d.missing.join(", ")}`);
  if (stalled) warnings.push("STALLED: pending slices exist but none can dispatch and none are in progress — resolve the dependency/component deadlock.");

  structuredLog({ cmd: "build dispatch", dispatch: dispatch.length, held: held.length, stalled, depIssues: hasDepIssues(deps) });

  const lines: string[] = [
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

  return success({
    data: {
      wave: dispatch,
      held,
      warnings,
      note: "per-slice model/effort routes Builders via the §2 table; componentBlast reflects project-level blast_radius_flags",
    },
    human: lines.join("\n"),
  });
}

function leaseUsage(action: string): CommandResult {
  return failure({ human: `usage: th build ${action} <SLICE-ID>` });
}

/**
 * `th build claim <SLICE-ID>` — take a live lease on the slice's components. The
 * collision guard: refuses (exit 1) if any component is already leased to a
 * DIFFERENT slice, even if the static plan thought them disjoint (drift can grow
 * a component set mid-build). Serialized under the state lock so two concurrent
 * claims can't both win an overlapping component.
 */
export function runBuildClaim(paths: ProjectPaths, sliceId?: string): CommandResult {
  if (!sliceId) return leaseUsage("claim");
  return withStateLock(paths, () => {
    const r = readState(paths);
    if (!r.exists) return NOT_INIT;
    if (!r.state) return failure({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });

    const slice: SliceState | undefined = r.state.slices.find((s) => s.id === sliceId);
    if (!slice) {
      return failure({ human: `Slice not found: ${sliceId}. Known: ${r.state.slices.map((s) => s.id).join(", ") || "(none)"}`, data: { error: "slice_not_found", sliceId } });
    }

    // A slice must be in-progress to hold a lease: the documented protocol is
    // "set in-progress, then claim" (mirrors runBuildSubClaim's parent check and
    // the Phase-B write-gate, which only grants writes to an in-progress slice's
    // components). A pending/done/blocked slice has no business holding components.
    if (slice.status !== "in-progress") {
      return failure({
        human: `Cannot claim ${sliceId}: it is "${slice.status}", not in-progress. Set it in-progress first (\`th slice set-status ${sliceId} in-progress\`), then claim (§16).`,
        data: { error: "slice_not_in_progress", sliceId, status: slice.status },
      });
    }

    // Only LIVE leases (held by a pending/in-progress slice) block a claim — a
    // stale lease from a done/blocked/crashed slice is ignored, not a permanent wall.
    const owners = new Map<string, string>();
    for (const lease of liveLeases(paths, r.state.slices)) {
      for (const c of lease.components) if (!owners.has(c)) owners.set(c, lease.slice);
    }
    const conflicts = slice.components
      .map((c) => ({ component: c, owner: owners.get(c) }))
      .filter((x) => x.owner !== undefined && x.owner !== sliceId) as Array<{ component: string; owner: string }>;
    if (conflicts.length > 0) {
      return failure({
        human: `Cannot claim ${sliceId}: ${conflicts.map((c) => `${c.component} held by ${c.owner}`).join(", ")}. Serialize behind it (§16).`,
        data: { error: "lease_conflict", conflicts },
      });
    }

    appendLeaseEvent(paths, { event: "claim", slice: sliceId, components: slice.components });
    structuredLog({ cmd: "build claim", slice: sliceId, components: slice.components });
    return success({ data: { slice: sliceId, components: slice.components }, human: `claimed ${sliceId}: ${slice.components.join(", ") || "(no components)"}` });
  });
}

/** `th build release <SLICE-ID>` — release the slice's lease (after it finishes/blocks). */
export function runBuildRelease(paths: ProjectPaths, sliceId?: string): CommandResult {
  if (!sliceId) return leaseUsage("release");
  return withStateLock(paths, () => {
    const r = readState(paths);
    if (!r.exists) return NOT_INIT;
    if (!r.state) return failure({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });

    const held = activeLeases(paths).find((l) => l.slice === sliceId);
    appendLeaseEvent(paths, { event: "release", slice: sliceId, components: held?.components ?? [] });
    structuredLog({ cmd: "build release", slice: sliceId });
    return success({ data: { slice: sliceId, released: held?.components ?? [] }, human: `released ${sliceId}.` });
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
export function runBuildSubClaim(paths: ProjectPaths, parentSlice?: string, components?: string[]): CommandResult {
  if (!parentSlice) return failure({ human: "usage: th build sub-claim <PARENT-SLICE> --components <c1,c2,...>" });
  if (!components || components.length === 0) {
    return failure({ human: "usage: th build sub-claim <PARENT-SLICE> --components <c1,c2,...>", data: { error: "no_components" } });
  }
  return withStateLock(paths, () => {
    const r = readState(paths);
    if (!r.exists) return NOT_INIT;
    if (!r.state) return failure({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });

    const parent: SliceState | undefined = r.state.slices.find((s) => s.id === parentSlice);
    if (!parent) {
      return failure({ human: `Parent slice not found: ${parentSlice}. Known: ${r.state.slices.map((s) => s.id).join(", ") || "(none)"}`, data: { error: "slice_not_found", parent: parentSlice } });
    }
    if (parent.status !== "in-progress") {
      return failure({
        human: `Cannot sub-claim under ${parentSlice}: it is "${parent.status}", not in-progress (the parent must hold the top-level lease).`,
        data: { error: "parent_not_in_progress", parent: parentSlice, status: parent.status },
      });
    }

    // Must be a non-empty SUBSET of the parent's declared components.
    const parentComponents = new Set(parent.components);
    const notInParent = components.filter((c) => !parentComponents.has(c));
    if (notInParent.length > 0) {
      return failure({
        human: `Cannot sub-claim under ${parentSlice}: ${notInParent.join(", ")} not in the parent's components (${parent.components.join(", ") || "(none)"}). A sub-lease must be a subset.`,
        data: { error: "not_a_subset", parent: parentSlice, requested: components, parentComponents: parent.components, extra: notInParent },
      });
    }

    // Must be DISJOINT from every LIVE sibling sub-lease under the same parent.
    // A sibling sub-lease is live exactly when the parent is in-progress (which it
    // is here), so the active sibling set is the live set — mirror runBuildClaim.
    const siblings = subLeasesOf(paths, parentSlice);
    const live = new Set(liveLeases(paths, r.state.slices).map((l) => l.slice));
    const owners = new Map<string, string>();
    for (const sib of siblings) {
      if (!live.has(sib.slice)) continue; // ignore a released/stale sibling
      for (const c of sib.components) if (!owners.has(c)) owners.set(c, sib.slice);
    }
    const conflicts = components
      .map((c) => ({ component: c, owner: owners.get(c) }))
      .filter((x) => x.owner !== undefined) as Array<{ component: string; owner: string }>;
    if (conflicts.length > 0) {
      return failure({
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

    appendLeaseEvent(paths, { event: "claim", slice: subId, components, parent: parentSlice });
    structuredLog({ cmd: "build sub-claim", subId, parent: parentSlice, components });
    return success({
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
export function runBuildSubRelease(paths: ProjectPaths, subId?: string): CommandResult {
  if (!subId) return failure({ human: "usage: th build sub-release <SUB-ID>" });
  return withStateLock(paths, () => {
    const r = readState(paths);
    if (!r.exists) return NOT_INIT;
    if (!r.state) return failure({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });

    const held = activeLeases(paths).find((l) => l.slice === subId && l.parent !== undefined);
    if (!held) {
      return failure({
        human: `No active sub-lease: ${subId}. Active sub-leases: ${activeLeases(paths).filter((l) => l.parent !== undefined).map((l) => l.slice).join(", ") || "(none)"}`,
        data: { error: "sub_lease_not_found", subId },
      });
    }

    appendLeaseEvent(paths, { event: "release", slice: subId, components: held.components, parent: held.parent });
    structuredLog({ cmd: "build sub-release", subId, parent: held.parent });
    return success({ data: { subId, parent: held.parent, released: held.components }, human: `released sub-lease ${subId}.` });
  });
}

/** Distinct sub-owner ids ever opened under `parentSlice` (claim events), for id minting. */
function readLeaseEventsForParent(paths: ProjectPaths, parentSlice: string): string[] {
  const ids = new Set<string>();
  for (const e of readLeaseEvents(paths)) {
    if (e.event === "claim" && e.parent === parentSlice) ids.add(e.slice);
  }
  return [...ids];
}

/**
 * `th build leases` — list the live component leases, reconciled against slice
 * state. Leases whose owning slice has settled (done/blocked) or vanished are
 * reported separately as STALE so they can be cleaned up (`th build release`),
 * rather than silently occupying components.
 */
export function runBuildLeases(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  // Without valid state we cannot reconcile; fall back to the raw active set.
  if (!r.state) {
    const leases = activeLeases(paths);
    const human = leases.length ? leases.map((l) => `${l.slice}: ${l.components.join(", ") || "(no components)"}`).join("\n") : "(no active leases)";
    return success({ data: { leases, stale: [] }, human });
  }

  const live = liveLeases(paths, r.state.slices);
  const stale = staleLeases(paths, r.state.slices);
  // liveLeases/staleLeases reconcile top-level AND sub-leases together (a sub-lease
  // against its parent); split them so each kind reports in a labeled section.
  const isSub = (l: ActiveLease): boolean => l.parent !== undefined;
  const liveTop = live.filter((l) => !isSub(l));
  const liveSub = live.filter(isSub);
  const staleTop = stale.filter((l) => !isSub(l));
  const staleSub = stale.filter(isSub);

  const lines: string[] = [];
  lines.push(liveTop.length ? "Live leases:" : "Live leases: (none)");
  for (const l of liveTop) lines.push(`  ${l.slice}: ${l.components.join(", ") || "(no components)"}`);
  lines.push(liveSub.length ? "Live sub-leases:" : "Live sub-leases: (none)");
  for (const l of liveSub) lines.push(`  ${l.slice} (under ${l.parent}): ${l.components.join(", ") || "(no components)"}`);
  if (staleTop.length) {
    lines.push("STALE leases (owning slice is done/blocked/missing — `th build release <ID>` to clear):");
    for (const l of staleTop) lines.push(`  ${l.slice}: ${l.components.join(", ")}`);
  }
  if (staleSub.length) {
    lines.push("STALE sub-leases (parent slice is done/blocked/missing — `th build sub-release <ID>` to clear):");
    for (const l of staleSub) lines.push(`  ${l.slice} (under ${l.parent}): ${l.components.join(", ")}`);
  }
  return success({ data: { leases: liveTop, subLeases: liveSub, stale: staleTop, staleSubLeases: staleSub }, human: lines.join("\n") });
}
