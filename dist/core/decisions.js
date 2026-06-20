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
exports.approvalAuditPath = approvalAuditPath;
exports.appendApprovalAudit = appendApprovalAudit;
exports.canonicalText = canonicalText;
exports.computeRecordHash = computeRecordHash;
exports.computeKeyedHash = computeKeyedHash;
exports.readDecisionEvents = readDecisionEvents;
exports.readLastDecisionRecordHash = readLastDecisionRecordHash;
exports.formatDecisionId = formatDecisionId;
exports.mintNextId = mintNextId;
exports.appendDecisionEvent = appendDecisionEvent;
exports.verifyChain = verifyChain;
exports.verifyApprovalSeals = verifyApprovalSeals;
exports.reduceDecisions = reduceDecisions;
exports.sortDecisions = sortDecisions;
exports.canonicalStageLink = canonicalStageLink;
exports.canonicalizeLink = canonicalizeLink;
exports.gatingObligations = gatingObligations;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const paths_1 = require("./paths");
const hash_1 = require("./hash");
Object.defineProperty(exports, "GENESIS_PREV_HASH", { enumerable: true, get: function () { return hash_1.GENESIS_PREV_HASH; } });
const jsonl_1 = require("./jsonl");
const stages_1 = require("./stages");
/** Lifecycle transitions that carry an optional keyed seal (the human-gate events). */
const APPROVAL_TRANSITIONS = new Set(["approved", "rejected", "superseded"]);
/** `<stateDir>/decisions.jsonl` — the decision ledger's location. */
function decisionsPath(paths) {
    return path.join(paths.stateDir, "decisions.jsonl");
}
/**
 * `<stateDir>/approval-audit.jsonl` — the DURABLE approval-attempt audit log
 * (#17, D3). The structured approval log used to be stderr-only and silenceable
 * (`TH_NO_LOG=1`); a forensic record of who approved (or attempted to approve)
 * what must survive a silenced stderr. This file records EVERY `th decision
 * approve` invocation — including ones blocked at the TTY barrier (which never
 * reach decisions.jsonl) — with the observed provenance, so a blocked or declined
 * approval attempt is auditable too. Append-only, gitignored under `.twinharness/`.
 */
function approvalAuditPath(paths) {
    return path.join(paths.stateDir, "approval-audit.jsonl");
}
/**
 * Append one approval-attempt record to the durable audit log. Best-effort and
 * never throws — an unwritable audit file must never break (or silently abort) an
 * approval/governance flow; it is a forensic aid, not a gate.
 */
function appendApprovalAudit(paths, record) {
    try {
        // AC#1 write-surface chokepoint (defense-in-depth, INSIDE the best-effort try):
        // a non-governed target is PREVENTED without crashing — this audit path must
        // never abort a governance flow. approvalAuditPath is under stateDir; the
        // propagating mechanical guard lives at appendDecisionEvent (below).
        (0, paths_1.assertGovernedWriteSurface)(paths.root, approvalAuditPath(paths));
        fs.mkdirSync(paths.stateDir, { recursive: true });
        fs.appendFileSync(approvalAuditPath(paths), JSON.stringify(record) + "\n", "utf8");
    }
    catch {
        // Audit logging must never crash or abort a command.
    }
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
    "provenance",
    "prevHash",
];
/**
 * Canonical key order for an {@link ApprovalProvenance} object so its
 * `JSON.stringify` form is byte-stable inside the sealed canonical text (the
 * field-order discipline that keeps the chain deterministic — REQ-NFR-001).
 */
const PROVENANCE_FIELD_ORDER = [
    "isTTY",
    "ppid",
    "parentComm",
    "hostname",
    "pid",
    "attributionSuspect",
];
/** Re-emit a provenance object in the fixed canonical key order (deterministic JSON). */
function canonicalProvenance(p) {
    const out = {};
    for (const key of PROVENANCE_FIELD_ORDER)
        out[key] = p[key];
    return out;
}
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
        else if (key === "provenance") {
            // Re-emit in the fixed provenance key order so the sealed text is byte-stable.
            ordered[key] = canonicalProvenance(val);
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
/**
 * Keyed seal (C-3b) for an event = HMAC-SHA256(key, canonicalText). Byte-stable
 * given the key — no nonce — so a sealed ledger stays deterministic (REQ-NFR-001).
 * Computed over the SAME canonical text as `recordHash` (keyedHash itself is not in
 * the canonical field order, so the keyless chain is unaffected by its presence).
 */
function computeKeyedHash(event, key) {
    return (0, node_crypto_1.createHmac)("sha256", key).update(canonicalText(event)).digest("hex");
}
// ---------------------------------------------------------------------------
// Tolerant reader (mirrors readLeaseEvents) — never throws
// ---------------------------------------------------------------------------
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
    if (typeof e.prevHash !== "string" || !hash_1.HEX64.test(e.prevHash))
        return false;
    if (typeof e.recordHash !== "string" || !hash_1.HEX64.test(e.recordHash))
        return false;
    if (e.links !== undefined && !Array.isArray(e.links))
        return false;
    if (e.keyedHash !== undefined && typeof e.keyedHash !== "string")
        return false;
    if (e.provenance !== undefined && (typeof e.provenance !== "object" || e.provenance === null))
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
    // Tolerant full forward read via the shared `readJsonlValues` (#11): every line
    // that parses AND passes `isValidEvent`, in file order; bad lines skipped.
    return (0, jsonl_1.readJsonlValues)(decisionsPath(paths), isValidEvent);
}
/**
 * The `recordHash` of the ledger's last VALID event — the only thing
 * `appendDecisionEvent` needs to seal the next link (PERF-009). Reads the file
 * once but parses only the TAIL: it walks lines from the end and `JSON.parse`s
 * just enough to find the last non-empty line that is a valid event, returning
 * its `recordHash`. Missing/empty file, or no valid tail line, → `GENESIS_PREV_HASH`.
 *
 * This is byte-identical to the old `readDecisionEvents(...).at(-1)?.recordHash`
 * derivation: the previous code took the last element of the SAME tolerant,
 * skip-invalid filter, so the last valid event is exactly what this returns — but
 * without the O(N) parse-and-validate of the whole ledger on every append (which
 * made N appends O(N²)). Tolerant by the same contract: a malformed/partial tail
 * line is skipped, so a torn last write never corrupts the next `prevHash`.
 */
function readLastDecisionRecordHash(paths) {
    // Tolerant tail scan via the shared `scanTailValid` (#11): the last line that
    // passes `isValidEvent`; missing file / no valid tail line → GENESIS.
    const last = (0, jsonl_1.scanTailValid)(decisionsPath(paths), isValidEvent);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
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
 * ONLY the current tail to derive `prevHash` (the last valid line's `recordHash`,
 * or GENESIS when empty/absent), sets `prevHash`, computes `recordHash`, then
 * atomically appends `JSON.stringify(sealed) + "\n"` (the lease-ledger pattern).
 *
 * PERF-009: `prevHash` comes from {@link readLastDecisionRecordHash} (tail parse
 * of one line), NOT a full `readDecisionEvents` parse+validate of the whole
 * ledger — so N appends are O(N) total, not O(N²). The sealed line and resulting
 * chain are byte-identical to the prior full-read derivation (the tail helper
 * returns the same last-valid-event `recordHash`).
 *
 * The serialized line stores every field INCLUDING `recordHash`; the hash itself
 * is over the canonical text WITHOUT `recordHash`. Returns the sealed event.
 */
function appendDecisionEvent(paths, event, key) {
    // AC#1 write-surface chokepoint: decisionsPath is under stateDir; the guard fires
    // here (not best-effort — this writer propagates) so a non-governed target throws.
    (0, paths_1.assertGovernedWriteSurface)(paths.root, decisionsPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const prevHash = readLastDecisionRecordHash(paths);
    const withPrev = { ...event, prevHash };
    const recordHash = computeRecordHash(withPrev);
    const sealed = { ...withPrev, recordHash };
    // Keyed seal (C-3b): only on an approval transition, and only when a key was
    // EXPLICITLY supplied (TH_DECISION_KEY) — never auto-generated. keyedHash is not
    // part of the canonical text, so the keyless chain (recordHash/prevHash) is
    // byte-identical whether or not a seal is present.
    if (key && APPROVAL_TRANSITIONS.has(event.event)) {
        sealed.keyedHash = computeKeyedHash(withPrev, key);
    }
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
    let expectedPrev = hash_1.GENESIS_PREV_HASH;
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
/**
 * Verify the optional keyed seals (C-3b) — run ONLY when a key is explicitly
 * supplied. For each approval-transition event that CARRIES a `keyedHash`,
 * recompute the HMAC and flag a mismatch. This catches a competently re-sealed
 * chain (which `verifyChain` cannot): an attacker who re-hashes the keyless chain
 * cannot reproduce a keyed seal without the key, so a left-behind seal stops
 * matching the tampered content.
 *
 * Warn-only by contract: the caller surfaces mismatches as a warning, NOT a
 * fail-closed `chain_broken`, because a per-environment key difference must never
 * turn a legitimately-committed ledger red. Residual limitation (documented): an
 * attacker who STRIPS the keyedHash entirely is not detected here — only the
 * keyless chain continuity (which still breaks on a naive edit) and an explicit
 * out-of-band key policy cover that.
 */
function verifyApprovalSeals(events, key) {
    const mismatches = [];
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (!APPROVAL_TRANSITIONS.has(e.event))
            continue;
        if (e.keyedHash === undefined)
            continue; // unsealed (created without a key) — not a mismatch
        const { recordHash: _rh, keyedHash, ...rest } = e;
        if (computeKeyedHash(rest, key) !== keyedHash) {
            mismatches.push({ index: i, id: e.id });
        }
    }
    return { ok: mismatches.length === 0, mismatches };
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
        if (e.provenance !== undefined)
            d.provenance = e.provenance;
    }
    return [...byId.values()];
}
/** Sort decisions by numeric `DECISION-NNN` suffix (deterministic — REQ-NFR-002). */
function sortDecisions(decisions) {
    return [...decisions].sort((a, b) => (numericSuffix(a.id) ?? 0) - (numericSuffix(b.id) ?? 0));
}
// ---------------------------------------------------------------------------
// gatingObligations — THE single governance predicate (RULE-007)
// ---------------------------------------------------------------------------
/** The canonical identifier of a stage within a decision's `links` array. The
 * stage component is canonicalized (F-6 item 2c) so a near-miss spelling in
 * either the recorded link or `current_stage` cannot make a gating decision
 * silently stop gating. */
function canonicalStageLink(stage) {
    return `stage:${(0, stages_1.canonicalizeStage)(stage)}`;
}
/**
 * Normalize a single link: a `stage:<x>` link has its stage component
 * canonicalized; any other link (REQ-/ADR- traceability) is returned unchanged.
 * Applied both when a link is recorded (`th decision add`) and when comparing in
 * `gatingObligations`, so the two sides always agree.
 */
function canonicalizeLink(link) {
    const prefix = "stage:";
    return link.startsWith(prefix) ? canonicalStageLink(link.slice(prefix.length)) : link;
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
    const wanted = canonicalStageLink(stage); // canonicalizes current_stage
    const obligations = [];
    for (const d of sortDecisions(decisions)) {
        if (d.status === "approved")
            continue;
        // Canonicalize each link's stage component too, so a near-miss spelling on
        // either side still matches (F-6 item 2c).
        if (d.links.some((l) => canonicalizeLink(l) === wanted)) {
            obligations.push({ decisionId: d.id, blockedStage: stage });
        }
    }
    return obligations;
}
