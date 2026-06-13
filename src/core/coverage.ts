/**
 * Pure coverage computation shared by `th coverage check` (the hard gate) and
 * `th coverage report` (the planned/implemented/tested breakdown), plus the
 * run-health audit (`th doctor`) and the next-action oracle (`th next`).
 *
 * REQ-ID traceability arithmetic only (spec §11/§15.8/§15.9): it computes which
 * dimension each requirement is anchored in. It never decides whether a
 * requirement is correct, and it never runs anything (plan §3 boundary rule).
 *
 * The three static dimensions, all derived from durable REQ-ID anchors:
 *   - planned     → the REQ-ID appears in the implementation plan (a slice exists)
 *   - implemented → the REQ-ID is anchored in the code directory (Builder writes
 *                   REQ-ID anchors WITH the implementation — see agents/builder.md)
 *   - tested      → the REQ-ID is anchored in a test file
 *
 * "passing" is intentionally NOT computed here — it requires executing the test
 * suite, which the CLI never does. It is layered on by the coverage-report
 * command from the optional `th verify run` report (and is whole-suite, not
 * per-REQ).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { extractReqIds, scanDirForReqIds } from "./anchors";

/** Read a file as UTF-8, or return undefined if it is absent / not a file. */
export function readFileOrUndefined(abs: string): string | undefined {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return undefined;
  return fs.readFileSync(abs, "utf8");
}

/**
 * Extract REQ-IDs from the `## MVP Scope` section of a scope file. Returns
 * undefined when the heading is absent or the section has no REQ-IDs (the caller
 * then falls back to checking all REQ-IDs). The section runs from the
 * `## MVP Scope` heading (case-insensitive) until the next `## ` heading.
 */
export function extractMvpScopeReqIds(scopeContent: string): string[] | undefined {
  const lines = scopeContent.split(/\r?\n/);
  const MVP_HEADING_RE = /^##\s+MVP\s+Scope\b/i;
  const NEXT_H2_RE = /^##\s+/;

  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    if (!inSection) {
      if (MVP_HEADING_RE.test(line)) inSection = true;
    } else {
      if (NEXT_H2_RE.test(line)) break;
      sectionLines.push(line);
    }
  }

  if (!inSection) return undefined;
  const ids = extractReqIds(sectionLines.join("\n"));
  return ids.length > 0 ? ids : undefined;
}

/** Unique union of every REQ-ID referenced by any file under `dir` (full recursion). */
export function collectDirReqIds(dir: string): string[] {
  const scanMap = scanDirForReqIds(dir);
  return [...scanMap.keys()];
}

export interface ResolvedReqSet {
  /** All REQ-IDs found in the requirements file (first-seen order). */
  allReqIds: string[];
  /** The checked subset after MVP filtering. */
  reqSet: string[];
  /** Human-readable description of the filter that was applied. */
  filterDescription: string;
}

/**
 * Resolve the requirement set to check: the intersection of (REQ-IDs in the
 * requirements file) ∩ (REQ-IDs in the `## MVP Scope` section) when a usable MVP
 * filter is present, otherwise all REQ-IDs. Identical semantics to the original
 * `th coverage check` so the gate's behaviour is unchanged.
 */
export function resolveReqSet(reqsContent: string, scopeContent: string | undefined): ResolvedReqSet {
  const allReqIds = extractReqIds(reqsContent);
  const mvpFilter = scopeContent !== undefined ? extractMvpScopeReqIds(scopeContent) : undefined;

  if (mvpFilter !== undefined && mvpFilter.length > 0) {
    const mvpSet = new Set(mvpFilter);
    const reqSet = allReqIds.filter((id) => mvpSet.has(id));
    if (reqSet.length === 0) {
      return { allReqIds, reqSet: allReqIds, filterDescription: "MVP filter: intersection empty — checking all REQ-IDs" };
    }
    return { allReqIds, reqSet, filterDescription: `MVP filter: applied (${reqSet.length} of ${allReqIds.length} REQ-IDs)` };
  }
  return { allReqIds, reqSet: allReqIds, filterDescription: "MVP filter: none — checking all REQ-IDs" };
}

export interface CoverageInputs {
  reqsFile?: string;
  planFile?: string;
  testsDir?: string;
  scopeFile?: string;
  /** Code directory scanned for `implemented` (default `src`). */
  codeDir?: string;
}

export interface CoverageRow {
  req: string;
  planned: boolean;
  implemented: boolean;
  tested: boolean;
}

export interface CoverageBreakdown {
  rows: CoverageRow[];
  total: number;
  planned: number;
  implemented: number;
  tested: number;
  filterDescription: string;
}

/** `reqs_file_not_found` sentinel returned when the requirements file is absent. */
export interface CoverageReqsMissing {
  error: "reqs_file_not_found";
  reqsFile: string;
}

/**
 * Compute the planned/implemented/tested breakdown for every checked REQ-ID.
 * Resolves all paths relative to `root`. Missing plan/tests/code → those
 * dimensions are simply false (never a crash). Returns a `reqs_file_not_found`
 * sentinel when the requirements file itself is absent.
 */
export function computeBreakdown(root: string, opts: CoverageInputs = {}): CoverageBreakdown | CoverageReqsMissing {
  const reqsAbs = path.resolve(root, opts.reqsFile ?? "docs/01-requirements.md");
  const planAbs = path.resolve(root, opts.planFile ?? "docs/09-implementation-plan.md");
  const testsAbs = path.resolve(root, opts.testsDir ?? "tests");
  const scopeAbs = path.resolve(root, opts.scopeFile ?? "docs/02-scope.md");
  const codeAbs = path.resolve(root, opts.codeDir ?? "src");

  const reqsContent = readFileOrUndefined(reqsAbs);
  if (reqsContent === undefined) {
    return { error: "reqs_file_not_found", reqsFile: path.relative(root, reqsAbs).split(path.sep).join("/") };
  }

  const { reqSet, filterDescription } = resolveReqSet(reqsContent, readFileOrUndefined(scopeAbs));

  const planContent = readFileOrUndefined(planAbs);
  const sliceSet = new Set(planContent === undefined ? [] : extractReqIds(planContent));
  const testSet = new Set(collectDirReqIds(testsAbs));
  const codeSet = new Set(collectDirReqIds(codeAbs));

  const rows: CoverageRow[] = reqSet.map((req) => ({
    req,
    planned: sliceSet.has(req),
    implemented: codeSet.has(req),
    tested: testSet.has(req),
  }));

  return {
    rows,
    total: rows.length,
    planned: rows.filter((r) => r.planned).length,
    implemented: rows.filter((r) => r.implemented).length,
    tested: rows.filter((r) => r.tested).length,
    filterDescription,
  };
}
