"use strict";
/**
 * Pure parse/format for `debate-log.md` entries (REQ-PCO-042: the debate
 * ledger). The twin of `drift-log.ts` — an append-only record of debate turns
 * and the final reconciliation. Formatting produces a new block and parsing
 * reads the existing blocks; neither rewrites history.
 *
 * Canonical entry shape:
 *
 *   ## DEBATE-003  (Should we cache the registry?, Builder)  — open
 *   Positions  : Builder argues for an LRU; Reviewer wants no cache.
 *   Resolution : (pending)
 *   Links      : REQ-PCO-040, DRIFT-007
 *
 * The `— <status>` tail distinguishes an `open` debate (a BLOCKING obligation,
 * exactly like a requirement-layer drift) from a `resolved` one. Pure, no IO.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDebateEntry = formatDebateEntry;
exports.parseDebateEntries = parseDebateEntries;
exports.nextDebateId = nextDebateId;
/**
 * Format a debate entry as the canonical markdown block (trailing blank line so
 * blocks are visually separated when appended). Aligns the field labels to match
 * the canonical example.
 *
 * The `source` field (default "Builder") is written into the parenthetical so
 * entries from the Orchestrator or a human are attributed correctly.
 */
function formatDebateEntry(entry) {
    const src = entry.source ?? "Builder";
    const heading = `## ${entry.id}  (${entry.topic}, ${src})  — ${entry.status}`;
    return [
        heading,
        `Positions  : ${entry.positions ?? ""}`,
        `Resolution : ${entry.resolution ?? "(pending)"}`,
        `Links      : ${entry.links ?? ""}`,
        "",
    ].join("\n");
}
// Heading regex: captures the parenthetical content as a single group so the
// parser can split off the optional ", <source>" suffix. Backward-compatible
// with logs lacking a source (or ", Builder") and handles any new source string.
const HEADING_RE = /^##\s+(DEBATE-\d+)\s*\(([^)]+)\)\s*—\s*(open|resolved)/;
/** Strip the optional ", <source>" suffix from a parenthetical head string. */
function extractTopic(paren) {
    // If the string contains a comma, the part after the last comma is the source
    // label. Strip it, returning just the topic.
    const lastComma = paren.lastIndexOf(",");
    if (lastComma < 0)
        return paren.trim();
    return paren.slice(0, lastComma).trim();
}
const FIELD_RE = /^(Positions|Resolution|Links)\s*:\s*(.*)$/;
/**
 * Parse all debate entries from a `debate-log.md` blob. The header and any other
 * non-entry headings are ignored — only well-formed
 * `## DEBATE-NNN (...) — <status>` blocks become entries.
 */
function parseDebateEntries(text) {
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
                topic: extractTopic(head[2]),
                status: head[3],
                positions: "",
                resolution: "",
                links: "",
            };
            continue;
        }
        if (line.startsWith("## ")) {
            // A non-entry heading terminates the current entry.
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
                if (field[1] === "Positions")
                    current.positions = value;
                else if (field[1] === "Resolution")
                    current.resolution = value;
                else
                    current.links = value;
            }
        }
    }
    if (current)
        entries.push(current);
    return entries;
}
/**
 * Compute the next `DEBATE-NNN` id from a `debate-log.md` blob: scan every
 * `DEBATE-NNN` token (entries and resolution notes alike so ids stay unique),
 * take the max, add one, zero-pad to 3. Starts at `DEBATE-001`.
 */
function nextDebateId(text) {
    let max = 0;
    for (const m of text.matchAll(/DEBATE-(\d+)/g)) {
        const n = Number(m[1]);
        if (n > max)
            max = n;
    }
    return `DEBATE-${String(max + 1).padStart(3, "0")}`;
}
