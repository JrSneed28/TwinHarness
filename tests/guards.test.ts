import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { NOT_INIT, formatIssues, requireState } from "../src/core/guards";
import { runInit } from "../src/commands/init";
import { makeTempProject, type TempProject } from "./helpers";

/** Shared command guards extracted from ~8 command files (behavior-preserving). */

let tp: TempProject;
afterEach(() => tp?.cleanup());

describe("guards", () => {
  it("NOT_INIT is a stable not_initialized failure", () => {
    expect(NOT_INIT.ok).toBe(false);
    expect((NOT_INIT.data as any)?.error).toBe("not_initialized");
  });

  it("formatIssues renders issues, empty for none", () => {
    expect(formatIssues(undefined)).toBe("");
    expect(formatIssues([])).toBe("");
    expect(formatIssues([{ path: "tier", message: "bad" }])).toBe("  - tier: bad");
  });

  it("requireState returns NOT_INIT when no run exists", () => {
    tp = makeTempProject();
    const r = requireState(tp.paths);
    expect(r.state).toBeUndefined();
    expect(r.result).toBe(NOT_INIT);
  });

  it("requireState returns the validated state for a valid run", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const r = requireState(tp.paths);
    expect(r.result).toBeUndefined();
    expect(r.state).toBeTruthy();
    expect(r.state!.current_stage).toBeTruthy();
  });

  it("requireState returns an invalid_state failure for a corrupt state.json", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    fs.writeFileSync(path.join(tp.paths.stateDir, "state.json"), "{ not valid json", "utf8");
    const r = requireState(tp.paths);
    expect(r.state).toBeUndefined();
    expect(r.result?.ok).toBe(false);
    expect((r.result?.data as any)?.error).toBe("invalid_state");
  });
});
