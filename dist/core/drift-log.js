"use strict";
/**
 * Pure parse/format for `drift-log.md` entries (spec §10: the bidirectional
 * drift log). The log is append-only — formatting produces a new block and
 * parsing reads the existing blocks; neither rewrites history.
 *
 * Canonical entry shape (§10):
 *
 *   ## DRIFT-003  (SLICE-2 / TASK-012, Builder)  — derived layer, auto-applied
 *   Discovery : Existing ThemeContext provider found; ...
 *   Action    : Wired into ThemeContext; updated 04-architecture.md §3 (v2).
 *   Escalation: none (no requirement contradicted).
 *
 * The `— <layer>, <action-tag>` tail distinguishes a DERIVED-layer drift
 * (auto-applied) from a REQUIREMENT-layer drift (BLOCKING). Pure, no IO.
 *
 * The append-only-markdown-ledger mechanics (heading assembly, source-suffix
 * stripping, the block parser, monotonic id minting) are shared with the debate
 * ledger via `md-ledger.ts` (CQ-001/005); only the drift-specific shape (layer
 * tail, the Discovery/Action/Escalation fields) lives here. The emitted markdown
 * is byte-identical to the prior standalone implementation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDriftEntry = formatDriftEntry;
exports.parseDriftEntries = parseDriftEntries;
exports.nextDriftId = nextDriftId;
const md_ledger_1 = require("./md-ledger");
/** The heading action-tag per layer (§10): derived auto-applies, requirement blocks. */
function actionTag(layer) {
    return layer === "requirement" ? "BLOCKING" : "auto-applied";
}
const DRIFT_LEDGER = {
    headingTail: (e) => `${e.layer} layer, ${actionTag(e.layer)}`,
    fields: [
        { label: "Discovery ", value: (e) => e.discovery },
        { label: "Action    ", value: (e) => e.action },
        { label: "Escalation", value: (e) => e.escalation },
    ],
};
/**
 * Format a drift entry as the §10 markdown block (trailing blank line so blocks
 * are visually separated when appended). Aligns the field labels to match the
 * canonical example.
 *
 * The `source` field (default "Builder") is written into the parenthetical so
 * entries from the Orchestrator or a human are attributed correctly.
 */
function formatDriftEntry(entry) {
    return (0, md_ledger_1.formatLedgerEntry)({
        id: entry.id,
        head: entry.ref,
        source: entry.source ?? "Builder",
        layer: entry.layer,
        discovery: entry.discovery,
        action: entry.action,
        escalation: entry.escalation,
    }, DRIFT_LEDGER);
}
// Heading regex: captures the parenthetical content as a single group so the
// parser can split off the optional ", <source>" suffix. This is
// backward-compatible with old logs (no source or ", Builder") and handles any
// new source string.
const HEADING_RE = /^##\s+(DRIFT-\d+)\s*\(([^)]+)\)\s*—\s*(derived|requirement)\s+layer/;
const FIELD_RE = /^(Discovery|Action|Escalation)\s*:\s*(.*)$/;
/**
 * Parse all drift entries from a `drift-log.md` blob. Resolution notes
 * (`## DRIFT-NNN — resolved`) and the header are ignored — only well-formed
 * `## DRIFT-NNN (...) — <layer> layer` blocks become entries.
 */
function parseDriftEntries(text) {
    return (0, md_ledger_1.parseLedgerEntries)(text, HEADING_RE, FIELD_RE, (h) => ({
        id: h.id,
        ref: h.head,
        layer: h.tag,
        discovery: "",
        action: "",
        escalation: "",
    }), (entry, key, value) => {
        if (key === "Discovery")
            entry.discovery = value;
        else if (key === "Action")
            entry.action = value;
        else
            entry.escalation = value;
    });
}
/**
 * Compute the next `DRIFT-NNN` id from a `drift-log.md` blob: scan every
 * `DRIFT-NNN` token (entries and resolution notes alike so ids stay unique),
 * take the max, add one, zero-pad to 3. Starts at `DRIFT-001`.
 */
function nextDriftId(text) {
    return (0, md_ledger_1.nextLedgerId)(text, "DRIFT");
}
