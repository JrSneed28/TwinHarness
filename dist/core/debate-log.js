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
 *
 * The append-only-markdown-ledger mechanics (heading assembly, source-suffix
 * stripping, the block parser, monotonic id minting) are shared with the drift
 * log via `md-ledger.ts` (CQ-001/005); only the debate-specific shape (status
 * tail, the Positions/Resolution/Links fields and their defaults) lives here.
 * The emitted markdown is byte-identical to the prior standalone implementation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDebateEntry = formatDebateEntry;
exports.parseDebateEntries = parseDebateEntries;
exports.nextDebateId = nextDebateId;
const md_ledger_1 = require("./md-ledger");
const DEBATE_LEDGER = {
    headingTail: (e) => e.status,
    fields: [
        { label: "Positions  ", value: (e) => e.positions ?? "" },
        { label: "Resolution ", value: (e) => e.resolution ?? "(pending)" },
        { label: "Links      ", value: (e) => e.links ?? "" },
    ],
};
/**
 * Format a debate entry as the canonical markdown block (trailing blank line so
 * blocks are visually separated when appended). Aligns the field labels to match
 * the canonical example.
 *
 * The `source` field (default "Builder") is written into the parenthetical so
 * entries from the Orchestrator or a human are attributed correctly.
 */
function formatDebateEntry(entry) {
    return (0, md_ledger_1.formatLedgerEntry)({
        id: entry.id,
        head: entry.topic,
        source: entry.source ?? "Builder",
        status: entry.status,
        positions: entry.positions,
        resolution: entry.resolution,
        links: entry.links,
    }, DEBATE_LEDGER);
}
// Heading regex: captures the parenthetical content as a single group so the
// parser can split off the optional ", <source>" suffix. Backward-compatible
// with logs lacking a source (or ", Builder") and handles any new source string.
const HEADING_RE = /^##\s+(DEBATE-\d+)\s*\(([^)]+)\)\s*—\s*(open|resolved)/;
const FIELD_RE = /^(Positions|Resolution|Links)\s*:\s*(.*)$/;
/**
 * Parse all debate entries from a `debate-log.md` blob. The header and any other
 * non-entry headings are ignored — only well-formed
 * `## DEBATE-NNN (...) — <status>` blocks become entries.
 */
function parseDebateEntries(text) {
    return (0, md_ledger_1.parseLedgerEntries)(text, HEADING_RE, FIELD_RE, (h) => ({
        id: h.id,
        topic: h.head,
        status: h.tag,
        positions: "",
        resolution: "",
        links: "",
    }), (entry, key, value) => {
        if (key === "Positions")
            entry.positions = value;
        else if (key === "Resolution")
            entry.resolution = value;
        else
            entry.links = value;
    });
}
/**
 * Compute the next `DEBATE-NNN` id from a `debate-log.md` blob: scan every
 * `DEBATE-NNN` token (entries and resolution notes alike so ids stay unique),
 * take the max, add one, zero-pad to 3. Starts at `DEBATE-001`.
 */
function nextDebateId(text) {
    return (0, md_ledger_1.nextLedgerId)(text, "DEBATE");
}
