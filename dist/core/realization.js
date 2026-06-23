"use strict";
/**
 * RealizationReceipt store + the REQ→slice ownership join (Axis-B slice-5 / BSC-1 —
 * the slice-completion grounding row).
 *
 * THE BLIND SPOT (BSC-1): a slice can be marked `done` while a REQ-ID it owns has NO
 * bound, reachable, digest-fresh source anchor — "done" is asserted with no
 * correspondence to realized code. The completion gate clears anyway.
 *
 * THE GROUND (consensus plan §0.2 — an INDEPENDENT, time-separated claim surface):
 *   - The independent CLAIM already exists in state: `SliceState.status === "done"`
 *     (`state-schema.ts`), authored at the slice→done transition — a DIFFERENT act, at
 *     a DIFFERENT time, than the realize/referent binding.
 *   - The REFERENT is a digest-bound anchor in a non-plan SOURCE file, recorded by the
 *     `th realize <REQ-ID> --artifact <path>` verb (caller supplies the path, BSC-4 /
 *     `th driver record` style). `th realize` does NOT set slice status — claim and
 *     referent stay SEPARATELY authored (this separability is the whole point; co-
 *     authoring them is self-grounding = the rejected v2 ground).
 *   - The gate ranges over every REQ-ID owned by a `done` slice and fails when the claim
 *     exists but a fresh, bound referent does not.
 *
 * THE OWNERSHIP JOIN (Lane 0b — REUSE the join that already exists, do NOT invent
 * primitives): REQ-ID → files carrying it via `FileEntry.req_ids` → those files'
 * `FileEntry.component` → name-match against `SliceState.components`. The impact engine
 * already performs both halves of this join (`repo-map/query.ts`); this module reuses
 * the SAME `FileEntry` fields. A normalization rule reconciles the token-vs-POSIX-id
 * mismatch (slice "commands" vs repo-map "src/commands"), and the resolver FAILS CLOSED:
 * a done-slice REQ that maps to no owning component is REPORTED (and blocks), never
 * silently dropped ("unobserved ≠ clean").
 *
 * Storage mirrors `src/core/verification-driver.ts` EXACTLY: a DEDICATED, lock-isolated
 * append-only SHA-256 hash-chained `<stateDir>/realization-receipts.jsonl`, a tolerant
 * reader, a tail-scan for the next `prevHash`, an atomic-append writer that runs under
 * the CALLER's `withStateLock` span, and a tamper-detecting chain walk. A dedicated
 * store gives the gate one validated reader and slice-1b-style external (un-writable)
 * production a distinct location (`external-realization-receipts.jsonl`).
 *
 * GATE_OWNED (Lane 0e): the referent binding lives in THIS append store, NOT a free
 * state field — so it never reopens the `STATE_FIELD_POLICY` / MCP `th_state_set`
 * refusal surface (program history: BSC-7 marker-injection bypass). No state field is
 * added by this slice.
 *
 * REUSE (avoid F8 regression): the shared digest path (`computeTargetDigest`), snapshot
 * coordinate (`currentReceiptSnapshotCoord`, `SnapshotCoord`), and signing infra
 * (`receipt-signing.ts`) come from `receipts.ts` — NO new digest formula. It does NOT
 * import or touch `tester.ts` (the F8 call path stays byte-identical, F8 tests green).
 *
 * `producer_identity` carries ZERO trust weight in-process (consensus §2 driver 2): an
 * audit breadcrumb only. The in-process pass status is `valid` NEVER `valid-grounded`,
 * so the status itself encodes the trust level. The genuine un-forgeable property
 * arrives via the slice-1b-style external Ed25519 producer — and even THAT is honestly
 * scoped as SIGNATURE-PROVENANCE independence only: the referent anchor is still agent-
 * authored, so the external producer proves the receipt was not forged in-process, NOT
 * that the referent is independent.
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
exports.ReferentUnresolvedError = void 0;
exports.realizationCanonicalText = realizationCanonicalText;
exports.computeRealizationRecordHash = computeRealizationRecordHash;
exports.realizationReceiptsPath = realizationReceiptsPath;
exports.externalRealizationReceiptsPath = externalRealizationReceiptsPath;
exports.isValidRealizationReceipt = isValidRealizationReceipt;
exports.readRealizationReceipts = readRealizationReceipts;
exports.readExternalRealizationReceipts = readExternalRealizationReceipts;
exports.readLastExternalRealizationRecordHash = readLastExternalRealizationRecordHash;
exports.readLastRealizationRecordHash = readLastRealizationRecordHash;
exports.verifyRealizationChain = verifyRealizationChain;
exports.normalizeComponentToken = normalizeComponentToken;
exports.doneSlices = doneSlices;
exports.ownedReqsForDoneSlices = ownedReqsForDoneSlices;
exports.unresolvedDoneSliceReqs = unresolvedDoneSliceReqs;
exports.loadRepoMapForRealization = loadRepoMapForRealization;
exports.appendRealizationReceipt = appendRealizationReceipt;
exports.readRealizationReceiptValidated = readRealizationReceiptValidated;
exports.realizationMigrationDone = realizationMigrationDone;
exports.grandfatheredRealizationBaseline = grandfatheredRealizationBaseline;
exports.ensureRealizationMigration = ensureRealizationMigration;
exports.ensureRealizationMigrationOpportunistic = ensureRealizationMigrationOpportunistic;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
const hash_1 = require("./hash");
const jsonl_1 = require("./jsonl");
const receipts_1 = require("./receipts");
const receipt_signing_1 = require("./receipt-signing");
const schema_1 = require("./repo-map/schema");
const state_store_1 = require("./state-store");
// ---------------------------------------------------------------------------
// Canonical text + hashing (mirrors receipts.ts / verification-driver.ts)
// ---------------------------------------------------------------------------
/**
 * The fixed canonical field order for hashing/signing. `signature` and `recordHash` are
 * EXCLUDED trailers (computed over the IDENTICAL bytes); `undefined` keys are dropped, so
 * an in-process receipt (the three signing fields absent) is byte-stable. The two nested
 * objects (`referent`, `snapshot_coord`) are re-emitted in a fixed key order.
 */
const CANONICAL_FIELD_ORDER = [
    "kind",
    "req_id",
    "owning_slice",
    "referent",
    "snapshot_coord",
    "producer_identity",
    "producer_kind",
    "key_id",
    "legacy",
    "prevHash",
];
/** Canonical key order for {@link RealizationReferent} (byte-stable nested JSON). */
const REFERENT_FIELD_ORDER = ["path", "digest"];
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
 * Deterministic canonical text of a realization receipt for hashing/signing. Field order
 * is fixed; `undefined` keys and `recordHash` are dropped; the two nested objects are
 * re-emitted in their fixed key order; `JSON.stringify` with no indentation. `signature`
 * is excluded (a trailer). `hashContent` then CRLF→LF normalizes (harmless — no CRLF).
 */
function realizationCanonicalText(receipt) {
    const ordered = {};
    for (const key of CANONICAL_FIELD_ORDER) {
        const val = receipt[key];
        if (val === undefined)
            continue;
        if (key === "referent") {
            ordered[key] = reorder(val, REFERENT_FIELD_ORDER);
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
/** `recordHash` for a realization receipt = SHA-256 of its canonical text (recordHash omitted). */
function computeRealizationRecordHash(receipt) {
    return (0, hash_1.hashContent)(realizationCanonicalText(receipt));
}
// ---------------------------------------------------------------------------
// Storage (mirrors verification-driver.ts)
// ---------------------------------------------------------------------------
/** `<stateDir>/realization-receipts.jsonl` — the in-process realization-receipt ledger. */
function realizationReceiptsPath(paths) {
    return path.join(paths.stateDir, "realization-receipts.jsonl");
}
/**
 * `<stateDir>/external-realization-receipts.jsonl` — the EXTERNAL keyed producer's store
 * (slice-1b). A SEPARATE file for LOCK-ISOLATION (parallel to the driver/approval external
 * stores): the out-of-process producer appends here without taking the in-process
 * `withStateLock` span. The SECURITY boundary is NOT this path — it is the private key held
 * only by the producer; a forged line written here is rejected by
 * {@link readRealizationReceiptValidated} (no verifying signature ⇒ `forged`).
 */
function externalRealizationReceiptsPath(paths) {
    return path.join(paths.stateDir, "external-realization-receipts.jsonl");
}
const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
/** Validate the shape of a parsed realization-receipt line; malformed lines are skipped (tolerant). */
function isValidRealizationReceipt(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const r = parsed;
    if (r.kind !== "realization")
        return false;
    if (typeof r.req_id !== "string" || r.req_id === "")
        return false;
    if (typeof r.owning_slice !== "string")
        return false;
    if (typeof r.producer_identity !== "string")
        return false;
    if (typeof r.prevHash !== "string" || !hash_1.HEX64.test(r.prevHash))
        return false;
    if (typeof r.recordHash !== "string" || !hash_1.HEX64.test(r.recordHash))
        return false;
    if (r.legacy !== undefined && typeof r.legacy !== "boolean")
        return false;
    // Slice-1b OPTIONAL signing fields: accepted when present, NEVER required.
    if (r.producer_kind !== undefined && r.producer_kind !== "external" && r.producer_kind !== "in-process")
        return false;
    if (r.key_id !== undefined && typeof r.key_id !== "string")
        return false;
    if (r.signature !== undefined &&
        (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))) {
        return false;
    }
    // Nested referent must be present + shaped.
    const ref = r.referent;
    if (typeof ref !== "object" || ref === null)
        return false;
    const f = ref;
    if (typeof f.path !== "string" || typeof f.digest !== "string")
        return false;
    // Snapshot coordinate must be present + shaped.
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
 * Read + parse every realization receipt in the in-process store, in file order. Missing
 * file → `[]`. Bad lines (non-JSON, partial-tail, schema-invalid) are silently skipped —
 * tolerant, never throws. Chain breaks surface via {@link verifyRealizationChain}.
 */
function readRealizationReceipts(paths) {
    return (0, jsonl_1.readJsonlValues)(realizationReceiptsPath(paths), isValidRealizationReceipt);
}
/**
 * Read + parse every realization receipt in the EXTERNAL store (slice-1b), same tolerant
 * shape as {@link readRealizationReceipts}. The signature on a line is verified at gate time
 * by {@link readRealizationReceiptValidated}, NOT here — this reader is shape-only, so a
 * forged-but-well-shaped line is returned and then classified `forged` downstream.
 */
function readExternalRealizationReceipts(paths) {
    return (0, jsonl_1.readJsonlValues)(externalRealizationReceiptsPath(paths), isValidRealizationReceipt);
}
/**
 * The `recordHash` of the EXTERNAL store's last valid realization receipt — the `prevHash`
 * seed for the external producer's own append-only chain. Missing/empty/no-valid-tail →
 * `GENESIS_PREV_HASH`. Used by the slice-1b standalone producer.
 */
function readLastExternalRealizationRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(externalRealizationReceiptsPath(paths), isValidRealizationReceipt);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * The `recordHash` of the in-process ledger's last VALID realization receipt — the seed
 * {@link appendRealizationReceipt} needs to seal the next link. Tail-scans the file so N
 * appends stay O(N) total. Missing/empty/no-valid-tail → `GENESIS_PREV_HASH`.
 */
function readLastRealizationRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(realizationReceiptsPath(paths), isValidRealizationReceipt);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * Walk realization receipts in file order with a running `expectedPrev = GENESIS`. For
 * each: recompute `recordHash` from its canonical text — a mismatch means the record was
 * edited; if `prevHash !== expectedPrev` the line was inserted/deleted/reordered. Return
 * `{ ok:false, brokenAt:N }` at the FIRST break; else advance. Byte-identical posture to
 * `receipts.verifyReceiptChain`.
 */
function verifyRealizationChain(receipts) {
    let expectedPrev = hash_1.GENESIS_PREV_HASH;
    for (let i = 0; i < receipts.length; i++) {
        const r = receipts[i];
        const { recordHash, ...rest } = r;
        const recomputed = computeRealizationRecordHash(rest);
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
// REQ→slice ownership join (Lane 0b) + done-slice REQ enumerator (Lane 0c)
// ---------------------------------------------------------------------------
/**
 * Normalize a component-identity token for the slice-vs-repo-map name match (Lane 0b).
 * `SliceState.components` are free-text tokens parsed from the plan markdown (e.g.
 * "commands"); repo-map `Component.name` / `FileEntry.component` may be POSIX-ish ids
 * (e.g. "src/commands"). We reconcile them by taking the LAST path segment, lowercasing,
 * and stripping a trailing slash — so "src/commands", "commands", and "Commands/" all
 * normalize to "commands". Deterministic + platform-independent. An empty/whitespace
 * token normalizes to "" and never matches (it is reported as unresolved, fail-closed).
 */
function normalizeComponentToken(token) {
    const trimmed = token.trim().replace(/[\\/]+$/, "");
    if (trimmed === "")
        return "";
    const segs = trimmed.split(/[\\/]+/);
    return (segs[segs.length - 1] ?? "").toLowerCase();
}
/** The `done` slices in a state (the independent claim surface — Lane 0a). */
function doneSlices(state) {
    return state.slices.filter((s) => s.status === "done");
}
/**
 * Build the set of component-name normalizations a set of slices declares (Lane 0b). Maps
 * the normalized token back to the slice ids that contributed it, so a matched file's
 * component resolves to the owning done slice(s).
 */
function doneSliceComponentIndex(done) {
    const index = new Map();
    for (const slice of done) {
        for (const comp of slice.components) {
            const norm = normalizeComponentToken(comp);
            if (norm === "")
                continue;
            const owners = index.get(norm) ?? [];
            if (!owners.includes(slice.id))
                owners.push(slice.id);
            index.set(norm, owners);
        }
    }
    return index;
}
/**
 * The REQ-IDs OWNED by a `done` slice (Lane 0c — the gate enumerator). For each REQ-ID
 * carried by any `FileEntry.req_ids` in the repo-map, take that file's `component`,
 * normalize it, and match against the `done` slices' normalized component set. A REQ owned
 * by ANY done slice (via any of its carrying files) must be backed.
 *
 * This REUSES the impact engine's join halves (`FileEntry.req_ids` → `FileEntry.component`)
 * over the same `RepoMap`. Returns the resolved owned set; the UNRESOLVED fail-closed set
 * (a REQ carried only by files whose component matched no done slice) is computed by
 * {@link unresolvedDoneSliceReqs}.
 */
function ownedReqsForDoneSlices(map, state) {
    const done = doneSlices(state);
    if (done.length === 0)
        return [];
    const compIndex = doneSliceComponentIndex(done);
    // reqId → set of owning done-slice ids (resolved via component normalization).
    const owners = new Map();
    for (const file of map.files) {
        if (file.req_ids.length === 0)
            continue;
        const norm = file.component === null ? "" : normalizeComponentToken(file.component);
        const sliceIds = norm === "" ? undefined : compIndex.get(norm);
        if (sliceIds === undefined)
            continue;
        for (const reqId of file.req_ids) {
            const set = owners.get(reqId) ?? new Set();
            for (const id of sliceIds)
                set.add(id);
            owners.set(reqId, set);
        }
    }
    const out = [];
    for (const [reqId, set] of owners) {
        out.push({ reqId, owningSlices: [...set].sort(), unresolved: false });
    }
    out.sort((a, b) => (a.reqId < b.reqId ? -1 : a.reqId > b.reqId ? 1 : 0));
    return out;
}
/**
 * The fail-closed UNRESOLVED set (Lane 0b / control 11f): a REQ-ID that is carried by repo-
 * map files AND appears in a `done` slice's coverage obligation, but whose carrying files'
 * components do NOT normalize-match any done slice component — so the ownership join could
 * not place it under a known component. Such a REQ is REPORTED (and blocks), never silently
 * dropped ("unobserved ≠ clean").
 *
 * We approximate "appears in a done slice's obligation" by: a REQ carried by ≥1 file in the
 * repo-map, NOT resolved by {@link ownedReqsForDoneSlices}, AND carried by a file whose
 * component is null/unmatched while some done slice exists. To avoid blocking on the entire
 * repo's REQ universe (most REQs belong to non-done slices), we ONLY flag a REQ as
 * fail-closed-unresolved when at least one of its carrying files has a `null` component
 * (genuinely unowned-in-map) — the precise name-fidelity hole the guard closes. A REQ whose
 * files all carry a non-null component that simply belongs to a non-done slice is correctly
 * NOT our obligation and is excluded.
 */
function unresolvedDoneSliceReqs(map, state) {
    const done = doneSlices(state);
    if (done.length === 0)
        return [];
    const resolved = new Set(ownedReqsForDoneSlices(map, state).map((o) => o.reqId));
    const unresolved = new Set();
    for (const file of map.files) {
        if (file.req_ids.length === 0)
            continue;
        if (file.component !== null)
            continue; // owned-in-map; not a name-fidelity hole
        for (const reqId of file.req_ids) {
            if (!resolved.has(reqId))
                unresolved.add(reqId);
        }
    }
    return [...unresolved].sort();
}
/**
 * Load + parse the persisted `<stateDir>/repo-map.json` for the gate's ownership join.
 * Returns the parsed map, or `null` when the map is absent/invalid (the gate treats a
 * missing map as "no owned REQs to enforce" — the brownfield `checkRepoMap` rung already
 * owns repo-map freshness; we do not double-block here). Tolerant: never throws.
 */
function loadRepoMapForRealization(paths) {
    const mapJsonPath = path.join(paths.stateDir, "repo-map.json");
    let raw = null;
    try {
        raw = fs.readFileSync(mapJsonPath, "utf8");
    }
    catch {
        return null;
    }
    const parsed = (0, schema_1.parseRepoMap)(raw);
    return parsed.ok && parsed.map ? parsed.map : null;
}
/**
 * Thrown by {@link appendRealizationReceipt} when `artifactPath` does NOT resolve in
 * source (refuse-at-creation: a realization whose referent is already missing must not be
 * minted — mirrors the terminal/driver flows).
 */
class ReferentUnresolvedError extends Error {
    referent;
    /** Stable machine token for the CLI failure envelope. */
    code = "realization_referent_unresolved";
    constructor(message, 
    /** The offending (root-relative) referent path. */
    referent) {
        super(message);
        this.referent = referent;
        this.name = "ReferentUnresolvedError";
    }
}
exports.ReferentUnresolvedError = ReferentUnresolvedError;
/**
 * Append one in-process realization receipt, sealing the hash chain. The caller MUST
 * already hold the `withStateLock` span (read-modify-append is serialized there), exactly
 * like `appendDriverReceipt`.
 *
 * Refuse-at-creation: `artifactPath` MUST resolve in source (its digest is the recomputable
 * referent ground) — else {@link ReferentUnresolvedError}. The receipt records the referent
 * digest + the current snapshot coordinate, derives `prevHash` from the tail, computes
 * `recordHash`, asserts the write-surface, and atomically appends. `producer_kind` is
 * `"in-process"` (zero trust weight). It does NOT set slice status — claim and referent stay
 * separately authored. Returns the sealed receipt.
 */
function appendRealizationReceipt(paths, input) {
    const digest = (0, receipts_1.computeTargetDigest)(paths.root, input.artifactPath);
    if (digest === null) {
        throw new ReferentUnresolvedError(`Refusing to mint a realization receipt for ${input.reqId}: artifact "${input.artifactPath}" does not resolve in source.`, input.artifactPath);
    }
    return sealAndAppend(paths, {
        kind: "realization",
        req_id: input.reqId,
        owning_slice: input.owningSlice,
        referent: { path: input.artifactPath, digest },
        snapshot_coord: (0, receipts_1.currentReceiptSnapshotCoord)(paths),
        producer_identity: input.producerIdentity,
        producer_kind: "in-process",
    });
}
/**
 * Append a one-time `legacy:true` backfill stamp (migration). A legacy receipt carries an
 * EMPTY referent (it grounds nothing — it is grandfathered), the snapshot coordinate of the
 * moment, and `producer_identity: "legacy-backfill"`. Internal: only
 * {@link ensureRealizationMigration} mints these.
 */
function appendLegacyRealizationReceipt(paths, reqId, owningSlice) {
    return sealAndAppend(paths, {
        kind: "realization",
        req_id: reqId,
        owning_slice: owningSlice,
        referent: { path: "", digest: "" },
        snapshot_coord: (0, receipts_1.currentReceiptSnapshotCoord)(paths),
        producer_identity: "legacy-backfill",
        legacy: true,
    });
}
/**
 * The shared seal+append chokepoint: derive `prevHash` from the tail, compute `recordHash`,
 * assert the governed write-surface, mkdir, atomically append. The single place a
 * realization receipt line is written, so the real and legacy producers stay byte-consistent
 * on the chain mechanics.
 */
function sealAndAppend(paths, receipt) {
    (0, paths_1.assertGovernedWriteSurface)(paths.root, realizationReceiptsPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const prevHash = readLastRealizationRecordHash(paths);
    const withPrev = { ...receipt, prevHash };
    const recordHash = computeRealizationRecordHash(withPrev);
    const sealed = { ...withPrev, recordHash };
    fs.appendFileSync(realizationReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
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
 * Apply the CONTENT checks to a present, non-legacy receipt, returning a pass/fail status.
 * On PASS the caller-supplied `passStatus` is returned (`valid` in-process / `valid-grounded`
 * external). On FAIL the specific token (`target_missing`/`target_mismatch`/`stale`) —
 * IDENTICAL discrimination for both producer kinds.
 */
function classifyRealizationContent(paths, receipt, passStatus) {
    const recordedPath = receipt.referent.path;
    const recordedDigest = receipt.referent.digest;
    const currentDigest = (0, receipts_1.computeTargetDigest)(paths.root, recordedPath);
    if (currentDigest === null)
        return { status: "target_missing", receipt };
    if (currentDigest !== recordedDigest)
        return { status: "target_mismatch", receipt };
    const staleReasons = snapshotStaleReasons(receipt.snapshot_coord, (0, receipts_1.currentReceiptSnapshotCoord)(paths));
    if (staleReasons.length > 0)
        return { status: "stale", receipt, staleReasons };
    return { status: passStatus, receipt };
}
/**
 * True iff a receipt CLAIMS to be external/signed — i.e. it carries EITHER a `signature`
 * trailer OR a `key_id`. Such a receipt MUST prove itself with a verifying Ed25519
 * signature; a claim that fails verification is `forged`.
 */
function claimsExternal(r) {
    return typeof r.signature === "string" || typeof r.key_id === "string";
}
/** Verify a realization receipt's Ed25519 signature against the loaded external public key. */
function signatureVerifies(receipt) {
    const publicKey = (0, receipt_signing_1.loadExternalPublicKey)();
    if (publicKey === null)
        return false;
    if (typeof receipt.signature !== "string")
        return false;
    if (receipt.key_id !== (0, receipt_signing_1.externalKeyId)(publicKey))
        return false;
    const { recordHash: _rh, signature: _sig, ...signedView } = receipt;
    return (0, receipt_signing_1.verifyCanonical)(realizationCanonicalText(signedView), receipt.signature, publicKey);
}
/**
 * Validate the receipt backing a realization claim for `reqId` (plan Lane 1 step 4). Reads
 * BOTH stores — the in-process `realization-receipts.jsonl` AND the external store — and
 * gathers every candidate matching `reqId`. Mirrors `readReceiptValidated` precedence
 * EXACTLY: external decisive (verify-or-`forged`) → in-process `valid` → `legacy`
 * grandfather → block set.
 */
function readRealizationReceiptValidated(paths, reqId) {
    const matches = (r) => r.req_id === reqId;
    const inProcessReceipts = readRealizationReceipts(paths);
    if (!verifyRealizationChain(inProcessReceipts).ok)
        return { status: "tampered" };
    // LATEST in-process candidate in file order (a re-realize mints a newer receipt).
    let inProcess;
    for (const r of inProcessReceipts) {
        if (matches(r))
            inProcess = r;
    }
    // ALL external candidates claiming this reqId.
    const externalReceipts = readExternalRealizationReceipts(paths);
    if (!verifyRealizationChain(externalReceipts).ok) {
        // A tampered external chain is fail-closed: do not trust any external line. Fall back to
        // the in-process classification (an external claim that cannot be read is not a forge of
        // the in-process verdict — but a present external CLAIM below would force `forged`).
    }
    const externalCandidates = externalReceipts.filter((r) => matches(r) && claimsExternal(r));
    // (1) An external CLAIM exists → it must PROVE itself with a verifying signature.
    if (externalCandidates.length > 0) {
        const publicKey = (0, receipt_signing_1.loadExternalPublicKey)();
        if (publicKey !== null && verifyRealizationChain(externalReceipts).ok) {
            // The LAST verifying external candidate in file order (a re-mint wins).
            let verified;
            for (const cand of externalCandidates) {
                if (signatureVerifies(cand))
                    verified = cand;
            }
            if (verified) {
                if (verified.legacy === true)
                    return { status: "legacy", receipt: verified };
                return classifyRealizationContent(paths, verified, "valid-grounded");
            }
        }
        // No external candidate verified (key absent, chain broken, or all signatures bad) → forged.
        return { status: "forged", receipt: externalCandidates[externalCandidates.length - 1] };
    }
    // (2) No external claim → the in-process classification on the latest line.
    if (!inProcess) {
        // absent-classification / migration: pre-upgrade ⇒ legacy; migrated-baseline ⇒ legacy;
        // migrated + not in baseline ⇒ absent → BLOCK.
        if (!realizationMigrationDone(paths))
            return { status: "legacy" };
        if (grandfatheredRealizationBaseline(paths).has(reqId))
            return { status: "legacy" };
        return { status: "absent" };
    }
    if (inProcess.legacy === true)
        return { status: "legacy", receipt: inProcess };
    return classifyRealizationContent(paths, inProcess, "valid");
}
// ---------------------------------------------------------------------------
// Migration / grandfather — idempotent, resume-safe
// ---------------------------------------------------------------------------
/** `<stateDir>/.realization-receipts-migration` — the migration marker file. */
function migrationMarkerPath(paths) {
    return path.join(paths.stateDir, ".realization-receipts-migration");
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
 * True once {@link ensureRealizationMigration} has run for this project (the marker file is
 * present + well-shaped). The gate's absent-classification keys on this to tell "genuinely
 * pre-upgrade" (no marker → grandfather implicitly) from "post-upgrade bypass" (marker
 * present, REQ not in baseline → BLOCK).
 */
function realizationMigrationDone(paths) {
    return readMigrationMarker(paths) !== undefined;
}
/**
 * The grandfathered baseline REQ-ID set captured at migration time. Empty when not yet
 * migrated. These REQs were already owned by `done` slices BEFORE the receipt regime
 * began, so an absent receipt for them is grandfathered (`legacy`) rather than a bypass.
 */
function grandfatheredRealizationBaseline(paths) {
    const marker = readMigrationMarker(paths);
    return new Set(marker ? marker.baseline : []);
}
/**
 * Idempotent, marker-guarded migration. MUST be called holding the state lock (it appends
 * receipts + writes the marker). On the FIRST call it stamps a `legacy:true` receipt for
 * every REQ-ID currently owned by a `done` slice that lacks ANY receipt, then writes the
 * marker recording the full grandfathered baseline REQ-ID set. A re-run is a no-op (the
 * marker is present).
 *
 * Double-stamp guard: even within the first run, a REQ that ALREADY has a receipt (scanning
 * the receipts file) is skipped — so a partial prior run, or a real receipt minted before
 * migration, is never double-stamped. The marker is written LAST, so a crash mid-stamp
 * leaves no marker and the next run re-attempts (the guard makes the retry safe).
 */
function ensureRealizationMigration(paths, state, map) {
    if (realizationMigrationDone(paths))
        return;
    const owned = map === null ? [] : ownedReqsForDoneSlices(map, state);
    // The REQ-IDs that already have ANY receipt — so we never double-stamp.
    const existing = new Set();
    for (const r of readRealizationReceipts(paths))
        existing.add(r.req_id);
    for (const o of owned) {
        if (existing.has(o.reqId))
            continue;
        appendLegacyRealizationReceipt(paths, o.reqId, o.owningSlices[0] ?? "");
        existing.add(o.reqId);
    }
    const baseline = owned.map((o) => o.reqId);
    const marker = { migratedAt: new Date().toISOString(), baseline };
    (0, paths_1.assertGovernedWriteSurface)(paths.root, migrationMarkerPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(migrationMarkerPath(paths), JSON.stringify(marker), "utf8");
}
/**
 * SELF-LOCKING opportunistic grandfather stamp — the fail-open closure (team-fix #8).
 *
 * THE WINDOW IT CLOSES: {@link ensureRealizationMigration} is otherwise stamped ONLY at the
 * `th slice set-status … done` transition (`commands/slices.ts`). A project that reaches a
 * `done` slice via ANY OTHER path — an `--emergency` raw `state set`, an imported/pre-existing
 * state file, a state hand-edited then adopted — never stamps the marker. With no marker,
 * {@link readRealizationReceiptValidated} grandfathers EVERY REQ as `legacy`, so the
 * realization rung silently never enforces (a fail-open: the gate that exists to catch an
 * unbacked done-slice REQ would pass it). This stamps the baseline the FIRST time the GATE
 * observes a `done` slice, regardless of how that slice became done — the gate is the
 * universal chokepoint every completion path funnels through.
 *
 * SAFE FROM A READER: the gate (`checkProductionReality`) is a PURE READER invoked from
 * surfaces that do NOT hold the state lock (`th gate production-reality`, `th next`, the
 * stop-gate, the MCP gate tools). This therefore takes its OWN `withStateLock` span — it must
 * NOT be called from a context already holding the lock (`withStateLock` is a non-reentrant
 * mkdir mutex; the slice→done path already holds it and calls the UN-locked
 * {@link ensureRealizationMigration} directly). It is a ONE-TIME write: after the first stamp
 * the marker fast-path returns WITHOUT locking, so the lock is taken at most once per project.
 *
 * It only stamps when a `done` slice actually exists (mirrors the slice→done trigger's
 * semantics: the obligation begins when the first done slice appears) — a project with no done
 * slices is left un-stamped so its baseline is not frozen empty before the regime is relevant.
 * Best-effort + fail-soft: a lock-timeout / read failure does NOT throw into the gate (the
 * gate then sees no marker and grandfathers `legacy` for this run — the SAME pre-fix posture,
 * never a crash; the next gate observation re-attempts the stamp).
 */
function ensureRealizationMigrationOpportunistic(paths) {
    if (realizationMigrationDone(paths))
        return; // fast-path: already stamped, no lock
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists || !r.state)
        return; // not an initialized project → nothing to grandfather
    const state = r.state;
    if (doneSlices(state).length === 0)
        return; // no done slice yet → obligation not live
    try {
        (0, state_store_1.withStateLock)(paths, () => {
            // Re-check UNDER the lock: another writer (or the slice→done path) may have stamped
            // between the unlocked fast-path and acquiring the lock. The marker write is the
            // single source of truth; this guard makes the stamp idempotent across racers.
            if (realizationMigrationDone(paths))
                return;
            const fresh = (0, state_store_1.readState)(paths);
            if (!fresh.exists || !fresh.state)
                return;
            if (doneSlices(fresh.state).length === 0)
                return;
            ensureRealizationMigration(paths, fresh.state, loadRepoMapForRealization(paths));
        });
    }
    catch {
        // Fail-soft: never let a lock-timeout / transient write error crash the gate. The marker
        // simply stays unstamped for this observation (legacy-grandfathered, the pre-fix posture)
        // and the NEXT gate observation re-attempts — the stamp is idempotent + resume-safe.
    }
}
