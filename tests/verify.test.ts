/**
 * `th verify` — configure + run project test/check commands (the one command
 * that executes; see core/verify.ts) — REQ-anchored.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { runVerifyAdd, runVerifyList, runVerifyClear, runVerifyRun, runVerifyApprove } from "../src/commands/verify";
import {
  readVerifyConfig,
  readVerifyReport,
  runCommands,
  isCommandSetApproved,
  redactSecrets,
  curatedEnv,
  looksRepoMutating,
} from "../src/core/verify";

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
    runVerifyApprove(tp.paths, { as: "test" });

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
    runVerifyApprove(tp.paths, { as: "test" });

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

// ===========================================================================
// Phase 6 safety hardening (#19) — REQ-anchored
// ===========================================================================

describe("REQ-VERIFY-SEC-001 (P6-2): a new/changed command set must be human-approved before it runs", () => {
  it("add → unapproved → run refuses with unapproved_command_set and writes no report", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);
    expect(isCommandSetApproved(readVerifyConfig(tp.paths))).toBe(false);
    const res = runVerifyRun(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unapproved_command_set");
    expect(readVerifyReport(tp.paths)).toBeNull();
  });

  it("approve pins the set; run then executes; a subsequent add re-requires approval", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);
    expect(runVerifyApprove(tp.paths, { as: "alice" }).ok).toBe(true);
    expect(isCommandSetApproved(readVerifyConfig(tp.paths))).toBe(true);
    expect(runVerifyRun(tp.paths).ok).toBe(true);

    // Adding a command changes the set → unapproved again.
    runVerifyAdd(tp.paths, PASS_CMD);
    expect(isCommandSetApproved(readVerifyConfig(tp.paths))).toBe(false);
    expect(runVerifyRun(tp.paths).data?.error).toBe("unapproved_command_set");
  });

  it("approve with no commands configured is a usage failure", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    expect(runVerifyApprove(tp.paths).data?.error).toBe("no_verify_commands");
  });
});

describe("REQ-VERIFY-SEC-002 (P6-2): add records per-command provenance (actor + timestamp)", () => {
  it("provenance carries the resolved actor and an ISO-8601 addedAt", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, "npm test", { as: "bob", now: () => new Date("2026-02-02T00:00:00.000Z") });
    const cfg = readVerifyConfig(tp.paths);
    expect(cfg.provenance).toHaveLength(1);
    expect(cfg.provenance![0]!.command).toBe("npm test");
    expect(cfg.provenance![0]!.actor).toBe("bob");
    expect(cfg.provenance![0]!.addedAt).toBe("2026-02-02T00:00:00.000Z");
  });
});

describe("REQ-VERIFY-SEC-003 (P6-3): the persisted output tail is secret-redacted", () => {
  it("redactSecrets scrubs token/secret shapes but leaves ordinary output", () => {
    expect(redactSecrets("API_KEY=sk-supersecret123")).toContain("[REDACTED]");
    expect(redactSecrets("password: hunter2")).toContain("[REDACTED]");
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toContain("[REDACTED]");
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE here")).toContain("[REDACTED_AWS_KEY]");
    expect(redactSecrets("ghp_0123456789abcdefghijklmnopqrstuvwx")).toContain("[REDACTED_GH_TOKEN]");
    // Ordinary test output is untouched.
    expect(redactSecrets("3 passed, 0 failed")).toBe("3 passed, 0 failed");
  });

  it("runCommands persists a redacted tail for a command that prints a secret", () => {
    tp = makeTempProject();
    const leak = `node -e "console.log('API_KEY=sk-leaked-value-xyz')"`;
    const report = runCommands(tp.root, [leak]);
    expect(report.results[0]!.outputTail).not.toContain("sk-leaked-value-xyz");
    expect(report.results[0]!.outputTail).toContain("[REDACTED]");
  });
});

describe("REQ-VERIFY-SEC-004 (P6-3): a curated env is passed to children, not a full inherit", () => {
  it("curatedEnv keeps PATH and tool prefixes but drops a non-allowlisted secret var", () => {
    const env = curatedEnv({ PATH: "/usr/bin", NODE_OPTIONS: "--enable-source-maps", MY_SECRET_TOKEN: "shh" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NODE_OPTIONS).toBe("--enable-source-maps");
    expect(env.MY_SECRET_TOKEN).toBeUndefined();
  });

  it("a verify child does NOT see a non-allowlisted parent env var", () => {
    tp = makeTempProject();
    const probe = `node -e "process.stdout.write('VAL=' + (process.env.TH_LEAK_PROBE || 'absent'))"`;
    const report = runCommands(tp.root, [probe], {
      env: curatedEnv({ ...process.env, TH_LEAK_PROBE: "should-not-pass" }),
    });
    expect(report.results[0]!.outputTail).toContain("VAL=absent");
  });
});

describe("REQ-VERIFY-SEC-005 (P6-5): read-only mode refuses repo-mutating commands", () => {
  it("looksRepoMutating flags writes/installs/git mutations and passes read-only commands", () => {
    expect(looksRepoMutating("echo hi > out.txt")).toBe(true);
    expect(looksRepoMutating("npm install")).toBe(true);
    expect(looksRepoMutating("git commit -m x")).toBe(true);
    expect(looksRepoMutating("rm -rf build")).toBe(true);
    expect(looksRepoMutating("npm test")).toBe(false);
    expect(looksRepoMutating("git status")).toBe(false);
  });

  it("runCommands in readOnly mode refuses a mutating command (exit 126) without executing it", () => {
    tp = makeTempProject();
    const sentinel = require("node:path").join(tp.root, "sentinel.txt");
    const mutating = `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x')"`;
    // The mutating shape we detect is the `node -e` writeFileSync? No — detect via redirection.
    const report = runCommands(tp.root, ["echo hi > out.txt"], { readOnly: true });
    expect(report.results[0]!.ok).toBe(false);
    expect(report.results[0]!.exitCode).toBe(126);
    expect(report.results[0]!.outputTail).toContain("read-only");
    // The redirection never ran → out.txt does not exist.
    expect(fs.existsSync(require("node:path").join(tp.root, "out.txt"))).toBe(false);
    void mutating;
  });
});
