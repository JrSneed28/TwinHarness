/**
 * Tester-record presence (SG3 P2-C, audit C-08). The production-reality gate's 3rd
 * condition is "a live-QA Tester run record is attached" — the audit's "mandatory
 * live QA + Production Reality Gate" promotes the on-demand Tester to a REQUIRED
 * final-verification gate (`orchestrator.md`, `templates/10` Tester Evidence).
 *
 * The record is a small JSON marker at `.twinharness/tester-record.json` written by
 * the live Tester (driver used, real/sandbox provider confirmed, raw output ref).
 * This module is the PURE read predicate the gate consumes; it is deliberately a
 * file-presence + shape check (not a counter on state.json) so the Tester's evidence
 * is auditable history, consistent with the simulation ledger and verify-report
 * sidecars. Keeping the predicate here (separate from the gate) mirrors how
 * `interviewReady`/`readVerifyReport` are pure readers the gate calls.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";

/** `<stateDir>/tester-record.json` — the live-QA Tester evidence marker. */
export function testerRecordPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "tester-record.json");
}

/**
 * A live-QA Tester run record (audit Part 5). All fields are evidence the gate
 * surfaces; only presence + a non-empty `driver` is required to satisfy the rung
 * (the human reads the rest in the verification report's Tester Evidence section).
 */
export interface TesterRecord {
  /** The driver/runner used for the live run (e.g. "playwright", "curl", "cli-e2e"). */
  driver: string;
  /** "real" | "sandbox" — the confirmed provider tier the live run exercised. */
  provider?: string;
  /** A reference to the raw output/screenshots (path or URL). */
  evidenceRef?: string;
  /** ISO timestamp the record was attached. */
  ranAt?: string;
}

/**
 * Read the Tester record, returning `null` when absent or unreadable/malformed
 * (fail-closed for the gate: no readable record ⇒ the rung blocks). A present record
 * must carry a non-empty `driver` to count — an empty marker is not evidence.
 */
export function readTesterRecord(paths: ProjectPaths): TesterRecord | null {
  const file = testerRecordPath(paths);
  if (!fs.existsSync(file)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.driver !== "string" || r.driver.trim() === "") return null;
  return {
    driver: r.driver,
    provider: typeof r.provider === "string" ? r.provider : undefined,
    evidenceRef: typeof r.evidenceRef === "string" ? r.evidenceRef : undefined,
    ranAt: typeof r.ranAt === "string" ? r.ranAt : undefined,
  };
}

/** True iff a valid live-QA Tester record is attached — the gate's 3rd condition. */
export function testerRecordPresent(paths: ProjectPaths): boolean {
  return readTesterRecord(paths) !== null;
}
