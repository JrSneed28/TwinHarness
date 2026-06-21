/**
 * Project verification config + report (the data layer for `th verify`).
 *
 * `th verify run` is the ONE command that executes configured project test
 * commands. It is deliberately quarantined here, away from every other `th`
 * command, because executing project commands is the single exception to the
 * CLI's "records and computes; never re-runs" boundary (plan §3) — it exists so
 * the run-health view (`th coverage report`, `th doctor`) can reflect whether the
 * suite is actually green, not just whether tests are anchored.
 *
 * Files live under the state dir, never inside state.json (so the state schema
 * and its content-hash stability are untouched):
 *   - verify.json            → { commands, provenance }  (the config)
 *   - verify-approvals.jsonl → append-only, hash-chained approval ledger (P1/R-02)
 *   - verify-report.json     → the last run's results
 *
 * Security note (see SECURITY.md): the configured commands are run with the
 * shell, in the project root. They are operator-authored, exactly like the
 * scripts a developer would run by hand; `th verify run` never sources commands
 * from untrusted artifact content. Phase 6 hardening (#19) adds:
 *   - per-command provenance (actor + timestamp) recorded on `th verify add`;
 *   - a curated (not fully-inherited) child env;
 *   - secret redaction of the persisted/printed output tail;
 *   - a Windows/POSIX process-TREE kill on timeout so grandchildren die;
 *   - an optional best-effort write blocker (--no-obvious-writes / deprecated --read-only) that refuses obvious repo-mutating verification commands.
 *
 * P1 hardening (R-01/R-02/R-03 — bring verify.json to the decision-record
 * standard): the command SET must be human-confirmed (a TTY barrier on
 * `th verify approve`, in the command layer) before its first execution; the
 * approval is recorded in a tamper-EVIDENT, SHA-256 hash-chained append-only
 * ledger (`verify-approvals.jsonl`, mirroring `decisions.jsonl`) so a forged or
 * edited approval breaks the chain and `verify run` fails CLOSED; and the config
 * write is atomic + governed (and serialized by the command layer's
 * `withStateLock`). A torn/unreadable config is treated as CORRUPT and refused,
 * never silently degraded to an empty/approved set.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import type { ProjectPaths } from "./paths";
import { assertGovernedWriteSurface } from "./paths";
import { atomicWriteFile, readFileWithRetry } from "./atomic-io";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";
import { readJsonlValues, scanTailValid } from "./jsonl";
import { gitHead, dirtyTreeDigest } from "./git-revision";

/** Per-command provenance (#19, P6-2): who added the command and when. */
export interface VerifyCommandProvenance {
  command: string;
  /** Resolved actor (TH_VERIFY_ACTOR / --as / "unknown"). */
  actor: string;
  /** ISO-8601 UTC add time. */
  addedAt: string;
}

export interface VerifyConfig {
  commands: string[];
  /** Provenance of each configured command (omit-when-absent for legacy files). */
  provenance?: VerifyCommandProvenance[];
  // NOTE (P1/R-02): approval is no longer a forgeable field on this config. A bare
  // `approvedHash = sha256(commands)` was publicly recomputable, so anyone who could
  // write verify.json could forge approval. Approvals now live in the tamper-evident
  // hash-chained ledger `verify-approvals.jsonl` (see {@link appendVerifyApproval} /
  // {@link evaluateCommandSetApproval}); legacy `approvedHash`/`approvedBy`/`approvedAt`
  // fields on an old file are ignored (treated as unapproved until a fresh
  // `th verify approve` seals a ledger entry).
}

export interface VerifyResult {
  command: string;
  exitCode: number;
  ok: boolean;
  durationMs: number;
  /** Last ~2000 chars of combined stdout+stderr (for a glanceable failure tail). */
  outputTail: string;
}

export interface VerifyReport {
  ok: boolean;
  ranAt: string;
  results: VerifyResult[];
}

const OUTPUT_TAIL_CHARS = 2000;

/**
 * Per-command wall-clock budget (ms). A configured command that hangs (a watch
 * mode, a server, a process waiting on stdin, a deadlocked test) would otherwise
 * block `th verify run` forever; the timeout kills it and records a failure so
 * the run always terminates. 5 minutes is generous for a real test suite.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

export function verifyConfigPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "verify.json");
}

export function verifyReportPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "verify-report.json");
}

/**
 * The stable hash of an ordered command set (#19, P6-2). Used to detect a
 * new/changed set that must be re-confirmed before execution. Hash the JSON array
 * (order-sensitive — reordering changes which command runs first, a meaningful
 * change) of the trimmed commands.
 */
export function commandSetHash(commands: string[]): string {
  return createHash("sha256").update(JSON.stringify(commands), "utf8").digest("hex");
}

/** Whether a read of verify.json found it absent, well-formed, or present-but-corrupt. */
export type VerifyConfigStatus = "ok" | "absent" | "corrupt";

export interface LoadedVerifyConfig {
  status: VerifyConfigStatus;
  config: VerifyConfig;
}

/**
 * Read verify.json, DISTINGUISHING absent from present-but-corrupt (R-03). The old
 * reader collapsed both to `{ commands: [] }`, so an unreadable/torn config read as
 * "no commands" — which `isCommandSetApproved` then judged trivially approved
 * (fail-OPEN). Here a present file that does not parse, or parses to the wrong
 * shape, returns `status:"corrupt"` so the run gate can fail CLOSED instead of
 * treating a corrupt config as an empty/approved set. The read goes through
 * {@link readFileWithRetry} so a transient contention error (a reader colliding
 * with a concurrent atomic rename of the config) is retried, not misjudged.
 */
export function loadVerifyConfig(paths: ProjectPaths): LoadedVerifyConfig {
  const file = verifyConfigPath(paths);
  if (!fs.existsSync(file)) return { status: "absent", config: { commands: [] } };
  let raw: string;
  try {
    raw = readFileWithRetry(file);
  } catch {
    // Present a moment ago but unreadable after the retry budget (e.g. removed
    // mid-read) → treat as absent: there are no bytes to misjudge as corrupt.
    return { status: "absent", config: { commands: [] } };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as VerifyConfig).commands)) {
      const obj = parsed as VerifyConfig;
      const commands = obj.commands.filter((c): c is string => typeof c === "string");
      const config: VerifyConfig = { commands };
      if (Array.isArray(obj.provenance)) {
        config.provenance = obj.provenance.filter(
          (p): p is VerifyCommandProvenance =>
            p != null && typeof (p as VerifyCommandProvenance).command === "string",
        );
      }
      return { status: "ok", config };
    }
    // Present + parseable but the wrong shape (no commands array) → corrupt.
    return { status: "corrupt", config: { commands: [] } };
  } catch {
    // Present but unparseable JSON → corrupt. Fail CLOSED at the run gate; never
    // silently degrade to "no commands / approved-empty" as the old reader did.
    return { status: "corrupt", config: { commands: [] } };
  }
}

/** Read the configured commands. Missing/corrupt file → empty command list (the
 * back-compat shape). Callers that must DISTINGUISH a corrupt config (to fail
 * closed) use {@link loadVerifyConfig} directly. */
export function readVerifyConfig(paths: ProjectPaths): VerifyConfig {
  return loadVerifyConfig(paths).config;
}

/**
 * Write verify.json atomically + through the governed write-surface chokepoint
 * (R-03 — was a bare `fs.writeFileSync`, torn-readable and ungoverned). The
 * command layer serializes concurrent mutations via `withStateLock`;
 * {@link atomicWriteFile} threads `paths.root` so the target is asserted in-surface
 * and the temp→fsync→rename→dir-fsync barrier makes a torn read impossible.
 */
export function writeVerifyConfig(paths: ProjectPaths, config: VerifyConfig): void {
  atomicWriteFile(verifyConfigPath(paths), JSON.stringify(config, null, 2) + "\n", { root: paths.root });
}

// ---------------------------------------------------------------------------
// Approval ledger (P1/R-02) — tamper-evident, hash-chained verify-approvals.jsonl
// ---------------------------------------------------------------------------

/**
 * Why a ledger and not a field on verify.json: the old `approvedHash` was a bare
 * `sha256(commands)`. `commandSetHash` is exported and its input is public, so
 * anyone who could write verify.json could recompute and FORGE the approval (R-02).
 * Approvals now live in an append-only, SHA-256 hash-chained ledger that mirrors
 * `decisions.jsonl`: a forged or edited approval event breaks the chain, and
 * `verify run` then fails CLOSED (unapproved). Forging by APPEND is separately
 * blocked by the TTY barrier on `th verify approve` (the command layer) and by the
 * write-gate (verify.json + this ledger are no longer auto-allowed for a direct
 * tool Write — see hook.ts) — exactly the layered defense `decisions.jsonl` relies on.
 */
export interface VerifyApprovalEvent {
  /** `commandSetHash(commands)` of the SET a human approved (64-hex). */
  approvedHash: string;
  /** Number of commands approved (audit only). */
  commandCount: number;
  /** Resolved approver attribution (`--as` / TH_VERIFY_ACTOR / "unknown"). */
  approvedBy: string;
  /** ISO-8601 UTC approval time. */
  approvedAt: string;
  /** SHA-256 hex (64) of the prior line's canonical text, or GENESIS for the first. */
  prevHash: string;
  /** SHA-256 hex (64) of THIS event's canonical text (computed with recordHash omitted). */
  recordHash: string;
}

export function verifyApprovalsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "verify-approvals.jsonl");
}

/** Fixed canonical field order for hashing (deterministic JSON; recordHash omitted). */
const APPROVAL_FIELD_ORDER: ReadonlyArray<keyof VerifyApprovalEvent> = [
  "approvedHash",
  "commandCount",
  "approvedBy",
  "approvedAt",
  "prevHash",
];

/** Deterministic canonical text of an approval event for hashing (recordHash omitted). */
export function approvalCanonicalText(event: Omit<VerifyApprovalEvent, "recordHash">): string {
  const ordered: Record<string, unknown> = {};
  for (const key of APPROVAL_FIELD_ORDER) {
    const val = (event as Record<string, unknown>)[key];
    if (val === undefined) continue;
    ordered[key] = val;
  }
  return JSON.stringify(ordered);
}

/** `recordHash` of an approval event = SHA-256 of its canonical text. */
function approvalRecordHash(event: Omit<VerifyApprovalEvent, "recordHash">): string {
  return hashContent(approvalCanonicalText(event));
}

/** Validate a parsed approval line; malformed lines are skipped by the reader. */
function isValidApprovalEvent(parsed: unknown): parsed is VerifyApprovalEvent {
  if (typeof parsed !== "object" || parsed === null) return false;
  const e = parsed as Record<string, unknown>;
  if (typeof e.approvedHash !== "string" || !HEX64.test(e.approvedHash)) return false;
  if (typeof e.commandCount !== "number") return false;
  if (typeof e.approvedBy !== "string") return false;
  if (typeof e.approvedAt !== "string") return false;
  if (typeof e.prevHash !== "string" || !HEX64.test(e.prevHash)) return false;
  if (typeof e.recordHash !== "string" || !HEX64.test(e.recordHash)) return false;
  return true;
}

/** Read every approval event in file order. Missing file → []. Bad lines skipped. */
export function readVerifyApprovals(paths: ProjectPaths): VerifyApprovalEvent[] {
  return readJsonlValues(verifyApprovalsPath(paths), isValidApprovalEvent);
}

/** The recordHash of the last VALID approval event, or GENESIS when none (tail parse). */
function lastApprovalRecordHash(paths: ProjectPaths): string {
  const last = scanTailValid(verifyApprovalsPath(paths), isValidApprovalEvent);
  return last ? last.recordHash : GENESIS_PREV_HASH;
}

export type VerifyApprovalChainResult =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: "edited" | "prev_mismatch" };

/**
 * Walk approval events with a running `expectedPrev`. A recomputed recordHash that
 * does not match → the record was edited (a forged field); `prevHash !== expectedPrev`
 * → inserted/deleted/reordered. Returns the FIRST break. Mirrors decisions' verifyChain.
 */
export function verifyApprovalChain(events: VerifyApprovalEvent[]): VerifyApprovalChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const { recordHash, ...rest } = e;
    if (approvalRecordHash(rest) !== recordHash) return { ok: false, brokenAt: i, reason: "edited" };
    if (e.prevHash !== expectedPrev) return { ok: false, brokenAt: i, reason: "prev_mismatch" };
    expectedPrev = e.recordHash;
  }
  return { ok: true };
}

/**
 * Append one approval event, sealing the hash chain (mirrors `appendDecisionEvent`).
 * The caller MUST already hold the `withStateLock` span. Reads only the current tail
 * for `prevHash`, computes `recordHash`, then atomically appends the JSON line. The
 * write-surface chokepoint fires here (not best-effort — this writer propagates) so a
 * non-governed target throws.
 */
export function appendVerifyApproval(
  paths: ProjectPaths,
  record: { approvedHash: string; commandCount: number; approvedBy: string; approvedAt: string },
): VerifyApprovalEvent {
  assertGovernedWriteSurface(paths.root, verifyApprovalsPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const prevHash = lastApprovalRecordHash(paths);
  const withPrev: Omit<VerifyApprovalEvent, "recordHash"> = { ...record, prevHash };
  const recordHash = approvalRecordHash(withPrev);
  const sealed: VerifyApprovalEvent = { ...withPrev, recordHash };
  fs.appendFileSync(verifyApprovalsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

/** Why a command set is (un)approved — distinguishes a tamper from a plain miss. */
export type ApprovalReason = "empty" | "approved" | "unapproved" | "chain_broken";

/**
 * Evaluate whether `commands` is approved for execution against the tamper-evident
 * ledger (R-02). An empty set is trivially approved (nothing to run). Otherwise the
 * ledger chain is verified FIRST and a break fails CLOSED (`chain_broken` →
 * unapproved). A set is approved iff the LATEST valid approval event's `approvedHash`
 * equals `commandSetHash(commands)` — so any `add`/`clear` that changed the set since
 * the last approval (the ledger is touched ONLY by `approve`) leaves the latest
 * approval pointing at a different hash → unapproved until re-confirmed.
 */
export function evaluateCommandSetApproval(
  paths: ProjectPaths,
  commands: string[],
): { approved: boolean; reason: ApprovalReason } {
  if (commands.length === 0) return { approved: true, reason: "empty" };
  const events = readVerifyApprovals(paths);
  if (!verifyApprovalChain(events).ok) return { approved: false, reason: "chain_broken" };
  const last = events.length ? events[events.length - 1]! : undefined;
  if (last && last.approvedHash === commandSetHash(commands)) return { approved: true, reason: "approved" };
  return { approved: false, reason: "unapproved" };
}

/**
 * Whether the current command set has been approved for execution (P1/R-02). A
 * non-empty set is approved only when the tamper-evident ledger's latest event
 * matches it on an unbroken chain; an empty set is trivially approved (nothing to
 * run). Reads the ledger; the caller passes `paths` + the current `commands`.
 */
export function isCommandSetApproved(paths: ProjectPaths, commands: string[]): boolean {
  return evaluateCommandSetApproval(paths, commands).approved;
}

/** The latest valid approval event matching `commands` (for audit display), or undefined. */
export function latestApprovalFor(paths: ProjectPaths, commands: string[]): VerifyApprovalEvent | undefined {
  if (commands.length === 0) return undefined;
  const events = readVerifyApprovals(paths);
  if (!verifyApprovalChain(events).ok) return undefined;
  const last = events.length ? events[events.length - 1]! : undefined;
  return last && last.approvedHash === commandSetHash(commands) ? last : undefined;
}

/**
 * Read the last verify report, or null when none has been written.
 *
 * The read goes through {@link readFileWithRetry} so a transient contention error
 * (a reader colliding with a concurrent atomic rename of the report — see
 * {@link writeVerifyReport}) is retried rather than swallowed as "absent". Without
 * this, a present-but-momentarily-contended report read null and made callers like
 * `th next` re-emit a spurious `run-verify` obligation (the REQ-NEXT-011 flake):
 * a settled run was intermittently judged un-verified. A genuinely missing or
 * corrupt report still returns null — the real staleness signal is unchanged.
 */
export function readVerifyReport(paths: ProjectPaths): VerifyReport | null {
  const file = verifyReportPath(paths);
  if (!fs.existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileWithRetry(file);
  } catch {
    // The file existed a moment ago but the read still failed after the retry
    // budget (e.g. it was removed mid-read) → treat as absent.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as VerifyReport).ok === "boolean") {
      return parsed as VerifyReport;
    }
  } catch {
    // Corrupt report → treat as absent.
  }
  return null;
}

/**
 * Write the verify report atomically (write temp, then rename over the target) so
 * a concurrent {@link readVerifyReport} can never observe a torn/partial file —
 * it sees either the old report or the new one, never a half-written blob. This
 * pairs with the retrying reader to keep a freshly-written report from reading as
 * absent (the REQ-NEXT-011 flake).
 */
export function writeVerifyReport(paths: ProjectPaths, report: VerifyReport): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  atomicWriteFile(verifyReportPath(paths), JSON.stringify(report, null, 2) + "\n", { root: paths.root });
}

/**
 * Write a BOUND verify-report envelope (F2/R-30): the report payload PLUS the current
 * binding coordinates (command-set hash, approval-ledger tail, git head, dirty-tree
 * digest), sealed at run time. `runVerifyRun` calls this so the persisted report can
 * be validated against the snapshot it certified — a later `verify add`/`clear`, a
 * re-approval, or a repo change makes the stored binding diverge and the validated
 * reader classifies the report `stale`. Same atomic + governed-surface write as the
 * bare report (the envelope is a superset, so legacy readers still parse it).
 */
export function writeVerifyReportEnvelope(paths: ProjectPaths, report: VerifyReport, commands: string[]): void {
  const binding = currentVerifyBinding(paths, commands);
  const envelope: VerifyReportEnvelope = {
    ...report,
    schemaVersion: VERIFY_REPORT_SCHEMA_VERSION,
    commandSetHash: binding.commandSetHash,
    configLockDigest: binding.configLockDigest,
    gitHead: binding.gitHead,
    dirtyTreeDigest: binding.dirtyTreeDigest,
  };
  fs.mkdirSync(paths.stateDir, { recursive: true });
  atomicWriteFile(verifyReportPath(paths), JSON.stringify(envelope, null, 2) + "\n", { root: paths.root });
}

// ---------------------------------------------------------------------------
// F2 (R-30) — bound verify-report envelope + validated reader
// ---------------------------------------------------------------------------

/**
 * The CURRENT verify-report envelope schema version (F2, R-30). A report written
 * by `runVerifyRun` now carries this so the completion gate can tell a binding-
 * carrying report apart from a legacy bare `VerifyReport` (which had no
 * `schemaVersion`). Bumped only when the binding shape changes.
 */
export const VERIFY_REPORT_SCHEMA_VERSION = 2;

/**
 * A verify report BOUND to the snapshot it certified (F2, R-30). The completion
 * gate must not accept a report that does not correspond to the CURRENT state of
 * the project — a legacy `{"ok":true}`, a stale report from before a `verify
 * add`/`clear`, or a report copied from another project/revision. The envelope
 * carries the four coordinates that pin a report to its production reality:
 *
 *   - `commandSetHash`   — `commandSetHash(commands)` of the suite that ran. A
 *                          `verify add`/`clear` changes this, so an old report no
 *                          longer matches the configured set → STALE.
 *   - `configLockDigest` — the approval-ledger tail (the `recordHash` of the latest
 *                          approval, or GENESIS when none). A re-approval (a new
 *                          human confirmation) advances it, so a report sealed
 *                          against an earlier approval is detectably stale.
 *   - `gitHead`          — the committed-tree identity the run executed against
 *                          (null on a non-git checkout — non-discriminating).
 *   - `dirtyTreeDigest`  — the uncommitted working-tree delta digest (null on a
 *                          non-git checkout). A report produced at HEAD with one set
 *                          of local edits is distinct from one at the same HEAD with
 *                          a different (or clean) tree.
 *
 * The report PAYLOAD (`ok`/`ranAt`/`results`) is carried inline (it IS a
 * `VerifyReport`) so the legacy readers (`readVerifyReport`) still parse it — the
 * envelope is a superset, not a wrapper. This keeps the bare-report consumers
 * working while the validated reader inspects the binding.
 */
export interface VerifyReportEnvelope extends VerifyReport {
  /** Envelope schema version ({@link VERIFY_REPORT_SCHEMA_VERSION}); absent ⇒ legacy. */
  schemaVersion: number;
  /** `commandSetHash(commands)` of the suite that produced this report. */
  commandSetHash: string;
  /** The approval-ledger tail digest at run time (latest recordHash, or GENESIS). */
  configLockDigest: string;
  /** The committed HEAD the run executed against, or null on a non-git checkout. */
  gitHead: string | null;
  /** The uncommitted working-tree delta digest, or null on a non-git checkout. */
  dirtyTreeDigest: string | null;
}

/**
 * The classification of a verify report against the CURRENT binding coordinates
 * (F2, R-30). The completion gate accepts ONLY `valid`; every other status blocks:
 *
 *   - `absent`  — no report on disk.
 *   - `corrupt` — present but unparseable / wrong shape.
 *   - `legacy`  — a bare `VerifyReport` with no (or an old) `schemaVersion` — it
 *                 carries no binding, so its greenness cannot be trusted for the
 *                 current snapshot; the operator must re-run to seal an envelope.
 *   - `stale`   — a bound report whose binding no longer matches: the command set
 *                 changed (`commandSetHash`), the approval was re-sealed
 *                 (`configLockDigest`), or the repo snapshot moved (`gitHead` /
 *                 `dirtyTreeDigest`). A copied-from-another-project/revision report
 *                 lands here (its gitHead/dirtyTree differ from this checkout's).
 *   - `valid`   — a bound report whose every PRESENT coordinate matches the current
 *                 project state (an absent git coordinate is non-discriminating).
 */
export type VerifyReportValidationStatus = "absent" | "corrupt" | "legacy" | "stale" | "valid";

export interface ValidatedVerifyReport {
  status: VerifyReportValidationStatus;
  /** The parsed report payload when present+parseable (absent/corrupt ⇒ undefined). */
  report?: VerifyReport;
  /** The parsed envelope when the report carried a binding (legacy/absent ⇒ undefined). */
  envelope?: VerifyReportEnvelope;
  /** For `stale`: which binding coordinate(s) diverged (audit/diagnostics). */
  staleReasons?: string[];
}

/** The expected binding coordinates a report must match to be `valid`. */
export interface VerifyBinding {
  commandSetHash: string;
  configLockDigest: string;
  gitHead: string | null;
  dirtyTreeDigest: string | null;
}

/** Is `v` a binding-carrying envelope (has the F2 fields)? Narrowing guard. */
function hasEnvelopeBinding(v: Record<string, unknown>): boolean {
  return (
    typeof v.schemaVersion === "number" &&
    typeof v.commandSetHash === "string" &&
    typeof v.configLockDigest === "string"
  );
}

/**
 * The CURRENT binding for `paths`: the configured command set's hash, the approval-
 * ledger tail digest, and the repo snapshot coordinates. Used both to STAMP a fresh
 * envelope (the writer, Commit 2) and to VALIDATE a stored one (the reader below) —
 * a single source so a report is judged stale by the SAME coordinates it was sealed
 * with. `gitHead`/`dirtyTreeDigest` fail soft to null (non-git checkout).
 */
export function currentVerifyBinding(paths: ProjectPaths, commands: string[]): VerifyBinding {
  return {
    commandSetHash: commandSetHash(commands),
    configLockDigest: lastApprovalRecordHash(paths),
    gitHead: gitHead(paths.root),
    dirtyTreeDigest: dirtyTreeDigest(paths.root),
  };
}

/**
 * Read the verify report and CLASSIFY it against the current binding (F2, R-30).
 * This is the validated reader the completion gate consumes instead of the bare
 * {@link readVerifyReport}: a legacy/stale/copied report is no longer silently
 * trusted as green.
 *
 * A git coordinate (gitHead/dirtyTreeDigest) that is null on EITHER side (the stored
 * report's or the current binding's) is NON-DISCRIMINATING — a binding we cannot
 * compute cannot prove staleness, so it does not flip a report to stale (the honest
 * "unbound" posture). The command-set and config-lock digests are always present
 * (they are content hashes), so they always discriminate.
 */
export function readVerifyReportValidated(paths: ProjectPaths): ValidatedVerifyReport {
  const file = verifyReportPath(paths);
  if (!fs.existsSync(file)) return { status: "absent" };
  let raw: string;
  try {
    raw = readFileWithRetry(file);
  } catch {
    return { status: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupt" };
  }
  if (parsed === null || typeof parsed !== "object") return { status: "corrupt" };
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.ok !== "boolean") return { status: "corrupt" };
  const report = obj as unknown as VerifyReport;

  // No binding ⇒ legacy: a bare report (or a pre-F2 schemaVersion) carries no proof
  // it corresponds to the current snapshot, so its greenness cannot be trusted.
  if (!hasEnvelopeBinding(obj) || (obj.schemaVersion as number) < VERIFY_REPORT_SCHEMA_VERSION) {
    return { status: "legacy", report };
  }
  const envelope = obj as unknown as VerifyReportEnvelope;

  // Compute the current binding and compare each PRESENT coordinate.
  const config = loadVerifyConfig(paths).config;
  const expected = currentVerifyBinding(paths, config.commands);
  const staleReasons: string[] = [];
  if (envelope.commandSetHash !== expected.commandSetHash) staleReasons.push("commandSetHash");
  if (envelope.configLockDigest !== expected.configLockDigest) staleReasons.push("configLockDigest");
  // git coordinates: only discriminate when BOTH sides are non-null.
  if (
    envelope.gitHead !== null &&
    expected.gitHead !== null &&
    envelope.gitHead !== expected.gitHead
  ) {
    staleReasons.push("gitHead");
  }
  if (
    envelope.dirtyTreeDigest !== null &&
    expected.dirtyTreeDigest !== null &&
    envelope.dirtyTreeDigest !== expected.dirtyTreeDigest
  ) {
    staleReasons.push("dirtyTreeDigest");
  }
  if (staleReasons.length > 0) return { status: "stale", report, envelope, staleReasons };
  return { status: "valid", report, envelope };
}

// ---------------------------------------------------------------------------
// Secret redaction (#19, P6-3) — scrub known secret shapes before persist/print
// ---------------------------------------------------------------------------

/**
 * Redaction rules for common secret shapes in command output. Conservative: each
 * pattern targets a recognizable token/credential form so ordinary test output is
 * left intact. This is best-effort defense-in-depth (the honest caveat: a secret
 * in an unrecognized shape can still leak), applied to the persisted AND printed
 * `outputTail` so a leaked token does not land in `verify-report.json` or the
 * terminal. Order matters — more specific patterns first.
 */
const REDACTION_RULES: ReadonlyArray<{ re: RegExp; replace: string }> = [
  // key=value / key: value for secret-ish keys (token, secret, password, api_key, ...).
  {
    re: /\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth)[A-Za-z0-9_-]*)\s*([=:])\s*("?)([^\s"']+)\3/gi,
    replace: "$1$2$3[REDACTED]$3",
  },
  // Authorization: Bearer <token> / Basic <b64>.
  { re: /\b(Authorization\s*:\s*)(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, replace: "$1$2 [REDACTED]" },
  // AWS access key id.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED_AWS_KEY]" },
  // GitHub tokens (ghp_, gho_, ghs_, ghr_, github_pat_).
  { re: /\b(?:gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replace: "[REDACTED_GH_TOKEN]" },
  // Slack tokens.
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: "[REDACTED_SLACK_TOKEN]" },
  // PEM private-key blocks.
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: "[REDACTED_PRIVATE_KEY]",
  },
];

/** Redact known secret patterns from a text blob (#19, P6-3). Never throws. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replace } of REDACTION_RULES) out = out.replace(re, replace);
  return out;
}

// ---------------------------------------------------------------------------
// Curated child env (#19, P6-3) — pass a scrubbed env, not a full inherit
// ---------------------------------------------------------------------------

/**
 * Env var names always forwarded to a verify child (the minimum a shell + test
 * runner needs). Everything else is dropped so a secret injected into the parent
 * environment (CI tokens, cloud creds) is NOT handed to a verify command sourced
 * from a possibly-untrusted project. An operator who needs a specific var present
 * can export it via a wrapper script they author, keeping the allowlist explicit.
 */
/**
 * Allowlisted env-var names (the minimum a shell + test runner needs). Matched
 * CASE-INSENSITIVELY (F1): native-Windows/PowerShell surfaces `Path`/`ProgramFiles`
 * in mixed case via `Object.keys(process.env)`, and a case-sensitive Set silently
 * dropped the critical PATH var — so a `th verify run` launched from PowerShell/cmd
 * couldn't resolve `node_modules/.bin` shims, `git`, `bash`, or corp tools. The names
 * here are stored upper-cased and compared against `k.toUpperCase()`. The Windows
 * dual-cased pairs (`SystemRoot`/`SYSTEMROOT`, …) collapse to one entry under folding.
 */
const ENV_ALLOWLIST: ReadonlySet<string> = new Set(
  [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
    "TERM",
    "USER",
    "LOGNAME",
    // Windows essentials.
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "WINDIR",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    // Benign, explicitly-named tool vars a JS suite legitimately reads (R-05). These
    // are data/selectors, NOT code-injection or trust-redirect surfaces — unlike
    // NODE_OPTIONS/NODE_EXTRA_CA_CERTS/npm_config_registry, which are denied below.
    "NODE_ENV", // build/test mode selector (development|production|test)
    "FORCE_COLOR", // color-output toggle honored by node/npm/vitest
    "NO_COLOR", // de-facto standard color opt-out
    "CI", // many runners branch on this; pure boolean selector
  ].map((n) => n.toUpperCase()),
);

/**
 * Closed denylist of `NODE_*` / `npm_*` vars that turn a verify child into a code-
 * execution, TLS-trust, or supply-chain redirect surface (R-05). The pre-fix code
 * forwarded EVERY `NODE_*`/`npm_*` var verbatim, so a poisoned parent env
 * (`NODE_OPTIONS=--require /evil.js`, `NODE_EXTRA_CA_CERTS=…`, `npm_config_registry=…`)
 * injected straight into every node/npm/vitest child. We now forward NOTHING by
 * prefix: only the explicit `ENV_ALLOWLIST` members above pass. This set is kept as
 * a belt-and-suspenders tripwire (a NODE_/npm_ var that somehow reached the allowlist
 * would still be dropped) and to document the precise vectors being closed.
 *
 * Matched CASE-INSENSITIVELY (F1): Windows env-var names are case-insensitive, so a
 * `nodE_OptionS` must drop exactly like `NODE_OPTIONS`. Stored upper-cased; compared
 * against `k.toUpperCase()`. Anything matching `--inspect` (a debugger/RCE bridge) in
 * its VALUE is also dropped regardless of name (see {@link curatedEnv}).
 */
const ENV_DENYLIST: ReadonlySet<string> = new Set(
  [
    // node code-injection / module-resolution / trust
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_PATH",
    "NODE_REPL_EXTERNAL_MODULE",
    "NODE_INSPECT",
    // npm trust / supply-chain redirect / script-execution toggles
    "npm_config_registry",
    "npm_config_cafile",
    "npm_config_ca",
    "npm_config_proxy",
    "npm_config_https_proxy",
    "npm_config_https-proxy",
    "npm_config_userconfig",
    "npm_config_globalconfig",
    "npm_config_prefix",
    "npm_config_node_options",
    "npm_config_ignore_scripts",
  ].map((n) => n.toUpperCase()),
);

/**
 * Build the curated child env from `parentEnv` (default `process.env`): keep ONLY
 * explicitly-allowlisted names — never a blanket `NODE_*`/`npm_*` passthrough (R-05).
 *
 * The old open prefix (`^(?:NODE_|npm_)`) forwarded code-injection and trust-redirect
 * vars verbatim into every child (`NODE_OPTIONS=--require /evil.js`, `NODE_EXTRA_CA_CERTS`,
 * `npm_config_registry`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, …). Now a name passes iff it
 * is in {@link ENV_ALLOWLIST}; the {@link ENV_DENYLIST} and an `--inspect`-in-value check
 * are redundant tripwires that drop a dangerous var even if it were ever allowlisted.
 *
 * All name matching is CASE-INSENSITIVE (F1) so it is correct on Windows (where env
 * names are case-insensitive and surfaced in mixed case — `Path`, `ProgramFiles`): the
 * allowlisted PATH survives in any casing, and a `nodE_OptionS` is still denied. The
 * ORIGINAL key casing and value are emitted unchanged (we only case-fold the compare).
 * An operator who needs another var present exports it via a wrapper script they author,
 * keeping the allowlist explicit. Returns a plain record suitable for `spawnSync`'s `env`.
 */
export function curatedEnv(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue;
    const kUpper = k.toUpperCase();
    if (ENV_DENYLIST.has(kUpper)) continue; // tripwire: never forward a known-dangerous var
    // Drop any NODE_*/npm_* var whose VALUE tries to attach a debugger / open an RCE
    // bridge (--inspect), even under an unanticipated alias name. Scoped (case-folded)
    // to the tool-prefix family so a benign allowlisted var (PATH, etc.) is judged by name.
    if (/^(?:NODE_|NPM_)/.test(kUpper) && /--inspect\b/.test(v)) continue;
    if (ENV_ALLOWLIST.has(kUpper)) out[k] = v; // preserve original key casing + value
  }
  return out;
}

// ---------------------------------------------------------------------------
// Read-only mode (#19, P6-5) — refuse repo-mutating verification
// ---------------------------------------------------------------------------

/**
 * Conservative detector for a command that looks like it mutates the repo /
 * working tree (#19, P6-5). Best-effort, regex over the literal command string —
 * the same honest-caveat posture as the write-gate Bash heuristic: it catches the
 * common mutating shapes (writes/redirections, package installs, git mutations,
 * destructive fs commands), not every possible mutation. Used only when read-only
 * mode is requested, to refuse the run rather than execute it.
 */
export function looksRepoMutating(command: string): boolean {
  const c = command;
  // Output redirections that write a file (> / >>); `2>` etc. still write.
  if (/(^|[^0-9>])>>?\s*\S/.test(c)) return true;
  // tee, dd of=, sed -i in-place.
  if (/\btee\b/.test(c)) return true;
  if (/\bof=/.test(c)) return true;
  if (/\bsed\b[^|;&]*\s-i\b/.test(c)) return true;
  // Destructive / mutating fs verbs.
  if (/\b(rm|rmdir|mv|cp|install|mkdir|touch|chmod|chown|ln|truncate|shred)\b/.test(c)) return true;
  // Package managers that mutate the tree / lockfiles.
  if (/\b(npm|pnpm|yarn|pip|pip3|poetry|cargo|go|bundle|gem|composer)\s+(i|install|add|ci|update|upgrade|build|get|sync|vendor)\b/.test(c)) return true;
  // Git mutations (commit/push/checkout/reset/clean/...). Read-only `git status`/`log`/`diff` pass.
  if (/\bgit\s+(add|commit|push|pull|fetch|merge|rebase|reset|checkout|clean|stash|apply|am|cherry-pick|tag|branch\s+-[dD])\b/.test(c)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Process-tree kill (#19, P6-4) — kill grandchildren on timeout
// ---------------------------------------------------------------------------

/** A parent→children adjacency map plus the helper that builds it (shared by all parsers). */
type ChildrenMap = Map<number, number[]>;
function addEdge(childrenOf: ChildrenMap, parentPid: number, childPid: number): void {
  if (!Number.isInteger(parentPid) || !Number.isInteger(childPid)) return;
  const arr = childrenOf.get(parentPid) ?? [];
  arr.push(childPid);
  childrenOf.set(parentPid, arr);
}

/**
 * Parse POSIX `ps -e -o pid=,ppid=` output ("<pid> <ppid>" per line) into a
 * parent→children map. Exported for unit coverage of the parser.
 */
export function parsePsProcessTable(stdout: string): ChildrenMap {
  const childrenOf: ChildrenMap = new Map();
  for (const line of (stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    addEdge(childrenOf, Number(m[2]), Number(m[1])); // ppid, pid
  }
  return childrenOf;
}

/**
 * Parse `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId |
 * ConvertTo-Csv -NoTypeInformation` output into a parent→children map (F4). CSV is
 * used over JSON because `ConvertTo-Json` emits a bare object for a single row and an
 * array otherwise; CSV is uniformly header + quoted rows for 0/1/many. The two value
 * columns appear in selection order (ProcessId, ParentProcessId). Exported for tests.
 */
export function parseCsvProcessTable(stdout: string): ChildrenMap {
  const childrenOf: ChildrenMap = new Map();
  const lines = (stdout ?? "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return childrenOf;
  // Locate the header to know column order; tolerate a leading "#TYPE …" comment line.
  let headerIdx = lines.findIndex((l) => /ProcessId/i.test(l) && /ParentProcessId/i.test(l));
  if (headerIdx < 0) headerIdx = 0;
  const header = lines[headerIdx]!.split(",").map((c) => c.replace(/^"|"$/g, "").trim().toLowerCase());
  const pidCol = header.indexOf("processid");
  const ppidCol = header.indexOf("parentprocessid");
  if (pidCol < 0 || ppidCol < 0) return childrenOf;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = lines[i]!.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    const pid = Number(cells[pidCol]);
    const ppid = Number(cells[ppidCol]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    addEdge(childrenOf, ppid, pid);
  }
  return childrenOf;
}

/**
 * Parse legacy `wmic process get ParentProcessId,ProcessId` output (columns come back
 * alphabetically as "ParentProcessId  ProcessId", whitespace-padded, with a header row
 * skipped by the all-digits match) into a parent→children map. Exported for tests.
 */
export function parseWmicProcessTable(stdout: string): ChildrenMap {
  const childrenOf: ChildrenMap = new Map();
  for (const line of (stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    addEdge(childrenOf, Number(m[1]), Number(m[2])); // ParentProcessId, ProcessId
  }
  return childrenOf;
}

/**
 * Run a process-table snapshot command and return its stdout (or "" on failure).
 * argv-array, no `shell:true`. A module-level seam so a test can stub the command
 * matrix without spawning real processes.
 */
let runSnapshotCommand = (cmd: string, args: string[]): string => {
  const out = spawnSync(cmd, args, { encoding: "utf8" });
  return out.error ? "" : (out.stdout ?? "");
};

/** Test seam: override the snapshot command runner; returns a restore fn. */
export function __setSnapshotCommandRunner(fn: (cmd: string, args: string[]) => string): () => void {
  const prev = runSnapshotCommand;
  runSnapshotCommand = fn;
  return () => {
    runSnapshotCommand = prev;
  };
}

/**
 * Snapshot the live process table as a `parentPid → childPids` map, on both
 * platforms (R-07). POSIX uses `ps -e -o pid=,ppid=`. Windows tries, in order:
 * PowerShell `Get-CimInstance Win32_Process` (CSV), then the older `Get-WmiObject`,
 * then legacy `wmic` — because `wmic` is DEPRECATED and removed-by-default (Feature-
 * on-Demand) on recent Win11, so it may be absent (F4). The FIRST command that yields
 * a non-empty map wins. Empty map on total failure; the caller then falls back to an
 * OS-level `taskkill /T` and a single-pid kill. Never throws.
 *
 * Why a snapshot walk and not `taskkill /T` alone (the pre-fix Windows path): by the
 * time the reap runs, `spawnSync` has ALREADY SIGKILLed the direct child (the shell),
 * so `taskkill /pid <deadRoot> /T` reports "process not found" and reaps NOTHING — the
 * grandchildren (vitest workers, a dev server) leak and can hold the cwd lock. The
 * process table still records each grandchild's ParentProcessId pointing at the
 * (now-dead) intermediate, so we can reconstruct and kill the whole subtree by PID.
 */
function snapshotChildrenMap(): ChildrenMap {
  try {
    if (process.platform === "win32") {
      // PowerShell CIM is the primary path; Get-WmiObject is an older PS fallback;
      // wmic is the legacy last resort. Each yields the same CSV columns we parse.
      const psSelect = "Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation";
      const attempts: Array<{ cmd: string; args: string[]; parse: (s: string) => ChildrenMap }> = [
        {
          cmd: "powershell",
          args: ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process | ${psSelect}`],
          parse: parseCsvProcessTable,
        },
        {
          cmd: "powershell",
          args: ["-NoProfile", "-NonInteractive", "-Command", `Get-WmiObject Win32_Process | ${psSelect}`],
          parse: parseCsvProcessTable,
        },
        {
          cmd: "wmic",
          args: ["process", "get", "ParentProcessId,ProcessId"],
          parse: parseWmicProcessTable,
        },
      ];
      for (const a of attempts) {
        const map = a.parse(runSnapshotCommand(a.cmd, a.args));
        if (map.size > 0) return map;
      }
      return new Map();
    }
    return parsePsProcessTable(runSnapshotCommand("ps", ["-e", "-o", "pid=,ppid="]));
  } catch {
    // Snapshot tool unavailable → empty map; caller degrades to taskkill /T + single-pid kill.
    return new Map();
  }
}

/** SIGKILL (POSIX) / `taskkill /F` (Windows) a single pid. Best-effort — never throws. */
function killOne(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    /* already dead / not permitted — best-effort */
  }
}

/**
 * Kill the process TREE rooted at the killed child `pid` (#19, P6-4; hardened in
 * R-07). `spawnSync`'s own timeout/overflow kill only SIGKILLs the direct child
 * (the shell); a test runner or server the shell spawned (vitest workers, a dev
 * server) can survive as an orphan and hold the project cwd. This reaps the rest
 * of the tree by signalling the child's process GROUP on POSIX (the child is
 * spawned `detached`, so it leads its own group) and, on every platform, by walking
 * a live PID/PPID snapshot and killing each descendant depth-first, leaves-first,
 * then the root.
 *
 * (Historical note, now corrected: an earlier version believed `spawnSync` could not
 * detach the child, so it relied on the snapshot walk alone — which silently leaks
 * reparented grandchildren on POSIX. `spawnSync` does honour `detached`, so the group
 * signal is the real fix.) Killing the explicit group/PIDs can never reach the verify
 * process or its siblings. Best-effort — never throws.
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    // POSIX primary reap: signal the detached child's process GROUP (PGID == pid).
    // This reaches grandchildren that reparented to PID 1 when spawnSync SIGKILLed
    // the direct child — reparenting changes PPID, not the process group, so the
    // PID/PPID snapshot walk below can no longer follow them. The detached group is
    // distinct from the verify process's group, so this never signals us. The walk
    // remains as a fallback for hosts where the group signal finds nothing.
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* group already empty / not a group leader — fall through to the walk */
      }
    }
    const childrenOf = snapshotChildrenMap();
    // F4 safety net: if no snapshot was available (e.g. wmic absent AND PowerShell
    // CIM failed on a locked-down Windows host), we have no descendant PIDs to walk.
    // Attempt the OS-level recursive tree kill so a missing snapshot doesn't mean zero
    // reap. It may still find nothing if the root is already dead, but it's strictly
    // better than killing only the root — and on POSIX there's no equivalent, so we
    // just fall through to the single-pid kill. argv-array, numeric pid, no shell.
    if (childrenOf.size === 0 && process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        /* best-effort */
      }
    }
    // Depth-first: collect the whole subtree, then kill leaves-first.
    const order: number[] = [];
    const stack = [pid];
    const seen = new Set<number>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      order.push(cur);
      for (const c of childrenOf.get(cur) ?? []) stack.push(c);
    }
    for (const target of order.reverse()) killOne(target);
  } catch {
    // Best-effort cleanup; a kill failure must not crash the run.
  }
}

/**
 * Conventional exit codes recorded for a child that `spawnSync` killed (status:null).
 * 124 = command timed out (matches GNU `timeout`); we keep it ONLY for a real
 * ETIMEDOUT. A `maxBuffer` overflow (ENOBUFS) or any other non-timeout kill is NOT
 * a timeout, so it gets a DISTINCT code (R-07) — recording 124 for an overflow
 * mislabels it as a timeout and hides the leak in the report.
 */
export const EXIT_TIMEOUT = 124;
export const EXIT_OUTPUT_OVERFLOW = 125; // ENOBUFS: child produced more output than maxBuffer
export const EXIT_KILLED = 137; // 128 + SIGKILL(9): any other non-timeout kill (status null)

export interface RunCommandsOptions {
  now?: () => Date;
  timeoutMs?: number;
  /** Curated env to pass to each child (default {@link curatedEnv}()). */
  env?: NodeJS.ProcessEnv;
  /** When true, refuse to execute a command that looks repo-mutating (#19, P6-5). Set by --no-obvious-writes (deprecated alias --read-only). */
  readOnly?: boolean;
  /**
   * Max bytes of combined stdout+stderr buffered per child before `spawnSync` kills
   * it with ENOBUFS (default 64 MiB). Exposed mainly so tests can force the overflow
   * path; production callers keep the default.
   */
  maxBuffer?: number;
  /**
   * Seam for the process-tree reap (default {@link killProcessTree}). Injectable so a
   * test can assert the reap fires on every killed-child path without spawning a real
   * grandchild on every platform. Production callers never set this.
   */
  killTree?: (pid: number) => void;
}

/**
 * Execute each command in order via the shell, in `root`. Stops nothing — every
 * command runs so the report is complete — but `ok` is false if any fail. A
 * command that cannot be spawned is recorded as a failure (exit 127) rather than
 * throwing. Each command is bounded by `timeoutMs` (default
 * {@link DEFAULT_COMMAND_TIMEOUT_MS}): a process that exceeds it is killed —
 * together with its whole process tree (#19, P6-4) so grandchildren die — and
 * recorded as a failure, so a hanging command can never block the run forever.
 * stdin is closed (`input: ""`) so a command that reads stdin gets EOF instead of
 * blocking.
 *
 * Kill paths (R-07): the process-tree reap fires on ANY child that `spawnSync`
 * killed (status null with a pid) — a timeout (ETIMEDOUT), a `maxBuffer` overflow
 * (ENOBUFS), or any other non-completion — so grandchildren never leak. The recorded
 * exit code is HONEST: {@link EXIT_TIMEOUT} (124) ONLY for a real timeout,
 * {@link EXIT_OUTPUT_OVERFLOW} (125) for an output overflow, {@link EXIT_KILLED} (137)
 * for any other kill — never 124 for a non-timeout.
 *
 * Hardening (#19): the child env is curated (not a full inherit; P6-3); the
 * recorded `outputTail` is secret-redacted (P6-3); and in `readOnly` mode (P6-5) a
 * command that looks repo-mutating is refused (recorded as a failure) rather than
 * executed.
 *
 * Back-compat: the legacy positional signature `runCommands(root, commands, now,
 * timeoutMs)` is still accepted; an options object is preferred.
 */
export function runCommands(
  root: string,
  commands: string[],
  nowOrOpts: (() => Date) | RunCommandsOptions = () => new Date(),
  timeoutMsArg: number = DEFAULT_COMMAND_TIMEOUT_MS,
): VerifyReport {
  const opts: RunCommandsOptions =
    typeof nowOrOpts === "function" ? { now: nowOrOpts, timeoutMs: timeoutMsArg } : nowOrOpts;
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const env = opts.env ?? curatedEnv();
  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
  const killTree = opts.killTree ?? killProcessTree;

  const results: VerifyResult[] = [];
  for (const command of commands) {
    // Best-effort write blocker (#19, P6-5, R-32): refuse obvious repo-mutating commands when --no-obvious-writes is set.
    if (opts.readOnly && looksRepoMutating(command)) {
      results.push({
        command,
        exitCode: 126, // conventional "command found but not executable/permitted"
        ok: false,
        durationMs: 0,
        outputTail:
          "[th verify] refused in --no-obvious-writes mode: this command looks like it mutates the repo/working tree " +
          "(write/redirection, package install, git mutation, or destructive fs verb). " +
          "This is a best-effort heuristic, not a security boundary. " +
          "Remove --no-obvious-writes to run it, or configure a non-mutating verification command.",
      });
      continue;
    }

    const start = Date.now();
    const spawnOpts: SpawnSyncOptionsWithStringEncoding = {
      cwd: root,
      shell: true,
      encoding: "utf8",
      maxBuffer,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      input: "",
      env,
    };
    // R-07 (POSIX grandchild reap): start the child in its OWN session/process group.
    // spawnSync DOES honour `detached` at runtime — libuv sets UV_PROCESS_DETACHED and
    // calls setsid() in the child, so the shell becomes a group leader (PGID == its
    // pid) and every descendant inherits that group. When the timeout SIGKILLs the
    // direct child, grandchildren reparent to PID 1 (breaking the PPID chain a
    // snapshot-walk follows) but KEEP their process group, so signalling the group by
    // `-pid` in killProcessTree still reaches them. The new group is distinct from the
    // verify process's group, so the group signal can never hit us. Windows is excluded
    // (no setsid/reparenting; it uses taskkill /T). `detached` is absent from
    // @types/node's SpawnSyncOptions despite being honoured, so it is set through a
    // narrow cast that leaves the known options fully type-checked above.
    (spawnOpts as { detached?: boolean }).detached = process.platform !== "win32";
    const proc = spawnSync(command, spawnOpts);
    const durationMs = Date.now() - start;
    const errCode = (proc.error as NodeJS.ErrnoException | undefined)?.code;
    // A timeout kill surfaces as ETIMEDOUT; a maxBuffer overflow as ENOBUFS — BOTH
    // leave status null with the direct child already SIGKILLed (R-07).
    const timedOut = errCode === "ETIMEDOUT";
    const outputOverflow = errCode === "ENOBUFS";
    // Reap the tree on ANY killed/failed-to-complete child (status null with a pid),
    // not just on timeout — the pre-fix code skipped the reap on ENOBUFS, leaking
    // grandchildren (vitest workers, dev servers) that could hold the cwd lock (R-07).
    if (proc.status === null && typeof proc.pid === "number") {
      // spawnSync already SIGKILLed the direct child; reap the rest of the tree so
      // a grandchild can't linger and hold the cwd (#19, P6-4; widened in R-07).
      killTree(proc.pid);
    }
    // Append an honest reason note — a timeout ONLY when it really timed out; an
    // output-overflow note for ENOBUFS; a generic kill note for any other null-status
    // termination. Never claim "timeout" for a non-timeout (R-07).
    const reasonNote = timedOut
      ? `\n[th verify] command (and its process tree) killed after ${timeoutMs}ms timeout`
      : outputOverflow
        ? `\n[th verify] command (and its process tree) killed: output exceeded the ${maxBuffer}-byte buffer (ENOBUFS)`
        : proc.status === null
          ? `\n[th verify] command (and its process tree) killed before completion${errCode ? ` (${errCode})` : ""}`
          : "";
    const combined = `${proc.stdout ?? ""}${proc.stderr ?? ""}${reasonNote}`;
    // Redact secrets BEFORE truncation so a redaction that straddles the tail
    // boundary still applies, then take the tail (#19, P6-3).
    const redacted = redactSecrets(combined);
    const outputTail = redacted.length > OUTPUT_TAIL_CHARS ? redacted.slice(-OUTPUT_TAIL_CHARS) : redacted;
    // spawnSync returns status null when the process was killed or failed to spawn.
    // Record an HONEST exit code: 124 ONLY for a real timeout; a distinct code for an
    // output-overflow or any other non-timeout kill so the report can tell them apart.
    const exitCode =
      proc.status ??
      (timedOut ? EXIT_TIMEOUT : outputOverflow ? EXIT_OUTPUT_OVERFLOW : EXIT_KILLED);
    results.push({ command, exitCode, ok: proc.status === 0, durationMs, outputTail });
  }
  return {
    ok: results.every((r) => r.ok),
    ranAt: now().toISOString(),
    results,
  };
}
