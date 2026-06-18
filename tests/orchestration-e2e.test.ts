/**
 * Deterministic end-to-end orchestration test (G3).
 *
 * The CLI is well covered by unit tests, but nothing exercised a whole run
 * end-to-end. This drives a realistic sequence of `th` command functions —
 * init → tier → artifact → slices → build waves (with the write-gate firing) →
 * coverage → final-verification stop-gate — and asserts the mechanical invariants
 * at each step. It verifies ORCHESTRATION MECHANICS (state progression + gates),
 * not agent behaviour, so it needs no LLM and is fully deterministic.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runArtifactRegister } from "../src/commands/artifact";
import { runSlicesSync, runSliceSetStatus } from "../src/commands/slices";
import { runBuildNextWave, runBuildClaim, runBuildRelease } from "../src/commands/build";
import { runCoverageCheck } from "../src/commands/coverage";
import { evaluateStopGate, runHookPretoolGate, type PreToolHookInput } from "../src/commands/hook";
import { writeVerifyConfig, writeVerifyReport } from "../src/core/verify";
import { readState, writeState } from "../src/core/state-store";
import type { ProjectPaths } from "../src/core/paths";
import type { TwinHarnessState } from "../src/core/state-schema";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/**
 * Position gate-owned state (tier, current_stage, implementation_allowed, slices)
 * for the run. After the #11 demotion a raw `th state set` refuses gate-owned
 * fields, so this in-process e2e uses the ungated low-level positioning writer
 * directly (the stop-gate it exercises never consults the interview soft-gate).
 */
function position(paths: ProjectPaths, patch: Partial<TwinHarnessState>): void {
  writeState(paths, { ...readState(paths).state!, ...patch });
}

function writeFile(t: TempProject, rel: string, content: string): void {
  const abs = path.join(t.root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function writeInput(filePath: string, root: string): PreToolHookInput {
  return { tool_name: "Write", tool_input: { file_path: filePath }, cwd: root };
}
const decisionOf = (out: { stdout: string }): unknown =>
  (JSON.parse(out.stdout) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision;
const isAllow = (out: { stdout: string }): boolean => Object.keys(JSON.parse(out.stdout)).length === 0;

describe("REQ-E2E-001: a run advances init → build → coverage → final-verification", () => {
  it("drives the full mechanical chain and the stop-gate ladder", () => {
    tp = makeTempProject();
    const { paths, root } = tp;

    // 1. Init.
    runInit(paths, {});
    expect(readState(paths).state?.current_stage).toBe("init");

    // 2. Classify + record tier (Orchestrator's call; recorded mechanically).
    position(paths, { tier: "T2", current_stage: "requirements" });
    expect(readState(paths).state?.tier).toBe("T2");

    // 3. Requirements artifact → register (content-hashed, approved).
    writeFile(tp, "docs/01-requirements.md", "# Requirements\n\nREQ-001 the system shall foo.\nREQ-002 the system shall bar.\n");
    runArtifactRegister(paths, "docs/01-requirements.md", 1);
    expect(readState(paths).state?.approved_artifacts).toHaveLength(1);

    // 4. Slice plan → sync into state.slices (SLICE-1 depends on SLICE-0).
    writeFile(
      tp,
      "docs/09-implementation-plan.md",
      [
        "# Implementation Plan",
        "",
        "### SLICE-0",
        "Components touched: src/skeleton.ts",
        "Covers REQ-001.",
        "",
        "### SLICE-1",
        "Components touched: src/feature.ts",
        "Covers REQ-002.",
        "Depends on: SLICE-0",
        "",
      ].join("\n"),
    );
    runSlicesSync(paths, { planFile: "docs/09-implementation-plan.md" });
    expect(readState(paths).state?.slices.map((s) => s.id)).toEqual(["SLICE-0", "SLICE-1"]);

    // 5. Unlock implementation.
    position(paths, { implementation_allowed: true, current_stage: "implementation" });

    // 6. Build wave: SLICE-0 dispatches; SLICE-1 is held on its dependency.
    let wave = runBuildNextWave(paths).data?.wave as string[];
    expect(wave).toEqual(["SLICE-0"]);

    // Build SLICE-0: claim + in-progress, then a write into its component is allowed.
    runSliceSetStatus(paths, "SLICE-0", "in-progress");
    expect(runBuildClaim(paths, "SLICE-0").ok).toBe(true);
    expect(isAllow(runHookPretoolGate(paths, writeInput("src/skeleton.ts", root)))).toBe(true);
    writeFile(tp, "src/skeleton.ts", "// REQ-001 walking skeleton\nexport const ok = true;\n");
    runSliceSetStatus(paths, "SLICE-0", "done");
    runBuildRelease(paths, "SLICE-0");

    // 7. Next wave: SLICE-1 is now dispatchable (dependency done).
    wave = runBuildNextWave(paths).data?.wave as string[];
    expect(wave).toEqual(["SLICE-1"]);
    runSliceSetStatus(paths, "SLICE-1", "in-progress");
    runBuildClaim(paths, "SLICE-1");
    writeFile(tp, "src/feature.ts", "// REQ-002 feature\nexport const ok2 = true;\n");

    // 8. Tests carry the REQ anchors → coverage is clean.
    writeFile(tp, "tests/e2e-feature.test.ts", "// REQ-001 and REQ-002 are exercised here\n");
    const cov = runCoverageCheck(paths);
    expect(cov.data?.total).toBe(2);
    expect(cov.data?.covered).toBe(2);
    expect(cov.data?.gaps).toEqual([]);

    // 9. Final verification: stop-gate blocks while SLICE-1 is unfinished.
    position(paths, { current_stage: "final-verification" });
    expect(evaluateStopGate(paths).block).toBe(true);

    // Finish SLICE-1 → with no verify suite configured, the gate now allows.
    runSliceSetStatus(paths, "SLICE-1", "done");
    runBuildRelease(paths, "SLICE-1");
    expect(evaluateStopGate(paths).block).toBe(false);

    // 10. A configured-but-RED suite re-blocks; a green suite clears it.
    writeVerifyConfig(paths, { commands: ["run-the-tests"] });
    writeVerifyReport(paths, {
      ok: false,
      ranAt: new Date().toISOString(),
      results: [{ command: "run-the-tests", exitCode: 1, ok: false, durationMs: 5, outputTail: "boom" }],
    });
    expect(evaluateStopGate(paths).block).toBe(true);

    writeVerifyReport(paths, {
      ok: true,
      ranAt: new Date().toISOString(),
      results: [{ command: "run-the-tests", exitCode: 0, ok: true, durationMs: 5, outputTail: "ok" }],
    });
    const final = evaluateStopGate(paths);
    expect(final.block).toBe(false);
    expect(final.reasons).toEqual([]);
  });
});

describe("REQ-E2E-002: the write-gate enforces phase and component boundaries through a run", () => {
  it("Phase A blocks impl writes / allows docs; Phase B enforces slice ownership", () => {
    tp = makeTempProject();
    const { paths, root } = tp;
    runInit(paths, {});

    // Phase A (implementation_allowed=false): impl writes gate; docs/root-md allowed.
    position(paths, { current_stage: "architecture" });
    expect(decisionOf(runHookPretoolGate(paths, writeInput("src/app.ts", root)))).toBe("ask");
    expect(isAllow(runHookPretoolGate(paths, writeInput("docs/01-requirements.md", root)))).toBe(true);
    expect(isAllow(runHookPretoolGate(paths, writeInput("README.md", root)))).toBe(true);

    // Phase B: implementation allowed, slices own path-like components.
    position(paths, {
      implementation_allowed: true,
      current_stage: "implementation",
      slices: [
        { id: "SLICE-0", status: "in-progress", components: ["src/skeleton.ts"] },
        { id: "SLICE-1", status: "pending", components: ["src/feature.ts"] },
      ],
    });

    // In-progress slice's own path → allowed; another slice's path → component-boundary ask.
    expect(isAllow(runHookPretoolGate(paths, writeInput("src/skeleton.ts", root)))).toBe(true);
    expect(decisionOf(runHookPretoolGate(paths, writeInput("src/feature.ts", root)))).toBe("ask");
    // An unowned, brand-new path is allowed (new files appear constantly during a build).
    expect(isAllow(runHookPretoolGate(paths, writeInput("src/brand-new.ts", root)))).toBe(true);
  });
});
