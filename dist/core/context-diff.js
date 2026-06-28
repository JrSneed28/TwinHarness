"use strict";
/**
 * context-diff.ts — S2 delta-patch computation (D-12/D-13).
 *
 * Vendored Myers line-diff, 3 context lines, NO network.
 * Symbol-boundary annotation via extractSymbols (D-12).
 * All fallback conditions return FULL — never throws across the boundary.
 *
 * Key exports:
 *   DeltaPatch / DeltaResult / DeltaOpts
 *   computeDelta(baseContent, currentContent, opts): DeltaResult
 *   reconstruct(baseContent, patch): string
 *   assertBaseObjectPresent(paths, base_hash): boolean   (5d guard)
 *   DIFF_RATIO_THRESHOLD / DIFF_MAX_HUNKS               (Balanced preset tunables)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DIFF_CONTEXT_LINES = exports.DIFF_MAX_HUNKS = exports.DIFF_RATIO_THRESHOLD = void 0;
exports.isDenylisted = isDenylisted;
exports.assertBaseObjectPresent = assertBaseObjectPresent;
exports.reconstruct = reconstruct;
exports.computeDelta = computeDelta;
const hash_1 = require("./hash");
const extract_1 = require("./repo-map/extract");
const context_page_1 = require("./context-page");
// ---------------------------------------------------------------------------
// Tunables — Balanced preset; overridable via DeltaOpts for tests
// ---------------------------------------------------------------------------
/** Fallback to FULL when changed-line ratio exceeds this threshold (D-13). */
exports.DIFF_RATIO_THRESHOLD = 0.6;
/** Fallback to FULL when hunk count exceeds this threshold. */
exports.DIFF_MAX_HUNKS = 12;
/** Context lines around each change group in a hunk. */
exports.DIFF_CONTEXT_LINES = 3;
// ---------------------------------------------------------------------------
// Denylist — locators matching these always fall back to FULL
// ---------------------------------------------------------------------------
const DIFF_DENYLIST = [
    /\.env(\.|$)/i,
    /credentials?\.(json|ya?ml|toml|ini|txt)$/i,
    /secrets?\.(json|ya?ml|toml|ini|txt)$/i,
    /\.pem$/i,
    /\.key$/i,
    /private[_\-]?key/i,
];
/** True when the locator matches any denylist pattern. */
function isDenylisted(locator) {
    return DIFF_DENYLIST.some((p) => p.test(locator));
}
/**
 * Myers diff: shortest edit script between two line arrays.
 * Returns ops in order: equal/insert/delete.
 */
function myersDiff(a, b) {
    const N = a.length;
    const M = b.length;
    if (N === 0 && M === 0)
        return [];
    if (N === 0)
        return b.map((line) => ({ kind: "insert", line }));
    if (M === 0)
        return a.map((line) => ({ kind: "delete", line }));
    const MAX = N + M;
    // v[k + MAX] = furthest-reaching x on diagonal k
    // Sentinel: v[1 + MAX] = 0 so the k=0 case in d=0 can read v[k+1+MAX].
    const v = new Array(2 * MAX + 1).fill(0);
    v[1 + MAX] = 0;
    // trace[d] = snapshot of v at the START of iteration d (before d's writes).
    const trace = [];
    let foundD = -1;
    outer: for (let d = 0; d <= MAX; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x;
            // Choose move: down (insert from b, diagonal k+1) or right (delete from a, diagonal k-1)
            if (k === -d) {
                x = v[(k + 1) + MAX]; // must go down
            }
            else if (k === d) {
                x = v[(k - 1) + MAX] + 1; // must go right
            }
            else if (v[(k - 1) + MAX] < v[(k + 1) + MAX]) {
                x = v[(k + 1) + MAX]; // prefer down (insert)
            }
            else {
                x = v[(k - 1) + MAX] + 1; // prefer right (delete)
            }
            let y = x - k;
            // Extend along diagonal (equal lines)
            while (x < N && y < M && a[x] === b[y]) {
                x++;
                y++;
            }
            v[k + MAX] = x;
            if (x >= N && y >= M) {
                foundD = d;
                break outer;
            }
        }
    }
    if (foundD < 0) {
        // Defensive: should not happen; return delete-all then insert-all
        return [
            ...a.map((line) => ({ kind: "delete", line })),
            ...b.map((line) => ({ kind: "insert", line })),
        ];
    }
    // Backtrack through trace to reconstruct edit ops
    const ops = [];
    let x = N;
    let y = M;
    for (let d = foundD; d > 0; d--) {
        const vd = trace[d];
        const k = x - y;
        // Determine which diagonal we came from
        let prevK;
        if (k === -d) {
            prevK = k + 1; // came via insert
        }
        else if (k === d) {
            prevK = k - 1; // came via delete
        }
        else if (vd[(k - 1) + MAX] < vd[(k + 1) + MAX]) {
            prevK = k + 1; // came via insert
        }
        else {
            prevK = k - 1; // came via delete
        }
        const prevX = vd[prevK + MAX];
        const prevY = prevX - prevK;
        // Entry point on diagonal k after the one non-diagonal move in step d
        let entryX;
        if (prevK === k + 1) {
            entryX = vd[(k + 1) + MAX]; // insert: x unchanged
        }
        else {
            entryX = vd[(k - 1) + MAX] + 1; // delete: x advanced
        }
        const entryY = entryX - k;
        // Diagonal (equal) moves from entry to current position
        while (x > entryX && y > entryY) {
            ops.push({ kind: "equal", line: a[x - 1] });
            x--;
            y--;
        }
        // The single non-diagonal move
        if (prevK === k + 1) {
            // insert: y moved from prevY to entryY
            ops.push({ kind: "insert", line: b[y - 1] });
            y--;
        }
        else {
            // delete: x moved from prevX to entryX
            ops.push({ kind: "delete", line: a[x - 1] });
            x--;
        }
        // (x, y) is now at (prevX, prevY)
    }
    // d=0: remaining equals from (x,y) back to (0,0)
    while (x > 0 && y > 0) {
        ops.push({ kind: "equal", line: a[x - 1] });
        x--;
        y--;
    }
    ops.reverse();
    return ops;
}
// ---------------------------------------------------------------------------
// Hunk builder
// ---------------------------------------------------------------------------
function opsToHunks(ops, contextLines) {
    const annotated = [];
    let baseNo = 1;
    let currentNo = 1;
    for (const op of ops) {
        if (op.kind === "equal") {
            annotated.push({ ...op, baseLineNo: baseNo++, currentLineNo: currentNo++ });
        }
        else if (op.kind === "delete") {
            annotated.push({ ...op, baseLineNo: baseNo++, currentLineNo: null });
        }
        else {
            annotated.push({ ...op, baseLineNo: null, currentLineNo: currentNo++ });
        }
    }
    // Mark changed indices
    const changedSet = new Set();
    for (let i = 0; i < annotated.length; i++) {
        if (annotated[i].kind !== "equal")
            changedSet.add(i);
    }
    if (changedSet.size === 0)
        return [];
    // Expand each changed index with context window
    const inWindow = new Set();
    for (const ci of changedSet) {
        const lo = Math.max(0, ci - contextLines);
        const hi = Math.min(annotated.length - 1, ci + contextLines);
        for (let j = lo; j <= hi; j++)
            inWindow.add(j);
    }
    // Split contiguous index ranges into groups
    const sorted = [...inWindow].sort((a, b) => a - b);
    const groups = [];
    let cur = [];
    for (let i = 0; i < sorted.length; i++) {
        if (i === 0 || sorted[i] !== sorted[i - 1] + 1) {
            if (cur.length > 0)
                groups.push(cur);
            cur = [sorted[i]];
        }
        else {
            cur.push(sorted[i]);
        }
    }
    if (cur.length > 0)
        groups.push(cur);
    return groups.map((indices) => {
        const hunkOps = indices.map((i) => annotated[i]);
        const baseNos = hunkOps.filter((o) => o.baseLineNo !== null).map((o) => o.baseLineNo);
        const currentNos = hunkOps.filter((o) => o.currentLineNo !== null).map((o) => o.currentLineNo);
        const baseStart = baseNos.length > 0 ? Math.min(...baseNos) : 1;
        const currentStart = currentNos.length > 0 ? Math.min(...currentNos) : 1;
        const lines = hunkOps.map((o) => {
            const prefix = o.kind === "equal" ? " " : o.kind === "insert" ? "+" : "-";
            return prefix + o.line;
        });
        return {
            baseStart,
            baseCount: baseNos.length,
            currentStart,
            currentCount: currentNos.length,
            lines,
        };
    });
}
/**
 * Find symbol spans by scanning content line-by-line for declaration patterns
 * matching the extractSymbols languages. Body runs to the next same-or-higher
 * boundary (mirroring extractSummary's heading-level logic in summary.ts).
 */
function findSymbolSpans(content, ext) {
    const lines = content.split(/\r?\n/);
    const e = ext.replace(/^\./, "").toLowerCase();
    // Per-language declaration pattern; group 1 = keyword/kind, group 2 = name.
    // Go uses a single capture group (name only) since group 2 may be absent.
    let re = null;
    switch (e) {
        case "ts":
        case "tsx":
        case "mts":
        case "cts":
        case "js":
        case "jsx":
        case "mjs":
        case "cjs":
            re = /^[ \t]*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var|namespace|module)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
            break;
        case "py":
            re = /^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
            break;
        case "go":
            re = /^(?:func(?:\s*\([^)]*\))?|type)\s+([A-Z][A-Za-z0-9_]*)/;
            break;
        case "rs":
            re = /^[ \t]*pub(?:\([^)]*\))?\s+(?:async\s+)?(fn|struct|enum|trait|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)/;
            break;
        case "java":
            re = /\bpublic\s+(?:final\s+|abstract\s+|sealed\s+)?(class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
            break;
        default:
            return [];
    }
    const spans = [];
    for (let i = 0; i < lines.length; i++) {
        const m = re.exec(lines[i]);
        if (m) {
            // Go: name is group 1; others: name is group 2 when present
            const name = m[2] ?? m[1] ?? "?";
            spans.push({ name, startLine: i + 1, endLine: lines.length });
        }
    }
    // Set endLine: run to just before next symbol (body span)
    for (let i = 0; i < spans.length - 1; i++) {
        spans[i].endLine = spans[i + 1].startLine - 1;
    }
    return spans;
}
/** Tag each hunk with the symbol it primarily belongs to (advisory; skipped on error). */
function annotateHunkSymbols(hunks, spans) {
    if (spans.length === 0)
        return hunks;
    return hunks.map((hunk) => {
        const midLine = hunk.baseStart + Math.floor(hunk.baseCount / 2);
        const span = spans.find((s) => s.startLine <= midLine && midLine <= s.endLine);
        return span ? { ...hunk, symbol: span.name } : hunk;
    });
}
// ---------------------------------------------------------------------------
// 5d: base-object presence guard
// ---------------------------------------------------------------------------
/**
 * 5d enforcement: verify the base content object exists in the CAS cold store
 * before constructing a delta. Returns true when present, false when absent
 * (⇒ caller should return FULL). Never throws.
 */
function assertBaseObjectPresent(paths, base_hash) {
    try {
        return (0, context_page_1.coldStoreGet)(paths, base_hash) !== undefined;
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// reconstruct
// ---------------------------------------------------------------------------
/** True when CRLF is the dominant line ending in `s` (vs lone LF). */
function preferCrlf(s) {
    const crlf = (s.match(/\r\n/g) ?? []).length;
    const lf = (s.match(/\n/g) ?? []).length;
    const loneLf = lf - crlf;
    return crlf > loneLf;
}
/**
 * Reconstruct the current content from base content and a delta patch.
 * Pure, no I/O; never throws (returns baseContent on any error).
 *
 * The line split is EOL-agnostic (`/\r?\n/`), so the join must restore the
 * original ending. We try the base's dominant ending first, then the alternate,
 * and accept whichever candidate matches the patch's `current_hash`. This makes
 * uniform CRLF content round-trip exactly (previously it was silently rewritten
 * to LF) and ensures a lossy reconstruction (e.g. mixed EOLs) is never returned
 * as if correct — on no match we fall back to `baseContent` (#7).
 */
function reconstruct(baseContent, patch) {
    try {
        const baseLines = baseContent.split(/\r?\n/);
        const out = [];
        let baseIdx = 1; // 1-based cursor
        for (const hunk of patch.hunks) {
            // Emit unchanged base lines before this hunk
            while (baseIdx < hunk.baseStart) {
                out.push(baseLines[baseIdx - 1] ?? "");
                baseIdx++;
            }
            // Apply hunk lines
            for (const rawLine of hunk.lines) {
                const prefix = rawLine[0];
                const content = rawLine.slice(1);
                if (prefix === " ") {
                    // context: emit and advance
                    out.push(content);
                    baseIdx++;
                }
                else if (prefix === "+") {
                    // insert: emit, no base advance
                    out.push(content);
                }
                else if (prefix === "-") {
                    // delete: skip base line
                    baseIdx++;
                }
            }
        }
        // Emit remaining base lines after all hunks
        while (baseIdx <= baseLines.length) {
            out.push(baseLines[baseIdx - 1] ?? "");
            baseIdx++;
        }
        // Restore the original line ending, validating against current_hash.
        const eolCandidates = preferCrlf(baseContent) ? ["\r\n", "\n"] : ["\n", "\r\n"];
        for (const eol of eolCandidates) {
            const candidate = out.join(eol);
            if (!patch.current_hash || (0, hash_1.hashContent)(candidate) === patch.current_hash) {
                return candidate;
            }
        }
        // No EOL candidate reproduced current_hash → fail-safe; the caller should
        // treat reconstruction as failed and fetch the FULL object instead.
        return baseContent;
    }
    catch {
        return baseContent;
    }
}
// ---------------------------------------------------------------------------
// computeDelta
// ---------------------------------------------------------------------------
/**
 * Compute a delta patch between baseContent and currentContent.
 *
 * Returns DeltaPatch on success or { fallback: "FULL"; reason } on any fallback
 * condition (binary, sensitive, base-not-resident, base-object-miss, ratio>threshold,
 * hunk count>max, denylist, or any unexpected error).
 *
 * Never throws across the boundary.
 */
function computeDelta(baseContent, currentContent, opts = {}) {
    try {
        const { locator, ext, sensitive = false, baseNotResident = false, paths, baseHash, ratioThreshold = exports.DIFF_RATIO_THRESHOLD, maxHunks = exports.DIFF_MAX_HUNKS, } = opts;
        // Binary check
        if ((0, extract_1.looksBinary)(Buffer.from(baseContent, "utf8")) || (0, extract_1.looksBinary)(Buffer.from(currentContent, "utf8"))) {
            return { fallback: "FULL", reason: "binary" };
        }
        // Sensitive
        if (sensitive) {
            return { fallback: "FULL", reason: "sensitive" };
        }
        // Base not resident
        if (baseNotResident) {
            return { fallback: "FULL", reason: "base-not-resident" };
        }
        // 5d: base-object-miss (when paths + baseHash provided)
        if (paths !== undefined && baseHash !== undefined) {
            if (!assertBaseObjectPresent(paths, baseHash)) {
                return { fallback: "FULL", reason: "base-object-miss" };
            }
        }
        // Denylist
        if (locator !== undefined && isDenylisted(locator)) {
            return { fallback: "FULL", reason: "denylist" };
        }
        // Split into lines for diff
        const baseLines = baseContent.split(/\r?\n/);
        const currentLines = currentContent.split(/\r?\n/);
        const ops = myersDiff(baseLines, currentLines);
        const hunks = opsToHunks(ops, exports.DIFF_CONTEXT_LINES);
        // Fallback: too many hunks
        if (hunks.length > maxHunks) {
            return { fallback: "FULL", reason: `hunks=${hunks.length} > ${maxHunks}` };
        }
        // Fallback: ratio too high.
        // Ratio = (deleted + inserted) / (N + M).  Dividing by N+M rather than
        // max(N,M) avoids double-counting a replacement (1 delete + 1 insert = 2
        // ops) against a small denominator — a single replacement in a 3-line file
        // scores 2/6 = 0.33 instead of 2/3 = 0.67.
        const changedOps = ops.filter((o) => o.kind !== "equal").length;
        const total = Math.max(baseLines.length + currentLines.length, 1);
        const ratio = changedOps / total;
        if (ratio > ratioThreshold) {
            return { fallback: "FULL", reason: `ratio=${ratio.toFixed(3)} > ${ratioThreshold}` };
        }
        // Symbol-boundary annotation (advisory; failure does not trigger FULL)
        let annotatedHunks = hunks;
        if (ext) {
            try {
                // Verify extension is parseable by checking extractSymbols returns something
                // meaningful (it returns [] for unknown exts — no cost to call).
                const spans = findSymbolSpans(baseContent, ext);
                annotatedHunks = annotateHunkSymbols(hunks, spans);
            }
            catch {
                // annotation is best-effort
            }
        }
        return {
            base_hash: (0, hash_1.hashContent)(baseContent),
            current_hash: (0, hash_1.hashContent)(currentContent),
            hunks: annotatedHunks,
        };
    }
    catch {
        return { fallback: "FULL", reason: "error" };
    }
}
