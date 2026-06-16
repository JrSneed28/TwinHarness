"use strict";
/**
 * Shared append-only markdown-ledger core (CQ-001/005 dedup). The drift log
 * (§10) and the debate ledger (REQ-PCO-042) were near-identical twins: each had
 * its own `formatX`, `HEADING_RE`, `extractRef`/`extractTopic`, `FIELD_RE`,
 * `parseXEntries`, and `nextXId`. This module factors out the structure they
 * truly share — heading assembly with an attributed `(<head>, <source>)`
 * parenthetical, source-suffix stripping, the line-by-line block parser, and
 * monotonic id minting — and parameterizes the parts that legitimately differ
 * (id prefix, the heading tail, the heading regex, the field labels/regex, and
 * the per-field assignment).
 *
 * The emitted markdown for BOTH logs is byte-identical to the old per-ledger
 * code: `formatLedgerEntry` joins the same heading + aligned field lines + a
 * trailing blank line, and each ledger supplies its exact label strings (with
 * their original alignment padding). Pure, no IO — both `drift-log.ts` and
 * `debate-log.ts` build on this and re-export the same public names.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatLedgerEntry = formatLedgerEntry;
exports.extractHead = extractHead;
exports.parseLedgerEntries = parseLedgerEntries;
exports.nextLedgerId = nextLedgerId;
/**
 * Format one ledger entry as its markdown block (trailing blank line so blocks
 * are visually separated when appended). The heading is
 * `## <id>  (<head>, <source>)  — <tail>`; each field line is `<label>: <value>`.
 * Byte-identical to the old per-ledger `formatX` (same spacing, same trailing
 * blank line) given the same config.
 */
function formatLedgerEntry(entry, config) {
    const heading = `## ${entry.id}  (${entry.head}, ${entry.source})  — ${config.headingTail(entry)}`;
    const lines = [heading];
    for (const field of config.fields) {
        lines.push(`${field.label}: ${field.value(entry)}`);
    }
    lines.push("");
    return lines.join("\n");
}
/**
 * Strip the optional ", <source>" suffix from a parenthetical head string. If
 * the string contains a comma, the part after the LAST comma is the source
 * label; strip it and return just the head (the drift `ref` / debate `topic`).
 * Byte-identical to the old `extractRef`/`extractTopic`.
 */
function extractHead(paren) {
    const lastComma = paren.lastIndexOf(",");
    if (lastComma < 0)
        return paren.trim();
    return paren.slice(0, lastComma).trim();
}
/**
 * Parse all entries from a ledger blob. The header and any non-entry headings
 * (e.g. resolution notes `## DRIFT-NNN — resolved`) terminate the current entry
 * and are ignored — only headings matching `headingRe` start an entry.
 *
 * `headingRe` must capture: (1) id, (2) parenthetical content, (3) the
 * layer/status token. `fieldRe` must capture: (1) the field key, (2) its value.
 * `make` builds a fresh accumulator from the parsed heading; `assign` writes a
 * matched field's value onto it. This is the exact line-by-line loop the two
 * per-ledger parsers shared.
 */
function parseLedgerEntries(text, headingRe, fieldRe, make, assign) {
    const entries = [];
    const lines = text.split(/\r?\n/);
    let current;
    for (const line of lines) {
        const head = headingRe.exec(line);
        if (head) {
            if (current)
                entries.push(current);
            current = make({ id: head[1], head: extractHead(head[2]), tag: head[3] });
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
            const field = fieldRe.exec(line);
            if (field) {
                assign(current, field[1], field[2]);
            }
        }
    }
    if (current)
        entries.push(current);
    return entries;
}
/**
 * Compute the next `<PREFIX>-NNN` id from a ledger blob: scan every
 * `<PREFIX>-NNN` token (entries and resolution notes alike so ids stay unique),
 * take the max, add one, zero-pad to 3. Starts at `<PREFIX>-001`. Byte-identical
 * to the old `nextDriftId`/`nextDebateId`.
 */
function nextLedgerId(text, prefix) {
    let max = 0;
    const re = new RegExp(`${prefix}-(\\d+)`, "g");
    for (const m of text.matchAll(re)) {
        const n = Number(m[1]);
        if (n > max)
            max = n;
    }
    return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}
