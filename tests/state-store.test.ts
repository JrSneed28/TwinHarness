import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { readState, writeState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-STATE-001: state round-trips through disk", () => {
  it("writeState then readState returns an equal, valid state", () => {
    tp = makeTempProject();
    const s = { ...initialState(), tier: "T2" as const, current_stage: "scope" };
    writeState(tp.paths, s);
    const r = readState(tp.paths);
    expect(r.exists).toBe(true);
    expect(r.state).toEqual(s);
  });

  it("reports missing state when none has been written", () => {
    tp = makeTempProject();
    expect(readState(tp.paths).exists).toBe(false);
  });

  it("reports issues for present-but-invalid JSON", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.agenticDir, { recursive: true });
    fs.writeFileSync(tp.paths.stateFile, "{ not json", "utf8");
    const r = readState(tp.paths);
    expect(r.exists).toBe(true);
    expect(r.state).toBeUndefined();
    expect(r.issues?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("REQ-STATE-002: idempotent write (replaced, not duplicated)", () => {
  it("rewriting replaces content and leaves no temp files", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), current_stage: "requirements" });
    writeState(tp.paths, { ...initialState(), current_stage: "scope" });
    const r = readState(tp.paths);
    expect(r.state?.current_stage).toBe("scope");
    const leftovers = fs.readdirSync(tp.paths.agenticDir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    expect(() => JSON.parse(fs.readFileSync(tp.paths.stateFile, "utf8"))).not.toThrow();
  });
});
