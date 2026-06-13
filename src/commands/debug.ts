import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState } from "../core/state-store";
import { scanDirForReqIds } from "../core/anchors";
import { parseDriftEntries } from "../core/drift-log";
import {
  formatDebugEntry,
  parseDebugEntries,
  nextDebugId,
  type DebugStatus,
} from "../core/debug-log";
import { readVerifyReport } from "../core/verify";
import { structuredLog } from "../core/log";

/**
 * `th debug` — mechanical support for the Debugger agent (evidence-first
 * defect tracing). `th debug pack` assembles a deterministic evidence bundle so
 * the Debugger starts from facts (failing output, anchors, slice, recent drift,
 * open findings); `th debug log add|list` is the append-only evidence ledger
 * (`debug-log.md`, mirroring `drift-log.md`). Records and computes; it never
 * decides a root cause and never fixes anything.
 */

function debugLogPath(paths: ProjectPaths): string {
  return path.join(paths.root, "debug-log.md");
}

const NOT_INIT = failure({ human: "No state.json found. Run `th init` first.", data: { error: "not_initialized" } });

export interface DebugPackOptions {
  slice?: string;
  req?: string;
}

/**
 * `th debug pack [--slice <ID> | --req <REQ-ID>]` — assemble the read-only
 * evidence bundle for a failure: the failing verify commands + output tails, the
 * REQ/slice anchors for the affected area, recent drift, and any open debug
 * findings. Sibling of `th context pack`, aimed at a defect rather than a handoff.
 */
export function runDebugPack(paths: ProjectPaths, opts: DebugPackOptions = {}): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) return failure({ human: "state.json is invalid.", data: { error: "invalid_state", issues: r.issues } });
  const s = r.state;

  // Failing suite (from the last `th verify run`).
  const report = readVerifyReport(paths);
  const failing = report ? report.results.filter((x) => !x.ok) : [];

  // Target framing: a slice's components, or a REQ-ID's code/test anchors.
  let sliceBlock: { id: string; status: string; components: string[] } | undefined;
  let reqAnchors: { req: string; files: string[] } | undefined;
  if (opts.slice) {
    const target = s.slices.find((sl) => sl.id === opts.slice);
    if (!target) {
      return failure({ human: `Unknown slice: ${opts.slice}. Known: ${s.slices.map((sl) => sl.id).join(", ") || "(none)"}`, data: { error: "unknown_slice", slice: opts.slice } });
    }
    sliceBlock = { id: target.id, status: target.status, components: target.components };
  }
  if (opts.req) {
    const files: string[] = [];
    for (const dir of ["src", "tests", "docs"]) {
      const map = scanDirForReqIds(path.join(paths.root, dir));
      for (const f of map.get(opts.req) ?? []) files.push(`${dir}/${f}`);
    }
    reqAnchors = { req: opts.req, files };
  }

  // Recent drift + open debug findings.
  const driftText = fs.existsSync(paths.driftLog) ? fs.readFileSync(paths.driftLog, "utf8") : "";
  const drift = parseDriftEntries(driftText).slice(-3).map((e) => ({ id: e.id, ref: e.ref, layer: e.layer, discovery: e.discovery }));
  const debugText = fs.existsSync(debugLogPath(paths)) ? fs.readFileSync(debugLogPath(paths), "utf8") : "";
  const openDebug = parseDebugEntries(debugText).filter((e) => e.status === "open").map((e) => ({ id: e.id, ref: e.ref, symptom: e.symptom }));

  structuredLog({ cmd: "debug pack", slice: opts.slice ?? null, req: opts.req ?? null, failing: failing.length });

  const lines: string[] = [`Debug evidence pack${opts.slice ? ` — ${opts.slice}` : opts.req ? ` — ${opts.req}` : ""}`];
  lines.push("", report ? `Suite: ${report.ok ? "green" : "FAILING"} (${report.results.length} command(s), last run ${report.ranAt})` : "Suite: no verify report (run `th verify run` to capture failures)");
  for (const f of failing) {
    lines.push(`  ✗ (${f.exitCode}) ${f.command}`);
    for (const l of f.outputTail.split(/\r?\n/).slice(-6)) lines.push(`      ${l}`);
  }
  if (sliceBlock) lines.push("", `Slice ${sliceBlock.id} [${sliceBlock.status}] — components: ${sliceBlock.components.join(", ") || "(none)"}`);
  if (reqAnchors) lines.push("", `${reqAnchors.req} anchored in: ${reqAnchors.files.join(", ") || "(no anchors found)"}`);
  lines.push("", drift.length ? `Recent drift: ${drift.map((d) => `${d.id} (${d.layer})`).join(", ")}` : "Recent drift: (none)");
  lines.push(openDebug.length ? `Open debug findings: ${openDebug.map((d) => d.id).join(", ")}` : "Open debug findings: (none)");

  return success({
    data: { slice: sliceBlock ?? null, req: reqAnchors ?? null, failing, drift, openDebug, suite: report ? { ok: report.ok, ranAt: report.ranAt } : null },
    human: lines.join("\n"),
  });
}

export interface DebugLogAddOptions {
  ref?: string;
  symptom?: string;
  evidence?: string;
  rootCause?: string;
  status?: string;
}

/** `th debug log add --ref … --symptom … --evidence … --root-cause … [--status open|resolved]`. */
export function runDebugLogAdd(paths: ProjectPaths, opts: DebugLogAddOptions): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) return failure({ human: "state.json is invalid.", data: { error: "invalid_state", issues: r.issues } });

  if (!opts.ref || !opts.symptom) {
    return failure({ human: 'usage: th debug log add --ref "REQ-007 / SLICE-2" --symptom "…" [--evidence "…"] [--root-cause "…"] [--status open|resolved]' });
  }
  const status: DebugStatus = opts.status === "resolved" ? "resolved" : "open";

  const file = debugLogPath(paths);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# Debug log\n\nAppend-only evidence trail for the Debugger agent.\n\n";
  const id = nextDebugId(existing);
  const block = formatDebugEntry({
    id,
    ref: opts.ref,
    symptom: opts.symptom,
    evidence: opts.evidence ?? "(pending)",
    rootCause: opts.rootCause ?? "(under investigation)",
    status,
  });
  fs.writeFileSync(file, existing + block, "utf8");
  structuredLog({ cmd: "debug log add", id, ref: opts.ref, status });
  return success({ data: { id, ref: opts.ref, status }, human: `${id} logged (${status}).` });
}

/** `th debug log list` — list debug entries + open count. */
export function runDebugLogList(paths: ProjectPaths): CommandResult {
  const file = debugLogPath(paths);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const entries = parseDebugEntries(text);
  const open = entries.filter((e) => e.status === "open");
  const human = entries.length
    ? [...entries.map((e) => `${e.id}  (${e.ref})  — ${e.status}: ${e.symptom}`), "", `${open.length} open, ${entries.length} total.`].join("\n")
    : "(no debug entries)";
  return success({ data: { entries, open: open.length, total: entries.length }, human });
}
