/**
 * `readVerifyReportValidated` classification (R-30, F2) — the BOUND verify-report
 * reader the completion gate consumes instead of the bare `readVerifyReport`.
 *
 * Classifies a report as absent | corrupt | legacy | stale | valid. The completion
 * gate accepts ONLY `valid`; this pins each classification independently.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import {
  readVerifyReportValidated,
  currentVerifyBinding,
  verifyReportPath,
  writeVerifyConfig,
  VERIFY_REPORT_SCHEMA_VERSION,
  type VerifyReportEnvelope,
} from "../src/core/verify";
import type { ProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

function project(): ProjectPaths {
  tp = makeTempProject();
  fs.mkdirSync(tp.paths.stateDir, { recursive: true });
  return tp.paths;
}
function writeRaw(paths: ProjectPaths, body: string): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(verifyReportPath(paths), body, "utf8");
}
/** Build a CURRENT-binding envelope (valid) for `commands`. */
function currentEnvelope(paths: ProjectPaths, commands: string[], ok = true): VerifyReportEnvelope {
  const b = currentVerifyBinding(paths, commands);
  return {
    ok,
    ranAt: new Date().toISOString(),
    results: [],
    schemaVersion: VERIFY_REPORT_SCHEMA_VERSION,
    commandSetHash: b.commandSetHash,
    configLockDigest: b.configLockDigest,
    gitHead: b.gitHead,
    dirtyTreeDigest: b.dirtyTreeDigest,
  };
}

describe("readVerifyReportValidated — classification", () => {
  it("absent: no report file → absent", () => {
    const paths = project();
    expect(readVerifyReportValidated(paths).status).toBe("absent");
  });

  it("corrupt: unparseable bytes → corrupt", () => {
    const paths = project();
    writeRaw(paths, "{ not json");
    expect(readVerifyReportValidated(paths).status).toBe("corrupt");
  });

  it("corrupt: wrong shape (no ok boolean) → corrupt", () => {
    const paths = project();
    writeRaw(paths, JSON.stringify({ results: [] }));
    expect(readVerifyReportValidated(paths).status).toBe("corrupt");
  });

  it("legacy: a bare `{\"ok\":true}` report (no schemaVersion) → legacy (rejected)", () => {
    const paths = project();
    writeRaw(paths, JSON.stringify({ ok: true, ranAt: "2026-06-13T00:00:00.000Z", results: [] }));
    expect(readVerifyReportValidated(paths).status).toBe("legacy");
  });

  it("legacy: an OLDER schemaVersion is rejected as legacy", () => {
    const paths = project();
    writeRaw(
      paths,
      JSON.stringify({ ok: true, ranAt: "x", results: [], schemaVersion: 1, commandSetHash: "a", configLockDigest: "b" }),
    );
    expect(readVerifyReportValidated(paths).status).toBe("legacy");
  });

  it("valid: a current-binding envelope (no commands) → valid", () => {
    const paths = project();
    writeRaw(paths, JSON.stringify(currentEnvelope(paths, [])));
    expect(readVerifyReportValidated(paths).status).toBe("valid");
  });

  it("stale: a command-set mismatch → stale (a `verify add` changed the set after the run)", () => {
    const paths = project();
    // Seal an envelope for the EMPTY command set, then change the config.
    writeRaw(paths, JSON.stringify(currentEnvelope(paths, [])));
    writeVerifyConfig(paths, { commands: ["npm test"] });
    const v = readVerifyReportValidated(paths);
    expect(v.status).toBe("stale");
    expect(v.staleReasons).toContain("commandSetHash");
  });

  it("stale: a report copied from another revision (gitHead/dirtyTree mismatch) → stale", () => {
    const paths = project();
    // Forge an envelope whose git coordinates are NON-null but differ from this checkout
    // (simulating a report copied from another project/revision). The current binding's
    // git coordinates are non-null in this repo, so they discriminate.
    const b = currentVerifyBinding(paths, []);
    // Only assert the copied-revision path when this checkout HAS a git identity (CI/dev
    // both do); on a non-git sandbox the coordinate is non-discriminating by design.
    if (b.gitHead !== null) {
      const env = currentEnvelope(paths, []);
      env.gitHead = "0000000000000000000000000000000000000000"; // a different commit
      writeRaw(paths, JSON.stringify(env));
      const v = readVerifyReportValidated(paths);
      expect(v.status).toBe("stale");
      expect(v.staleReasons).toContain("gitHead");
    }
  });

  it("stale: a config-lock (approval-ledger) mismatch → stale", () => {
    const paths = project();
    const env = currentEnvelope(paths, []);
    env.configLockDigest = "f".repeat(64); // a digest that does not match the current tail
    writeRaw(paths, JSON.stringify(env));
    const v = readVerifyReportValidated(paths);
    expect(v.status).toBe("stale");
    expect(v.staleReasons).toContain("configLockDigest");
  });
});
