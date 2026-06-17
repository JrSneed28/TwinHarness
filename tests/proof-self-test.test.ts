/**
 * Deterministic self-test end-to-end (plan Step 9 / §7.2 / §11 / AC #5).
 *
 * `runProof({selfTest:true, registry})` drives the deterministic spine (real `run*`
 * handlers, NO LLM — the orchestration-e2e pattern) to PRODUCE harvestable artifacts,
 * runs every mechanical sub-proof, and assembles a FULL nine-card {@link ProofReport}
 * with a coverage matrix. The decisive assertion (pre-mortem #1): the LIVE MCP-tool
 * dimension is NOT satisfied from a self-test loop alone — it proves mechanical
 * reachability only.
 *
 * This test MAY import TOOL_DEFS from ../src/mcp-server (tests are not bundled, so
 * the R7 no-cycle rule that binds the engine does not apply here).
 */

import { describe, it, expect } from "vitest";
import { runProof } from "../src/core/proof/runner";
import { PROOF_COMPONENTS } from "../src/core/proof/types";
import { TOOL_DEFS } from "../src/mcp-server";

const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

describe("proof self-test — full nine-card report, live MCP dimension NOT satisfied (AC #5)", () => {
  it(
    "produces all nine component cards from the deterministic spine",
    async () => {
      const report = await runProof({ selfTest: true, registry: { names: TOOL_NAMES } });

      // All nine components present, exactly once, in topology order.
      expect(report.cards.map((c) => c.component)).toEqual([...PROOF_COMPONENTS]);

      // Components 1/2/5 PASS over the deterministic completed run.
      const verdictOf = (c: string): string => report.cards.find((x) => x.component === c)!.verdict;
      expect(verdictOf("operational")).toBe("pass");
      expect(verdictOf("orchestration")).toBe("pass");
      expect(verdictOf("dogfood")).toBe("pass");
    },
    120_000,
  );

  it(
    "does NOT satisfy the live MCP-tool dimension from self-test alone",
    async () => {
      const report = await runProof({ selfTest: true, registry: { names: TOOL_NAMES } });

      // The MCP-tool dimension knows every registered tool…
      expect(report.matrix.mcpTools.count).toBe(TOOL_NAMES.length);
      // …but NONE are touched, because a self-test loop never satisfies the live trail.
      expect(report.matrix.mcpTools.touched).toEqual([]);
      expect(report.matrix.mcpTools.untouched).toEqual(TOOL_NAMES);

      // Subsystems + gates ARE fully exercised mechanically, isolating the gap to MCP.
      expect(report.matrix.subsystems.untouched).toEqual([]);
      expect(report.matrix.gates.untouched).toEqual([]);

      // Matrix incomplete ⇒ overall verdict FAIL (self-test never passes the live gate).
      expect(report.matrix.complete).toBe(false);
      expect(report.summary.verdict).toBe("fail");

      // A self-test diagnostic explains WHY the MCP dimension is unmet.
      const mcpDiag = report.diagnostics.find((d) => d.location.startsWith("mcp-tool:"));
      expect(mcpDiag).toBeDefined();
      expect(mcpDiag!.hint.toLowerCase()).toContain("self-test");
    },
    120_000,
  );
});
