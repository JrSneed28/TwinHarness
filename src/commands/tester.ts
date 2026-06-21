/**
 * `th tester record` (SG3 P2-C, audit C-08) — attach the live-QA Tester run record the
 * production-reality gate's 3rd condition requires.
 *
 * The gate (`src/core/gate-preconditions.ts` → `checkProductionReality`) refuses
 * completion at final-verification until `.twinharness/tester-record.json` is present
 * and well-shaped (a non-empty `driver`). Before this verb existed, NO command or MCP
 * tool wrote that marker — the Tester agent only routed findings to drift/blackboard
 * and `th next` told the human to update the verification report, which the gate does
 * NOT read — so the gate could never be cleared through the documented workflow (audit
 * P1). This verb is the missing writer: it records the marker the gate reads.
 *
 * Mechanical only (plan §3 boundary rule): the CLI records the driver/provider/evidence
 * the live Tester supplies and content-hashes the marker. It does NOT decide whether the
 * live run actually passed — that judgment is the Tester's, surfaced in the verification
 * report's Tester Evidence section; the gate's mechanical requirement is only that a
 * recorded live run EXISTS. The pure READ predicate the gate consumes lives in
 * `src/core/tester.ts`; this is its governed writer (mirroring the sim ledger split).
 */

import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { atomicWriteFile } from "../core/atomic-io";
import { shortHash } from "../core/hash";
import { structuredLog } from "../core/log";
import { appendLedger } from "../core/ledger";
import { requireState } from "../core/guards";
import { testerRecordPath, type TesterRecord } from "../core/tester";

export interface TesterRecordOptions {
  /** The driver/runner used for the live run (e.g. "playwright", "curl", "cli-e2e"). Required. */
  driver?: string;
  /** The confirmed provider tier the live run exercised — "real" | "sandbox" (free text). */
  provider?: string;
  /** A reference to the raw output/screenshots (path or URL). */
  evidenceRef?: string;
}

/**
 * `th tester record --driver <d> [--provider real|sandbox] [--evidence-ref <path|url>]`
 *
 * Write the live-QA Tester marker at `.twinharness/tester-record.json` (through the
 * UNMODIFIED governed-write chokepoint — the state dir is an admitted write surface) and
 * stamp `ranAt`. A non-empty `driver` is REQUIRED (an empty marker is not evidence and
 * the read predicate rejects it). Returns a `{file, hash}` receipt.
 */
export function runTesterRecord(paths: ProjectPaths, opts: TesterRecordOptions): CommandResult {
  const driver = (opts.driver ?? "").trim();
  if (driver === "") {
    return failure({
      human: "usage: th tester record --driver <playwright|curl|cli-e2e|…> [--provider real|sandbox] [--evidence-ref <path|url>]",
      data: { error: "missing_driver" },
    });
  }

  // Require an initialized run (matches the other governed writers) so the marker is
  // attached to a real project; a clean NOT_INIT beats a stray file in a non-run dir.
  const st = requireState(paths);
  if (st.result) return st.result;

  const provider = opts.provider?.trim();
  const evidenceRef = opts.evidenceRef?.trim();
  const record: TesterRecord = {
    driver,
    ...(provider ? { provider } : {}),
    ...(evidenceRef ? { evidenceRef } : {}),
    ranAt: new Date().toISOString(),
  };

  const body = JSON.stringify(record, null, 2) + "\n";
  atomicWriteFile(testerRecordPath(paths), body, { root: paths.root });
  const hash = shortHash(body);
  const rel = path.relative(paths.root, testerRecordPath(paths)).split(path.sep).join("/");

  // Audit trail (mirrors the sim ledger): attaching a Tester record clears a gate rung.
  appendLedger(paths, { event: "tester-record", driver: record.driver, provider: record.provider ?? null });
  structuredLog({ cmd: "tester record", driver: record.driver, provider: record.provider ?? null });

  return success({
    data: { file: rel, ...record, hash },
    human:
      `Recorded live-QA Tester evidence at ${rel} (driver: ${record.driver}` +
      `${record.provider ? `, provider: ${record.provider}` : ""}${record.evidenceRef ? `, evidence: ${record.evidenceRef}` : ""}). ` +
      `The production-reality gate's Tester condition is now satisfied.`,
    receipts: [{ file: rel, hash }],
  });
}
