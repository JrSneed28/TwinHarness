/**
 * REQ-ID anchor extraction (spec §11 tests-as-contract; §15.8/§15.9 traceability:
 * "every MVP REQ-ID maps to ≥1 slice and ≥1 test"). REQ-IDs are the anchors that
 * tie requirements, slice/task IDs, and TEST names together (spec §17).
 *
 * `extractReqIds`/`REQ_ID_PATTERN` are pure (no IO). `scanDirForReqIds` is the
 * Slice-5 file-tree scanner that feeds traceability/orphan detection (§17): it
 * walks a directory and maps each REQ-ID anchor to the files where it appears.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Canonical REQ-ID anchor pattern source (exported so the Slice-5 scanner can
 * reuse the exact same shape). Matches `REQ-001`, `REQ-NFR-001`, `REQ-HASH-001`:
 * a `REQ-` prefix followed by one or more `-`-separated uppercase-alnum segments.
 */
export const REQ_ID_PATTERN = "REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*";

/**
 * Find every REQ-ID anchor in a blob of text and return the UNIQUE set in
 * first-seen (stable) order.
 */
export function extractReqIds(text: string): string[] {
  const re = new RegExp(REQ_ID_PATTERN, "g");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const id = m[0];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Directory names never descended into when scanning a tree for anchors. */
const SCAN_SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

/**
 * Recursively scan `dir` for REQ-ID anchors and return a map of
 * `REQ-ID → list of root-relative (forward-slash) file paths` where it appears.
 *
 * - `extPredicate` optionally restricts which files are read (by file name); when
 *   omitted every regular file is scanned.
 * - `node_modules`, `dist`, and `.git` are always skipped.
 * - File paths are relative to `dir` and use forward slashes for cross-platform
 *   stable output. A missing/non-directory `dir` yields an empty map.
 */
export function scanDirForReqIds(
  dir: string,
  extPredicate?: (name: string) => boolean,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out;

  const walk = (abs: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(abs, entry.name));
      } else if (entry.isFile()) {
        if (extPredicate && !extPredicate(entry.name)) continue;
        const filePath = path.join(abs, entry.name);
        const rel = path.relative(dir, filePath).split(path.sep).join("/");
        const content = fs.readFileSync(filePath, "utf8");
        for (const id of extractReqIds(content)) {
          const files = out.get(id);
          if (files) {
            if (!files.includes(rel)) files.push(rel);
          } else {
            out.set(id, [rel]);
          }
        }
      }
    }
  };
  walk(dir);
  return out;
}
