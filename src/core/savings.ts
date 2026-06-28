/**
 * Savings calc core (Phase B1 — pure, clock-free, no I/O).
 *
 * Computes a single deterministic {@link SavingsResult} from a list of
 * {@link TelemetryRecord}s. The headline math is reproducible from
 * `telemetry.jsonl` alone (order-independent, no clock, no env reads except the
 * caller-supplied suppression mode).
 *
 * Honesty contract (plan Principle 1): until rehydration payback is instrumented
 * for a cycle, `avoided_tokens` is an UPPER BOUND (payback not yet subtracted).
 * That state is surfaced via {@link SavingsResult.payback_measured} and
 * {@link SavingsResult.headline_label} — never as a bare "measured" claim.
 *
 * Fail-safe (AC-28): malformed/partial records never throw — missing or
 * non-finite numbers coerce to 0; an unresolvable category becomes
 * `uncategorized_tokens` labeled `[incomplete]`.
 */

import type { TelemetryRecord, TelemetryWorkloadCategory } from "./context-telemetry";
import { resolveCategory, TELEMETRY_WORKLOAD_CATEGORIES } from "./savings-classify";

// ---------------------------------------------------------------------------
// Exported contract (downstream workers depend on this exact shape)
// ---------------------------------------------------------------------------

/** One category's attributed avoided tokens. `rehydration` may be negative (AC-8). */
export interface CategoryAvoided {
  category: TelemetryWorkloadCategory;
  avoided_tokens: number;
  label: "measured" | "incomplete";
}

/** The full deterministic savings figure for a session (or whole store). */
export interface SavingsResult {
  /** Σ orig_tokens. */
  baseline_tokens: number;
  /** Σ returned_tokens (returned ?? orig). */
  actual_tokens: number;
  /** Σ net_cycle — an UPPER BOUND when payback is unmeasured. */
  avoided_tokens: number;
  /** avoided/baseline*100, rounded 2dp; 0 when baseline==0. */
  saved_pct: number;
  /** Σ payback (0 when none measured). */
  payback_tokens: number;
  /** false ⇒ headline is a pre-rehydration UPPER BOUND. */
  payback_measured: boolean;
  /** Always 0 from telemetry (provider cache is transcript-only). */
  cache_read_tokens: number;
  /** One per {@link TELEMETRY_WORKLOAD_CATEGORIES}, in that order. */
  categories: CategoryAvoided[];
  /** Avoided whose category resolved undefined → `[incomplete]`. */
  uncategorized_tokens: number;
  /** == avoided_tokens (input-side); feeds pricing. */
  avoided_input_tokens: number;
  /** Number of records considered (after session filter). */
  record_count: number;
  /** Echo of opts.session_id when scoped. */
  session_id?: string;
  /** From opts.suppressMode (TH_EXACT_SUPPRESS). */
  suppress_mode: boolean;
  /** Honesty label for the headline (see {@link computeSavings}). */
  headline_label: string;
}

export interface ComputeSavingsOpts {
  session_id?: string;
  suppressMode?: boolean;
}

// ---------------------------------------------------------------------------
// Coercion helpers (fail-safe — AC-28)
// ---------------------------------------------------------------------------

/** Coerce an arbitrary value to a finite number, defaulting to 0. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** orig_tokens, coerced to a finite number (0 when absent/malformed). */
function origOf(rec: TelemetryRecord): number {
  return num(rec.orig_tokens);
}

/** returned_tokens ?? orig_tokens ?? 0, each coerced to a finite number. */
function returnedOf(rec: TelemetryRecord): number {
  if (typeof rec.returned_tokens === "number" && Number.isFinite(rec.returned_tokens)) {
    return rec.returned_tokens;
  }
  return origOf(rec);
}

/** True when this record carries a rehydration payback (per-page re-serve). */
function isRehydration(rec: TelemetryRecord): boolean {
  return rec.rehydrated_full_tokens !== null && rec.rehydrated_full_tokens !== undefined;
}

// ---------------------------------------------------------------------------
// Cycle netting (keyed by (page_id, epoch))
// ---------------------------------------------------------------------------

interface Cycle {
  /** Non-rehydration records in this cycle. */
  base: TelemetryRecord[];
  /** Rehydration records in this cycle. */
  rehydration: TelemetryRecord[];
}

/**
 * Group records into per-`(page_id, epoch)` cycles. A non-rehydration record
 * with no usable `page_id` forms its own singleton cycle (so cross-page credit
 * never merges).
 *
 * Capsule-level rehydration records — the only kind the R7 host emitter writes
 * today: epoch-scoped, `content_hash`-keyed, NO `page_id` — are NOT cycles. They
 * carry no per-page credit to cap against, so they are returned separately for
 * the caller to apply as a session-level capsule-payback pool. (Putting them in
 * zero-credit singleton cycles would silently drop every real payback.)
 */
function buildCycles(records: TelemetryRecord[]): { cycles: Cycle[]; capsule: TelemetryRecord[] } {
  const keyed = new Map<string, Cycle>();
  const singletons: Cycle[] = [];
  const capsule: TelemetryRecord[] = [];

  for (const rec of records) {
    const pageId = typeof rec.page_id === "string" && rec.page_id.length > 0 ? rec.page_id : undefined;

    // No page_id + rehydration ⇒ capsule-level payback (handled session-wide).
    if (pageId === undefined && isRehydration(rec)) {
      capsule.push(rec);
      continue;
    }

    const cycle: Cycle = pageId === undefined ? { base: [], rehydration: [] } : (() => {
      const key = `${pageId}${num(rec.epoch)}`;
      let c = keyed.get(key);
      if (c === undefined) {
        c = { base: [], rehydration: [] };
        keyed.set(key, c);
      }
      return c;
    })();

    if (isRehydration(rec)) cycle.rehydration.push(rec);
    else cycle.base.push(rec);

    if (pageId === undefined) singletons.push(cycle);
  }

  return { cycles: [...keyed.values(), ...singletons], capsule };
}

/**
 * Sum the deduped rehydration payback over a list of rehydration records.
 * Records sharing a `content_hash` count once (idempotency key I2); the max
 * value is taken so the result is order-independent even if duplicates disagree.
 * Records with no `content_hash` are each counted (no information to dedup on).
 * Used both per-`(page_id, epoch)` cycle and for the session capsule pool.
 */
function dedupPayback(rehydration: TelemetryRecord[]): number {
  const byHash = new Map<string, number>();
  let anonymous = 0;
  for (const rec of rehydration) {
    const tokens = num(rec.rehydrated_full_tokens);
    const hash = rec.content_hash;
    if (typeof hash === "string" && hash.length > 0) {
      byHash.set(hash, Math.max(byHash.get(hash) ?? 0, tokens));
    } else {
      anonymous += tokens;
    }
  }
  let total = anonymous;
  for (const v of byHash.values()) total += v;
  return total;
}

// ---------------------------------------------------------------------------
// computeSavings
// ---------------------------------------------------------------------------

export function computeSavings(records: TelemetryRecord[], opts?: ComputeSavingsOpts): SavingsResult {
  const sessionId = opts?.session_id;
  const suppressMode = opts?.suppressMode ?? false;

  const scoped =
    sessionId !== undefined ? records.filter((r) => r.session_id === sessionId) : records.slice();

  // Headline baseline/actual sum over ALL scoped records.
  let baseline = 0;
  let actual = 0;
  for (const rec of scoped) {
    baseline += origOf(rec);
    actual += returnedOf(rec);
  }

  // Category buckets (zero-filled, in canonical order).
  const buckets = new Map<TelemetryWorkloadCategory, number>();
  for (const c of TELEMETRY_WORKLOAD_CATEGORIES) buckets.set(c, 0);
  let uncategorized = 0;

  // Per-cycle netting. `creditedTotal` tracks whether ANY suppression credit
  // exists (drives the upper-bound disclosure when no payback was measured).
  const { cycles, capsule } = buildCycles(scoped);
  let avoided = 0;
  let paybackTotal = 0;
  let creditedTotal = 0;

  for (const cycle of cycles) {
    let credited = 0;
    for (const rec of cycle.base) {
      const contrib = Math.max(0, origOf(rec) - returnedOf(rec));
      credited += contrib;
      // Attribute the positive contribution to its resolved category.
      const cat = resolveCategory(rec);
      if (cat === undefined) uncategorized += contrib;
      else buckets.set(cat, (buckets.get(cat) ?? 0) + contrib);
    }
    creditedTotal += credited;

    // A rehydration record WITH a page_id (none emitted today, but keep the
    // path) caps its payback against this cycle's own credit.
    const payback =
      cycle.rehydration.length > 0 ? Math.min(dedupPayback(cycle.rehydration), credited) : 0;

    avoided += credited - payback; // payback ≤ credited ⇒ never negative
    paybackTotal += payback;
  }

  // Session-level capsule payback: epoch-scoped rehydration records carry no
  // page_id, so they cannot cap per-page. Dedup by content_hash (I2), then
  // subtract from the whole-session avoided total, capped at total credit and
  // floored at 0 so the headline can never go negative.
  const capsulePayback = dedupPayback(capsule);
  const appliedCapsule = Math.min(capsulePayback, avoided);
  avoided -= appliedCapsule;
  paybackTotal += appliedCapsule;

  // payback_measured: we have actually measured & subtracted a payback whenever
  // ANY rehydration record exists in the input. It is an upper bound ONLY when
  // suppression credit exists yet no rehydration record was emitted at all.
  const anyRehydration = capsule.length > 0 || cycles.some((c) => c.rehydration.length > 0);
  const paybackMeasured = anyRehydration || creditedTotal === 0;

  // Rehydration payback is shown as a subtracted (negative) line (AC-8).
  buckets.set("rehydration", (buckets.get("rehydration") ?? 0) - paybackTotal);

  const categories: CategoryAvoided[] = TELEMETRY_WORKLOAD_CATEGORIES.map((category) => ({
    category,
    avoided_tokens: buckets.get(category) ?? 0,
    label:
      category === "rehydration" && !paybackMeasured ? "incomplete" : "measured",
  }));

  const saved_pct = baseline > 0 ? Math.round((avoided / baseline) * 10000) / 100 : 0;

  const headline_label = !suppressMode
    ? "measured · observe-only (0%)"
    : !paybackMeasured
      ? "measured · pre-rehydration upper bound"
      : "measured";

  return {
    baseline_tokens: baseline,
    actual_tokens: actual,
    avoided_tokens: avoided,
    saved_pct,
    payback_tokens: paybackTotal,
    payback_measured: paybackMeasured,
    cache_read_tokens: 0,
    categories,
    uncategorized_tokens: uncategorized,
    avoided_input_tokens: avoided,
    record_count: scoped.length,
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    suppress_mode: suppressMode,
    headline_label,
  };
}
