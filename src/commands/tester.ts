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

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { atomicWriteFile } from "../core/atomic-io";
import { shortHash, hashContent } from "../core/hash";
import { structuredLog } from "../core/log";
import { appendLedger } from "../core/ledger";
import { requireState } from "../core/guards";
import { gitHead, dirtyTreeDigest } from "../core/git-revision";
import { testerRecordPath, type TesterRecord } from "../core/tester";

export interface TesterRecordOptions {
  /** The driver/runner used for the live run (e.g. "playwright", "curl", "cli-e2e"). Required. */
  driver?: string;
  /** The confirmed provider tier the live run exercised — "real" | "sandbox" (free text). */
  provider?: string;
  /** A reference to the raw output/screenshots (path or URL). */
  evidenceRef?: string;
  /**
   * F8/R-31 — the live run's pass/fail verdict (`--passed`). The production-reality
   * gate's STRICT predicate requires `passed:true`: a record without it (or with a
   * recorded FAIL) is not evidence of a passing live run. Default false when the flag
   * is absent (an unmarked run is NOT a pass).
   */
  passed?: boolean;
}

/**
 * Compute the execution-receipt digest binding a Tester record to a real run (F8/R-31).
 * It hashes the run's identifying inputs (driver + provider + the pass verdict + the
 * evidence reference) AND, when `evidenceRef` names a readable file under the project,
 * a content hash of that file — so a fabricated marker without the real evidence file
 * cannot reproduce the digest. A non-file/URL evidenceRef still contributes its string.
 */
function computeReceiptDigest(
  root: string,
  parts: { driver: string; provider?: string; evidenceRef?: string; passed: boolean },
): string {
  let evidenceContent = "";
  if (parts.evidenceRef) {
    const abs = path.isAbsolute(parts.evidenceRef) ? parts.evidenceRef : path.resolve(root, parts.evidenceRef);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        evidenceContent = fs.readFileSync(abs, "utf8");
      }
    } catch {
      /* unreadable → contribute nothing extra; the ref string still binds */
    }
  }
  const canonical = JSON.stringify({
    driver: parts.driver,
    provider: parts.provider ?? null,
    evidenceRef: parts.evidenceRef ?? null,
    passed: parts.passed,
    evidenceContentHash: evidenceContent ? hashContent(evidenceContent) : null,
  });
  return hashContent(canonical);
}

/**
 * `th tester record --driver <d> --passed [--provider real|sandbox] [--evidence-ref <path|url>]`
 *
 * Write the live-QA Tester marker at `.twinharness/tester-record.json` (through the
 * UNMODIFIED governed-write chokepoint — the state dir is an admitted write surface) and
 * stamp `ranAt`. A non-empty `driver` is REQUIRED.
 *
 * F8/R-31 — the record is now BOUND so it is actual proof a live run PASSED against
 * THIS snapshot, not a copyable driver-only marker: it carries the `passed` verdict, an
 * execution-receipt digest, and the repo-snapshot coordinates (gitHead/dirtyTreeDigest).
 * The strict gate predicate (`testerRecordPresent`) requires `passed:true` + a receipt +
 * a matching snapshot. Mechanical (plan §3): the CLI records the verdict the live Tester
 * supplies; it does not re-run or re-judge the live QA. Returns a `{file, hash}` receipt.
 */
export function runTesterRecord(paths: ProjectPaths, opts: TesterRecordOptions): CommandResult {
  const driver = (opts.driver ?? "").trim();
  if (driver === "") {
    return failure({
      human: "usage: th tester record --driver <playwright|curl|cli-e2e|…> --passed [--provider real|sandbox] [--evidence-ref <path|url>]",
      data: { error: "missing_driver" },
    });
  }

  // Require an initialized run (matches the other governed writers) so the marker is
  // attached to a real project; a clean NOT_INIT beats a stray file in a non-run dir.
  const st = requireState(paths);
  if (st.result) return st.result;

  const provider = opts.provider?.trim();
  const evidenceRef = opts.evidenceRef?.trim();
  const passed = opts.passed === true;
  const receiptDigest = computeReceiptDigest(paths.root, { driver, provider, evidenceRef, passed });
  const record: TesterRecord = {
    driver,
    ...(provider ? { provider } : {}),
    ...(evidenceRef ? { evidenceRef } : {}),
    ranAt: new Date().toISOString(),
    passed,
    receiptDigest,
    gitHead: gitHead(paths.root),
    dirtyTreeDigest: dirtyTreeDigest(paths.root),
  };

  const body = JSON.stringify(record, null, 2) + "\n";
  atomicWriteFile(testerRecordPath(paths), body, { root: paths.root });
  const hash = shortHash(body);
  const rel = path.relative(paths.root, testerRecordPath(paths)).split(path.sep).join("/");

  // Audit trail (mirrors the sim ledger): attaching a Tester record clears a gate rung.
  appendLedger(paths, { event: "tester-record", driver: record.driver, provider: record.provider ?? null, passed });
  structuredLog({ cmd: "tester record", driver: record.driver, provider: record.provider ?? null, passed });

  // Honest signal when the run was NOT marked passed: the record is written (audit
  // history) but the production-reality gate's Tester condition is NOT satisfied.
  const gateNote = passed
    ? "The production-reality gate's Tester condition is now satisfied."
    : "NOTE: recorded as NOT passed (`--passed` absent) — the production-reality gate's Tester condition is NOT satisfied. Re-record with `--passed` once the live run is green.";

  return success({
    data: { file: rel, ...record, hash },
    human:
      `Recorded live-QA Tester evidence at ${rel} (driver: ${record.driver}` +
      `${record.provider ? `, provider: ${record.provider}` : ""}${record.evidenceRef ? `, evidence: ${record.evidenceRef}` : ""}, passed: ${passed}). ` +
      gateNote,
    receipts: [{ file: rel, hash }],
  });
}
