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
 *   - an optional read-only mode that refuses repo-mutating verification.
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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ProjectPaths } from "./paths";
import { assertGovernedWriteSurface } from "./paths";
import { atomicWriteFile, readFileWithRetry } from "./atomic-io";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";
import { readJsonlValues, scanTailValid } from "./jsonl";

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
const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
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
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
]);

/**
 * Build the curated child env from `parentEnv` (default `process.env`): keep only
 * allowlisted names; carry through a tool-prefix family (`NODE_*`, `npm_*`) that a
 * JS test suite commonly relies on, but never blanket-inherit. Returns a plain
 * record suitable for `spawnSync`'s `env`.
 */
export function curatedEnv(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue;
    if (ENV_ALLOWLIST.has(k) || /^(?:NODE_|npm_)/.test(k)) out[k] = v;
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

/**
 * Kill the process TREE rooted at the timed-out child `pid` (#19, P6-4).
 * `spawnSync`'s own timeout only SIGKILLs the direct child (the shell); a test
 * runner or server the shell spawned (vitest workers, a dev server) can survive
 * as an orphan and hold the project cwd. This reaps the rest of the tree.
 *
 * Windows: `taskkill /pid <pid> /T /F` — a real recursive tree kill (the case the
 * original code missed entirely; spawnSync's SIGKILL on Windows does not cascade).
 *
 * POSIX: `spawnSync` cannot put the child in its own detached process group (that
 * option is `spawn`-only), so the child shares OUR group — signalling `-ourGroup`
 * would suicide. We instead reap descendants by walking the child's children from
 * `ps` (PID/PPID) and SIGKILLing each, depth-first, then the child itself. We never
 * signal a process group, so this can never kill the verify process or its siblings.
 * Best-effort — never throws.
 */
export function killProcessTree(pid: number): void {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    // Build a pid → children map from `ps -e -o pid=,ppid=` (POSIX-portable).
    const childrenOf = new Map<number, number[]>();
    try {
      const out = spawnSync("ps", ["-e", "-o", "pid=,ppid="], { encoding: "utf8" });
      for (const line of (out.stdout ?? "").split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (!m) continue;
        const childPid = Number(m[1]);
        const parentPid = Number(m[2]);
        const arr = childrenOf.get(parentPid) ?? [];
        arr.push(childPid);
        childrenOf.set(parentPid, arr);
      }
    } catch {
      // `ps` unavailable → fall back to single-pid kill below.
    }
    // Depth-first: collect the whole subtree, then SIGKILL leaves-first.
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
    for (const target of order.reverse()) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        /* already dead / not permitted — best-effort */
      }
    }
  } catch {
    // Best-effort cleanup; a kill failure must not crash the run.
  }
}

export interface RunCommandsOptions {
  now?: () => Date;
  timeoutMs?: number;
  /** Curated env to pass to each child (default {@link curatedEnv}()). */
  env?: NodeJS.ProcessEnv;
  /** When true, refuse to execute a command that looks repo-mutating (#19, P6-5). */
  readOnly?: boolean;
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

  const results: VerifyResult[] = [];
  for (const command of commands) {
    // Read-only refusal (#19, P6-5): never execute an apparently-mutating command.
    if (opts.readOnly && looksRepoMutating(command)) {
      results.push({
        command,
        exitCode: 126, // conventional "command found but not executable/permitted"
        ok: false,
        durationMs: 0,
        outputTail:
          "[th verify] refused in --read-only mode: this command looks like it mutates the repo/working tree " +
          "(write/redirection, package install, git mutation, or destructive fs verb). " +
          "Remove --read-only to run it, or configure a non-mutating verification command.",
      });
      continue;
    }

    const start = Date.now();
    const proc = spawnSync(command, {
      cwd: root,
      shell: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      input: "",
      env,
    });
    const durationMs = Date.now() - start;
    // A timeout kill surfaces as proc.error with code ETIMEDOUT and a null status.
    const timedOut = (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    if (timedOut && typeof proc.pid === "number") {
      // spawnSync already SIGKILLed the direct child; reap the rest of the tree so
      // a grandchild (test runner, server) can't linger and hold the cwd (#19, P6-4).
      killProcessTree(proc.pid);
    }
    const combined = `${proc.stdout ?? ""}${proc.stderr ?? ""}${timedOut ? `\n[th verify] command (and its process tree) killed after ${timeoutMs}ms timeout` : ""}`;
    // Redact secrets BEFORE truncation so a redaction that straddles the tail
    // boundary still applies, then take the tail (#19, P6-3).
    const redacted = redactSecrets(combined);
    const outputTail = redacted.length > OUTPUT_TAIL_CHARS ? redacted.slice(-OUTPUT_TAIL_CHARS) : redacted;
    // spawnSync returns status null when the process was killed or failed to spawn.
    const exitCode = proc.status ?? 124; // 124 = conventional timeout/kill exit code
    results.push({ command, exitCode, ok: proc.status === 0, durationMs, outputTail });
  }
  return {
    ok: results.every((r) => r.ok),
    ranAt: now().toISOString(),
    results,
  };
}
