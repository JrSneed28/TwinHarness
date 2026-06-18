"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_INTERVIEW_THRESHOLD = void 0;
exports.runInterviewStart = runInterviewStart;
exports.runInterviewRecord = runInterviewRecord;
exports.runInterviewStatus = runInterviewStatus;
const fs = __importStar(require("node:fs"));
const atomic_io_1 = require("../core/atomic-io");
const output_1 = require("../core/output");
const log_1 = require("../core/log");
/** Default ambiguity-gate threshold (spec R15): the run gates once ambiguity ≤ 0.20. */
exports.DEFAULT_INTERVIEW_THRESHOLD = 0.2;
/** True iff `n` is a finite number within the closed unit interval [0,1]. */
function isUnit(n) {
    return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}
/** Validate a parsed value as a well-formed InterviewState (corrupt ⇒ "not started"). */
function isInterviewState(v) {
    if (typeof v !== "object" || v === null)
        return false;
    const o = v;
    if (typeof o.idea !== "string")
        return false;
    if (!isUnit(o.threshold))
        return false;
    if (!Array.isArray(o.rounds))
        return false;
    if (!(o.ambiguity === null || isUnit(o.ambiguity)))
        return false;
    return true;
}
/**
 * Read + validate the interview store. Returns null for a MISSING or CORRUPT file
 * (both mean "not started") — never throws.
 */
function readInterview(paths) {
    try {
        if (!fs.existsSync(paths.interviewFile))
            return null;
        const parsed = JSON.parse(fs.readFileSync(paths.interviewFile, "utf8"));
        return isInterviewState(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
/**
 * Deterministic serialization (2-space indent, trailing newline). Uses the same
 * atomic write-then-rename helper as the sibling `state.json` store so a crashed or
 * concurrent write can never leave a half-written `interview.json` (atomicWriteFile
 * creates the parent dir, so no separate mkdir is needed).
 */
function writeInterview(paths, state) {
    (0, atomic_io_1.atomicWriteFile)(paths.interviewFile, JSON.stringify(state, null, 2) + "\n");
}
/** `ready` is the ONLY computed value: the resolved ambiguity gate. */
function computeReady(ambiguity, threshold) {
    return ambiguity !== null && ambiguity <= threshold;
}
/**
 * `th interview start` — create `.twinharness/interview.json` for a new interview.
 * Store-only: records the idea + resolved threshold; no rounds yet. Overwrites any
 * prior interview (a fresh `th:run --interview` starts a clean loop).
 */
function runInterviewStart(paths, opts = {}) {
    const idea = opts.idea?.trim();
    if (!idea) {
        (0, log_1.structuredLog)({ cmd: "interview start", error: "missing_field", field: "idea" });
        return (0, output_1.failure)({ human: "Missing required `idea`.", data: { error: "missing_field", field: "idea" } });
    }
    const threshold = opts.threshold ?? exports.DEFAULT_INTERVIEW_THRESHOLD;
    if (!isUnit(threshold)) {
        (0, log_1.structuredLog)({ cmd: "interview start", error: "invalid_threshold" });
        return (0, output_1.failure)({
            human: "`threshold` must be a finite number in [0,1].",
            data: { error: "invalid_threshold", threshold },
        });
    }
    const state = { idea, threshold, rounds: [], ambiguity: null, status: "in-progress" };
    writeInterview(paths, state);
    (0, log_1.structuredLog)({ cmd: "interview start", threshold });
    return (0, output_1.success)({
        data: { idea, threshold, rounds: 0, ready: false },
        human: `Interview started (threshold ${threshold}).`,
    });
}
/**
 * `th interview record` — append one agent-supplied round to the interview store
 * and update the latest ambiguity. Store-only: every field is taken verbatim; the
 * handler validates shape but COMPUTES nothing except `ready` in the result echo.
 */
function runInterviewRecord(paths, opts = {}) {
    const existing = readInterview(paths);
    if (!existing) {
        (0, log_1.structuredLog)({ cmd: "interview record", error: "not_started" });
        return (0, output_1.failure)({
            human: "No interview in progress. Run `th interview start` first.",
            data: { error: "not_started" },
        });
    }
    const question = opts.question?.trim();
    const answer = opts.answer?.trim();
    if (!question) {
        (0, log_1.structuredLog)({ cmd: "interview record", error: "missing_field", field: "question" });
        return (0, output_1.failure)({ human: "Missing required `question`.", data: { error: "missing_field", field: "question" } });
    }
    if (!answer) {
        (0, log_1.structuredLog)({ cmd: "interview record", error: "missing_field", field: "answer" });
        return (0, output_1.failure)({ human: "Missing required `answer`.", data: { error: "missing_field", field: "answer" } });
    }
    // Validate the agent-supplied scores shape (goal/constraints/criteria, all FINITE
    // numbers). Number.isFinite (not `typeof === "number"`) so a non-finite score —
    // e.g. `1e999` parses to Infinity over MCP — is rejected rather than silently
    // serialized to `null` by JSON.stringify, which would corrupt the verbatim store.
    const s = opts.scores;
    if (typeof s !== "object" ||
        s === null ||
        !Number.isFinite(s.goal) ||
        !Number.isFinite(s.constraints) ||
        !Number.isFinite(s.criteria)) {
        (0, log_1.structuredLog)({ cmd: "interview record", error: "invalid_scores" });
        return (0, output_1.failure)({
            human: "`scores` must be an object { goal, constraints, criteria } of numbers.",
            data: { error: "invalid_scores" },
        });
    }
    const scoreRec = s;
    const scores = {
        goal: scoreRec.goal,
        constraints: scoreRec.constraints,
        criteria: scoreRec.criteria,
    };
    const ambiguity = opts.ambiguity;
    if (!isUnit(ambiguity)) {
        (0, log_1.structuredLog)({ cmd: "interview record", error: "invalid_ambiguity" });
        return (0, output_1.failure)({
            human: "`ambiguity` must be a finite number in [0,1].",
            data: { error: "invalid_ambiguity", ambiguity },
        });
    }
    // entities is optional; when present it must be an array of strings.
    let entities = [];
    if (opts.entities !== undefined) {
        if (!Array.isArray(opts.entities) || opts.entities.some((e) => typeof e !== "string")) {
            (0, log_1.structuredLog)({ cmd: "interview record", error: "invalid_entities" });
            return (0, output_1.failure)({
                human: "`entities` must be an array of strings.",
                data: { error: "invalid_entities" },
            });
        }
        entities = opts.entities;
    }
    const round = { question, answer, scores, ambiguity, entities };
    const next = {
        ...existing,
        rounds: [...existing.rounds, round],
        ambiguity,
    };
    writeInterview(paths, next);
    const ready = computeReady(ambiguity, next.threshold);
    (0, log_1.structuredLog)({ cmd: "interview record", rounds: next.rounds.length });
    return (0, output_1.success)({
        data: { rounds: next.rounds.length, ambiguity, threshold: next.threshold, ready },
        human: `Recorded round ${next.rounds.length} (ambiguity ${ambiguity}, ready ${ready}).`,
    });
}
/**
 * `th interview status` — report `{ rounds, ambiguity, threshold, ready }`. A
 * missing/corrupt store reports `started:false` with a default threshold and
 * `ready:false`. Read-only; COMPUTES only `ready`.
 */
function runInterviewStatus(paths) {
    const existing = readInterview(paths);
    if (!existing) {
        (0, log_1.structuredLog)({ cmd: "interview status", started: false });
        return (0, output_1.success)({
            data: {
                started: false,
                rounds: 0,
                ambiguity: null,
                threshold: exports.DEFAULT_INTERVIEW_THRESHOLD,
                ready: false,
            },
            human: "No interview in progress.",
        });
    }
    const ready = computeReady(existing.ambiguity, existing.threshold);
    (0, log_1.structuredLog)({ cmd: "interview status", rounds: existing.rounds.length });
    return (0, output_1.success)({
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
