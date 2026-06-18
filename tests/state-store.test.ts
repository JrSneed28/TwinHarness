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
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(tp.paths.stateFile, "{ not json", "utf8");
    const r = readState(tp.paths);
    expect(r.exists).toBe(true);
    expect(r.state).toBeUndefined();
    expect(r.issues?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("REQ-STATE-003: legacy interview_threshold self-heals on read (pre-migrate write window)", () => {
  // Guards the review MINOR: before `th migrate` stamps v2, a mutating read-write
  // must NOT silently drop a custom interview_threshold via serializeState (which
  // omits the now-unknown key). readState carries it forward, inverted, as
  // interview_cutoff (= 1 − threshold), mirroring the v1→v2 migration.
  function writeLegacy(tp: TempProject, threshold: number): void {
    writeState(tp.paths, initialState());
    const obj = JSON.parse(fs.readFileSync(tp.paths.stateFile, "utf8")) as Record<string, unknown>;
    delete obj.schema_version;
    obj.interview_threshold = threshold;
    fs.writeFileSync(tp.paths.stateFile, JSON.stringify(obj), "utf8");
  }

  it("inverts a custom legacy threshold to interview_cutoff and drops the old key", () => {
    tp = makeTempProject();
    writeLegacy(tp, 0.3);
    const r = readState(tp.paths);
    expect(r.state?.interview_cutoff).toBeCloseTo(0.7, 10);
    expect((r.state as Record<string, unknown> | undefined)?.interview_threshold).toBeUndefined();
  });

  it("persists the inverted cutoff when the healed state is written before migrate", () => {
    tp = makeTempProject();
    writeLegacy(tp, 0.2);
    // Simulate a mutating command: read (heals), then write back.
    const healed = readState(tp.paths).state!;
    writeState(tp.paths, healed);
    const onDisk = JSON.parse(fs.readFileSync(tp.paths.stateFile, "utf8")) as Record<string, unknown>;
    expect(onDisk.interview_cutoff).toBeCloseTo(0.8, 10);
    expect(onDisk.interview_threshold).toBeUndefined();
  });
});

describe("REQ-STATE-002: idempotent write (replaced, not duplicated)", () => {
  it("rewriting replaces content and leaves no temp files", () => {
    tp = makeTempProject();
    writeState(tp.paths, { ...initialState(), current_stage: "requirements" });
    writeState(tp.paths, { ...initialState(), current_stage: "scope" });
    const r = readState(tp.paths);
    expect(r.state?.current_stage).toBe("scope");
    const leftovers = fs.readdirSync(tp.paths.stateDir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    expect(() => JSON.parse(fs.readFileSync(tp.paths.stateFile, "utf8"))).not.toThrow();
  });
});
