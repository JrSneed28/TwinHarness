/**
 * Scenario isolation (plan Step 1 / AC #16 / §11 — C2).
 *
 * `startScenario` must scaffold its sandbox in an OS temp root OUTSIDE any ancestor
 * `.twinharness`, so a live run's MCP/CLI writes resolve to the scenario root and
 * NEVER climb up into — and corrupt — the developer's real state. These tests assert
 * the resolved state file lives inside the temp root and that a real write through the
 * scenario does not touch a repo-level state file.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProjectPaths } from "../src/core/paths";
import { runDriftAdd } from "../src/commands/drift";
import { startScenario, finishScenario, listScenarios } from "../src/core/proof/scenario";
import type { SampleBrief } from "../src/core/proof/types";

const GREENFIELD: SampleBrief = {
  id: "tiny-cli-greenfield",
  size: "tiny",
  domain: "cli",
  tierHint: "T1",
  type: "greenfield",
  acceptanceCriteria: [],
};

const REPO_ROOT = path.resolve(__dirname, "..");

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const root = created.pop()!;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("startScenario isolation (C2)", () => {
  it("creates a root OUTSIDE any ancestor .twinharness; state resolves inside the temp root", () => {
    const { scenarioRoot, scenarioPaths } = startScenario(GREENFIELD);
    created.push(scenarioRoot);

    // The temp root is its OWN project root (resolveProjectPaths did not climb up).
    expect(path.resolve(scenarioPaths.root)).toBe(path.resolve(scenarioRoot));

    // The state file lives inside the temp root.
    const rel = path.relative(scenarioRoot, scenarioPaths.stateFile);
    expect(rel.startsWith("..")).toBe(false);
    expect(path.isAbsolute(rel)).toBe(false);
    expect(fs.existsSync(scenarioPaths.stateFile)).toBe(true);

    // No ANCESTOR directory above the temp root carries a `.twinharness`/`.agentic-sdlc`
    // that hijacked resolution (walk up from the parent to the filesystem root).
    let cursor = path.dirname(path.resolve(scenarioRoot));
    for (;;) {
      expect(fs.existsSync(path.join(cursor, ".twinharness"))).toBe(false);
      expect(fs.existsSync(path.join(cursor, ".agentic-sdlc", "state.json"))).toBe(false);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  });

  it("a write through the scenario does not touch a repo-level state file", () => {
    // Capture the repo's real state file (if any) BEFORE running a scenario write.
    const repoPaths = resolveProjectPaths(REPO_ROOT);
    const before = fs.existsSync(repoPaths.stateFile)
      ? fs.readFileSync(repoPaths.stateFile, "utf8")
      : null;

    const { scenarioRoot, scenarioPaths } = startScenario(GREENFIELD);
    created.push(scenarioRoot);

    // A real gate-mutating write through the scenario paths.
    const res = runDriftAdd(scenarioPaths, {
      layer: "requirement",
      ref: "SLICE-1",
      discovery: "isolated write",
      action: "build paused",
    });
    expect(res.ok).toBe(true);

    // The write landed in the SCENARIO, not the repo.
    expect(fs.existsSync(path.join(scenarioPaths.stateDir, "gate-ledger.jsonl"))).toBe(true);

    // The repo-level state file is byte-for-byte unchanged (or still absent).
    const after = fs.existsSync(repoPaths.stateFile)
      ? fs.readFileSync(repoPaths.stateFile, "utf8")
      : null;
    expect(after).toBe(before);

    // The repo did not gain a sibling proof-calls/gate-ledger from this scenario.
    expect(repoPaths.root).not.toBe(scenarioPaths.root);
  });

  it("tracks the scenario via the marker (listScenarios + finishScenario)", () => {
    const { scenarioRoot, scenarioPaths } = startScenario(GREENFIELD);
    created.push(scenarioRoot);

    const id = path.basename(scenarioRoot);
    expect(listScenarios().some((s) => s.id === id && s.status === "prepared")).toBe(true);

    const finished = finishScenario(scenarioPaths);
    expect(finished.id).toBe(id);
    expect(finished.status).toBe("finished");
    expect(listScenarios().some((s) => s.id === id && s.status === "finished")).toBe(true);
  });
});
