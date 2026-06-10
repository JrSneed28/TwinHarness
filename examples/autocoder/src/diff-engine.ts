/**
 * IF-013 DiffPatchEngine.generateDiff — the PURE, deterministic unified-diff
 * generator (REQ-010). Owner component: `diff-engine`.
 *
 * `generateDiff(before, after, path)` renders a terminal-displayable unified diff:
 * a `--- a/<path>` / `+++ b/<path>` file header followed by one or more `@@ -l,c
 * +l,c @@` hunks. The function is PURE — no IO, no clock, no randomness — so the
 * SAME (before, after, path) always yields byte-identical output (a property the
 * tests assert).
 *
 * RULE-002 / INV-003 postcondition: EVERY Edit is representable as a Diff. The two
 * degenerate Edits are explicit:
 *  - `before === null`  → a NEW file (the `---` side is `/dev/null`).
 *  - `after  === ""`    → a DELETION (the `+++` side is `/dev/null`).
 * The empty-vs-empty case (no change) still produces a valid (header-only, zero
 * hunk) diff so even a no-op Edit is representable.
 *
 * SLICE-4 builds ONLY `generateDiff` here; `parsePatch` / `applyHunks` (the read
 * side of IF-013, used by `apply_patch`) land in SLICE-6.
 */

/** Number of unchanged context lines emitted around each change block. */
const CONTEXT = 3;

/** /dev/null sentinel used for the new-file / deletion sides of the header. */
const DEV_NULL = "/dev/null";

/**
 * Split text into lines for diffing. Unlike the reader's splitter we PRESERVE the
 * structure faithfully: an empty string is zero lines; a trailing newline does not
 * add a phantom line. CRLF is normalized to LF so the diff is stable cross-platform.
 */
function toLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** One op in the line-level edit script. */
interface Op {
  kind: "equal" | "del" | "add";
  line: string;
}

/**
 * Compute a line-level edit script (LCS-based) between `a` and `b`. Deterministic:
 * the classic dynamic-programming LCS with a fixed tie-break (prefer deletions
 * before additions) so the output never varies for the same input.
 */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as number[];
    const rowNext = lcs[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        row[j] = (rowNext[j + 1] as number) + 1;
      } else {
        row[j] = Math.max(rowNext[j] as number, row[j + 1] as number);
      }
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] as string;
    const bj = b[j] as string;
    if (ai === bj) {
      ops.push({ kind: "equal", line: ai });
      i++;
      j++;
    } else if ((lcs[i + 1] as number[])[j]! >= (lcs[i] as number[])[j + 1]!) {
      // Deletion is taken when it does not lose LCS length (fixed tie-break).
      ops.push({ kind: "del", line: ai });
      i++;
    } else {
      ops.push({ kind: "add", line: bj });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", line: a[i] as string });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "add", line: b[j] as string });
    j++;
  }
  return ops;
}

/** A grouped change region plus its surrounding context, in 1-based line coords. */
interface Hunk {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  lines: string[]; // each already prefixed with " ", "-", or "+"
}

/**
 * Group the flat op script into unified-diff hunks: a run of changes plus up to
 * CONTEXT lines of equal context on each side, merging adjacent change runs whose
 * separating context is short enough to overlap.
 */
function buildHunks(ops: Op[]): Hunk[] {
  // Index of every op that is an actual change (not equal).
  const changeIdx: number[] = [];
  ops.forEach((op, idx) => {
    if (op.kind !== "equal") {
      changeIdx.push(idx);
    }
  });
  if (changeIdx.length === 0) {
    return [];
  }

  // Merge changes whose gap (of equal ops) is <= 2*CONTEXT into one hunk window.
  const groups: { from: number; to: number }[] = [];
  let groupFrom = changeIdx[0] as number;
  let groupTo = changeIdx[0] as number;
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k] as number;
    if (idx - groupTo <= 2 * CONTEXT + 1) {
      groupTo = idx;
    } else {
      groups.push({ from: groupFrom, to: groupTo });
      groupFrom = idx;
      groupTo = idx;
    }
  }
  groups.push({ from: groupFrom, to: groupTo });

  const hunks: Hunk[] = [];
  for (const g of groups) {
    const start = Math.max(0, g.from - CONTEXT);
    const end = Math.min(ops.length - 1, g.to + CONTEXT);

    // Compute 1-based start lines and counts on each side by counting the ops
    // BEFORE the window, then within it.
    let aBefore = 0;
    let bBefore = 0;
    for (let idx = 0; idx < start; idx++) {
      const op = ops[idx] as Op;
      if (op.kind !== "add") aBefore++;
      if (op.kind !== "del") bBefore++;
    }
    const lines: string[] = [];
    let aCount = 0;
    let bCount = 0;
    for (let idx = start; idx <= end; idx++) {
      const op = ops[idx] as Op;
      if (op.kind === "equal") {
        lines.push(" " + op.line);
        aCount++;
        bCount++;
      } else if (op.kind === "del") {
        lines.push("-" + op.line);
        aCount++;
      } else {
        lines.push("+" + op.line);
        bCount++;
      }
    }
    hunks.push({
      // A zero-length side is reported with start line 0 (unified-diff convention).
      aStart: aCount === 0 ? 0 : aBefore + 1,
      aCount,
      bStart: bCount === 0 ? 0 : bBefore + 1,
      bCount,
      lines,
    });
  }
  return hunks;
}

/**
 * Render a unified diff for an Edit. PURE / deterministic (REQ-010, IF-013).
 *
 * @param before current contents, or `null` for a new file.
 * @param after  new contents; `""` denotes a deletion.
 * @param path   the file path placed in the `a/` `b/` header.
 * @returns a unified-diff string (file headers + `@@` hunks); terminal-displayable.
 *          Always ends with a trailing newline.
 */
export function generateDiff(before: string | null, after: string, path: string): string {
  const isNewFile = before === null;
  const isDeletion = after === "" && !isNewFile;

  const aLines = toLines(before ?? "");
  const bLines = toLines(after);

  const ops = diffLines(aLines, bLines);
  const hunks = buildHunks(ops);

  // File header. New file → the `---` side is /dev/null; deletion → `+++` side is.
  const aHeaderPath = isNewFile ? DEV_NULL : `a/${path}`;
  const bHeaderPath = isDeletion ? DEV_NULL : `b/${path}`;

  const out: string[] = [];
  out.push(`--- ${aHeaderPath}`);
  out.push(`+++ ${bHeaderPath}`);

  for (const h of hunks) {
    out.push(`@@ -${h.aStart},${h.aCount} +${h.bStart},${h.bCount} @@`);
    for (const l of h.lines) {
      out.push(l);
    }
  }

  return out.join("\n") + "\n";
}

/* ===========================================================================
 * SLICE-6 (REQ-023, IF-013 read side): parsePatch + applyHunks.
 *
 * These are the PURE, deterministic READ side of the DiffPatchEngine consumed by
 * `apply_patch` (`tool-applypatch`). They do NO IO and DO NOT mutate disk or any
 * internal state — `applyHunks` is a pure function of (file, hunks) that returns a
 * fresh result string, leaving its inputs untouched. The TOOL (tool-applypatch)
 * enforces all-or-none atomicity across files (RULE-013 / INV-007); the engine only
 * reports per-hunk applicability.
 * ======================================================================== */

/**
 * One parsed unified-diff hunk: the 1-based source/target line anchors from the
 * `@@ -aStart,aCount +bStart,bCount @@` header plus the body lines (each retaining
 * its ` ` / `-` / `+` prefix). A `\` line ("No newline at end of file") is dropped
 * during parsing (it carries no content op for our line-based apply).
 */
export interface ParsedHunk {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  /** Body lines, prefix-preserved: " " context, "-" removed, "+" added. */
  lines: string[];
}

/** One file's worth of parsed hunks, keyed by the `b/` (target) path. */
export interface ParsedPatchFile {
  path: string;
  hunks: ParsedHunk[];
}

/** The whole parsed patch document: an ordered list of per-file hunk sets. */
export interface ParsedPatch {
  files: ParsedPatchFile[];
}

/**
 * Discriminated parse result (IF-013). `ok:true` carries the parsed patch; `ok:false`
 * carries the PATCH_MALFORMED reason. We return a discriminable failure (rather than
 * throwing) so `apply_patch` maps it to a `status:"error"` ToolResult (ERR-011)
 * without a try/catch — RULE-008 (the tool never throws on an expected failure).
 */
export type ParsePatchResult =
  | { ok: true; patch: ParsedPatch }
  | { ok: false; reason: string };

/** Result of a per-file dry-run/apply (IF-013). `applicable:false` names the bad hunk. */
export interface ApplyHunksResult {
  applicable: boolean;
  /** The new file contents when `applicable` — a FRESH string (no input mutation). */
  result?: string;
  /** The 0-based index of the first hunk that failed to apply (when not applicable). */
  failedHunkIndex?: number;
}

/** Strip the target path of a `+++ b/<path>` header (or `--- a/<path>`). */
function headerPath(raw: string): string {
  // Drop a leading `a/` or `b/` marker; a `/dev/null` side is returned verbatim so
  // the caller can detect a new-file (`---` is /dev/null) or deletion (`+++` is).
  let p = raw.trim();
  // Some unified diffs append a tab + timestamp; cut at the first tab.
  const tab = p.indexOf("\t");
  if (tab !== -1) p = p.slice(0, tab);
  if (p === DEV_NULL) return p;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** Parse a `@@ -aStart,aCount +bStart,bCount @@` header; counts default to 1 if omitted. */
function parseHunkHeader(line: string): Omit<ParsedHunk, "lines"> | null {
  // Unified-diff hunk header: `@@ -l[,c] +l[,c] @@[ optional section heading]`.
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  const aStart = Number(m[1]);
  const aCount = m[2] === undefined ? 1 : Number(m[2]);
  const bStart = Number(m[3]);
  const bCount = m[4] === undefined ? 1 : Number(m[4]);
  return { aStart, aCount, bStart, bCount };
}

/**
 * Parse a unified-diff Patch document into per-file hunk sets (IF-013). PURE — no IO.
 *
 * Recognized structure:
 *  - a file block opens with a `--- <a-path>` line immediately followed by `+++ <b-path>`;
 *  - each hunk opens with a `@@ -..,.. +..,.. @@` header and carries ` `/`-`/`+` body lines;
 *  - a `\ No newline at end of file` marker line is tolerated and dropped.
 *
 * Anything that breaks this structure (a `@@` before any file header, a `+++` with no
 * preceding `---`, a hunk whose body line counts disagree with the header, zero files,
 * or zero hunks for a file) is reported as PATCH_MALFORMED (ERR-011) via `ok:false`.
 */
export function parsePatch(patchText: string): ParsePatchResult {
  if (typeof patchText !== "string" || patchText.length === 0) {
    return { ok: false, reason: "empty patch" };
  }
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline yields a final empty element; drop it so it is not mis-read.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const files: ParsedPatchFile[] = [];
  let current: ParsedPatchFile | null = null;
  let activeHunk: ParsedHunk | null = null;
  // Running tallies of body lines seen for the active hunk, checked against its header.
  let seenA = 0;
  let seenB = 0;

  function closeHunk(): string | null {
    if (!activeHunk) return null;
    // The hunk body must contribute exactly the counts its header declared.
    if (seenA !== activeHunk.aCount || seenB !== activeHunk.bCount) {
      return `hunk line counts disagree with header (@@ -${activeHunk.aStart},${activeHunk.aCount} +${activeHunk.bStart},${activeHunk.bCount} @@: saw ${seenA}/${seenB})`;
    }
    activeHunk = null;
    seenA = 0;
    seenB = 0;
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (line.startsWith("--- ")) {
      const closeErr = closeHunk();
      if (closeErr) return { ok: false, reason: closeErr };
      // A `---` must be immediately followed by a `+++` (the two-line file header).
      const next = lines[i + 1];
      if (typeof next !== "string" || !next.startsWith("+++ ")) {
        return { ok: false, reason: "`---` file header not followed by `+++`" };
      }
      const aPath = headerPath(line.slice(4));
      const bPath = headerPath(next.slice(4));
      // The target path is the `+++` side unless this is a deletion (b is /dev/null),
      // in which case the `---` side names the file being removed.
      const target = bPath === DEV_NULL ? aPath : bPath;
      if (target === DEV_NULL || target.length === 0) {
        return { ok: false, reason: "file header has no resolvable target path" };
      }
      current = { path: target, hunks: [] };
      files.push(current);
      i++; // consumed the `+++` line
      continue;
    }

    if (line.startsWith("+++ ")) {
      // A `+++` not immediately preceded by a consumed `---` is malformed.
      return { ok: false, reason: "`+++` header without a preceding `---`" };
    }

    if (line.startsWith("@@")) {
      const closeErr = closeHunk();
      if (closeErr) return { ok: false, reason: closeErr };
      if (!current) {
        return { ok: false, reason: "hunk `@@` before any file header" };
      }
      const head = parseHunkHeader(line);
      if (!head) {
        return { ok: false, reason: `malformed hunk header: ${line}` };
      }
      activeHunk = { ...head, lines: [] };
      seenA = 0;
      seenB = 0;
      current.hunks.push(activeHunk);
      continue;
    }

    if (activeHunk) {
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" — tolerated, no content op.
        continue;
      }
      const marker = line[0];
      if (marker === " " || line === "") {
        // A bare empty line inside a hunk is a context line for an empty source line.
        activeHunk.lines.push(line === "" ? " " : line);
        seenA++;
        seenB++;
      } else if (marker === "-") {
        activeHunk.lines.push(line);
        seenA++;
      } else if (marker === "+") {
        activeHunk.lines.push(line);
        seenB++;
      } else {
        return { ok: false, reason: `unexpected line inside hunk: ${line}` };
      }
      continue;
    }

    // Outside any hunk and not a recognized header: tolerate blank separators, but a
    // non-blank, non-header line with no active file/hunk is malformed.
    if (line.trim().length === 0) continue;
    return { ok: false, reason: `unexpected line outside a hunk: ${line}` };
  }

  const closeErr = closeHunk();
  if (closeErr) return { ok: false, reason: closeErr };

  if (files.length === 0) {
    return { ok: false, reason: "no file headers found in patch" };
  }
  for (const f of files) {
    if (f.hunks.length === 0) {
      return { ok: false, reason: `file ${f.path} has no hunks` };
    }
  }
  return { ok: true, patch: { files } };
}

/**
 * DRY-RUN / apply a file's hunks against its current contents (IF-013). PURE — it
 * does NOT touch disk and does NOT mutate `file` or `hunks`; it returns a fresh
 * `result` string when every hunk applies cleanly.
 *
 * Application model (line-based, exact-context): each hunk anchors at its `aStart`
 * (1-based) line. The ` ` (context) and `-` (removed) body lines must match the
 * current file lines EXACTLY at that anchor; `+` lines are inserted. If any hunk's
 * context/removal does not match at its anchor → `{applicable:false, failedHunkIndex}`
 * and NO result (the tool then rejects the whole patch — RULE-013). A new file
 * (current contents "") is applied from an `aStart` of 0 with an all-`+` hunk.
 *
 * @param file  current file contents (use "" for a not-yet-existing target).
 * @param hunks the parsed hunks for this one file, in document order.
 */
export function applyHunks(file: string, hunks: ParsedHunk[]): ApplyHunksResult {
  // Split current contents into lines WITHOUT losing structure (mirrors toLines).
  const original = toLines(file);
  // Work on a copy so the input is never mutated (dry-run purity).
  const out: string[] = [];
  let cursor = 0; // 0-based index into `original` consumed so far

  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h] as ParsedHunk;
    // The hunk anchors at aStart (1-based). aStart 0 (a pure-add / new-file hunk)
    // means "before line 1" → anchor index 0.
    const anchor = hunk.aStart > 0 ? hunk.aStart - 1 : 0;

    // Carry forward any unchanged lines between the cursor and the anchor verbatim.
    if (anchor < cursor) {
      // Hunks must be in non-overlapping, ascending order; an anchor behind the
      // cursor cannot be satisfied → not applicable.
      return { applicable: false, failedHunkIndex: h };
    }
    for (let k = cursor; k < anchor; k++) {
      const carried = original[k];
      if (carried === undefined) {
        return { applicable: false, failedHunkIndex: h };
      }
      out.push(carried);
    }
    cursor = anchor;

    // Walk the hunk body: context/removed lines must match `original[cursor]` exactly.
    for (const body of hunk.lines) {
      const marker = body[0];
      const text = body.slice(1);
      if (marker === " ") {
        if (original[cursor] !== text) {
          return { applicable: false, failedHunkIndex: h };
        }
        out.push(text);
        cursor++;
      } else if (marker === "-") {
        if (original[cursor] !== text) {
          return { applicable: false, failedHunkIndex: h };
        }
        cursor++; // removed: consume the source line, do not emit it
      } else if (marker === "+") {
        out.push(text); // added: emit, consume no source line
      } else {
        // A body line with no recognized marker is not applicable.
        return { applicable: false, failedHunkIndex: h };
      }
    }
  }

  // Append any remaining unchanged tail after the last hunk.
  for (let k = cursor; k < original.length; k++) {
    out.push(original[k] as string);
  }

  // Reassemble. An empty result (full deletion) is the empty string; otherwise join
  // with newlines and add the trailing newline (matches generateDiff's line model).
  const result = out.length === 0 ? "" : out.join("\n") + "\n";
  return { applicable: true, result };
}

/**
 * The DiffPatchEngine surface for `diff-engine`. SLICE-4 exposes `generateDiff`;
 * SLICE-6 adds the read side `parsePatch` / `applyHunks` (IF-013).
 */
export interface DiffEngine {
  generateDiff(before: string | null, after: string, path: string): string;
  parsePatch(patchText: string): ParsePatchResult;
  applyHunks(file: string, hunks: ParsedHunk[]): ApplyHunksResult;
}

/** Construct the diff engine (a thin holder over the pure functions). */
export function createDiffEngine(): DiffEngine {
  return { generateDiff, parsePatch, applyHunks };
}
