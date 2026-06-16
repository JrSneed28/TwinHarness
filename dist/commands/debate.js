"use strict";
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
exports.runDebateAdd = runDebateAdd;
exports.runDebateList = runDebateList;
exports.runDebateResolve = runDebateResolve;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const output_1 = require("../core/output");
const state_store_1 = require("../core/state-store");
const debate_log_1 = require("../core/debate-log");
const log_1 = require("../core/log");
const ledger_1 = require("../core/ledger");
const guards_1 = require("../core/guards");
/**
 * `th debate` — append-only access to the debate ledger (REQ-PCO-042). The
 * twin of `th drift`: mechanical only. The CLI records debate turns and the
 * final reconciliation and tracks the open (BLOCKING) count; it never decides
 * who wins a debate. An OPEN debate is a blocking obligation, exactly like a
 * requirement-layer drift: it increments `state.debate_open_blocking`, which the
 * stop-gate reads to refuse premature completion. Resolving the debate clears it.
 */
/**
 * Self-healing header for debate-log.md (kept analogous to the drift-log header
 * init writes). Written when the ledger is absent so `debate add` can run on a
 * project whose ledger was never created or was deleted.
 */
const DEBATE_LOG_HEADER = `# Debate Log

Append-only record of debate turns and final reconciliation (REQ-PCO-042). Each
entry records the topic, the status (open vs. resolved), the positions, the
resolution, and any links.

Format:

\`\`\`
## DEBATE-NNN  (topic, Builder)  — <status>
Positions  : ...
Resolution : ...
Links      : ...
\`\`\`
`;
/** `<root>/debate-log.md` — the ledger file (mirrors how drift uses driftLog). */
function debateLogPath(paths) {
    return path.join(paths.root, "debate-log.md");
}
/** Read debate-log.md, creating it from the header if absent. */
function readDebateLog(paths) {
    const file = debateLogPath(paths);
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, DEBATE_LOG_HEADER, "utf8");
        return DEBATE_LOG_HEADER;
    }
    return fs.readFileSync(file, "utf8");
}
/** Append a block to debate-log.md (append-only — never rewrites history). */
function appendDebateLog(paths, block) {
    const current = readDebateLog(paths);
    // Ensure a separating newline before the appended block.
    const sep = current.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(debateLogPath(paths), `${current}${sep}${block}`, "utf8");
}
/**
 * `th debate add --topic <...> [--positions ...] [--links ...] [--source ...]`
 * Compute the next DEBATE id, append an `open` entry. An open debate is BLOCKING:
 * it increments `state.debate_open_blocking`.
 */
function runDebateAdd(paths, opts) {
    return (0, state_store_1.withStateLock)(paths, () => runDebateAddLocked(paths, opts));
}
function runDebateAddLocked(paths, opts) {
    const topic = opts.topic;
    if (!topic) {
        return (0, output_1.failure)({
            human: "usage: th debate add --topic <topic> [--positions ...] [--links ...] [--source ...]",
            data: { error: "missing_topic" },
        });
    }
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `Existing state.json is invalid; fix it before logging a debate:\n${(0, guards_1.formatIssues)(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const current = readDebateLog(paths);
    const id = (0, debate_log_1.nextDebateId)(current);
    const block = (0, debate_log_1.formatDebateEntry)({
        id,
        topic,
        status: "open",
        positions: opts.positions ?? "",
        resolution: "(pending)",
        links: opts.links ?? "",
        source: opts.source,
    });
    appendDebateLog(paths, block);
    // An open debate is a blocking obligation (twin of a requirement-layer drift).
    const debateOpenBlocking = (r.state.debate_open_blocking ?? 0) + 1;
    (0, state_store_1.writeState)(paths, { ...r.state, debate_open_blocking: debateOpenBlocking });
    // Audit ledger (F5): an open debate opens a blocking gate.
    (0, ledger_1.appendLedger)(paths, {
        event: "debate-blocking-opened",
        id,
        topic,
        debate_open_blocking: debateOpenBlocking,
    });
    (0, log_1.structuredLog)({ cmd: "debate add", id, debate_open_blocking: debateOpenBlocking });
    return (0, output_1.success)({
        data: { id, status: "open", debate_open_blocking: debateOpenBlocking },
        human: `${id} logged (open, BLOCKING). Open blocking debates: ${debateOpenBlocking}.`,
    });
}
/**
 * `th debate list` — parse + report every entry (sorted by numeric id) plus the
 * open BLOCKING count. The status reported is the *effective* status: an entry
 * with a later `## DEBATE-NNN — resolved` note reads as resolved.
 */
function runDebateList(paths) {
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `state.json is invalid:\n${(0, guards_1.formatIssues)(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    const file = debateLogPath(paths);
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const entries = sortById(effectiveEntries((0, debate_log_1.parseDebateEntries)(text)));
    const openBlocking = r.state.debate_open_blocking ?? 0;
    const human = entries.length
        ? entries.map((e) => `${e.id}  (${e.topic})  ${e.status}`).join("\n")
        : "(no debate entries)";
    return (0, output_1.success)({ data: { entries, open_blocking: openBlocking }, human });
}
/**
 * Collapse the append-only log to one effective entry per id: the LAST block for
 * an id wins (a resolved twin appended after the open block makes the entry read
 * as resolved). Insertion order is preserved by the final sort.
 */
function effectiveEntries(entries) {
    const byId = new Map();
    for (const e of entries)
        byId.set(e.id, e);
    return [...byId.values()];
}
/** Sort entries by the numeric portion of their `DEBATE-NNN` id. */
function sortById(entries) {
    return [...entries].sort((a, b) => idNum(a.id) - idNum(b.id));
}
function idNum(id) {
    const m = /DEBATE-(\d+)/.exec(id);
    return m ? Number(m[1]) : 0;
}
/**
 * `th debate resolve <id> [--resolution ...]` — append an append-only resolution
 * note recording the reconciliation, mark the entry resolved, and decrement
 * `state.debate_open_blocking` (floor 0).
 *
 * Hardened validations (mirror drift resolve):
 * - The id must match an existing open debate entry (no unknown ids).
 * - Double-resolving (a `## <id> — resolved` note already present) is rejected.
 */
function runDebateResolve(paths, opts) {
    return (0, state_store_1.withStateLock)(paths, () => runDebateResolveLocked(paths, opts));
}
function runDebateResolveLocked(paths, opts) {
    const id = opts.id;
    if (!id)
        return (0, output_1.failure)({ human: "usage: th debate resolve <DEBATE-NNN> [--resolution ...]" });
    const r = (0, state_store_1.readState)(paths);
    if (!r.exists)
        return guards_1.NOT_INIT;
    if (!r.state) {
        return (0, output_1.failure)({
            human: `Existing state.json is invalid; fix it before resolving a debate:\n${(0, guards_1.formatIssues)(r.issues)}`,
            data: { error: "invalid_state", issues: r.issues },
        });
    }
    // Parse the debate log to validate the id and detect double-resolves.
    const file = debateLogPath(paths);
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const entries = (0, debate_log_1.parseDebateEntries)(text);
    const entry = entries.find((e) => e.id === id);
    if (!entry) {
        return (0, output_1.failure)({
            human: `Debate entry not found: ${id}. Known entries: ${entries.map((e) => e.id).join(", ") || "(none)"}`,
            data: { error: "debate_not_found", id },
        });
    }
    // Check for a pre-existing resolution note (double-resolve guard).
    const alreadyResolved = text
        .split(/\r?\n/)
        .some((line) => line.trim() === `## ${id} — resolved`);
    if (alreadyResolved) {
        return (0, output_1.failure)({
            human: `${id} is already resolved. Double-resolving is not allowed.`,
            data: { error: "already_resolved", id },
        });
    }
    // Append the resolved twin block so the ledger stays append-only AND a fresh
    // parse reflects the resolved status + the reconciliation text.
    const resolution = opts.resolution ?? "(reconciled)";
    appendDebateLog(paths, (0, debate_log_1.formatDebateEntry)({
        id,
        topic: entry.topic,
        status: "resolved",
        positions: entry.positions,
        resolution,
        links: entry.links,
        source: "Builder",
    }));
    // Append-only resolution marker (double-resolve guard relies on this line).
    appendDebateLog(paths, `## ${id} — resolved\n`);
    const debateOpenBlocking = Math.max(0, (r.state.debate_open_blocking ?? 0) - 1);
    (0, state_store_1.writeState)(paths, { ...r.state, debate_open_blocking: debateOpenBlocking });
    // Audit ledger (F5): resolving a debate clears a blocking gate.
    (0, ledger_1.appendLedger)(paths, {
        event: "debate-blocking-resolved",
        id,
        debate_open_blocking: debateOpenBlocking,
    });
    (0, log_1.structuredLog)({ cmd: "debate resolve", id, debate_open_blocking: debateOpenBlocking });
    return (0, output_1.success)({
        data: { id, status: "resolved", debate_open_blocking: debateOpenBlocking },
        human: `${id} marked resolved. Open blocking debates: ${debateOpenBlocking}.`,
    });
}
