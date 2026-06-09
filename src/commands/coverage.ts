import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { extractReqIds } from "../core/anchors";
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

/** True if the path looks like a test source file we should scan for REQ-IDs. */
function isTestSource(name: string): boolean {
  return /\.(test|spec)\.[^.]+$/.test(name) || /\.(ts|js)$/.test(name);
}

/**
 * Collect REQ-IDs referenced by every test source directly under `testsDir`
 * (recursing one level into subdirectories is enough for the MVP layout).
 * Missing dir → empty set.
 */
function collectTestReqIds(testsDir: string): string[] {
  if (!fs.existsSync(testsDir) || !fs.statSync(testsDir).isDirectory()) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  const addFrom = (abs: string): void => {
    const content = fs.readFileSync(abs, "utf8");
    for (const id of extractReqIds(content)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  };

  for (const entry of fs.readdirSync(testsDir, { withFileTypes: true })) {
    const abs = path.join(testsDir, entry.name);
    if (entry.isFile() && isTestSource(entry.name)) {
      addFrom(abs);
    } else if (entry.isDirectory()) {
      // Recurse one level.
      for (const inner of fs.readdirSync(abs, { withFileTypes: true })) {
        if (inner.isFile() && isTestSource(inner.name)) addFrom(path.join(abs, inner.name));
      }
    }
  }
  return out;
}

/**
 * `th coverage check` — verify that every requirement REQ-ID is mapped to at
 * least one slice (implementation plan) and at least one test. Success (exit 0)
 * when there are zero gaps; failure (exit 1) listing each gap otherwise.
 */
export function runCoverageCheck(paths: ProjectPaths, opts: CoverageOptions = {}): CommandResult {
  const reqsAbs = path.resolve(paths.root, opts.reqsFile ?? "docs/01-requirements.md");
  const planAbs = path.resolve(paths.root, opts.planFile ?? "docs/09-implementation-plan.md");
  const testsAbs = path.resolve(paths.root, opts.testsDir ?? "tests");

  const reqsContent = readFileOrUndefined(reqsAbs);
  if (reqsContent === undefined) {
    const rel = path.relative(paths.root, reqsAbs).split(path.sep).join("/");
    return failure({
      human: `Requirements file not found: ${rel}. Run \`th init\` and author requirements first.`,
      data: { error: "reqs_file_not_found", reqsFile: rel },
    });
  }

  // MVP-filtering via scope is a future refinement; for now the requirement set
  // = all REQ-IDs in the requirements file.
  const reqSet = extractReqIds(reqsContent);

  // Missing plan file → empty slice set (everything is a gap), but never crash.
  const planContent = readFileOrUndefined(planAbs);
  const sliceSet = planContent === undefined ? [] : extractReqIds(planContent);

  // Missing tests dir → empty test set.
  const testSet = collectTestReqIds(testsAbs);

  const gaps: CoverageGap[] = [];
  for (const req of reqSet) {
    const inSlice = sliceSet.includes(req);
    const inTest = testSet.includes(req);
    if (!inSlice || !inTest) gaps.push({ req, inSlice, inTest });
  }

  const total = reqSet.length;
  const covered = total - gaps.length;
  structuredLog({ cmd: "coverage check", total, covered, gaps: gaps.length });

  if (gaps.length === 0) {
    return success({
      data: { ok: true, total, covered, gaps: [] },
      human: `coverage complete: ${covered}/${total} REQ-IDs mapped to ≥1 slice and ≥1 test`,
    });
  }

  const lines = gaps.map((g) => {
    const missing: string[] = [];
    if (!g.inSlice) missing.push("no slice");
    if (!g.inTest) missing.push("no test");
    return `  - ${g.req}: ${missing.join(", ")}`;
  });
  return failure({
    data: { gaps, total, covered },
    human: `coverage gap: ${covered}/${total} REQ-IDs mapped; ${gaps.length} uncovered:\n${lines.join("\n")}`,
  });
}
