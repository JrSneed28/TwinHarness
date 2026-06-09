import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { extractReqIds, scanDirForReqIds } from "../core/anchors";
import { structuredLog } from "../core/log";

/**
 * `th anchors scan` — the REQ-anchor file-tree scanner (spec §17 anchors feed
 * traceability; §11 tests-as-contract). Mechanical only (plan §3 boundary rule):
 * it reports WHERE each REQ-ID anchor appears across requirements/tests/code and
 * flags ORPHANS (anchors in tests/ or src/ with no matching defined requirement).
 * It never decides whether a requirement is correct.
 */

export interface AnchorsScanOptions {
  reqs?: boolean;
  tests?: boolean;
  code?: boolean;
  strict?: boolean;
}

/** A REQ anchor found in tests/ or src/ with no matching defined requirement. */
export interface Orphan {
  req: string;
  where: string;
}

/** A scanned category: REQ-ID → root-relative files where the anchor appears. */
type CategoryMap = Record<string, string[]>;

const DEFAULT_DIRS = {
  requirements: "docs",
  tests: "tests",
  code: "src",
} as const;

/** Turn a `Map<string, string[]>` (insertion-ordered) into a plain record. */
function toRecord(m: Map<string, string[]>): CategoryMap {
  const out: CategoryMap = {};
  for (const [req, files] of m) out[req] = files;
  return out;
}

/**
 * The DEFINED requirement set = REQ-IDs in `docs/01-requirements.md` if present,
 * else every REQ-ID anywhere under `docs/`. Returned as a Set for membership tests.
 */
function definedRequirementSet(paths: ProjectPaths): Set<string> {
  const reqsFile = path.join(paths.docsDir, "01-requirements.md");
  if (fs.existsSync(reqsFile) && fs.statSync(reqsFile).isFile()) {
    return new Set(extractReqIds(fs.readFileSync(reqsFile, "utf8")));
  }
  const ids = new Set<string>();
  for (const id of scanDirForReqIds(paths.docsDir).keys()) ids.add(id);
  return ids;
}

/**
 * `th anchors scan` — scan the selected categories for REQ-ID anchors and detect
 * orphans. If none of reqs/tests/code is requested, all three are scanned.
 * Exit 0 normally; with `strict` and a non-empty orphan list → failure (exit 1).
 */
export function runAnchorsScan(paths: ProjectPaths, opts: AnchorsScanOptions = {}): CommandResult {
  // Default: scan all three when no category flag is given.
  const anySelected = !!(opts.reqs || opts.tests || opts.code);
  const scanReqs = anySelected ? !!opts.reqs : true;
  const scanTests = anySelected ? !!opts.tests : true;
  const scanCode = anySelected ? !!opts.code : true;

  const data: {
    requirements?: CategoryMap;
    tests?: CategoryMap;
    code?: CategoryMap;
    orphans: Orphan[];
  } = { orphans: [] };

  let requirementsMap: Map<string, string[]> | undefined;
  let testsMap: Map<string, string[]> | undefined;
  let codeMap: Map<string, string[]> | undefined;

  if (scanReqs) {
    requirementsMap = scanDirForReqIds(path.join(paths.root, DEFAULT_DIRS.requirements));
    data.requirements = toRecord(requirementsMap);
  }
  if (scanTests) {
    testsMap = scanDirForReqIds(path.join(paths.root, DEFAULT_DIRS.tests));
    data.tests = toRecord(testsMap);
  }
  if (scanCode) {
    codeMap = scanDirForReqIds(path.join(paths.root, DEFAULT_DIRS.code));
    data.code = toRecord(codeMap);
  }

  // Orphan detection: REQ anchors in tests/ or src/ that are NOT in the defined
  // requirement set. (Requirements themselves can never be orphans.)
  const defined = definedRequirementSet(paths);
  const orphans: Orphan[] = [];
  const recordOrphans = (m: Map<string, string[]> | undefined, label: string): void => {
    if (!m) return;
    for (const [req, files] of m) {
      if (defined.has(req)) continue;
      for (const file of files) orphans.push({ req, where: `${label}/${file}` });
    }
  };
  recordOrphans(testsMap, "tests");
  recordOrphans(codeMap, "code");
  data.orphans = orphans;

  // Human: compact per-category counts + orphan list.
  const countLines: string[] = [];
  if (data.requirements) countLines.push(`requirements: ${Object.keys(data.requirements).length} REQ-ID(s)`);
  if (data.tests) countLines.push(`tests:        ${Object.keys(data.tests).length} REQ-ID(s)`);
  if (data.code) countLines.push(`code:         ${Object.keys(data.code).length} REQ-ID(s)`);
  const orphanLines = orphans.length
    ? ["orphans:", ...orphans.map((o) => `  - ${o.req} (${o.where})`)]
    : ["orphans: (none)"];
  const human = [...countLines, ...orphanLines].join("\n");

  structuredLog({ cmd: "anchors scan", scanned: { reqs: scanReqs, tests: scanTests, code: scanCode }, orphans: orphans.length });

  if (opts.strict && orphans.length > 0) {
    return failure({
      data,
      human: `${human}\n\n${orphans.length} orphan anchor(s) (--strict).`,
    });
  }
  return success({ data, human });
}
