"use strict";
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
exports.DEFAULT_COMMAND_TIMEOUT_MS = void 0;
exports.verifyConfigPath = verifyConfigPath;
exports.verifyReportPath = verifyReportPath;
exports.commandSetHash = commandSetHash;
exports.loadVerifyConfig = loadVerifyConfig;
exports.readVerifyConfig = readVerifyConfig;
exports.writeVerifyConfig = writeVerifyConfig;
exports.verifyApprovalsPath = verifyApprovalsPath;
exports.approvalCanonicalText = approvalCanonicalText;
exports.readVerifyApprovals = readVerifyApprovals;
exports.verifyApprovalChain = verifyApprovalChain;
exports.appendVerifyApproval = appendVerifyApproval;
exports.evaluateCommandSetApproval = evaluateCommandSetApproval;
exports.isCommandSetApproved = isCommandSetApproved;
exports.latestApprovalFor = latestApprovalFor;
exports.readVerifyReport = readVerifyReport;
exports.writeVerifyReport = writeVerifyReport;
exports.redactSecrets = redactSecrets;
exports.curatedEnv = curatedEnv;
exports.looksRepoMutating = looksRepoMutating;
exports.killProcessTree = killProcessTree;
exports.runCommands = runCommands;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const paths_1 = require("./paths");
const atomic_io_1 = require("./atomic-io");
const hash_1 = require("./hash");
const jsonl_1 = require("./jsonl");
const OUTPUT_TAIL_CHARS = 2000;
/**
 * Per-command wall-clock budget (ms). A configured command that hangs (a watch
 * mode, a server, a process waiting on stdin, a deadlocked test) would otherwise
 * block `th verify run` forever; the timeout kills it and records a failure so
 * the run always terminates. 5 minutes is generous for a real test suite.
 */
exports.DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
function verifyConfigPath(paths) {
    return path.join(paths.stateDir, "verify.json");
}
function verifyReportPath(paths) {
    return path.join(paths.stateDir, "verify-report.json");
}
/**
 * The stable hash of an ordered command set (#19, P6-2). Used to detect a
 * new/changed set that must be re-confirmed before execution. Hash the JSON array
 * (order-sensitive — reordering changes which command runs first, a meaningful
 * change) of the trimmed commands.
 */
function commandSetHash(commands) {
    return (0, node_crypto_1.createHash)("sha256").update(JSON.stringify(commands), "utf8").digest("hex");
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
function loadVerifyConfig(paths) {
    const file = verifyConfigPath(paths);
    if (!fs.existsSync(file))
        return { status: "absent", config: { commands: [] } };
    let raw;
    try {
        raw = (0, atomic_io_1.readFileWithRetry)(file);
    }
    catch {
        // Present a moment ago but unreadable after the retry budget (e.g. removed
        // mid-read) → treat as absent: there are no bytes to misjudge as corrupt.
        return { status: "absent", config: { commands: [] } };
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.commands)) {
            const obj = parsed;
            const commands = obj.commands.filter((c) => typeof c === "string");
            const config = { commands };
            if (Array.isArray(obj.provenance)) {
                config.provenance = obj.provenance.filter((p) => p != null && typeof p.command === "string");
            }
            return { status: "ok", config };
        }
        // Present + parseable but the wrong shape (no commands array) → corrupt.
        return { status: "corrupt", config: { commands: [] } };
    }
    catch {
        // Present but unparseable JSON → corrupt. Fail CLOSED at the run gate; never
        // silently degrade to "no commands / approved-empty" as the old reader did.
        return { status: "corrupt", config: { commands: [] } };
    }
}
/** Read the configured commands. Missing/corrupt file → empty command list (the
 * back-compat shape). Callers that must DISTINGUISH a corrupt config (to fail
 * closed) use {@link loadVerifyConfig} directly. */
function readVerifyConfig(paths) {
    return loadVerifyConfig(paths).config;
}
/**
 * Write verify.json atomically + through the governed write-surface chokepoint
 * (R-03 — was a bare `fs.writeFileSync`, torn-readable and ungoverned). The
 * command layer serializes concurrent mutations via `withStateLock`;
 * {@link atomicWriteFile} threads `paths.root` so the target is asserted in-surface
 * and the temp→fsync→rename→dir-fsync barrier makes a torn read impossible.
 */
function writeVerifyConfig(paths, config) {
    (0, atomic_io_1.atomicWriteFile)(verifyConfigPath(paths), JSON.stringify(config, null, 2) + "\n", { root: paths.root });
}
function verifyApprovalsPath(paths) {
    return path.join(paths.stateDir, "verify-approvals.jsonl");
}
/** Fixed canonical field order for hashing (deterministic JSON; recordHash omitted). */
const APPROVAL_FIELD_ORDER = [
    "approvedHash",
    "commandCount",
    "approvedBy",
    "approvedAt",
    "prevHash",
];
/** Deterministic canonical text of an approval event for hashing (recordHash omitted). */
function approvalCanonicalText(event) {
    const ordered = {};
    for (const key of APPROVAL_FIELD_ORDER) {
        const val = event[key];
        if (val === undefined)
            continue;
        ordered[key] = val;
    }
    return JSON.stringify(ordered);
}
/** `recordHash` of an approval event = SHA-256 of its canonical text. */
function approvalRecordHash(event) {
    return (0, hash_1.hashContent)(approvalCanonicalText(event));
}
/** Validate a parsed approval line; malformed lines are skipped by the reader. */
function isValidApprovalEvent(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const e = parsed;
    if (typeof e.approvedHash !== "string" || !hash_1.HEX64.test(e.approvedHash))
        return false;
    if (typeof e.commandCount !== "number")
        return false;
    if (typeof e.approvedBy !== "string")
        return false;
    if (typeof e.approvedAt !== "string")
        return false;
    if (typeof e.prevHash !== "string" || !hash_1.HEX64.test(e.prevHash))
        return false;
    if (typeof e.recordHash !== "string" || !hash_1.HEX64.test(e.recordHash))
        return false;
    return true;
}
/** Read every approval event in file order. Missing file → []. Bad lines skipped. */
function readVerifyApprovals(paths) {
    return (0, jsonl_1.readJsonlValues)(verifyApprovalsPath(paths), isValidApprovalEvent);
}
/** The recordHash of the last VALID approval event, or GENESIS when none (tail parse). */
function lastApprovalRecordHash(paths) {
    const last = (0, jsonl_1.scanTailValid)(verifyApprovalsPath(paths), isValidApprovalEvent);
    return last ? last.recordHash : hash_1.GENESIS_PREV_HASH;
}
/**
 * Walk approval events with a running `expectedPrev`. A recomputed recordHash that
 * does not match → the record was edited (a forged field); `prevHash !== expectedPrev`
 * → inserted/deleted/reordered. Returns the FIRST break. Mirrors decisions' verifyChain.
 */
function verifyApprovalChain(events) {
    let expectedPrev = hash_1.GENESIS_PREV_HASH;
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const { recordHash, ...rest } = e;
        if (approvalRecordHash(rest) !== recordHash)
            return { ok: false, brokenAt: i, reason: "edited" };
        if (e.prevHash !== expectedPrev)
            return { ok: false, brokenAt: i, reason: "prev_mismatch" };
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
function appendVerifyApproval(paths, record) {
    (0, paths_1.assertGovernedWriteSurface)(paths.root, verifyApprovalsPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const prevHash = lastApprovalRecordHash(paths);
    const withPrev = { ...record, prevHash };
    const recordHash = approvalRecordHash(withPrev);
    const sealed = { ...withPrev, recordHash };
    fs.appendFileSync(verifyApprovalsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
    return sealed;
}
/**
 * Evaluate whether `commands` is approved for execution against the tamper-evident
 * ledger (R-02). An empty set is trivially approved (nothing to run). Otherwise the
 * ledger chain is verified FIRST and a break fails CLOSED (`chain_broken` →
 * unapproved). A set is approved iff the LATEST valid approval event's `approvedHash`
 * equals `commandSetHash(commands)` — so any `add`/`clear` that changed the set since
 * the last approval (the ledger is touched ONLY by `approve`) leaves the latest
 * approval pointing at a different hash → unapproved until re-confirmed.
 */
function evaluateCommandSetApproval(paths, commands) {
    if (commands.length === 0)
        return { approved: true, reason: "empty" };
    const events = readVerifyApprovals(paths);
    if (!verifyApprovalChain(events).ok)
        return { approved: false, reason: "chain_broken" };
    const last = events.length ? events[events.length - 1] : undefined;
    if (last && last.approvedHash === commandSetHash(commands))
        return { approved: true, reason: "approved" };
    return { approved: false, reason: "unapproved" };
}
/**
 * Whether the current command set has been approved for execution (P1/R-02). A
 * non-empty set is approved only when the tamper-evident ledger's latest event
 * matches it on an unbroken chain; an empty set is trivially approved (nothing to
 * run). Reads the ledger; the caller passes `paths` + the current `commands`.
 */
function isCommandSetApproved(paths, commands) {
    return evaluateCommandSetApproval(paths, commands).approved;
}
/** The latest valid approval event matching `commands` (for audit display), or undefined. */
function latestApprovalFor(paths, commands) {
    if (commands.length === 0)
        return undefined;
    const events = readVerifyApprovals(paths);
    if (!verifyApprovalChain(events).ok)
        return undefined;
    const last = events.length ? events[events.length - 1] : undefined;
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
function readVerifyReport(paths) {
    const file = verifyReportPath(paths);
    if (!fs.existsSync(file))
        return null;
    let raw;
    try {
        raw = (0, atomic_io_1.readFileWithRetry)(file);
    }
    catch {
        // The file existed a moment ago but the read still failed after the retry
        // budget (e.g. it was removed mid-read) → treat as absent.
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
            return parsed;
        }
    }
    catch {
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
function writeVerifyReport(paths, report) {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    (0, atomic_io_1.atomicWriteFile)(verifyReportPath(paths), JSON.stringify(report, null, 2) + "\n", { root: paths.root });
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
const REDACTION_RULES = [
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
function redactSecrets(text) {
    let out = text;
    for (const { re, replace } of REDACTION_RULES)
        out = out.replace(re, replace);
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
const ENV_ALLOWLIST = new Set([
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
function curatedEnv(parentEnv = process.env) {
    const out = {};
    for (const [k, v] of Object.entries(parentEnv)) {
        if (v === undefined)
            continue;
        if (ENV_ALLOWLIST.has(k) || /^(?:NODE_|npm_)/.test(k))
            out[k] = v;
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
function looksRepoMutating(command) {
    const c = command;
    // Output redirections that write a file (> / >>); `2>` etc. still write.
    if (/(^|[^0-9>])>>?\s*\S/.test(c))
        return true;
    // tee, dd of=, sed -i in-place.
    if (/\btee\b/.test(c))
        return true;
    if (/\bof=/.test(c))
        return true;
    if (/\bsed\b[^|;&]*\s-i\b/.test(c))
        return true;
    // Destructive / mutating fs verbs.
    if (/\b(rm|rmdir|mv|cp|install|mkdir|touch|chmod|chown|ln|truncate|shred)\b/.test(c))
        return true;
    // Package managers that mutate the tree / lockfiles.
    if (/\b(npm|pnpm|yarn|pip|pip3|poetry|cargo|go|bundle|gem|composer)\s+(i|install|add|ci|update|upgrade|build|get|sync|vendor)\b/.test(c))
        return true;
    // Git mutations (commit/push/checkout/reset/clean/...). Read-only `git status`/`log`/`diff` pass.
    if (/\bgit\s+(add|commit|push|pull|fetch|merge|rebase|reset|checkout|clean|stash|apply|am|cherry-pick|tag|branch\s+-[dD])\b/.test(c))
        return true;
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
function killProcessTree(pid) {
    if (!pid || pid <= 0)
        return;
    try {
        if (process.platform === "win32") {
            (0, node_child_process_1.spawnSync)("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
            return;
        }
        // Build a pid → children map from `ps -e -o pid=,ppid=` (POSIX-portable).
        const childrenOf = new Map();
        try {
            const out = (0, node_child_process_1.spawnSync)("ps", ["-e", "-o", "pid=,ppid="], { encoding: "utf8" });
            for (const line of (out.stdout ?? "").split("\n")) {
                const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
                if (!m)
                    continue;
                const childPid = Number(m[1]);
                const parentPid = Number(m[2]);
                const arr = childrenOf.get(parentPid) ?? [];
                arr.push(childPid);
                childrenOf.set(parentPid, arr);
            }
        }
        catch {
            // `ps` unavailable → fall back to single-pid kill below.
        }
        // Depth-first: collect the whole subtree, then SIGKILL leaves-first.
        const order = [];
        const stack = [pid];
        const seen = new Set();
        while (stack.length) {
            const cur = stack.pop();
            if (seen.has(cur))
                continue;
            seen.add(cur);
            order.push(cur);
            for (const c of childrenOf.get(cur) ?? [])
                stack.push(c);
        }
        for (const target of order.reverse()) {
            try {
                process.kill(target, "SIGKILL");
            }
            catch {
                /* already dead / not permitted — best-effort */
            }
        }
    }
    catch {
        // Best-effort cleanup; a kill failure must not crash the run.
    }
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
function runCommands(root, commands, nowOrOpts = () => new Date(), timeoutMsArg = exports.DEFAULT_COMMAND_TIMEOUT_MS) {
    const opts = typeof nowOrOpts === "function" ? { now: nowOrOpts, timeoutMs: timeoutMsArg } : nowOrOpts;
    const now = opts.now ?? (() => new Date());
    const timeoutMs = opts.timeoutMs ?? exports.DEFAULT_COMMAND_TIMEOUT_MS;
    const env = opts.env ?? curatedEnv();
    const results = [];
    for (const command of commands) {
        // Read-only refusal (#19, P6-5): never execute an apparently-mutating command.
        if (opts.readOnly && looksRepoMutating(command)) {
            results.push({
                command,
                exitCode: 126, // conventional "command found but not executable/permitted"
                ok: false,
                durationMs: 0,
                outputTail: "[th verify] refused in --read-only mode: this command looks like it mutates the repo/working tree " +
                    "(write/redirection, package install, git mutation, or destructive fs verb). " +
                    "Remove --read-only to run it, or configure a non-mutating verification command.",
            });
            continue;
        }
        const start = Date.now();
        const proc = (0, node_child_process_1.spawnSync)(command, {
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
        const timedOut = proc.error?.code === "ETIMEDOUT";
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
