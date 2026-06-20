/**
 * Phase 5 / P5-2 — runtime tier-gate on advanced MCP tools (REQ-PCO-061, plan §B2).
 *
 * The advanced coordination tools (collab, debate, section leases, sub-leases)
 * STAY advertised in TOOL_DEFS — the count + name contracts are invariant — but
 * their `run` closure consults a RUNTIME gate. When the active tier does not enable
 * the feature, the tool returns a structured `tier_locked` failure (NOT a crash)
 * instead of executing; once the tier enables it, the tool runs normally.
 *
 * These tests are parity-COMPATIBLE: they never change the tool set, only assert
 * the gate's behavior. The count/name contract is re-pinned here so a regression in
 * either direction (a gated tool vanishing, or the count drifting) is caught.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, expectedToolDefsCount, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { TOOL_DEFS } from "../src/mcp-server";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/** The advanced tools the runtime gate covers, with a minimal valid arg set each. */
const GATED_TOOLS: ReadonlyArray<{ name: string; args: Record<string, unknown> }> = [
  // section-lease
  { name: "th_artifact_claim", args: { section: "docs/04-architecture.md#data-model", holder: "a" } },
  { name: "th_artifact_release", args: { section: "docs/04-architecture.md#data-model", holder: "a" } },
  { name: "th_artifact_leases", args: {} },
  // collab
  { name: "th_collab_init", args: { stage: "architecture" } },
  // Deferred #3: th_collab_fragment also carries the destructive-op ack gate (composed
  // FIRST). Pass confirm:true here so this suite exercises the TIER gate specifically.
  { name: "th_collab_fragment", args: { stage: "architecture", round: "r1", name: "a.md", text: "REQ-001 x", confirm: true } },
  { name: "th_collab_list", args: { stage: "architecture" } },
  { name: "th_collab_merge", args: { stage: "architecture", round: "r1" } },
  // debate
  { name: "th_debate_add", args: { topic: "t" } },
  { name: "th_debate_list", args: {} },
  { name: "th_debate_resolve", args: { id: "DEBATE-001" } },
  // sub-lease
  { name: "th_build_sub_claim", args: { parentSlice: "SLICE-P", components: "core" } },
  { name: "th_build_sub_release", args: { subId: "SLICE-P#sub-1" } },
];

function defFor(name: string) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  expect(def, `tool ${name} must be advertised`).toBeDefined();
  return def!;
}

describe("REQ-PCO-061: gated tools STAY advertised (parity contract preserved)", () => {
  it("REQ-PCO-061: TOOL_DEFS.length is still 62 (gating is runtime-only)", () => {
    expect(TOOL_DEFS.length).toBe(expectedToolDefsCount());
  });

  it("REQ-PCO-061: every gated tool name is still present in the registry", () => {
    const names = new Set(TOOL_DEFS.map((t) => t.name));
    for (const { name } of GATED_TOOLS) expect(names.has(name)).toBe(true);
  });

  it("REQ-PCO-061: the permanently-forbidden tool stays absent (RULE-011)", () => {
    expect(TOOL_DEFS.map((t) => t.name)).not.toContain("th_decision_approve");
  });
});

describe("REQ-PCO-061: locked tier → structured tier_locked refusal (never a crash)", () => {
  for (const { name, args } of GATED_TOOLS) {
    it(`REQ-PCO-061: ${name} returns tier_locked at T0 (no throw)`, () => {
      tp = makeTempProject();
      runInit(tp.paths, {});
      runStateSet(tp.paths, "tier", "T0", { emergency: true });
      const def = defFor(name);
      // Must NOT throw — a locked tool is a clean refusal.
      const res = def.run(tp.paths, args);
      expect(res.ok).toBe(false);
      expect(res.data?.error).toBe("tier_locked");
      expect(res.data?.feature).toBeTruthy();
      expect(String(res.human)).toContain("th tier");
    });
  }

  it("REQ-PCO-061: an uninitialized project (no state) reads as locked, not a crash", () => {
    tp = makeTempProject();
    const def = defFor("th_artifact_leases");
    const res = def.run(tp.paths, {});
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("tier_locked");
  });
});

describe("REQ-PCO-061: enabled tier → the gate is transparent (tool runs)", () => {
  it("REQ-PCO-061: at T2 the read-only gated tools execute (no tier_locked)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2", { emergency: true });
    for (const name of ["th_artifact_leases", "th_debate_list", "th_collab_list"]) {
      const args = GATED_TOOLS.find((g) => g.name === name)!.args;
      const res = defFor(name).run(tp.paths, args);
      // The underlying handler may succeed or fail on its own merits, but it must
      // NOT be the tier gate refusing — the feature is unlocked at T2.
      expect(res.data?.error).not.toBe("tier_locked");
    }
  });

  it("REQ-PCO-061: parallel authorship (>1 in-flight slice) unlocks the gate below T2", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T1", { emergency: true });
    runStateSet(
      tp.paths,
      "slices",
      JSON.stringify([
        { id: "SLICE-1", status: "in-progress", components: ["a"] },
        { id: "SLICE-2", status: "in-progress", components: ["b"] },
      ]),
    );
    const res = defFor("th_debate_list").run(tp.paths, {});
    expect(res.data?.error).not.toBe("tier_locked");
  });
});
