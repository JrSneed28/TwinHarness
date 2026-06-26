"use strict";
/**
 * `th decision …` — the decision-governance CLI handlers (SLICE-4).
 *
 * Five handlers, each a convention-conformant `CommandResult` handler (Critical
 * Pattern 1 / REQ-NFR-008): `paths` first, typed opts second, returns
 * `success()`/`failure()` (never throws, never `process.exit`), and emits exactly
 * ONE `structuredLog` per invocation.
 *
 *   runDecisionAdd      (IF-002) — append a `proposed` event; mint id; audit trail.
 *   runDecisionDetect   (IF-005) — read-only candidate surfacing (never writes).
 *   runDecisionList     (IF-006) — sorted read model with audit fields.
 *   runDecisionApprove  (IF-003) — the non-self-approval TTY barrier + state machine.
 *   runDecisionCheck    (IF-004) — the single gating predicate; exit 0/6.
 *
 * The hash-chained store lives in `src/core/decisions.ts`; writes go through
 * `appendDecisionEvent` under `withStateLock`. The gating predicate
 * `gatingObligations` is the SINGLE source of truth (RULE-007) — `check` and the
 * `th next` rung call the same function.
 *
 * `th decision approve` is HUMAN-ONLY and is NEVER exposed as an MCP tool
 * (RULE-011): there is no code path from MCP to `runDecisionApprove`.
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
exports.DECISION_GATE_EXIT = void 0;
exports.runDecisionAdd = runDecisionAdd;
exports.runDecisionDetect = runDecisionDetect;
exports.runDecisionList = runDecisionList;
exports.requireTTYConfirmation = requireTTYConfirmation;
exports.captureApprovalProvenance = captureApprovalProvenance;
exports.runDecisionApprove = runDecisionApprove;
exports.runDecisionCheck = runDecisionCheck;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const tty = __importStar(require("node:tty"));
const output_1 = require("../core/output");
const log_1 = require("../core/log");
const state_store_1 = require("../core/state-store");
const state_store_2 = require("../core/state-store");
const decisions_1 = require("../core/decisions");
const decision_key_1 = require("../core/decision-key");
const receipts_1 = require("../core/receipts");
/** `th decision check` exit code when an unapproved decision gates the stage (IF-004). */
exports.DECISION_GATE_EXIT = 6;
/** Parse a comma-separated flag value the same way `--components` is parsed. */
function parseList(raw) {
    if (!raw)
        return [];
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
/**
 * `th decision add` — record one `proposed` decision, mint the next id, set the
 * proposer/proposedAt audit trail (REQ-402, REQ-413). Never auto-approves.
 *
 * Anchor: REQ-402 — records `proposed`; mints id; never auto-approves.
 * Anchor: REQ-413 — audit: proposer + proposedAt on the proposed event.
 * Anchor: REQ-NFR-008 — paths-first; one structuredLog; returns CommandResult.
 */
function runDecisionAdd(paths, opts = {}) {
    const title = opts.title?.trim();
    const rationale = opts.rationale?.trim();
    // Validate required fields BEFORE any write (no append on a missing field).
    if (!title) {
        (0, log_1.structuredLog)({ cmd: "decision add", error: "missing_field", field: "title" });
        return (0, output_1.failure)({
            human: "Missing required --title.",
            data: { error: "missing_field", field: "title" },
        });
    }
    if (!rationale) {
        (0, log_1.structuredLog)({ cmd: "decision add", error: "missing_field", field: "rationale" });
        return (0, output_1.failure)({
            human: "Missing required --rationale.",
            data: { error: "missing_field", field: "rationale" },
        });
    }
    // Canonicalize stage links at record time (F-6 item 2c) so a `stage:` near-miss
    // is stored canonically and a gating decision keeps gating after current_stage
    // is normalized.
    const links = (opts.links ?? []).map(decisions_1.canonicalizeLink);
    const proposer = opts.proposer?.trim() || "orchestrator";
    const now = opts.now ?? (() => new Date());
    // Read-modify-append serialized via withStateLock (the proven primitive).
    const sealed = (0, state_store_2.withStateLock)(paths, () => {
        const id = (0, decisions_1.mintNextId)((0, decisions_1.readDecisionEvents)(paths));
        return (0, decisions_1.appendDecisionEvent)(paths, {
            id,
            event: "proposed",
            title,
            rationale,
            links,
            proposer,
            proposedAt: now().toISOString(),
        });
    });
    // P6-6 (#16) — discourage `stage:` links on reversible choices. A `stage:` link
    // makes the decision GATE that stage until it is approved (and it keeps gating
    // even if later rejected/superseded — only approve clears it). For a reversible
    // choice that doesn't truly need to block a stage, prefer a traceability link
    // (REQ-/ADR-) instead. Surfaced as an advisory `stageLink` warning at the add
    // surface; never blocks (the operator may legitimately want the gate).
    const stageLinks = links.filter((l) => l.startsWith("stage:"));
    const stageWarning = stageLinks.length > 0
        ? ` (advisory: ${stageLinks.join(", ")} will GATE that stage until this decision is APPROVED — ` +
            `rejecting/superseding does NOT clear the gate. Use a stage link only for a choice that must ` +
            `block the stage; for a reversible choice prefer a REQ-/ADR- traceability link.)`
        : "";
    (0, log_1.structuredLog)({ cmd: "decision add", id: sealed.id, status: "proposed", links: links.length });
    return (0, output_1.success)({
        data: { id: sealed.id, status: "proposed", links, stageLinks },
        human: `Recorded ${sealed.id} (proposed).${stageWarning}`,
    });
}
/** Extract the first `# ` heading from a markdown body (the title). */
function firstHeading(body) {
    for (const line of body.split(/\r?\n/)) {
        const m = /^#\s+(.+?)\s*$/.exec(line);
        if (m)
            return m[1];
    }
    return undefined;
}
/**
 * `th decision detect` — surface advisory `DecisionCandidate[]` from four
 * deterministic on-disk sources (ADRs, drift-log, scope-change signals,
 * state.json blast-radius flags). Read-only/advisory: exit 0 ALWAYS; NEVER
 * appends, approves, or writes any state (REQ-405, RULE-006).
 *
 * Anchor: REQ-405 — read-only candidate surfacing from four sources; never writes.
 * Anchor: REQ-NFR-008 — paths-first; one structuredLog; returns CommandResult.
 */
function runDecisionDetect(paths, _opts = {}) {
    const candidates = [];
    // 1. ADR files — docs/05-adrs/ADR-NNN-*.md; one candidate per file.
    const adrDir = path.join(paths.docsDir, "05-adrs");
    try {
        const entries = fs.readdirSync(adrDir).filter((f) => /^ADR-\d+.*\.md$/.test(f)).sort();
        for (const f of entries) {
            const rel = path.posix.join("docs/05-adrs", f);
            let title = f;
            try {
                const heading = firstHeading(fs.readFileSync(path.join(adrDir, f), "utf8"));
                if (heading)
                    title = heading;
            }
            catch {
                // Unreadable ADR — fall back to the filename as the title.
            }
            candidates.push({ title, source: "adr", sourceRef: rel });
        }
    }
    catch {
        // No ADR directory — no ADR candidates.
    }
    // 2. Drift-log entries — one candidate per distinct DRIFT-NNN heading.
    try {
        const driftBody = fs.readFileSync(paths.driftLog, "utf8");
        const seen = new Set();
        for (const line of driftBody.split(/\r?\n/)) {
            const m = /^##\s+(DRIFT-\d+)\b(.*)$/.exec(line);
            if (!m)
                continue;
            const id = m[1];
            // Skip resolution headings ("## DRIFT-001 — resolved") and repeats.
            if (/—\s*resolved/i.test(m[2] ?? ""))
                continue;
            if (seen.has(id))
                continue;
            seen.add(id);
            candidates.push({
                title: `Drift entry ${id}: ${m[2]?.replace(/^\s*[—-]\s*/, "").trim() || "scope-affecting change"}`,
                source: "drift-log",
                sourceRef: id,
                rationale: "Drift entry signals a change that may constitute a significant run choice.",
            });
        }
    }
    catch {
        // No drift-log — no drift candidates.
    }
    // 3. Scope-change signal — at most one candidate from docs/02-scope.md.
    try {
        const scopeBody = fs.readFileSync(path.join(paths.docsDir, "02-scope.md"), "utf8");
        if (/(^##\s+Changes\b)|(^\s*(ADDED|CHANGED):)/m.test(scopeBody)) {
            candidates.push({
                title: "Scope signal: a post-requirements scope change is recorded",
                source: "scope-change",
                sourceRef: "docs/02-scope.md",
                rationale: "Scope document contains change markers indicating a scope addition/change.",
            });
        }
    }
    catch {
        // No scope doc — no scope-change candidate.
    }
    // 4. Blast-radius flags — one candidate per state.json blast_radius_flags[N].
    const stateResult = (0, state_store_1.readState)(paths);
    const flags = stateResult.state?.blast_radius_flags ?? [];
    flags.forEach((flag, i) => {
        candidates.push({
            title: `Blast-radius flag: ${flag}`,
            source: "blast-radius-flag",
            sourceRef: `state.json:blast_radius_flags[${i}]`,
            rationale: "A blast-radius flag indicates a high-impact choice warranting a formal decision.",
            suggestedLinks: ["stage:architecture"],
        });
    });
    (0, log_1.structuredLog)({ cmd: "decision detect", candidates: candidates.length });
    return (0, output_1.success)({
        data: { candidates },
        human: candidates.length === 0
            ? "No decision candidates detected."
            : `Detected ${candidates.length} decision candidate(s).`,
    });
}
/** Project a reduced Decision into the list output shape (omit N/A fields). */
function listShape(d) {
    const out = {
        id: d.id,
        title: d.title,
        rationale: d.rationale,
        status: d.status,
        links: d.links,
    };
    if (d.proposer !== undefined)
        out.proposer = d.proposer;
    if (d.proposedAt !== undefined)
        out.proposedAt = d.proposedAt;
    // Approver/approvedAt present only once a transition has occurred.
    if (d.status !== "proposed") {
        if (d.approver !== undefined)
            out.approver = d.approver;
        if (d.approvedAt !== undefined)
            out.approvedAt = d.approvedAt;
        // Provenance (#17, D3) — the observed source of the approval. Surfaced so a
        // reviewer can see an UNATTRIBUTED (attributionSuspect) approval at a glance.
        if (d.provenance !== undefined)
            out.provenance = d.provenance;
    }
    if (d.status === "superseded" && d.supersededBy !== undefined)
        out.supersededBy = d.supersededBy;
    return out;
}
/**
 * `th decision list` — the reduced decision set, sorted by numeric id suffix
 * (deterministic — REQ-NFR-002). Exit 0 always. Audit fields appear only when
 * applicable to the status.
 *
 * Anchor: REQ-406 — sorted read model (ids/titles/statuses/links/audit).
 * Anchor: REQ-NFR-008 — paths-first; one structuredLog; returns CommandResult.
 */
function runDecisionList(paths, _opts = {}) {
    const events = (0, decisions_1.readDecisionEvents)(paths);
    // Fail closed on a broken chain (C-3a): never list a tampered ledger as clean.
    const chain = (0, decisions_1.verifyChain)(events);
    if (!chain.ok) {
        (0, log_1.structuredLog)({ cmd: "decision list", error: "chain_broken", brokenAt: chain.brokenAt });
        return (0, output_1.failure)({
            human: `decisions.jsonl hash chain is broken at index ${chain.brokenAt} (${chain.reason}); refusing to list a tampered ledger as clean. Inspect \`.twinharness/decisions.jsonl\`.`,
            data: { error: "chain_broken", brokenAt: chain.brokenAt, reason: chain.reason },
        });
    }
    const reduced = (0, decisions_1.sortDecisions)((0, decisions_1.reduceDecisions)(events));
    const decisions = reduced.map(listShape);
    const seal = sealWarningData(events);
    // P6-6 (#16) — Decision-UX clarity: rejected/superseded decisions STILL GATE
    // (only `approved` clears the gate — DQ-002 / gatingObligations). A reviewer
    // scanning the list might assume a `rejected` decision is "handled"; surface a
    // one-line caveat whenever a stage-linked decision is in a non-approved terminal
    // status, so the still-gating semantics are visible at the read surface.
    const stillGating = reduced.filter((d) => (d.status === "rejected" || d.status === "superseded") &&
        d.links.some((l) => (0, decisions_1.canonicalizeLink)(l).startsWith("stage:")));
    const gatingNote = stillGating.length > 0
        ? "\n\nNote: only an APPROVED decision clears its stage gate. The following are in a " +
            "non-approved terminal status but their stage link STILL GATES (rejection/supersession does " +
            `not clear the gate — supersede-then-approve or approve the replacement to advance): ${stillGating
                .map((d) => `${d.id} [${d.status}]`)
                .join(", ")}.`
        : "";
    (0, log_1.structuredLog)({ cmd: "decision list", decisions: decisions.length });
    return (0, output_1.success)({
        data: { decisions, stillGating: stillGating.map((d) => d.id), ...seal },
        human: decisions.length === 0
            ? "No decisions recorded."
            : reduced.map((d) => `${d.id}  [${d.status}]  ${d.title}`).join("\n") + gatingNote,
    });
}
/**
 * The governance BARRIER (IF-003 / ADR-003 Layer 2). Runs FIRST, before any read
 * or write of the store. Two barriers, in order:
 *   1. No controlling TTY (`process.stdin.isTTY` falsy) → `no_tty`. An agent's
 *      tool shell / CI / pipe has no TTY, so it is structurally blocked (REQ-412).
 *   2. Interactive y/N prompt; ONLY `y`/`yes` (case-insensitive) proceeds. Anything
 *      else — `n`, empty, or EOF — → `confirmation_declined`.
 * There is NO `--yes`/override flag (it would reopen the self-approval hole).
 *
 * Injectable for headless tests via `opts.isTTY` / `opts.stdinLine` so all three
 * branches are reachable without a real PTY.
 */
/**
 * Read ONE line from stdin (fd 0) for the interactive y/N prompt, returning the
 * text up to (not including) the first newline.
 *
 * Why not `fs.readFileSync(0)`: that reads to EOF, so on a real controlling TTY
 * pressing Enter does NOT return — the call blocks until the user sends EOF
 * (Ctrl+D / Ctrl+Z), and on the Windows console it commonly throws outright
 * (EAGAIN/EOF), which fails the prompt closed and made approval impossible for a
 * legitimate human at an interactive Windows terminal. Reading byte-by-byte and
 * stopping at the first `\n` returns on a single keystroke + Enter on every
 * platform. EAGAIN/EWOULDBLOCK (a non-blocking fd 0 with no byte ready yet) is
 * retried after a short sleep — it means "wait", not "decline". EOF ends the
 * line with whatever was typed; only a truly unreadable stdin returns `""`
 * (fail-closed; the caller treats it as declined).
 */
/** Block this thread for ~`ms` without busy-spinning (Atomics.wait on a tiny SAB). */
function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function readSingleLineFromStdin() {
    const bytes = [];
    const one = Buffer.alloc(1);
    // eslint-disable-next-line no-constant-condition
    while (true) {
        let n;
        try {
            n = fs.readSync(0, one, 0, 1, null);
        }
        catch (err) {
            const code = err.code;
            // Node flips fd 0 to O_NONBLOCK once the stdin stream is referenced, so a
            // readSync on a real interactive terminal throws EAGAIN/EWOULDBLOCK simply
            // because the user has not typed the next byte YET. That is "wait", NOT
            // "decline" — sleep briefly and retry, or the prompt fails closed on the
            // very platforms (TTY/Windows console) this helper exists to support.
            if (code === "EAGAIN" || code === "EWOULDBLOCK") {
                sleepMs(15);
                continue;
            }
            // EOF (Windows console / closed pipe with no trailing newline) ends the
            // line cleanly with whatever was typed so far.
            if (code === "EOF")
                break;
            // Truly unreadable stdin → fail-closed (declined).
            return "";
        }
        if (n === 0)
            break; // EOF
        const ch = one.readUInt8(0);
        if (ch === 0x0a)
            break; // \n terminates the line (CR is stripped below)
        bytes.push(ch);
    }
    return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
}
function requireTTYConfirmation(id, disposition, opts = {}) {
    // Barrier 1: TTY check.
    // Use tty.isatty(0) rather than `process.stdin.isTTY`: the latter lazily
    // CONSTRUCTS the process.stdin stream, which flips fd 0 to O_NONBLOCK on
    // POSIX and makes the very next readSync throw EAGAIN. isatty detects the
    // terminal without that side effect on the fd we are about to read.
    const isTTY = opts.isTTY ?? tty.isatty(0);
    if (!isTTY) {
        return { ok: false, error: "no_tty" };
    }
    // Barrier 2: interactive y/N confirmation.
    let line = opts.stdinLine;
    if (line === undefined) {
        // Real interactive path: name the id + disposition, then read one line.
        process.stderr.write(`Confirm ${disposition} of ${id}? [y/N] `);
        line = readSingleLineFromStdin();
    }
    const answer = line.trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
        return { ok: true };
    }
    return { ok: false, error: "confirmation_declined" };
}
/**
 * Best-effort parent-process command name (#17, D3). On Linux reads
 * `/proc/<ppid>/comm` (the kernel-maintained command name); elsewhere, or on any
 * read failure, returns "unknown". Never throws — provenance is forensic metadata,
 * not a gate, so an unreadable parent must never break an approval.
 */
function readParentComm(ppid) {
    if (!ppid || ppid <= 0)
        return "unknown";
    // Linux fast path: the kernel-maintained command name, no subprocess.
    try {
        const comm = fs.readFileSync(`/proc/${ppid}/comm`, "utf8").trim();
        if (comm)
            return comm;
    }
    catch {
        // /proc absent (Windows/macOS) or unreadable → fall through to the per-OS query.
    }
    try {
        if (process.platform === "win32") {
            // tasklist CSV: the image name is the first quoted field.
            const out = (0, node_child_process_1.spawnSync)("tasklist", ["/FI", `PID eq ${ppid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 2000, windowsHide: true });
            const m = out.stdout?.match(/^"([^"]+)"/);
            return m?.[1]?.trim() || "unknown";
        }
        // macOS / BSD: `ps -p <ppid> -o comm=` prints the command name, no header.
        const out = (0, node_child_process_1.spawnSync)("ps", ["-p", String(ppid), "-o", "comm="], {
            encoding: "utf8",
            timeout: 2000,
        });
        return out.stdout?.trim() || "unknown";
    }
    catch {
        return "unknown";
    }
}
function captureApprovalProvenance(attributionSuspect, deps = {}) {
    const ppid = deps.ppid ?? process.ppid ?? 0;
    return {
        isTTY: deps.isTTY ?? Boolean(process.stdin.isTTY),
        ppid,
        parentComm: deps.parentComm ?? readParentComm(ppid),
        hostname: deps.hostname ?? os.hostname(),
        pid: deps.pid ?? process.pid,
        attributionSuspect,
    };
}
/** The transition event type for a disposition. */
function dispositionEvent(reject, supersede) {
    if (supersede)
        return "superseded";
    if (reject)
        return "rejected";
    return "approved";
}
/**
 * `th decision approve <id>` (and `--reject` / `--supersede <id>`) — the §8 human
 * gate. The TTY barrier (`requireTTYConfirmation`) runs FIRST, before ANY read or
 * write; on a barrier failure there is NO append. Then the state-machine
 * transition is enforced (proposed→approved/rejected; approved→superseded), the
 * chain tail is verified (refuse to extend a broken chain), and the transition
 * event is appended with the resolved `approver` attribution.
 *
 * Attribution (NOT a barrier): approver = --as ?? TH_APPROVAL_ACTOR ?? "human".
 *
 * Anchor: REQ-403 — approve transitions to approved; records human approval; not self-approvable.
 * Anchor: REQ-407 — state-machine graph enforced; illegal transitions fail structured.
 * Anchor: REQ-412 — non-self-approval barrier is mechanical (TTY), not convention.
 * Anchor: REQ-413 — records approver + approvedAt on the transition event.
 * Anchor: REQ-NFR-006 — approve requires a human-attributable approval; agent context blocked.
 * Anchor: REQ-NFR-008 — paths-first; one structuredLog; returns CommandResult.
 */
function runDecisionApprove(paths, id, opts = {}) {
    const reject = Boolean(opts.reject);
    const supersedeTarget = opts.supersede;
    const supersede = supersedeTarget !== undefined;
    // Disposition ambiguity is resolved BEFORE the barrier so the error is stable,
    // but it still performs no read/write of the store.
    if (reject && supersede) {
        (0, log_1.structuredLog)({ cmd: "decision approve", error: "ambiguous_disposition", id });
        return (0, output_1.failure)({
            human: "--reject and --supersede are mutually exclusive.",
            data: { error: "ambiguous_disposition" },
        });
    }
    const disposition = supersede
        ? "supersede"
        : reject
            ? "reject"
            : "approve";
    // Attribution (NOT a barrier — D3): an EXPLICIT actor comes from `--as` or
    // TH_APPROVAL_ACTOR. We STOP silently trusting an unattributed approval as
    // "human": when neither is supplied, the approver still defaults to "human" (so
    // the state machine and existing read model are unchanged) but the provenance
    // record is marked `attributionSuspect: true` — an unattributed approval is
    // forensically flagged, not laundered into a confident human claim (#17).
    //
    // Provenance/attribution are resolved BEFORE the barrier (they perform no store
    // read/write — like the disposition above) so a BLOCKED attempt (no-tty /
    // declined) is recorded in the durable approval-audit log too. The audit log
    // (#17, D3) survives a silenced stderr (`TH_NO_LOG=1`), so every approval attempt
    // — sealed or blocked — leaves a forensic record.
    const explicitActor = (opts.as ?? process.env.TH_APPROVAL_ACTOR)?.trim();
    const attributionSuspect = !explicitActor;
    const approver = explicitActor || "human";
    const provenance = captureApprovalProvenance(attributionSuspect, opts.provenance ?? { isTTY: opts.tty?.isTTY });
    const now = opts.now ?? (() => new Date());
    const toEvent = dispositionEvent(reject, supersede);
    const auditTs = now().toISOString();
    // ---- BARRIER (runs FIRST, before any read or write) -----------------------
    const confirm = requireTTYConfirmation(id ?? "(unknown)", disposition, opts.tty);
    if (!confirm.ok) {
        (0, log_1.structuredLog)({ cmd: "decision approve", error: confirm.error, id });
        (0, decisions_1.appendApprovalAudit)(paths, { ts: auditTs, id, disposition, outcome: confirm.error, approver, provenance });
        return (0, output_1.failure)({
            human: confirm.error === "no_tty"
                ? "Approval requires an interactive terminal (no controlling TTY)."
                : "Approval declined at the confirmation prompt.",
            data: { error: confirm.error },
        });
    }
    if (!id) {
        (0, log_1.structuredLog)({ cmd: "decision approve", error: "unknown_decision", id });
        (0, decisions_1.appendApprovalAudit)(paths, { ts: auditTs, id, disposition, outcome: "unknown_decision", approver, provenance });
        return (0, output_1.failure)({
            human: "usage: th decision approve <DECISION-ID> [--reject | --supersede <id>]",
            data: { error: "unknown_decision", id },
        });
    }
    // Read-modify-append serialized via withStateLock. All further failure paths
    // return BEFORE the append, so the file is never touched on failure.
    const result = (0, state_store_2.withStateLock)(paths, () => {
        const events = (0, decisions_1.readDecisionEvents)(paths);
        // Refuse to extend a broken chain (THR-009 / MIT-010): verify tail BEFORE append.
        const chain = (0, decisions_1.verifyChain)(events);
        if (!chain.ok) {
            return (0, output_1.failure)({
                human: `Refusing to approve: decisions.jsonl hash chain is broken at index ${chain.brokenAt}.`,
                data: { error: "chain_broken", brokenAt: chain.brokenAt, reason: chain.reason },
            });
        }
        const decisions = (0, decisions_1.reduceDecisions)(events);
        const target = decisions.find((d) => d.id === id);
        if (!target) {
            return (0, output_1.failure)({
                human: `Unknown decision: ${id}.`,
                data: { error: "unknown_decision", id },
            });
        }
        // State machine (REQ-407): proposed→approved/rejected; approved→superseded.
        const legal = toEvent === "superseded" ? target.status === "approved" : target.status === "proposed";
        if (!legal) {
            return (0, output_1.failure)({
                human: `Illegal transition: ${id} is ${target.status}, cannot ${disposition}.`,
                data: { error: "illegal_transition", id, currentStatus: target.status },
            });
        }
        // For supersede, the superseding id must already exist in the store.
        if (supersede) {
            const exists = decisions.some((d) => d.id === supersedeTarget);
            if (!exists) {
                return (0, output_1.failure)({
                    human: `Unknown superseding decision: ${supersedeTarget}.`,
                    data: { error: "unknown_superseding_id", supersededBy: supersedeTarget },
                });
            }
        }
        // Append the transition event (a NEW event; the prior event is preserved).
        // The real invocation provenance (#17, D3) is sealed onto the transition so an
        // after-the-fact reviewer sees the observed source (TTY/ppid/host/pid) and the
        // attribution-suspect flag — not just a self-asserted "human".
        const event = {
            id,
            event: toEvent,
            approver,
            approvedAt: auditTs,
            provenance,
        };
        if (supersede)
            event.supersededBy = supersedeTarget;
        // BSC-4 (Axis-B slice-1a, execution doc §6): ground an APPROVAL with a
        // terminal-transition receipt so the completion gate cannot be cleared by an
        // approval marker alone. Migration runs BEFORE the approval event is sealed, so
        // THIS decision is not yet terminal when the grandfathered baseline is captured
        // — it then gets a REAL receipt below rather than a `legacy` backfill stamp.
        // Reject/supersede mint NOTHING: they are not "approved/complete" claims (a
        // rejected decision still gates per DQ-002, so it has nothing to ground). The
        // mint is purely additive and runs under the SAME lock.
        if (toEvent === "approved")
            (0, receipts_1.ensureReceiptMigration)(paths);
        // Mint BEFORE persisting the approval event. A receipt failure must leave the
        // decision proposed so the command remains safely retryable; an orphan receipt
        // is harmless because only terminal decisions are enforced by the gate.
        if (toEvent === "approved") {
            (0, receipts_1.appendTerminalReceipt)(paths, {
                kind: "decision-approve",
                refId: id,
                producerIdentity: "cli:th decision approve",
            });
        }
        // Seal the approval transition with the opt-in key when one is explicitly set
        // (C-3b). resolveDecisionKey() returns null by default → no seal, no behavior change.
        (0, decisions_1.appendDecisionEvent)(paths, event, (0, decision_key_1.resolveDecisionKey)());
        const data = { id, to: toEvent, approver, provenance };
        if (supersede)
            data.supersededBy = supersedeTarget;
        const suspectNote = attributionSuspect
            ? ` [UNATTRIBUTED — no --as/TH_APPROVAL_ACTOR; marked suspect in audit provenance]`
            : "";
        return (0, output_1.success)({ data, human: `${id} → ${toEvent} (by ${approver}).${suspectNote}` });
    });
    // Durable audit (#17, D3): record the post-lock outcome — "appended" when the
    // transition was sealed, else the failure error code (chain_broken /
    // unknown_decision / illegal_transition / unknown_superseding_id). Survives a
    // silenced stderr; complements the hash-chained decisions.jsonl with a record of
    // EVERY approval attempt and its observed provenance.
    (0, decisions_1.appendApprovalAudit)(paths, {
        ts: auditTs,
        id,
        disposition,
        outcome: result.ok ? "appended" : (result.data?.error ?? "failed"),
        approver,
        provenance,
    });
    // Exactly one structuredLog per invocation, after the locked section.
    (0, log_1.structuredLog)({
        cmd: "decision approve",
        id,
        to: result.ok ? toEvent : undefined,
        error: result.ok ? undefined : result.data?.error,
    });
    return result;
}
/**
 * `th decision check` — fail (exit 6) when any unapproved decision gates the
 * current stage; pass (exit 0) when all gating decisions are approved or none
 * exist. Uses the SINGLE `gatingObligations` predicate (RULE-007) — the same
 * function the `th next` rung calls; they cannot disagree.
 *
 * Missing decisions.jsonl → [] → exit 0. Missing state.json → no current stage
 * → exit 0.
 *
 * Anchor: REQ-404 — fail non-zero when an unapproved gating decision blocks the stage.
 * Anchor: REQ-407 — read model reflects the enforced status graph.
 * Anchor: REQ-NFR-008 — paths-first; one structuredLog; returns CommandResult.
 */
function runDecisionCheck(paths, _opts = {}) {
    const events = (0, decisions_1.readDecisionEvents)(paths);
    // Tamper gate (C-3a) — verify the keyless chain FIRST and fail CLOSED. A broken
    // chain means the ledger is untrustworthy, so `check` must NOT report it clean.
    // Reuses exit 6 (guard #7) but with a DISTINCT data.error discriminator
    // ("chain_broken") vs the unapproved-gating path ("unapproved_gating").
    const chain = (0, decisions_1.verifyChain)(events);
    if (!chain.ok) {
        (0, log_1.structuredLog)({ cmd: "decision check", error: "chain_broken", brokenAt: chain.brokenAt });
        return {
            ok: false,
            exitCode: exports.DECISION_GATE_EXIT,
            data: { error: "chain_broken", brokenAt: chain.brokenAt, reason: chain.reason },
            human: `decisions.jsonl hash chain is broken at index ${chain.brokenAt} (${chain.reason}); ` +
                `the decision ledger has been edited/reordered. Refusing to report it as clean.`,
        };
    }
    const decisions = (0, decisions_1.reduceDecisions)(events);
    const state = (0, state_store_1.readState)(paths).state;
    const gating = (0, decisions_1.gatingObligations)(decisions, state);
    const seal = sealWarningData(events);
    if (gating.length > 0) {
        (0, log_1.structuredLog)({ cmd: "decision check", gating: gating.length });
        return {
            ok: false,
            exitCode: exports.DECISION_GATE_EXIT,
            data: { ok: false, error: "unapproved_gating", gating, ...seal },
            human: [
                "Unapproved decisions gate the current stage:",
                ...gating.map((g) => {
                    const d = decisions.find((x) => x.id === g.decisionId);
                    const status = d ? d.status : "proposed";
                    // P6-6 (#16): a rejected/superseded decision STILL GATES — make that explicit
                    // in the per-line reason so a reviewer doesn't assume it's already handled.
                    const stillNote = status === "rejected" || status === "superseded"
                        ? ` (status ${status} — still gating; only APPROVED clears the gate)`
                        : "";
                    return `  ${g.decisionId} blocks stage '${g.blockedStage}'${stillNote}`;
                }),
            ].join("\n"),
        };
    }
    (0, log_1.structuredLog)({ cmd: "decision check", gating: 0 });
    return (0, output_1.success)({ data: { gating: [], ...seal }, human: "No unapproved gating decisions." });
}
/**
 * Optional keyed-seal warning (C-3b, warn-only). Returns `{}` unless a key is
 * EXPLICITLY set (TH_DECISION_KEY) AND a present seal mismatches — in which case
 * it returns a `sealWarning` marker for the data payload. NEVER changes the exit
 * code (a per-environment key difference must not turn a clean ledger red).
 */
function sealWarningData(events) {
    const key = (0, decision_key_1.resolveDecisionKey)();
    if (!key)
        return {};
    const res = (0, decisions_1.verifyApprovalSeals)(events, key);
    return res.ok ? {} : { sealWarning: { mismatches: res.mismatches } };
}
