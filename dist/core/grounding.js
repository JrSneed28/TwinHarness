"use strict";
/**
 * External-reference grounding sensor + receipt store + the work-class classifier and the
 * sibling external-signed budget/exception/carve-out stores (Axis-B slice-BSC10a / BSC-10).
 *
 * THE BLIND SPOT: TwinHarness can mint downstream realization (BSC-1) but has NO mechanical
 * record that the real EXTERNAL reference a piece of work was supposed to match — a pinned
 * dependency version, a content/symbol manifest, a rendered surface — was ACTUALLY CHECKED.
 * "We grounded against the reference" is asserted with no recomputable correspondence. This
 * module is the upstream input-grounding counterpart to BSC-1: it derives the recomputable
 * computable ground for a piece of work and mints a schema-registered {@link GroundingReceipt}
 * whose ground is re-derivable at gate time, so a work-class that REQUIRES a grounding kind but
 * carries none (or an over-budget / unobserved one) is mechanically detectable.
 *
 * Storage mirrors `src/core/assertion-presence.ts` / `src/core/realization.ts` EXACTLY: a
 * DEDICATED, lock-isolated append-only SHA-256 hash-chained `<stateDir>/grounding-receipts.jsonl`,
 * a tolerant reader that never throws, a tail-scan for the next `prevHash`, an atomic-append
 * writer that runs under the CALLER's `withStateLock` span, and a tamper-detecting chain walk.
 * The external producer's store is a SEPARATE lock-isolated `<stateDir>/external-grounding-
 * receipts.jsonl` (parallel to the external driver/mutation stores) — the out-of-process keyed
 * producer (Slice B) appends there without taking the in-process lock; the security boundary is
 * the private key, not the path.
 *
 * THE SIGNED SIBLING STORES (PCC-4): the conformance BUDGETS, the `SignedException`s, and the
 * permitted-difference CARVE-OUTs are NOT receipt fields — they live in three sibling external-
 * signed stores (`grounding-budgets.jsonl` / `grounding-exceptions.jsonl` / `grounding-
 * carveouts.jsonl`), modeled symbol-for-symbol on `assertion-waivers.jsonl` and `scan-exceptions`.
 * In slice-BSC10a these stores carry a SCHEMA + a TOLERANT READER ONLY — there is NO in-process
 * producer (an agent cannot self-sign its own budget — 3-party authority), and an UNSIGNED /
 * wrong-key line exempts NOTHING (fail-closed M4: the gate treats the required ground as
 * ungrounded/over-budget, never a passing budget). The Slice-B Ed25519 producer fills them.
 *
 * BINDING CONTRACT (mirrors the BSC-2 sensor determinism rule): the ground serialization is
 * DETERMINISTIC — every nested object is re-emitted in a FIXED key order, `entries[]` are sorted
 * lexically by POSIX-normalized `path`, `conformance[]` is sorted by `metric`, NO clock / NO
 * random / NO `Date` in any canonical text. There is NO `typescript`/AST/renderer/axe runtime
 * dependency: `visual-hash` + `a11y` MEASUREMENT is a documented STUB that emits
 * `conformance: unobserved` (fail-closed under forced enforce; real measurement is Slice C).
 *
 * `producer_identity` carries ZERO trust weight in-process; the genuine un-forgeable property is
 * the Slice-B external Ed25519 signature (a write-surface TwinHarness cannot reach). Absence ≠
 * forgery: an in-process-only grounding receipt is `ungrounded` where a kind is required, NEVER
 * `forged` (mirrors `valid` vs `valid-grounded` in `receipts.ts`).
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
exports.requiredGroundKindsForWorkClass = requiredGroundKindsForWorkClass;
exports.serializeGroundingGround = serializeGroundingGround;
exports.groundingGroundDigest = groundingGroundDigest;
exports.groundingCanonicalText = groundingCanonicalText;
exports.computeGroundingRecordHash = computeGroundingRecordHash;
exports.groundingReceiptsPath = groundingReceiptsPath;
exports.externalGroundingReceiptsPath = externalGroundingReceiptsPath;
exports.groundingBudgetsPath = groundingBudgetsPath;
exports.groundingExceptionsPath = groundingExceptionsPath;
exports.groundingCarveoutsPath = groundingCarveoutsPath;
exports.isValidGroundingReceipt = isValidGroundingReceipt;
exports.readGroundingReceipts = readGroundingReceipts;
exports.readExternalGroundingReceipts = readExternalGroundingReceipts;
exports.readLastGroundingRecordHash = readLastGroundingRecordHash;
exports.readLastExternalGroundingRecordHash = readLastExternalGroundingRecordHash;
exports.verifyGroundingChain = verifyGroundingChain;
exports.appendGroundingReceipt = appendGroundingReceipt;
exports.validateGroundingContent = validateGroundingContent;
exports.readGroundingValidated = readGroundingValidated;
exports.isValidGroundingBudget = isValidGroundingBudget;
exports.isValidGroundingException = isValidGroundingException;
exports.isValidGroundingCarveout = isValidGroundingCarveout;
exports.readGroundingBudgets = readGroundingBudgets;
exports.readGroundingExceptions = readGroundingExceptions;
exports.readGroundingCarveouts = readGroundingCarveouts;
exports.groundingBudgetCanonicalText = groundingBudgetCanonicalText;
exports.groundingExceptionCanonicalText = groundingExceptionCanonicalText;
exports.groundingCarveoutCanonicalText = groundingCarveoutCanonicalText;
exports.validGroundingExemptions = validGroundingExemptions;
exports.groundingExemptionKey = groundingExemptionKey;
exports.validGroundingBudgets = validGroundingBudgets;
exports.validGroundingCarveouts = validGroundingCarveouts;
exports.toleranceThresholdVerdicts = toleranceThresholdVerdicts;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_1 = require("./paths");
const hash_1 = require("./hash");
const jsonl_1 = require("./jsonl");
const receipts_1 = require("./receipts");
const receipt_signing_1 = require("./receipt-signing");
const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
// ---------------------------------------------------------------------------
// Work-class → required-ground-kinds classifier (the fixed matrix + the rules)
// ---------------------------------------------------------------------------
/**
 * The fixed, ratified work-class → required-ground-kinds matrix (spec R2; gap 9 maps the spec's
 * `digest` shorthand → the schema literal `"digest-manifest"`). One row per ground-bearing
 * work-class; `pure-greenfield` is INERT (empty required-set ⇒ the gate is not-required/PASS).
 * A `greenfield+dep` (a greenfield with declared dependencies) requires a `version-pin` per the
 * UX/dep rules below. Frozen so producer and validator can never drift on what a class requires.
 */
const WORK_CLASS_GROUND_MATRIX = {
    redesign: ["digest-manifest", "visual-hash"],
    recreation: ["digest-manifest", "visual-hash", "version-pin"],
    integration: ["digest-manifest", "version-pin"],
    migration: ["version-pin", "digest-manifest"],
    "greenfield+dep": ["version-pin"],
    greenfield: [],
};
/**
 * The surface labels that FORCE a `visual-hash` requirement regardless of the declared work-class
 * (spec R2: label ≠ surface). An interactive/screen/TUI surface is grounded visually even when a
 * task is labelled "CLI": the LABEL is the agent's claim, the SURFACE is the observable fact.
 */
const UX_SURFACE_LABELS = new Set(["ux", "ui", "tui", "screen", "interactive", "visual"]);
/** True iff any of `surfaces` is a UX/screen surface that forces a `visual-hash` ground. */
function hasUxSurface(surfaces) {
    return surfaces.some((s) => UX_SURFACE_LABELS.has(s.trim().toLowerCase()));
}
/**
 * The fixed work-class → required-ground-kinds resolution (spec R2 + the UX-surface force-rule +
 * the cross-check conflict rule). `workClass` is the DECLARED class; `surfaces` is the observed
 * surface set (which may force `visual-hash`); `derivedClass` is the OPTIONAL evidence-derived
 * class (the BSC-8-style cross-check). The rules, in order:
 *
 *  1. Base required-set = the matrix row for `workClass` (unknown class ⇒ empty, treated inert).
 *  2. UX-surface force-rule: a UX/screen surface FORCES `visual-hash` into the set for ANY class.
 *  3. Cross-check conflict rule: when `derivedClass` is supplied AND differs from `workClass`, the
 *     required-set becomes the STRICTER UNION of BOTH rows (fail-closed — never silently pick one)
 *     and `crossCheckFlag` is set so the human ratifies the divergence. Same class ⇒ no flag.
 *
 * The result is lexically sorted + de-duplicated so it is deterministic.
 */
function requiredGroundKindsForWorkClass(workClass, surfaces = [], derivedClass) {
    const set = new Set(WORK_CLASS_GROUND_MATRIX[workClass] ?? []);
    // (2) UX-surface force-rule — a screen/interactive surface forces visual grounding.
    if (hasUxSurface(surfaces))
        set.add("visual-hash");
    // (3) Cross-check conflict rule — declared ≠ derived ⇒ stricter union + a surfaced flag.
    let crossCheckFlag;
    if (derivedClass !== undefined && derivedClass !== "" && derivedClass !== workClass) {
        for (const k of WORK_CLASS_GROUND_MATRIX[derivedClass] ?? [])
            set.add(k);
        crossCheckFlag = "class-cross-check-mismatch";
    }
    const required = [...set].sort();
    return crossCheckFlag ? { required, crossCheckFlag } : { required };
}
// ---------------------------------------------------------------------------
// Ground serialization + digest (deterministic, byte-stable — sort+POSIX-normalize)
// ---------------------------------------------------------------------------
/** Canonical key order for {@link SnapshotCoord} (byte-stable nested JSON). */
const SNAPSHOT_FIELD_ORDER = ["gitHead", "treeDigest"];
/** Re-emit a nested object in a fixed key order (deterministic JSON). */
function reorder(obj, order) {
    const out = {};
    for (const key of order)
        out[key] = obj[key];
    return out;
}
/** POSIX-normalize a path (backslashes → forward slashes) so a Windows-captured entry is stable. */
function toPosix(p) {
    return p.replace(/\\/g, "/");
}
/**
 * Canonical JSON of one computable ground, byte-stable regardless of object-key insertion order
 * or `entries[]` capture order. Each variant re-emits its fields in a FIXED order; a digest-
 * manifest's `entries` are POSIX-normalized + lexically sorted by `path` (the determinism axis);
 * `undefined` optionals are omitted (omit-when-absent so a digest-only ground is byte-identical).
 */
function serializeGroundingGround(ground) {
    switch (ground.groundKind) {
        case "digest-manifest": {
            const ordered = {
                groundKind: ground.groundKind,
                manifestDigest: ground.manifestDigest,
            };
            if (ground.entries !== undefined) {
                ordered.entries = [...ground.entries]
                    .map((e) => ({ path: toPosix(e.path), digest: e.digest }))
                    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
            }
            return JSON.stringify(ordered);
        }
        case "version-pin": {
            return JSON.stringify({ groundKind: ground.groundKind, pkg: ground.pkg, version: ground.version });
        }
        case "visual-hash": {
            const ordered = {
                groundKind: ground.groundKind,
                perceptualHash: ground.perceptualHash,
            };
            if (ground.renderer !== undefined)
                ordered.renderer = ground.renderer;
            return JSON.stringify(ordered);
        }
    }
}
/** Content digest of a computable ground = SHA-256 of its canonical serialization. */
function groundingGroundDigest(ground) {
    return (0, hash_1.hashContent)(serializeGroundingGround(ground));
}
/** Canonical key order for one {@link ConformanceMetric} (byte-stable nested JSON). */
const CONFORMANCE_FIELD_ORDER = ["metric", "observed", "status"];
/** Re-emit the conformance metrics in a deterministic order (sorted by `metric`, fixed key order). */
function serializeConformance(conformance) {
    return [...conformance]
        .sort((a, b) => (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0))
        .map((m) => reorder(m, CONFORMANCE_FIELD_ORDER));
}
// ---------------------------------------------------------------------------
// GroundingReceipt — canonical text + hashing (mirrors assertion-presence.ts)
// ---------------------------------------------------------------------------
/**
 * The fixed canonical field order for hashing/signing a {@link GroundingReceipt}. `signature`
 * and `recordHash` are EXCLUDED trailers (computed over the IDENTICAL canonical input, so a
 * Slice-B signature covers every signed field). `undefined` keys are dropped (so an in-process
 * receipt with all the honesty/signing optionals absent is byte-stable); the `ground` re-emits
 * via {@link serializeGroundingGround}'s element ordering, the `conformance` via the sorted
 * fixed-key order, and the snapshot in its fixed key order.
 */
const GROUNDING_CANONICAL_FIELD_ORDER = [
    "kind",
    "refId",
    "workClass",
    "ground",
    "conformance",
    "snapshot_coord",
    "producer_identity",
    "fidelityTier",
    "diffBand",
    "legacy",
    "producer_kind",
    "key_id",
    "prevHash",
];
/**
 * Deterministic canonical text of a grounding receipt for hashing/signing. Field order is fixed;
 * `undefined` keys, `recordHash`, and `signature` are dropped; the `ground` is re-emitted via the
 * deterministic ground serializer, the `conformance` via its sorted fixed-key serializer, and the
 * snapshot in its fixed key order; `JSON.stringify` with no indentation. `hashContent` then
 * CRLF→LF normalizes (harmless). A receipt with every optional absent produces byte-identical text.
 */
function groundingCanonicalText(receipt) {
    const ordered = {};
    for (const key of GROUNDING_CANONICAL_FIELD_ORDER) {
        const val = receipt[key];
        if (val === undefined)
            continue;
        if (key === "ground") {
            // Re-emit the ground deterministically by round-tripping through the canonical serializer.
            ordered[key] = JSON.parse(serializeGroundingGround(val));
        }
        else if (key === "conformance") {
            ordered[key] = serializeConformance(val);
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
/** `recordHash` for a grounding receipt = SHA-256 of its canonical text (signature excluded). */
function computeGroundingRecordHash(receipt) {
    return (0, hash_1.hashContent)(groundingCanonicalText(receipt));
}
// ---------------------------------------------------------------------------
// Store paths (in-process + external + the three sibling external-signed stores)
// ---------------------------------------------------------------------------
/** `<stateDir>/grounding-receipts.jsonl` — the in-process grounding ledger. */
function groundingReceiptsPath(paths) {
    return path.join(paths.stateDir, "grounding-receipts.jsonl");
}
/**
 * `<stateDir>/external-grounding-receipts.jsonl` — the EXTERNAL keyed producer's store (Slice B).
 * A SEPARATE file for LOCK-ISOLATION (parallel to `external-mutation-receipts.jsonl`): the
 * out-of-process producer appends here without taking the in-process `withStateLock` span. The
 * SECURITY boundary is NOT this path — it is the private key; a forged line is rejected by the
 * gate validator (no verifying signature ⇒ `ungrounded`, never trusted).
 */
function externalGroundingReceiptsPath(paths) {
    return path.join(paths.stateDir, "external-grounding-receipts.jsonl");
}
/** `<stateDir>/grounding-budgets.jsonl` — the EXTERNAL-signed conformance-budget store (PCC-4). */
function groundingBudgetsPath(paths) {
    return path.join(paths.stateDir, "grounding-budgets.jsonl");
}
/** `<stateDir>/grounding-exceptions.jsonl` — the EXTERNAL-signed SignedException store (PCC-4). */
function groundingExceptionsPath(paths) {
    return path.join(paths.stateDir, "grounding-exceptions.jsonl");
}
/** `<stateDir>/grounding-carveouts.jsonl` — the EXTERNAL-signed permitted-difference store (PCC-4). */
function groundingCarveoutsPath(paths) {
    return path.join(paths.stateDir, "grounding-carveouts.jsonl");
}
// ---------------------------------------------------------------------------
// GroundingReceipt — shape validation + tolerant readers
// ---------------------------------------------------------------------------
/** Tolerant shape check for a parsed computable ground (each variant's required fields). */
function isValidGround(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const g = parsed;
    switch (g.groundKind) {
        case "digest-manifest": {
            if (typeof g.manifestDigest !== "string" || g.manifestDigest === "")
                return false;
            if (g.entries !== undefined) {
                if (!Array.isArray(g.entries))
                    return false;
                for (const e of g.entries) {
                    if (typeof e !== "object" || e === null)
                        return false;
                    const em = e;
                    if (typeof em.path !== "string" || typeof em.digest !== "string")
                        return false;
                }
            }
            return true;
        }
        case "version-pin":
            return typeof g.pkg === "string" && g.pkg !== "" && typeof g.version === "string" && g.version !== "";
        case "visual-hash":
            return (typeof g.perceptualHash === "string" &&
                g.perceptualHash !== "" &&
                (g.renderer === undefined || typeof g.renderer === "string"));
        default:
            return false;
    }
}
/** Tolerant shape check for one parsed conformance metric. */
function isValidConformanceMetric(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const m = parsed;
    if (m.metric !== "version" && m.metric !== "api" && m.metric !== "visual" && m.metric !== "a11y")
        return false;
    if (!(typeof m.observed === "string" || typeof m.observed === "number"))
        return false;
    if (m.status !== "within-budget" && m.status !== "over-budget" && m.status !== "unobserved")
        return false;
    return true;
}
/** Validate the shape of a parsed grounding line; malformed/cross-shaped lines are skipped (tolerant). */
function isValidGroundingReceipt(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const r = parsed;
    if (r.kind !== "grounding")
        return false;
    if (typeof r.refId !== "string" || r.refId === "")
        return false;
    if (typeof r.workClass !== "string" || r.workClass === "")
        return false;
    if (typeof r.producer_identity !== "string")
        return false;
    if (typeof r.prevHash !== "string" || !hash_1.HEX64.test(r.prevHash))
        return false;
    if (typeof r.recordHash !== "string" || !hash_1.HEX64.test(r.recordHash))
        return false;
    if (!isValidGround(r.ground))
        return false;
    if (!Array.isArray(r.conformance) || !r.conformance.every(isValidConformanceMetric))
        return false;
    // Optional honesty fields — present ⇒ well-shaped, absent ⇒ byte-stable. (The evidence-spine
    // `manifest_digest` thread lives on the BSC-1/3/7 receipts, NOT here — a GroundingReceipt carries
    // its digest inside `ground` via DigestManifestGround.manifestDigest.)
    if (r.fidelityTier !== undefined && typeof r.fidelityTier !== "string")
        return false;
    if (r.diffBand !== undefined && typeof r.diffBand !== "string")
        return false;
    if (r.legacy !== undefined && typeof r.legacy !== "boolean")
        return false;
    // Optional signing trailer (Slice-B). A present-but-malformed field tolerant-skips the line.
    if (r.producer_kind !== undefined && r.producer_kind !== "external" && r.producer_kind !== "in-process")
        return false;
    if (r.key_id !== undefined && typeof r.key_id !== "string")
        return false;
    if (r.signature !== undefined && (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))) {
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
 * Read + parse every grounding receipt in the in-process store, in file order. Missing file →
 * `[]`. Bad lines are silently skipped — tolerant, never throws. Chain breaks surface via
 * {@link verifyGroundingChain}.
 */
function readGroundingReceipts(paths) {
    return (0, jsonl_1.readJsonlValues)(groundingReceiptsPath(paths), isValidGroundingReceipt);
}
/**
 * Read + parse every grounding receipt in the EXTERNAL store, in file order. Missing file → `[]`.
 * Bad lines skipped — tolerant, never throws. The signature is verified at gate time, NOT here.
 */
function readExternalGroundingReceipts(paths) {
    return (0, jsonl_1.readJsonlValues)(externalGroundingReceiptsPath(paths), isValidGroundingReceipt);
}
/**
 * The `recordHash` of the in-process store's last VALID grounding receipt — the `prevHash` seed
 * {@link appendGroundingReceipt} needs to seal the next link. Tail-scans the file so N appends
 * stay O(N) total. Missing/empty/no-valid-tail → `GENESIS_PREV_HASH`.
 */
function readLastGroundingRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(groundingReceiptsPath(paths), isValidGroundingReceipt);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * The `recordHash` of the EXTERNAL store's last valid grounding receipt — the `prevHash` seed for
 * the Slice-B producer's own append-only chain. Missing/empty/no-valid-tail → `GENESIS_PREV_HASH`.
 */
function readLastExternalGroundingRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(externalGroundingReceiptsPath(paths), isValidGroundingReceipt);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * Walk grounding receipts in file order with a running `expectedPrev = GENESIS`. For each:
 * recompute `recordHash` from its canonical text — a mismatch means the record was edited; if
 * `prevHash !== expectedPrev` the line was inserted/deleted/reordered. Return
 * `{ ok:false, brokenAt:N }` at the FIRST break; else advance. Byte-identical posture to
 * `verifyAssertionPresenceChain`.
 */
function verifyGroundingChain(receipts) {
    let expectedPrev = hash_1.GENESIS_PREV_HASH;
    for (let i = 0; i < receipts.length; i++) {
        const r = receipts[i];
        const { recordHash, signature: _sig, ...rest } = r;
        const recomputed = computeGroundingRecordHash(rest);
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
 * Append one in-process grounding receipt, sealing the hash chain. The caller MUST already hold
 * the `withStateLock` span (read-modify-append is serialized there), exactly like
 * `appendAssertionPresenceReceipt`. The receipt records the supplied ground + conformance + the
 * current snapshot coordinate, derives `prevHash` from the tail, computes `recordHash`, asserts
 * the write-surface, and atomically appends. In-process-only (no signing fields). Returns the
 * sealed receipt.
 */
function appendGroundingReceipt(paths, input) {
    const receipt = {
        kind: "grounding",
        refId: groundingRefId(paths),
        workClass: input.workClass,
        ground: input.ground,
        conformance: input.conformance ?? [],
        snapshot_coord: (0, receipts_1.currentReceiptSnapshotCoord)(paths),
        producer_identity: input.producerIdentity,
        ...(input.fidelityTier !== undefined ? { fidelityTier: input.fidelityTier } : {}),
        ...(input.diffBand !== undefined ? { diffBand: input.diffBand } : {}),
    };
    (0, paths_1.assertGovernedWriteSurface)(paths.root, groundingReceiptsPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const prevHash = readLastGroundingRecordHash(paths);
    const withPrev = { ...receipt, prevHash };
    const recordHash = computeGroundingRecordHash(withPrev);
    const sealed = { ...withPrev, recordHash };
    fs.appendFileSync(groundingReceiptsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
    return sealed;
}
/**
 * The run identity a fresh receipt grounds: the current `gitHead`, or `"no-git"` on a non-git
 * checkout — so a re-run at a new HEAD mints a receipt under a new refId and the gate finds the
 * LATEST receipt for the current snapshot (mirrors `assertionRefId`).
 */
function groundingRefId(paths) {
    return (0, receipts_1.currentReceiptSnapshotCoord)(paths).gitHead ?? "no-git";
}
/**
 * Compare a recorded coordinate against the current one under the F8 rule: a coordinate
 * discriminates ONLY when BOTH the recorded and the current value are non-null.
 */
function snapshotStaleReasons(recorded, current) {
    const reasons = [];
    if (recorded.gitHead !== null && current.gitHead !== null && recorded.gitHead !== current.gitHead) {
        reasons.push("gitHead");
    }
    if (recorded.treeDigest !== null && current.treeDigest !== null && recorded.treeDigest !== current.treeDigest) {
        reasons.push("treeDigest");
    }
    return reasons;
}
/**
 * Classify a grounding receipt's CONTENT (tolerant — never throws). The conformance verdict is
 * fail-closed: ANY `unobserved` metric ⇒ `unobserved` (the highest-precedence soft-fail, so a
 * stubbed visual/a11y measurement blocks under forced enforce); else ANY `over-budget` metric ⇒
 * `over-budget`; else a diverged snapshot ⇒ `stale`; else `valid`. The unobserved/over-budget
 * metric names ride on the result for the gate's diagnostics.
 */
function validateGroundingContent(paths, receipt) {
    const unobservedMetrics = receipt.conformance
        .filter((m) => m.status === "unobserved")
        .map((m) => m.metric)
        .sort();
    const overBudgetMetrics = receipt.conformance
        .filter((m) => m.status === "over-budget")
        .map((m) => m.metric)
        .sort();
    if (unobservedMetrics.length > 0)
        return { status: "unobserved", unobservedMetrics };
    if (overBudgetMetrics.length > 0)
        return { status: "over-budget", overBudgetMetrics };
    // Stale dimension (F8 honesty): a recorded coordinate is NON-DISCRIMINATING unless it actually
    // carries a value. A receipt with NO meaningful coordinate — `snapshot_coord` null/undefined, OR
    // a `{ gitHead: null, treeDigest: null }` object — has nothing to be stale AGAINST, so it must
    // not be spuriously flagged stale (and must not crash). Guard the whole branch so we ONLY call
    // `currentReceiptSnapshotCoord` (which throws on a path-less `paths`/empty coord) when at least
    // one recorded field is present. Loose `== null` covers both null and undefined fields. A
    // no-coord receipt ⇒ the stale dimension is satisfied (treated `valid`), exactly the documented
    // "snapshot_coord null ⇒ no stale" semantics.
    const recorded = receipt.snapshot_coord;
    const hasRecordedCoord = recorded != null && (recorded.gitHead != null || recorded.treeDigest != null);
    if (hasRecordedCoord) {
        const staleReasons = snapshotStaleReasons(recorded, (0, receipts_1.currentReceiptSnapshotCoord)(paths));
        if (staleReasons.length > 0)
            return { status: "stale", staleReasons };
    }
    return { status: "valid" };
}
/** Verify a grounding receipt's Ed25519 signature against the loaded external public key. */
function groundingSignatureVerifies(receipt, publicKey) {
    if (typeof receipt.signature !== "string")
        return false;
    if (receipt.key_id !== (0, receipt_signing_1.externalKeyId)(publicKey))
        return false;
    const { recordHash: _rh, signature, ...signedView } = receipt;
    return (0, receipt_signing_1.verifyCanonical)(groundingCanonicalText(signedView), signature, publicKey);
}
/**
 * Read + validate BOTH grounding stores and resolve, per ground-kind, the LATEST trusted
 * candidate (recompute-don't-trust posture). BOTH chains are walked once and BOTH fail closed:
 * a tampered IN-PROCESS chain trusts NOTHING from the in-process store (`inProcessChainOk:false`),
 * and a tampered EXTERNAL chain trusts NOTHING from the external store (`externalChainOk:false`).
 * For each kind, a signature-verified EXTERNAL receipt (`valid-grounded`) supersedes an in-process
 * one (`valid`); an external receipt that does NOT verify is simply ignored (ungrounded — absence ≠
 * forgery).
 *
 * EXTERNAL CHAIN INTEGRITY (Slice B — asymmetry CLOSED): the external store's hash chain is now
 * walked here with {@link verifyGroundingChain} (same prevHash-link + recordHash-recompute walk as
 * the in-process M-1 path). Each external line is ALSO verified independently by its own Ed25519
 * signature, BUT signature-validity alone does not establish CHAIN position: `prevHash` is inside
 * the signed canonical input, yet a party with file-write (but not the key) could otherwise REORDER
 * or DUPLICATE validly-signed lines to resurface a STALE signed grounding as the "latest per kind."
 * The chain walk closes that: a reorder/duplicate/edit breaks the `prevHash → prior recordHash`
 * linkage ⇒ `externalChainOk:false` ⇒ the external store is dropped wholesale (fail-closed,
 * symmetric with the in-process M-1 posture). A SINGLE validly-signed line is a trivial chain
 * (genesis `prevHash` + its own `recordHash`) and verifies. The COMPLEMENTARY cross-receipt
 * `manifest_digest` mismatch (a threaded BSC-1/3/7 digest disagreeing with the grounding manifest)
 * is enforced separately by the gate's `chain_mismatch` reason ({@link evaluateGrounding}).
 */
function readGroundingValidated(paths) {
    const inProcess = readGroundingReceipts(paths);
    const inProcessChainOk = verifyGroundingChain(inProcess).ok;
    // External chain integrity (Slice B): walk the external store's hash chain BEFORE trusting any of
    // its lines. A broken/reordered/duplicated chain ⇒ trust NOTHING from the external store (fail-
    // closed, mirroring the in-process M-1 posture). An empty/missing store verifies (`{ok:true}`).
    const external = readExternalGroundingReceipts(paths);
    const externalChainOk = verifyGroundingChain(external).ok;
    const byKind = new Map();
    // In-process candidates (attribution-only `valid`), only when the chain is intact.
    if (inProcessChainOk) {
        for (const r of inProcess) {
            byKind.set(r.ground.groundKind, { receipt: r, trustLabel: "valid" });
        }
    }
    // External candidates supersede when the external chain is intact AND their signature verifies
    // (independently grounded). A tampered external chain drops the whole store — a forged file-write
    // reorder/dup of validly-signed lines can no longer resurface a stale grounding.
    const publicKey = (0, receipt_signing_1.loadExternalPublicKey)();
    if (externalChainOk && publicKey !== null) {
        for (const r of external) {
            if (r.producer_kind !== "external")
                continue;
            if (!groundingSignatureVerifies(r, publicKey))
                continue; // unverifiable ⇒ ungrounded, ignore
            byKind.set(r.ground.groundKind, { receipt: r, trustLabel: "valid-grounded" });
        }
    }
    return { byKind, inProcessChainOk, externalChainOk };
}
/** Shared tolerant shape check for the snapshot coordinate + the external signing trailer. */
function hasValidExternalTrailer(r) {
    if (r.producer_kind !== "external")
        return false;
    if (typeof r.key_id !== "string" || r.key_id === "")
        return false;
    if (r.signature !== undefined && (typeof r.signature !== "string" || !ED25519_SIGNATURE_BASE64.test(r.signature))) {
        return false;
    }
    if (typeof r.prevHash !== "string" || !hash_1.HEX64.test(r.prevHash))
        return false;
    if (typeof r.recordHash !== "string" || !hash_1.HEX64.test(r.recordHash))
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
/** True iff `g` is one of the three ground-kind literals (shared sibling-store guard). */
function isGroundKindValue(g) {
    return g === "digest-manifest" || g === "version-pin" || g === "visual-hash";
}
/** Tolerant shape check for a budget line (a malformed line is skipped, never trusted). */
function isValidGroundingBudget(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const r = parsed;
    if (r.kind !== "grounding-budget")
        return false;
    if (typeof r.workClass !== "string" || r.workClass === "")
        return false;
    if (!isGroundKindValue(r.groundKind))
        return false;
    if (r.metric !== "version" && r.metric !== "api" && r.metric !== "visual" && r.metric !== "a11y")
        return false;
    if (typeof r.threshold !== "number" || !Number.isFinite(r.threshold))
        return false;
    return hasValidExternalTrailer(r);
}
/** Tolerant shape check for an exception line. */
function isValidGroundingException(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const r = parsed;
    if (r.kind !== "grounding-exception")
        return false;
    if (typeof r.workClass !== "string" || r.workClass === "")
        return false;
    if (!isGroundKindValue(r.groundKind))
        return false;
    if (typeof r.reason !== "string")
        return false;
    return hasValidExternalTrailer(r);
}
/** Tolerant shape check for a carve-out line. */
function isValidGroundingCarveout(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const r = parsed;
    if (r.kind !== "grounding-carveout")
        return false;
    if (typeof r.workClass !== "string" || r.workClass === "")
        return false;
    if (typeof r.regionDigest !== "string" || !hash_1.HEX64.test(r.regionDigest))
        return false;
    if (typeof r.reason !== "string")
        return false;
    return hasValidExternalTrailer(r);
}
/**
 * Read every (well-shaped) budget line, file order. Signatures are verified at gate time, NOT
 * here — this reader is shape-only, so an UNSIGNED/wrong-key line is RETURNED and then exempts
 * NOTHING downstream (fail-closed M4). Missing file → `[]`; never throws.
 */
function readGroundingBudgets(paths) {
    return (0, jsonl_1.readJsonlValues)(groundingBudgetsPath(paths), isValidGroundingBudget);
}
/** Read every (well-shaped) exception line, file order. Signatures verified at gate time, NOT here. */
function readGroundingExceptions(paths) {
    return (0, jsonl_1.readJsonlValues)(groundingExceptionsPath(paths), isValidGroundingException);
}
/** Read every (well-shaped) carve-out line, file order. Signatures verified at gate time, NOT here. */
function readGroundingCarveouts(paths) {
    return (0, jsonl_1.readJsonlValues)(groundingCarveoutsPath(paths), isValidGroundingCarveout);
}
// ---------------------------------------------------------------------------
// Sibling-store canonical text + chain walk + signature verify (Slice B / M4)
// ---------------------------------------------------------------------------
//
// The Slice-B Ed25519 producer signs each sibling line over its CANONICAL TEXT (the ONE formula
// the producer at sign time and the gate at validation time both use, so they can never diverge on
// the binding). `signature` + `recordHash` are EXCLUDED trailers — the signature covers every other
// field including `prevHash`. The verify path is VERIFY-ONLY (the in-process surface holds no
// private key — `receipt-signing.ts` exports no signer), exactly like `validWaivedReqs` /
// approvals / scan-exceptions: an UNSIGNED / wrong-key / chain-tampered line exempts NOTHING (M4).
/** Canonical field order for a {@link GroundingBudget} (signature + recordHash excluded — trailers). */
const GROUNDING_BUDGET_CANONICAL_FIELD_ORDER = [
    "kind",
    "workClass",
    "groundKind",
    "metric",
    "threshold",
    "snapshot_coord",
    "producer_kind",
    "key_id",
    "prevHash",
];
/** Canonical field order for a {@link GroundingException} (signature + recordHash excluded). */
const GROUNDING_EXCEPTION_CANONICAL_FIELD_ORDER = [
    "kind",
    "workClass",
    "groundKind",
    "reason",
    "snapshot_coord",
    "producer_kind",
    "key_id",
    "prevHash",
];
/** Canonical field order for a {@link GroundingCarveout} (signature + recordHash excluded). */
const GROUNDING_CARVEOUT_CANONICAL_FIELD_ORDER = [
    "kind",
    "workClass",
    "regionDigest",
    "reason",
    "snapshot_coord",
    "producer_kind",
    "key_id",
    "prevHash",
];
/**
 * Deterministic canonical text of one sibling-store line: emit `order`'s fields in sequence, the
 * nested `snapshot_coord` re-emitted in its fixed key order, `undefined`/`signature`/`recordHash`
 * dropped; `JSON.stringify` with no indentation. `hashContent` then CRLF→LF normalizes (harmless).
 * The SINGLE formula both the producer (sign) and the gate (verify) use. `order` MUST exclude the
 * `signature`/`recordHash` trailers (the three FIELD_ORDER constants already do).
 */
function siblingCanonicalText(line, order) {
    const ordered = {};
    for (const key of order) {
        const val = line[key];
        if (val === undefined)
            continue;
        if (key === "snapshot_coord") {
            ordered[key] = reorder(val, SNAPSHOT_FIELD_ORDER);
        }
        else {
            ordered[key] = val;
        }
    }
    return JSON.stringify(ordered);
}
/** Canonical text of a budget (signature + recordHash excluded). */
function groundingBudgetCanonicalText(budget) {
    return siblingCanonicalText(budget, GROUNDING_BUDGET_CANONICAL_FIELD_ORDER);
}
/** Canonical text of an exception (signature + recordHash excluded). */
function groundingExceptionCanonicalText(exception) {
    return siblingCanonicalText(exception, GROUNDING_EXCEPTION_CANONICAL_FIELD_ORDER);
}
/** Canonical text of a carve-out (signature + recordHash excluded). */
function groundingCarveoutCanonicalText(carveout) {
    return siblingCanonicalText(carveout, GROUNDING_CARVEOUT_CANONICAL_FIELD_ORDER);
}
/**
 * Walk a sibling store in file order with a running `expectedPrev = GENESIS`. Recompute each
 * line's `recordHash` from its canonical text (mismatch ⇒ edited) and assert `prevHash` links to
 * the prior `recordHash` (mismatch ⇒ inserted/deleted/reordered). Return `{ ok:false, brokenAt:N }`
 * at the FIRST break; else `{ ok:true }`. Byte-identical posture to `verifyAssertionWaiverChain` —
 * a tampered sibling store exempts NOTHING (fail-closed).
 */
function verifySiblingChain(lines, canonical) {
    let expectedPrev = hash_1.GENESIS_PREV_HASH;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const recomputed = (0, hash_1.hashContent)(canonical(line));
        if (recomputed !== line.recordHash)
            return { ok: false, brokenAt: i, reason: "edited" };
        if (line.prevHash !== expectedPrev)
            return { ok: false, brokenAt: i, reason: "prev_mismatch" };
        expectedPrev = line.recordHash;
    }
    return { ok: true };
}
/** Verify a sibling line's Ed25519 signature against the loaded external public key (verify-only). */
function siblingSignatureVerifies(line, publicKey, canonical) {
    const signature = line.signature;
    if (typeof signature !== "string")
        return false;
    if (line.key_id !== (0, receipt_signing_1.externalKeyId)(publicKey))
        return false;
    return (0, receipt_signing_1.verifyCanonical)(canonical(line), signature, publicKey);
}
/**
 * The set of validly-exempted grounding axes for the current run (the gate subtracts these from the
 * over-budget offender set — the I5 SignedException path). A `GroundingException` exempts its
 * `(workClass, groundKind)` ONLY when ALL of (mirroring `validWaivedReqs` symbol-for-symbol):
 *   1. The exception store's chain verifies (a tampered chain exempts NOTHING — fail-closed).
 *   2. An external public key is loaded AND the line's Ed25519 signature verifies under it with a
 *      matching `key_id` (an UNSIGNED / wrong-key / self-signed line exempts NOTHING — the in-
 *      process surface holds no private key, M4 3-party authority).
 *
 * With NO key loaded (the default fork/local/test path) NO exception verifies, so the set is empty
 * and the gate enforces fully. The result is keyed `"${workClass}::${groundKind}"` so the gate
 * can test membership by scope without ambiguity (the `::` separator + the fixed matrix's space-
 * free class labels and kind literals make a key collision impossible).
 */
function validGroundingExemptions(paths) {
    const exempt = new Map();
    const exceptions = readGroundingExceptions(paths);
    if (exceptions.length === 0)
        return exempt;
    // Fail-closed: a tampered chain exempts NOTHING (no line from a tampered store is trusted).
    if (!verifySiblingChain(exceptions, groundingExceptionCanonicalText).ok)
        return exempt;
    const publicKey = (0, receipt_signing_1.loadExternalPublicKey)();
    if (publicKey === null)
        return exempt; // no key ⇒ nothing verifies ⇒ exempt NOTHING
    for (const ex of exceptions) {
        if (!siblingSignatureVerifies(ex, publicKey, groundingExceptionCanonicalText))
            continue;
        exempt.set(groundingExemptionKey(ex.workClass, ex.groundKind), {
            workClass: ex.workClass,
            groundKind: ex.groundKind,
            reason: ex.reason,
        });
    }
    return exempt;
}
/** The scope key for a `(workClass, groundKind)` exemption (`::`-separated, collision-free). */
function groundingExemptionKey(workClass, groundKind) {
    return `${workClass}::${groundKind}`;
}
/**
 * The set of validly-signed conformance BUDGETS for the current run, keyed
 * `"${workClass}::${groundKind}::${metric}"`. A budget counts ONLY when the budget store's
 * chain verifies AND the line's Ed25519 signature verifies under the loaded external key (3-party
 * authority, E4: an agent cannot self-issue a passing budget — the security boundary is the private
 * key). An UNSIGNED / wrong-key / tampered budget is INERT (M4). With no key loaded the set is empty.
 * Exposed so the gate (and the producer-authority test E4) can confirm a threshold was externally
 * authorized rather than agent-asserted.
 */
function validGroundingBudgets(paths) {
    const valid = new Map();
    const budgets = readGroundingBudgets(paths);
    if (budgets.length === 0)
        return valid;
    if (!verifySiblingChain(budgets, groundingBudgetCanonicalText).ok)
        return valid;
    const publicKey = (0, receipt_signing_1.loadExternalPublicKey)();
    if (publicKey === null)
        return valid;
    for (const b of budgets) {
        if (!siblingSignatureVerifies(b, publicKey, groundingBudgetCanonicalText))
            continue;
        valid.set(`${b.workClass}::${b.groundKind}::${b.metric}`, b);
    }
    return valid;
}
/**
 * The set of validly-signed permitted-difference CARVE-OUTs for the current run, keyed by
 * `regionDigest`. A carve-out counts ONLY when the carve-out store's chain verifies AND the line's
 * Ed25519 signature verifies under the loaded external key. An UNSIGNED / wrong-key / tampered
 * carve-out masks NOTHING (M4). The perceptual-region masking it authorizes is consumed by the
 * Slice-C visual measurement; exposed here so the verify path is symmetric across all three stores.
 */
function validGroundingCarveouts(paths) {
    const valid = new Map();
    const carveouts = readGroundingCarveouts(paths);
    if (carveouts.length === 0)
        return valid;
    if (!verifySiblingChain(carveouts, groundingCarveoutCanonicalText).ok)
        return valid;
    const publicKey = (0, receipt_signing_1.loadExternalPublicKey)();
    if (publicKey === null)
        return valid;
    for (const c of carveouts) {
        if (!siblingSignatureVerifies(c, publicKey, groundingCarveoutCanonicalText))
            continue;
        valid.set(c.regionDigest, c);
    }
    return valid;
}
// ---------------------------------------------------------------------------
// Tolerance-kind threshold comparison (C4c — observed-vs-SIGNED-budget, Slice C)
// ---------------------------------------------------------------------------
//
// The deferred MED-1 the deterministic-kind enforce-flip (Slice B) left open: for the RUNNER-
// SENSITIVE TOLERANCE kinds (`visual-hash`, carrying the `visual` perceptual-diff + `a11y` scan-
// count conformance metrics) the over-budget verdict in `groundingConformanceOf` comes from the
// receipt's OWN signed `conformance[].status` — the signed budget THRESHOLD is verified for
// AUTHENTICITY (3-party authority, E4) but NEVER compared against the metric's `observed` value.
// That makes the budget INERT: a producer that signs a generous `status:"within-budget"` over an
// observed value that EXCEEDS the separately-signed threshold would pass. C4c closes that with an
// INDEPENDENT gate-side arithmetic comparison: `observed > signed_threshold ⇒ over-budget`,
// computed HERE (the gate), not trusted from the receipt's self-reported `status`.
//
// This is DETERMINISTIC arithmetic only — the `observed` value comes from the externally-signed
// receipt and the `threshold` from the externally-signed budget store; NO renderer/axe runs here
// (that toolchain stays in the producer/CI). Fail-closed: an `unobserved` observed value under
// enforce, or a required tolerance metric with NO matching signed budget under enforce, is a hard
// FAIL (never a silent pass). The `version`/`api` metrics on the DETERMINISTIC kinds are NOT
// re-compared here — they are binary exact-equality the signed receipt status fully decides (the
// Slice-B posture is unchanged for them).
/** The conformance metrics that are TOLERANCE-based (a numeric `observed ≤ threshold` band). */
const TOLERANCE_METRICS = new Set(["visual", "a11y"]);
/**
 * The independent tolerance-threshold verdict for a `visual-hash` grounding receipt (C4c). For each
 * TOLERANCE conformance metric (`visual` / `a11y`) on the receipt, look up the validly-signed
 * budget for `(receipt.workClass, "visual-hash", metric)` and compute `observed ≤ threshold` with
 * the gate's OWN arithmetic (recompute-don't-trust — the receipt's self-reported `status` is NOT
 * consulted here). `validBudgets` is the caller-resolved `validGroundingBudgets(paths)` map (passed
 * in so the gate resolves it ONCE per run, not per receipt). A non-`visual-hash` ground ⇒ `[]`
 * (deterministic kinds are not tolerance-gated). A `visual-hash` ground with NO tolerance metric on
 * its conformance list ⇒ `[]` (the caller's required/missing logic owns that case).
 *
 * Fail-closed precedence within a metric: `unobserved` (the stub) and `unpinned` (no signed
 * tolerance) are BOTH soft-fails the gate blocks under enforce; a numeric `observed` over its
 * signed `threshold` is `over-budget`. Only a numeric `observed` at-or-under a SIGNED threshold is
 * `within-budget`. The verdicts are emitted in `metric` order for determinism.
 *
 * TRUST SCOPE (review-fix, sec HIGH): the THRESHOLD is externally-signed / 3-party
 * (`validGroundingBudgets`), but `observed` comes from the trusted receipt. For an EXTERNAL
 * (`valid-grounded`) visual-hash receipt `observed` is producer-measured (renderer/axe in CI) and
 * 3-party. For an IN-PROCESS (`valid`) receipt `observed` is AGENT-AUTHORED — so this recompute
 * defends against a lying `status` given an honest `observed`, NOT against a lying `observed`.
 * In-process tolerance conformance is therefore ATTRIBUTION-TRUST ONLY (mirrors realization.ts:47-52).
 * Requiring tolerance grounds to be external (`valid-grounded`) to count under enforce is the P4
 * `require-grounded` tightening, deferred uniformly with the other Axis-B rows.
 */
function toleranceThresholdVerdicts(receipt, validBudgets) {
    if (receipt.ground.groundKind !== "visual-hash")
        return [];
    const verdicts = [];
    for (const m of receipt.conformance) {
        if (!TOLERANCE_METRICS.has(m.metric))
            continue;
        if (m.observed === "unobserved" || typeof m.observed !== "number") {
            // The stubbed / non-numeric measurement — fail-closed (never a silent pass under enforce).
            verdicts.push({ metric: m.metric, observed: "unobserved", threshold: null, status: "unobserved" });
            continue;
        }
        const observed = m.observed;
        const budget = validBudgets.get(`${receipt.workClass}::visual-hash::${m.metric}`);
        if (budget === undefined) {
            // Observed but UNPINNED: no validly-signed tolerance for this axis ⇒ cannot be gated as
            // passing (fail-closed under enforce). The threshold is unknown, so `null`.
            verdicts.push({ metric: m.metric, observed, threshold: null, status: "unpinned" });
            continue;
        }
        verdicts.push({
            metric: m.metric,
            observed,
            threshold: budget.threshold,
            status: observed > budget.threshold ? "over-budget" : "within-budget",
        });
    }
    return verdicts.sort((a, b) => a.metric.localeCompare(b.metric));
}
