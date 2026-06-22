"use strict";
/**
 * Human-approval receipt store (Axis-B slice-3a / BSC-7 — authenticated human
 * approvals). `humanGate` was a declarative-only flag with ZERO predicate
 * consumers (pure gate theater): every reader was a help/render string. This
 * module converts it into an enforceable precondition backed by a schema-registered
 * `HumanApprovalReceipt` — a per-stage approval bound to
 * `{stage, snapshot_coord (gitHead, treeDigest), governing_artifact_digest}` where
 * `governing_artifact_digest` is MANDATORY (snapshot_coord alone is whole-tree and
 * free to mint in-process, which would make the stale/replay controls vacuous).
 *
 * This is the FOURTH instance of the shipped receipt shape (BSC-4 terminal receipts
 * slice-1a/1b, BSC-6 scan exceptions slice-2): it REUSES the shared hash-chain
 * helpers (`computeRecordHash`, `canonicalText`, `CANONICAL_FIELD_ORDER`) and the
 * digest/snapshot primitives from `receipts.ts`, and the signing infra from
 * `receipt-signing.ts` — it does NOT import or touch `tester.ts` (F8 invariant: the
 * tester call path stays byte-identical).
 *
 * It is a DISTINCT entity from `TerminalTransitionReceipt`: an approval is keyed by
 * `stage` (no `refId`), so a focused module + a parallel `readApprovalValidated(stage)`
 * validator keep the F8 lesson (small single-purpose receipt files) and avoid
 * conflating two receipt domains. Storage mirrors `receipts.ts` EXACTLY: append-only,
 * SHA-256 hash-chained `<stateDir>/approval-receipts.jsonl`, a tolerant reader, a
 * tail-scan for the next `prevHash`, an atomic-append writer under the CALLER's
 * `withStateLock` span, and a tamper-detecting chain walk.
 *
 * `producer_identity` carries ZERO trust weight in-process (consensus §3 S1): it is
 * an audit breadcrumb only. The in-process record is hash-chained + stage/snapshot
 * -bound and LOOKS authoritative, but the agent can still mint it with `th approve`,
 * so the genuine un-forgeable property arrives only in slice-3b (an external keyed
 * producer at a write-surface TwinHarness cannot reach). The in-process pass status
 * is `valid` NEVER `valid-grounded` so the status itself encodes the trust level.
 * Documented as such so a reviewer never mistakes it for a trust anchor.
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
exports.ApprovalUnmintableError = exports.HUMAN_GATE_STAGES = void 0;
exports.isHumanGateStage = isHumanGateStage;
exports.approvalCanonicalText = approvalCanonicalText;
exports.computeApprovalRecordHash = computeApprovalRecordHash;
exports.approvalReceiptsPath = approvalReceiptsPath;
exports.externalApprovalsPath = externalApprovalsPath;
exports.readApprovalReceipts = readApprovalReceipts;
exports.readExternalApprovals = readExternalApprovals;
exports.readLastExternalApprovalRecordHash = readLastExternalApprovalRecordHash;
exports.readLastApprovalRecordHash = readLastApprovalRecordHash;
exports.verifyApprovalChain = verifyApprovalChain;
exports.appendApprovalReceipt = appendApprovalReceipt;
exports.readApprovalValidated = readApprovalValidated;
exports.approvalMigrationDone = approvalMigrationDone;
exports.grandfatheredBaseline = grandfatheredBaseline;
exports.ensureApprovalMigration = ensureApprovalMigration;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
const hash_1 = require("./hash");
const jsonl_1 = require("./jsonl");
const stages_1 = require("./stages");
const receipts_1 = require("./receipts");
const receipt_signing_1 = require("./receipt-signing");
// ---------------------------------------------------------------------------
// Schema (plan §4 step 3a-1)
// ---------------------------------------------------------------------------
/**
 * The canonical ids of the 8 `humanGate:true` stages, derived from STAGE_PIPELINE so
 * a flag flip in `stages.ts` is the single source of truth (the set can never drift
 * from the contract table). An approval's `stage` MUST be one of these.
 */
exports.HUMAN_GATE_STAGES = new Set(stages_1.STAGE_PIPELINE.filter((s) => s.humanGate).map((s) => s.stage));
/** True iff `stage` is one of the 8 `humanGate` stages (validated against STAGE_PIPELINE). */
function isHumanGateStage(stage) {
    return exports.HUMAN_GATE_STAGES.has(stage);
}
// ---------------------------------------------------------------------------
// Canonical text + hashing — `stage` IS in the signed order (R5)
// ---------------------------------------------------------------------------
/**
 * The fixed canonical field order for hashing/signing (plan §4 3a-1, R5). Mirrors
 * `receipts.ts:155-170`, but `stage` JOINS the order (right after `kind`) so an
 * Ed25519 signature over the payload is BOUND to the stage — otherwise a valid
 * signature over a stage-less payload would be liftable to another stage, defeating
 * cross-stage replay protection (control c). `signature` and `recordHash` are
 * EXCLUDED trailers (the canonical text is signature-free + deterministic), computed
 * over the IDENTICAL bytes — exactly like `receipts.ts:162-166`.
 */
const APPROVAL_CANONICAL_FIELD_ORDER = [
    "kind",
    "stage",
    "approval_of",
    "producer_identity",
    "producer_kind",
    "key_id",
    "legacy",
    "prevHash",
];
/** Canonical key order for {@link ApprovalGround} (byte-stable nested JSON). */
const GROUND_FIELD_ORDER = [
    "snapshot_coord",
    "governing_artifact_digest",
];
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
 * Deterministic canonical text of an approval for hashing/signing. Field order is
 * fixed (with `stage` IN the order, R5); `undefined` keys and `recordHash` are
 * dropped; the nested ground + snapshot objects are re-emitted in their fixed key
 * order; `JSON.stringify` with no indentation. `signature` is excluded (a trailer).
 */
function approvalCanonicalText(receipt) {
    const ordered = {};
    for (const key of APPROVAL_CANONICAL_FIELD_ORDER) {
        const val = receipt[key];
        if (val === undefined)
            continue;
        if (key === "approval_of") {
            const g = val;
            // Re-emit the ground AND its nested snapshot in fixed key order (byte-stable).
            const normalized = {
                snapshot_coord: reorder(g.snapshot_coord, SNAPSHOT_FIELD_ORDER),
                governing_artifact_digest: g.governing_artifact_digest,
            };
            ordered[key] = reorder(normalized, GROUND_FIELD_ORDER);
        }
        else {
            ordered[key] = val;
        }
    }
    return JSON.stringify(ordered);
}
/**
 * `recordHash` for an approval = SHA-256 of its canonical text (recordHash omitted).
 * Hashes the approval's OWN canonical text through the SAME shared `hashContent`
 * primitive `receipts.computeRecordHash` wraps — so the two chains are byte-consistent
 * on the digest mechanics while each binds its own (terminal vs approval) field order.
 */
function computeApprovalRecordHash(receipt) {
    return (0, hash_1.hashContent)(approvalCanonicalText(receipt));
}
// ---------------------------------------------------------------------------
// Storage (mirrors receipts.ts)
// ---------------------------------------------------------------------------
/** `<stateDir>/approval-receipts.jsonl` — the in-process human-approval ledger. */
function approvalReceiptsPath(paths) {
    return path.join(paths.stateDir, "approval-receipts.jsonl");
}
/**
 * `<stateDir>/external-approvals.jsonl` — the EXTERNAL keyed producer's store
 * (slice-3b). A SEPARATE file for LOCK-ISOLATION (parallel to `external-receipts.jsonl`
 * / `scan-exceptions.jsonl`): the out-of-process producer appends here without taking
 * the in-process `withStateLock` span. The SECURITY boundary is NOT this path — it is
 * the private key held only by the producer; a forged line written here is rejected by
 * {@link readApprovalValidated} (no verifying signature ⇒ `forged`).
 */
function externalApprovalsPath(paths) {
    return path.join(paths.stateDir, "external-approvals.jsonl");
}
const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
/** Validate the shape of a parsed approval line; malformed lines are skipped (tolerant). */
function isValidApproval(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const r = parsed;
    if (r.kind !== "human-approval")
        return false;
    if (typeof r.stage !== "string" || r.stage === "")
        return false;
    if (typeof r.producer_identity !== "string")
        return false;
    if (typeof r.prevHash !== "string" || !hash_1.HEX64.test(r.prevHash))
        return false;
    if (typeof r.recordHash !== "string" || !hash_1.HEX64.test(r.recordHash))
        return false;
    if (r.legacy !== undefined && typeof r.legacy !== "boolean")
        return false;
    // Slice-3b OPTIONAL signing fields: accepted when present, NEVER required.
    if (r.producer_kind !== undefined && r.producer_kind !== "external" && r.producer_kind !== "in-process")
        return false;
    if (r.key_id !== undefined && typeof r.key_id !== "string")
        return false;
    if (r.signature !== undefined &&
        (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))) {
        return false;
    }
    // Nested ground must be present + shaped; `governing_artifact_digest` is MANDATORY.
    const ground = r.approval_of;
    if (typeof ground !== "object" || ground === null)
        return false;
    const g = ground;
    if (typeof g.governing_artifact_digest !== "string")
        return false;
    const snap = g.snapshot_coord;
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
 * Read + parse every approval in the in-process store, in file order. Missing file →
 * `[]`. Bad lines (non-JSON, partial-tail, schema-invalid) are silently skipped —
 * tolerant, never throws. Chain breaks surface via {@link verifyApprovalChain}.
 */
function readApprovalReceipts(paths) {
    return (0, jsonl_1.readJsonlValues)(approvalReceiptsPath(paths), isValidApproval);
}
/**
 * Read + parse every approval in the EXTERNAL store (slice-3b), same tolerant shape
 * as {@link readApprovalReceipts}. The signature on a line is verified at gate time by
 * {@link readApprovalValidated}, NOT here — this reader is shape-only.
 */
function readExternalApprovals(paths) {
    return (0, jsonl_1.readJsonlValues)(externalApprovalsPath(paths), isValidApproval);
}
/**
 * The `recordHash` of the EXTERNAL store's last valid approval — the `prevHash` seed
 * for the external producer's own append-only chain. Missing/empty/no-valid-tail →
 * `GENESIS_PREV_HASH`. Used by the slice-3b standalone producer.
 */
function readLastExternalApprovalRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(externalApprovalsPath(paths), isValidApproval);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * The `recordHash` of the in-process ledger's last VALID approval — the seed
 * {@link appendApprovalReceipt} needs to seal the next link. Tail-scans the file so N
 * appends stay O(N) total. Missing/empty/no-valid-tail → `GENESIS_PREV_HASH`.
 */
function readLastApprovalRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(approvalReceiptsPath(paths), isValidApproval);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * Walk approvals in file order with a running `expectedPrev = GENESIS`. For each:
 * recompute `recordHash` from its canonical text — a mismatch means the record was
 * edited; if `prevHash !== expectedPrev` the line was inserted, deleted, or reordered;
 * a truncated chain head (the first line's `prevHash !== GENESIS`) breaks here too.
 * Return `{ ok:false, brokenAt:N }` at the FIRST break; else advance. Byte-identical
 * posture to `receipts.verifyReceiptChain` (so a tampered store → `tampered`, never a
 * silent `absent`).
 */
function verifyApprovalChain(receipts) {
    let expectedPrev = hash_1.GENESIS_PREV_HASH;
    for (let i = 0; i < receipts.length; i++) {
        const r = receipts[i];
        const { recordHash, ...rest } = r;
        const recomputed = computeApprovalRecordHash(rest);
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
/**
 * Thrown by {@link appendApprovalReceipt} when the stage is not a `humanGate` stage,
 * or its governing artifact (`produces`) does not resolve in source (refuse-at-creation:
 * a producer refuses to mint an approval whose ground is already missing).
 */
class ApprovalUnmintableError extends Error {
    stage;
    artifact;
    /** Stable machine token for the CLI failure envelope. */
    code;
    constructor(message, code, 
    /** The offending stage. */
    stage, 
    /** The governing-artifact path (when the failure is an unresolved artifact). */
    artifact) {
        super(message);
        this.stage = stage;
        this.artifact = artifact;
        this.name = "ApprovalUnmintableError";
        this.code = code;
    }
}
exports.ApprovalUnmintableError = ApprovalUnmintableError;
/**
 * Append one in-process human-approval receipt, sealing the hash chain. The caller MUST
 * already hold the `withStateLock` span (read-modify-append is serialized there).
 *
 * Refuse-at-creation (plan §4 3a-2): the stage MUST be a `humanGate` stage AND its
 * governing artifact (`produces`) MUST resolve in source — else throws
 * {@link ApprovalUnmintableError} BEFORE any write, so an approval whose ground is
 * already missing cannot be minted. The approval records the digest of that artifact +
 * the current snapshot coordinate, derives `prevHash` from the tail, computes
 * `recordHash`, asserts the write-surface, and atomically appends. `producer_kind` is
 * `"in-process"` (zero trust weight). Returns the sealed approval.
 */
function appendApprovalReceipt(paths, input) {
    const contract = (0, stages_1.stageContract)(input.stage);
    if (!contract || !contract.humanGate) {
        throw new ApprovalUnmintableError(`Refusing to mint an approval for "${input.stage}": not a humanGate stage.`, "approval_stage_not_human_gate", input.stage);
    }
    const artifact = contract.produces;
    const digest = (0, receipts_1.computeTargetDigest)(paths.root, artifact);
    if (digest === null) {
        throw new ApprovalUnmintableError(`Refusing to mint an approval for "${input.stage}": governing artifact "${artifact}" does not resolve in source.`, "approval_artifact_unresolved", input.stage, artifact);
    }
    return sealAndAppend(paths, {
        kind: "human-approval",
        stage: input.stage,
        approval_of: {
            snapshot_coord: (0, receipts_1.currentReceiptSnapshotCoord)(paths),
            governing_artifact_digest: digest,
        },
        producer_identity: input.producerIdentity,
        producer_kind: "in-process",
    });
}
/**
 * Append a one-time `legacy:true` backfill stamp (migration §4). A legacy approval
 * carries an EMPTY governing digest (it grounds nothing — it is grandfathered), the
 * snapshot coordinate of the moment, and `producer_identity: "legacy-backfill"`.
 * Internal: only {@link ensureApprovalMigration} mints these.
 */
function appendLegacyApproval(paths, stage) {
    return sealAndAppend(paths, {
        kind: "human-approval",
        stage,
        approval_of: {
            snapshot_coord: (0, receipts_1.currentReceiptSnapshotCoord)(paths),
            governing_artifact_digest: "",
        },
        producer_identity: "legacy-backfill",
        legacy: true,
    });
}
/**
 * The shared seal+append chokepoint: derive `prevHash` from the tail, compute
 * `recordHash`, assert the governed write-surface, mkdir, atomically append. The single
 * place an approval line is written, so the real and legacy producers stay byte-consistent
 * on the chain mechanics.
 */
function sealAndAppend(paths, receipt) {
    (0, paths_1.assertGovernedWriteSurface)(paths.root, approvalReceiptsPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const prevHash = readLastApprovalRecordHash(paths);
    const withPrev = { ...receipt, prevHash };
    const recordHash = computeApprovalRecordHash(withPrev);
    const sealed = { ...withPrev, recordHash };
    fs.appendFileSync(approvalReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
    return sealed;
}
/**
 * Compare a recorded coordinate against the current one under the F8 rule: a coordinate
 * discriminates ONLY when BOTH the recorded and the current value are non-null. A null on
 * either side is non-discriminating and never contributes staleness.
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
 * Apply the content checks to a present, non-legacy approval (plan §4 3a-1 / R3). Uses
 * the DIFF-BEARING `target_resolves_in_source` path — re-read the stage's governing
 * artifact and compare its digest — NOT the `decision-approve` build-coordinate shortcut.
 * On PASS, the caller-supplied `passStatus` is returned (`valid` in-process, `valid-grounded`
 * external). On FAIL, the specific fail token.
 */
function classifyApprovalContent(paths, receipt, passStatus) {
    const contract = (0, stages_1.stageContract)(receipt.stage);
    // A well-formed approval names a real humanGate stage; if the contract is gone the
    // governing artifact cannot be re-derived → treat as target_missing (fail-closed).
    if (!contract || !contract.humanGate)
        return { status: "target_missing", receipt };
    const recordedDigest = receipt.approval_of.governing_artifact_digest;
    const currentDigest = (0, receipts_1.computeTargetDigest)(paths.root, contract.produces);
    if (currentDigest === null)
        return { status: "target_missing", receipt };
    if (currentDigest !== recordedDigest)
        return { status: "target_mismatch", receipt };
    const staleReasons = snapshotStaleReasons(receipt.approval_of.snapshot_coord, (0, receipts_1.currentReceiptSnapshotCoord)(paths));
    if (staleReasons.length > 0)
        return { status: "stale", receipt, staleReasons };
    return { status: passStatus, receipt };
}
/**
 * Validate the approval backing the `humanGate` stage `stage` (plan §4 3a-4 / 3a-5).
 * Reads BOTH stores — the in-process `approval-receipts.jsonl` AND the external
 * `external-approvals.jsonl` — and gathers every candidate for `stage`.
 *
 * SLICE-3B PRECEDENCE (the grounded/forged asymmetry, mirrors `receipts.ts:649-721`):
 *   1. If ANY candidate CLAIMS `producer_kind:"external"`, it must PROVE itself.
 *      - MED-1 (external chain): the external store's append-only hash chain MUST verify
 *        first; a tampered/reordered/truncated `external-approvals.jsonl` → `tampered` →
 *        BLOCK (never honored).
 *      - Then load `loadExternalPublicKey()` and `verifyCanonical` each candidate's
 *        signature over `approvalCanonicalText(candidate)`; a verifying one → content
 *        checks → `valid-grounded`; no external candidate verifies (key absent / wrong
 *        key / tampered / replayed) → `forged` → BLOCK (NEVER silently downgraded to the
 *        in-process `valid`, and NEVER deferred to the in-process `tampered` path).
 *   2. Else (NO external claim for `stage`): the UNCHANGED slice-3a classification on the
 *      LATEST in-process candidate — absent / legacy / target_* / stale / `valid`.
 *
 * MED-2 (ordering): external precedence is evaluated FIRST. The in-process
 * `verifyApprovalChain`/`tampered` check fires ONLY in branch (2) (no external claim for
 * `stage`), so a verifying external-signed approval for stage S is NOT masked by an
 * UNRELATED in-process tamper (the external store outranks the forgeable in-process
 * ledger). The common in-process-only path (no external claim) is byte-identical to
 * slice-3a — every existing approval/fixture/neg-control test stays green.
 *
 * MARKER-INTEGRITY FAIL-CLOSED (plan §4 3a-5, R2): unlike `receipts.ts:710-715`, an
 * ABSENT migration marker does NOT blanket-`legacy`-PASS. The absent-classification keys
 * on the grandfathered baseline ONLY: a stage in the baseline → `legacy`; otherwise →
 * `absent` → BLOCK. So deleting the marker (so the baseline reads empty) downgrades NO
 * stage to a free pass — every engaged unreceipted stage classifies `absent`.
 *
 * CHAIN-TAMPER (R2-iii): a non-verifying in-process chain (incl. head truncation) →
 * `tampered`, never a silent `absent` (branch (2) only — see MED-2).
 */
function readApprovalValidated(paths, stage) {
    const canonicalStage = stage;
    const matches = (r) => r.stage === canonicalStage;
    // SLICE-3B MED-2 — ORDERING. External precedence is evaluated FIRST, BEFORE the
    // in-process chain/`tampered` classification. The external store outranks the
    // forgeable in-process ledger, so a genuine external-signed approval for stage S must
    // NOT be masked by an UNRELATED in-process tamper. We therefore read the external
    // store for this stage up front and only fall through to the in-process path (incl. its
    // `verifyApprovalChain` head/tamper check) when there is NO external claim for `stage` —
    // which keeps the common in-process-only path byte-identical to slice-3a behavior.
    const externalAll = readExternalApprovals(paths);
    const externalCandidates = externalAll.filter((r) => matches(r) && r.producer_kind === "external");
    // (1) An external CLAIM exists → it must PROVE itself with a verifying Ed25519
    // signature AND a verifying external chain (MED-1). This branch is DECISIVE: a
    // verifying external approval grounds; a non-verifying one is `forged` and BLOCKS —
    // never silently downgraded to the in-process `valid` path, and never deferred to the
    // in-process `tampered` classification.
    if (externalCandidates.length > 0) {
        // MED-1 — external chain verification. A tampered/reordered/truncated
        // external-approvals.jsonl must NOT be honored: if the external store's own
        // append-only hash chain does not verify, no external candidate can be trusted →
        // `tampered` → BLOCK (mirrors the in-process chain posture, applied to the external
        // store before any signature is accepted).
        if (!verifyApprovalChain(externalAll).ok) {
            return { status: "tampered", receipt: externalCandidates[externalCandidates.length - 1] };
        }
        const verified = verifyExternalApproval(externalCandidates);
        if (verified) {
            if (verified.legacy === true)
                return { status: "legacy", receipt: verified };
            return classifyApprovalContent(paths, verified, "valid-grounded");
        }
        // No external candidate verified (key absent, wrong key, or all signatures
        // bad/tampered/replayed) → forged.
        return { status: "forged", receipt: externalCandidates[externalCandidates.length - 1] };
    }
    // (2) No external claim → the UNCHANGED slice-3a classification on the in-process line.
    // The in-process chain/`tampered` check lives HERE (after the no-external-claim gate),
    // so an unrelated in-process tamper can only affect a stage with no external claim.
    const inProcessReceipts = readApprovalReceipts(paths);
    if (!verifyApprovalChain(inProcessReceipts).ok)
        return { status: "tampered" };
    // LATEST in-process candidate in file order (a re-approval mints a newer record).
    let inProcess;
    for (const r of inProcessReceipts) {
        if (matches(r))
            inProcess = r;
    }
    if (!inProcess) {
        // Absent-classification, fail-closed marker integrity (R2): grandfathered baseline ONLY.
        if (grandfatheredBaseline(paths).has(stage))
            return { status: "legacy" };
        return { status: "absent" };
    }
    if (inProcess.legacy === true)
        return { status: "legacy", receipt: inProcess };
    return classifyApprovalContent(paths, inProcess, "valid");
}
/**
 * Slice-3b external verification: return the LAST external candidate (file order, so a
 * re-mint wins) whose Ed25519 signature authentically verifies under the loaded public
 * key, or `undefined` when none verify.
 *
 * Mirrors `receipts.ts:690-707` exactly: load the verifier's public key
 * ({@link loadExternalPublicKey}, env `TH_RECEIPT_PUBLIC_KEYFILE`). With NO key the
 * external claim is unprovable ⇒ `undefined` ⇒ the caller classifies `forged`
 * (fail-closed; this is the default CI path for tests that set no key). For each
 * candidate: require its `key_id` to match {@link externalKeyId} of the loaded key, then
 * recompute the signed canonical text via {@link approvalCanonicalText} over the
 * candidate with the `recordHash`/`signature` trailers stripped, and
 * {@link verifyCanonical} the `signature`. Because the C-H producer signs the IDENTICAL
 * `approvalCanonicalText` bytes, a genuine external approval verifies; any tamper to a
 * signed field, a wrong-key signature, or a replayed signature over a different stage
 * fails the check.
 */
function verifyExternalApproval(candidates) {
    const publicKey = (0, receipt_signing_1.loadExternalPublicKey)();
    if (publicKey === null)
        return undefined;
    const configuredKeyId = (0, receipt_signing_1.externalKeyId)(publicKey);
    let verified;
    for (const cand of candidates) {
        if (typeof cand.signature !== "string")
            continue; // no trailer ⇒ unverifiable
        if (cand.key_id !== configuredKeyId)
            continue;
        const { recordHash: _rh, signature: _sig, ...signedView } = cand;
        if ((0, receipt_signing_1.verifyCanonical)(approvalCanonicalText(signedView), cand.signature, publicKey)) {
            verified = cand;
        }
    }
    return verified;
}
// ---------------------------------------------------------------------------
// Migration / grandfather (plan §4 3a-5) — fail-closed marker integrity (R2)
// ---------------------------------------------------------------------------
/** `<stateDir>/.approval-receipts-migration` — the migration marker file. */
function migrationMarkerPath(paths) {
    return path.join(paths.stateDir, ".approval-receipts-migration");
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
 * True once {@link ensureApprovalMigration} has run for this project. Unlike receipts.ts,
 * the absent-classification does NOT key on this to grant a blanket pass (R2 fail-closed):
 * a missing marker grants NOTHING — only stages in the grandfathered baseline pass as
 * `legacy`, and an absent marker yields an EMPTY baseline (every unreceipted stage blocks).
 */
function approvalMigrationDone(paths) {
    return readMigrationMarker(paths) !== undefined;
}
/**
 * The grandfathered baseline stage-set captured at migration time — CROSS-CHECKED
 * against the on-disk ledger (carry-forward review hardening). Members are stage ids.
 * Empty set when not yet migrated — which (with the fail-closed absent-classification)
 * means an absent marker downgrades NO stage to a free pass.
 *
 * The marker's `baseline[]` array is NOT trusted verbatim: a hand-edited marker that
 * names a stage with no on-disk chain-sealed `legacy:true` stamp would otherwise
 * manufacture a bogus `legacy`-PASS (the `ensureApprovalMigration` writer always seals a
 * real `legacy:true` stamp for every baseline member, so a legitimate baseline member
 * ALWAYS has one). So each baseline member is intersected with the set of stages that
 * carry an actual chain-sealed `legacy:true` approval in the in-process ledger; a
 * baseline entry with no matching stamp is dropped (fail-closed). A tampered chain (the
 * walk does not verify) contributes NOTHING, so a forged stamp cannot smuggle a stage in.
 */
function grandfatheredBaseline(paths) {
    const marker = readMigrationMarker(paths);
    if (!marker)
        return new Set();
    // Stages with a REAL chain-sealed `legacy:true` stamp on disk. A non-verifying chain
    // contributes nothing — a forged/edited stamp cannot manufacture a legacy stage.
    const receipts = readApprovalReceipts(paths);
    if (!verifyApprovalChain(receipts).ok)
        return new Set();
    const stampedLegacy = new Set();
    for (const r of receipts) {
        if (r.legacy === true)
            stampedLegacy.add(r.stage);
    }
    return new Set(marker.baseline.filter((s) => stampedLegacy.has(s)));
}
/**
 * Idempotent, marker-guarded migration (plan §4 3a-5). MUST be called holding the state
 * lock. On the FIRST call it stamps a `legacy:true` approval for every `humanGate` stage
 * the run has ALREADY advanced past (engaged AND ordinal-≤-current) that lacks any approval,
 * then writes the marker recording the grandfathered baseline. A re-run is a no-op.
 *
 * The set of "already-advanced humanGate stages" is supplied by the caller (the gate owns the
 * required-set computation via `engagedStagesFor` + `stageOrdinal`); this keeps `approvals.ts`
 * free of the gate-precondition traversal (no import cycle: gate-preconditions imports approvals,
 * not vice-versa). The caller passes the already-advanced humanGate stage ids.
 *
 * Double-stamp guard: a stage that ALREADY has an approval is skipped — so a partial prior run,
 * or a real approval minted before migration, is never double-stamped.
 */
function ensureApprovalMigration(paths, alreadyAdvancedHumanGateStages) {
    if (approvalMigrationDone(paths))
        return; // marker present → already migrated
    const baselineStages = alreadyAdvancedHumanGateStages.filter((s) => isHumanGateStage(s));
    // Stages that already have ANY in-process approval — never double-stamp.
    const existing = new Set();
    for (const r of readApprovalReceipts(paths))
        existing.add(r.stage);
    for (const stage of baselineStages) {
        if (existing.has(stage))
            continue;
        appendLegacyApproval(paths, stage);
        existing.add(stage);
    }
    // Write the marker LAST, recording the baseline, so a crash mid-stamp leaves no marker
    // and the next run re-attempts (the double-stamp guard makes the retry safe).
    const marker = { migratedAt: new Date().toISOString(), baseline: [...baselineStages] };
    (0, paths_1.assertGovernedWriteSurface)(paths.root, migrationMarkerPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(migrationMarkerPath(paths), JSON.stringify(marker), "utf8");
}
