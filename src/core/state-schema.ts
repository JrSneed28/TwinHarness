/**
 * `state.json` schema, validator, canonical serializer, and the initial state.
 *
 * Shape is taken verbatim from the spec §18. Validation is hand-rolled (zero
 * runtime dependencies — plan Principle 3) and returns a precise issue list so
 * `th state verify` and the stop-gate can explain *what* is wrong.
 */

export const TIERS = ["T0", "T1", "T2", "T3"] as const;
export type Tier = (typeof TIERS)[number];

/** The blast-radius set (spec §5): these can never be Tier 0. */
export const BLAST_RADIUS_FLAGS = [
  "authentication",
  "authorization",
  "data-integrity",
  "money",
  "migrations",
] as const;
export type BlastRadiusFlag = (typeof BLAST_RADIUS_FLAGS)[number];

export const SLICE_STATUSES = ["pending", "in-progress", "done", "blocked"] as const;
export type SliceStatus = (typeof SLICE_STATUSES)[number];

export interface ApprovedArtifact {
  file: string;
  version: number;
  hash: string;
}

export interface SliceState {
  id: string;
  status: SliceStatus;
  /** Components touched end-to-end — used for parallel-build serialization (§16). */
  components: string[];
}

export interface TwinHarnessState {
  tier: Tier | null;
  complexity_rationale: string;
  blast_radius_flags: BlastRadiusFlag[];
  current_stage: string;
  approved_artifacts: ApprovedArtifact[];
  summaries_index: string;
  slices: SliceState[];
  implementation_allowed: boolean;
  open_questions: string[];
  drift_open_blocking: number;
  revise_loop_counts: Record<string, number>;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  state?: TwinHarnessState;
}

/** Canonical field order → deterministic serialization → stable content hashes. */
export const STATE_FIELD_ORDER: (keyof TwinHarnessState)[] = [
  "tier",
  "complexity_rationale",
  "blast_radius_flags",
  "current_stage",
  "approved_artifacts",
  "summaries_index",
  "slices",
  "implementation_allowed",
  "open_questions",
  "drift_open_blocking",
  "revise_loop_counts",
];

/** Fresh state written by `th init` — unclassified, implementation not yet allowed. */
export function initialState(): TwinHarnessState {
  return {
    tier: null,
    complexity_rationale: "",
    blast_radius_flags: [],
    current_stage: "init",
    approved_artifacts: [],
    summaries_index: "00-project-summary.md",
    slices: [],
    implementation_allowed: false,
    open_questions: [],
    drift_open_blocking: 0,
    revise_loop_counts: {},
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** Validate an arbitrary parsed value against the state schema. */
export function validateState(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, issues: [{ path: "$", message: "state must be a JSON object" }] };
  }
  const v = value;

  if (!(v.tier === null || (typeof v.tier === "string" && (TIERS as readonly string[]).includes(v.tier)))) {
    issues.push({ path: "tier", message: `must be null or one of ${TIERS.join(", ")}` });
  }

  if (typeof v.complexity_rationale !== "string") {
    issues.push({ path: "complexity_rationale", message: "must be a string" });
  }

  if (!Array.isArray(v.blast_radius_flags)) {
    issues.push({ path: "blast_radius_flags", message: "must be an array" });
  } else {
    v.blast_radius_flags.forEach((f: unknown, i: number) => {
      if (typeof f !== "string" || !(BLAST_RADIUS_FLAGS as readonly string[]).includes(f)) {
        issues.push({ path: `blast_radius_flags[${i}]`, message: `invalid flag "${String(f)}"` });
      }
    });
  }

  if (typeof v.current_stage !== "string" || v.current_stage.length === 0) {
    issues.push({ path: "current_stage", message: "must be a non-empty string" });
  }

  if (!Array.isArray(v.approved_artifacts)) {
    issues.push({ path: "approved_artifacts", message: "must be an array" });
  } else {
    v.approved_artifacts.forEach((a: unknown, i: number) => {
      if (!isPlainObject(a)) {
        issues.push({ path: `approved_artifacts[${i}]`, message: "must be an object" });
        return;
      }
      if (typeof a.file !== "string" || a.file.length === 0) {
        issues.push({ path: `approved_artifacts[${i}].file`, message: "must be a non-empty string" });
      }
      if (!isInteger(a.version) || (a.version as number) < 1) {
        issues.push({ path: `approved_artifacts[${i}].version`, message: "must be a positive integer" });
      }
      if (typeof a.hash !== "string" || a.hash.length === 0) {
        issues.push({ path: `approved_artifacts[${i}].hash`, message: "must be a non-empty string" });
      }
    });
  }

  if (typeof v.summaries_index !== "string") {
    issues.push({ path: "summaries_index", message: "must be a string" });
  }

  if (!Array.isArray(v.slices)) {
    issues.push({ path: "slices", message: "must be an array" });
  } else {
    v.slices.forEach((s: unknown, i: number) => {
      if (!isPlainObject(s)) {
        issues.push({ path: `slices[${i}]`, message: "must be an object" });
        return;
      }
      if (typeof s.id !== "string" || s.id.length === 0) {
        issues.push({ path: `slices[${i}].id`, message: "must be a non-empty string" });
      }
      if (typeof s.status !== "string" || !(SLICE_STATUSES as readonly string[]).includes(s.status)) {
        issues.push({ path: `slices[${i}].status`, message: `must be one of ${SLICE_STATUSES.join(", ")}` });
      }
      if (!Array.isArray(s.components) || s.components.some((c: unknown) => typeof c !== "string")) {
        issues.push({ path: `slices[${i}].components`, message: "must be an array of strings" });
      }
    });
  }

  if (typeof v.implementation_allowed !== "boolean") {
    issues.push({ path: "implementation_allowed", message: "must be a boolean" });
  }

  if (!Array.isArray(v.open_questions) || v.open_questions.some((q: unknown) => typeof q !== "string")) {
    issues.push({ path: "open_questions", message: "must be an array of strings" });
  }

  if (!isInteger(v.drift_open_blocking) || (v.drift_open_blocking as number) < 0) {
    issues.push({ path: "drift_open_blocking", message: "must be a non-negative integer" });
  }

  if (!isPlainObject(v.revise_loop_counts)) {
    issues.push({ path: "revise_loop_counts", message: "must be an object" });
  } else {
    for (const [k, val] of Object.entries(v.revise_loop_counts)) {
      if (!isInteger(val) || (val as number) < 0) {
        issues.push({ path: `revise_loop_counts.${k}`, message: "must be a non-negative integer" });
      }
    }
  }

  // Cross-field invariant — the veto FLOOR (spec §5): Tier 0 is forbidden when
  // any blast-radius flag is present. This makes `th state set tier T0`
  // mechanically refuse with flags set, and makes the stop-gate block such a
  // state (evaluateStopGate rejects invalid state). Guarded on the per-field
  // checks above so it never fires on already-malformed input.
  if (
    v.tier === "T0" &&
    Array.isArray(v.blast_radius_flags) &&
    v.blast_radius_flags.length > 0
  ) {
    issues.push({ path: "tier", message: "Tier 0 is vetoed when blast-radius flags are present (§5)" });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, issues: [], state: value as unknown as TwinHarnessState };
}

/** Deterministic serialization in canonical field order, trailing newline. */
export function serializeState(state: TwinHarnessState): string {
  const ordered: Record<string, unknown> = {};
  for (const key of STATE_FIELD_ORDER) {
    ordered[key] = state[key];
  }
  return JSON.stringify(ordered, null, 2) + "\n";
}
