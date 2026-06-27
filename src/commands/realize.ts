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

import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { withStateLock, readState } from "../core/state-store";
import { structuredLog } from "../core/log";
import { appendLedger } from "../core/ledger";
import { NOT_INIT } from "../core/guards";
import {
  appendRealizationReceipt,
  realizationReceiptsPath,
  ReferentUnresolvedError,
  ownedReqsForDoneSlices,
  loadRepoMapForRealization,
} from "../core/realization";

export interface RealizeOptions {
  /** The REQ-ID being realized (positional). */
  reqId?: string;
  /** The source artifact path the REQ-ID is realized in (the referent). Required. */
  artifact?: string;
  /** Self-asserted producer identity (attribution-only, zero in-process trust weight). */
  producerIdentity?: string;
}

/**
 * `th realize <REQ-ID> --artifact <path> [--identity <who>]` — mint an in-process
 * realization receipt binding the REQ-ID to a digest of the named source artifact.
 * Serialized under the state lock so the chain append is atomic (mirrors `th approve`).
 */
export function runRealize(paths: ProjectPaths, opts: RealizeOptions = {}): CommandResult {
  return withStateLock(paths, () => runRealizeLocked(paths, opts));
}

function runRealizeLocked(paths: ProjectPaths, opts: RealizeOptions): CommandResult {
  const reqId = (opts.reqId ?? "").trim();
  if (reqId === "") {
    return failure({
      human: "Usage: th realize <REQ-ID> --artifact <path>. The REQ-ID positional is required.",
      data: { error: "realization_req_id_missing" },
    });
  }
  const artifact = (opts.artifact ?? "").trim();
  if (artifact === "") {
    return failure({
      human: `Usage: th realize ${reqId} --artifact <path>. The --artifact referent path is required.`,
      data: { error: "realization_artifact_missing" },
    });
  }

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: "state.json is invalid; fix it before recording a realization receipt.",
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  // Resolve the owning done-slice for the REQ-ID (audit breadcrumb on the receipt; the gate
  // recomputes ownership fresh, it does not trust this field). A REQ the join cannot place
  // under a done slice is still recordable here — the operator may be realizing ahead of the
  // gate's enumeration — so this is informational, not a refusal.
  const map = loadRepoMapForRealization(paths);
  const owning =
    map === null
      ? undefined
      : ownedReqsForDoneSlices(map, r.state).find((o) => o.reqId === reqId);
  const owningSlice = owning ? owning.owningSlices[0] ?? "" : "";

  let sealed;
  try {
    sealed = appendRealizationReceipt(paths, {
      reqId,
      owningSlice,
      artifactPath: artifact,
      producerIdentity: opts.producerIdentity ?? "cli:th realize",
    });
  } catch (e) {
    if (e instanceof ReferentUnresolvedError) {
      return failure({
        human:
          `Cannot record a realization receipt: artifact "${e.referent}" does not resolve in source. ` +
          `Supply a source path that exists, then re-run.`,
        data: { error: e.code, referent: e.referent },
      });
    }
    throw e;
  }

  const rel = path.relative(paths.root, realizationReceiptsPath(paths)).split(path.sep).join("/");

  // Audit trail (mirrors the driver/approval writers). Key the chain digest as
  // `realizationRecordHash` so it never collides with the ledger entry's own seal fields.
  appendLedger(paths, {
    event: "realize",
    reqId,
    owningSlice,
    referent: sealed.referent.path,
    realizationRecordHash: sealed.recordHash,
  });
  structuredLog({ cmd: "realize", reqId, referent: sealed.referent.path, realizationRecordHash: sealed.recordHash });

  // Advisory (not a failure): an empty owningSlice means the ownership join placed this REQ
  // under NO `done` slice — either the operator is realizing ahead of the slice→done claim, or
  // the REQ is not yet owned by any done slice. The receipt is still recorded (it grounds the
  // REQ for whenever its slice IS marked done), but the realization gate rung will not enforce
  // this REQ until that claim exists. Surfaced so the operator is not misled into thinking the
  // gate is now satisfied for an as-yet-unowned REQ.
  const unowned = owningSlice === "";

  return success({
    data: {
      file: rel,
      reqId,
      owningSlice,
      ...(unowned ? { owningSliceResolved: false } : {}),
      referent: sealed.referent,
      producer_kind: sealed.producer_kind ?? "in-process",
      recordHash: sealed.recordHash,
    },
    human:
      `Recorded an in-process realization receipt at ${rel} ` +
      `(${reqId} → ${sealed.referent.path}${owningSlice ? `, owning slice ${owningSlice}` : ""}). ` +
      (unowned
        ? `ADVISORY: ${reqId} is not currently owned by any \`done\` slice (the ownership join found no match), ` +
          `so the realization gate rung will not enforce it until its slice is marked done. `
        : "") +
      `NOTE: this in-process record is ATTRIBUTION-ONLY (zero trust weight) — the agent can mint it; ` +
      `independent (signature-provenance) grounding requires the external-signed producer.`,
    receipts: [{ file: rel, hash: sealed.recordHash }],
  });
}
