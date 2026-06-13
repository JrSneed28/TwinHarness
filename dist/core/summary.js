"use strict";
/**
 * Summary-block extraction (spec §9 — "Summaries as handoff currency").
 *
 * Every governing artifact opens with a compact Summary block; the Orchestrator
 * routes that block, not the whole document, to downstream stages. `th context
 * pack` mechanically assembles those blocks into one candidate handoff bundle.
 * This is the extractor: pure, no IO.
 *
 * It COMPUTES a candidate bundle; it does not DECIDE what to route (that stays
 * the Orchestrator's call — plan §3 boundary rule).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractSummary = extractSummary;
/** Heading that opens a Summary block (case-insensitive): `## Summary`, `# Summary`. */
const SUMMARY_HEADING_RE = /^(#{1,3})\s+summary\b/i;
const ANY_HEADING_RE = /^#{1,3}\s+/;
/**
 * Extract the Summary block from markdown. The block runs from a `## Summary`
 * (or `# Summary` / `### Summary`) heading until the next heading of the same or
 * higher level (or end of file). When no Summary heading exists, `summary` is
 * null and `head` carries the first ~`headLines` non-blank lines as a fallback.
 */
function extractSummary(markdown, headLines = 8) {
    const lines = markdown.split(/\r?\n/);
    let startIdx = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
        const m = SUMMARY_HEADING_RE.exec(lines[i]);
        if (m) {
            startIdx = i;
            level = m[1].length;
            break;
        }
    }
    if (startIdx >= 0) {
        const body = [];
        for (let i = startIdx + 1; i < lines.length; i++) {
            const line = lines[i];
            const h = ANY_HEADING_RE.exec(line);
            if (h) {
                const hLevel = (/^#+/.exec(line)?.[0].length) ?? 99;
                if (hLevel <= level)
                    break;
            }
            body.push(line);
        }
        return { summary: body.join("\n").trim(), head: headFallback(lines, headLines) };
    }
    return { summary: null, head: headFallback(lines, headLines) };
}
function headFallback(lines, headLines) {
    const out = [];
    for (const line of lines) {
        if (out.length >= headLines)
            break;
        if (line.trim().length === 0 && out.length === 0)
            continue; // skip leading blanks
        out.push(line);
    }
    return out.join("\n").trim();
}
