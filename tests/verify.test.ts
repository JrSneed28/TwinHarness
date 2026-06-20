/**
 * `th verify` — configure + run project test/check commands (the one command
 * that executes; see core/verify.ts) — REQ-anchored.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
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
  killProcessTree,
  parsePsProcessTable,
  parseCsvProcessTable,
  parseWmicProcessTable,
  __setSnapshotCommandRunner,
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
    runVerifyApprove(tp.paths, { as: "test", tty: { isTTY: true, stdinLine: "y" } });

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
    runVerifyApprove(tp.paths, { as: "test", tty: { isTTY: true, stdinLine: "y" } });

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
    expect(isCommandSetApproved(tp.paths, readVerifyConfig(tp.paths).commands)).toBe(false);
    const res = runVerifyRun(tp.paths);
    expect(res.ok).toBe(false);
    expect(res.data?.error).toBe("unapproved_command_set");
    expect(readVerifyReport(tp.paths)).toBeNull();
  });

  it("approve pins the set; run then executes; a subsequent add re-requires approval", () => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    runVerifyAdd(tp.paths, PASS_CMD);
    expect(runVerifyApprove(tp.paths, { as: "alice", tty: { isTTY: true, stdinLine: "y" } }).ok).toBe(true);
    expect(isCommandSetApproved(tp.paths, readVerifyConfig(tp.paths).commands)).toBe(true);
    expect(runVerifyRun(tp.paths).ok).toBe(true);

    // Adding a command changes the set → unapproved again.
    runVerifyAdd(tp.paths, PASS_CMD);
    expect(isCommandSetApproved(tp.paths, readVerifyConfig(tp.paths).commands)).toBe(false);
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
  it("curatedEnv keeps PATH and safe tool vars but drops a non-allowlisted secret var", () => {
    // NODE_ENV is a benign, explicitly-allowlisted tool var (R-05); NODE_OPTIONS is
    // NOT — it injects code into every node child, so it must be dropped (asserted
    // in REQ-VERIFY-SEC-006 below). MY_SECRET_TOKEN is a generic secret → dropped.
    const env = curatedEnv({ PATH: "/usr/bin", NODE_ENV: "test", MY_SECRET_TOKEN: "shh" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NODE_ENV).toBe("test");
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

// ===========================================================================
// P3 hardening — R-05 (dangerous-env passthrough) + R-07 (kill-path mislabel)
// ===========================================================================

describe("REQ-VERIFY-SEC-006 (P3/R-05): curatedEnv drops code-injection / trust / supply-chain env vars", () => {
  it("drops NODE_OPTIONS, NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED, NODE_PATH and dangerous npm_config_*", () => {
    const env = curatedEnv({
      // benign, must survive
      PATH: "/usr/bin",
      NODE_ENV: "test",
      // R-05 code-injection / trust vectors → must be dropped
      NODE_OPTIONS: "--require /evil.js",
      NODE_EXTRA_CA_CERTS: "/tmp/evil-ca.pem",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NODE_PATH: "/tmp/evil-modules",
      NODE_REPL_EXTERNAL_MODULE: "/tmp/evil.js",
      // an --inspect-bearing var → dropped
      NODE_INSPECT: "--inspect-brk=0.0.0.0:9229",
      // supply-chain / trust redirect npm_config_* → must be dropped
      npm_config_registry: "http://evil.example/",
      npm_config_cafile: "/tmp/evil-ca.pem",
      npm_config_ca: "-----BEGIN CERTIFICATE-----",
      npm_config_proxy: "http://evil.example:8080",
      npm_config_https_proxy: "http://evil.example:8080",
      "npm_config_https-proxy": "http://evil.example:8080",
      npm_config_userconfig: "/tmp/evil-npmrc",
      npm_config_globalconfig: "/tmp/evil-npmrc",
      npm_config_prefix: "/tmp/evil-prefix",
      npm_config_node_options: "--require /evil.js",
      npm_config_ignore_scripts: "false",
      // a generic project secret → still dropped (existing behavior must hold)
      MY_SECRET: "shh",
      MY_SECRET_TOKEN: "shh",
    });

    // benign survivors
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NODE_ENV).toBe("test");

    // every dangerous var is gone
    for (const k of [
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "NODE_PATH",
      "NODE_REPL_EXTERNAL_MODULE",
      "NODE_INSPECT",
      "npm_config_registry",
      "npm_config_cafile",
      "npm_config_ca",
      "npm_config_proxy",
      "npm_config_https_proxy",
      "npm_config_https-proxy",
      "npm_config_userconfig",
      "npm_config_globalconfig",
      "npm_config_prefix",
      "npm_config_node_options",
      "npm_config_ignore_scripts",
      "MY_SECRET",
      "MY_SECRET_TOKEN",
    ]) {
      expect(env[k], `expected ${k} to be dropped`).toBeUndefined();
    }
  });

  it("drops any --inspect-bearing NODE_* var even with an unanticipated name", () => {
    const env = curatedEnv({ NODE_FOO: "--inspect=127.0.0.1:9229 --bar" });
    expect(env.NODE_FOO).toBeUndefined();
  });

  it("a verify child cannot be hijacked via NODE_OPTIONS from the parent env", () => {
    tp = makeTempProject();
    // If NODE_OPTIONS leaked through, node would --require this file and print PWNED.
    const evil = path.join(tp.root, "evil.js");
    fs.writeFileSync(evil, "process.stdout.write('PWNED ');\n");
    const probe = `node -e "process.stdout.write('done')"`;
    const report = runCommands(tp.root, [probe], {
      env: curatedEnv({ ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(evil)}` }),
    });
    expect(report.results[0]!.outputTail).toContain("done");
    expect(report.results[0]!.outputTail).not.toContain("PWNED");
  });

  // F1 (HIGH): native Windows/PowerShell surfaces env names in mixed case (`Path`,
  // `ProgramFiles`); a case-SENSITIVE allowlist dropped PATH and broke `th verify run`.
  it("keeps allowlisted vars in ANY casing, preserving original key + value (Windows mixed-case env)", () => {
    const env = curatedEnv({
      Path: "C:\\real\\path", // Windows casing of PATH — must survive
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      ProgramFiles: "C:\\Program Files",
      TeMp: "C:\\Temp",
      "node_env": "production", // lower-cased NODE_ENV
    });
    // A path-like key survives (case-insensitive lookup) with the real value.
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
    expect(pathKey, "a PATH-like key should survive in some casing").toBeDefined();
    expect(env[pathKey!]).toBe("C:\\real\\path");
    // Original key casing is preserved (not upper-cased on the way out).
    expect(pathKey).toBe("Path");
    expect(env.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(env.ProgramFiles).toBe("C:\\Program Files");
    expect(env.TeMp).toBe("C:\\Temp");
    expect(env["node_env"]).toBe("production");
  });

  it("still DROPS dangerous vars in ANY casing (case-insensitive denial holds)", () => {
    const env = curatedEnv({
      Path: "/usr/bin", // benign survivor as a control
      nodE_OptionS: "--require /evil.js",
      Node_Extra_Ca_Certs: "/tmp/evil-ca.pem",
      NODE_TLS_REJECT_unauthorized: "0",
      NPM_CONFIG_REGISTRY: "http://evil.example/",
      "Npm_Config_Https-Proxy": "http://evil.example:8080",
    });
    expect(Object.keys(env).some((k) => k.toUpperCase() === "PATH")).toBe(true);
    for (const k of [
      "nodE_OptionS",
      "Node_Extra_Ca_Certs",
      "NODE_TLS_REJECT_unauthorized",
      "NPM_CONFIG_REGISTRY",
      "Npm_Config_Https-Proxy",
    ]) {
      expect(env[k], `expected case-variant ${k} to be dropped`).toBeUndefined();
    }
  });

  it("drops a mixed-case NODE_* var carrying --inspect in its value", () => {
    const env = curatedEnv({ nOdE_fOo: "--inspect=127.0.0.1:9229" });
    expect(env.nOdE_fOo).toBeUndefined();
  });
});

describe("REQ-VERIFY-SEC-007 (P3/R-07): a maxBuffer (ENOBUFS) overflow reaps the tree and is NOT mislabeled a timeout", () => {
  it("an output-overflow kill calls killProcessTree and records a non-timeout exit code + honest message", () => {
    tp = makeTempProject();
    const killed: number[] = [];
    // A command that floods stdout past a tiny maxBuffer → Node kills it with
    // ENOBUFS, status:null, pid set, but error.code !== ETIMEDOUT. It chdir's out of
    // the temp root first (like HANG_CMD) so a lingering child can't hold the cwd and
    // wedge teardown. The spy RECORDS the pid and still performs the REAL reap, so the
    // assertion (reap invoked) holds without leaking the process.
    const flood = `node -e "process.chdir(require('os').tmpdir());process.stdout.write('x'.repeat(5000000))"`;
    const report = runCommands(tp.root, [flood], {
      maxBuffer: 1024,
      killTree: (pid) => {
        killed.push(pid);
        killProcessTree(pid);
      },
    });
    const r = report.results[0]!;
    expect(r.ok).toBe(false);
    // The tree MUST be reaped on an ENOBUFS kill (the leak the audit flagged).
    expect(killed.length).toBe(1);
    expect(typeof killed[0]).toBe("number");
    expect(killed[0]).toBeGreaterThan(0);
    // It must NOT be mislabeled a timeout: exit code is not 124 and the message
    // does not claim a timeout.
    expect(r.exitCode).not.toBe(124);
    expect(r.outputTail.toLowerCase()).not.toContain("timeout");
    expect(r.outputTail.toLowerCase()).toContain("output");
  });

  it("an honest ETIMEDOUT still records exit 124 and a timeout message", () => {
    tp = makeTempProject();
    const killed: number[] = [];
    const report = runCommands(tp.root, [HANG_CMD], {
      timeoutMs: 1000,
      killTree: (pid) => {
        killed.push(pid);
        killProcessTree(pid);
      },
    });
    const r = report.results[0]!;
    expect(r.ok).toBe(false);
    expect(killed.length).toBe(1); // tree reaped on timeout too
    expect(r.exitCode).toBe(124);
    expect(r.outputTail).toContain("timeout");
  });
});

describe("REQ-VERIFY-005 (P3/R-07): the timeout reap actually kills a spawned grandchild (no false confidence)", () => {
  it("a real grandchild process is dead after the timeout reap", () => {
    tp = makeTempProject();
    const pidFile = path.join(tp.root, "grandchild.pid");
    // Two real script FILES (no fragile nested `node -e` quoting): the parent
    // script (the shell's direct child) spawns a DETACHED node GRANDCHILD that
    // records its own PID then sleeps far past the budget; the parent then hangs
    // too, so the timeout fires. If the reap only SIGKILLed the direct child (the
    // exact gap REQ-VERIFY-005 failed to catch), the grandchild would survive.
    const gcScript = path.join(tp.root, "grandchild.js");
    fs.writeFileSync(
      gcScript,
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setTimeout(() => {}, 30000);\n`,
    );
    const parentScript = path.join(tp.root, "parent.js");
    // The grandchild is an ordinary (non-detached) member of the shell's process
    // tree — exactly what the timeout reap (taskkill /T on Windows, ps-walk SIGKILL
    // on POSIX) is supposed to reach. It must die when killProcessTree runs, and
    // SURVIVE if that call is deleted (the deletion guard the old test lacked).
    fs.writeFileSync(
      parentScript,
      `const cp = require("child_process");\n` +
        `cp.spawn(process.execPath, [${JSON.stringify(gcScript)}], { stdio: "ignore" });\n` +
        `setTimeout(() => {}, 30000);\n`,
    );
    const spawner = `node ${JSON.stringify(parentScript)}`;

    const report = runCommands(tp.root, [spawner], { timeoutMs: 3000 });
    expect(report.results[0]!.ok).toBe(false);

    // Give the grandchild a beat to have written its pid (it writes immediately).
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) {
      spawnSync(process.execPath, ["-e", "setTimeout(()=>{},50)"]);
    }
    expect(fs.existsSync(pidFile), "grandchild should have recorded its pid").toBe(true);
    const gcPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(gcPid)).toBe(true);

    // Poll: after the reap the grandchild PID must be gone. process.kill(pid, 0)
    // throws ESRCH when the process no longer exists.
    let alive = true;
    const killDeadline = Date.now() + 4000;
    while (alive && Date.now() < killDeadline) {
      try {
        process.kill(gcPid, 0);
        // still alive — wait a touch and re-poll
        spawnSync(process.execPath, ["-e", "setTimeout(()=>{},100)"]);
      } catch {
        alive = false;
      }
    }
    // Defensive teardown if the assertion is about to fail: don't leak the process.
    if (alive) {
      try {
        process.kill(gcPid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    expect(alive, `grandchild pid ${gcPid} should be dead after the timeout reap`).toBe(false);
  });

  it("killProcessTree is invoked with the child pid on timeout (guard against deletion)", () => {
    tp = makeTempProject();
    const killed: number[] = [];
    const report = runCommands(tp.root, [HANG_CMD], {
      timeoutMs: 1000,
      killTree: (pid) => {
        killed.push(pid);
        killProcessTree(pid); // delegate so the hung child is actually reaped
      },
    });
    expect(report.results[0]!.ok).toBe(false);
    expect(killed.length).toBe(1);
    expect(typeof killed[0]).toBe("number");
    expect(killed[0]).toBeGreaterThan(0);
  });
});

// Keep a direct reference so the export stays covered even if seams change.
void killProcessTree;

// ===========================================================================
// P3 second pass — F4: process-table snapshot parsers (Windows reap resilience)
// ===========================================================================

describe("REQ-VERIFY-SEC-008 (P3/R-07/F4): the process-table snapshot parsers build a correct PID/PPID map", () => {
  it("parseCsvProcessTable parses Get-CimInstance CSV (ProcessId,ParentProcessId)", () => {
    // Exactly the shape of `Get-CimInstance Win32_Process | Select ProcessId,
    // ParentProcessId | ConvertTo-Csv -NoTypeInformation` (quoted, CRLF, header first).
    const csv = ['"ProcessId","ParentProcessId"', '"4","0"', '"100","4"', '"200","100"', '"201","100"'].join("\r\n");
    const map = parseCsvProcessTable(csv);
    expect(map.get(0)).toEqual([4]);
    expect(map.get(4)).toEqual([100]);
    expect(map.get(100)).toEqual([200, 201]);
    // Walk: subtree of 4 = {4,100,200,201}.
    expect(map.get(200)).toBeUndefined();
  });

  it("parseCsvProcessTable tolerates a leading #TYPE comment line and reversed column order", () => {
    const csv = [
      "#TYPE Selected.Microsoft.Management.Infrastructure.CimInstance",
      '"ParentProcessId","ProcessId"', // reversed selection order
      '"0","4"',
      '"4","100"',
    ].join("\n");
    const map = parseCsvProcessTable(csv);
    expect(map.get(0)).toEqual([4]);
    expect(map.get(4)).toEqual([100]);
  });

  it("parseCsvProcessTable returns an empty map for empty/garbage input (caller degrades safely)", () => {
    expect(parseCsvProcessTable("").size).toBe(0);
    expect(parseCsvProcessTable("not,a,process,table\n1,2,3").size).toBe(0);
  });

  it("parseWmicProcessTable parses legacy wmic columns (ParentProcessId  ProcessId)", () => {
    const text = ["ParentProcessId  ProcessId", "0                4", "4                100", "100              200"].join(
      "\n",
    );
    const map = parseWmicProcessTable(text);
    expect(map.get(0)).toEqual([4]);
    expect(map.get(4)).toEqual([100]);
    expect(map.get(100)).toEqual([200]);
  });

  it("parsePsProcessTable parses POSIX `ps -e -o pid=,ppid=` (pid first, then ppid)", () => {
    const text = ["    4     0", "  100     4", "  200   100"].join("\n");
    const map = parsePsProcessTable(text);
    expect(map.get(0)).toEqual([4]);
    expect(map.get(4)).toEqual([100]);
    expect(map.get(100)).toEqual([200]);
  });

  // F4: on Windows the snapshot cascades CIM → Get-WmiObject → wmic, taking the first
  // command that yields a non-empty table. Driven through the command seam so no real
  // process table is needed; verifies the wmic-absent / CIM-failing host still reaps.
  it.runIf(process.platform === "win32")(
    "snapshotChildrenMap cascades CIM → WMI → wmic and uses the first non-empty result",
    () => {
      const tried: string[] = [];
      // CIM and Get-WmiObject return nothing (simulate a host where they fail/are blank);
      // legacy wmic returns a valid table → its child of the target pid is reaped.
      const restore = __setSnapshotCommandRunner((cmd, args) => {
        const joined = `${cmd} ${args.join(" ")}`;
        if (/Get-CimInstance/.test(joined)) {
          tried.push("cim");
          return "";
        }
        if (/Get-WmiObject/.test(joined)) {
          tried.push("wmi");
          return "";
        }
        if (cmd === "wmic") {
          tried.push("wmic");
          return ["ParentProcessId  ProcessId", "999999  888888"].join("\n");
        }
        tried.push(`other:${cmd}`);
        return "";
      });
      try {
        // Use synthetic, non-existent PIDs so the real taskkill/killOne calls are no-ops.
        killProcessTree(999999);
      } finally {
        restore();
      }
      // All three Windows snapshot strategies were attempted, in order, until wmic hit.
      expect(tried).toEqual(["cim", "wmi", "wmic"]);
    },
  );
});
