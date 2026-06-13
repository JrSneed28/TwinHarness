"use strict";
/**
 * Pure parse/format for `debug-log.md` — the Debugger agent's append-only
 * evidence ledger. It mirrors `drift-log.md` (core/drift-log.ts): formatting
 * produces a new block, parsing reads existing blocks, neither rewrites history.
 *
 * The Debugger records FACTS, not decisions: each entry anchors a finding to a
 * REQ-ID/slice with its symptom, evidence (file:line / captured output), root
 * cause, and status. A root cause that contradicts a requirement is escalated as
 * a BLOCKING drift entry through the existing drift flow — the debug log is the
 * evidence trail, the drift log is the governance counter.
 *
 * Canonical entry shape:
 *
 *   ## DEBUG-003  (REQ-007 / SLICE-2)  — open
 *   Symptom  : export CSV omits the trailing newline; acceptance test fails.
 *   Evidence : src/export.ts:42 writes rows without a final "\n"; verify tail …
 *   RootCause: writeRows() joins with "\n" but never appends a terminator.
 *   Status   : open
 *
 * Pure, no IO.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDebugEntry = formatDebugEntry;
exports.parseDebugEntries = parseDebugEntries;
exports.nextDebugId = nextDebugId;
/** Format a debug entry as a markdown block (trailing blank line separates blocks). */
function formatDebugEntry(entry) {
    const status = entry.status ?? "open";
    return [
        `## ${entry.id}  (${entry.ref})  — ${status}`,
        `Symptom  : ${entry.symptom}`,
        `Evidence : ${entry.evidence}`,
        `RootCause: ${entry.rootCause}`,
        `Status   : ${status}`,
        "",
    ].join("\n");
}
const HEADING_RE = /^##\s+(DEBUG-\d+)\s*\(([^)]+)\)\s*—\s*(open|resolved)/;
const FIELD_RE = /^(Symptom|Evidence|RootCause|Status)\s*:\s*(.*)$/;
/** Parse all debug entries from a `debug-log.md` blob. */
function parseDebugEntries(text) {
    const entries = [];
    let current;
    for (const line of text.split(/\r?\n/)) {
        const head = HEADING_RE.exec(line);
        if (head) {
            if (current)
                entries.push(current);
            current = {
                id: head[1],
                ref: head[2].trim(),
                symptom: "",
                evidence: "",
                rootCause: "",
                status: head[3],
            };
            continue;
        }
        if (line.startsWith("## ")) {
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
                if (field[1] === "Symptom")
                    current.symptom = value;
                else if (field[1] === "Evidence")
                    current.evidence = value;
                else if (field[1] === "RootCause")
                    current.rootCause = value;
                else
                    current.status = (value === "resolved" ? "resolved" : "open");
            }
        }
    }
    if (current)
        entries.push(current);
    return entries;
}
/** Compute the next `DEBUG-NNN` id (max existing + 1, zero-padded to 3). */
function nextDebugId(text) {
    let max = 0;
    for (const m of text.matchAll(/DEBUG-(\d+)/g)) {
        const n = Number(m[1]);
        if (n > max)
            max = n;
    }
    return `DEBUG-${String(max + 1).padStart(3, "0")}`;
}
