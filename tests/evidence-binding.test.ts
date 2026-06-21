/**
 * F2 (R-30) verify-report binding + F8 (R-31) Tester-record binding + the
 * evidence-anchor write deny across BOTH Bash and Write/Edit (R-29).
 *
 * These are RED against HEAD: HEAD's verify report was an unbound `VerifyReport` the
 * gate trusted on `ok` alone; HEAD's Tester record counted on driver-presence alone;
 * and HEAD's write-gate anchored only verify.json / verify-approvals.jsonl (not the
 * report or the Tester record). Here a legacy/stale/copied/driver-only/unbound piece
 * of evidence is rejected, and a tool-mediated write to any evidence anchor is denied.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { writeState, readState } from "../src/core/state-store";
import { initialState } from "../src/core/state-schema";
import { runInit } from "../src/commands/init";
import {
  runVerifyAdd,
  runVerifyApprove,
  runVerifyClear,
  runVerifyRun,
} from "../src/commands/verify";
import { runTesterRecord } from "../src/commands/tester";
import {
  readVerifyReportValidated,
  verifyReportPath,
  writeVerifyReportEnvelope,
  currentVerifyBinding,
  type VerifyReport,
} from "../src/core/verify";
import { readTesterRecordValidated, testerRecordPath, testerRecordPresent } from "../src/core/tester";
import { runHookPretoolGate, type PreToolHookInput } from "../src/commands/hook";
import type { ProjectPaths } from "../src/core/paths";

let tp: TempProject | undefined;
afterEach(() => {
  tp?.cleanup();
  tp = undefined;
});

function parseOut(out: { stdout: string }): Record<string, unknown> {
  return JSON.parse(out.stdout) as Record<string, unknown>;
}
function permissionDecision(out: { stdout: string }): string | undefined {
  const hso = parseOut(out)["hookSpecificOutput"] as Record<string, unknown> | undefined;
  return hso?.["permissionDecision"] as string | undefined;
}
function writeInput(filePath: string, cwd?: string): PreToolHookInput {
  return { tool_name: "Write", tool_input: { file_path: filePath }, cwd };
}
function bashInput(command: string, cwd?: string): PreToolHookInput {
  return { tool_name: "Bash", tool_input: { command }, cwd };
}

// ---------------------------------------------------------------------------
// F2 — verify-report binding
// ---------------------------------------------------------------------------
describe("F2/R-30 — verify report must be a CURRENT-binding envelope to be trusted", () => {
  function approvedProject(commands: string[]): ProjectPaths {
    tp = makeTempProject();
    const paths = tp.paths;
    runInit(paths, {});
    for (const c of commands) runVerifyAdd(paths, c);
    runVerifyApprove(paths, { as: "alice", tty: { isTTY: true, stdinLine: "y" } });
    return paths;
  }

  it("a bare `{\"ok\":true}` report is rejected as legacy", () => {
    tp = makeTempProject();
    fs.mkdirSync(tp.paths.stateDir, { recursive: true });
    fs.writeFileSync(verifyReportPath(tp.paths), JSON.stringify({ ok: true, ranAt: "x", results: [] }), "utf8");
    expect(readVerifyReportValidated(tp.paths).status).toBe("legacy");
  });

  it("runVerifyRun writes a BOUND envelope the validated reader accepts as valid", () => {
    const paths = approvedProject(["node -e \"process.exit(0)\""]);
    expect(runVerifyRun(paths).ok).toBe(true);
    const v = readVerifyReportValidated(paths);
    expect(v.status).toBe("valid");
    expect(v.envelope!.schemaVersion).toBe(2);
    expect(typeof v.envelope!.commandSetHash).toBe("string");
    expect(typeof v.envelope!.configLockDigest).toBe("string");
  });

  it("a `verify add` AFTER the run invalidates the prior report (command-set mismatch → stale)", () => {
    const paths = approvedProject(["node -e \"process.exit(0)\""]);
    expect(runVerifyRun(paths).ok).toBe(true);
    expect(readVerifyReportValidated(paths).status).toBe("valid");
    // Add a command → the configured set changed → the sealed report no longer matches.
    runVerifyAdd(paths, "echo two");
    const v = readVerifyReportValidated(paths);
    expect(v.status).toBe("stale");
    expect(v.staleReasons).toContain("commandSetHash");
  });

  it("a `verify clear` AFTER the run invalidates the prior report (stale)", () => {
    const paths = approvedProject(["node -e \"process.exit(0)\""]);
    expect(runVerifyRun(paths).ok).toBe(true);
    runVerifyClear(paths);
    // The configured set is now empty; the sealed report's commandSetHash no longer matches.
    expect(readVerifyReportValidated(paths).status).toBe("stale");
  });

  it("a report copied from another project/revision (gitHead mismatch) is rejected as stale", () => {
    tp = makeTempProject();
    const paths = tp.paths;
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const binding = currentVerifyBinding(paths, []);
    // Only meaningful when this checkout has a git identity (so the coordinate discriminates).
    if (binding.gitHead !== null) {
      const report: VerifyReport = { ok: true, ranAt: "x", results: [] };
      writeVerifyReportEnvelope(paths, report, []);
      // Tamper the persisted envelope's gitHead to a different revision.
      const raw = JSON.parse(fs.readFileSync(verifyReportPath(paths), "utf8")) as Record<string, unknown>;
      raw.gitHead = "0000000000000000000000000000000000000000";
      fs.writeFileSync(verifyReportPath(paths), JSON.stringify(raw), "utf8");
      const v = readVerifyReportValidated(paths);
      expect(v.status).toBe("stale");
      expect(v.staleReasons).toContain("gitHead");
    }
  });
});

describe("F2/R-30 — the verify-report anchor is write-denied across Bash and Write/Edit", () => {
  function preImpl(paths: ProjectPaths): void {
    runInit(paths, {});
    writeState(paths, { ...initialState(), current_stage: "stage-05" });
  }

  it("a Write/Edit to verify-report.json is gated (not silently allowed by the doc/state allowlist)", () => {
    tp = makeTempProject();
    preImpl(tp.paths);
    const out = runHookPretoolGate(tp.paths, writeInput(".twinharness/verify-report.json", tp.root));
    expect(["ask", "deny"]).toContain(permissionDecision(out));
  });

  it("a Bash redirection to verify-report.json is HARD-denied", () => {
    tp = makeTempProject();
    preImpl(tp.paths);
    const out = runHookPretoolGate(tp.paths, bashInput("echo '{}' > .twinharness/verify-report.json", tp.root));
    expect(permissionDecision(out)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// F8 — Tester-record binding
// ---------------------------------------------------------------------------
describe("F8/R-31 — the Tester record must be PASSED + receipt + repo-bound to count", () => {
  function initialized(): ProjectPaths {
    tp = makeTempProject();
    runInit(tp.paths, {});
    return tp.paths;
  }

  it("a driver-only record (legacy bare marker) is rejected (driver_only)", () => {
    const paths = initialized();
    fs.writeFileSync(testerRecordPath(paths), JSON.stringify({ driver: "cli-e2e" }), "utf8");
    expect(readTesterRecordValidated(paths).status).toBe("driver_only");
    expect(testerRecordPresent(paths)).toBe(false);
  });

  it("a record without --passed (driver only, via the writer) does not satisfy the gate", () => {
    const paths = initialized();
    expect(runTesterRecord(paths, { driver: "cli-e2e" }).ok).toBe(true);
    // Written, but `passed` is false → not evidence of a passing live run.
    expect(readTesterRecordValidated(paths).status).toBe("not_passed");
    expect(testerRecordPresent(paths)).toBe(false);
  });

  it("a --passed record is bound (receipt + repo snapshot) and counts", () => {
    const paths = initialized();
    expect(runTesterRecord(paths, { driver: "cli-e2e", passed: true }).ok).toBe(true);
    const v = readTesterRecordValidated(paths);
    expect(v.status).toBe("valid");
    expect(typeof v.record!.receiptDigest).toBe("string");
    expect(v.record!.passed).toBe(true);
    expect(testerRecordPresent(paths)).toBe(true);
  });

  it("a passed-but-UNBOUND record (no receiptDigest) is rejected (unbound)", () => {
    const paths = initialized();
    fs.writeFileSync(testerRecordPath(paths), JSON.stringify({ driver: "cli-e2e", passed: true }), "utf8");
    expect(readTesterRecordValidated(paths).status).toBe("unbound");
    expect(testerRecordPresent(paths)).toBe(false);
  });

  it("a record staled by a repo change since the run is rejected (stale)", () => {
    const paths = initialized();
    // Record bound to the CURRENT snapshot.
    expect(runTesterRecord(paths, { driver: "cli-e2e", passed: true }).ok).toBe(true);
    const before = readTesterRecordValidated(paths);
    // Only meaningful when the record captured a non-null repo snapshot (a git checkout).
    if (before.record!.gitHead != null || before.record!.dirtyTreeDigest != null) {
      // Tamper the persisted record's snapshot to a different revision.
      const raw = JSON.parse(fs.readFileSync(testerRecordPath(paths), "utf8")) as Record<string, unknown>;
      if (before.record!.gitHead != null) raw.gitHead = "0000000000000000000000000000000000000000";
      else raw.dirtyTreeDigest = "0000000000000000000000000000000000000000000000000000000000000000";
      fs.writeFileSync(testerRecordPath(paths), JSON.stringify(raw), "utf8");
      expect(readTesterRecordValidated(paths).status).toBe("stale");
      expect(testerRecordPresent(paths)).toBe(false);
    }
  });

  it("the tester-record anchor is write-denied across Bash and Write/Edit", () => {
    const paths = initialized();
    writeState(paths, { ...readState(paths).state!, current_stage: "stage-05", implementation_allowed: false });
    const w = runHookPretoolGate(paths, writeInput(".twinharness/tester-record.json", tp!.root));
    expect(["ask", "deny"]).toContain(permissionDecision(w));
    const b = runHookPretoolGate(paths, bashInput("echo '{}' > .twinharness/tester-record.json", tp!.root));
    expect(permissionDecision(b)).toBe("deny");
  });
});
