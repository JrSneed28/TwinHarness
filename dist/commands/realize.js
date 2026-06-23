"use strict";
/**
 * `th realize <REQ-ID> --artifact <path>` (Axis-B slice-5 / BSC-1) — mint the in-process
 * realization receipt the production-reality realization rung reads.
 *
 * Before this verb, a slice could be marked `done` while a REQ-ID it owns had NO bound,
 * reachable, digest-fresh source anchor (BSC-1). This is the missing REFERENT writer: the
 * caller supplies the source artifact a REQ-ID is realized in, and the receipt binds that
 * REQ-ID to a content digest of the artifact, hash-chained into
 * `<stateDir>/realization-receipts.jsonl`, under `withStateLock` (exactly like `th approve`
 * / `th driver record`).
 *
 * SEPARABILITY (the whole point — consensus §0.2): the CLAIM (`SliceState.status==="done"`)
 * and the REFERENT (this receipt) are authored by DISTINCT acts at DISTINCT times. `th
 * realize` does NOT set slice status — it only supplies/refreshes the referent for a REQ
 * whose slice was independently marked done. Co-authoring claim + referent would be
 * self-grounding (the rejected v2 ground).
 *
 * ZERO TRUST WEIGHT (consensus §2 driver 2): this is the IN-PROCESS producer — the agent
 * can mint it, so its trust label is `valid` NEVER `valid-grounded`. The signature-
 * provenance-independent property arrives only via the slice-1b external Ed25519 producer
 * (`scripts/th-receipt-producer.mjs --kind realization`). Even then the independence is
 * SIGNATURE-PROVENANCE only — the referent anchor is still agent-authored.
 *
 * Refuse-at-creation: the `--artifact` path MUST resolve in source (its digest is the
 * recomputable ground) — else `realization_referent_unresolved`. The core logic lives in
 * `src/core/realization.ts`; this is its governed CLI writer.
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
exports.runRealize = runRealize;
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const log_1 = require("../core/log");
const ledger_1 = require("../core/ledger");
const guards_1 = require("../core/guards");
const realization_1 = require("../core/realization");
/**
 * `th realize <REQ-ID> --artifact <path> [--identity <who>]` — mint an in-process
 * realization receipt binding the REQ-ID to a digest of the named source artifact.
 * Serialized under the state lock so the chain append is atomic (mirrors `th approve`).
 */
function runRealize(paths, opts = {}) {
    return (0, state_store_1.withStateLock)(paths, () => runRealizeLocked(paths, opts));
}
function runRealizeLocked(paths, opts) {
    const reqId = (opts.reqId ?? "").trim();
    if (reqId === "") {
        return (0, output_1.failure)({
            human: "Usage: th realize <REQ-ID> --artifact <path>. The REQ-ID positional is required.",
            data: { error: "realization_req_id_missing" },
        });
    }
    const artifact = (opts.artifact ?? "").trim();
    if (artifact === "") {
        return (0, output_1.failure)({
            human: `Usage: th realize ${reqId} --artifact <path>. The --artifact referent path is required.`,
            data: { error: "realization_artifact_missing" },
        });
    }
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: "state.json is invalid; fix it before recording a realization receipt.",
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    // Resolve the owning done-slice for the REQ-ID (audit breadcrumb on the receipt; the gate
    // recomputes ownership fresh, it does not trust this field). A REQ the join cannot place
    // under a done slice is still recordable here — the operator may be realizing ahead of the
    // gate's enumeration — so this is informational, not a refusal.
    const map = (0, realization_1.loadRepoMapForRealization)(paths);
    const owning = map === null
        ? undefined
        : (0, realization_1.ownedReqsForDoneSlices)(map, r.state).find((o) => o.reqId === reqId);
    const owningSlice = owning ? owning.owningSlices[0] ?? "" : "";
    let sealed;
    try {
        sealed = (0, realization_1.appendRealizationReceipt)(paths, {
            reqId,
            owningSlice,
            artifactPath: artifact,
            producerIdentity: opts.producerIdentity ?? "cli:th realize",
        });
    }
    catch (e) {
        if (e instanceof realization_1.ReferentUnresolvedError) {
            return (0, output_1.failure)({
                human: `Cannot record a realization receipt: artifact "${e.referent}" does not resolve in source. ` +
                    `Supply a source path that exists, then re-run.`,
                data: { error: e.code, referent: e.referent },
            });
        }
        throw e;
    }
    const rel = path.relative(paths.root, (0, realization_1.realizationReceiptsPath)(paths)).split(path.sep).join("/");
    // Audit trail (mirrors the driver/approval writers). Key the chain digest as
    // `realizationRecordHash` so it never collides with the ledger entry's own seal fields.
    (0, ledger_1.appendLedger)(paths, {
        event: "realize",
        reqId,
        owningSlice,
        referent: sealed.referent.path,
        realizationRecordHash: sealed.recordHash,
    });
    (0, log_1.structuredLog)({ cmd: "realize", reqId, referent: sealed.referent.path, realizationRecordHash: sealed.recordHash });
    return (0, output_1.success)({
        data: {
            file: rel,
            reqId,
            owningSlice,
            referent: sealed.referent,
            producer_kind: sealed.producer_kind ?? "in-process",
            recordHash: sealed.recordHash,
        },
        human: `Recorded an in-process realization receipt at ${rel} ` +
            `(${reqId} → ${sealed.referent.path}${owningSlice ? `, owning slice ${owningSlice}` : ""}). ` +
            `NOTE: this in-process record is ATTRIBUTION-ONLY (zero trust weight) — the agent can mint it; ` +
            `independent (signature-provenance) grounding requires the external-signed producer.`,
        receipts: [{ file: rel, hash: sealed.recordHash }],
    });
}
