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
exports.runDecisionApprove = runDecisionApprove;
exports.runDecisionCheck = runDecisionCheck;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const log_1 = require("../core/log");
const state_store_1 = require("../core/state-store");
const state_store_2 = require("../core/state-store");
const decisions_1 = require("../core/decisions");
const decision_key_1 = require("../core/decision-key");
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
    (0, log_1.structuredLog)({ cmd: "decision add", id: sealed.id, status: "proposed", links: links.length });
    return (0, output_1.success)({
        data: { id: sealed.id, status: "proposed", links },
        human: `Recorded ${sealed.id} (proposed).`,
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
    (0, log_1.structuredLog)({ cmd: "decision list", decisions: decisions.length });
    return (0, output_1.success)({
        data: { decisions, ...seal },
        human: decisions.length === 0
            ? "No decisions recorded."
            : reduced.map((d) => `${d.id}  [${d.status}]  ${d.title}`).join("\n"),
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
function requireTTYConfirmation(id, disposition, opts = {}) {
    // Barrier 1: TTY check.
    const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
    if (!isTTY) {
        return { ok: false, error: "no_tty" };
    }
    // Barrier 2: interactive y/N confirmation.
    let line = opts.stdinLine;
    if (line === undefined) {
        // Real interactive path: name the id + disposition, then read one line.
        process.stderr.write(`Confirm ${disposition} of ${id}? [y/N] `);
        try {
            const raw = fs.readFileSync(0, "utf8");
            line = raw.split(/\r?\n/)[0] ?? "";
        }
        catch {
            // EOF / unreadable stdin → declined (fail-closed).
            line = "";
        }
    }
    const answer = line.trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
        return { ok: true };
    }
    return { ok: false, error: "confirmation_declined" };
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
    // ---- BARRIER (runs FIRST, before any read or write) -----------------------
    const confirm = requireTTYConfirmation(id ?? "(unknown)", disposition, opts.tty);
    if (!confirm.ok) {
        (0, log_1.structuredLog)({ cmd: "decision approve", error: confirm.error, id });
        return (0, output_1.failure)({
            human: confirm.error === "no_tty"
                ? "Approval requires an interactive terminal (no controlling TTY)."
                : "Approval declined at the confirmation prompt.",
            data: { error: confirm.error },
        });
    }
    if (!id) {
        (0, log_1.structuredLog)({ cmd: "decision approve", error: "unknown_decision", id });
        return (0, output_1.failure)({
            human: "usage: th decision approve <DECISION-ID> [--reject | --supersede <id>]",
            data: { error: "unknown_decision", id },
        });
    }
    const approver = (opts.as ?? process.env.TH_APPROVAL_ACTOR ?? "human").trim() || "human";
    const now = opts.now ?? (() => new Date());
    const toEvent = dispositionEvent(reject, supersede);
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
        const event = {
            id,
            event: toEvent,
            approver,
            approvedAt: now().toISOString(),
        };
        if (supersede)
            event.supersededBy = supersedeTarget;
        // Seal the approval transition with the opt-in key when one is explicitly set
        // (C-3b). resolveDecisionKey() returns null by default → no seal, no behavior change.
        (0, decisions_1.appendDecisionEvent)(paths, event, (0, decision_key_1.resolveDecisionKey)());
        const data = { id, to: toEvent, approver };
        if (supersede)
            data.supersededBy = supersedeTarget;
        return (0, output_1.success)({ data, human: `${id} → ${toEvent} (by ${approver}).` });
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
                ...gating.map((g) => `  ${g.decisionId} blocks stage '${g.blockedStage}'`),
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
