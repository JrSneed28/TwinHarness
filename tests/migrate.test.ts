/**
 * `th migrate` + schema versioning (Phase 4) — REQ-anchored.
 */

import { describe, it, expect, afterEach } from "vitest";
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
