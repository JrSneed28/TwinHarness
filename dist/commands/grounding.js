"use strict";
/**
 * `th grounding record` / `th grounding check` (Axis-B slice-A / BSC-10) — in-process
 * external-reference grounding producer and reader/validator.
 *
 * BSC-10 identified that external references (dependency versions, visual renderings,
 * API manifests) carried by a slice could silently drift or be unverified — a version pin
 * could be claimed without a digest binding, a UI assertion could be declared without a
 * perceptual hash, and the completion gate would not notice (BSC-10). These two verbs are
 * the missing in-process SENSOR surface:
 *
 *   `th grounding record`  — appends a GroundingReceipt to
 *     `<stateDir>/grounding-receipts.jsonl`, hash-chained, under `withStateLock` (exactly
 *     like `th driver record` / `th approve` / `th realize`). ATTRIBUTION-ONLY (zero trust
 *     weight) — the agent can mint it, so its trust label is `valid` NEVER `valid-grounded`;
 *     independent grounding arrives only with the Slice-B external Ed25519-signed producer.
 *
 *   `th grounding check`   — READ-ONLY validator: recomputes/validates the chain and prints
 *     a summary. Appends NOTHING. Leaves NO breadcrumb file. The write-surface snapshot must
 *     show zero delta for this verb (enforced by the MCP write-surface audit test).
 *
 * The core store and classifier live in `src/core/grounding.ts`; this is the governed CLI
 * writer/reader surface (mirroring the driver/realization/assertion-presence producer split).
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
exports.runGroundingRecord = runGroundingRecord;
exports.runGroundingCheck = runGroundingCheck;
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const log_1 = require("../core/log");
const ledger_1 = require("../core/ledger");
const guards_1 = require("../core/guards");
const grounding_1 = require("../core/grounding");
/**
 * `th grounding record --ground-kind <k> --work-class <c> [--identity <who>] [...]` — mint an
 * in-process grounding receipt and append it to the grounding receipts store. Serialized under
 * the state lock so the chain append is atomic (mirrors `th approve` / `th driver record`).
 */
function runGroundingRecord(paths, opts = {}) {
    return (0, state_store_1.withStateLock)(paths, () => runGroundingRecordLocked(paths, opts));
}
function runGroundingRecordLocked(paths, opts) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: "state.json is invalid; fix it before recording a grounding receipt.",
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const groundKind = (opts.groundKind ?? "").trim();
    if (groundKind === "") {
        return (0, output_1.failure)({
            human: "Usage: th grounding record --ground-kind <digest-manifest|version-pin|visual-hash> --work-class <c> [...].\n" +
                "The --ground-kind discriminant is required.",
            data: { error: "grounding_kind_missing" },
        });
    }
    const workClass = (opts.workClass ?? "").trim();
    if (workClass === "") {
        return (0, output_1.failure)({
            human: "Usage: th grounding record --ground-kind <k> --work-class <c> [...].\n" +
                "The --work-class field is required (drives the required-ground matrix).",
            data: { error: "grounding_work_class_missing" },
        });
    }
    // Build the discriminated GroundingGround union from the kind-specific CLI flags.
    // Each variant requires its own mandatory fields; missing required fields are surfaced
    // as a refuse-at-creation error (mirrors `th driver record` / `th realize`).
    let ground;
    switch (groundKind) {
        case "digest-manifest": {
            const manifestDigest = (opts.manifestDigest ?? "").trim();
            if (manifestDigest === "") {
                return (0, output_1.failure)({
                    human: "Usage: th grounding record --ground-kind digest-manifest --manifest-digest <d> --work-class <c>.\n" +
                        "--manifest-digest is required for ground kind 'digest-manifest'.",
                    data: { error: "grounding_manifest_digest_missing" },
                });
            }
            ground = { groundKind: "digest-manifest", manifestDigest };
            break;
        }
        case "version-pin": {
            const pkg = (opts.pkg ?? "").trim();
            const version = (opts.pinVersion ?? "").trim();
            if (pkg === "" || version === "") {
                return (0, output_1.failure)({
                    human: "Usage: th grounding record --ground-kind version-pin --pkg <p> --pin-version <v> --work-class <c>.\n" +
                        "--pkg and --pin-version are both required for ground kind 'version-pin'.",
                    data: { error: "grounding_version_pin_fields_missing" },
                });
            }
            ground = { groundKind: "version-pin", pkg, version };
            break;
        }
        case "visual-hash": {
            const perceptualHash = (opts.perceptualHash ?? "").trim();
            if (perceptualHash === "") {
                return (0, output_1.failure)({
                    human: "Usage: th grounding record --ground-kind visual-hash --perceptual-hash <h> --work-class <c>.\n" +
                        "--perceptual-hash is required for ground kind 'visual-hash'.",
                    data: { error: "grounding_perceptual_hash_missing" },
                });
            }
            const renderer = (opts.renderer ?? "").trim() || undefined;
            ground = { groundKind: "visual-hash", perceptualHash, ...(renderer ? { renderer } : {}) };
            break;
        }
        default:
            return (0, output_1.failure)({
                human: `Unknown --ground-kind value: "${groundKind}". ` +
                    `Must be one of: digest-manifest, version-pin, visual-hash.`,
                data: { error: "grounding_kind_unknown", groundKind },
            });
    }
    const sealed = (0, grounding_1.appendGroundingReceipt)(paths, {
        workClass,
        ground,
        producerIdentity: opts.producerIdentity ?? "cli:th grounding record",
    });
    const rel = path.relative(paths.root, (0, grounding_1.groundingReceiptsPath)(paths)).split(path.sep).join("/");
    // Audit trail (mirrors the driver/realization/assertion-presence writers): a grounding
    // receipt grounds the BSC-10 external-reference rung. Key the chain digest as
    // `groundingRecordHash` so it never collides with the ledger entry's own seal fields.
    (0, ledger_1.appendLedger)(paths, {
        event: "grounding-record",
        groundKind,
        workClass,
        groundingRecordHash: sealed.recordHash,
    });
    (0, log_1.structuredLog)({ cmd: "grounding record", groundKind, workClass, groundingRecordHash: sealed.recordHash });
    return (0, output_1.success)({
        data: {
            file: rel,
            groundKind,
            workClass,
            producer_kind: sealed.producer_kind ?? "in-process",
            recordHash: sealed.recordHash,
        },
        human: `Recorded an in-process grounding receipt at ${rel} ` +
            `(groundKind: ${groundKind}, workClass: ${workClass}). ` +
            `NOTE: this in-process record is ATTRIBUTION-ONLY (zero trust weight) — the agent can mint it; ` +
            `independent grounding requires the Slice-B external Ed25519-signed producer.`,
        receipts: [{ file: rel, hash: sealed.recordHash }],
    });
}
/**
 * `th grounding check` — READ-ONLY: recompute/validate the grounding chain and print a
 * summary. Appends NOTHING and leaves NO breadcrumb file. The write-surface snapshot must
 * show zero delta for this verb.
 */
function runGroundingCheck(paths, _opts = {}) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: "state.json is invalid; fix it before checking grounding receipts.",
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    // Pure read: verify raw chain integrity, then load the validated (trust-labelled) view.
    // readGroundingReceipts — raw JSONL parse (tolerant, never throws); used for chain walk.
    // readGroundingValidated — trust-labels each receipt (byKind Map); also pure read.
    // Neither call writes anything; no withStateLock needed.
    const rawReceipts = (0, grounding_1.readGroundingReceipts)(paths);
    const chainResult = (0, grounding_1.verifyGroundingChain)(rawReceipts);
    const validated = (0, grounding_1.readGroundingValidated)(paths);
    const total = rawReceipts.length;
    const chainOk = chainResult.ok;
    // Summarise the byKind Map into a stable array for the output payload.
    const byKindSummary = Array.from(validated.byKind.entries()).map(([groundKind, entry]) => ({
        groundKind,
        recordHash: entry.receipt.recordHash,
        trustLabel: entry.trustLabel,
        workClass: entry.receipt.workClass,
    }));
    (0, log_1.structuredLog)({
        cmd: "grounding check",
        total,
        chainOk,
        inProcessChainOk: validated.inProcessChainOk,
        byKindCount: validated.byKind.size,
    });
    return (0, output_1.success)({
        data: {
            total,
            chainOk,
            inProcessChainOk: validated.inProcessChainOk,
            ...(!chainOk
                ? { chainBrokenAt: chainResult.brokenAt,
                    chainBreakReason: chainResult.reason }
                : {}),
            byKind: byKindSummary,
        },
        human: `Grounding receipts: ${total} total; chain ${chainOk ? "OK" : "BROKEN"}` +
            (!chainOk
                ? ` (broken at index ${chainResult.brokenAt},` +
                    ` reason: ${chainResult.reason})`
                : "") +
            `; ${validated.byKind.size} trusted kind(s): ${byKindSummary.map((e) => e.groundKind).join(", ") || "(none)"}` +
            `. (Read-only — no state written.)`,
    });
}
