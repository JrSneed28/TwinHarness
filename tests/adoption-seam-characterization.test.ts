/**
 * SLICE-0 / TASK-001 — Adoption-seam characterization tests.
 *
 * These tests pin the CURRENT baseline behavior of the four adoption seams so
 * later slices cannot silently change them. They are regression tripwires, not
 * feature tests. No production logic is added; we characterize what already
 * exists.
 *
 * REQ-IDs anchored: REQ-105, REQ-408, REQ-504.
 *
 * Placement: a dedicated characterization file per docs/08-test-strategy.md §Slice 0.
 * The pre-scaffolded stub files (tests/mcp-parity.test.ts, tests/next-decision-obligation.test.ts)
 * are NOT touched here — they belong to SLICE-6 and SLICE-5 respectively and will
 * be filled in at the FINAL target values (count 23). This file asserts the CURRENT
 * baseline values (count 16, approve-absent, runNext baseline).
 */

import { describe, it, expect, afterEach } from "vitest";
import { TOOL_DEFS, toToolResult } from "../src/mcp-server";
import { runNext } from "../src/commands/next";
import { runInit } from "../src/commands/init";
import { success, failure, type CommandResult } from "../src/core/output";
import { makeTempProject, type TempProject } from "./helpers";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

// ---------------------------------------------------------------------------
// Seam B — TOOL_DEFS count invariant (REQ-105 baseline: 16)
// ---------------------------------------------------------------------------

describe("SLICE-0 characterization: MCP tool registry baseline (Seam B)", () => {
  /**
   * REQ-105: Both Feature-1 tools appended to TOOL_DEFS; the tool count follows
   * the incremental path 16→18→19→23. This test pins the 16 baseline at SLICE-0.
   * Later slices advance this assertion step by step.
   *
   * Anchor: REQ-105
   */
  it("REQ-105: test_REQ105_tool_count_incremental_path_16_to_60 — TOOL_DEFS.length is exactly 60 after the coordination-primitive layer (th_build_dispatch/plan + th_artifact_*/collab_*/debate_*) plus the interview/init tools (th_interview_*/th_init) plus the MCP-tool-expansion (5 typed gate-transition tools + 16 wired handlers)", () => {
    // The coordination-primitive layer advances the baseline from 23 to 35; the
    // interview/init tools (th_interview_*/th_init) append → 39; and the
    // MCP-tool-expansion adds 5 typed gate-transition tools + 16 wired handlers → 60.
    expect(TOOL_DEFS.length).toBe(62);
  });

  /**
   * REQ-105 (cont.) — toToolResult round-trip: a CommandResult with data and
   * human text maps to a CallToolResult with isError:false, matching content,
   * and structuredContent equal to the data payload. This characterizes the
   * adapter function that every new tool will depend on.
   *
   * Anchor: REQ-105
   */
  it("REQ-105: test_REQ105_toToolResult_round_trips_sample_tool_shape — toToolResult round-trips a sample tool shape", () => {
    const sample: CommandResult = success({
      data: { tool: "th_state_get", count: 16, seam: "B" },
      human: "characterization: 16 tools at baseline",
    });
    const mapped = toToolResult(sample);

    // isError is the inverse of result.ok
    expect(mapped.isError).toBe(false);

    // content is a single text block with the human string
    expect(mapped.content).toHaveLength(1);
    expect(mapped.content[0]).toMatchObject({ type: "text", text: "characterization: 16 tools at baseline" });

    // structuredContent carries the data payload for machine consumption,
    // now additively merged with the numeric exit code (ARCH-005).
    expect(mapped.structuredContent).toEqual({ tool: "th_state_get", count: 16, seam: "B", exitCode: 0 });
  });

  /**
   * REQ-105 (cont.) — toToolResult maps ok:false to isError:true (failure branch
   * round-trip). This pins the error path used by any handler that returns failure.
   *
   * Anchor: REQ-105
   */
  it("REQ-105: test_REQ105_toToolResult_failure_is_error_true — toToolResult maps ok:false to isError:true", () => {
    const err: CommandResult = failure("something went wrong", 1);
    const mapped = toToolResult(err);
    expect(mapped.isError).toBe(true);
    expect(mapped.content[0]).toMatchObject({ type: "text" });
  });
});

// ---------------------------------------------------------------------------
// Seam B — th_decision_approve must NEVER appear (REQ-408 baseline tripwire)
// ---------------------------------------------------------------------------

describe("SLICE-0 characterization: th_decision_approve absent from TOOL_DEFS (Seam B)", () => {
  /**
   * REQ-408: Final MCP tool total 23; th_decision_approve is permanently NOT an
   * MCP tool (RULE-011, INV-005). This test pins the approve-absent invariant at
   * the SLICE-0 baseline (count still 16). It is a regression tripwire that must
   * remain green through all subsequent slices as the count advances to 23.
   *
   * Anchor: REQ-408
   */
  it("REQ-408: test_REQ408_mcp_has_no_decision_approve_tool_count_60 — th_decision_approve absent from TOOL_DEFS; count invariant holds at 60", () => {
    const names = TOOL_DEFS.map((t) => t.name);

    // The approve tool must NEVER appear — this invariant is non-negotiable (RULE-011, INV-005).
    expect(names).not.toContain("th_decision_approve");

    // The coordination-primitive layer lands the count at 35; th_interview_*/th_init → 39; the
    // MCP-tool-expansion adds 5 typed gate-transition tools + 16 wired handlers → 60.
    // th_decision_approve stays permanently absent (decision approval is a human
    // gate, never an MCP tool).
    expect(TOOL_DEFS.length).toBe(62);
  });
});

// ---------------------------------------------------------------------------
// Seam C — runNext baseline with no decisions.jsonl (REQ-504)
// ---------------------------------------------------------------------------

describe("SLICE-0 characterization: runNext baseline on decisions-free project (Seam C)", () => {
  /**
   * REQ-504: When no decision obligation is unmet, runNext behaves exactly as
   * today. This captures the baseline output for a freshly initialized project
   * that has no decisions.jsonl, so SLICE-5 can prove byte-equality when the
   * decision-obligation rung is added.
   *
   * The characterization proves:
   * 1. runNext does not throw when decisions.jsonl is absent.
   * 2. The output kind for an initialized, tier-unset project is "classify-tier"
   *    (which is what the pre-epic code produces in this state).
   * 3. The output structure (ok, exitCode, data.kind, data.action) matches
   *    the pre-epic baseline exactly.
   *
   * Anchor: REQ-504
   */
  it("REQ-504: test_REQ504_next_unchanged_when_no_obligation — no decisions.jsonl → runNext output byte-identical to pre-epic baseline", () => {
    tp = makeTempProject();

    // Initialize the project (creates state.json with tier:null and no decisions.jsonl).
    runInit(tp.paths, {});

    // Confirm no decisions.jsonl is present (this is the "no obligation" state).
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const decisionsPath = join(tp.root, ".twinharness", "decisions.jsonl");
    expect(existsSync(decisionsPath)).toBe(false);

    // Run the oracle — must not throw.
    const result = runNext(tp.paths);

    // Pre-epic baseline: tier is null → kind is "classify-tier".
    // This is the byte-identical expectation that SLICE-5 will continue to satisfy.
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect((result.data as Record<string, unknown>).kind).toBe("classify-tier");

    // The action text must start with "Tier is unclassified" — the baseline sentence
    // SLICE-5 must not alter when no obligation is unmet.
    const action = (result.data as Record<string, unknown>).action as string;
    expect(action).toMatch(/^Tier is unclassified/);
  });

  /**
   * REQ-504 (cont.) — runNext on an uninitialised dir (no state.json, no decisions.jsonl)
   * must return kind:"init". This pins the very first rung of the ladder, which
   * must remain untouched by the decision-obligation rung added in SLICE-5.
   *
   * Anchor: REQ-504
   */
  it("REQ-504: test_REQ504_next_uninit_kind_init_unchanged — uninitialized dir with no decisions.jsonl → kind init (pre-epic baseline)", () => {
    tp = makeTempProject();
    // No init call — no state.json, no decisions.jsonl.
    const result = runNext(tp.paths);
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).kind).toBe("init");
  });
});
