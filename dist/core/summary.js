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
exports.extractSection = extractSection;
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
/**
 * SG3 P1-B (C-12) — generalise {@link extractSummary} to pull the body of ANY named
 * heading. The section runs from the FIRST heading whose text matches `name`
 * (case-insensitive, trimmed; markdown `#…######` of any level) until the next
 * heading of the SAME OR HIGHER level (or end of file) — the identical
 * level-scoping rule {@link extractSummary} uses. This is the uncapped extractor a
 * caller wraps in a token budget (`th artifact section`), replacing the prior
 * Summary-only extraction so an agent can read JUST the section it needs.
 *
 * Matching is on the heading's TEXT after the `#` markers, trimmed; a trailing
 * anchor/`{#id}` or surrounding whitespace does not defeat the match, but the core
 * text must equal `name` (not merely contain it) so `## Risks` does not match a
 * request for `Risk`.
 */
function extractSection(markdown, name) {
    const lines = markdown.split(/\r?\n/);
    const want = name.trim().toLowerCase();
    const headingRe = /^(#{1,6})\s+(.+?)\s*$/;
    let startIdx = -1;
    let level = 0;
    let heading = null;
    for (let i = 0; i < lines.length; i++) {
        const m = headingRe.exec(lines[i]);
        if (!m)
            continue;
        // Normalize the heading text: strip a trailing `{#anchor}` and surrounding ws.
        const text = m[2].replace(/\s*\{#[^}]*\}\s*$/, "").trim().toLowerCase();
        if (text === want) {
            startIdx = i;
            level = m[1].length;
            heading = lines[i];
            break;
        }
    }
    if (startIdx < 0)
        return { found: false, heading: null, body: "" };
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
    return { found: true, heading, body: body.join("\n").trim() };
}
