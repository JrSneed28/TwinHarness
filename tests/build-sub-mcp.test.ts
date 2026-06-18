/**
 * SLICE-1 — MCP sub-claim / sub-release wrappers (REQ-101..105).
 *
 * Real assertions replacing the it.todo stubs. Each test carries its
 * REQ-ID anchor in the description string (the literal form `th anchors scan`
 * and `th coverage check` recognise).
 *
 * Anchors covered: REQ-101, REQ-102, REQ-103, REQ-104, REQ-105.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runBuildClaim, runBuildSubClaim, runBuildSubRelease } from "../src/commands/build";
import { TOOL_DEFS } from "../src/mcp-server";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** Set up a temp project with a parent slice in-progress and its top-level lease held. */
function parentInProgress(t: TempProject, id = "SLICE-P", components = ["core", "api"]): void {
  runStateSet(t.paths, "slices", JSON.stringify([{ id, status: "in-progress", components }]));
  runBuildClaim(t.paths, id);
}

describe("SLICE-1 — MCP sub-claim / sub-release wrappers", () => {
  it(
    "REQ-101: test_REQ101_mcp_sub_claim_matches_cli_behavior — th_build_sub_claim run closure yields a CommandResult identical to runBuildSubClaim (same data, exitCode, lease effect)",
    () => {
      tp = makeTempProject();
      runInit(tp.paths, {});
      parentInProgress(tp);

      // Call via the MCP ToolDef's run closure — must match calling runBuildSubClaim directly.
      const def = TOOL_DEFS.find((t) => t.name === "th_build_sub_claim")!;
      expect(def).toBeDefined();

      const mcpRes = def.run(tp.paths, { parentSlice: "SLICE-P", components: "core" });

      // Direct call on a fresh equivalent project for comparison.
      const tp2 = makeTempProject();
      try {
        runInit(tp2.paths, {});
        parentInProgress(tp2);
        const directRes = runBuildSubClaim(tp2.paths, "SLICE-P", ["core"]);

        // Same success/failure shape and exit-code.
        expect(mcpRes.ok).toBe(directRes.ok);
        expect(mcpRes.exitCode).toBe(directRes.exitCode);
        // Both produce data with the same structural keys.
        expect(mcpRes.data?.parent).toBe(directRes.data?.parent);
        expect(mcpRes.data?.components).toEqual(directRes.data?.components);
        // Both produce a sub-id of the same form (SLICE-P#sub-1 since each project starts fresh).
        expect(mcpRes.data?.subId).toBe("SLICE-P#sub-1");
        expect(directRes.data?.subId).toBe("SLICE-P#sub-1");
      } finally {
        tp2.cleanup();
      }
    },
  );

  it(
    "REQ-102: test_REQ102_mcp_sub_claim_components_parsed_correctly — components 'core, api , ' parses to ['core','api'] reaching runBuildSubClaim",
    () => {
      tp = makeTempProject();
      runInit(tp.paths, {});
      parentInProgress(tp, "SLICE-P", ["core", "api", "db"]);

      const def = TOOL_DEFS.find((t) => t.name === "th_build_sub_claim")!;
      // Pass the comma-separated string with extra spaces and a trailing comma (empty entry).
      const res = def.run(tp.paths, { parentSlice: "SLICE-P", components: "core, api , " });

      // Must succeed — "core" and "api" are valid subsets of the parent.
      expect(res.ok).toBe(true);
      // The components that landed at runBuildSubClaim must be the trimmed, empty-stripped array.
      expect(res.data?.components).toEqual(["core", "api"]);
      expect(res.data?.parent).toBe("SLICE-P");
    },
  );

  it(
    "REQ-103: test_REQ103_mcp_sub_release_matches_cli_behavior — th_build_sub_release releases the lease and matches runBuildSubRelease directly",
    () => {
      tp = makeTempProject();
      runInit(tp.paths, {});
      parentInProgress(tp);

      // First open a sub-lease via the claim tool.
      const claimDef = TOOL_DEFS.find((t) => t.name === "th_build_sub_claim")!;
      const claimRes = claimDef.run(tp.paths, { parentSlice: "SLICE-P", components: "core" });
      expect(claimRes.ok).toBe(true);
      const subId = claimRes.data?.subId as string;
      expect(subId).toBe("SLICE-P#sub-1");

      // Release via MCP tool closure.
      const relDef = TOOL_DEFS.find((t) => t.name === "th_build_sub_release")!;
      const mcpRes = relDef.run(tp.paths, { subId });

      // Compare to what runBuildSubRelease returns on an already-released sub-lease
      // (which gives sub_lease_not_found — the side effect is already consumed).
      // Instead we verify the MCP closure succeeds (ok:true, lease is gone) and
      // that a second release returns the same error runBuildSubRelease would.
      expect(mcpRes.ok).toBe(true);
      expect(mcpRes.human).toContain(subId);

      // Second release via direct handler must fail — lease already released.
      const directDoubleRelease = runBuildSubRelease(tp.paths, subId);
      expect(directDoubleRelease.ok).toBe(false);
      expect(directDoubleRelease.data?.error).toBe("sub_lease_not_found");
    },
  );

  it(
    "REQ-104: test_REQ104_mcp_sub_release_input_schema — schema rejects missing subId and unknown properties (additionalProperties:false)",
    () => {
      const def = TOOL_DEFS.find((t) => t.name === "th_build_sub_release")!;
      expect(def).toBeDefined();

      // Schema must declare subId as required.
      expect(def.inputSchema.required).toContain("subId");
      // Schema must be closed (additionalProperties:false).
      expect(def.inputSchema.additionalProperties).toBe(false);
      // subId property must be of type string.
      expect(def.inputSchema.properties["subId"]?.type).toBe("string");

      // Also verify th_build_sub_claim schema shape (REQ-102's contract side).
      const claimDef = TOOL_DEFS.find((t) => t.name === "th_build_sub_claim")!;
      expect(claimDef.inputSchema.required).toContain("parentSlice");
      expect(claimDef.inputSchema.required).toContain("components");
      expect(claimDef.inputSchema.additionalProperties).toBe(false);
    },
  );

  it(
    "REQ-105: test_REQ105_tool_count_incremental_path_16_to_60 — TOOL_DEFS.length is 60 after the coordination-primitive layer + interview/init + gate-transition + wired-handler tools; toToolResult round-trips for the sub-lease tools",
    () => {
      // The coordination-primitive layer advances the count to 35 (th_build_dispatch/plan
      // inserted into the build group + th_artifact_*/collab_*/debate_* appended), the
      // th_interview_*/th_init tools append to reach 39, and the MCP-tool-expansion
      // adds 21 more (5 typed gate-transition tools + 16 wired handlers) → 60.
      expect(TOOL_DEFS.length).toBe(60);

      // Both sub-lease tools must be present.
      const names = TOOL_DEFS.map((t) => t.name);
      expect(names).toContain("th_build_sub_claim");
      expect(names).toContain("th_build_sub_release");

      // The forbidden tool must remain absent.
      expect(names).not.toContain("th_decision_approve");

      // th_build_dispatch + th_build_plan were inserted after th_build_release (16/17→18/19),
      // and the MCP-tool-expansion then inserted 5 typed gate tools (positions 3-7),
      // th_drift_list/resolve (9-10) and th_coverage_report (18) ahead of the build group,
      // shifting the sub-lease tools to canonical positions 27/28 → indices 26/27.
      expect(names[26]).toBe("th_build_sub_claim");
      expect(names[27]).toBe("th_build_sub_release");
    },
  );
});
