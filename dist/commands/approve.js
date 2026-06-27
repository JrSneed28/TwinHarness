"use strict";
/**
 * `th approve <stage>` (Axis-B slice-3a / BSC-7) — mint the in-process human-approval
 * receipt the `humanGate` precondition reads.
 *
 * Before this verb, `humanGate` was a declarative-only flag with ZERO predicate
 * consumers — pure gate theater. This is the missing producer: it records a per-stage
 * `HumanApprovalReceipt` bound to `{stage, snapshot_coord, governing_artifact_digest}`,
 * hash-chained into `<stateDir>/approval-receipts.jsonl`, under `withStateLock`.
 *
 * ZERO TRUST WEIGHT (consensus §3 S1): this is the IN-PROCESS producer — the agent can
 * mint it, so the record is attribution-only. Its validated status is `valid` NEVER
 * `valid-grounded`; the independently-grounded property arrives only in slice-3b (an
 * external Ed25519-keyed producer at a write-surface TwinHarness cannot reach). The
 * record LOOKS authoritative (signed-shape, hash-chained, snapshot-bound) but is NOT an
 * independence anchor — do not read `th approve` output as third-party authorization.
 *
 * Mechanical only (plan §3 boundary rule): the CLI RECORDS that an approval act
 * occurred at this tree state; it does not decide whether the human actually approved.
 * Refuse-at-creation mirrors the producer discipline: the stage must be a `humanGate`
 * stage AND its governing artifact (`produces`) must resolve in source, else no write.
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
exports.runApprove = runApprove;
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const log_1 = require("../core/log");
const ledger_1 = require("../core/ledger");
const guards_1 = require("../core/guards");
const stages_1 = require("../core/stages");
const approvals_1 = require("../core/approvals");
/**
 * `th approve [<stage>]` — mint an in-process approval for a `humanGate` stage (default =
 * the run's current stage). Serialized under the state lock so the chain append is atomic.
 */
function runApprove(paths, stage, opts = {}) {
    return (0, state_store_1.withStateLock)(paths, () => runApproveLocked(paths, stage, opts));
}
function runApproveLocked(paths, stageArg, opts) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: "state.json is invalid; fix it before approving a stage.",
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    // Default = the run's current stage when no positional is supplied.
    const raw = (stageArg ?? r.state.current_stage ?? "").trim();
    const stage = (0, stages_1.canonicalizeStage)(raw);
    if (stage === "") {
        return (0, output_1.failure)({
            human: "usage: th approve <stage>  (no stage given and the run has no current_stage to default to)",
            data: { error: "approval_stage_required" },
        });
    }
    // Refuse-at-creation BEFORE any write: not a humanGate stage → clear refusal (a
    // non-humanGate stage carries no approval gate, so an approval would be meaningless).
    const contract = (0, stages_1.stageContract)(stage);
    if (!contract || !contract.humanGate) {
        return (0, output_1.failure)({
            human: `Cannot approve "${stage}": it is not a humanGate stage. ` +
                `humanGate stages: requirements, scope, architecture, ux-design, ui-design, contracts, security, final-verification.`,
            data: { error: "approval_stage_not_human_gate", stage },
        });
    }
    let sealed;
    try {
        sealed = (0, approvals_1.appendApprovalReceipt)(paths, {
            stage,
            producerIdentity: opts.producerIdentity ?? "cli:th approve",
        });
    }
    catch (e) {
        if (e instanceof approvals_1.ApprovalUnmintableError) {
            return (0, output_1.failure)({
                human: e.code === "approval_artifact_unresolved"
                    ? `Refusing to approve "${stage}": its governing artifact "${e.artifact}" does not resolve in source. ` +
                        `Author and register the stage artifact first, then approve.`
                    : `Cannot approve "${stage}": ${e.message}`,
                data: { error: e.code, stage, ...(e.artifact ? { artifact: e.artifact } : {}) },
            });
        }
        throw e;
    }
    const rel = path.relative(paths.root, (0, approvals_1.approvalReceiptsPath)(paths)).split(path.sep).join("/");
    // Audit trail (mirrors the sim/tester writers): an approval clears a humanGate rung.
    // NB: key the approval's chain digest as `approvalRecordHash` so it never collides with
    // the ledger entry's OWN `recordHash`/`prevHash` seal fields.
    (0, ledger_1.appendLedger)(paths, { event: "approve", stage, approvalRecordHash: sealed.recordHash });
    (0, log_1.structuredLog)({ cmd: "approve", stage, approvalRecordHash: sealed.recordHash });
    return (0, output_1.success)({
        data: {
            file: rel,
            stage,
            producer_kind: sealed.producer_kind ?? "in-process",
            governing_artifact_digest: sealed.approval_of.governing_artifact_digest,
            recordHash: sealed.recordHash,
        },
        human: `Recorded an in-process human-approval receipt for "${stage}" at ${rel} ` +
            `(governing artifact: ${contract.produces}). ` +
            `NOTE: this in-process record is ATTRIBUTION-ONLY (zero trust weight) — the agent can mint it; ` +
            `independent grounding requires the slice-3b external-signed producer.`,
        receipts: [{ file: rel, hash: sealed.recordHash }],
    });
}
