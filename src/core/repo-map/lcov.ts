/**
 * `repo-map/lcov.ts` — PURE, CONTAINED ingestion of an lcov coverage report
 * (P2-6b). The lcov file is UNTRUSTED repo content (RULE-004): it is never
 * executed, and every path it names is resolved through the SAME repo-containment
 * check the scanner uses. A path that escapes the repo root (`..`, absolute, or a
 * Windows drive) is REJECTED — lcov can never grant a coverage edge to an
 * out-of-repo path, and there is NO symlink traversal (we resolve textually, never
 * touch the filesystem here).
 *
 * lcov format (the bits we use):
 *   SF:<source-file-path>   — start of a record for one source file
 *   end_of_record           — end of that record
 * We extract only the SF: source paths, contain them, and POSIX-normalize them so a
 * caller can intersect them with the in-repo file set.
 */

import * as path from "node:path";

/**
 * Resolve an lcov-declared path to a repo-relative POSIX path, or null if it
 * escapes the repo root. `lcovDir` is the POSIX-relative directory of the lcov file
 * itself (so a relative SF path is resolved against it, matching how coverage tools
 * emit paths relative to the report). Absolute paths are accepted ONLY when they
 * fall under `absRoot`. This mirrors the scanner's containment guarantee
 * (REQ-RU-092 / REQ-NFR-003): no path escapes root, no symlink traversal.
 */
export function containLcovPath(
  absRoot: string,
  lcovDirRel: string,
  sfPath: string,
): string | null {
  if (sfPath.length === 0) return null;
  const norm = sfPath.replace(/\\/g, "/");
  // Absolute (POSIX or Windows drive) — accept only if under absRoot.
  const isAbsolute = norm.startsWith("/") || /^[A-Za-z]:\//.test(norm);
  let abs: string;
  if (isAbsolute) {
    abs = path.resolve(norm);
  } else {
    abs = path.resolve(absRoot, lcovDirRel, norm);
  }
  const rel = path.relative(absRoot, abs).split(path.sep).join("/");
  // Reject anything that climbs out of the repo root.
  if (rel === "" || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) {
    return null;
  }
  return rel;
}

/**
 * Parse lcov text into the SET of CONTAINED, in-repo source paths it covers. Paths
 * that escape the root are dropped (never returned). `knownFiles`, when provided,
 * further restricts the result to files the scanner actually saw (so a stale lcov
 * entry for a deleted file does not introduce a phantom path). Returns POSIX-relative
 * paths.
 */
export function parseLcovContained(
  lcovText: string,
  absRoot: string,
  lcovDirRel: string,
  knownFiles?: Set<string>,
): string[] {
  const out = new Set<string>();
  // Coverage tools disagree on the base for a RELATIVE SF path: most (jest/c8/nyc and
  // `lcov -c -d .`) emit it relative to the repo ROOT, a few relative to the report
  // directory. Try the report dir first (documented intent), then the repo root, and
  // accept the FIRST base that lands on a KNOWN in-repo file. Absolute SF paths ignore
  // the base. Because every candidate is gated by `knownFiles`, the extra base can never
  // grant a false edge — it only recovers the common `coverage/lcov.info` + root-relative
  // layout that the report-dir-only base silently dropped.
  const bases = lcovDirRel === "" ? [""] : [lcovDirRel, ""];
  for (const line of lcovText.split(/\r?\n/)) {
    const m = /^SF:(.*)$/.exec(line.trim());
    if (!m) continue;
    const sf = m[1]!.trim();
    for (const base of bases) {
      const contained = containLcovPath(absRoot, base, sf);
      if (contained === null) continue; // escaping path under this base — try the next
      if (knownFiles && !knownFiles.has(contained)) continue; // unknown under this base
      out.add(contained);
      break; // first base that yields a (known) contained path wins
    }
  }
  return [...out];
}
