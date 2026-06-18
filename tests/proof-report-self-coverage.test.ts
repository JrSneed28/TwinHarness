/**
 * Finding #4 — th_proof_report can now count ITS OWN call in the coverage matrix.
 *
 * FIXED BEHAVIOR (was a bug): callTool() appends the proof-calls entry BEFORE it
 * dispatches the handler (src/mcp-server.ts callTool). So when th_proof_report
 * harvests the live scenario trail and builds the coverage matrix, that trail
 * ALREADY contains th_proof_report — the report can include itself in the
 * "touched" MCP-tool set.
 *
 * Under the OLD post-dispatch logging the append ran AFTER runProofReport had
 * already harvested the trail and built the matrix, so th_proof_report was
 * permanently invisible to its own coverage matrix.
 *
 * THIS TEST PINS THE FIXED BEHAVIOR end-to-end: it runs th_proof_report against a
 * REAL isolated scenario sandbox (so the report harvests that sandbox's
 * proof-calls.jsonl), reads the emitted report.json, and asserts th_proof_report
 * is in matrix.mcpTools.touched. A regression to post-dispatch logging flips it.
 *
 * (The earlier characterization version of this file pinned the WRONG behavior by
 *  driving buildCoverageMatrix with a pre-self-call trail; the fix flips it here.)
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import { callTool } from "../src/mcp-server";
import { readProofCalls } from "../src/core/proof/harvest";
import { startScenario } from "../src/core/proof/scenario";
import { resolveProjectPaths } from "../src/core/paths";
import type { SampleBrief, ProofReport } from "../src/core/proof/types";

/** A minimal greenfield brief — enough for startScenario to scaffold an isolated sandbox. */
const BRIEF: SampleBrief = {
  id: "self-coverage-probe",
  size: "tiny",
  domain: "cli",
  tierHint: "T1",
  type: "greenfield",
  acceptanceCriteria: ["self-coverage probe"],
};

/** Pull the structured `data` payload off a CallToolResult (toToolResult attaches it). */
function structuredData(res: unknown): { summary?: { stats?: { report?: { jsonPath?: string } } } } | undefined {
  return (res as { structuredContent?: { summary?: { stats?: { report?: { jsonPath?: string } } } } }).structuredContent;
}

describe("Finding #4: th_proof_report self-coverage (regression — pins FIXED before-dispatch logging)", () => {
  let prevProjectDir: string | undefined;
  let scenarioRoot: string | undefined;

  beforeEach(() => {
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    if (scenarioRoot) {
      try {
        fs.rmSync(scenarioRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      scenarioRoot = undefined;
    }
  });

  it("the self-call is recorded in the scenario trail BEFORE dispatch (ok:true)", async () => {
    const handle = startScenario(BRIEF);
    scenarioRoot = handle.scenarioRoot;
    process.env.CLAUDE_PROJECT_DIR = handle.scenarioRoot;

    await callTool("th_proof_report", {});

    // The mechanism the fix relies on: the self-call was appended to the scenario's
    // dedicated trail (with ok:true — it passed validation and dispatched).
    const calls = readProofCalls(resolveProjectPaths(handle.scenarioRoot));
    const self = calls.find((c) => c.tool === "th_proof_report");
    expect(self).toBeDefined();
    expect(self!.ok).toBe(true);
  }, 30000);

  it("th_proof_report appears in the emitted matrix's touched MCP tools (impossible under post-dispatch logging)", async () => {
    const handle = startScenario(BRIEF);
    scenarioRoot = handle.scenarioRoot;
    process.env.CLAUDE_PROJECT_DIR = handle.scenarioRoot;

    const res = await callTool("th_proof_report", {});

    // The probe scenario won't touch every subsystem/tool, so the run verdict may be
    // a failure (incomplete coverage) — that is irrelevant here. We only assert that
    // th_proof_report COUNTED ITSELF, which the emitted report.json records.
    const jsonPath = structuredData(res)?.summary?.stats?.report?.jsonPath;
    expect(typeof jsonPath).toBe("string");

    const report = JSON.parse(fs.readFileSync(jsonPath!, "utf8")) as ProofReport;
    expect(report.matrix.mcpTools.touched).toContain("th_proof_report");
    expect(report.matrix.mcpTools.untouched).not.toContain("th_proof_report");
  }, 30000);
});
