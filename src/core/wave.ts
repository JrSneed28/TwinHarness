import type { SliceState } from "./state-schema";

/**
 * Live wave computation + dependency-graph validation (spec §16, extended).
 *
 * `core/schedule.ts` plans waves from the *static* plan; this module computes the
 * *live* wave from current run state and validates the `depends_on` graph so an
 * unsatisfiable graph (a cycle, a dangling ref, a dep on a never-finishing slice)
 * surfaces as a STALL instead of an Orchestrator quietly spinning on an empty
 * wave forever. Pure, deterministic, zero-IO — the CLI computes; it never decides
 * which Builder runs (plan §3).
 */

export interface HeldSlice {
  id: string;
  reason: "dependency" | "component-conflict";
  /** The unmet dependency IDs, or the conflicting component names. */
  detail: string[];
}

export interface WavePlan {
  /** Slice IDs dispatchable in parallel right now. */
  wave: string[];
  /** Pending slices that can't dispatch yet, with the reason. */
  held: HeldSlice[];
  /**
   * True when pending slices exist, none can be dispatched, AND nothing is
   * in-progress to free components later — i.e. no amount of waiting helps. A
   * dependency cycle, a dep on a `blocked`/missing slice, or a self-deadlocked
   * component graph all land here. This is the signal `th next` turns into a
   * `stalled` obligation rather than a cheery "dispatch the next wave".
   */
  stalled: boolean;
}

/**
 * Compute the dispatchable wave. `occupied` maps a component to the slice that
 * currently owns it (in-progress slices + live leases); a component is busy for a
 * candidate only when owned by a DIFFERENT slice (a slice never blocks itself).
 * `anyInProgress` tells us whether something running could free components later,
 * which distinguishes "waiting" (not stalled) from a true deadlock.
 */
export function computeWave(
  slices: SliceState[],
  occupied: Map<string, string>,
  anyInProgress: boolean,
): WavePlan {
  const statusById = new Map(slices.map((s) => [s.id, s.status]));
  const wave: string[] = [];
  const claimedInWave = new Set<string>();
  const held: HeldSlice[] = [];
  let pending = 0;

  for (const s of slices) {
    if (s.status !== "pending") continue;
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
    for (const c of s.components) claimedInWave.add(c);
  }

  const stalled = pending > 0 && wave.length === 0 && !anyInProgress;
  return { wave, held, stalled };
}

export interface DepIssues {
  /** Slices whose `depends_on` names an ID that is not a known slice. */
  dangling: Array<{ slice: string; missing: string[] }>;
  /** Dependency cycles, each as the list of slice IDs forming the loop. */
  cycles: string[][];
}

/** True when there is any dependency problem worth surfacing. */
export function hasDepIssues(d: DepIssues): boolean {
  return d.dangling.length > 0 || d.cycles.length > 0;
}

/**
 * Validate the `depends_on` graph: report dangling references (a dep on a slice
 * that doesn't exist) and cycles (which deadlock `next-wave` forever). Pure DFS
 * with a GRAY/BLACK coloring; dangling edges are excluded from cycle search.
 */
export function validateDeps(slices: SliceState[]): DepIssues {
  const ids = new Set(slices.map((s) => s.id));
  const dangling: Array<{ slice: string; missing: string[] }> = [];
  for (const s of slices) {
    const missing = (s.depends_on ?? []).filter((d) => !ids.has(d));
    if (missing.length > 0) dangling.push({ slice: s.id, missing });
  }

  const adj = new Map(slices.map((s) => [s.id, (s.depends_on ?? []).filter((d) => ids.has(d))]));
  const cycles: string[][] = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (u: string): void => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === WHITE) visit(v);
      else if (c === GRAY) {
        const i = stack.indexOf(v);
        if (i >= 0) cycles.push(stack.slice(i));
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };

  for (const s of slices) if ((color.get(s.id) ?? WHITE) === WHITE) visit(s.id);
  return { dangling, cycles };
}
