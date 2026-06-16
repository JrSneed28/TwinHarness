import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { extractReqIds, scanDirForReqIds } from "../core/anchors";
import { structuredLog } from "../core/log";
import { readFileOrUndefined } from "../core/coverage";

/**
 * `th trace render` — the RENDERED traceability view (spec §17). Traceability is
 * **generated on demand** by scanning the durable REQ-ID anchors that live next
 * to the code; it is NEVER stored as a maintained matrix (§17, decision #12). The
 * view never goes stale the way a hand-maintained matrix does because the anchors
 * move with the code.
 *
 * Mechanical only (plan §3 boundary rule): it records WHERE each requirement's
 * anchor appears across design/contracts/plan/tests/code; it never decides
 * whether a requirement is correct or adequately covered.
 */

/** Requirements file relative to the project root (§17 anchor source of truth). */
const REQUIREMENTS_FILE = "docs/01-requirements.md";
/** Contracts file relative to the project root (§17 "Contract" column). */
const CONTRACTS_FILE = "docs/07-contracts.md";
/** Implementation-plan file relative to the project root (§17 "Slice / Task"). */
const PLAN_FILE = "docs/09-implementation-plan.md";

/** A single rendered traceability row: one requirement and where it is anchored. */
export interface TraceRow {
  req: string;
  /** Design docs under docs/ (excluding 01-requirements) mentioning the REQ. */
  design: string[];
  /** Contracts file(s) mentioning the REQ. */
  contract: string[];
  /** Implementation-plan mention + any nearby SLICE-/TASK- tokens (best-effort). */
  sliceTask: string[];
  /** Test files mentioning the REQ. */
  test: string[];
  /** Source files mentioning the REQ. */
  code: string[];
}

/** SLICE-/TASK- token shape surfaced from the plan as a best-effort convenience. */
const SLICE_TASK_PATTERN = /\b(?:SLICE|TASK)-\d+\b/g;


/**
 * Invert a `REQ-ID → files` scan into a `REQ-ID → Set<files>` lookup, optionally
 * dropping any file path matching `exclude` (used to keep 01-requirements out of
 * the Design column). File paths are prefixed with `prefix` so they read as
 * project-root-relative forward-slash paths in the rendered view.
 */
function indexByReq(
  map: Map<string, string[]>,
  prefix: string,
  exclude?: (rel: string) => boolean,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [req, files] of map) {
    for (const rel of files) {
      if (exclude && exclude(rel)) continue;
      const full = prefix ? `${prefix}/${rel}` : rel;
      const list = out.get(req);
      if (list) {
        if (!list.includes(full)) list.push(full);
      } else {
        out.set(req, [full]);
      }
    }
  }
  return out;
}

/**
 * Build a per-REQ-ID map of SLICE-/TASK- tokens from the plan.
 *
 * For each line that mentions a given REQ-ID, collect:
 * 1. All SLICE-/TASK- tokens on that same line.
 * 2. The SLICE-N token from the nearest preceding heading line that contains a
 *    SLICE-N token (section context).
 *
 * Returns a Map<REQ-ID, string[]> of unique, stable-order tokens.
 */
function planSliceTaskByReq(planContent: string): Map<string, string[]> {
  const REQ_ID_RE = /REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*/g;
  const HEADING_RE = /^#{1,6}\s+/;

  const out = new Map<string, string[]>();
  const lines = planContent.split(/\r?\n/);

  // Track the nearest preceding heading slice token.
  let headingSliceToken: string | undefined;

  for (const line of lines) {
    const sliceTaskTokens: string[] = [];
    for (const m of line.matchAll(new RegExp(SLICE_TASK_PATTERN.source, "g"))) {
      if (!sliceTaskTokens.includes(m[0])) sliceTaskTokens.push(m[0]);
    }

    // Update heading slice context.
    if (HEADING_RE.test(line)) {
      const headSlice = sliceTaskTokens.find((t) => t.startsWith("SLICE-"));
      if (headSlice) headingSliceToken = headSlice;
    }

    // Collect REQ-IDs on this line.
    const reqIds: string[] = [];
    for (const m of line.matchAll(REQ_ID_RE)) {
      if (!reqIds.includes(m[0])) reqIds.push(m[0]);
    }

    if (reqIds.length === 0) continue;

    for (const req of reqIds) {
      const list = out.get(req) ?? [];
      // Add same-line tokens.
      for (const tok of sliceTaskTokens) {
        if (!list.includes(tok)) list.push(tok);
      }
      // Add heading slice context token.
      if (headingSliceToken && !list.includes(headingSliceToken)) {
        list.push(headingSliceToken);
      }
      out.set(req, list);
    }
  }

  return out;
}

/** Render a row's cell: join file lists with ", "; an empty cell shows as "—". */
function cell(items: string[]): string {
  return items.length ? items.join(", ") : "—";
}

/**
 * `th trace render` — build the §17 traceability view fresh from anchors and
 * return both structured rows and a markdown table. Failure (exit 1) when the
 * project is not initialized far enough to have a requirements file or when that
 * file defines no requirements to trace.
 */
export function runTraceRender(paths: ProjectPaths): CommandResult {
  const reqsAbs = path.resolve(paths.root, REQUIREMENTS_FILE);
  const reqsContent = readFileOrUndefined(reqsAbs);
  if (reqsContent === undefined) {
    return failure({
      human: `no requirements to trace: ${REQUIREMENTS_FILE} not found. Run \`th init\` and author requirements first.`,
      data: { error: "no_requirements" },
    });
  }

  const reqSet = extractReqIds(reqsContent);
  if (reqSet.length === 0) {
    return failure({
      human: `no requirements to trace: ${REQUIREMENTS_FILE} defines no REQ-ID anchors.`,
      data: { error: "no_requirements" },
    });
  }

  // Design = REQ-ID anchors in design docs under docs/ (esp. 03 domain / 04
  // architecture / 06 technical-design, §17 "Design ref"). The files that own a
  // DEDICATED column — 01-requirements, 07-contracts, 09-implementation-plan —
  // are excluded so Design, Contract, and Slice/Task stay distinct (§17).
  const docsScan = scanDirForReqIds(paths.docsDir);
  const designExcluded = new Set([
    "01-requirements.md",
    path.basename(CONTRACTS_FILE),
    path.basename(PLAN_FILE),
  ]);
  const designIdx = indexByReq(docsScan, "docs", (rel) => designExcluded.has(rel));

  // Contract = REQ-ID anchors in the contracts file (§17 "Contract").
  const contractContent = readFileOrUndefined(path.resolve(paths.root, CONTRACTS_FILE));
  const contractIdx = new Map<string, string[]>();
  if (contractContent !== undefined) {
    for (const id of extractReqIds(contractContent)) contractIdx.set(id, [CONTRACTS_FILE]);
  }

  // Slice / Task = the REQ-ID appearing in the plan, plus per-REQ SLICE-/TASK-
  // tokens (same line or nearest heading context) surfaced as a convenience (§17).
  const planContent = readFileOrUndefined(path.resolve(paths.root, PLAN_FILE));
  const planReqs = planContent === undefined ? new Set<string>() : new Set(extractReqIds(planContent));
  const planTokenMap = planContent === undefined ? new Map<string, string[]>() : planSliceTaskByReq(planContent);

  // Test = REQ-ID anchors under tests/; Code = REQ-ID anchors under src/ (§17).
  const testIdx = indexByReq(scanDirForReqIds(path.join(paths.root, "tests")), "tests");
  const codeIdx = indexByReq(scanDirForReqIds(path.join(paths.root, "src")), "src");

  const rows: TraceRow[] = reqSet.map((req) => {
    const sliceTask: string[] = [];
    if (planReqs.has(req)) {
      sliceTask.push(PLAN_FILE);
      const tokens = planTokenMap.get(req) ?? [];
      for (const tok of tokens) {
        if (!sliceTask.includes(tok)) sliceTask.push(tok);
      }
    }
    return {
      req,
      design: designIdx.get(req) ?? [],
      contract: contractIdx.get(req) ?? [],
      sliceTask,
      test: testIdx.get(req) ?? [],
      code: codeIdx.get(req) ?? [],
    };
  });

  // Human render = a markdown table with the §17 columns, generated fresh; nothing
  // is persisted (§17 — rendered on demand, never stored).
  const header = "| Requirement | Design ref | Contract | Slice / Task | Test | Code |";
  const divider = "| --- | --- | --- | --- | --- | --- |";
  const body = rows.map(
    (r) =>
      `| ${r.req} | ${cell(r.design)} | ${cell(r.contract)} | ${cell(r.sliceTask)} | ${cell(r.test)} | ${cell(r.code)} |`,
  );
  const human = [header, divider, ...body].join("\n");

  structuredLog({ cmd: "trace render", requirements: rows.length });
  return success({ data: { rows }, human });
}
