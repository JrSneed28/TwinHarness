"use strict";
/**
 * Append-only gate-mutation ledger (audit finding F5).
 *
 * The mechanical gates (Stop-gate, write-gate) only bind a *compliant* agent:
 * the orchestrator legitimately sets `implementation_allowed`, the blast-radius
 * `tier`, and resolves blocking drift via the same `th` CLI. The CLI cannot tell
 * *who* invoked it (the agent runs every `th` command), so this ledger does NOT
 * claim provenance — it provides a timestamped, append-only RECORD of every
 * gate-relevant state change so a human reviewing afterwards can see exactly
 * when `implementation_allowed` flipped, when blocking drift opened/closed, etc.
 *
 * It is observability, not enforcement: it never blocks a mutation. Writes are
 * best-effort and must never crash a command. The ledger lives next to the state
 * it audits (`<stateDir>/gate-ledger.jsonl`), one JSON object per line.
 *
 * TAMPER-EVIDENCE (GOV-2). Each NEW entry is sealed into a SHA-256 hash chain —
 * `prevHash` (the previous sealed entry's `recordHash`, GENESIS for the first)
 * plus `recordHash` (this entry's own canonical-text hash) — mirroring the
 * decision ledger (`src/core/decisions.ts`). An actor who edits, reorders, or
 * deletes a sealed entry breaks the chain detectably (`verifyLedgerChain`).
 *
 * Two deliberate differences from the decision ledger:
 *   1. Payload keys are DYNAMIC (`[key]: unknown`), so the canonical text sorts
 *      keys lexicographically instead of using a fixed field order.
 *   2. `ts` is PART of the sealed content (the gate ledger is intentionally
 *      clock-bearing), so backdating `ts` on a sealed entry is itself a tamper
 *      signal. Determinism (REQ-NFR-001) still holds: for a GIVEN entry (its `ts`
 *      included) the hash is identical on every OS — `hashContent` is clock-free
 *      and CRLF→LF-normalized; the only non-determinism is the `ts` captured at
 *      append time, which becomes immutable sealed content thereafter.
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
exports.GATE_LEDGER_KEYS = exports.GENESIS_PREV_HASH = void 0;
exports.ledgerPath = ledgerPath;
exports.ledgerCanonicalText = ledgerCanonicalText;
exports.computeLedgerRecordHash = computeLedgerRecordHash;
exports.computeLedgerKeyedHash = computeLedgerKeyedHash;
exports.readLastLedgerRecordHash = readLastLedgerRecordHash;
exports.appendLedger = appendLedger;
exports.appendHighWater = appendHighWater;
exports.readLedger = readLedger;
exports.verifyLedgerChain = verifyLedgerChain;
exports.verifyLedgerSeals = verifyLedgerSeals;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const paths_1 = require("./paths");
const hash_1 = require("./hash");
Object.defineProperty(exports, "GENESIS_PREV_HASH", { enumerable: true, get: function () { return hash_1.GENESIS_PREV_HASH; } });
const jsonl_1 = require("./jsonl");
/** Top-level state keys whose mutation is gate-relevant and therefore audited. */
exports.GATE_LEDGER_KEYS = new Set([
    "implementation_allowed",
    "drift_open_blocking",
    "debate_open_blocking",
    "write_gate",
    "tier",
    "blast_radius_flags",
    // RC-C / R-04 (DR-02): the gate-DEFINING config fields. An `--emergency` raw
    // write of any of these moves a gate (skip slices / drop UX-UI stages / vanish
    // the interview gate / lower the interview cutoff), so it must seal a ledger
    // entry + high-water anchor just like the other gate-owned fields above. These
    // are flat scalars (string / boolean / number), so `ledgerCanonicalText` seals
    // them deterministically.
    "delivery_mode",
    "has_ui",
    "interview_required",
    "interview_cutoff",
]);
/** `<stateDir>/gate-ledger.jsonl` — the audit record's location. */
function ledgerPath(paths) {
    return path.join(paths.stateDir, "gate-ledger.jsonl");
}
// ---------------------------------------------------------------------------
// Canonical text + hashing (GOV-2) — the tamper-evidence core
// ---------------------------------------------------------------------------
/**
 * Deterministic canonical text of an entry for hashing. Because payload keys are
 * DYNAMIC (unlike the decision ledger's fixed field order), every own key is
 * emitted with keys SORTED lexicographically — `recordHash` is EXCLUDED (it is
 * the hash output, not input), `prevHash` is INCLUDED (it chains the record).
 * `JSON.stringify` with no indentation; `hashContent` then CRLF→LF normalizes
 * (harmless — the canonical text contains no CRLF). Key-order-independent: the
 * same logical entry hashes identically regardless of property insertion order.
 */
function ledgerCanonicalText(entry) {
    const ordered = {};
    // Only TOP-LEVEL keys are sorted. Payload values must be primitives or flat
    // arrays (all callers pass string/number/boolean/string[] — e.g.
    // blast_radius_flags); a nested OBJECT value would NOT be key-normalized, so do
    // not seal one without extending this canonicalizer.
    for (const key of Object.keys(entry).sort()) {
        // Neither hash output is an input to the canonical text: `recordHash` is the
        // keyless digest, `keyedHash` is the optional HMAC seal (#8). Excluding both
        // keeps the keyless recordHash/chain byte-identical whether or not a seal exists.
        if (key === "recordHash" || key === "keyedHash")
            continue;
        const val = entry[key];
        if (val === undefined)
            continue; // omit absent keys (mirrors decisions)
        ordered[key] = val;
    }
    return JSON.stringify(ordered);
}
/** `recordHash` for an entry = SHA-256 of its canonical text (recordHash omitted). */
function computeLedgerRecordHash(entry) {
    return (0, hash_1.hashContent)(ledgerCanonicalText(entry));
}
/**
 * OPTIONAL keyed seal (GOV-2 / #8) for an entry = HMAC-SHA256(key, canonicalText).
 * Byte-stable given the key — no nonce — so a sealed ledger stays deterministic
 * (REQ-NFR-001). Computed over the SAME canonical text as `recordHash` (`keyedHash`
 * is excluded from that text, so the keyless chain is unaffected by its presence).
 * Mirrors `computeKeyedHash` in the decision ledger.
 */
function computeLedgerKeyedHash(entry, key) {
    return (0, node_crypto_1.createHmac)("sha256", key).update(ledgerCanonicalText(entry)).digest("hex");
}
// ---------------------------------------------------------------------------
// Tail read (PERF — mirrors readLastDecisionRecordHash) — last sealed link only
// ---------------------------------------------------------------------------
/**
 * The `recordHash` of the ledger's last SEALED entry — the only thing
 * `appendLedger` needs to chain the next link. Reads the file once but parses
 * only the TAIL: it walks lines from the end and `JSON.parse`s just enough to
 * find the last non-empty line that carries a valid `recordHash`, returning it.
 * Missing/empty file, or no sealed tail line (a fully-legacy ledger), →
 * `GENESIS_PREV_HASH` (so the first NEW sealed entry anchors the chain).
 *
 * Tail-only (not a full `readLedger`) so N appends stay O(N) total, not O(N²)
 * (mirrors `readLastDecisionRecordHash`). Tolerant: a malformed / partial-tail
 * line, or a legacy unsealed line, is skipped while scanning upward.
 */
function readLastLedgerRecordHash(paths) {
    // Last sealed entry = the last line that is an object carrying a HEX64
    // `recordHash`; legacy/unsealed lines (no valid recordHash) are skipped while
    // scanning upward. None / missing file → GENESIS (the first NEW seal anchors the
    // chain). The tolerant tail scan is the shared `scanTailValid` (#11).
    const last = (0, jsonl_1.scanTailValid)(ledgerPath(paths), (p) => {
        if (typeof p !== "object" || p === null)
            return false;
        const rh = p.recordHash;
        return typeof rh === "string" && hash_1.HEX64.test(rh);
    });
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * Append one entry to the gate ledger, sealing it into the hash chain.
 * Best-effort: a ledger failure must NEVER crash the command that triggered it
 * (mirrors `structuredLog`). The `ts` is captured here and becomes part of the
 * sealed content. `prevHash` is the last sealed entry's `recordHash` (GENESIS
 * when none — the migration anchor for a fresh or fully-legacy ledger), derived
 * from a tail read so N appends are O(N) total. The serialized line stores every
 * field INCLUDING `recordHash`; the hash itself is over the canonical text
 * WITHOUT `recordHash`.
 *
 * OPT-IN KEYED SEAL (GOV-2 / #8): when `TH_LEDGER_KEY` is set in the environment,
 * an HMAC `keyedHash` over the same canonical text is also attached (never
 * auto-generated; an unset/empty key seals nothing). `keyedHash` is excluded from
 * the canonical text, so the keyless `recordHash`/chain is byte-identical whether
 * or not a key is in use — a ledger built without a key stays fully back-compatible.
 */
function appendLedger(paths, entry) {
    try {
        // AC#1 write-surface chokepoint (defense-in-depth, INSIDE the best-effort try):
        // a non-governed target is PREVENTED (the append below never runs) without
        // crashing — the audit path's contract is "never throw" (mirrors `structuredLog`).
        // ledgerPath is always under stateDir, so this never false-rejects a legitimate
        // append; the propagating mechanical guarantee lives at the non-best-effort sites
        // (appendDecisionEvent / appendLeaseEvent / atomicWriteFile).
        (0, paths_1.assertGovernedWriteSurface)(paths.root, ledgerPath(paths));
        fs.mkdirSync(paths.stateDir, { recursive: true });
        const prevHash = readLastLedgerRecordHash(paths);
        // Build the unsealed entry first (the ts captured here becomes sealed
        // content), hash it, then seal. LedgerEntry's index signature (`[key]:
        // unknown`) widens the spread of `entry`'s keys to `unknown`, so we assemble a
        // plain record and assert the LedgerEntry shape — ts/event/prevHash/recordHash
        // are provably present and string-typed below.
        const withPrev = { ts: new Date().toISOString(), ...entry, prevHash };
        const recordHash = computeLedgerRecordHash(withPrev);
        const sealed = { ...withPrev, recordHash };
        // Opt-in keyed seal: only when TH_LEDGER_KEY is explicitly set (empty/unset →
        // no seal). Over the SAME canonical text as recordHash, so the keyless chain is
        // unchanged. Separate trust domain from TH_DECISION_KEY — do not reuse that key.
        const key = process.env.TH_LEDGER_KEY;
        if (key) {
            sealed.keyedHash = computeLedgerKeyedHash(withPrev, key);
        }
        fs.appendFileSync(ledgerPath(paths), JSON.stringify(sealed) + "\n", "utf8");
    }
    catch {
        // Never throw from the audit path.
    }
}
/**
 * Append a SEALED in-chain HIGH-WATER ANCHOR `{ event:"high-water", count:N }`,
 * where N = the number of SEALED entries currently in the ledger (entries carrying
 * a `recordHash`), i.e. the count BEFORE this anchor (it excludes itself). The
 * count is sealed content, so rewriting it in place breaks the keyless chain (an
 * EDIT, detected by `verifyLedgerChain`). Re-homed INTO the chain (ADR-001 sidecar
 * precedent) rather than an UNSEALED `state.json` counter an attacker could edit.
 *
 * SCOPE (documented residual — #8 threat model): this does NOT make tail truncation
 * detectable. `verifyLedgerChain` is a length-agnostic forward walk, so a truncated
 * tail past this anchor is a valid PREFIX and still verifies `ok`. The honest gain
 * over an unsealed counter is (a) edit/reorder/mid-delete of the anchor gets the
 * same chain protection as any sealed entry, and (b) no unsealed sidecar exists.
 * Do NOT add a `count <= sealed-run-length` "regression" check — it is CIRCULAR
 * (both operands are read from the same truncatable ledger and shrink together).
 */
function appendHighWater(paths) {
    const sealedCount = readLedger(paths).filter((e) => typeof e.recordHash === "string").length;
    appendLedger(paths, { event: "high-water", count: sealedCount });
}
/** Read + parse every ledger entry. Missing file → empty. Bad lines skipped.
 *  Tolerant full forward read via the shared `readJsonlValues` (#11). */
function readLedger(paths) {
    return (0, jsonl_1.readJsonlValues)(ledgerPath(paths), (p) => typeof p === "object" && p !== null);
}
/**
 * Verify the tamper-evidence chain over the ledger's SEALED entries.
 *
 * MIGRATION / BACK-COMPAT (CRITICAL). Existing ledgers predate sealing: their
 * leading lines have NO `recordHash`. Those legacy/unsealed entries form an
 * unverifiable PRE-MIGRATION PREFIX that is NOT a tamper signal — we cannot
 * recompute a chain that was never written. So this walks only the CONTIGUOUS
 * RUN OF SEALED entries (those carrying a `recordHash`): it skips the leading
 * legacy prefix, then anchors the first sealed entry's `prevHash` to GENESIS
 * (the migration anchor — the first seal starts a fresh chain) and walks the
 * rest. A sealed entry appearing AFTER the run begins but missing its own
 * `recordHash` is treated as a deletion/tamper within the sealed run
 * ("prev_mismatch" surfaces at the next sealed line whose `prevHash` no longer
 * matches). Indices in the result are absolute (into the passed `entries`).
 *
 * Within the sealed run: recompute each entry's `recordHash` from its canonical
 * text — a mismatch means the record was edited (a forged/swapped/backdated
 * field, since `ts` is sealed) → "edited". If `prevHash !== expectedPrev` the
 * line was inserted, deleted, or reordered → "prev_mismatch". Return the first
 * break; else advance `expectedPrev = entry.recordHash`. Any single-record
 * mutation breaks that record's `recordHash` AND every subsequent `prevHash`, so
 * one linear pass detects tampering.
 */
function verifyLedgerChain(entries) {
    // Locate the first SEALED entry; everything before it is the legacy prefix.
    let start = -1;
    for (let i = 0; i < entries.length; i++) {
        const rh = entries[i].recordHash;
        if (typeof rh === "string" && hash_1.HEX64.test(rh)) {
            start = i;
            break;
        }
    }
    if (start === -1)
        return { ok: true }; // fully-legacy (unsealed) ledger — nothing to verify
    let expectedPrev = hash_1.GENESIS_PREV_HASH; // first sealed entry anchors to GENESIS
    for (let i = start; i < entries.length; i++) {
        const e = entries[i];
        const { recordHash, ...rest } = e;
        // A sealed run must remain sealed: a missing/invalid recordHash inside the run
        // is itself tamper (a deleted seal). recomputed !== (undefined) → "edited".
        const recomputed = computeLedgerRecordHash(rest);
        if (recomputed !== recordHash) {
            return { ok: false, brokenAt: i, reason: "edited" };
        }
        if ((e.prevHash ?? hash_1.GENESIS_PREV_HASH) !== expectedPrev) {
            return { ok: false, brokenAt: i, reason: "prev_mismatch" };
        }
        expectedPrev = recordHash;
    }
    return { ok: true };
}
/**
 * Verify the optional keyed seals (GOV-2 / #8) — run ONLY when a key is explicitly
 * supplied. For each entry that CARRIES a `keyedHash`, recompute the HMAC over its
 * canonical text and flag a mismatch. This catches a competently re-sealed keyless
 * chain (which `verifyLedgerChain` cannot): an attacker who re-hashes the keyless
 * chain after editing a field cannot reproduce a left-behind `keyedHash` without
 * `TH_LEDGER_KEY`, so the stale seal stops matching the tampered content.
 *
 * WARN-ONLY by contract (mirrors `verifyApprovalSeals`): the caller surfaces
 * mismatches as a WARNING, never a fail-closed break, because a per-environment key
 * difference (or the wrong key) must never turn a legitimately-committed ledger red.
 * Residual (documented, mirrors decisions.ts): an attacker who STRIPS the keyedHash
 * entirely — or who holds the key — is not detected here; the key is held out-of-band.
 */
function verifyLedgerSeals(entries, key) {
    const mismatches = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (typeof e.keyedHash !== "string")
            continue; // unsealed (no keyed seal) — not a mismatch
        const { recordHash: _rh, keyedHash, ...rest } = e;
        if (computeLedgerKeyedHash(rest, key) !== keyedHash) {
            mismatches.push({ index: i, event: typeof e.event === "string" ? e.event : "" });
        }
    }
    return { ok: mismatches.length === 0, mismatches };
}
