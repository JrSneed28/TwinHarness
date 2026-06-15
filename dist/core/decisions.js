"use strict";
/**
 * Decision-governance store (spec §6.4 / SLICE-4) — the data-integrity
 * blast-radius core. Append-only, SHA-256 hash-chained `decisions.jsonl`
 * (`<stateDir>/decisions.jsonl`), one `DecisionEvent` per line.
 *
 * Mirrors `src/core/leases.ts` exactly: a tolerant read-only parser
 * (`readDecisionEvents`) that never throws and skips malformed/partial lines, an
 * atomic-append writer (`appendDecisionEvent`) that runs under the caller's
 * `withStateLock` span, and a pure reducer (`reduceDecisions`) over the event
 * log. The hash chain (`prevHash`/`recordHash` via `hashContent`) is what makes a
 * forged, edited, or reordered approval mechanically detectable (`verifyChain`).
 *
 * ADR-001: sidecar JSONL, no `state.json` schema bump. The CLI only records and
 * computes against this file; the gating predicate (`gatingObligations`) is the
 * SINGLE source of truth (RULE-007) consumed by both `runDecisionCheck` and the
 * `th next` rung — there is exactly one implementation.
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
exports.GENESIS_PREV_HASH = void 0;
exports.decisionsPath = decisionsPath;
exports.canonicalText = canonicalText;
exports.computeRecordHash = computeRecordHash;
exports.readDecisionEvents = readDecisionEvents;
exports.formatDecisionId = formatDecisionId;
exports.mintNextId = mintNextId;
exports.appendDecisionEvent = appendDecisionEvent;
exports.verifyChain = verifyChain;
exports.reduceDecisions = reduceDecisions;
exports.sortDecisions = sortDecisions;
exports.findDecision = findDecision;
exports.canonicalStageLink = canonicalStageLink;
exports.gatingObligations = gatingObligations;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const hash_1 = require("./hash");
/** `prevHash` of the very first event line — 64 hex zeros (DS-001). */
exports.GENESIS_PREV_HASH = "0".repeat(64);
/** `<stateDir>/decisions.jsonl` — the decision ledger's location. */
function decisionsPath(paths) {
    return path.join(paths.stateDir, "decisions.jsonl");
}
// ---------------------------------------------------------------------------
// Canonical text + hashing (DS-001) — the tamper-evidence core
// ---------------------------------------------------------------------------
/**
 * The fixed canonical field order for hashing (DS-001 / TD §Hash-Chain). Mirrors
 * the deterministic-JSON discipline of `serializeState`: copy fields into a fresh
 * object in THIS order, omit any `undefined` key, and omit `recordHash` entirely.
 * `links` is sorted lexicographically before inclusion.
 */
const CANONICAL_FIELD_ORDER = [
    "id",
    "event",
    "title",
    "rationale",
    "links",
    "supersededBy",
    "proposer",
    "proposedAt",
    "approver",
    "approvedAt",
    "prevHash",
];
/**
 * Deterministic canonical text of an event for hashing (DS-001). Field order is
 * fixed; `undefined` keys and `recordHash` are dropped; `links` is sorted
 * lexicographically; `JSON.stringify` with no indentation. `hashContent` then
 * CRLF→LF normalizes (harmless — the canonical text contains no CRLF).
 */
function canonicalText(event) {
    const ordered = {};
    for (const key of CANONICAL_FIELD_ORDER) {
        const val = event[key];
        if (val === undefined)
            continue;
        if (key === "links") {
            // Sort a COPY lexicographically; never mutate the caller's array.
            ordered[key] = [...val].sort();
        }
        else {
            ordered[key] = val;
        }
    }
    return JSON.stringify(ordered);
}
/** `recordHash` for an event = SHA-256 of its canonical text (recordHash omitted). */
function computeRecordHash(event) {
    return (0, hash_1.hashContent)(canonicalText(event));
}
// ---------------------------------------------------------------------------
// Tolerant reader (mirrors readLeaseEvents) — never throws
// ---------------------------------------------------------------------------
const HEX64 = /^[0-9a-f]{64}$/;
const ID_RE = /^DECISION-\d{3,}$/;
const EVENT_TYPES = new Set(["proposed", "approved", "rejected", "superseded"]);
/** Validate the shape of a parsed line; malformed lines are skipped (DS-001). */
function isValidEvent(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const e = parsed;
    if (typeof e.id !== "string" || !ID_RE.test(e.id))
        return false;
    if (typeof e.event !== "string" || !EVENT_TYPES.has(e.event))
        return false;
    if (typeof e.prevHash !== "string" || !HEX64.test(e.prevHash))
        return false;
    if (typeof e.recordHash !== "string" || !HEX64.test(e.recordHash))
        return false;
    if (e.links !== undefined && !Array.isArray(e.links))
        return false;
    return true;
}
/**
 * Read + parse every decision event in file order. Missing file → `[]`. Bad
 * lines (non-JSON, partial-tail, schema-invalid) are silently skipped — tolerant,
 * never throws (mirrors `readLeaseEvents`). Chain breaks surface via
 * `verifyChain`, not here.
 */
function readDecisionEvents(paths) {
    const file = decisionsPath(paths);
    if (!fs.existsSync(file))
        return [];
    const out = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (isValidEvent(parsed))
                out.push(parsed);
        }
        catch {
            // Tolerant: skip malformed / partial-tail lines.
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// Id minting (DS-001 / TD §Id-Minting) — monotonic; never reused
// ---------------------------------------------------------------------------
/** Parse the numeric suffix of a `DECISION-NNN` id, or null when it doesn't match. */
function numericSuffix(id) {
    const m = /^DECISION-(\d+)$/.exec(id);
    if (!m)
        return null;
    return Number(m[1]);
}
/** Format `DECISION-NNN`, zero-padded to 3 digits (pads past 999). */
function formatDecisionId(n) {
    return `DECISION-${String(n).padStart(3, "0")}`;
}
/**
 * Mint the next id from the EVER-SEEN set: `max(numeric suffix across all ids in
 * the file) + 1`, or 1 when empty. Mints from every event (any type), so a
 * rejected/superseded id is never reused — monotonic and immutable (REQ-407,
 * RULE-002). Deterministic for a given file (REQ-NFR-002).
 */
function mintNextId(events) {
    let max = 0;
    for (const e of events) {
        const n = numericSuffix(e.id);
        if (n !== null && n > max)
            max = n;
    }
    return formatDecisionId(max + 1);
}
// ---------------------------------------------------------------------------
// Atomic append (mirrors appendLeaseEvent) — runs under withStateLock
// ---------------------------------------------------------------------------
/**
 * Append one decision event, sealing the hash chain. The caller MUST already
 * hold the `withStateLock` span (read-modify-append is serialized there). Reads
 * the current tail to derive `prevHash` (the last line's `recordHash`, or GENESIS
 * when empty/absent), sets `prevHash`, computes `recordHash`, then atomically
 * appends `JSON.stringify(sealed) + "\n"` (the lease-ledger pattern).
 *
 * The serialized line stores every field INCLUDING `recordHash`; the hash itself
 * is over the canonical text WITHOUT `recordHash`. Returns the sealed event.
 */
function appendDecisionEvent(paths, event) {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const existing = readDecisionEvents(paths);
    const prevHash = existing.length > 0 ? existing[existing.length - 1].recordHash : exports.GENESIS_PREV_HASH;
    const withPrev = { ...event, prevHash };
    const recordHash = computeRecordHash(withPrev);
    const sealed = { ...withPrev, recordHash };
    fs.appendFileSync(decisionsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
    return sealed;
}
/**
 * Walk events in file order with a running `expectedPrev = GENESIS`. For each
 * event: recompute `recordHash` from its canonical text — a mismatch means the
 * record was edited (a forged/swapped field). If `prevHash !== expectedPrev` the
 * line was inserted, deleted, or reordered. Return `{ ok:false, brokenAt:N }` at
 * the FIRST break; else advance `expectedPrev = event.recordHash`.
 *
 * Any single-record mutation breaks that record's `recordHash` AND every
 * subsequent `prevHash`, so one linear pass detects tampering (ADR-001).
 */
function verifyChain(events) {
    let expectedPrev = exports.GENESIS_PREV_HASH;
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const { recordHash, ...rest } = e;
        const recomputed = computeRecordHash(rest);
        if (recomputed !== recordHash) {
            return { ok: false, brokenAt: i, reason: "edited" };
        }
        if (e.prevHash !== expectedPrev) {
            return { ok: false, brokenAt: i, reason: "prev_mismatch" };
        }
        expectedPrev = e.recordHash;
    }
    return { ok: true };
}
// ---------------------------------------------------------------------------
// reduceDecisions (TD §latest-event-wins) — event log → read model
// ---------------------------------------------------------------------------
/**
 * Reduce the event log to the current decision set. The `proposed` event seeds a
 * decision's identity, content (`title`/`rationale`/`links`), and proposer audit;
 * each later event for the same id updates `status` and the approver audit
 * (latest-event-wins). Order is preserved by first-seen, then callers sort by
 * numeric suffix for deterministic output.
 */
function reduceDecisions(events) {
    const byId = new Map();
    for (const e of events) {
        let d = byId.get(e.id);
        if (!d) {
            d = {
                id: e.id,
                title: e.title ?? "",
                rationale: e.rationale ?? "",
                status: e.event,
                links: e.links ? [...e.links] : [],
            };
            byId.set(e.id, d);
        }
        // Content fields seed on the first (proposed) event; carry-forward only when set.
        if (e.title !== undefined)
            d.title = e.title;
        if (e.rationale !== undefined)
            d.rationale = e.rationale;
        if (e.links !== undefined)
            d.links = [...e.links];
        // Status is always the latest event type.
        d.status = e.event;
        // Audit fields.
        if (e.proposer !== undefined)
            d.proposer = e.proposer;
        if (e.proposedAt !== undefined)
            d.proposedAt = e.proposedAt;
        if (e.approver !== undefined)
            d.approver = e.approver;
        if (e.approvedAt !== undefined)
            d.approvedAt = e.approvedAt;
        if (e.supersededBy !== undefined)
            d.supersededBy = e.supersededBy;
    }
    return [...byId.values()];
}
/** Sort decisions by numeric `DECISION-NNN` suffix (deterministic — REQ-NFR-002). */
function sortDecisions(decisions) {
    return [...decisions].sort((a, b) => (numericSuffix(a.id) ?? 0) - (numericSuffix(b.id) ?? 0));
}
/** Look up a single reduced decision by id (convenience for the handlers). */
function findDecision(events, id) {
    return reduceDecisions(events).find((d) => d.id === id);
}
// ---------------------------------------------------------------------------
// gatingObligations — THE single governance predicate (RULE-007)
// ---------------------------------------------------------------------------
/** The canonical identifier of a stage within a decision's `links` array. */
function canonicalStageLink(stage) {
    return `stage:${stage}`;
}
/**
 * The single gating predicate (RULE-007 — only implementation; both
 * `runDecisionCheck` and the `th next` rung call THIS function so they cannot
 * disagree). A decision `d` gates iff BOTH:
 *   1. `d.status !== "approved"` (proposed / rejected / superseded all still gate;
 *      rejection does NOT clear the gate — DQ-002).
 *   2. `d.links` contains the canonical id of `state.current_stage`
 *      (`stage:<current_stage>`) — stage-linked only; REQ-IDs/ADR-ids in `links`
 *      are traceability, never gates (DQ-001).
 *
 * Output is sorted by numeric id suffix (deterministic — REQ-NFR-002).
 * `state` may be undefined / lack a current stage → no gate → empty array.
 */
function gatingObligations(decisions, state) {
    const stage = state?.current_stage;
    if (!stage)
        return [];
    const wanted = canonicalStageLink(stage);
    const obligations = [];
    for (const d of sortDecisions(decisions)) {
        if (d.status === "approved")
            continue;
        if (d.links.includes(wanted)) {
            obligations.push({ decisionId: d.id, blockedStage: stage });
        }
    }
    return obligations;
}
