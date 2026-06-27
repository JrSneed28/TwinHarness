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

import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { withStateLock, readState } from "../core/state-store";
import { structuredLog } from "../core/log";
import { appendLedger } from "../core/ledger";
import { NOT_INIT } from "../core/guards";
import { canonicalizeStage, stageContract } from "../core/stages";
import {
  appendApprovalReceipt,
  approvalReceiptsPath,
  ApprovalUnmintableError,
} from "../core/approvals";

export interface ApproveOptions {
  /** Test seam: the producer identity to record (attribution-only). Defaults to `cli:th approve`. */
  producerIdentity?: string;
}

/**
 * `th approve [<stage>]` — mint an in-process approval for a `humanGate` stage (default =
 * the run's current stage). Serialized under the state lock so the chain append is atomic.
 */
export function runApprove(paths: ProjectPaths, stage: string | undefined, opts: ApproveOptions = {}): CommandResult {
  return withStateLock(paths, () => runApproveLocked(paths, stage, opts));
}

function runApproveLocked(paths: ProjectPaths, stageArg: string | undefined, opts: ApproveOptions): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: "state.json is invalid; fix it before approving a stage.",
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  // Default = the run's current stage when no positional is supplied.
  const raw = (stageArg ?? r.state.current_stage ?? "").trim();
  const stage = canonicalizeStage(raw);
  if (stage === "") {
    return failure({
      human: "usage: th approve <stage>  (no stage given and the run has no current_stage to default to)",
      data: { error: "approval_stage_required" },
    });
  }

  // Refuse-at-creation BEFORE any write: not a humanGate stage → clear refusal (a
  // non-humanGate stage carries no approval gate, so an approval would be meaningless).
  const contract = stageContract(stage);
  if (!contract || !contract.humanGate) {
    return failure({
      human:
        `Cannot approve "${stage}": it is not a humanGate stage. ` +
        `humanGate stages: requirements, scope, architecture, ux-design, ui-design, contracts, security, final-verification.`,
      data: { error: "approval_stage_not_human_gate", stage },
    });
  }

  let sealed;
  try {
    sealed = appendApprovalReceipt(paths, {
      stage,
      producerIdentity: opts.producerIdentity ?? "cli:th approve",
    });
  } catch (e) {
    if (e instanceof ApprovalUnmintableError) {
      return failure({
        human:
          e.code === "approval_artifact_unresolved"
            ? `Refusing to approve "${stage}": its governing artifact "${e.artifact}" does not resolve in source. ` +
              `Author and register the stage artifact first, then approve.`
            : `Cannot approve "${stage}": ${e.message}`,
        data: { error: e.code, stage, ...(e.artifact ? { artifact: e.artifact } : {}) },
      });
    }
    throw e;
  }

  const rel = path.relative(paths.root, approvalReceiptsPath(paths)).split(path.sep).join("/");

  // Audit trail (mirrors the sim/tester writers): an approval clears a humanGate rung.
  // NB: key the approval's chain digest as `approvalRecordHash` so it never collides with
  // the ledger entry's OWN `recordHash`/`prevHash` seal fields.
  appendLedger(paths, { event: "approve", stage, approvalRecordHash: sealed.recordHash });
  structuredLog({ cmd: "approve", stage, approvalRecordHash: sealed.recordHash });

  return success({
    data: {
      file: rel,
      stage,
      producer_kind: sealed.producer_kind ?? "in-process",
      governing_artifact_digest: sealed.approval_of.governing_artifact_digest,
      recordHash: sealed.recordHash,
    },
    human:
      `Recorded an in-process human-approval receipt for "${stage}" at ${rel} ` +
      `(governing artifact: ${contract.produces}). ` +
      `NOTE: this in-process record is ATTRIBUTION-ONLY (zero trust weight) — the agent can mint it; ` +
      `independent grounding requires the slice-3b external-signed producer.`,
    receipts: [{ file: rel, hash: sealed.recordHash }],
  });
}
