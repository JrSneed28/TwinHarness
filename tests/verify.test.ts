/**
 * `th verify` — configure + run project test/check commands (the one command
 * that executes; see core/verify.ts) — REQ-anchored.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runVerifyAdd, runVerifyList, runVerifyClear, runVerifyRun } from "../src/commands/verify";
import { readVerifyConfig, readVerifyReport, runCommands } from "../src/core/verify";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

// Portable, cross-platform stand-ins for POSIX `true`/`false`/`sleep` so these
// tests pass on a bare-Windows runner with no Git Bash on PATH. runCommands uses
// spawnSync(shell: true) → cmd.exe on Windows, which cannot resolve `true`/
// `false`/`sleep`; `node` is always on PATH wherever vitest runs. The quoting is
// safe under both cmd.exe and sh (no shell-special chars outside the quotes).
// (P1-3 / DOC-003≡TEST-002)
const PASS_CMD = `node -e "process.exit(0)"`;
const FAIL_CMD = `node -e "process.exit(1)"`;
// Hangs > any test budget so the timeout-kill path is exercised. It chdir's out
// of the spawn cwd (the temp project root) first: on Windows a SIGKILL of the
// shell does not kill this grandchild, and a process holding the temp root as
// its cwd would block the afterEach rmSync (EPERM). chdir releases that lock so
// the lingering (harmless) process can't wedge teardown.
const HANG_CMD = `node -e "process.chdir(require('os').tmpdir());setTimeout(()=>{},10000)"`;

describe("REQ-VERIFY-001: add/list/clear manage the command list (outside state.json)", () => {
  it("add appends; list reflects; clear empties — and state.json is untouched", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const before = fs.readFileSync(tp.paths.stateFile, "utf8");

    expect(runVerifyAdd(tp.paths, "npm test").ok).toBe(true);
    expect(runVerifyAdd(tp.paths, "npm run lint").ok).toBe(true);
    expect(readVerifyConfig(tp.paths).commands).toEqual(["npm test", "npm run lint"]);

    const list = runVerifyList(tp.paths);
    expect(list.data?.commands).toEqual(["npm test", "npm run lint"]);

    expect(runVerifyClear(tp.paths).ok).toBe(true);
    expect(readVerifyConfig(tp.paths).commands).toEqual([]);

    // The verify config never touches state.json (schema stability).
    expect(fs.readFileSync(tp.paths.stateFile, "utf8")).toBe(before);
  });

  it("add with no command → usage failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runVerifyAdd(tp.paths, "  ").ok).toBe(false);
  });
});

describe("REQ-VERIFY-002: run executes configured commands and records a report", () => {
  it("all green → success, report.ok true, exit 0", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);
    runVerifyAdd(tp.paths, PASS_CMD);

    const res = runVerifyRun(tp.paths);
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.data?.ok).toBe(true);

    const report = readVerifyReport(tp.paths);
    expect(report?.ok).toBe(true);
    expect(report?.results).toHaveLength(2);
  });

  it("a failing command → failure, report.ok false, exit 1, but all commands still ran", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);
    runVerifyAdd(tp.paths, FAIL_CMD);

    const res = runVerifyRun(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);

    const report = readVerifyReport(tp.paths);
    expect(report?.ok).toBe(false);
    expect(report?.results).toHaveLength(2);
    expect(report?.results[0]?.ok).toBe(true);
    expect(report?.results[1]?.ok).toBe(false);
  });
});

describe("REQ-VERIFY-003: run with no configured commands is a usage failure", () => {
  it("no commands → failure no_verify_commands, no report written", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    const res = runVerifyRun(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("no_verify_commands");
    expect(readVerifyReport(tp.paths)).toBeNull();
  });
});

describe("REQ-VERIFY-004: runCommands timestamp is injectable (clock-free testing)", () => {
  it("ranAt uses the injected clock", () => {
    tp = makeTempProject();
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const report = runCommands(tp.root, [PASS_CMD], () => fixed);
    expect(report.ranAt).toBe("2026-01-01T00:00:00.000Z");
    expect(report.ok).toBe(true);
  });
});

describe("REQ-VERIFY-005: a hanging command is killed by the timeout, not blocked forever", () => {
  it("a hanging command with a short budget → recorded as a failure and the run returns", () => {
    tp = makeTempProject();
    const start = Date.now();
    // 2s budget: long enough to be robust against spawn jitter under full-suite
    // parallel load, short enough to prove a 10s hang is killed well before it ends.
    const report = runCommands(tp.root, [HANG_CMD], undefined, 2000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(8000); // returned well before the 10s sleep would finish
    expect(report.ok).toBe(false);
    expect(report.results[0]?.ok).toBe(false);
    expect(report.results[0]?.outputTail).toContain("timeout");
  });

  it("a fast command still passes under a generous budget", () => {
    tp = makeTempProject();
    // Use the default (5-minute) budget — a 150ms budget is NOT generous for a
    // real shell spawn and flakes under full-suite parallel load on slower hosts.
    const report = runCommands(tp.root, [PASS_CMD]);
    expect(report.ok).toBe(true);
  });
});
