/**
 * `th interview …` — the deterministic, STORE-ONLY interview handlers.
 *
 * The Orchestrator runs an ambiguity-scored Socratic loop (`th:run --interview`).
 * All JUDGMENT — the per-dimension scores, the ambiguity number, the captured
 * entities — is produced by the AGENT; the deterministic layer cannot call an LLM
 * (plan Principle 1). These handlers therefore only RECORD what the agent supplies
 * and PERSIST it to `.twinharness/interview.json`. The ONLY value they COMPUTE is
 * `ready = ambiguity <= threshold` (the resolved gate). Everything else is verbatim
 * storage + read-back.
 *
 * Each handler is a convention-conformant `CommandResult` handler (Critical
 * Pattern 1): `paths` first, typed opts second, returns `success()`/`failure()`
 * (never throws, never `process.exit`), emits exactly ONE `structuredLog`.
 *
 * A missing OR corrupt `interview.json` is treated as "not started": `status`
 * reports `started:false`; `record` refuses with `not_started`.
 */

import * as fs from "node:fs";
import type { ProjectPaths } from "../core/paths";
import { atomicWriteFile } from "../core/atomic-io";
import { type CommandResult, success, failure } from "../core/output";
import { structuredLog } from "../core/log";

/** Default ambiguity-gate threshold (spec R15): the run gates once ambiguity ≤ 0.20. */
export const DEFAULT_INTERVIEW_THRESHOLD = 0.2;

/** Per-dimension scores the agent supplies for a round (verbatim — never computed here). */
export interface InterviewScores {
  goal: number;
  constraints: number;
  criteria: number;
}

/** One recorded Socratic round (all fields agent-supplied; stored verbatim). */
export interface InterviewRound {
  question: string;
  answer: string;
  scores: InterviewScores;
  ambiguity: number;
  entities: string[];
}

/** The persisted interview document (`.twinharness/interview.json`). */
export interface InterviewState {
  idea: string;
  threshold: number;
  rounds: InterviewRound[];
  /** The latest round's ambiguity (null until the first round is recorded). */
  ambiguity: number | null;
  status: "in-progress";
}

/** True iff `n` is a finite number within the closed unit interval [0,1]. */
function isUnit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** Validate a parsed value as a well-formed InterviewState (corrupt ⇒ "not started"). */
function isInterviewState(v: unknown): v is InterviewState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.idea !== "string") return false;
  if (!isUnit(o.threshold)) return false;
  if (!Array.isArray(o.rounds)) return false;
  if (!(o.ambiguity === null || isUnit(o.ambiguity))) return false;
  return true;
}

/**
 * Read + validate the interview store. Returns null for a MISSING or CORRUPT file
 * (both mean "not started") — never throws.
 */
function readInterview(paths: ProjectPaths): InterviewState | null {
  try {
    if (!fs.existsSync(paths.interviewFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(paths.interviewFile, "utf8")) as unknown;
    return isInterviewState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic serialization (2-space indent, trailing newline). Uses the same
 * atomic write-then-rename helper as the sibling `state.json` store so a crashed or
 * concurrent write can never leave a half-written `interview.json` (atomicWriteFile
 * creates the parent dir, so no separate mkdir is needed).
 */
function writeInterview(paths: ProjectPaths, state: InterviewState): void {
  atomicWriteFile(paths.interviewFile, JSON.stringify(state, null, 2) + "\n");
}

/** `ready` is the ONLY computed value: the resolved ambiguity gate. */
function computeReady(ambiguity: number | null, threshold: number): boolean {
  return ambiguity !== null && ambiguity <= threshold;
}

export interface InterviewStartOptions {
  idea?: string;
  threshold?: number;
}

/**
 * `th interview start` — create `.twinharness/interview.json` for a new interview.
 * Store-only: records the idea + resolved threshold; no rounds yet. Overwrites any
 * prior interview (a fresh `th:run --interview` starts a clean loop).
 */
export function runInterviewStart(paths: ProjectPaths, opts: InterviewStartOptions = {}): CommandResult {
  const idea = opts.idea?.trim();
  if (!idea) {
    structuredLog({ cmd: "interview start", error: "missing_field", field: "idea" });
    return failure({ human: "Missing required `idea`.", data: { error: "missing_field", field: "idea" } });
  }
  const threshold = opts.threshold ?? DEFAULT_INTERVIEW_THRESHOLD;
  if (!isUnit(threshold)) {
    structuredLog({ cmd: "interview start", error: "invalid_threshold" });
    return failure({
      human: "`threshold` must be a finite number in [0,1].",
      data: { error: "invalid_threshold", threshold },
    });
  }

  const state: InterviewState = { idea, threshold, rounds: [], ambiguity: null, status: "in-progress" };
  writeInterview(paths, state);

  structuredLog({ cmd: "interview start", threshold });
  return success({
    data: { idea, threshold, rounds: 0, ready: false },
    human: `Interview started (threshold ${threshold}).`,
  });
}

export interface InterviewRecordOptions {
  question?: string;
  answer?: string;
  /** Agent-supplied per-dimension scores (validated for shape only — never computed). */
  scores?: unknown;
  ambiguity?: number;
  /** Agent-supplied entity list (validated for shape only). */
  entities?: unknown;
}

/**
 * `th interview record` — append one agent-supplied round to the interview store
 * and update the latest ambiguity. Store-only: every field is taken verbatim; the
 * handler validates shape but COMPUTES nothing except `ready` in the result echo.
 */
export function runInterviewRecord(paths: ProjectPaths, opts: InterviewRecordOptions = {}): CommandResult {
  const existing = readInterview(paths);
  if (!existing) {
    structuredLog({ cmd: "interview record", error: "not_started" });
    return failure({
      human: "No interview in progress. Run `th interview start` first.",
      data: { error: "not_started" },
    });
  }

  const question = opts.question?.trim();
  const answer = opts.answer?.trim();
  if (!question) {
    structuredLog({ cmd: "interview record", error: "missing_field", field: "question" });
    return failure({ human: "Missing required `question`.", data: { error: "missing_field", field: "question" } });
  }
  if (!answer) {
    structuredLog({ cmd: "interview record", error: "missing_field", field: "answer" });
    return failure({ human: "Missing required `answer`.", data: { error: "missing_field", field: "answer" } });
  }

  // Validate the agent-supplied scores shape (goal/constraints/criteria, all FINITE
  // numbers). Number.isFinite (not `typeof === "number"`) so a non-finite score —
  // e.g. `1e999` parses to Infinity over MCP — is rejected rather than silently
  // serialized to `null` by JSON.stringify, which would corrupt the verbatim store.
  const s = opts.scores;
  if (
    typeof s !== "object" ||
    s === null ||
    !Number.isFinite((s as Record<string, unknown>).goal) ||
    !Number.isFinite((s as Record<string, unknown>).constraints) ||
    !Number.isFinite((s as Record<string, unknown>).criteria)
  ) {
    structuredLog({ cmd: "interview record", error: "invalid_scores" });
    return failure({
      human: "`scores` must be an object { goal, constraints, criteria } of numbers.",
      data: { error: "invalid_scores" },
    });
  }
  const scoreRec = s as { goal: number; constraints: number; criteria: number };
  const scores: InterviewScores = {
    goal: scoreRec.goal,
    constraints: scoreRec.constraints,
    criteria: scoreRec.criteria,
  };

  const ambiguity = opts.ambiguity;
  if (!isUnit(ambiguity)) {
    structuredLog({ cmd: "interview record", error: "invalid_ambiguity" });
    return failure({
      human: "`ambiguity` must be a finite number in [0,1].",
      data: { error: "invalid_ambiguity", ambiguity },
    });
  }

  // entities is optional; when present it must be an array of strings.
  let entities: string[] = [];
  if (opts.entities !== undefined) {
    if (!Array.isArray(opts.entities) || opts.entities.some((e) => typeof e !== "string")) {
      structuredLog({ cmd: "interview record", error: "invalid_entities" });
      return failure({
        human: "`entities` must be an array of strings.",
        data: { error: "invalid_entities" },
      });
    }
    entities = opts.entities as string[];
  }

  const round: InterviewRound = { question, answer, scores, ambiguity, entities };
  const next: InterviewState = {
    ...existing,
    rounds: [...existing.rounds, round],
    ambiguity,
  };
  writeInterview(paths, next);

  const ready = computeReady(ambiguity, next.threshold);
  structuredLog({ cmd: "interview record", rounds: next.rounds.length });
  return success({
    data: { rounds: next.rounds.length, ambiguity, threshold: next.threshold, ready },
    human: `Recorded round ${next.rounds.length} (ambiguity ${ambiguity}, ready ${ready}).`,
  });
}

/**
 * `th interview status` — report `{ rounds, ambiguity, threshold, ready }`. A
 * missing/corrupt store reports `started:false` with a default threshold and
 * `ready:false`. Read-only; COMPUTES only `ready`.
 */
export function runInterviewStatus(paths: ProjectPaths): CommandResult {
  const existing = readInterview(paths);
  if (!existing) {
    structuredLog({ cmd: "interview status", started: false });
    return success({
      data: {
        started: false,
        rounds: 0,
        ambiguity: null,
        threshold: DEFAULT_INTERVIEW_THRESHOLD,
        ready: false,
      },
      human: "No interview in progress.",
    });
  }

  const ready = computeReady(existing.ambiguity, existing.threshold);
  structuredLog({ cmd: "interview status", rounds: existing.rounds.length });
  return success({
    data: {
      started: true,
      rounds: existing.rounds.length,
      ambiguity: existing.ambiguity,
      threshold: existing.threshold,
      ready,
    },
    human: `Interview: ${existing.rounds.length} round(s), ambiguity ${existing.ambiguity ?? "n/a"}, threshold ${existing.threshold}, ready ${ready}.`,
  });
}
