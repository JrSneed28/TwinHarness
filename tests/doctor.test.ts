/**
 * `th doctor` — self-diagnostic (Phase 3) — REQ-anchored.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runStateSet } from "../src/commands/state";
import { runMigrate } from "../src/commands/migrate";
import { readState, writeState } from "../src/core/state-store";
import { runDoctor } from "../src/commands/doctor";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}
const checks = (data: unknown): Check[] => (data as { checks: Check[] }).checks;
const byName = (data: unknown, name: string): Check | undefined => checks(data).find((c) => c.name === name);

describe("REQ-DOCTOR-001: environment + project health", () => {
  it("reports node ok and 'no run' on an uninitialized dir", () => {
    tp = makeTempProject();
    const res = runDoctor(tp.paths);
    expect(res.ok).toBe(true);
    expect(byName(res.data, "node")?.status).toBe("ok");
    expect(byName(res.data, "project")?.detail).toMatch(/no TwinHarness run/);
  });

  it("reports a healthy initialized project at the current schema", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runDoctor(tp.paths);
    expect(res.ok).toBe(true);
    expect(byName(res.data, "state.json")?.status).toBe("ok");
    expect(byName(res.data, "schema")?.status).toBe("ok");
  });

  it("warns when state is legacy (unversioned)", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const s = readState(tp.paths).state!;
    const legacy = { ...s };
    delete legacy.schema_version;
    writeState(tp.paths, legacy);
    const res = runDoctor(tp.paths);
    expect(byName(res.data, "schema")?.status).toBe("warn");
    // ...and migrate clears the warning.
    runMigrate(tp.paths);
    expect(byName(runDoctor(tp.paths).data, "schema")?.status).toBe("ok");
  });

  it("warns on open blocking drift", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runStateSet(tp.paths, "drift_open_blocking", "2");
    const res = runDoctor(tp.paths);
    expect(byName(res.data, "blocking drift")?.status).toBe("warn");
  });

  it("fails (non-zero) on an invalid state.json", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    fs.writeFileSync(tp.paths.stateFile, "{ not valid json");
    const res = runDoctor(tp.paths);
    expect(res.ok).toBe(false);
    expect(byName(res.data, "state.json")?.status).toBe("fail");
  });
});
