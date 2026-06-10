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
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDriftEntry = formatDriftEntry;
exports.parseDriftEntries = parseDriftEntries;
exports.nextDriftId = nextDriftId;
/** The heading action-tag per layer (§10): derived auto-applies, requirement blocks. */
function actionTag(layer) {
    return layer === "requirement" ? "BLOCKING" : "auto-applied";
}
/**
 * Format a drift entry as the §10 markdown block (trailing blank line so blocks
 * are visually separated when appended). Aligns the field labels to match the
 * canonical example.
 *
 * The `source` field (default "Builder") is written into the parenthetical so
 * entries from the Orchestrator or a human are attributed correctly.
 */
function formatDriftEntry(entry) {
    const src = entry.source ?? "Builder";
    const heading = `## ${entry.id}  (${entry.ref}, ${src})  — ${entry.layer} layer, ${actionTag(entry.layer)}`;
    return [
        heading,
        `Discovery : ${entry.discovery}`,
        `Action    : ${entry.action}`,
        `Escalation: ${entry.escalation}`,
        "",
    ].join("\n");
}
// Heading regex: captures the parenthetical content as a single group so the
// parser can split off the optional ", <source>" suffix. This is
// backward-compatible with old logs (no source or ", Builder") and handles any
// new source string.
const HEADING_RE = /^##\s+(DRIFT-\d+)\s*\(([^)]+)\)\s*—\s*(derived|requirement)\s+layer/;
/** Strip the optional ", <source>" suffix from a parenthetical ref string. */
function extractRef(paren) {
    // If the string contains a comma, the part after the last comma is the source
    // label. Strip it, returning just the ref.
    const lastComma = paren.lastIndexOf(",");
    if (lastComma < 0)
        return paren.trim();
    return paren.slice(0, lastComma).trim();
}
const FIELD_RE = /^(Discovery|Action|Escalation)\s*:\s*(.*)$/;
/**
 * Parse all drift entries from a `drift-log.md` blob. Resolution notes
 * (`## DRIFT-NNN — resolved`) and the header are ignored — only well-formed
 * `## DRIFT-NNN (...) — <layer> layer` blocks become entries.
 */
function parseDriftEntries(text) {
    const entries = [];
    const lines = text.split(/\r?\n/);
    let current;
    for (const line of lines) {
        const head = HEADING_RE.exec(line);
        if (head) {
            if (current)
                entries.push(current);
            current = {
                id: head[1],
                ref: extractRef(head[2]),
                layer: head[3],
                discovery: "",
                action: "",
                escalation: "",
            };
            continue;
        }
        if (line.startsWith("## ")) {
            // A non-entry heading (e.g. a resolution note) terminates the current entry.
            if (current) {
                entries.push(current);
                current = undefined;
            }
            continue;
        }
        if (current) {
            const field = FIELD_RE.exec(line);
            if (field) {
                const value = field[2];
                if (field[1] === "Discovery")
                    current.discovery = value;
                else if (field[1] === "Action")
                    current.action = value;
                else
                    current.escalation = value;
            }
        }
    }
    if (current)
        entries.push(current);
    return entries;
}
/**
 * Compute the next `DRIFT-NNN` id from a `drift-log.md` blob: scan every
 * `DRIFT-NNN` token (entries and resolution notes alike so ids stay unique),
 * take the max, add one, zero-pad to 3. Starts at `DRIFT-001`.
 */
function nextDriftId(text) {
    let max = 0;
    for (const m of text.matchAll(/DRIFT-(\d+)/g)) {
        const n = Number(m[1]);
        if (n > max)
            max = n;
    }
    return `DRIFT-${String(max + 1).padStart(3, "0")}`;
}
