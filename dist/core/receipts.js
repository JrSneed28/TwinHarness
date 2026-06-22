"use strict";
/**
 * Terminal-transition receipt store (Axis-B slice-1a / BSC-4 — the keystone the
 * other 8 blind-spot classes copy). An irreversible ledger flip — a drift
 * resolved, a simulation retired, a decision approved — currently clears the
 * completion gate from a marker/attestation alone, with NO correspondence to
 * source. This module mints a schema-registered `TerminalTransitionReceipt` whose
 * *ground* (a content digest of the named source target + the repository snapshot
 * coordinate it was minted at) is recomputable at gate time, so a flip that does
 * not actually resolve in source is mechanically detectable.
 *
 * Storage mirrors `src/core/decisions.ts` EXACTLY: append-only, SHA-256
 * hash-chained `<stateDir>/terminal-receipts.jsonl`, one receipt per line, a
 * tolerant reader that never throws (`readTerminalReceipts`), a tail-scan for the
 * next `prevHash` (`readLastReceiptRecordHash`), an atomic-append writer that runs
 * under the CALLER's `withStateLock` span (`appendTerminalReceipt`), and a
 * tamper-detecting chain walk (`verifyReceiptChain`). A dedicated store gives the
 * gate one validated reader and slice-1b's external (un-writable) producer a
 * distinct location.
 *
 * The shared digest formula (`computeTargetDigest`) is modeled on
 * `tester.ts:computeReceiptDigest` (F8 content-bound-digest) but DOES NOT import
 * or modify it — F8's call path stays byte-identical and F8 tests stay green. It
 * is the SINGLE formula used by BOTH the producer (at creation) and the validator
 * (at gate time), so the two sides can never drift apart on the binding.
 *
 * `producer_identity` carries ZERO trust weight in-process (execution doc §2.4):
 * it is an audit breadcrumb only. The genuine un-forgeable property arrives in
 * slice-1b (an external keyed producer at a write-surface TwinHarness cannot
 * reach). Documented as such so a reviewer never mistakes it for a trust anchor.
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
exports.TargetUnresolvedError = void 0;
exports.canonicalText = canonicalText;
exports.computeRecordHash = computeRecordHash;
exports.terminalReceiptsPath = terminalReceiptsPath;
exports.externalReceiptsPath = externalReceiptsPath;
exports.readTerminalReceipts = readTerminalReceipts;
exports.readExternalReceipts = readExternalReceipts;
exports.readLastExternalReceiptRecordHash = readLastExternalReceiptRecordHash;
exports.readLastReceiptRecordHash = readLastReceiptRecordHash;
exports.verifyReceiptChain = verifyReceiptChain;
exports.targetResolvesInSource = targetResolvesInSource;
exports.computeTargetDigest = computeTargetDigest;
exports.currentSnapshotCoord = currentSnapshotCoord;
exports.appendTerminalReceipt = appendTerminalReceipt;
exports.readReceiptValidated = readReceiptValidated;
exports.receiptMigrationDone = receiptMigrationDone;
exports.grandfatheredBaseline = grandfatheredBaseline;
exports.collectTerminalEntities = collectTerminalEntities;
exports.ensureReceiptMigration = ensureReceiptMigration;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
const hash_1 = require("./hash");
const jsonl_1 = require("./jsonl");
const git_revision_1 = require("./git-revision");
const drift_log_1 = require("./drift-log");
const decisions_1 = require("./decisions");
const receipt_signing_1 = require("./receipt-signing");
// ---------------------------------------------------------------------------
// Canonical text + hashing (mirrors decisions.ts) — the tamper-evidence core
// ---------------------------------------------------------------------------
/**
 * The fixed canonical field order for hashing. Mirrors decisions.ts: copy fields
 * into a fresh object in THIS order, omit any `undefined` key, omit `recordHash`
 * entirely. The two nested objects (`target_resolves_in_source`, `snapshot_coord`)
 * are re-emitted in a FIXED key order so the canonical text is byte-stable (the
 * `canonicalProvenance` technique from decisions.ts).
 */
const CANONICAL_FIELD_ORDER = [
    "kind",
    "refId",
    "target_resolves_in_source",
    "snapshot_coord",
    "producer_identity",
    // Slice-1b — `producer_kind` + `key_id` join the canonical (and therefore MAC-
    // bound) input AFTER producer_identity, BEFORE legacy. `signature` is DELIBERATELY
    // absent here: like `recordHash`, it is a TRAILER excluded from canonicalText, so
    // both the recordHash and the signature are computed over the IDENTICAL bytes.
    // canonicalText() skips undefined keys, so a slice-1a receipt (all three new fields
    // absent) produces the byte-identical canonical text — and recordHash — as before.
    "producer_kind",
    "key_id",
    "legacy",
    "prevHash",
];
/** Canonical key order for {@link TargetResolvesInSource} (byte-stable nested JSON). */
const TARGET_FIELD_ORDER = ["path", "digest"];
/** Canonical key order for {@link SnapshotCoord} (byte-stable nested JSON). */
const SNAPSHOT_FIELD_ORDER = ["gitHead", "treeDigest"];
/** Re-emit a nested object in a fixed key order (deterministic JSON). */
function reorder(obj, order) {
    const out = {};
    for (const key of order)
        out[key] = obj[key];
    return out;
}
/**
 * Deterministic canonical text of a receipt for hashing. Field order is fixed;
 * `undefined` keys and `recordHash` are dropped; the two nested objects are
 * re-emitted in their fixed key order; `JSON.stringify` with no indentation.
 * `hashContent` then CRLF→LF normalizes (harmless — the canonical text contains
 * no CRLF).
 */
function canonicalText(receipt) {
    const ordered = {};
    for (const key of CANONICAL_FIELD_ORDER) {
        const val = receipt[key];
        if (val === undefined)
            continue;
        if (key === "target_resolves_in_source") {
            ordered[key] = reorder(val, TARGET_FIELD_ORDER);
        }
        else if (key === "snapshot_coord") {
            ordered[key] = reorder(val, SNAPSHOT_FIELD_ORDER);
        }
        else {
            ordered[key] = val;
        }
    }
    return JSON.stringify(ordered);
}
/** `recordHash` for a receipt = SHA-256 of its canonical text (recordHash omitted). */
function computeRecordHash(receipt) {
    return (0, hash_1.hashContent)(canonicalText(receipt));
}
// ---------------------------------------------------------------------------
// Storage (mirrors decisions.ts)
// ---------------------------------------------------------------------------
/** `<stateDir>/terminal-receipts.jsonl` — the in-process terminal-receipt ledger. */
function terminalReceiptsPath(paths) {
    return path.join(paths.stateDir, "terminal-receipts.jsonl");
}
/**
 * `<stateDir>/external-receipts.jsonl` — the EXTERNAL keyed producer's store
 * (slice-1b). A SEPARATE file purely for LOCK-ISOLATION: the out-of-process producer
 * appends here without taking the in-process `withStateLock` span, so it never
 * contends with a running `th`. The SECURITY boundary is NOT this path — it is the
 * HMAC key the line is signed with; a forged line written here is rejected by
 * {@link readReceiptValidated} (no verifying signature ⇒ `forged`), exactly as one
 * written into the in-process store would be.
 */
function externalReceiptsPath(paths) {
    return path.join(paths.stateDir, "external-receipts.jsonl");
}
const KIND_VALUES = new Set(["drift-resolve", "sim-retire", "decision-approve"]);
/** Validate the shape of a parsed line; malformed lines are skipped (tolerant). */
function isValidReceipt(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const r = parsed;
    if (typeof r.kind !== "string" || !KIND_VALUES.has(r.kind))
        return false;
    if (typeof r.refId !== "string" || r.refId === "")
        return false;
    if (typeof r.producer_identity !== "string")
        return false;
    if (typeof r.prevHash !== "string" || !hash_1.HEX64.test(r.prevHash))
        return false;
    if (typeof r.recordHash !== "string" || !hash_1.HEX64.test(r.recordHash))
        return false;
    if (r.legacy !== undefined && typeof r.legacy !== "boolean")
        return false;
    // Slice-1b OPTIONAL signing fields: accepted when present, NEVER required — an old
    // slice-1a receipt (all three absent) stays valid + hash-identical. A present field
    // must be well-shaped (a malformed signing field makes the line tolerant-skipped,
    // never silently treated as a verifying external receipt).
    if (r.producer_kind !== undefined && r.producer_kind !== "external" && r.producer_kind !== "in-process")
        return false;
    if (r.key_id !== undefined && typeof r.key_id !== "string")
        return false;
    if (r.signature !== undefined && (typeof r.signature !== "string" || !hash_1.HEX64.test(r.signature)))
        return false;
    // Nested ground objects must be present and shaped.
    const tgt = r.target_resolves_in_source;
    if (typeof tgt !== "object" || tgt === null)
        return false;
    const t = tgt;
    if (typeof t.path !== "string" || typeof t.digest !== "string")
        return false;
    const snap = r.snapshot_coord;
    if (typeof snap !== "object" || snap === null)
        return false;
    const s = snap;
    if (!(s.gitHead === null || typeof s.gitHead === "string"))
        return false;
    if (!(s.treeDigest === null || typeof s.treeDigest === "string"))
        return false;
    return true;
}
/**
 * Read + parse every receipt in file order. Missing file → `[]`. Bad lines
 * (non-JSON, partial-tail, schema-invalid) are silently skipped — tolerant, never
 * throws (mirrors `readDecisionEvents`). Chain breaks surface via
 * {@link verifyReceiptChain}, not here.
 */
function readTerminalReceipts(paths) {
    return (0, jsonl_1.readJsonlValues)(terminalReceiptsPath(paths), isValidReceipt);
}
/**
 * Read + parse every receipt in the EXTERNAL store (slice-1b), same tolerant shape
 * as {@link readTerminalReceipts} (same `isValidReceipt`). Missing file → `[]`; bad
 * lines skipped; never throws. The signature on a line is verified at gate time by
 * {@link readReceiptValidated}, NOT here — this reader is shape-only, so a
 * forged-but-well-shaped line is returned and then classified `forged` downstream.
 */
function readExternalReceipts(paths) {
    return (0, jsonl_1.readJsonlValues)(externalReceiptsPath(paths), isValidReceipt);
}
/**
 * The `recordHash` of the EXTERNAL store's last valid receipt — the `prevHash` seed
 * for the external producer's own append-only hash chain (it is its OWN chain,
 * anchored independently of the in-process ledger). Missing/empty/no-valid-tail →
 * `GENESIS_PREV_HASH`. Used by the standalone producer script (`scripts/
 * th-receipt-producer.mjs`) via the compiled dist.
 */
function readLastExternalReceiptRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(externalReceiptsPath(paths), isValidReceipt);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * The `recordHash` of the ledger's last VALID receipt — the only thing
 * {@link appendTerminalReceipt} needs to seal the next link. Tail-scans the file
 * (parses only down to the last valid line) so N appends stay O(N) total.
 * Missing/empty file, or no valid tail line → `GENESIS_PREV_HASH`.
 */
function readLastReceiptRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(terminalReceiptsPath(paths), isValidReceipt);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * Walk receipts in file order with a running `expectedPrev = GENESIS`. For each
 * receipt: recompute `recordHash` from its canonical text — a mismatch means the
 * record was edited. If `prevHash !== expectedPrev` the line was inserted,
 * deleted, or reordered. Return `{ ok:false, brokenAt:N }` at the FIRST break;
 * else advance `expectedPrev = receipt.recordHash`. Byte-identical posture to
 * `decisions.verifyChain`.
 */
function verifyReceiptChain(receipts) {
    let expectedPrev = hash_1.GENESIS_PREV_HASH;
    for (let i = 0; i < receipts.length; i++) {
        const r = receipts[i];
        const { recordHash, ...rest } = r;
        const recomputed = computeRecordHash(rest);
        if (recomputed !== recordHash) {
            return { ok: false, brokenAt: i, reason: "edited" };
        }
        if (r.prevHash !== expectedPrev) {
            return { ok: false, brokenAt: i, reason: "prev_mismatch" };
        }
        expectedPrev = r.recordHash;
    }
    return { ok: true };
}
// ---------------------------------------------------------------------------
// Shared digest / snapshot helpers — the SINGLE formula used by producer AND validator
// ---------------------------------------------------------------------------
/**
 * True iff `relPath` resolves to a readable, REGULAR file CONTAINED within
 * `root`. Uses {@link resolveWithinRoot} for the same cross-platform containment
 * posture the rest of TwinHarness takes (rejects absolute-elsewhere, `..`,
 * symlink/junction escape). A directory, a missing path, or a path-escape → false.
 */
function targetResolvesInSource(root, relPath) {
    return computeTargetDigest(root, relPath) !== null;
}
/**
 * The SINGLE shared content-binding formula (modeled on
 * `tester.ts:computeReceiptDigest`, NOT importing it). Resolve `relPath` within
 * `root` (path-escape → null), require a readable regular file (else null), and
 * return `hashContent(<file utf8>)` — CRLF-normalized, since these are text
 * targets. Returns `null` whenever the target does not resolve, which is the
 * negative signal both the producer (refuse-at-creation) and the validator
 * (`target_missing`) key on.
 */
function computeTargetDigest(root, relPath) {
    if (relPath === "")
        return null;
    const abs = (0, paths_1.resolveWithinRoot)(root, relPath);
    if (abs === null)
        return null; // path-escape / absolute-elsewhere / junction escape
    try {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
            return null;
        return (0, hash_1.hashContent)(fs.readFileSync(abs, "utf8"));
    }
    catch {
        return null; // unreadable → does not resolve
    }
}
/**
 * The current repository snapshot coordinate (reuses `git-revision.ts`). Both
 * fields null on a non-git checkout — non-discriminating (F8 honesty). The single
 * helper the producer calls at mint time and the validator calls at gate time.
 */
function currentSnapshotCoord(root) {
    return { gitHead: (0, git_revision_1.gitHead)(root), treeDigest: (0, git_revision_1.dirtyTreeDigest)(root) };
}
/**
 * Thrown by {@link appendTerminalReceipt} when `targetPath` is supplied but does
 * NOT resolve in source (negative-control **c** at creation: a producer refuses
 * to mint a receipt whose ground is already missing).
 */
class TargetUnresolvedError extends Error {
    target;
    /** Stable machine token for the CLI failure envelope. */
    code = "receipt_target_unresolved";
    constructor(message, 
    /** The offending (root-relative) target path. */
    target) {
        super(message);
        this.target = target;
        this.name = "TargetUnresolvedError";
    }
}
exports.TargetUnresolvedError = TargetUnresolvedError;
/**
 * Append one terminal-transition receipt, sealing the hash chain. The caller MUST
 * already hold the `withStateLock` span (read-modify-append is serialized there),
 * exactly like `appendDecisionEvent`.
 *
 * If `targetPath` is supplied it MUST resolve in source (negative-control **c**):
 * a non-resolving target throws {@link TargetUnresolvedError} BEFORE any write, so
 * a flip whose ground is already missing cannot be minted. The receipt records the
 * digest of that target and the current snapshot coordinate, then derives
 * `prevHash` from the tail, computes `recordHash`, asserts the write-surface, and
 * atomically appends `JSON.stringify(sealed) + "\n"`. Returns the sealed receipt.
 */
function appendTerminalReceipt(paths, input) {
    let targetPath = "";
    let digest = "";
    if (input.targetPath !== undefined && input.targetPath !== "") {
        const d = computeTargetDigest(paths.root, input.targetPath);
        if (d === null) {
            throw new TargetUnresolvedError(`Refusing to mint a ${input.kind} receipt for ${input.refId}: target "${input.targetPath}" does not resolve in source.`, input.targetPath);
        }
        targetPath = input.targetPath;
        digest = d;
    }
    return sealAndAppend(paths, {
        kind: input.kind,
        refId: input.refId,
        target_resolves_in_source: { path: targetPath, digest },
        snapshot_coord: currentSnapshotCoord(paths.root),
        producer_identity: input.producerIdentity,
    });
}
/**
 * Append a one-time `legacy:true` backfill stamp (migration §4). A legacy receipt
 * carries an EMPTY target (it grounds nothing — it is grandfathered), the snapshot
 * coordinate of the moment, and `producer_identity: "legacy-backfill"`. Internal:
 * only {@link ensureReceiptMigration} mints these.
 */
function appendLegacyReceipt(paths, kind, refId) {
    return sealAndAppend(paths, {
        kind,
        refId,
        target_resolves_in_source: { path: "", digest: "" },
        snapshot_coord: currentSnapshotCoord(paths.root),
        producer_identity: "legacy-backfill",
        legacy: true,
    });
}
/**
 * The shared seal+append chokepoint: derive `prevHash` from the tail, compute
 * `recordHash`, assert the governed write-surface, mkdir, atomically append. The
 * single place a receipt line is written, so the real and legacy producers stay
 * byte-consistent on the chain mechanics.
 */
function sealAndAppend(paths, receipt) {
    // AC#1 write-surface chokepoint: terminalReceiptsPath is under stateDir; the
    // guard fires here (propagating, not best-effort) so a non-governed target throws.
    (0, paths_1.assertGovernedWriteSurface)(paths.root, terminalReceiptsPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const prevHash = readLastReceiptRecordHash(paths);
    const withPrev = { ...receipt, prevHash };
    const recordHash = computeRecordHash(withPrev);
    const sealed = { ...withPrev, recordHash };
    fs.appendFileSync(terminalReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
    return sealed;
}
/**
 * Compare a recorded coordinate against the current one under the F8 rule: a
 * coordinate discriminates ONLY when BOTH the recorded and the current value are
 * non-null. A null on either side is non-discriminating (a non-git checkout, or a
 * receipt minted before the coordinate existed) and never contributes staleness.
 * Returns the list of diverged coordinate names (empty = not stale).
 */
function snapshotStaleReasons(recorded, current) {
    const reasons = [];
    if (recorded.gitHead !== null && current.gitHead !== null && recorded.gitHead !== current.gitHead) {
        reasons.push("gitHead");
    }
    if (recorded.treeDigest !== null &&
        current.treeDigest !== null &&
        recorded.treeDigest !== current.treeDigest) {
        reasons.push("treeDigest");
    }
    return reasons;
}
/**
 * Apply the slice-1a CONTENT checks to a present, non-legacy receipt, returning a
 * pass/fail status. On PASS, the caller-supplied `passStatus` is returned —
 * `"valid"` for an in-process/attested receipt (slice-1a, unchanged) or
 * `"valid-grounded"` for a signature-verified external receipt (slice-1b). On FAIL,
 * the specific slice-1a fail token (`target_missing` / `target_mismatch` / `stale`)
 * — IDENTICAL discrimination for both producer kinds, so an external receipt whose
 * target was deleted/edited or whose snapshot drifted blocks exactly like an
 * in-process one.
 *
 * decision-approve is build-coordinate-only (execution doc §6): no target block, no
 * snapshot staleness — a present non-legacy receipt passes.
 */
function classifyReceiptContent(paths, kind, receipt, passStatus) {
    if (kind === "decision-approve")
        return { status: passStatus, receipt };
    const recordedPath = receipt.target_resolves_in_source.path;
    const recordedDigest = receipt.target_resolves_in_source.digest;
    const currentDigest = computeTargetDigest(paths.root, recordedPath);
    if (currentDigest === null)
        return { status: "target_missing", receipt }; // (c)
    if (currentDigest !== recordedDigest)
        return { status: "target_mismatch", receipt };
    const staleReasons = snapshotStaleReasons(receipt.snapshot_coord, currentSnapshotCoord(paths.root));
    if (staleReasons.length > 0)
        return { status: "stale", receipt, staleReasons }; // (a)
    return { status: passStatus, receipt };
}
/**
 * Validate the receipt backing the terminal flip `(kind, refId)` (execution doc
 * §3 / §6, extended by slice-1b). Reads BOTH stores — the in-process
 * `terminal-receipts.jsonl` AND the external `external-receipts.jsonl` — and gathers
 * every candidate matching `(kind, refId)`.
 *
 * SLICE-1B PRECEDENCE (the grounded/forged asymmetry):
 *   1. If ANY candidate CLAIMS `producer_kind:"external"`:
 *      - Load the external key. For each external candidate, re-derive its canonical
 *        text and {@link verifyCanonical} its `signature`. The FIRST that
 *        authentically verifies is run through the slice-1a content checks; if it
 *        passes ⇒ `valid-grounded` (independently grounded — the in-process surface
 *        cannot forge the MAC). If it verifies but the CONTENT fails ⇒ the slice-1a
 *        fail token (`target_missing` / `target_mismatch` / `stale`) or `legacy`.
 *      - If NO external candidate verifies (key absent, or every signature is
 *        bad/tampered/replayed) ⇒ `forged` ⇒ BLOCK. An unprovable independence claim
 *        is never silently downgraded to `valid`.
 *   2. Else (no external claim): the EXISTING slice-1a classification on the LATEST
 *      in-process candidate — absent / legacy / target_* / stale / `valid` —
 *      UNCHANGED, so every slice-1a test (and the no-key dev path) stays green.
 *
 * ABSENT classification (the load-bearing negative-control **b** / migration §4):
 * when NO candidate is found anywhere —
 *   - `!receiptMigrationDone(paths)` → `legacy` (genuinely pre-upgrade).
 *   - migrated AND `${kind}:${refId}` in {@link grandfatheredBaseline} → `legacy`.
 *   - migrated AND NOT in the baseline → `absent` → BLOCK.
 */
function readReceiptValidated(paths, kind, refId) {
    const matches = (r) => r.kind === kind && r.refId === refId;
    // LATEST in-process candidate in file order (a re-flip mints a newer receipt).
    let inProcess;
    for (const r of readTerminalReceipts(paths)) {
        if (matches(r))
            inProcess = r;
    }
    // ALL external candidates claiming this (kind, refId) — gathered so a verifying one
    // can be preferred over a non-verifying (forged) one regardless of file order.
    const externalCandidates = readExternalReceipts(paths).filter((r) => matches(r) && r.producer_kind === "external");
    // (1) An external CLAIM exists → it must PROVE itself with a verifying signature.
    if (externalCandidates.length > 0) {
        const key = (0, receipt_signing_1.loadExternalKey)();
        if (key !== null) {
            // The LAST verifying external candidate in file order (a re-mint wins), so a
            // newer grounded receipt supersedes an older one.
            let verified;
            for (const cand of externalCandidates) {
                if (typeof cand.signature !== "string")
                    continue; // no trailer ⇒ unverifiable
                const { recordHash: _rh, signature: _sig, ...signedView } = cand;
                if ((0, receipt_signing_1.verifyCanonical)(canonicalText(signedView), cand.signature, key))
                    verified = cand;
            }
            if (verified) {
                if (verified.legacy === true)
                    return { status: "legacy", receipt: verified };
                return classifyReceiptContent(paths, kind, verified, "valid-grounded");
            }
        }
        // No external candidate verified (key absent, or all signatures bad) → forged.
        return { status: "forged", receipt: externalCandidates[externalCandidates.length - 1] };
    }
    // (2) No external claim → the UNCHANGED slice-1a classification on the in-process line.
    if (!inProcess) {
        // Negative-control (b) / migration §4 absent-classification.
        if (!receiptMigrationDone(paths))
            return { status: "legacy" }; // genuinely pre-upgrade
        if (grandfatheredBaseline(paths).has(baselineKey(kind, refId)))
            return { status: "legacy" };
        return { status: "absent" }; // migrated + not grandfathered → BLOCK
    }
    if (inProcess.legacy === true)
        return { status: "legacy", receipt: inProcess };
    return classifyReceiptContent(paths, kind, inProcess, "valid");
}
/** `<stateDir>/.terminal-receipts-migration` — the migration marker file. */
function migrationMarkerPath(paths) {
    return path.join(paths.stateDir, ".terminal-receipts-migration");
}
/** The grandfathered-baseline membership key for an entity. */
function baselineKey(kind, refId) {
    return `${kind}:${refId}`;
}
/** Tolerantly read the migration marker, or `undefined` when absent/malformed. */
function readMigrationMarker(paths) {
    const file = migrationMarkerPath(paths);
    if (!fs.existsSync(file))
        return undefined;
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch {
        return undefined;
    }
    const parsed = (0, jsonl_1.safeParseJson)(raw);
    if (typeof parsed !== "object" || parsed === null)
        return undefined;
    const m = parsed;
    if (typeof m.migratedAt !== "string")
        return undefined;
    if (!Array.isArray(m.baseline) || !m.baseline.every((x) => typeof x === "string"))
        return undefined;
    return { migratedAt: m.migratedAt, baseline: m.baseline };
}
/**
 * True once {@link ensureReceiptMigration} has run for this project (the marker
 * file is present + well-shaped). The gate's absent-classification keys on this to
 * tell "genuinely pre-upgrade" (no marker → grandfather implicitly) from
 * "post-upgrade bypass" (marker present, entity not in baseline → BLOCK).
 */
function receiptMigrationDone(paths) {
    return readMigrationMarker(paths) !== undefined;
}
/**
 * The grandfathered baseline id-set captured at migration time. Members are
 * `${kind}:${refId}`. Empty set when not yet migrated. These entities were already
 * terminal BEFORE the receipt regime began, so an absent receipt for them is
 * grandfathered (`legacy`) rather than a bypass.
 */
function grandfatheredBaseline(paths) {
    const marker = readMigrationMarker(paths);
    return new Set(marker ? marker.baseline : []);
}
/**
 * Minimal, tolerant read of `<stateDir>/simulation-ledger.json` for the migration
 * baseline ONLY — reads the RAW file (no `commands/sim.ts` import, which would be
 * an import cycle: commands import receipts.ts, not vice-versa). Returns the ids
 * of every entry whose `status === "retired"`. A missing/corrupt/non-array file
 * yields `[]` (the migration is best-effort; a damaged ledger simply contributes
 * no grandfathered sim ids).
 */
function readRetiredSimIds(paths) {
    const file = path.join(paths.stateDir, "simulation-ledger.json");
    if (!fs.existsSync(file))
        return [];
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch {
        return [];
    }
    const parsed = (0, jsonl_1.safeParseJson)(raw);
    if (!Array.isArray(parsed))
        return [];
    const ids = [];
    for (const row of parsed) {
        if (typeof row !== "object" || row === null)
            continue;
        const r = row;
        if (typeof r.id === "string" && r.id !== "" && r.status === "retired")
            ids.push(r.id);
    }
    return ids;
}
/**
 * The currently-terminal entities across the three ledgers (execution doc §4),
 * read from the RAW source files (no command imports):
 *   - `drift-resolve` — `paths.driftLog` entries that carry a `## DRIFT-NNN —
 *     resolved` note in the file. refId = the `DRIFT-NNN`.
 *   - `sim-retire`    — `<stateDir>/simulation-ledger.json` entries with
 *     `status === "retired"`. refId = the `SIM-NNN`.
 *   - `decision-approve` — `readDecisionEvents` → `reduceDecisions` decisions with
 *     `status === "approved"`. refId = the `DECISION-NNN`.
 */
function collectTerminalEntities(paths) {
    const out = [];
    // drift-resolve: a resolved drift has a `## DRIFT-NNN — resolved` note line
    // (em-dash U+2014, exactly as runDriftResolve writes it). parseDriftEntries
    // gives us the set of known DRIFT ids; the resolution note is what marks them
    // terminal. We scan the raw file lines for the resolution notes directly.
    let driftText = "";
    try {
        driftText = fs.readFileSync(paths.driftLog, "utf8");
    }
    catch {
        driftText = ""; // no drift log → no resolved drifts
    }
    if (driftText !== "") {
        const knownDriftIds = new Set((0, drift_log_1.parseDriftEntries)(driftText).map((e) => e.id));
        const seen = new Set();
        for (const line of driftText.split(/\r?\n/)) {
            const m = /^##\s+(DRIFT-\d+)\s+—\s+resolved\s*$/.exec(line.trim());
            if (!m)
                continue;
            const id = m[1];
            // Only count a resolution note that corresponds to a real drift entry, and
            // only once per id.
            if (knownDriftIds.has(id) && !seen.has(id)) {
                seen.add(id);
                out.push({ kind: "drift-resolve", refId: id });
            }
        }
    }
    // sim-retire: retired entries in the simulation ledger.
    for (const id of readRetiredSimIds(paths)) {
        out.push({ kind: "sim-retire", refId: id });
    }
    // decision-approve: approved decisions.
    for (const d of (0, decisions_1.reduceDecisions)((0, decisions_1.readDecisionEvents)(paths))) {
        if (d.status === "approved")
            out.push({ kind: "decision-approve", refId: d.id });
    }
    return out;
}
/**
 * Idempotent, marker-guarded migration (execution doc §4). MUST be called holding
 * the state lock (it appends receipts + writes the marker). On the FIRST call it
 * stamps a `legacy:true` receipt for every currently-terminal ledger entity that
 * lacks ANY receipt, then writes the marker recording the full grandfathered
 * baseline id-set. A re-run is a no-op (the marker is present).
 *
 * Double-stamp guard: even within the first run, an entity that ALREADY has a
 * receipt (found by scanning the receipts file) is skipped — so a partial prior
 * run, or a real receipt minted before migration, is never double-stamped.
 */
function ensureReceiptMigration(paths) {
    if (receiptMigrationDone(paths))
        return; // marker present → already migrated
    const terminalEntities = collectTerminalEntities(paths);
    // The set of (kind:refId) that already have ANY receipt — so we never double-stamp.
    const existing = new Set();
    for (const r of readTerminalReceipts(paths))
        existing.add(baselineKey(r.kind, r.refId));
    for (const ent of terminalEntities) {
        const key = baselineKey(ent.kind, ent.refId);
        if (existing.has(key))
            continue; // already has a receipt — do not double-stamp
        appendLegacyReceipt(paths, ent.kind, ent.refId);
        existing.add(key);
    }
    // Write the marker LAST, recording the full baseline (every currently-terminal
    // entity id), so a crash mid-stamp leaves no marker and the next run re-attempts
    // (the double-stamp guard makes the retry safe).
    const baseline = terminalEntities.map((e) => baselineKey(e.kind, e.refId));
    const marker = { migratedAt: new Date().toISOString(), baseline };
    (0, paths_1.assertGovernedWriteSurface)(paths.root, migrationMarkerPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(migrationMarkerPath(paths), JSON.stringify(marker), "utf8");
}
