/**
 * CLI integration tests (PR validation, v0.6.2).
 *
 * The command unit tests call the `run*` functions directly, which bypasses
 * cli.ts's argument parsing + dispatch. These tests spawn the BUILT `dist/cli.js`
 * so the 0.6.2 wiring is actually exercised end-to-end: the new command groups
 * (`preview`, `scorecard`, `telemetry`), the new flags (`--tier`, `--brownfield`),
 * the `strict` write_gate value, the Claude Code doctor note, and HELP.
 *
 * Requires a built dist/ (CI builds before testing, like tests/concurrency.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";

// Every test here spawns the built `node dist/cli.js` one or more times
// (the telemetry round-trip does 6 sequential spawns). Node cold-start plus
// Windows process-creation overhead can exceed vitest's 5s default under full-
// suite CI load, so raise the ceiling for the whole file — same approach as
// tests/concurrency.test.ts. The ceiling still catches a genuine hang.
vi.setConfig({ testTimeout: 30_000 });

const CLI = path.resolve(__dirname, "../dist/cli.js");
const ROOT = path.resolve(__dirname, "..");

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** Spawn the built CLI against `root`. TH_NO_LOG keeps the stderr log quiet. */
function run(root: string, args: string[]): RunResult {
  const r = spawnSync("node", [CLI, "--cwd", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, TH_NO_LOG: "1" },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

let tp: TempProject | undefined;
beforeEach(() => {
  tp = makeTempProject();
});
afterEach(() => tp?.cleanup());

describe("REQ-CLI-PREVIEW-001: `th preview` is dispatched and honors --tier", () => {
  it("preview --tier T2 lists the pipeline with gate markers (exit 0)", () => {
    const res = run(tp!.root, ["preview", "--tier", "T2"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("T2");
    expect(res.stdout).toMatch(/requirements/);
    expect(res.stdout).toMatch(/gate/i);
  });

  it("preview --tier T2 --json emits parseable JSON with ok:true", () => {
    const res = run(tp!.root, ["preview", "--tier", "T2", "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok?: boolean };
    expect(parsed.ok).toBe(true);
  });
});

describe("REQ-CLI-SCORECARD-001: `th scorecard` is dispatched", () => {
  it("scorecard --json returns a structured summary on a fresh project", () => {
    run(tp!.root, ["init"]);
    const res = run(tp!.root, ["scorecard", "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty("slices");
    expect(parsed).toHaveProperty("coverage");
  });
});

describe("REQ-CLI-TELEMETRY-001: `th telemetry on|off|status` round-trips and is local-only", () => {
  it("status → on → status(enabled) → off → status(disabled)", () => {
    run(tp!.root, ["init"]);
    expect(run(tp!.root, ["telemetry", "status"]).stdout).toMatch(/disabled/i);
    expect(run(tp!.root, ["telemetry", "on"]).status).toBe(0);
    expect(run(tp!.root, ["telemetry", "status"]).stdout).toMatch(/enabled/i);
    expect(run(tp!.root, ["telemetry", "off"]).status).toBe(0);
    expect(run(tp!.root, ["telemetry", "status"]).stdout).toMatch(/disabled/i);
  });

  it("an unknown telemetry subcommand fails (non-zero)", () => {
    run(tp!.root, ["init"]);
    expect(run(tp!.root, ["telemetry", "bogus"]).status).not.toBe(0);
  });
});

describe("REQ-CLI-BROWNFIELD-001: `th init --brownfield` flag is parsed and stamps project_mode", () => {
  it("--brownfield → project_mode=brownfield; plain init omits it", () => {
    run(tp!.root, ["init", "--brownfield"]);
    expect(run(tp!.root, ["state", "get", "project_mode"]).stdout).toContain("brownfield");

    const tp2 = makeTempProject();
    run(tp2.root, ["init"]);
    expect(run(tp2.root, ["state", "get", "project_mode"]).stdout).not.toContain("brownfield");
    tp2.cleanup();
  });
});

describe("REQ-CLI-STRICT-001: state set accepts the new write_gate `strict` value", () => {
  it("strict is accepted and reads back; an invalid value is rejected", () => {
    run(tp!.root, ["init"]);
    // write_gate is gate-owned (#11): a raw `state set` needs --emergency to force it.
    expect(run(tp!.root, ["state", "set", "write_gate", "strict", "--emergency"]).status).toBe(0);
    expect(run(tp!.root, ["state", "get", "write_gate"]).stdout).toContain("strict");
    expect(run(tp!.root, ["state", "set", "write_gate", "bogus", "--emergency"]).status).not.toBe(0);
  });
});

describe("REQ-CLI-DOCTOR-001: `th doctor` surfaces the Claude Code compatibility note (G10)", () => {
  it("doctor output names the Claude Code expectation", () => {
    run(tp!.root, ["init"]);
    expect(run(tp!.root, ["doctor"]).stdout).toMatch(/claude code/i);
  });
});

describe("REQ-CLI-HELP-001: help advertises the new commands and flags", () => {
  it("help lists preview, scorecard, telemetry, and --brownfield", () => {
    const help = run(tp!.root, ["help"]).stdout;
    for (const token of ["preview", "scorecard", "telemetry", "--brownfield"]) {
      expect(help).toContain(token);
    }
  });
});

describe("REQ-CLI-MANIFEST-001: plugin.json declares the Claude Code version expectation (G10)", () => {
  it("metadata.requiresClaudeCode is a non-empty string", () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin/plugin.json"), "utf8")) as {
      metadata?: { requiresClaudeCode?: unknown };
    };
    expect(typeof plugin.metadata?.requiresClaudeCode).toBe("string");
    expect((plugin.metadata?.requiresClaudeCode as string).length).toBeGreaterThan(0);
  });
});
