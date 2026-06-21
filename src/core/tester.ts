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
import { gitHead, dirtyTreeDigest } from "./git-revision";
import { hashContent } from "./hash";

/** `<stateDir>/tester-record.json` — the live-QA Tester evidence marker. */
export function testerRecordPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "tester-record.json");
}

/**
 * An evidence reference is REMOTE (a URL like `https://…`, `s3://…`) rather than a
 * local file when it carries a URI scheme. A remote ref is not a file we can re-read,
 * so the local-evidence integrity checks are skipped for it (its string still binds
 * into the receipt digest). A bare path — absolute or relative — is treated as local.
 */
export function isRemoteEvidenceRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(ref);
}

/** Resolve a LOCAL evidence ref against the project root (absolute refs pass through). */
function resolveEvidencePath(root: string, ref: string): string {
  return path.isAbsolute(ref) ? ref : path.resolve(root, ref);
}

/** True iff `ref` names a readable, regular file once resolved against `root`. */
export function localEvidenceReadable(root: string, ref: string): boolean {
  const abs = resolveEvidencePath(root, ref);
  try {
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Compute the execution-receipt digest binding a Tester record to a real run
 * (F8/R-31). Hashes the run's identifying inputs (driver + provider + pass verdict +
 * evidence reference) AND, when `evidenceRef` names a readable LOCAL file, a content
 * hash of that file — so a fabricated marker without the real evidence cannot
 * reproduce the digest. A remote (URL) ref contributes only its string.
 *
 * The SINGLE source of truth shared by the `th tester record` writer
 * (`src/commands/tester.ts`) and {@link readTesterRecordValidated}'s
 * recompute-and-compare, so the writer and the validator can never drift apart on
 * the binding formula.
 */
export function computeReceiptDigest(
  root: string,
  parts: { driver: string; provider?: string; evidenceRef?: string; passed: boolean },
): string {
  let evidenceContent = "";
  if (parts.evidenceRef && !isRemoteEvidenceRef(parts.evidenceRef)) {
    const abs = resolveEvidencePath(root, parts.evidenceRef);
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
 * A live-QA Tester run record (audit Part 5; bound in F8 / R-31).
 *
 * Legacy fields (`driver`/`provider`/`evidenceRef`/`ranAt`) are the human-readable
 * evidence the verification report surfaces. F8 ADDS the BINDING fields that make a
 * record actual proof a live run passed against THIS snapshot, not a driver-only
 * marker copied from elsewhere:
 *
 *   - `passed`          — the live run's pass/fail verdict. A record with `passed`
 *                         absent or false is NOT evidence of a passing live run.
 *   - `receiptDigest`   — a digest of the execution receipt (driver + provider +
 *                         evidenceRef + a content hash of the raw output) — the
 *                         single value that makes the record forgery-resistant: a
 *                         fabricated marker without a real receipt cannot reproduce it.
 *   - `gitHead`         — the committed-tree identity the live run exercised (null
 *                         on a non-git checkout — non-discriminating).
 *   - `dirtyTreeDigest` — the working-tree delta digest at run time (null on a
 *                         non-git checkout). A record produced before a code change
 *                         no longer matches the current tree → stale.
 *
 * The bound fields are OPTIONAL on the type so a legacy bare record still parses;
 * the STRICT presence predicate ({@link testerRecordPresent}) is what requires them.
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
  /** F8 — the live run's pass/fail verdict (true ⇒ the live QA passed). */
  passed?: boolean;
  /** F8 — execution-receipt digest binding the record to a real run. */
  receiptDigest?: string;
  /** F8 — committed HEAD the live run exercised, or null on a non-git checkout. */
  gitHead?: string | null;
  /** F8 — working-tree delta digest at run time, or null on a non-git checkout. */
  dirtyTreeDigest?: string | null;
}

/**
 * Read the Tester record, returning `null` when absent or unreadable/malformed
 * (fail-closed for the gate: no readable record ⇒ the rung blocks). A present record
 * must carry a non-empty `driver` to PARSE — an empty marker is not evidence. The
 * F8 BINDING fields are carried through when present (the strict gate predicate
 * inspects them); a legacy bare record still parses (advisory back-compat).
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
    passed: typeof r.passed === "boolean" ? r.passed : undefined,
    receiptDigest: typeof r.receiptDigest === "string" ? r.receiptDigest : undefined,
    gitHead: typeof r.gitHead === "string" ? r.gitHead : r.gitHead === null ? null : undefined,
    dirtyTreeDigest:
      typeof r.dirtyTreeDigest === "string" ? r.dirtyTreeDigest : r.dirtyTreeDigest === null ? null : undefined,
  };
}

/**
 * The classification of a Tester record against the F8 binding requirements
 * (R-31). The completion gate accepts ONLY `valid`; every other status blocks:
 *
 *   - `absent`      — no record on disk (or unparseable / no driver).
 *   - `driver_only` — a legacy/bare record: a `driver` but no `passed` + receipt
 *                     binding (the pre-F8 marker shape) — not proof of a live PASS.
 *   - `not_passed`  — bound but `passed !== true` (a recorded FAIL or missing verdict).
 *   - `unbound`     — `passed:true` but no `receiptDigest` (no execution receipt).
 *   - `evidence_missing`  — the record names a LOCAL evidence file that is now absent
 *                     or unreadable (deleted since the run, or never existed). A
 *                     receipt that points at evidence we cannot read is not proof.
 *   - `evidence_mismatch` — the local evidence file exists but its content no longer
 *                     reproduces the bound `receiptDigest` (replaced/edited since the
 *                     run) — the receipt no longer corresponds to the evidence.
 *   - `stale`       — bound + passed, but the repo snapshot moved since the run
 *                     (gitHead / dirtyTreeDigest diverged) — the live run no longer
 *                     corresponds to the current tree (a code change invalidates it).
 *   - `valid`       — passed, receipt-bound, local evidence (if any) verified, and the
 *                     repo snapshot matches.
 */
export type TesterRecordValidationStatus =
  | "absent"
  | "driver_only"
  | "not_passed"
  | "unbound"
  | "evidence_missing"
  | "evidence_mismatch"
  | "stale"
  | "valid";

export interface ValidatedTesterRecord {
  status: TesterRecordValidationStatus;
  record?: TesterRecord;
  /** For `stale`: which repo-snapshot coordinate(s) diverged. */
  staleReasons?: string[];
}

/**
 * Read + CLASSIFY the Tester record against the F8 binding (R-31). The git
 * coordinates discriminate only when BOTH sides are non-null (the honest "unbound"
 * posture — a coordinate we cannot compute cannot prove staleness). When the record
 * names a LOCAL evidence file, that file is re-read and the receipt RECOMPUTED, so a
 * record bound to absent evidence, or evidence deleted/replaced after the run, is
 * caught even when it lives outside the tracked tree (where the repo coordinates miss it).
 */
export function readTesterRecordValidated(paths: ProjectPaths): ValidatedTesterRecord {
  const record = readTesterRecord(paths);
  if (record === null) return { status: "absent" };
  // A bare/legacy marker: a driver but no pass+receipt binding.
  if (record.passed === undefined && record.receiptDigest === undefined) {
    return { status: "driver_only", record };
  }
  if (record.passed !== true) return { status: "not_passed", record };
  if (typeof record.receiptDigest !== "string" || record.receiptDigest.trim() === "") {
    return { status: "unbound", record };
  }
  // Local-evidence integrity: a record naming a LOCAL evidence file must still be able
  // to read that file AND reproduce the bound receipt from its content. This catches a
  // record written against absent local evidence (the digest bound a null content hash),
  // and evidence deleted/replaced AFTER recording — neither of which the repo-snapshot
  // coordinates detect when the evidence lives outside the tracked tree. A remote (URL)
  // ref is not a file we can re-read → skipped (it contributes only its string).
  if (record.evidenceRef && !isRemoteEvidenceRef(record.evidenceRef)) {
    if (!localEvidenceReadable(paths.root, record.evidenceRef)) {
      return { status: "evidence_missing", record };
    }
    const recomputed = computeReceiptDigest(paths.root, {
      driver: record.driver,
      provider: record.provider,
      evidenceRef: record.evidenceRef,
      passed: record.passed === true,
    });
    if (recomputed !== record.receiptDigest) {
      return { status: "evidence_mismatch", record };
    }
  }
  // Repo-snapshot binding: stale when a present coordinate diverged from the current tree.
  const curHead = gitHead(paths.root);
  const curDirty = dirtyTreeDigest(paths.root);
  const staleReasons: string[] = [];
  if (record.gitHead != null && curHead != null && record.gitHead !== curHead) {
    staleReasons.push("gitHead");
  }
  if (record.dirtyTreeDigest != null && curDirty != null && record.dirtyTreeDigest !== curDirty) {
    staleReasons.push("dirtyTreeDigest");
  }
  if (staleReasons.length > 0) return { status: "stale", record, staleReasons };
  return { status: "valid", record };
}

/**
 * True iff a live-QA Tester record satisfying the F8 binding is attached — the
 * production-reality gate's 3rd condition (R-31, ENFORCED).
 *
 * STRICT: a record counts ONLY when the live run is recorded as PASSED, carries an
 * execution-receipt digest, its LOCAL evidence file (if any) is readable and still
 * reproduces that digest, and its repo-snapshot binding matches the current tree
 * (`readTesterRecordValidated(...).status === "valid"`). A driver-only marker, a
 * missing/false pass verdict, an unbound (no-receipt) record, one whose local evidence
 * is absent or altered, or one staled by a code change since the run no longer clears
 * the rung — closing the F8 gap where a bare `{driver}` marker (copyable, unbound to
 * any real run) could fake the mandatory live QA. The richer classification + token
 * are available via `readTesterRecordValidated`.
 */
export function testerRecordPresent(paths: ProjectPaths): boolean {
  return readTesterRecordValidated(paths).status === "valid";
}
