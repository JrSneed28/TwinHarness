/**
 * Hook stdin-`cwd` root resolution parity (R-12).
 *
 * Claude Code does NOT pass `--cwd` to the shipped hooks (hooks/hooks.json); the
 * session's project dir arrives ONLY on the hook stdin payload's `cwd`. PreToolUse
 * already honored that `cwd`; the Stop and SubagentStop gates resolved from the
 * `th` process cwd instead. If session cwd != process cwd, the write-gate and the
 * completion-gate could govern DIFFERENT roots — the Stop hook could fail-open on
 * the wrong/absent state. The fix routes all three hooks through one shared
 * stdin-cwd resolver (cli.ts `resolveHookPaths`).
 *
 * These tests spawn the BUILT `dist/cli.js` so the cli.ts dispatch wiring is
 * exercised end-to-end. The discriminator: a PROJECT dir whose state.json is
 * present-but-invalid makes both the stop-gate and the subagent-stop gate BLOCK;
 * a foreign process cwd with no state.json would ALLOW. The hook is launched from
 * the foreign cwd with NO `--cwd`, and the project dir is supplied ONLY via the
 * stdin `cwd`. A block proves the hook resolved the project (stdin cwd), not the
 * process cwd.
 *
 * Requires a built dist/ (CI builds before testing, like tests/cli-integration.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Node cold-start + Windows process-creation overhead can exceed vitest's 5s
// default under full-suite load; raise the ceiling for the whole file (same
// approach as tests/cli-integration.test.ts).
vi.setConfig({ testTimeout: 30_000 });

const CLI = path.resolve(__dirname, "../dist/cli.js");

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Spawn the built CLI for a hook, from `processCwd`, with NO `--cwd` flag, piping
 * `stdinJson` as the hook payload. Mirrors how Claude Code launches the shipped
 * hooks (hooks/hooks.json passes no `--cwd`). `TH_NO_LOG` keeps stderr quiet.
 */
function runHook(processCwd: string, hookArgs: string[], stdinJson: string): RunResult {
  const r = spawnSync("node", [CLI, "hook", ...hookArgs], {
    cwd: processCwd,
    input: stdinJson,
    encoding: "utf8",
    env: { ...process.env, TH_NO_LOG: "1" },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

let projectDir: string | undefined;
let foreignCwd: string | undefined;

beforeEach(() => {
  // A project whose state.json is present-but-INVALID → the gates BLOCK.
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "th-stdincwd-proj-"));
  const stateDir = path.join(projectDir, ".twinharness");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), "{ not valid json", "utf8");

  // A SEPARATE process cwd with NO TwinHarness state anywhere up its chain → if a
  // hook resolved from here it would ALLOW.
  foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "th-stdincwd-foreign-"));
});

afterEach(() => {
  if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
  if (foreignCwd) fs.rmSync(foreignCwd, { recursive: true, force: true });
  projectDir = foreignCwd = undefined;
});

describe("REQ-HOOK-STDINCWD-001: stop-gate honors the stdin payload cwd", () => {
  it("blocks on the PROJECT's invalid state when cwd is supplied only via stdin (process cwd is foreign)", () => {
    const payload = JSON.stringify({ cwd: projectDir });
    const res = runHook(foreignCwd!, ["stop-gate"], payload);
    expect(res.status).toBe(0);
    const j = JSON.parse(res.stdout) as Record<string, unknown>;
    // Resolved the project (stdin cwd) → invalid state → block.
    expect(j["decision"]).toBe("block");
    expect(String(j["reason"])).toContain("does NOT validate");
  });

  it("ALLOWS (no block) when no stdin cwd is given and the process cwd has no state", () => {
    // Control: without the stdin cwd the hook resolves the foreign process cwd,
    // which has no state → allow ({}). This is the divergence the fix closes.
    const res = runHook(foreignCwd!, ["stop-gate"], JSON.stringify({}));
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({});
  });
});

describe("REQ-HOOK-STDINCWD-002: subagent-stop honors the stdin payload cwd", () => {
  it("blocks on the PROJECT's invalid state when cwd is supplied only via stdin (process cwd is foreign)", () => {
    const payload = JSON.stringify({ cwd: projectDir });
    const res = runHook(foreignCwd!, ["subagent-stop"], payload);
    expect(res.status).toBe(0);
    const j = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(j["decision"]).toBe("block");
    expect(String(j["reason"])).toContain("does NOT validate");
  });

  it("ALLOWS when no stdin cwd is given and the process cwd has no state", () => {
    const res = runHook(foreignCwd!, ["subagent-stop"], JSON.stringify({}));
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({});
  });
});

describe("REQ-HOOK-STDINCWD-003: PreToolUse / Stop / SubagentStop resolve the SAME root from one payload", () => {
  it("all three gates block on the project's invalid state from a foreign process cwd via stdin cwd", () => {
    // PreToolUse on an invalid-state project emits a systemMessage (stands down)
    // rather than {} — the discriminating signal is "not a bare allow". Stop /
    // SubagentStop both emit a block decision. All three must have resolved the
    // SAME (project) root despite the foreign process cwd.
    const pre = runHook(
      foreignCwd!,
      ["pretool-gate"],
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/x.ts" }, cwd: projectDir }),
    );
    const stop = runHook(foreignCwd!, ["stop-gate"], JSON.stringify({ cwd: projectDir }));
    const sub = runHook(foreignCwd!, ["subagent-stop"], JSON.stringify({ cwd: projectDir }));

    // PreToolUse saw the invalid project state (it stands down with a systemMessage).
    const preJson = JSON.parse(pre.stdout) as Record<string, unknown>;
    expect(preJson["systemMessage"]).toBeTruthy();
    // Stop + SubagentStop both block on the SAME project state.
    expect((JSON.parse(stop.stdout) as Record<string, unknown>)["decision"]).toBe("block");
    expect((JSON.parse(sub.stdout) as Record<string, unknown>)["decision"]).toBe("block");
  });
});
