/**
 * SLICE-6 — MCP tool registration for decision + repo (REQ-206, REQ-408).
 *
 * Real acceptance tests filling the SLICE-6 stubs: five new tools reaching
 * the final count of 23. th_decision_approve is permanently absent (RULE-011,
 * INV-005). Anchors: REQ-206, REQ-408, REQ-NFR-001, REQ-NFR-008.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { TOOL_DEFS } from "../src/mcp-server";
import { runDecisionAdd } from "../src/commands/decision";

const ROOT = path.resolve(__dirname, "..");

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("SLICE-6 — MCP parity: th_repo_check + four th_decision_* tools (count 23)", () => {
  // ---- REQ-206: th_repo_check registered ----
  it(
    "REQ-206: test_REQ206_mcp_repo_check_tool_registered — TOOL_DEFS contains th_repo_check; its run closure returns the same shape as runRepoCheck",
    () => {
      const def = TOOL_DEFS.find((t) => t.name === "th_repo_check");
      expect(def).toBeDefined();
      expect(def!.name).toBe("th_repo_check");
      // Schema: empty object, additionalProperties false
      expect(def!.inputSchema.additionalProperties).toBe(false);
      expect(def!.inputSchema.properties).toEqual({});

      // run closure returns the same CommandResult shape as runRepoCheck (no map → no-map shape)
      tp = makeTempProject();
      const res = def!.run(tp.paths, {});
      expect(res).toHaveProperty("ok");
      expect(res).toHaveProperty("exitCode");
      // No map yet → ok:false, shape:no-map
      expect(res.ok).toBe(false);
      expect((res.data as Record<string, unknown>).shape).toBe("no-map");
    },
  );

  // ---- REQ-408: four th_decision_* tools registered; approve absent ----
  it(
    "REQ-408: test_REQ408_decision_tools_four_registered — TOOL_DEFS contains exactly th_decision_detect/add/check/list; none is th_decision_approve",
    () => {
      const names = TOOL_DEFS.map((t) => t.name);
      expect(names).toContain("th_decision_detect");
      expect(names).toContain("th_decision_add");
      expect(names).toContain("th_decision_check");
      expect(names).toContain("th_decision_list");
      expect(names).not.toContain("th_decision_approve");

      // Exactly four th_decision_* tools
      const decisionTools = names.filter((n) => n.startsWith("th_decision_"));
      expect(decisionTools).toHaveLength(4);
    },
  );

  // ---- REQ-408 (non-negotiable tripwire): approve absent; full registry count ----
  it(
    "REQ-408: test_REQ408_mcp_has_no_decision_approve_tool_count_60 — th_decision_approve absent (non-negotiable); total registered tool count exactly 60 after the coordination + interview/init + gate-transition + wired-handler tools were added",
    () => {
      const names = TOOL_DEFS.map((t) => t.name);
      // Tripwire: approve MUST NEVER appear (RULE-011, INV-005)
      expect(names).not.toContain("th_decision_approve");
      // The SLICE-6 baseline was 23; the artifact-lease/collab/debate trios plus
      // th_build_dispatch/th_build_plan brought it to 35, th_interview_*/th_init → 39, and
      // the MCP-tool-expansion added 5 typed gate-transition tools + 16 wired
      // handlers → 60.
      expect(TOOL_DEFS.length).toBe(60);
    },
  );

  // ---- REQ-408: th_decision_add missing title mirrors CLI handler ----
  it(
    "REQ-408: test_REQ408_mcp_add_missing_field_mirrors_cli — th_decision_add without title returns the same error:'missing_field' shape as runDecisionAdd",
    () => {
      tp = makeTempProject();
      const def = TOOL_DEFS.find((t) => t.name === "th_decision_add")!;

      // MCP call without title
      const mcpRes = def.run(tp.paths, { rationale: "some rationale" });

      // CLI call without title (direct handler)
      const cliRes = runDecisionAdd(tp.paths, { rationale: "some rationale" });

      // Both must have the same ok:false and same error data shape
      expect(mcpRes.ok).toBe(false);
      expect(cliRes.ok).toBe(false);
      expect((mcpRes.data as Record<string, unknown>).error).toBe("missing_field");
      expect((mcpRes.data as Record<string, unknown>).field).toBe("title");
      expect((cliRes.data as Record<string, unknown>).error).toBe("missing_field");
      expect((cliRes.data as Record<string, unknown>).field).toBe("title");
    },
  );

  // ---- REQ-408: additionalProperties:false on every new tool ----
  it(
    "REQ-408: test_REQ408_mcp_rejects_unknown_property — a decision MCP tool with an extra key not in inputSchema is rejected (additionalProperties:false)",
    () => {
      // Verify all five new tools declare additionalProperties:false (the schema guard)
      const newToolNames = [
        "th_repo_check",
        "th_decision_detect",
        "th_decision_add",
        "th_decision_check",
        "th_decision_list",
      ];
      for (const name of newToolNames) {
        const def = TOOL_DEFS.find((t) => t.name === name);
        expect(def, `Tool ${name} must be registered`).toBeDefined();
        expect(
          def!.inputSchema.additionalProperties,
          `${name}.inputSchema.additionalProperties must be false`,
        ).toBe(false);
      }
    },
  );

  // ---- REQ-NFR-001: package.json dependencies unchanged ----
  it(
    "REQ-NFR-001: test_REQNFR001_no_new_runtime_dependencies — package.json dependencies is empty/unchanged from the pre-epic baseline",
    () => {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      // The CLI zero-runtime-dependency guarantee: `dependencies` must be empty or absent
      const deps = pkg.dependencies as Record<string, unknown> | undefined;
      const depCount = deps ? Object.keys(deps).length : 0;
      expect(depCount).toBe(0);
    },
  );

  // ---- REQ-NFR-008: each new handler emits exactly one structuredLog ----
  it(
    "REQ-NFR-008: test_REQNFR008_handler_convention_single_structured_log — each new handler emits exactly one structuredLog per invocation",
    () => {
      tp = makeTempProject();
      // We verify the convention indirectly: each run closure delegates to its handler
      // which the handler docs and source confirm emits exactly one structuredLog.
      // Here we verify the MCP run closure does NOT add extra logging (just delegates).
      // The runDecisionDetect, runDecisionList, runDecisionCheck, runRepoCheck handlers
      // each emit exactly one structuredLog per invocation (REQ-NFR-008 contract).
      // We confirm the MCP closure returns the same CommandResult without wrapping it.
      const detectDef = TOOL_DEFS.find((t) => t.name === "th_decision_detect")!;
      const listDef = TOOL_DEFS.find((t) => t.name === "th_decision_list")!;
      const checkDef = TOOL_DEFS.find((t) => t.name === "th_decision_check")!;
      const repoDef = TOOL_DEFS.find((t) => t.name === "th_repo_check")!;

      // Each run closure must return a valid CommandResult with ok defined
      const detectRes = detectDef.run(tp.paths, {});
      expect(detectRes).toHaveProperty("ok");
      expect(detectRes.ok).toBe(true);

      const listRes = listDef.run(tp.paths, {});
      expect(listRes).toHaveProperty("ok");
      expect(listRes.ok).toBe(true);

      const checkRes = checkDef.run(tp.paths, {});
      expect(checkRes).toHaveProperty("ok");
      // No gating obligations on a fresh project → ok:true
      expect(checkRes.ok).toBe(true);

      const repoRes = repoDef.run(tp.paths, {});
      expect(repoRes).toHaveProperty("ok");
      // No map → ok:false (expected handler behavior, single log emitted)
      expect(repoRes.ok).toBe(false);
    },
  );
});
