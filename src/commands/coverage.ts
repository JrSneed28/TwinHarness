import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { extractReqIds, scanDirForReqIds } from "../core/anchors";
import { structuredLog } from "../core/log";

/**
 * `th coverage check` — the mechanical coverage-map gate (build plan §3; spec §11
 * tests-as-contract, §15.8/§15.9: "every MVP REQ-ID maps to ≥1 slice and ≥1
 * test"). Pure traceability arithmetic over REQ-ID anchors: it never decides
 * *whether* a requirement is correct, only whether each one is anchored in the
 * implementation plan (a slice) and in a test file.
 */

export interface CoverageOptions {
  reqsFile?: string;
  planFile?: string;
  testsDir?: string;
  /** Path to the scope file for MVP filtering (default docs/02-scope.md). */
  scopeFile?: string;
}

/** A REQ-ID that is missing from a slice and/or a test. */
interface CoverageGap {
  req: string;
  inSlice: boolean;
  inTest: boolean;
}

/** Read a file as UTF-8, or return undefined if it is absent / not a file. */
function readFileOrUndefined(abs: string): string | undefined {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return undefined;
  return fs.readFileSync(abs, "utf8");
}

/**
 * Extract REQ-IDs from the MVP Scope section of a scope file. If the file
 * lacks an `## MVP Scope` heading (case-insensitive) or the section is empty,
 * returns undefined (caller falls back to no-filter behaviour).
 *
 * The MVP section runs from the `## MVP Scope` heading until the next `## `
 * heading (or end of file).
 */
function extractMvpScopeReqIds(scopeContent: string): string[] | undefined {
  const lines = scopeContent.split(/\r?\n/);
  const MVP_HEADING_RE = /^##\s+MVP\s+Scope\b/i;
  const NEXT_H2_RE = /^##\s+/;

  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    if (!inSection) {
      if (MVP_HEADING_RE.test(line)) {
        inSection = true;
      }
    } else {
      if (NEXT_H2_RE.test(line)) break;
      sectionLines.push(line);
    }
  }

  if (!inSection) return undefined;
  const ids = extractReqIds(sectionLines.join("\n"));
  return ids.length > 0 ? ids : undefined;
}

/**
 * Collect all REQ-IDs referenced by any file in `testsDir` (full recursion,
 * all files, same skip-dirs as scanDirForReqIds). Returns unique union.
 * Missing dir → empty array.
 */
function collectTestReqIds(testsAbs: string): string[] {
  const scanMap = scanDirForReqIds(testsAbs);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of scanMap.keys()) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * `th coverage check [--reqs F] [--plan F] [--tests D] [--scope F]` — verify
 * that every (MVP) requirement REQ-ID is mapped to at least one slice
 * (implementation plan) and at least one test. Success (exit 0) when there are
 * zero gaps; failure (exit 1) listing each gap otherwise.
 *
 * MVP filtering: if docs/02-scope.md (or `--scope`) exists and contains a
 * `## MVP Scope` heading, the checked requirement set is the intersection of
 * (REQ-IDs in requirements file) ∩ (REQ-IDs in the MVP Scope section). When
 * the filter produces an empty set or the scope file / section is absent,
 * falls back to checking all REQ-IDs.
 */
export function runCoverageCheck(paths: ProjectPaths, opts: CoverageOptions = {}): CommandResult {
  const reqsAbs = path.resolve(paths.root, opts.reqsFile ?? "docs/01-requirements.md");
  const planAbs = path.resolve(paths.root, opts.planFile ?? "docs/09-implementation-plan.md");
  const testsAbs = path.resolve(paths.root, opts.testsDir ?? "tests");
  const scopeAbs = path.resolve(paths.root, opts.scopeFile ?? "docs/02-scope.md");

  const reqsContent = readFileOrUndefined(reqsAbs);
  if (reqsContent === undefined) {
    const rel = path.relative(paths.root, reqsAbs).split(path.sep).join("/");
    return failure({
      human: `Requirements file not found: ${rel}. Run \`th init\` and author requirements first.`,
      data: { error: "reqs_file_not_found", reqsFile: rel },
    });
  }

  const allReqIds = extractReqIds(reqsContent);

  // MVP filtering: try to extract the MVP Scope section from the scope file.
  let mvpFilter: string[] | undefined;
  const scopeContent = readFileOrUndefined(scopeAbs);
  if (scopeContent !== undefined) {
    mvpFilter = extractMvpScopeReqIds(scopeContent);
  }

  let reqSet: string[];
  let filterDescription: string;
  if (mvpFilter !== undefined && mvpFilter.length > 0) {
    const mvpSet = new Set(mvpFilter);
    reqSet = allReqIds.filter((id) => mvpSet.has(id));
    if (reqSet.length === 0) {
      // Intersection empty → fall back.
      reqSet = allReqIds;
      filterDescription = "MVP filter: intersection empty — checking all REQ-IDs";
    } else {
      filterDescription = `MVP filter: applied (${reqSet.length} of ${allReqIds.length} REQ-IDs)`;
    }
  } else {
    reqSet = allReqIds;
    filterDescription = "MVP filter: none — checking all REQ-IDs";
  }

  // Missing plan file → empty slice set (everything is a gap), but never crash.
  const planContent = readFileOrUndefined(planAbs);
  const sliceSet = planContent === undefined ? [] : extractReqIds(planContent);

  // Missing tests dir → empty test set. Full recursion via scanDirForReqIds.
  const testSet = collectTestReqIds(testsAbs);

  const gaps: CoverageGap[] = [];
  for (const req of reqSet) {
    const inSlice = sliceSet.includes(req);
    const inTest = testSet.includes(req);
    if (!inSlice || !inTest) gaps.push({ req, inSlice, inTest });
  }

  const total = reqSet.length;
  const covered = total - gaps.length;
  structuredLog({ cmd: "coverage check", total, covered, gaps: gaps.length, filter: filterDescription });

  if (gaps.length === 0) {
    return success({
      data: { ok: true, total, covered, gaps: [], mvpFilter: filterDescription },
      human: `coverage complete: ${covered}/${total} REQ-IDs mapped to ≥1 slice and ≥1 test\n${filterDescription}`,
    });
  }

  const lines = gaps.map((g) => {
    const missing: string[] = [];
    if (!g.inSlice) missing.push("no slice");
    if (!g.inTest) missing.push("no test");
    return `  - ${g.req}: ${missing.join(", ")}`;
  });
  return failure({
    data: { gaps, total, covered, mvpFilter: filterDescription },
    human: `coverage gap: ${covered}/${total} REQ-IDs mapped; ${gaps.length} uncovered:\n${lines.join("\n")}\n${filterDescription}`,
  });
}
