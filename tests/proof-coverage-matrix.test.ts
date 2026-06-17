/**
 * Coverage matrix (plan Step 9 / §11 / AC #5 / §10 pre-mortem #1).
 *
 * The matrix is the HARD gate: it FAILS the run if any subsystem / any MCP tool /
 * any gate goes unexercised. The decisive cases here are (1) fail-on-gap — removing
 * one tool from the live trail flips `complete` to false with a diagnostic naming
 * it — and (2) the self-test rejection — a self-test-only touched-set NEVER satisfies
 * the LIVE MCP-tool dimension (it proves mechanical reachability only).
 */

import { describe, it, expect } from "vitest";
import {
  buildCoverageMatrix,
  matrixDiagnostics,
  PROOF_SUBSYSTEMS,
  PROOF_GATES,
} from "../src/core/proof/coverage-matrix";
import type { ProofCall } from "../src/core/proof/types";

const TOOLS = ["th_state_get", "th_route", "th_next"] as const;

/** A live proof-calls.jsonl trail touching exactly `names`. */
function trail(names: readonly string[]): ProofCall[] {
  return names.map((tool) => ({ tool, ts: new Date().toISOString(), ok: true }));
}

describe("buildCoverageMatrix — complete only when every dimension is fully touched", () => {
  it("is COMPLETE when subsystems, MCP tools, and gates are all touched", () => {
    const matrix = buildCoverageMatrix({
      knownToolNames: TOOLS,
      liveMcpCalls: trail(TOOLS),
      subsystemsTouched: [...PROOF_SUBSYSTEMS],
      gatesTouched: [...PROOF_GATES],
    });
    expect(matrix.complete).toBe(true);
    expect(matrix.subsystems.untouched).toEqual([]);
    expect(matrix.mcpTools.untouched).toEqual([]);
    expect(matrix.gates.untouched).toEqual([]);
    expect(matrix.mcpTools.count).toBe(TOOLS.length);
    expect(matrixDiagnostics(matrix)).toEqual([]);
  });
});

describe("fail-on-gap — one untouched MCP tool FAILS the matrix with a naming diagnostic (AC #5)", () => {
  it("flips complete:false and emits a diagnostic naming the missing tool", () => {
    const matrix = buildCoverageMatrix({
      knownToolNames: TOOLS,
      liveMcpCalls: trail(["th_state_get", "th_route"]), // th_next NOT invoked live
      subsystemsTouched: [...PROOF_SUBSYSTEMS],
      gatesTouched: [...PROOF_GATES],
    });
    expect(matrix.complete).toBe(false);
    expect(matrix.mcpTools.untouched).toEqual(["th_next"]);

    const diags = matrixDiagnostics(matrix);
    const naming = diags.find((d) => d.location === "mcp-tool:th_next");
    expect(naming).toBeDefined();
    expect(naming!.component).toBe("runner-report");
    expect(naming!.hint).toContain("th_next");
  });
});

describe("self-test rejection — a self-test-only touched-set NEVER satisfies the live MCP dimension (pre-mortem #1)", () => {
  it("forces mcpTools untouched even when the (self-test) trail names every tool", () => {
    const matrix = buildCoverageMatrix({
      knownToolNames: TOOLS,
      liveMcpCalls: trail(TOOLS), // a self-test loop could 'touch' every tool…
      subsystemsTouched: [...PROOF_SUBSYSTEMS],
      gatesTouched: [...PROOF_GATES],
      selfTestOnly: true, // …but self-test must NOT satisfy the LIVE dimension
    });
    expect(matrix.mcpTools.touched).toEqual([]);
    expect(matrix.mcpTools.untouched).toEqual([...TOOLS]);
    expect(matrix.complete).toBe(false);

    const diags = matrixDiagnostics(matrix, { selfTestOnly: true });
    expect(diags.length).toBe(TOOLS.length);
    expect(diags.every((d) => d.location.startsWith("mcp-tool:"))).toBe(true);
    expect(diags[0]!.hint.toLowerCase()).toContain("self-test");
  });
});

describe("unverifiable — an absent registry reports the MCP dimension UNVERIFIABLE, never silently complete", () => {
  it("forces mcpTools untouched + a distinct unverifiable diagnostic", () => {
    const matrix = buildCoverageMatrix({
      knownToolNames: TOOLS,
      liveMcpCalls: trail(TOOLS),
      subsystemsTouched: [...PROOF_SUBSYSTEMS],
      gatesTouched: [...PROOF_GATES],
      mcpUnverifiable: true,
    });
    expect(matrix.mcpTools.touched).toEqual([]);
    expect(matrix.complete).toBe(false);
    const diags = matrixDiagnostics(matrix, { mcpUnverifiable: true });
    expect(diags[0]!.hint.toLowerCase()).toContain("unverifiable");
  });
});

describe("subsystem + gate dimensions are enforced too", () => {
  it("FAILS when a subsystem is untouched and names it", () => {
    const partial = PROOF_SUBSYSTEMS.filter((s) => s !== "telemetry");
    const matrix = buildCoverageMatrix({
      knownToolNames: TOOLS,
      liveMcpCalls: trail(TOOLS),
      subsystemsTouched: [...partial],
      gatesTouched: [...PROOF_GATES],
    });
    expect(matrix.complete).toBe(false);
    expect(matrix.subsystems.untouched).toEqual(["telemetry"]);
    expect(matrixDiagnostics(matrix).some((d) => d.location === "subsystem:telemetry")).toBe(true);
  });

  it("FAILS when a gate is untouched and names it", () => {
    const partial = PROOF_GATES.filter((g) => g !== "decision");
    const matrix = buildCoverageMatrix({
      knownToolNames: TOOLS,
      liveMcpCalls: trail(TOOLS),
      subsystemsTouched: [...PROOF_SUBSYSTEMS],
      gatesTouched: [...partial],
    });
    expect(matrix.complete).toBe(false);
    expect(matrix.gates.untouched).toEqual(["decision"]);
    expect(matrixDiagnostics(matrix).some((d) => d.location === "gate:decision")).toBe(true);
  });
});
