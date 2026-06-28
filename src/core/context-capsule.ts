/**
 * context-capsule.ts — Control Capsule generation (S1; D-01/D-02/D-17).
 *
 * Pure + deterministic: same inputs → same capsule → same hash. No I/O beyond
 * reading the state values passed in. Reuses `estimateTokens` from
 * context-telemetry.ts and `hashContent` from hash.ts.
 *
 * Budget tiers (D-02): micro ~1.5K tok / standard ~2K; hard-capped < 10K (D-17).
 * The safety subset (mandatory:true) is never dropped under any budget (D-01).
 */

import type { TwinHarnessState } from "./state-schema";
import { hashContent } from "./hash";
import { estimateTokens } from "./context-telemetry";

// ---------------------------------------------------------------------------
// Token budgets (D-02 / D-17)
// ---------------------------------------------------------------------------

/** Micro capsule budget: ~1 500 tokens (T0/T1 auto-run, no blast-radius). */
export const MICRO_BUDGET_TOKENS = 1_500;

/** Standard capsule budget: ~2 000 tokens. */
export const STANDARD_BUDGET_TOKENS = 2_000;

/**
 * Absolute hard cap (D-17): capsule MUST stay under this token count.
 * Narrative fields collapse to an overflow pointer when the cap is breached.
 */
export const HARD_CAP_TOKENS = 9_999;

// ---------------------------------------------------------------------------
// Budget preset
// ---------------------------------------------------------------------------

export type BudgetPreset = "micro" | "standard";

const BUDGET_TOKENS_BY_PRESET: Record<BudgetPreset, number> = {
  micro: MICRO_BUDGET_TOKENS,
  standard: STANDARD_BUDGET_TOKENS,
};

// ---------------------------------------------------------------------------
// Capsule schema (D-01)
// ---------------------------------------------------------------------------

/**
 * D-01 ordered Control Capsule. All 16 content fields + capsule_hash are present
 * on every returned object; the safety subset ({@link MANDATORY_CAPSULE_FIELDS})
 * is never absent or replaced with an overflow pointer regardless of budget pressure.
 */
export interface Capsule {
  /** Project objective derived from complexity_rationale. */
  objective: string;
  /** Effective tier string (T0–T3 or "unclassified"). */
  tier: string;
  /** Active workflow stage (e.g. "implementation"). */
  stage: string;
  /** Active in-progress slice IDs or wave label. */
  slice_or_wave: string;
  /** Slice IDs treated as requirement anchors (exact IDs — mandatory). */
  requirement_ids: string[];
  /** Approved artifact constraint refs: "file:vN:hash12" format (mandatory). */
  approved_constraints: string[];
  /** Blast-radius flags active on the project (mandatory). */
  blast_radius_flags: string[];
  /** Open blocking drift / debate counts as descriptor strings (mandatory). */
  open_blocking_drift: string[];
  /** Open questions from state (narrative — drops first under budget). */
  open_decisions: string[];
  /** Blocked slice IDs (narrative). */
  failures_blockers: string[];
  /** Done slices with touched components (narrative). */
  side_effects_performed: string[];
  /** Recommended next action derived from state (narrative). */
  next_action: string;
  /** Completion criteria for the current stage (mandatory). */
  completion_criteria: string;
  /**
   * SHA-256 hex of canonical(capsule-without-hash). Deterministic given the same
   * inputs. Computed last so it covers the full budget-enforced capsule body.
   */
  capsule_hash: string;
  /** Residency epoch at generation time (mandatory). */
  epoch: number;
  /** ISO-8601 generation timestamp (mandatory). */
  generated_at: string;
}

/**
 * Fields in the mandatory (safety) subset — never dropped or overflowed under
 * budget pressure (policies, approvals, blast-radius, gate status, completion
 * criteria, open blocking drift, exact IDs/hashes/limits/dates).
 */
export const MANDATORY_CAPSULE_FIELDS: ReadonlySet<keyof Capsule> = new Set([
  "tier",
  "stage",
  "requirement_ids",
  "approved_constraints",
  "blast_radius_flags",
  "open_blocking_drift",
  "completion_criteria",
  "capsule_hash",
  "epoch",
  "generated_at",
]);

/**
 * Narrative fields, ordered by drop priority (least critical first).
 * These are replaced with an overflow pointer when the capsule exceeds its budget.
 */
const NARRATIVE_FIELDS_DROP_ORDER: ReadonlyArray<keyof Capsule> = [
  "objective",
  "side_effects_performed",
  "failures_blockers",
  "open_decisions",
  "next_action",
  "slice_or_wave",
];

/** Overflow pointer injected when a narrative field is collapsed due to budget. */
const OVERFLOW_POINTER = "[overflow — `th context rehydrate` to restore full capsule]";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CapsuleOptions {
  /** Token budget preset; defaults to "standard". */
  budget?: BudgetPreset;
  /** Residency epoch at generation time; defaults to 0. */
  epoch?: number;
  /**
   * ISO-8601 generation timestamp. Pass a fixed string in tests to keep the
   * hash deterministic; production callers may omit this (defaults to now).
   */
  generatedAt?: string;
}

// ---------------------------------------------------------------------------
// Canonical serialization (for capsule_hash)
// ---------------------------------------------------------------------------

/**
 * Recursive canonical JSON: object keys sorted alphabetically, no whitespace.
 * Deterministic regardless of insertion order — used to derive `capsule_hash`.
 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${(v as unknown[]).map(canonicalJson).join(",")}]`;
  const rec = v as Record<string, unknown>;
  const pairs = Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`);
  return `{${pairs.join(",")}}`;
}

// ---------------------------------------------------------------------------
// State → capsule body helpers (pure, no I/O)
// ---------------------------------------------------------------------------

function deriveSliceOrWave(state: TwinHarnessState): string {
  const active = state.slices.filter((s) => s.status === "in-progress").map((s) => s.id);
  if (active.length > 0) return active.join(", ");
  const pending = state.slices.filter((s) => s.status === "pending").map((s) => s.id);
  if (pending.length > 0) {
    const shown = pending.slice(0, 5).join(", ");
    const extra = pending.length > 5 ? ` (+${pending.length - 5} more)` : "";
    return `pending: ${shown}${extra}`;
  }
  return "none";
}

function deriveOpenBlockingDrift(state: TwinHarnessState): string[] {
  const items: string[] = [];
  const drift = state.drift_open_blocking ?? 0;
  const debate = state.debate_open_blocking ?? 0;
  if (drift > 0) items.push(`drift_open_blocking=${drift}`);
  if (debate > 0) items.push(`debate_open_blocking=${debate}`);
  return items;
}

function deriveApprovedConstraints(state: TwinHarnessState): string[] {
  return state.approved_artifacts.map((a) => `${a.file}:v${a.version}:${a.hash.slice(0, 12)}`);
}

function deriveNextAction(state: TwinHarnessState): string {
  if (!state.implementation_allowed) {
    return `Complete stage "${state.current_stage}" gates — implementation not yet allowed.`;
  }
  const inProgress = state.slices.filter((s) => s.status === "in-progress");
  if (inProgress.length > 0) {
    return `Complete in-progress slices: ${inProgress.map((s) => s.id).join(", ")}.`;
  }
  const pending = state.slices.filter((s) => s.status === "pending");
  if (pending.length > 0) {
    const shown = pending.slice(0, 3).map((s) => s.id).join(", ");
    const extra = pending.length > 3 ? ` (+${pending.length - 3} more)` : "";
    return `Start pending slices: ${shown}${extra}.`;
  }
  return `All slices complete — advance past stage "${state.current_stage}".`;
}

function deriveCompletionCriteria(state: TwinHarnessState, stage: string): string {
  const parts: string[] = [`stage="${stage}" gates pass`];
  const drift = (state.drift_open_blocking ?? 0) + (state.debate_open_blocking ?? 0);
  if (drift > 0) parts.push(`resolve ${drift} blocking drift(s)`);
  if (state.open_questions.length > 0) {
    parts.push(`close ${state.open_questions.length} open question(s)`);
  }
  const notDone = state.slices.filter((s) => s.status !== "done").length;
  if (notDone > 0) parts.push(`complete ${notDone} remaining slice(s)`);
  if (state.blast_radius_flags.length > 0) {
    parts.push(`all blast-radius gates cleared (${state.blast_radius_flags.join(", ")})`);
  }
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

type CapsuleBody = Omit<Capsule, "capsule_hash">;

function estimateBodyTokens(body: CapsuleBody): number {
  return estimateTokens(JSON.stringify(body));
}

function collapseField(value: unknown): unknown {
  if (Array.isArray(value)) return [OVERFLOW_POINTER];
  return OVERFLOW_POINTER;
}

/**
 * Enforce the soft budget and the D-17 hard cap.
 *
 * Narrative fields are collapsed to an overflow pointer in drop-priority order
 * until the capsule fits within `budgetTokens`. A second pass over all narrative
 * fields runs if the result still exceeds {@link HARD_CAP_TOKENS}.
 */
function enforceBudget(body: CapsuleBody, budgetTokens: number): CapsuleBody {
  if (estimateBodyTokens(body) <= budgetTokens) return body;

  // Soft-budget pass: collapse narrative fields from least critical first.
  let current: CapsuleBody = body;
  for (const field of NARRATIVE_FIELDS_DROP_ORDER) {
    if (estimateBodyTokens(current) <= budgetTokens) break;
    current = { ...current, [field]: collapseField(current[field as keyof CapsuleBody]) };
  }

  // Hard-cap pass: if still over the absolute limit, collapse all remaining narrative fields.
  if (estimateBodyTokens(current) > HARD_CAP_TOKENS) {
    for (const field of NARRATIVE_FIELDS_DROP_ORDER) {
      current = { ...current, [field]: collapseField(current[field as keyof CapsuleBody]) };
    }
  }

  return current;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * D-01/D-02 — generate a Control Capsule from the current project state.
 *
 * Pure and deterministic: same `state` + `tier` + `stage` + fixed `opts.generatedAt`
 * always yields the same {@link Capsule} and the same `capsule_hash`.
 *
 * @param state   Validated project state (read from `state.json`).
 * @param tier    Effective tier string to embed (e.g. "T2", "unclassified").
 * @param stage   Active workflow stage (e.g. "implementation").
 * @param opts    Budget preset, epoch, and timestamp overrides.
 */
export function capsuleFromState(
  state: TwinHarnessState,
  tier: string,
  stage: string,
  opts: CapsuleOptions = {},
): Capsule {
  const budgetPreset: BudgetPreset = opts.budget ?? "standard";
  const budgetTokens = BUDGET_TOKENS_BY_PRESET[budgetPreset];
  const epoch = opts.epoch ?? 0;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();

  // Build the full capsule body (all narrative fields populated).
  const fullBody: CapsuleBody = {
    objective: state.complexity_rationale || "No objective recorded.",
    tier,
    stage,
    slice_or_wave: deriveSliceOrWave(state),
    requirement_ids: state.slices.map((s) => s.id),
    approved_constraints: deriveApprovedConstraints(state),
    blast_radius_flags: [...state.blast_radius_flags],
    open_blocking_drift: deriveOpenBlockingDrift(state),
    open_decisions: [...state.open_questions],
    failures_blockers: state.slices.filter((s) => s.status === "blocked").map((s) => s.id),
    side_effects_performed: state.slices
      .filter((s) => s.status === "done")
      .map((s) => `${s.id}(${s.components.join(",")})`),
    next_action: deriveNextAction(state),
    completion_criteria: deriveCompletionCriteria(state, stage),
    epoch,
    generated_at: generatedAt,
  };

  // Apply budget enforcement — narrative fields may be collapsed; mandatory fields never are.
  const body = enforceBudget(fullBody, budgetTokens);

  // capsule_hash covers the full budget-enforced body (D-01: canonical, without hash field).
  const capsule_hash = hashContent(canonicalJson(body));

  return { ...body, capsule_hash };
}
