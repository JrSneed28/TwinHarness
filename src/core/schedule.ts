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
 * Deterministic greedy scheduler. Place each slice into the FIRST wave that
 * (a) sits STRICTLY after every hard dependency's wave and (b) contains no slice
 * sharing a component with it, else start a new wave. Returns waves as arrays of
 * slice IDs.
 *
 * Two serialization rules combine (ARCH-001):
 *   - COMPONENT-disjointness (§16): overlapping slices land in different waves
 *     (serialized to avoid merge conflicts); disjoint slices may share a wave.
 *   - HARD `depends_on` ordering: a slice's wave is STRICTLY GREATER than the
 *     max wave of its hard dependencies — so a dependent can never schedule in
 *     the same or an earlier wave than something it hard-depends on, even when
 *     their components are disjoint and §16 alone would pack them together.
 *
 * ORDER-ROBUST: a slice is held back until every hard dependency PRESENT IN THE
 * INPUT is already placed, so the strict-ordering invariant holds even for a
 * FORWARD reference (a dependency listed AFTER its dependent in the input).
 * Independent slices still place in input order on the first pass, so the output
 * is input-order stable for the common (topologically-ordered) plan — preserving
 * the §18 byte-stability of an existing plan that has no forward refs.
 *
 * `depends_on_soft` (interface-only) deps do NOT gate placement: a soft dep is a
 * speculative contract dependency, not a build-order one (REQ-PCO-070), so it is
 * deliberately ignored here. A `depends_on` id that names a slice NOT in the
 * input set (a dangling ref) is ignored for placement; `validateDeps` surfaces
 * such refs separately. A dependency CYCLE cannot be ordered — the deferral is
 * bounded by the slice count, and any slice still unplaceable on the final pass
 * is placed ignoring its unmet deps (no crash, no infinite loop); `validateDeps`
 * surfaces the cycle as the actionable error. Slices with empty `components`
 * conflict with nothing and pack into the first dependency-eligible wave.
 * Pure and deterministic.
 */
export function scheduleWaves(slices: SliceState[]): string[][] {
  const waves: SliceState[][] = [];
  // Wave index each already-placed slice landed in, by id.
  const waveOf = new Map<string, number>();
  // The set of ids present in the input — only these gate placement; a dep on an
  // id NOT in this set is dangling and ignored (validateDeps reports it).
  const known = new Set(slices.map((s) => s.id));

  /** Place one slice now: scan from minWave for a conflict-free wave, else append. */
  const place = (slice: SliceState, ignoreUnmet: boolean): boolean => {
    // A slice is ready only when every KNOWN hard dependency is already placed.
    // (Forced final pass places it regardless — a cycle/self-dep never resolves.)
    let minWave = 0;
    for (const dep of slice.depends_on ?? []) {
      if (!known.has(dep) || dep === slice.id) continue; // dangling/self → ignore
      const depWave = waveOf.get(dep);
      if (depWave === undefined) {
        if (!ignoreUnmet) return false; // dep not placed yet — defer this slice
        continue; // forced pass: treat the unmet dep as if absent
      }
      if (depWave + 1 > minWave) minWave = depWave + 1;
    }

    // Scan from minWave (never below it — that enforces strict dependency
    // ordering) for the first wave with no component conflict; else append. The
    // append always lands at index >= minWave (a placed dep's index is < the
    // current wave count, so minWave <= waves.length — no empty padding needed).
    for (let w = minWave; w < waves.length; w++) {
      const wave = waves[w]!;
      if (wave.every((member) => !shareComponent(member, slice))) {
        wave.push(slice);
        waveOf.set(slice.id, w);
        return true;
      }
    }
    waves.push([slice]);
    waveOf.set(slice.id, waves.length - 1);
    return true;
  };

  // Repeatedly sweep the still-unplaced slices in input order, placing each whose
  // dependencies are all satisfied. Bounded by the slice count: each non-final
  // pass that makes no progress means the remainder is a cycle (or depends on
  // one), so the LAST allowed pass forces placement ignoring unmet deps.
  let remaining = slices.filter(() => true);
  for (let pass = 0; remaining.length > 0; pass++) {
    const forced = pass >= slices.length; // safety net: cannot exceed N passes
    const next: SliceState[] = [];
    for (const slice of remaining) {
      if (!place(slice, forced)) next.push(slice);
    }
    // No progress on a non-forced pass ⇒ only cyclic slices remain; force them
    // next pass rather than spinning. (Without this, a 2-cycle would loop.)
    if (next.length === remaining.length && !forced) {
      for (const slice of next) place(slice, true);
      break;
    }
    remaining = next;
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
