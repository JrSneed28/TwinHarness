/**
 * SG3 P1-C (C-14) — the tier gate now lives INSIDE the shared CLI handlers, not
 * only on the MCP runtime path. Before this fix `assertTierAllows` existed only in
 * mcp-server.ts and `featureActiveForState` was called by NO CLI handler, so a
 * direct `th collab|debate|artifact|build sub-*` invocation bypassed the tier gate
 * entirely — a fail-open seam between the two surfaces.
 *
 * Both surfaces now call the SAME `assertFeatureUnlocked` (commands/tier.ts), so a
 * locked-tier refusal MUST be byte-for-byte identical no matter which surface the
 * call entered through. This suite pins that identity per feature
 * (collab / debate / section-lease / sub-lease): for each, the CLI shared handler's
 * refusal `CommandResult` is deep-equal to the MCP tool's refusal `CommandResult`.
 * If the two ever drift (e.g. a new CLI handler forgets the gate, or one surface's
 * refusal shape changes), this fails.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import type { CommandResult } from "../src/core/output";
import type { ProjectPaths } from "../src/core/paths";
import { TOOL_DEFS } from "../src/mcp-server";
import { runCollabInit, runCollabFragment, runCollabList, runCollabMerge } from "../src/commands/collab";
import { runDebateAdd, runDebateList, runDebateResolve } from "../src/commands/debate";
import { runArtifactClaim, runArtifactRelease, runArtifactLeases } from "../src/commands/artifact-lease";
import { runBuildSubClaim, runBuildSubRelease } from "../src/commands/build";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/**
 * Each gated capability paired both ways: the CLI shared handler call and the MCP
 * tool (name + args). On a locked tier BOTH must refuse with the SAME result.
 *
 * Note on `th_collab_fragment`: the MCP twin composes the destructive-op ack gate
 * FIRST, so we pass `confirm:true` to reach the TIER gate (the CLI handler has no
 * ack gate). The tier refusal it then returns must equal the CLI handler's.
 */
const CASES: ReadonlyArray<{
  feature: string;
  cli: (paths: ProjectPaths) => CommandResult;
  tool: string;
  toolArgs: Record<string, unknown>;
}> = [
  // collab
  { feature: "collab", cli: (p) => runCollabInit(p, { stage: "architecture" }), tool: "th_collab_init", toolArgs: { stage: "architecture" } },
  {
    feature: "collab",
    cli: (p) => runCollabFragment(p, { stage: "architecture", round: "r1", name: "a.md", text: "REQ-001 x" }),
    tool: "th_collab_fragment",
    toolArgs: { stage: "architecture", round: "r1", name: "a.md", text: "REQ-001 x", confirm: true },
  },
  { feature: "collab", cli: (p) => runCollabList(p, { stage: "architecture" }), tool: "th_collab_list", toolArgs: { stage: "architecture" } },
  { feature: "collab", cli: (p) => runCollabMerge(p, { stage: "architecture", round: "r1" }), tool: "th_collab_merge", toolArgs: { stage: "architecture", round: "r1" } },
  // debate
  { feature: "debate", cli: (p) => runDebateAdd(p, { topic: "t" }), tool: "th_debate_add", toolArgs: { topic: "t" } },
  { feature: "debate", cli: (p) => runDebateList(p), tool: "th_debate_list", toolArgs: {} },
  { feature: "debate", cli: (p) => runDebateResolve(p, { id: "DEBATE-001" }), tool: "th_debate_resolve", toolArgs: { id: "DEBATE-001" } },
  // section-lease
  { feature: "section-lease", cli: (p) => runArtifactClaim(p, { section: "docs/04-architecture.md#data-model", holder: "a" }), tool: "th_artifact_claim", toolArgs: { section: "docs/04-architecture.md#data-model", holder: "a" } },
  { feature: "section-lease", cli: (p) => runArtifactRelease(p, { section: "docs/04-architecture.md#data-model", holder: "a" }), tool: "th_artifact_release", toolArgs: { section: "docs/04-architecture.md#data-model", holder: "a" } },
  { feature: "section-lease", cli: (p) => runArtifactLeases(p), tool: "th_artifact_leases", toolArgs: {} },
  // sub-lease
  { feature: "sub-lease", cli: (p) => runBuildSubClaim(p, "SLICE-P", ["core"]), tool: "th_build_sub_claim", toolArgs: { parentSlice: "SLICE-P", components: "core" } },
  { feature: "sub-lease", cli: (p) => runBuildSubRelease(p, "SLICE-P#sub-1"), tool: "th_build_sub_release", toolArgs: { subId: "SLICE-P#sub-1" } },
];

function defFor(name: string) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  expect(def, `tool ${name} must be advertised`).toBeDefined();
  return def!;
}

describe("SG3 P1-C: CLI shared handlers enforce the tier gate (no fail-open seam)", () => {
  for (const { feature, cli } of CASES) {
    it(`${feature}: CLI handler refuses with tier_locked at T0 (was ungated before the fix)`, () => {
      tp = makeTempProject();
      runInit(tp.paths, {});
      runStateSet(tp.paths, "tier", "T0", { emergency: true });
      const res = cli(tp.paths);
      expect(res.ok).toBe(false);
      expect(res.data?.error).toBe("tier_locked");
      expect(res.data?.feature).toBe(feature);
      expect(String(res.human)).toContain("th tier");
    });
  }

  it("an uninitialized project (no state) reads as locked via the CLI handler too", () => {
    tp = makeTempProject();
    const res = runArtifactLeases(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("tier_locked");
  });
});

describe("SG3 P1-C: CLI refusal === MCP refusal, byte-for-byte (single shared gate)", () => {
  for (const { feature, cli, tool, toolArgs } of CASES) {
    it(`${feature}: ${tool} and its CLI twin return an identical tier_locked CommandResult`, () => {
      tp = makeTempProject();
      runInit(tp.paths, {});
      runStateSet(tp.paths, "tier", "T0", { emergency: true });

      const cliRes = cli(tp.paths);
      const mcpRes = defFor(tool).run(tp.paths, toolArgs);

      // Both refuse via the tier gate (the MCP ack gate, where present, is satisfied
      // by confirm:true so the tier refusal is what we compare).
      expect(cliRes.data?.error).toBe("tier_locked");
      expect(mcpRes.data?.error).toBe("tier_locked");

      // The whole CommandResult must match — ok, data (error/feature/tier), human.
      expect(cliRes).toEqual(mcpRes);
    });
  }
});

describe("SG3 P1-C: enabling the tier makes the CLI gate transparent (no capability loss)", () => {
  it("at T2 the read-only gated CLI handlers run (no tier_locked)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "tier", "T2", { emergency: true });
    expect(runArtifactLeases(tp.paths).data?.error).not.toBe("tier_locked");
    expect(runDebateList(tp.paths).data?.error).not.toBe("tier_locked");
    expect(runCollabList(tp.paths, { stage: "architecture" }).data?.error).not.toBe("tier_locked");
  });

  it("parallel authorship (>1 in-flight slice) unlocks the CLI gate below T2", () => {
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
    expect(runDebateList(tp.paths).data?.error).not.toBe("tier_locked");
    expect(runCollabList(tp.paths, { stage: "architecture" }).data?.error).not.toBe("tier_locked");
  });
});
