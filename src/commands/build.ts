import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState, withStateLock } from "../core/state-store";
import { type SliceState, type ValidationIssue } from "../core/state-schema";
import { scheduleWaves, conflictPairs } from "../core/schedule";
import { activeLeases, leasedComponents, appendLeaseEvent } from "../core/leases";
import { structuredLog } from "../core/log";

/**
 * `th build plan` — the mechanical parallel-build serializer (spec §16; build
 * plan §4 Slice 7 (b)). It computes a deterministic wave schedule over the
 * slices: disjoint-component slices share a wave (Builders may run concurrently),
 * shared-component slices are split across waves (serialized to avoid merge
 * conflicts / drift races). Pure traceability arithmetic over `state.slices` —
 * it never decides *whether* a Builder runs, only the conflict-free ordering.
 */

function formatIssues(issues: ValidationIssue[] | undefined): string {
  return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}

const NOT_INIT = failure({
  human: "No state.json found. Run `th init` first.",
  data: { error: "not_initialized" },
});

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

interface HeldSlice {
  id: string;
  reason: "dependency" | "component-conflict";
  detail: string[];
}

/**
 * `th build next-wave` — the live wave-runner oracle. Returns the set of slices
 * that are dispatchable IN PARALLEL right now: status `pending`, all `depends_on`
 * slices `done`, and components free of (a) in-progress slices, (b) active
 * leases, and (c) each other within the wave. The held slices are reported with
 * the reason they wait (unmet dependency or a component conflict). Reuses the
 * §16 disjointness rule but over the *current* run state, not the static plan.
 */
export function runBuildNextWave(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
  }

  const slices = r.state.slices;
  const statusById = new Map(slices.map((s) => [s.id, s.status]));

  // Component → the slice that currently occupies it: an in-progress slice owns
  // its components; an active lease owns its components. A component is busy FOR a
  // candidate only when occupied by a DIFFERENT slice (a slice never blocks itself).
  const ownerByComponent = new Map<string, string>();
  for (const s of slices) if (s.status === "in-progress") for (const c of s.components) if (!ownerByComponent.has(c)) ownerByComponent.set(c, s.id);
  for (const [component, owner] of leasedComponents(paths)) if (!ownerByComponent.has(component)) ownerByComponent.set(component, owner);

  const wave: string[] = [];
  const claimedInWave = new Set<string>();
  const held: HeldSlice[] = [];

  for (const s of slices) {
    if (s.status !== "pending") continue;

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
    for (const c of s.components) claimedInWave.add(c);
  }

  structuredLog({ cmd: "build next-wave", dispatch: wave.length, held: held.length });

  const human = [
    wave.length ? `Dispatch now (parallel): ${wave.join(", ")}` : "Dispatch now: (none ready)",
    ...(held.length
      ? ["Held:", ...held.map((h) => `  ${h.id} — ${h.reason}: ${h.detail.join(", ")}`)]
      : ["Held: (none)"]),
    "",
    "Set each dispatched slice in-progress and `th build claim <ID>` before spawning its Builder.",
  ].join("\n");

  return success({ data: { wave, held }, human });
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

    const owners = leasedComponents(paths);
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

/** `th build leases` — list the live component leases. */
export function runBuildLeases(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  const leases = activeLeases(paths);
  const human = leases.length
    ? leases.map((l) => `${l.slice}: ${l.components.join(", ") || "(no components)"}`).join("\n")
    : "(no active leases)";
  return success({ data: { leases }, human });
}
