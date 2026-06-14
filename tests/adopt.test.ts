import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { readState } from "../src/core/state-store";

/**
 * G5 — brownfield / existing-codebase adoption.
 *
 * `th init --brownfield` records `project_mode: "brownfield"` so downstream
 * stages adopt the existing-codebase variants. The default `th init` must stay
 * byte-identical to a pre-G5 init: `project_mode` is left undefined and never
 * serialized (preserving state-file content-hash stability, §18).
 */

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-BROWNFIELD-001: th init --brownfield records project_mode", () => {
  it("REQ-BROWNFIELD-001: init --brownfield records project_mode", () => {
    tp = makeTempProject();
    const res = runInit(tp.paths, { brownfield: true });
    expect(res.ok).toBe(true);

    const r = readState(tp.paths);
    expect(r.exists).toBe(true);
    expect(r.state?.project_mode).toBe("brownfield");
  });

  it("REQ-BROWNFIELD-001: --brownfield surfaces project_mode in the result data + human output", () => {
    tp = makeTempProject();
    const res = runInit(tp.paths, { brownfield: true });
    expect(res.data?.project_mode).toBe("brownfield");
    expect(res.human).toContain("brownfield");
  });
});

describe("REQ-BROWNFIELD-002: greenfield init leaves project_mode undefined", () => {
  it("REQ-BROWNFIELD-002: plain init leaves project_mode undefined (read back via readState)", () => {
    tp = makeTempProject();
    const res = runInit(tp.paths, {});
    expect(res.ok).toBe(true);

    const r = readState(tp.paths);
    expect(r.exists).toBe(true);
    expect(r.state?.project_mode).toBeUndefined();
    expect(res.data?.project_mode).toBeUndefined();
  });

  it("REQ-BROWNFIELD-002: greenfield state serializes WITHOUT a project_mode key", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    // The raw on-disk JSON must not even mention the field, so a pre-G5 state
    // file hashes byte-identically (§18 content-hash stability).
    const raw = fs.readFileSync(tp.paths.stateFile, "utf8");
    expect(raw).not.toContain("project_mode");
    expect(JSON.parse(raw)).not.toHaveProperty("project_mode");
  });
});

describe("REQ-BROWNFIELD-003: brownfield mode survives a re-read and stays valid", () => {
  it("REQ-BROWNFIELD-003: brownfield state validates and persists project_mode on disk", () => {
    tp = makeTempProject();
    runInit(tp.paths, { brownfield: true });

    const raw = fs.readFileSync(tp.paths.stateFile, "utf8");
    expect(JSON.parse(raw).project_mode).toBe("brownfield");

    // readState validates the schema; a present-but-valid project_mode must not
    // produce validation issues.
    const r = readState(tp.paths);
    expect(r.issues).toBeUndefined();
    expect(r.state?.project_mode).toBe("brownfield");
  });
});
