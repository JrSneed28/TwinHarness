import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState } from "../src/core/state-store";
import { resolveProjectPaths } from "../src/core/paths";
// readState imported directly above — alias for clarity inside legacy test.
const readStateAlias = readState;

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-INIT-001: th init scaffolds the project (§3, §12)", () => {
  it("creates docs/, .twinharness/state.json (valid), and drift-log.md", () => {
    tp = makeTempProject();
    const res = runInit(tp.paths, {});
    expect(res.ok).toBe(true);
    expect(fs.existsSync(tp.paths.docsDir)).toBe(true);
    expect(fs.existsSync(tp.paths.driftLog)).toBe(true);
    const r = readState(tp.paths);
    expect(r.exists).toBe(true);
    expect(r.state?.current_stage).toBe("init");
  });

  it("a fresh project gets .twinharness as the state dir", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(tp.paths.stateDir).toContain(".twinharness");
    expect(tp.paths.stateFile).toContain(".twinharness");
    expect(fs.existsSync(tp.paths.stateFile)).toBe(true);
  });

  it("is idempotent: a second run without --force preserves existing state", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const before = readState(tp.paths).state!;
    fs.writeFileSync(tp.paths.stateFile, JSON.stringify({ ...before, current_stage: "scope" }, null, 2), "utf8");
    expect(runInit(tp.paths, {}).ok).toBe(true);
    expect(readState(tp.paths).state?.current_stage).toBe("scope");
  });

  it("--force resets state to initial", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const before = readState(tp.paths).state!;
    fs.writeFileSync(tp.paths.stateFile, JSON.stringify({ ...before, current_stage: "scope" }, null, 2), "utf8");
    runInit(tp.paths, { force: true });
    expect(readState(tp.paths).state?.current_stage).toBe("init");
  });
});

describe("REQ-INIT-002: legacy .agentic-sdlc fallback (backward compatibility)", () => {
  it("resolveProjectPaths uses .agentic-sdlc when that dir has state.json and .twinharness absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-legacy-test-"));
    try {
      // Create the legacy directory with a state.json (minimal valid content).
      const legacyDir = path.join(root, ".agentic-sdlc");
      fs.mkdirSync(legacyDir, { recursive: true });
      const state = {
        tier: null,
        complexity_rationale: "",
        blast_radius_flags: [],
        current_stage: "scope",
        approved_artifacts: [],
        summaries_index: "00-project-summary.md",
        slices: [],
        implementation_allowed: false,
        open_questions: [],
        drift_open_blocking: 0,
        revise_loop_counts: {},
      };
      fs.writeFileSync(path.join(legacyDir, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");

      const paths = resolveProjectPaths(root);
      expect(paths.stateDir).toContain(".agentic-sdlc");
      expect(paths.stateFile).toContain(".agentic-sdlc");

      // readState via the legacy paths should return the state we wrote.
      const r = readStateAlias(paths);
      expect(r.exists).toBe(true);
      expect(r.state?.current_stage).toBe("scope");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveProjectPaths prefers .twinharness over .agentic-sdlc when both exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-both-test-"));
    try {
      // Create both dirs.
      const legacyDir = path.join(root, ".agentic-sdlc");
      const newDir = path.join(root, ".twinharness");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.mkdirSync(newDir, { recursive: true });

      const paths = resolveProjectPaths(root);
      expect(paths.stateDir).toContain(".twinharness");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
