/**
 * atomic-io-consumers: regression guard for the two write sites that now route
 * through `atomicWriteFile` (C-2 tail — S-C).
 *
 * Asserts:
 *   (a) `th repo map --write` writes a valid repo-map.json artifact and is
 *       byte-identical across two back-to-back runs (REQ-NFR-001 determinism).
 *   (b) `writeTelemetryConfig` writes a valid telemetry.json artifact and is
 *       byte-identical across two back-to-back runs (REQ-NFR-001 determinism).
 *
 * Call patterns mirror tests/repo.test.ts and tests/telemetry.test.ts — no new
 * test infrastructure; just `makeTempProject` + the exported command functions.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runRepoMap } from "../src/commands/repo";
import {
  writeTelemetryConfig,
  readTelemetryConfig,
  telemetryConfigPath,
} from "../src/core/telemetry";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

// ---------------------------------------------------------------------------
// repo map --write (via atomicWriteFile, S-C)
// ---------------------------------------------------------------------------

describe("S-C consumer: th repo map --write artifact", () => {
  it("write mode produces a valid repo-map.json with a schema_version field", () => {
    tp = makeTempProject();
    const result = runRepoMap(tp.paths, { write: true });
    expect(result.ok).toBe(true);

    const jsonPath = path.join(tp.paths.stateDir, "repo-map.json");
    expect(fs.existsSync(jsonPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
    // schema_version may be a string or number — just verify it exists.
    expect(parsed["schema_version"]).toBeDefined();
  });

  it("REQ-NFR-001: two back-to-back write runs are byte-identical (stable state)", () => {
    tp = makeTempProject();

    // Run 1: may create docs/ which changes docs_roots on the next scan.
    runRepoMap(tp.paths, { write: true });

    // Run 2: state has stabilised (docs/ already exists from run 1).
    runRepoMap(tp.paths, { write: true });
    const jsonPath = path.join(tp.paths.stateDir, "repo-map.json");
    const second = fs.readFileSync(jsonPath, "utf8");

    // Run 3: must be byte-identical to run 2 (same inputs → same output).
    runRepoMap(tp.paths, { write: true });
    const third = fs.readFileSync(jsonPath, "utf8");

    expect(third).toBe(second);
  });

  it("--no-write does not create repo-map.json", () => {
    tp = makeTempProject();
    const result = runRepoMap(tp.paths, { write: false });
    expect(result.ok).toBe(true);

    const jsonPath = path.join(tp.paths.stateDir, "repo-map.json");
    expect(fs.existsSync(jsonPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeTelemetryConfig (via atomicWriteFile, S-C)
// ---------------------------------------------------------------------------

describe("S-C consumer: writeTelemetryConfig artifact", () => {
  it("writes a valid telemetry.json with the correct enabled flag", () => {
    tp = makeTempProject();
    writeTelemetryConfig(tp.paths, { enabled: true });

    const cfgPath = telemetryConfigPath(tp.paths);
    expect(fs.existsSync(cfgPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    expect(parsed["enabled"]).toBe(true);
  });

  it("REQ-NFR-001: two back-to-back writes are byte-identical", () => {
    tp = makeTempProject();

    writeTelemetryConfig(tp.paths, { enabled: true });
    const cfgPath = telemetryConfigPath(tp.paths);
    const first = fs.readFileSync(cfgPath, "utf8");

    writeTelemetryConfig(tp.paths, { enabled: true });
    const second = fs.readFileSync(cfgPath, "utf8");

    expect(second).toBe(first);
  });

  it("read-back matches the written config (enabled → disabled round-trip)", () => {
    tp = makeTempProject();

    writeTelemetryConfig(tp.paths, { enabled: true });
    expect(readTelemetryConfig(tp.paths).enabled).toBe(true);

    writeTelemetryConfig(tp.paths, { enabled: false });
    expect(readTelemetryConfig(tp.paths).enabled).toBe(false);
  });

  it("creates parent stateDir if it does not exist yet", () => {
    tp = makeTempProject();
    // stateDir is not yet created (makeTempProject only creates root)
    expect(fs.existsSync(tp.paths.stateDir)).toBe(false);

    writeTelemetryConfig(tp.paths, { enabled: false });
    expect(fs.existsSync(telemetryConfigPath(tp.paths))).toBe(true);
  });
});
