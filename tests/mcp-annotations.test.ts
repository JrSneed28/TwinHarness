/**
 * Phase 7 / P7-2 — machine-readable MCP tool annotations + compact-by-default
 * (REQ-PCO-071).
 *
 * Every tool carries MCP-standard behavior hints (readOnlyHint / destructiveHint /
 * idempotentHint) and a TwinHarness `category` for grouping. This is a THIN
 * annotation layer: it never changes the tool count or any name (the consolidation
 * of overlapping oracles is expressed purely as a shared category). The heavy
 * oracle tools are compact-by-default with a `verbose` opt-in.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, expectedToolDefsCount, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import {
  TOOL_DEFS,
  TOOL_ANNOTATIONS,
  toolAnnotations,
  listTools,
  compactHeavyResult,
} from "../src/mcp-server";
import { writeTelemetryConfig } from "../src/core/telemetry";
import { success, failure } from "../src/core/output";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Snapshot every file under `dir` as a relative-path → bytes map (recursive). */
function snapshotDir(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (cur: string) => {
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) walk(abs);
      else out.set(path.relative(dir, abs), fs.readFileSync(abs));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

describe("REQ-PCO-071: every tool is annotated (no gaps, no orphans)", () => {
  it("REQ-PCO-071: every TOOL_DEFS entry has exactly one annotation", () => {
    const missing = TOOL_DEFS.filter((t) => !TOOL_ANNOTATIONS[t.name]).map((t) => t.name);
    expect(missing, `tools without an annotation: ${missing.join(", ")}`).toEqual([]);
  });

  it("REQ-PCO-071: no orphan annotation (every annotated name is a real tool)", () => {
    const names = new Set(TOOL_DEFS.map((t) => t.name));
    const orphans = Object.keys(TOOL_ANNOTATIONS).filter((n) => !names.has(n));
    expect(orphans, `annotations for non-existent tools: ${orphans.join(", ")}`).toEqual([]);
  });

  it("REQ-PCO-071: the annotation count equals the tool count (62)", () => {
    expect(Object.keys(TOOL_ANNOTATIONS).length).toBe(TOOL_DEFS.length);
    expect(TOOL_DEFS.length).toBe(expectedToolDefsCount());
  });
});

describe("REQ-PCO-071: hint semantics are coherent", () => {
  it("REQ-PCO-071: a read-only tool is never destructive and is idempotent", () => {
    for (const [name, a] of Object.entries(TOOL_ANNOTATIONS)) {
      if (a.readOnlyHint) {
        expect(a.destructiveHint, `${name}: read-only tool must not be destructive`).toBe(false);
        expect(a.idempotentHint, `${name}: read-only tool must be idempotent`).toBe(true);
      }
    }
  });

  it("REQ-PCO-071: known read-only tools are flagged read-only", () => {
    // R-09: th_scorecard was previously (wrongly) pinned read-only here while it
    // appends a telemetry.jsonl line per call when telemetry is ON. It now lives in
    // the not-read-only list below. th_doctor is the genuine read-only health oracle.
    for (const name of ["th_state_get", "th_next", "th_doctor", "th_coverage_report", "th_repo_relevant", "th_repo_impact"]) {
      expect(toolAnnotations(name)?.readOnlyHint, `${name} must be read-only`).toBe(true);
    }
  });

  it("REQ-PCO-071: mutating tools are flagged not-read-only", () => {
    // R-09: th_route and th_scorecard write an opt-in telemetry line per call, so
    // their honest hint is readOnlyHint:false (moved out of the read-only list above).
    for (const name of ["th_state_set", "th_tier_record", "th_drift_add", "th_verify_clear", "th_init", "th_repo_map", "th_route", "th_scorecard"]) {
      expect(toolAnnotations(name)?.readOnlyHint, `${name} must NOT be read-only`).toBe(false);
    }
  });

  it("REQ-PCO-071: append/ledger tools are NOT idempotent; set/upsert tools ARE", () => {
    // Append/ledger tools, INCLUDING every lease claim/release: each appends a JSONL
    // event per call (appendLeaseEvent / append*), so a second identical call is NOT a
    // no-op and must report idempotentHint:false (DR-03 / R-10). The lease tools were
    // previously mis-annotated idempotent:true, contradicting this module's own rule
    // ("FALSE for append/ledger/lease tools where a second call records another event").
    for (const name of [
      "th_drift_add", "th_decision_add", "th_debate_add", "th_verify_add",
      "th_build_claim", "th_build_release", "th_build_sub_claim", "th_build_sub_release",
      "th_artifact_claim", "th_artifact_release",
      // R-09: each appends one telemetry.jsonl line per call when telemetry is ON
      // (N calls → N lines), so idempotentHint:false matches the append reality.
      "th_route", "th_scorecard",
    ]) {
      expect(toolAnnotations(name)?.idempotentHint, `${name} (append) must not be idempotent`).toBe(false);
    }
    for (const name of ["th_init", "th_slices_sync", "th_repo_map", "th_slice_set_status"]) {
      expect(toolAnnotations(name)?.idempotentHint, `${name} (set/upsert) must be idempotent`).toBe(true);
    }
  });

  it("REQ-PCO-071: the consolidated oracle groups share a category", () => {
    // next/next_wave/dispatch group under "oracle"; doctor/scorecard under "health".
    for (const name of ["th_next", "th_build_next_wave", "th_build_dispatch", "th_build_plan"]) {
      expect(toolAnnotations(name)?.category, `${name} must be in the oracle group`).toBe("oracle");
    }
    for (const name of ["th_doctor", "th_scorecard"]) {
      expect(toolAnnotations(name)?.category, `${name} must be in the health group`).toBe("health");
    }
  });
});

describe("REQ-PCO-071: annotations are advertised on the MCP tool list", () => {
  it("REQ-PCO-071: listTools() carries annotations + category _meta for every tool", () => {
    const tools = listTools();
    expect(tools.length).toBe(TOOL_DEFS.length);
    for (const t of tools) {
      const ann = TOOL_ANNOTATIONS[t.name]!;
      expect(t.annotations, `${t.name} must advertise annotations`).toBeDefined();
      expect((t.annotations as Record<string, unknown>).readOnlyHint).toBe(ann.readOnlyHint);
      expect((t.annotations as Record<string, unknown>).destructiveHint).toBe(ann.destructiveHint);
      expect((t.annotations as Record<string, unknown>).idempotentHint).toBe(ann.idempotentHint);
      expect((t as { _meta?: Record<string, unknown> })._meta?.["twinharness.dev/category"]).toBe(ann.category);
    }
  });
});

describe("REQ-PCO-071: compact-by-default for heavy tools (verbose opt-in)", () => {
  it("REQ-PCO-071: compactHeavyResult collapses a multi-line report by default, keeps data", () => {
    const r = success({ data: { rows: [1, 2, 3] }, human: "HEADLINE\nrow 1\nrow 2\nrow 3" });
    const compact = compactHeavyResult(r, false);
    expect(compact.human).toContain("HEADLINE");
    expect(compact.human).toContain("compact");
    expect(compact.human!.split("\n").length).toBeLessThan(r.human!.split("\n").length);
    // Lossless: the structured data is untouched.
    expect(compact.data).toEqual(r.data);
  });

  it("REQ-PCO-071: verbose:true returns the full human report unchanged", () => {
    const r = success({ data: { x: 1 }, human: "A\nB\nC" });
    expect(compactHeavyResult(r, true)).toBe(r);
  });

  it("REQ-PCO-071: a failure / single-line result is returned unchanged", () => {
    const fail = failure({ human: "one line problem", data: { error: "x" } });
    expect(compactHeavyResult(fail, false)).toBe(fail);
    const oneLine = success({ human: "single", data: {} });
    expect(compactHeavyResult(oneLine, false)).toBe(oneLine);
  });

  it("REQ-PCO-071: th_doctor default is compact; verbose:true is the full report (data identical)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const def = TOOL_DEFS.find((t) => t.name === "th_doctor")!;
    const compact = def.run(tp.paths, {});
    const verbose = def.run(tp.paths, { verbose: true });
    // Same structured payload; the compact human text is shorter.
    expect(compact.data).toEqual(verbose.data);
    expect(String(compact.human).length).toBeLessThanOrEqual(String(verbose.human).length);
  });

  it("REQ-PCO-071: th_doctor/th_scorecard/th_coverage_report accept the verbose flag (schema)", () => {
    for (const name of ["th_doctor", "th_scorecard", "th_coverage_report"]) {
      const def = TOOL_DEFS.find((t) => t.name === name)!;
      expect(def.inputSchema.properties.verbose, `${name} must declare a verbose input`).toBeDefined();
      expect(def.inputSchema.properties.verbose!.type).toBe("boolean");
    }
  });
});

describe("REQ-PCO-071 / R-09: read-only tools write zero bytes even with telemetry ON", () => {
  // The general guard the deep dive (R-09) calls for: a tool that advertises
  // readOnlyHint:true must perform NO stateDir mutation on ANY client-reachable call.
  // Telemetry is the worst case — it's the opt-in switch that turned th_route /
  // th_scorecard into disk writers under a false read-only hint. With telemetry ON
  // and a populated state dir (including a LEGACY interview.json that would otherwise
  // be lazily rewritten on read), driving every readOnlyHint:true tool must leave the
  // state dir byte-for-byte unchanged. If a future tool starts writing under a
  // read-only hint, this sweep fails with the offending tool name.
  it("R-09: a telemetry-on sweep over every read-only tool leaves stateDir unchanged", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Worst case: telemetry is explicitly ENABLED (the R-09 trigger).
    writeTelemetryConfig(tp.paths, { enabled: true });
    // Seed a LEGACY-shape interview store so the read-only interview/gate tools
    // exercise the lazy-upgrade path (which must NOT persist on a read-only call).
    fs.writeFileSync(
      tp.paths.interviewFile,
      JSON.stringify({ idea: "legacy", threshold: 0.2, ambiguity: 0.1, rounds: [] }, null, 2) + "\n",
      "utf8",
    );

    const before = snapshotDir(tp.paths.stateDir);

    const readOnly = TOOL_DEFS.filter((t) => TOOL_ANNOTATIONS[t.name]?.readOnlyHint === true);
    // Guard against a vacuous sweep: the read-only set must be non-trivial AND must
    // include the interview/next gate consumers that exercise the lazy-upgrade path.
    expect(readOnly.length).toBeGreaterThan(10);
    const roNames = new Set(readOnly.map((t) => t.name));
    expect(roNames.has("th_interview_status"), "th_interview_status must be read-only (R-09)").toBe(true);
    expect(roNames.has("th_next"), "th_next must be read-only").toBe(true);

    for (const def of readOnly) {
      // Every read-only oracle tolerates empty args (sensible defaults); drive it.
      def.run(tp.paths, {});
    }

    const after = snapshotDir(tp.paths.stateDir);

    // No new files, no deleted files, no changed bytes — for EVERY read-only tool.
    const newFiles = [...after.keys()].filter((k) => !before.has(k));
    const goneFiles = [...before.keys()].filter((k) => !after.has(k));
    expect(newFiles, `read-only sweep created files: ${newFiles.join(", ")}`).toEqual([]);
    expect(goneFiles, `read-only sweep deleted files: ${goneFiles.join(", ")}`).toEqual([]);
    const changed = [...after.entries()]
      .filter(([k, buf]) => !before.get(k)?.equals(buf))
      .map(([k]) => k);
    expect(changed, `read-only sweep mutated bytes in: ${changed.join(", ")}`).toEqual([]);
  });
});
