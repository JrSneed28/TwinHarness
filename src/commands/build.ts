import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState, withStateLock } from "../core/state-store";
import { type SliceState } from "../core/state-schema";
import { scheduleWaves, conflictPairs } from "../core/schedule";
import { activeLeases, liveLeases, staleLeases, occupiedComponents, appendLeaseEvent } from "../core/leases";
import { computeWave, validateDeps, hasDepIssues } from "../core/wave";
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
  const lines: string[] = [];
  lines.push(live.length ? "Live leases:" : "Live leases: (none)");
  for (const l of live) lines.push(`  ${l.slice}: ${l.components.join(", ") || "(no components)"}`);
  if (stale.length) {
    lines.push("STALE leases (owning slice is done/blocked/missing — `th build release <ID>` to clear):");
    for (const l of stale) lines.push(`  ${l.slice}: ${l.components.join(", ")}`);
  }
  return success({ data: { leases: live, stale }, human: lines.join("\n") });
}
