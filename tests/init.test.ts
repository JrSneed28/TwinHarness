import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState } from "../src/core/state-store";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-INIT-001: th init scaffolds the project (§3, §12)", () => {
  it("creates docs/, .agentic-sdlc/state.json (valid), and drift-log.md", () => {
    tp = makeTempProject();
    const res = runInit(tp.paths, {});
    expect(res.ok).toBe(true);
    expect(fs.existsSync(tp.paths.docsDir)).toBe(true);
    expect(fs.existsSync(tp.paths.driftLog)).toBe(true);
    const r = readState(tp.paths);
    expect(r.exists).toBe(true);
    expect(r.state?.current_stage).toBe("init");
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
