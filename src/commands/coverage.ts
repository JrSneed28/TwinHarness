import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { resolveWithinRoot } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { extractReqIds } from "../core/anchors";
import {
  readFileOrUndefined,
  resolveReqSet,
  collectTestReqIds,
  computeBreakdown,
} from "../core/coverage";
import { readVerifyReport } from "../core/verify";
import { structuredLog } from "../core/log";

/**
 * `th coverage check` — the mechanical coverage-map gate (build plan §3; spec §11
 * tests-as-contract, §15.8/§15.9: "every MVP REQ-ID maps to ≥1 slice and ≥1
 * test"). Pure traceability arithmetic over REQ-ID anchors: it never decides
 * *whether* a requirement is correct, only whether each one is anchored in the
 * implementation plan (a slice) and in a test file.
 *
 * `th coverage report` adds the planned / implemented / tested / passing
 * breakdown (the gate stays slice+test). "passing" is whole-suite, sourced from
 * the optional `th verify run` report — the CLI never runs tests itself.
 */

export interface CoverageOptions {
  reqsFile?: string;
  planFile?: string;
  testsDir?: string;
  /** Path to the scope file for MVP filtering (default docs/02-scope.md). */
  scopeFile?: string;
  /** Code directory scanned for the `implemented` dimension (report only; default src). */
  codeDir?: string;
}

/** A REQ-ID that is missing from a slice and/or a test. */
interface CoverageGap {
  req: string;
  inSlice: boolean;
  inTest: boolean;
}

/** Validate that every supplied path override stays within the project root. */
function rejectEscapingPath(paths: ProjectPaths, opts: CoverageOptions): CommandResult | undefined {
  const fields: Array<[keyof CoverageOptions, string | undefined]> = [
    ["reqsFile", opts.reqsFile],
    ["planFile", opts.planFile],
    ["testsDir", opts.testsDir],
    ["scopeFile", opts.scopeFile],
    ["codeDir", opts.codeDir],
  ];
  for (const [, value] of fields) {
    if (value !== undefined && resolveWithinRoot(paths.root, value) === null) {
      return failure({ human: `Path outside project root: ${value}`, data: { error: "path_outside_root", file: value } });
    }
  }
  return undefined;
}

/**
 * `th coverage check [--reqs F] [--plan F] [--tests D] [--scope F]` — verify
 * that every (MVP) requirement REQ-ID is mapped to at least one slice
 * (implementation plan) and at least one test. Success (exit 0) when there are
 * zero gaps; failure (exit 1) listing each gap otherwise.
 */
export function runCoverageCheck(paths: ProjectPaths, opts: CoverageOptions = {}): CommandResult {
  const escaped = rejectEscapingPath(paths, opts);
  if (escaped) return escaped;

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

  const { allReqIds, reqSet, filterDescription } = resolveReqSet(reqsContent, readFileOrUndefined(scopeAbs));
  void allReqIds;

  const planContent = readFileOrUndefined(planAbs);
  const sliceSet = planContent === undefined ? [] : extractReqIds(planContent);
  // TEST dimension counts only RECOGNIZED test files (GOV-1): an anchor in a
  // prose/fixture file under tests/ no longer satisfies the gate.
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

/**
 * `th coverage report [--reqs F] [--plan F] [--tests D] [--scope F] [--code D]`
 * — the planned / implemented / tested / passing breakdown for every checked
 * REQ-ID (read-only; never a gate). Always exits 0 when the requirements file is
 * present — it is a status view, not the hard gate (`th coverage check`).
 *
 *   planned     → REQ-ID is in the implementation plan (a slice exists)
 *   implemented → REQ-ID is anchored in the code dir (default src)
 *   tested      → REQ-ID is anchored in a test file
 *   passing     → tested AND the last `th verify run` reported a green suite
 *                 (whole-suite signal; "—" when no verify report exists)
 */
export function runCoverageReport(paths: ProjectPaths, opts: CoverageOptions = {}): CommandResult {
  const escaped = rejectEscapingPath(paths, opts);
  if (escaped) return escaped;

  const breakdown = computeBreakdown(paths.root, opts);
  if ("error" in breakdown) {
    return failure({
      human: `Requirements file not found: ${breakdown.reqsFile}. Run \`th init\` and author requirements first.`,
      data: { error: breakdown.error, reqsFile: breakdown.reqsFile },
    });
  }

  const report = readVerifyReport(paths);
  const suitePassing = report ? report.ok : null;
  const passingCount = suitePassing === null ? null : breakdown.rows.filter((r) => r.tested && suitePassing).length;

  structuredLog({
    cmd: "coverage report",
    total: breakdown.total,
    planned: breakdown.planned,
    implemented: breakdown.implemented,
    tested: breakdown.tested,
    passing: passingCount,
  });

  const cell = (b: boolean): string => (b ? "✓" : "·");
  const passCell = (tested: boolean): string => (suitePassing === null ? "—" : tested && suitePassing ? "✓" : "·");
  const rows = breakdown.rows.map(
    (r) => `  ${r.req.padEnd(16)} ${cell(r.planned)} planned  ${cell(r.implemented)} implemented  ${cell(r.tested)} tested  ${passCell(r.tested)} passing`,
  );
  const passingSummary = passingCount === null ? "— (no verify report — run `th verify run`)" : `${passingCount}/${breakdown.total}`;
  const human = [
    `Coverage breakdown — ${breakdown.total} REQ-ID(s) checked`,
    `  planned:     ${breakdown.planned}/${breakdown.total}`,
    `  implemented: ${breakdown.implemented}/${breakdown.total}`,
    `  tested:      ${breakdown.tested}/${breakdown.total}`,
    `  passing:     ${passingSummary}`,
    breakdown.filterDescription,
    "",
    ...(rows.length ? rows : ["  (no REQ-IDs found)"]),
  ].join("\n");

  return success({
    data: {
      total: breakdown.total,
      planned: breakdown.planned,
      implemented: breakdown.implemented,
      tested: breakdown.tested,
      passing: passingCount,
      suitePassing,
      rows: breakdown.rows,
      mvpFilter: breakdown.filterDescription,
    },
    human,
  });
}
