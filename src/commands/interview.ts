/**
 * `th interview …` — the deterministic, STORE-ONLY interview handlers.
 *
 * The Orchestrator runs a confidence-scored Socratic loop (`th:run --interview`).
 * All JUDGMENT — the per-dimension scores, the confidence number, the captured
 * entities — is produced by the AGENT; the deterministic layer cannot call an LLM
 * (plan Principle 1). These handlers therefore only RECORD what the agent supplies
 * and PERSIST it to `.twinharness/interview.json`. The ONLY value they COMPUTE is
 * `ready = confidence >= cutoff` (the resolved gate). Everything else is verbatim
 * storage + read-back.
 *
 * Each handler is a convention-conformant `CommandResult` handler (Critical
 * Pattern 1): `paths` first, typed opts second, returns `success()`/`failure()`
 * (never throws, never `process.exit`), emits exactly ONE `structuredLog`.
 *
 * A missing OR corrupt `interview.json` is treated as "not started": `status`
 * reports `started:false`; `record` refuses with `not_started`.
 *
 * MIGRATION (semantic flip): the surface was historically `ambiguity` (lower =
 * better) gated by a `threshold` (ready when `ambiguity <= threshold`). It is now
 * `confidence` (higher = better) gated by a `cutoff` (ready when
 * `confidence >= cutoff`). `readInterview` performs a LAZY on-read upgrade of a
 * legacy `{ threshold, ambiguity }` file to the new `{ cutoff, confidence }` shape
 * (`confidence = 1 − ambiguity`, `cutoff = 1 − threshold`), snapshots the legacy
 * file once to `interview.json.bak`, then rewrites it. interview.json carries NO
 * schema_version, so this lazy upgrade is its only migration path.
 */

import * as fs from "node:fs";
import type { ProjectPaths } from "../core/paths";
import { atomicWriteFile } from "../core/atomic-io";
import { type CommandResult, success, failure } from "../core/output";
import { structuredLog } from "../core/log";

/** Default confidence-gate cutoff (spec R15): the run gates once confidence ≥ 0.80. */
export const DEFAULT_INTERVIEW_CUTOFF = 0.8;

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
  confidence: number;
  entities: string[];
}

/** The persisted interview document (`.twinharness/interview.json`). */
export interface InterviewState {
  idea: string;
  cutoff: number;
  rounds: InterviewRound[];
  /** The latest round's confidence (null until the first round is recorded). */
  confidence: number | null;
  status: "in-progress";
}

/** True iff `n` is a finite number within the closed unit interval [0,1]. */
function isUnit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * Validate a parsed value as a well-formed InterviewState. Accepts BOTH the NEW
 * `{ cutoff, confidence }` shape and the LEGACY `{ threshold, ambiguity }` shape
 * during the transition — a legacy file must survive validation so `readInterview`
 * can upgrade it in place (otherwise it would be silently dropped as "not started").
 * The round-level confidence/ambiguity field is intentionally NOT validated here
 * (verbatim store; `record` validates new rounds on the way in). Corrupt ⇒ "not started".
 */
function isInterviewState(v: unknown): v is InterviewState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.idea !== "string") return false;
  // Accept either the new `cutoff` or the legacy `threshold` gate value.
  const gate = o.cutoff ?? o.threshold;
  if (!isUnit(gate)) return false;
  if (!Array.isArray(o.rounds)) return false;
  // Latest-gate value: new `confidence` or legacy `ambiguity`; null/absent allowed.
  const latest = o.confidence ?? o.ambiguity;
  if (!(latest === null || latest === undefined || isUnit(latest))) return false;
  return true;
}

/** True iff a parsed object is in the LEGACY `{ threshold, ambiguity }` shape. */
function isLegacyShape(o: Record<string, unknown>): boolean {
  return o.cutoff === undefined && o.threshold !== undefined;
}

/**
 * Upgrade a legacy `{ threshold, ambiguity }` document to the new
 * `{ cutoff, confidence }` shape. The flip preserves the gate exactly:
 * `confidence = 1 − ambiguity`, `cutoff = 1 − threshold` (so threshold 0.2 → cutoff 0.8).
 */
function upgradeLegacy(o: Record<string, unknown>): InterviewState {
  const threshold = o.threshold as number;
  const rawRounds = Array.isArray(o.rounds) ? o.rounds : [];
  const rounds: InterviewRound[] = rawRounds.map((r) => {
    const rr = r as Record<string, unknown>;
    const amb = rr.ambiguity;
    const conf =
      typeof rr.confidence === "number"
        ? rr.confidence
        : typeof amb === "number"
          ? 1 - amb
          : 0;
    return {
      question: String(rr.question ?? ""),
      answer: String(rr.answer ?? ""),
      scores: rr.scores as InterviewScores,
      confidence: conf,
      entities: Array.isArray(rr.entities) ? (rr.entities as string[]) : [],
    };
  });
  const latestAmb = o.ambiguity;
  const confidence =
    typeof latestAmb === "number" ? 1 - latestAmb : null;
  return {
    idea: String(o.idea ?? ""),
    cutoff: 1 - threshold,
    rounds,
    confidence,
    status: "in-progress",
  };
}

/**
 * Read + validate the interview store. Returns null for a MISSING or CORRUPT file
 * (both mean "not started") — never throws.
 *
 * LAZY UPGRADE: a legacy `{ threshold, ambiguity }` file is snapshotted once to
 * `interview.json.bak`, upgraded to the `{ cutoff, confidence }` shape, and
 * rewritten in place — so every later read sees the new shape.
 */
function readInterview(paths: ProjectPaths): InterviewState | null {
  try {
    if (!fs.existsSync(paths.interviewFile)) return null;
    const raw = fs.readFileSync(paths.interviewFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isInterviewState(parsed)) return null;
    const o = parsed as unknown as Record<string, unknown>;
    if (isLegacyShape(o)) {
      // Snapshot the legacy file ONCE (pre-mortem #3) before rewriting in the new shape.
      const bak = paths.interviewFile + ".bak";
      try {
        if (!fs.existsSync(bak)) fs.writeFileSync(bak, raw, "utf8");
      } catch {
        // A failed snapshot must not block the upgrade — the read still succeeds.
      }
      const upgraded = upgradeLegacy(o);
      writeInterview(paths, upgraded);
      return upgraded;
    }
    return parsed;
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

/** `ready` is the ONLY computed value: the resolved confidence gate. */
function computeReady(confidence: number | null, cutoff: number): boolean {
  return confidence !== null && confidence >= cutoff;
}

/**
 * Interview readiness as a pure predicate (audit finding #14). Reads the interview
 * store and returns the resolved confidence gate (`confidence >= cutoff`). A missing
 * or corrupt store ⇒ NOT ready (the interview has not yet reached readiness). This is
 * the single source of `ready` consumed by the soft interview gate
 * (`checkInterview` in gate-preconditions.ts) so the gate and `th interview status`
 * never disagree about readiness.
 */
export function interviewReady(paths: ProjectPaths): boolean {
  const existing = readInterview(paths);
  if (!existing) return false;
  return computeReady(existing.confidence, existing.cutoff);
}

export interface InterviewStartOptions {
  idea?: string;
  cutoff?: number;
}

/**
 * `th interview start` — create `.twinharness/interview.json` for a new interview.
 * Store-only: records the idea + resolved cutoff; no rounds yet. Overwrites any
 * prior interview (a fresh `th:run --interview` starts a clean loop).
 */
export function runInterviewStart(paths: ProjectPaths, opts: InterviewStartOptions = {}): CommandResult {
  const idea = opts.idea?.trim();
  if (!idea) {
    structuredLog({ cmd: "interview start", error: "missing_field", field: "idea" });
    return failure({ human: "Missing required `idea`.", data: { error: "missing_field", field: "idea" } });
  }
  const cutoff = opts.cutoff ?? DEFAULT_INTERVIEW_CUTOFF;
  if (!isUnit(cutoff)) {
    structuredLog({ cmd: "interview start", error: "invalid_cutoff" });
    return failure({
      human: "`cutoff` must be a finite number in [0,1].",
      data: { error: "invalid_cutoff", cutoff },
    });
  }

  const state: InterviewState = { idea, cutoff, rounds: [], confidence: null, status: "in-progress" };
  writeInterview(paths, state);

  structuredLog({ cmd: "interview start", cutoff });
  return success({
    data: { idea, cutoff, rounds: 0, ready: false },
    human: `Interview started (cutoff ${cutoff}).`,
  });
}

export interface InterviewRecordOptions {
  question?: string;
  answer?: string;
  /** Agent-supplied per-dimension scores (validated for shape only — never computed). */
  scores?: unknown;
  confidence?: number;
  /** Agent-supplied entity list (validated for shape only). */
  entities?: unknown;
}

/**
 * `th interview record` — append one agent-supplied round to the interview store
 * and update the latest confidence. Store-only: every field is taken verbatim; the
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

  const confidence = opts.confidence;
  if (!isUnit(confidence)) {
    structuredLog({ cmd: "interview record", error: "invalid_confidence" });
    return failure({
      human: "`confidence` must be a finite number in [0,1].",
      data: { error: "invalid_confidence", confidence },
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

  const round: InterviewRound = { question, answer, scores, confidence, entities };
  const next: InterviewState = {
    ...existing,
    rounds: [...existing.rounds, round],
    confidence,
  };
  writeInterview(paths, next);

  const ready = computeReady(confidence, next.cutoff);
  structuredLog({ cmd: "interview record", rounds: next.rounds.length });
  return success({
    data: { rounds: next.rounds.length, confidence, cutoff: next.cutoff, ready },
    human: `Recorded round ${next.rounds.length} (confidence ${confidence}, ready ${ready}).`,
  });
}

/**
 * `th interview status` — report `{ rounds, confidence, cutoff, ready }`. A
 * missing/corrupt store reports `started:false` with a default cutoff and
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
        confidence: null,
        cutoff: DEFAULT_INTERVIEW_CUTOFF,
        ready: false,
      },
      human: "No interview in progress.",
    });
  }

  const ready = computeReady(existing.confidence, existing.cutoff);
  structuredLog({ cmd: "interview status", rounds: existing.rounds.length });
  return success({
    data: {
      started: true,
      rounds: existing.rounds.length,
      confidence: existing.confidence,
      cutoff: existing.cutoff,
      ready,
    },
    human: `Interview: ${existing.rounds.length} round(s), confidence ${existing.confidence ?? "n/a"}, cutoff ${existing.cutoff}, ready ${ready}.`,
  });
}
