/**
 * Component 7 (Security & containment) — plan §11; AC #12. The allowlist is the
 * exact NAME-SET (42 entries) and `th_decision_approve` is absent. A matching
 * tool-name list PASSES; an extra/missing name or `th_decision_approve` FAILS with
 * an AI-actionable diagnostic naming it. Also proves GATE_OWNED 5-field refusal and
 * telemetry no-network. Containment is DEPENDENCY-INJECTED — `toolNames` is passed
 * in, never imported from mcp-server (R7).
 */

import { describe, it, expect } from "vitest";
import {
  assertContainment,
  EXPECTED_TOOL_ALLOWLIST,
  FORBIDDEN_MCP_TOOL,
} from "../src/core/proof/containment";

const find = (
  report: ReturnType<typeof assertContainment>,
  name: string,
) => report.assertions.find((a) => a.name === name)!;

describe("proof/containment — exact NAME-SET + GATE_OWNED + telemetry (AC #12)", () => {
  it("allowlist has 42 entries and excludes th_decision_approve", () => {
    expect(EXPECTED_TOOL_ALLOWLIST.length).toBe(42);
    expect(EXPECTED_TOOL_ALLOWLIST).not.toContain(FORBIDDEN_MCP_TOOL);
    // 35 base + 3 proof + 4 new interview/init tools.
    expect(EXPECTED_TOOL_ALLOWLIST).toContain("th_proof_run");
    expect(EXPECTED_TOOL_ALLOWLIST).toContain("th_proof_component");
    expect(EXPECTED_TOOL_ALLOWLIST).toContain("th_proof_report");
    expect(EXPECTED_TOOL_ALLOWLIST).toContain("th_interview_start");
    expect(EXPECTED_TOOL_ALLOWLIST).toContain("th_interview_record");
    expect(EXPECTED_TOOL_ALLOWLIST).toContain("th_interview_status");
    expect(EXPECTED_TOOL_ALLOWLIST).toContain("th_init");
  });

  it("the EXPECTED allowlist as toolNames PASSES containment with no diagnostics", () => {
    const report = assertContainment({ toolNames: EXPECTED_TOOL_ALLOWLIST });
    for (const a of report.assertions) {
      expect(a.pass, `${a.name}: ${JSON.stringify(a.actual)}`).toBe(true);
    }
    expect(report.diagnostics).toHaveLength(0);
  });

  it("an EXTRA tool name FAILS the name-set assertion with a diagnostic naming it", () => {
    const report = assertContainment({ toolNames: [...EXPECTED_TOOL_ALLOWLIST, "th_rogue_tool"] });
    expect(find(report, "registry.name_set_equals_allowlist").pass).toBe(false);
    const diag = report.diagnostics.find((d) => d.hint.includes("th_rogue_tool"));
    expect(diag).toBeDefined();
    expect(diag!.component).toBe("containment");
  });

  it("a MISSING tool name FAILS the name-set assertion with a diagnostic naming it", () => {
    const missing = EXPECTED_TOOL_ALLOWLIST[0];
    const report = assertContainment({ toolNames: EXPECTED_TOOL_ALLOWLIST.slice(1) });
    expect(find(report, "registry.name_set_equals_allowlist").pass).toBe(false);
    expect(report.diagnostics.some((d) => d.hint.includes(missing!))).toBe(true);
  });

  it("th_decision_approve in the tool set FAILS the absence assertion", () => {
    const report = assertContainment({ toolNames: [...EXPECTED_TOOL_ALLOWLIST, FORBIDDEN_MCP_TOOL] });
    expect(find(report, "registry.decision_approve_absent").pass).toBe(false);
    expect(report.diagnostics.some((d) => d.hint.includes(FORBIDDEN_MCP_TOOL))).toBe(true);
  });

  it("resolveWithinRoot rejects every hostile path input", () => {
    const report = assertContainment({ toolNames: EXPECTED_TOOL_ALLOWLIST });
    const a = find(report, "guards.path_traversal_rejected");
    expect(a.pass).toBe(true);
    expect(a.actual).toBe(a.expected); // all hostile inputs rejected
  });

  it("MCP th_state_set refuses every GATE_OWNED field (5-field set)", () => {
    const report = assertContainment({ toolNames: EXPECTED_TOOL_ALLOWLIST });
    expect(find(report, "state.gate_owned_refused").pass).toBe(true);
    const count = find(report, "state.gate_owned_count");
    expect(count.pass).toBe(true);
    expect(count.actual).toBe(5);
    expect(report.stats.gateOwned).toEqual(
      expect.arrayContaining([
        "implementation_allowed",
        "tier",
        "current_stage",
        "write_gate",
        "blast_radius_flags",
      ]),
    );
  });

  it("telemetry stays local (no network import/egress in telemetry.ts)", () => {
    const report = assertContainment({ toolNames: EXPECTED_TOOL_ALLOWLIST });
    expect(find(report, "telemetry.no_network").pass).toBe(true);
  });

  it("an injected telemetry source WITH a network import is caught", () => {
    const report = assertContainment({
      toolNames: EXPECTED_TOOL_ALLOWLIST,
      telemetrySource: `import * as https from "node:https";\nhttps.get("http://evil");\n`,
    });
    expect(find(report, "telemetry.no_network").pass).toBe(false);
  });
});
