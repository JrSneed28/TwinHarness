import type { SliceState } from "./state-schema";

/**
 * Parallel-build serialization (spec §16): two slices may build concurrently
 * ONLY if their touched component sets are DISJOINT. Slices sharing a component
 * are SERIALIZED to avoid merge conflicts / drift races.
 *
 * Pure, deterministic, zero-dependency (plan Principle 3). The CLI *records and
 * computes* the schedule; it never decides whether a Builder actually runs.
 */

/** True iff slices `a` and `b` touch at least one common component. */
export function shareComponent(a: SliceState, b: SliceState): boolean {
  const setA = new Set(a.components);
  for (const c of b.components) {
    if (setA.has(c)) return true;
  }
  return false;
}

/**
 * Deterministic greedy scheduler. Iterate slices IN INPUT ORDER; place each
 * slice into the FIRST wave that contains no slice sharing a component with it,
 * else start a new wave. Returns waves as arrays of slice IDs.
 *
 * Disjoint slices share a wave (parallel-eligible); overlapping slices land in
 * different waves (serialized). Slices with empty `components` conflict with
 * nothing and pack freely into the first available wave.
 */
export function scheduleWaves(slices: SliceState[]): string[][] {
  const waves: SliceState[][] = [];
  for (const slice of slices) {
    let placed = false;
    for (const wave of waves) {
      if (wave.every((member) => !shareComponent(member, slice))) {
        wave.push(slice);
        placed = true;
        break;
      }
    }
    if (!placed) waves.push([slice]);
  }
  return waves.map((wave) => wave.map((s) => s.id));
}

/** An unordered pair of slices that share ≥1 component, with the shared names. */
export interface ConflictPair {
  a: string;
  b: string;
  shared: string[];
}

/**
 * All unordered slice pairs that share ≥1 component, with the shared component
 * names. These pairs are serialized (placed in different waves) by
 * `scheduleWaves`. Pairs are emitted in input order (i before j).
 */
export function conflictPairs(slices: SliceState[]): ConflictPair[] {
  const pairs: ConflictPair[] = [];
  for (let i = 0; i < slices.length; i++) {
    const si = slices[i]!;
    const setI = new Set(si.components);
    for (let j = i + 1; j < slices.length; j++) {
      const sj = slices[j]!;
      const shared = sj.components.filter((c) => setI.has(c));
      if (shared.length > 0) {
        pairs.push({ a: si.id, b: sj.id, shared });
      }
    }
  }
  return pairs;
}
