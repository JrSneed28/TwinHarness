"use strict";
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
exports.DEFAULT_INTERVIEW_CUTOFF = void 0;
exports.interviewReady = interviewReady;
exports.runInterviewStart = runInterviewStart;
exports.runInterviewRecord = runInterviewRecord;
exports.runInterviewStatus = runInterviewStatus;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const atomic_io_1 = require("../core/atomic-io");
const output_1 = require("../core/output");
const log_1 = require("../core/log");
const state_store_1 = require("../core/state-store");
const interview_readiness_1 = require("../core/interview-readiness");
/** Default confidence-gate cutoff (spec R15): the run gates once confidence ≥ 0.80. */
exports.DEFAULT_INTERVIEW_CUTOFF = 0.8;
/** True iff `n` is a finite number within the closed unit interval [0,1]. */
function isUnit(n) {
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
function isInterviewState(v) {
    if (typeof v !== "object" || v === null)
        return false;
    const o = v;
    if (typeof o.idea !== "string")
        return false;
    // Accept either the new `cutoff` or the legacy `threshold` gate value.
    const gate = o.cutoff ?? o.threshold;
    if (!isUnit(gate))
        return false;
    if (!Array.isArray(o.rounds))
        return false;
    // Latest-gate value: new `confidence` or legacy `ambiguity`; null/absent allowed.
    const latest = o.confidence ?? o.ambiguity;
    if (!(latest === null || latest === undefined || isUnit(latest)))
        return false;
    return true;
}
/** True iff a parsed object is in the LEGACY `{ threshold, ambiguity }` shape. */
function isLegacyShape(o) {
    return o.cutoff === undefined && o.threshold !== undefined;
}
/**
 * Upgrade a legacy `{ threshold, ambiguity }` document to the new
 * `{ cutoff, confidence }` shape. The flip preserves the gate exactly:
 * `confidence = 1 − ambiguity`, `cutoff = 1 − threshold` (so threshold 0.2 → cutoff 0.8).
 */
function upgradeLegacy(o) {
    const threshold = o.threshold;
    const rawRounds = Array.isArray(o.rounds) ? o.rounds : [];
    const rounds = rawRounds.map((r) => {
        const rr = r;
        const amb = rr.ambiguity;
        const conf = typeof rr.confidence === "number"
            ? rr.confidence
            : typeof amb === "number"
                ? 1 - amb
                : 0;
        return {
            question: String(rr.question ?? ""),
            answer: String(rr.answer ?? ""),
            scores: rr.scores,
            confidence: conf,
            entities: Array.isArray(rr.entities) ? rr.entities : [],
        };
    });
    const latestAmb = o.ambiguity;
    const confidence = typeof latestAmb === "number" ? 1 - latestAmb : null;
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
 *
 * `persist` (default true) controls whether the lazy upgrade is written back to
 * disk. A genuinely READ-ONLY caller (`th interview status`, R-09) passes
 * `persist:false`: it still receives the upgraded shape IN MEMORY (the return value
 * is identical), but no `.bak`/`interview.json` write occurs, so the read leaves the
 * state dir byte-for-byte unchanged. The next mutating `record` migrates on disk.
 */
function readInterview(paths, opts = {}) {
    const persist = opts.persist !== false;
    try {
        if (!fs.existsSync(paths.interviewFile))
            return null;
        const raw = fs.readFileSync(paths.interviewFile, "utf8");
        const parsed = JSON.parse(raw);
        if (!isInterviewState(parsed))
            return null;
        const o = parsed;
        if (isLegacyShape(o)) {
            const upgraded = upgradeLegacy(o);
            // A read-only caller upgrades the shape in memory only — no disk mutation.
            if (!persist)
                return upgraded;
            // Snapshot the legacy file ONCE (pre-mortem #3) before rewriting in the new shape.
            const bak = paths.interviewFile + ".bak";
            try {
                if (!fs.existsSync(bak))
                    fs.writeFileSync(bak, raw, "utf8");
            }
            catch {
                // A failed snapshot must not block the upgrade — the read still succeeds.
            }
            writeInterview(paths, upgraded);
            return upgraded;
        }
        return parsed;
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
    (0, atomic_io_1.atomicWriteFile)(paths.interviewFile, JSON.stringify(state, null, 2) + "\n", { root: paths.root });
}
/** `ready` is the ONLY computed value: the resolved confidence gate. */
function computeReady(confidence, cutoff) {
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
function interviewReady(paths) {
    // R-09: this predicate feeds read-only gate evaluation (e.g. `th next`,
    // `th interview status`) — it must not persist the lazy legacy upgrade, so any
    // read-only tool that consults the interview gate leaves the state dir untouched.
    const existing = readInterview(paths, { persist: false });
    if (!existing)
        return false;
    return computeReady(existing.confidence, existing.cutoff);
}
/**
 * `th interview start` — create `.twinharness/interview.json` for a new interview.
 * Store-only: records the idea + resolved cutoff; no rounds yet. Overwrites any
 * prior interview (a fresh `th:run --interview` starts a clean loop).
 */
function runInterviewStart(paths, opts = {}) {
    const idea = opts.idea?.trim();
    if (!idea) {
        (0, log_1.structuredLog)({ cmd: "interview start", error: "missing_field", field: "idea" });
        return (0, output_1.failure)({ human: "Missing required `idea`.", data: { error: "missing_field", field: "idea" } });
    }
    const cutoff = opts.cutoff ?? exports.DEFAULT_INTERVIEW_CUTOFF;
    if (!isUnit(cutoff)) {
        (0, log_1.structuredLog)({ cmd: "interview start", error: "invalid_cutoff" });
        return (0, output_1.failure)({
            human: "`cutoff` must be a finite number in [0,1].",
            data: { error: "invalid_cutoff", cutoff },
        });
    }
    const state = { idea, cutoff, rounds: [], confidence: null, status: "in-progress" };
    writeInterview(paths, state);
    (0, log_1.structuredLog)({ cmd: "interview start", cutoff });
    return (0, output_1.success)({
        data: { idea, cutoff, rounds: 0, ready: false },
        human: `Interview started (cutoff ${cutoff}).`,
    });
}
/**
 * `th interview record` — append one agent-supplied round to the interview store
 * and update the latest confidence. Store-only: every field is taken verbatim; the
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
    const confidence = opts.confidence;
    if (!isUnit(confidence)) {
        (0, log_1.structuredLog)({ cmd: "interview record", error: "invalid_confidence" });
        return (0, output_1.failure)({
            human: "`confidence` must be a finite number in [0,1].",
            data: { error: "invalid_confidence", confidence },
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
    const round = { question, answer, scores, confidence, entities };
    const next = {
        ...existing,
        rounds: [...existing.rounds, round],
        confidence,
    };
    writeInterview(paths, next);
    const ready = computeReady(confidence, next.cutoff);
    // BSC-9 (Axis-B slice-7): when this round makes the interview READY, mint a backing
    // InterviewReadinessReceipt so the soft interview gate's `interviewReady` claim rides a
    // recomputable correspondence artifact (confidence/cutoff over the interview-store digest
    // + snapshot coordinate), not a self-assertion. Minted AFTER `writeInterview` so the
    // store digest binds the new content, under `withStateLock` (the append serializes the
    // read-modify-append exactly like the other receipt producers). A non-ready round mints
    // nothing — readiness is only asserted (and therefore only requires a receipt) when true.
    if (ready) {
        const storePath = path.relative(paths.root, paths.interviewFile).split(path.sep).join("/");
        (0, state_store_1.withStateLock)(paths, () => (0, interview_readiness_1.appendReadinessReceipt)(paths, {
            refId: (0, interview_readiness_1.readinessRefId)(paths),
            confidence,
            cutoff: next.cutoff,
            storePath,
            producerIdentity: "in-process:interview-record",
        }));
    }
    (0, log_1.structuredLog)({ cmd: "interview record", rounds: next.rounds.length });
    return (0, output_1.success)({
        data: { rounds: next.rounds.length, confidence, cutoff: next.cutoff, ready },
        human: `Recorded round ${next.rounds.length} (confidence ${confidence}, ready ${ready}).`,
    });
}
/**
 * `th interview status` — report `{ rounds, confidence, cutoff, ready }`. A
 * missing/corrupt store reports `started:false` with a default cutoff and
 * `ready:false`. Read-only; COMPUTES only `ready`.
 */
function runInterviewStatus(paths) {
    // R-09: `th interview status` is annotated read-only — never persist the lazy
    // legacy upgrade here. The in-memory upgraded shape still drives the report; the
    // next mutating `record`/`start` migrates the file on disk.
    const existing = readInterview(paths, { persist: false });
    if (!existing) {
        (0, log_1.structuredLog)({ cmd: "interview status", started: false });
        return (0, output_1.success)({
            data: {
                started: false,
                rounds: 0,
                confidence: null,
                cutoff: exports.DEFAULT_INTERVIEW_CUTOFF,
                ready: false,
            },
            human: "No interview in progress.",
        });
    }
    const ready = computeReady(existing.confidence, existing.cutoff);
    (0, log_1.structuredLog)({ cmd: "interview status", rounds: existing.rounds.length });
    return (0, output_1.success)({
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
