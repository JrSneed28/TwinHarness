/**
 * `th driver record` (Axis-B slice-4a / BSC-3) — mint the in-process driver-dimension
 * receipt the production-reality gate's verification-driver rung reads.
 *
 * Before this verb, the completion gate cleared on a verify report that said "ok" with
 * NO record of WHICH verification dimensions a trusted runner actually EXERCISED — a run
 * that never typechecked read identically to one that did (BSC-3). This is the missing
 * in-process SENSOR writer: it records which seed dimensions (`tests-executed`,
 * `typecheck`, `build`) `verify-report.json` actually observed, hash-chained into
 * `<stateDir>/driver-receipts.jsonl`, under `withStateLock` (exactly like `th approve`).
 *
 * ZERO TRUST WEIGHT (consensus §3): this is the IN-PROCESS producer — the agent can mint
 * it, so the record is attribution-only. Its trust label is `valid` NEVER `valid-grounded`;
 * the independently-grounded property arrives only in slice-4b (an external Ed25519-keyed
 * producer at a write-surface TwinHarness cannot reach). The record LOOKS authoritative
 * (hash-chained, snapshot-bound) but is NOT an independence anchor.
 *
 * SENSOR + refuse-at-creation (the 4a negative-control): the receipt records a dimension
 * ONLY when `verify-report.json` actually OBSERVES it. A `--dimension` claim is INTERSECTED
 * with the observed set; a claimed-but-unobserved name is REFUSED before any write
 * (`driver_dimension_unobserved`), and a missing/unresolving report is refused too
 * (`driver_evidence_unresolved`). The core sensor lives in `src/core/verification-driver.ts`;
 * this is its governed CLI writer (mirroring the approval/tester producer split).
 */

import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { withStateLock, readState } from "../core/state-store";
import { structuredLog } from "../core/log";
import { appendLedger } from "../core/ledger";
import { NOT_INIT } from "../core/guards";
import {
  appendDriverReceipt,
  driverReceiptsPath,
  DimensionUnobservedError,
  EvidenceUnresolvedError,
} from "../core/verification-driver";

export interface DriverRecordOptions {
  /**
   * The dimension names to RECORD as observed (comma-aware via repeated `--dimension`).
   * Intersected with what `verify-report.json` actually observes; a claimed-but-unobserved
   * name is refused at creation. Omitted ⇒ record every observed seed dimension.
   */
  dimensionNames?: readonly string[];
  /** Self-asserted producer identity (attribution-only, zero in-process trust weight). */
  producerIdentity?: string;
}

/**
 * `th driver record [--dimension <name>] [--identity <who>]` — mint an in-process
 * driver-dimension receipt from the current `verify-report.json`. Serialized under the
 * state lock so the chain append is atomic (mirrors `th approve`).
 */
export function runDriverRecord(paths: ProjectPaths, opts: DriverRecordOptions = {}): CommandResult {
  return withStateLock(paths, () => runDriverRecordLocked(paths, opts));
}

function runDriverRecordLocked(paths: ProjectPaths, opts: DriverRecordOptions): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: "state.json is invalid; fix it before recording a driver-dimension receipt.",
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  let sealed;
  try {
    sealed = appendDriverReceipt(paths, {
      ...(opts.dimensionNames !== undefined ? { dimensionNames: opts.dimensionNames } : {}),
      producerIdentity: opts.producerIdentity ?? "cli:th driver record",
    });
  } catch (e) {
    if (e instanceof DimensionUnobservedError) {
      return failure({
        human:
          `Refusing to record driver dimension(s) not observed in verify-report.json: ${e.unobserved.join(", ")}. ` +
          `Run \`th verify run\` so the report evidences the dimension(s) first, then re-record.`,
        data: { error: e.code, unobserved: e.unobserved },
      });
    }
    if (e instanceof EvidenceUnresolvedError) {
      return failure({
        human:
          `Cannot record a driver-dimension receipt: evidence artifact "${e.evidenceRef}" does not resolve in source. ` +
          `Run \`th verify run\` to produce the report, then re-record.`,
        data: { error: e.code, evidenceRef: e.evidenceRef },
      });
    }
    throw e;
  }

  const rel = path.relative(paths.root, driverReceiptsPath(paths)).split(path.sep).join("/");
  const recorded = sealed.dimensions.map((d) => d.name);

  // Audit trail (mirrors the approval/tester writers): a driver receipt grounds the BSC-3
  // verification-driver rung. Key the chain digest as `driverRecordHash` so it never
  // collides with the ledger entry's OWN recordHash/prevHash seal fields.
  appendLedger(paths, { event: "driver-record", dimensions: recorded, driverRecordHash: sealed.recordHash });
  structuredLog({ cmd: "driver record", dimensions: recorded, driverRecordHash: sealed.recordHash });

  return success({
    data: {
      file: rel,
      dimensions: recorded,
      producer_kind: sealed.producer_kind ?? "in-process",
      recordHash: sealed.recordHash,
    },
    human:
      `Recorded an in-process driver-dimension receipt at ${rel} ` +
      `(dimensions observed: ${recorded.length > 0 ? recorded.join(", ") : "(none)"}). ` +
      `NOTE: this in-process record is ATTRIBUTION-ONLY (zero trust weight) — the agent can mint it; ` +
      `independent grounding requires the slice-4b external-signed producer.`,
    receipts: [{ file: rel, hash: sealed.recordHash }],
  });
}
