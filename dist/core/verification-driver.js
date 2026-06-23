"use strict";
/**
 * VerificationDriver sensor + driver-dimension receipt store (Axis-B slice-4a /
 * BSC-3 — the cross-cutting keystone the consensus plan names for BSC-1/2/3 and the
 * runner-side of BSC-5). The completion gate currently clears on a verify report that
 * says "ok", with NO record of WHICH verification dimensions a trusted runner actually
 * EXERCISED — so a run that never typechecked, or never built, reads identically to one
 * that did. This module is the SENSOR: the trusted runner observes which dimensions it
 * exercised (seed `{tests-executed, typecheck, build}`) ONLY from a real, recomputable
 * artifact, and mints a schema-registered {@link DriverDimensionReceipt} whose ground is
 * re-derivable at gate time, so a run that CLAIMS a dimension it did not observe is
 * mechanically detectable (slice-4a negative-control).
 *
 * BINDING CONTRACT (the single most important correctness rule of the slice):
 *   - Every seed dimension binds to `verify-report.json`'s per-command exit results
 *     `{command, exitCode, ok}` (`src/core/verify.ts` writes these). A dimension is
 *     OBSERVED iff the report has a command matching the dimension whose `ok === true`.
 *   - The receipt's `evidenceRef` points at `verify-report.json` (a recomputable file),
 *     and the receipt is snapshot-bound — so the gate re-reads the report at validation
 *     time and re-derives the observation (the F8 "diffable ground" lesson).
 *   - It NEVER binds to `tester-record.json`: `src/commands/tester.ts` records an
 *     AGENT-SUPPLIED MARKER, not a runner observation. Binding there would reproduce
 *     BSC-3 inside its own fix.
 *
 * Storage mirrors `src/core/approvals.ts` EXACTLY: a DEDICATED, lock-isolated
 * append-only SHA-256 hash-chained `<stateDir>/driver-receipts.jsonl`, a tolerant
 * reader, a tail-scan for the next `prevHash`, an atomic-append writer that runs under
 * the CALLER's `withStateLock` span, and a tamper-detecting chain walk. A dedicated
 * store keeps the gate one validated reader and gives slice-4b's external (un-writable)
 * producer a distinct location.
 *
 * `producer_identity` carries ZERO trust weight in-process (consensus §3): it is an
 * audit breadcrumb only. The genuine un-forgeable property arrives in slice-4b (an
 * external keyed producer at a write-surface TwinHarness cannot reach); the in-process
 * pass status is `valid` NEVER `valid-grounded`, so the status itself encodes the trust
 * level. Documented as such so a reviewer never mistakes it for a trust anchor.
 *
 * It REUSES the shared digest/snapshot primitives (`computeTargetDigest`,
 * `currentReceiptSnapshotCoord`, `SnapshotCoord`) and signing infra
 * (`receipt-signing.ts`) — it does NOT import or touch `tester.ts` (F8 invariant: the
 * tester call path stays byte-identical and its tests stay green).
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
exports.EvidenceUnresolvedError = exports.DimensionUnobservedError = exports.SEED_DIMENSION_NAMES = exports.SEED_DIMENSIONS = void 0;
exports.observedDimensionsFromReport = observedDimensionsFromReport;
exports.driverCanonicalText = driverCanonicalText;
exports.computeDriverRecordHash = computeDriverRecordHash;
exports.driverReceiptsPath = driverReceiptsPath;
exports.externalDriverReceiptsPath = externalDriverReceiptsPath;
exports.isValidDriverReceipt = isValidDriverReceipt;
exports.readDriverReceipts = readDriverReceipts;
exports.readExternalDriverReceipts = readExternalDriverReceipts;
exports.readLastExternalDriverRecordHash = readLastExternalDriverRecordHash;
exports.readLastDriverRecordHash = readLastDriverRecordHash;
exports.verifyDriverChain = verifyDriverChain;
exports.observeDriverDimensions = observeDriverDimensions;
exports.appendDriverReceipt = appendDriverReceipt;
exports.validateDriverReceiptContent = validateDriverReceiptContent;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
const hash_1 = require("./hash");
const jsonl_1 = require("./jsonl");
const receipts_1 = require("./receipts");
const verify_1 = require("./verify");
// ---------------------------------------------------------------------------
// Seed dimension vocabulary + the binding contract (verify-report.json ONLY)
// ---------------------------------------------------------------------------
/**
 * The seed dimension vocabulary for slice-4a (the namespace is OPEN; this slice seeds
 * exactly three). Each maps to the substrings that identify its verify command in
 * `verify-report.json`'s per-command results. A dimension is OBSERVED iff the report has
 * a command whose text contains ANY of the dimension's markers AND that command's
 * `ok === true` (it actually passed). Declared-SET coverage is BSC-5, assertion quality
 * is BSC-2 — this slice builds only the sensor those rows consume.
 */
exports.SEED_DIMENSIONS = [
    // `tests-executed` — a test runner command actually ran and passed.
    { name: "tests-executed", commandMarkers: ["test", "vitest", "jest", "mocha"] },
    // `typecheck` — a no-emit type check ran and passed.
    { name: "typecheck", commandMarkers: ["typecheck", "tsc", "type-check"] },
    // `build` — a build/compile command ran and passed. NOT the committed-`dist/` digest
    // (that would be circular with the dist invariant); the runner's verify exit is the ground.
    { name: "build", commandMarkers: ["build", "compile", "esbuild"] },
];
/** The seed dimension NAMES (open vocabulary, this slice's three). */
exports.SEED_DIMENSION_NAMES = exports.SEED_DIMENSIONS.map((d) => d.name);
/**
 * True iff `command` (a verify-report command string) matches the dimension's markers.
 * Case-insensitive substring match — the same heuristic the verify-report surface uses to
 * label commands; deterministic and platform-independent.
 */
function commandMatchesDimension(command, markers) {
    const lc = command.toLowerCase();
    return markers.some((m) => lc.includes(m));
}
/**
 * Derive the dimensions a verify report OBSERVES — the SINGLE shared derivation used by
 * BOTH the sensor (at mint time) and the validator (at gate time), so the two sides can
 * never drift apart on what "observed" means. For each seed dimension, a command in the
 * report whose text matches the dimension's markers AND whose `ok === true` makes the
 * dimension observed. Returns the set of observed seed dimension names.
 *
 * `null`/absent report ⇒ empty set (nothing observed — fail-closed at the gate). A report
 * with a matching command that FAILED (`ok === false`) does NOT observe the dimension.
 */
function observedDimensionsFromReport(report) {
    const observed = new Set();
    if (report === null || !Array.isArray(report.results))
        return observed;
    for (const dim of exports.SEED_DIMENSIONS) {
        const hit = report.results.some((r) => r.ok === true && typeof r.command === "string" && commandMatchesDimension(r.command, dim.commandMarkers));
        if (hit)
            observed.add(dim.name);
    }
    return observed;
}
// ---------------------------------------------------------------------------
// Canonical text + hashing (mirrors receipts.ts / approvals.ts)
// ---------------------------------------------------------------------------
/**
 * The fixed canonical field order for hashing/signing (mirrors `receipts.ts` +
 * `approvals.ts`). `signature` and `recordHash` are EXCLUDED trailers (computed over the
 * IDENTICAL bytes); `undefined` keys are dropped, so a 4a receipt (the three signing
 * fields absent) is byte-stable. The `dimensions` array and `snapshot_coord` object are
 * re-emitted in a fixed key order so the canonical text is deterministic.
 */
const DRIVER_CANONICAL_FIELD_ORDER = [
    "kind",
    "refId",
    "dimensions",
    "snapshot_coord",
    "producer_identity",
    "producer_kind",
    "key_id",
    "legacy",
    // BSC-10 (C4a) evidence-spine BINDING OPT-IN: IN the canonical order just BEFORE `manifest_digest`
    // so a PRESENT `grounding_bound` is signature/hash-bound. Omit-when-absent ⇒ a pre-BSC-10 / un-
    // enrolled receipt (the field absent) is byte-identical, so shipped BSC-3 probes + parity hold.
    "grounding_bound",
    // BSC-10 evidence-spine thread: IN the canonical order (just before `prevHash`) so a PRESENT
    // `manifest_digest` is signature/hash-bound (tamper-evident). Omit-when-absent ⇒ a pre-BSC-10
    // receipt (the field absent) is byte-identical, so shipped BSC-3 probes + receipts-parity hold.
    "manifest_digest",
    "prevHash",
];
/** Canonical key order for one {@link DriverDimension} (byte-stable nested JSON). */
const DIMENSION_FIELD_ORDER = ["name", "observed", "evidenceRef"];
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
 * Deterministic canonical text of a driver receipt for hashing/signing. Field order is
 * fixed; `undefined` keys and `recordHash` are dropped; each dimension is re-emitted in
 * its fixed key order (so the array is byte-stable element-by-element) and the snapshot
 * object likewise; `JSON.stringify` with no indentation. `signature` is excluded (a
 * trailer). `hashContent` then CRLF→LF normalizes (harmless — no CRLF in the text).
 */
function driverCanonicalText(receipt) {
    const ordered = {};
    for (const key of DRIVER_CANONICAL_FIELD_ORDER) {
        const val = receipt[key];
        if (val === undefined)
            continue;
        if (key === "dimensions") {
            ordered[key] = val.map((d) => reorder(d, DIMENSION_FIELD_ORDER));
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
/** `recordHash` for a driver receipt = SHA-256 of its canonical text (recordHash omitted). */
function computeDriverRecordHash(receipt) {
    return (0, hash_1.hashContent)(driverCanonicalText(receipt));
}
// ---------------------------------------------------------------------------
// Storage (mirrors approvals.ts)
// ---------------------------------------------------------------------------
/** `<stateDir>/driver-receipts.jsonl` — the in-process driver-dimension ledger. */
function driverReceiptsPath(paths) {
    return path.join(paths.stateDir, "driver-receipts.jsonl");
}
/**
 * `<stateDir>/external-driver-receipts.jsonl` — the EXTERNAL keyed producer's store
 * (slice-4b). A SEPARATE file for LOCK-ISOLATION (parallel to `external-receipts.jsonl` /
 * `external-approvals.jsonl`): the out-of-process CI producer appends here without taking
 * the in-process `withStateLock` span. The SECURITY boundary is NOT this path — it is the
 * private key held only by the producer; a forged line written here is rejected by the
 * gate validator (no verifying signature ⇒ `forged`).
 */
function externalDriverReceiptsPath(paths) {
    return path.join(paths.stateDir, "external-driver-receipts.jsonl");
}
const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
/** Validate the shape of a parsed driver-receipt line; malformed lines are skipped (tolerant). */
function isValidDriverReceipt(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const r = parsed;
    if (r.kind !== "driver-dimension")
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
    // Slice-4b OPTIONAL signing fields: accepted when present, NEVER required.
    if (r.producer_kind !== undefined && r.producer_kind !== "external" && r.producer_kind !== "in-process")
        return false;
    if (r.key_id !== undefined && typeof r.key_id !== "string")
        return false;
    if (r.signature !== undefined &&
        (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))) {
        return false;
    }
    // Dimensions: a present array of well-shaped rows (each `observed:true`).
    if (!Array.isArray(r.dimensions))
        return false;
    for (const d of r.dimensions) {
        if (typeof d !== "object" || d === null)
            return false;
        const dim = d;
        if (typeof dim.name !== "string" || dim.name === "")
            return false;
        if (dim.observed !== true)
            return false;
        if (typeof dim.evidenceRef !== "string" || dim.evidenceRef === "")
            return false;
    }
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
 * Read + parse every driver receipt in the in-process store, in file order. Missing
 * file → `[]`. Bad lines (non-JSON, partial-tail, schema-invalid) are silently skipped —
 * tolerant, never throws. Chain breaks surface via {@link verifyDriverChain}.
 */
function readDriverReceipts(paths) {
    return (0, jsonl_1.readJsonlValues)(driverReceiptsPath(paths), isValidDriverReceipt);
}
/**
 * Read + parse every driver receipt in the EXTERNAL store (slice-4b), same tolerant shape
 * as {@link readDriverReceipts}. The signature on a line is verified at gate time by the
 * gate validator, NOT here — this reader is shape-only, so a forged-but-well-shaped line is
 * returned and then classified `forged` downstream.
 */
function readExternalDriverReceipts(paths) {
    return (0, jsonl_1.readJsonlValues)(externalDriverReceiptsPath(paths), isValidDriverReceipt);
}
/**
 * The `recordHash` of the EXTERNAL store's last valid driver receipt — the `prevHash` seed
 * for the external producer's own append-only chain. Missing/empty/no-valid-tail →
 * `GENESIS_PREV_HASH`. Used by the slice-4b standalone producer.
 */
function readLastExternalDriverRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(externalDriverReceiptsPath(paths), isValidDriverReceipt);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * The `recordHash` of the in-process ledger's last VALID driver receipt — the seed
 * {@link appendDriverReceipt} needs to seal the next link. Tail-scans the file so N appends
 * stay O(N) total. Missing/empty/no-valid-tail → `GENESIS_PREV_HASH`.
 */
function readLastDriverRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(driverReceiptsPath(paths), isValidDriverReceipt);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * Walk driver receipts in file order with a running `expectedPrev = GENESIS`. For each:
 * recompute `recordHash` from its canonical text — a mismatch means the record was edited;
 * if `prevHash !== expectedPrev` the line was inserted/deleted/reordered (a truncated head,
 * the first line's `prevHash !== GENESIS`, breaks here too). Return `{ ok:false,
 * brokenAt:N }` at the FIRST break; else advance. Byte-identical posture to
 * `receipts.verifyReceiptChain`.
 */
function verifyDriverChain(receipts) {
    let expectedPrev = hash_1.GENESIS_PREV_HASH;
    for (let i = 0; i < receipts.length; i++) {
        const r = receipts[i];
        const { recordHash, ...rest } = r;
        const recomputed = computeDriverRecordHash(rest);
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
 * Thrown by {@link appendDriverReceipt} when a claimed dimension is NOT observed in
 * `verify-report.json` (refuse-at-creation: the sensor never records a dimension a real
 * runner did not exercise — the negative-control, enforced before any write).
 */
class DimensionUnobservedError extends Error {
    unobserved;
    /** Stable machine token for the CLI failure envelope. */
    code = "driver_dimension_unobserved";
    constructor(message, 
    /** The dimension names claimed but not observed. */
    unobserved) {
        super(message);
        this.unobserved = unobserved;
        this.name = "DimensionUnobservedError";
    }
}
exports.DimensionUnobservedError = DimensionUnobservedError;
/**
 * Thrown by {@link appendDriverReceipt} when the bound `verify-report.json` artifact does
 * not resolve in source (its digest is needed as the recomputable evidenceRef ground — a
 * receipt whose evidence is already missing must not be minted).
 */
class EvidenceUnresolvedError extends Error {
    evidenceRef;
    /** Stable machine token for the CLI failure envelope. */
    code = "driver_evidence_unresolved";
    constructor(message, 
    /** The (root-relative) evidence path that did not resolve. */
    evidenceRef) {
        super(message);
        this.evidenceRef = evidenceRef;
        this.name = "EvidenceUnresolvedError";
    }
}
exports.EvidenceUnresolvedError = EvidenceUnresolvedError;
/**
 * Observe the driver dimensions for the current run from `verify-report.json` (the SENSOR
 * step). Reads the report, derives the observed seed dimensions via the shared
 * {@link observedDimensionsFromReport}, and returns one {@link DriverDimension} per observed
 * name bound to the report's root-relative path. Used internally by
 * {@link appendDriverReceipt}; exported so Lane D can assert the sensor reads the artifact.
 */
function observeDriverDimensions(paths) {
    const evidenceRef = path.relative(paths.root, (0, verify_1.verifyReportPath)(paths)).split(path.sep).join("/");
    const observed = observedDimensionsFromReport((0, verify_1.readVerifyReport)(paths));
    const out = [];
    for (const name of exports.SEED_DIMENSION_NAMES) {
        if (observed.has(name))
            out.push({ name, observed: true, evidenceRef });
    }
    return out;
}
/**
 * Append one in-process driver-dimension receipt, sealing the hash chain. The caller MUST
 * already hold the `withStateLock` span (read-modify-append is serialized there), exactly
 * like `appendApprovalReceipt`.
 *
 * SENSOR + refuse-at-creation (slice-4a negative-control): the run records a dimension ONLY
 * when `verify-report.json` actually OBSERVES it. A `dimensionNames` claim is INTERSECTED
 * with the observed set; a claimed-but-unobserved name throws {@link DimensionUnobservedError}
 * BEFORE any write, so a claim-without-observation can never be minted. The bound report
 * artifact MUST resolve in source (its digest is the recomputable ground) — else
 * {@link EvidenceUnresolvedError}. The receipt records the observed dimensions + the current
 * snapshot coordinate, derives `prevHash` from the tail, computes `recordHash`, asserts the
 * write-surface, and atomically appends. `producer_kind` is `"in-process"` (zero trust
 * weight). Returns the sealed receipt.
 */
function appendDriverReceipt(paths, input) {
    // The recomputable ground MUST resolve: bind the report artifact's digest at mint time
    // so the gate can re-read + recompute (the F8 lesson). A missing report ⇒ refuse.
    const evidenceRef = path.relative(paths.root, (0, verify_1.verifyReportPath)(paths)).split(path.sep).join("/");
    if ((0, receipts_1.computeTargetDigest)(paths.root, evidenceRef) === null) {
        throw new EvidenceUnresolvedError(`Refusing to mint a driver-dimension receipt: evidence artifact "${evidenceRef}" does not resolve in source.`, evidenceRef);
    }
    // SENSOR: what the runner actually observed (the ONLY thing recordable).
    const observed = observeDriverDimensions(paths);
    const observedNames = new Set(observed.map((d) => d.name));
    // Negative-control (refuse-at-creation): a CLAIMED dimension the report did not observe
    // is refused — a claim-without-observation can never be minted.
    if (input.dimensionNames !== undefined) {
        const unobserved = input.dimensionNames.filter((n) => !observedNames.has(n));
        if (unobserved.length > 0) {
            throw new DimensionUnobservedError(`Refusing to record driver dimension(s) not observed in verify-report.json: ${unobserved.join(", ")}.`, unobserved);
        }
    }
    // The dimensions RECORDED: the claimed subset (when given) or every observed dimension.
    const dimensions = input.dimensionNames === undefined
        ? observed
        : observed.filter((d) => input.dimensionNames.includes(d.name));
    return sealAndAppend(paths, {
        kind: "driver-dimension",
        refId: driverRefId(paths),
        dimensions,
        snapshot_coord: (0, receipts_1.currentReceiptSnapshotCoord)(paths),
        producer_identity: input.producerIdentity,
        producer_kind: "in-process",
    });
}
/**
 * The run/verification identity a fresh receipt grounds: the current `gitHead`, or
 * `"no-git"` on a non-git checkout. A re-run at a new HEAD mints a receipt under a new
 * refId, so the gate finds the LATEST receipt for the current snapshot.
 */
function driverRefId(paths) {
    return (0, receipts_1.currentReceiptSnapshotCoord)(paths).gitHead ?? "no-git";
}
/**
 * The shared seal+append chokepoint: derive `prevHash` from the tail, compute `recordHash`,
 * assert the governed write-surface, mkdir, atomically append. The single place a driver
 * receipt line is written, so future producers stay byte-consistent on the chain mechanics.
 */
function sealAndAppend(paths, receipt) {
    (0, paths_1.assertGovernedWriteSurface)(paths.root, driverReceiptsPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const prevHash = readLastDriverRecordHash(paths);
    const withPrev = { ...receipt, prevHash };
    const recordHash = computeDriverRecordHash(withPrev);
    const sealed = { ...withPrev, recordHash };
    fs.appendFileSync(driverReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
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
 * Re-derive a driver receipt's GROUND at gate time and classify it — the digest-recompute /
 * validator Lane B's gate consumes (the F8 "recomputable ground" property). For EACH
 * recorded dimension: re-read `verify-report.json` and confirm the dimension is STILL
 * observed by it (a recorded claim that the current report does not evidence ⇒
 * `dimension_unobserved` ⇒ BLOCK — this is what makes a claimed-but-unobserved dimension
 * detectable even if a line were hand-inserted past the chain check). Then confirm the bound
 * evidence artifact resolves, and the snapshot coordinate has not drifted.
 *
 * The dimension's `evidenceRef` is re-resolved per-dimension (all seed dimensions bind the
 * same `verify-report.json`, but the per-dimension ref keeps the contract honest if the
 * vocabulary later binds different artifacts).
 */
function validateDriverReceiptContent(paths, receipt) {
    // Evidence must still resolve (every recorded dimension's bound artifact).
    for (const dim of receipt.dimensions) {
        if ((0, receipts_1.computeTargetDigest)(paths.root, dim.evidenceRef) === null) {
            return { status: "evidence_missing" };
        }
    }
    // Re-derive what the CURRENT report observes; every RECORDED dimension must still be in it.
    const observed = observedDimensionsFromReport((0, verify_1.readVerifyReport)(paths));
    const unobserved = receipt.dimensions.filter((d) => !observed.has(d.name)).map((d) => d.name);
    if (unobserved.length > 0) {
        return { status: "dimension_unobserved", unobservedDimensions: unobserved };
    }
    // Snapshot binding: stale when a present coordinate diverged from the current tree.
    const staleReasons = snapshotStaleReasons(receipt.snapshot_coord, (0, receipts_1.currentReceiptSnapshotCoord)(paths));
    if (staleReasons.length > 0)
        return { status: "stale", staleReasons };
    return { status: "valid" };
}
