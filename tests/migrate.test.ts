/**
 * `th migrate` + schema versioning (Phase 4) — REQ-anchored.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runMigrate } from "../src/commands/migrate";
import { readState, writeState } from "../src/core/state-store";
import { CURRENT_SCHEMA_VERSION, type TwinHarnessState } from "../src/core/state-schema";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

describe("REQ-MIGRATE-001: schema version handling", () => {
  it("a freshly inited project is already at the current schema version", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(readState(tp.paths).state?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    const res = runMigrate(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.migrated).toBe(false);
  });

  it("stamps a legacy (unversioned) state file", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    // Simulate a legacy file: drop schema_version.
    const s = readState(tp.paths).state!;
    const legacy: TwinHarnessState = { ...s };
    delete legacy.schema_version;
    writeState(tp.paths, legacy);
    expect(readState(tp.paths).state?.schema_version).toBeUndefined();

    const res = runMigrate(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.migrated).toBe(true);
    expect(readState(tp.paths).state?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("refuses to downgrade a state written by a newer th", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const s = readState(tp.paths).state!;
    writeState(tp.paths, { ...s, schema_version: CURRENT_SCHEMA_VERSION + 5 });
    const res = runMigrate(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("schema_too_new");
  });

  it("fails cleanly on an uninitialized project", () => {
    tp = makeTempProject();
    const res = runMigrate(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("not_initialized");
  });
});

describe("REQ-MIGRATE-002: v1→v2 interview_threshold → interview_cutoff (confidence flip)", () => {
  it("migrates a legacy v1 state.json with interview_threshold to v2 with the INVERTED interview_cutoff (0.2 → 0.8)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});

    // Synthesize a legacy v1 on-disk state: no schema_version, and the OLD
    // interview_threshold key (0.2). Written directly with fs because the canonical
    // serializer no longer emits interview_threshold (it is no longer a known field).
    const s = readState(tp.paths).state!;
    const legacy: Record<string, unknown> = { ...s, interview_threshold: 0.2 };
    delete legacy.schema_version;
    delete (legacy as Record<string, unknown>).interview_cutoff;
    fs.writeFileSync(tp.paths.stateFile, JSON.stringify(legacy, null, 2) + "\n", "utf8");

    const res = runMigrate(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.migrated).toBe(true);
    expect(res.data?.from).toBe(1);
    expect(res.data?.to).toBe(2);

    const migrated = readState(tp.paths).state as (TwinHarnessState & { interview_threshold?: number; interview_cutoff?: number }) | undefined;
    expect(migrated?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
    // The flip preserves the gate: threshold 0.2 → cutoff 0.8 (1 − 0.2).
    expect(migrated?.interview_cutoff).toBeCloseTo(0.8, 10);
    // The legacy key is gone (renamed, not duplicated).
    expect(migrated?.interview_threshold).toBeUndefined();
    // And the persisted bytes no longer carry the legacy key.
    const onDisk = fs.readFileSync(tp.paths.stateFile, "utf8");
    expect(onDisk).not.toContain("interview_threshold");
    expect(onDisk).toContain("interview_cutoff");
  });

  it("a v1 state WITHOUT interview_threshold still steps cleanly to v2 (no cutoff introduced)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const s = readState(tp.paths).state!;
    const legacy: TwinHarnessState = { ...s };
    delete legacy.schema_version;
    writeState(tp.paths, legacy);

    const res = runMigrate(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.data?.migrated).toBe(true);
    const migrated = readState(tp.paths).state as (TwinHarnessState & { interview_cutoff?: number }) | undefined;
    expect(migrated?.schema_version).toBe(2);
    expect(migrated?.interview_cutoff).toBeUndefined();
  });
});
