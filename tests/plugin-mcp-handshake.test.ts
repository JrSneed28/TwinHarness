/**
 * R-37 — release-confidence: the LIVE plugin/MCP handshake as a vitest entry point.
 *
 * The authoritative CI step runs `scripts/ci-plugin-mcp-validate.cjs` directly (so it
 * gates even if the test runner is skipped). This wrapper ALSO drives the same script
 * under `npm test` so a local `npm run verify` exercises it — gated on the built
 * artifacts existing (the same graceful-skip convention as the cross-process
 * concurrency suite: CI always builds first; a local run without a build simply skips).
 *
 * It validates: plugin + marketplace manifests, the agent manifests, a real
 * `dist/mcp-server.js` JSON-RPC initialize + tools/list handshake, and a live
 * hook Stop-gate decision over the compiled CLI — the shipped surfaces the Claude
 * Code host loads, which an in-process unit test cannot prove.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "ci-plugin-mcp-validate.cjs");
const MCP = path.join(ROOT, "dist", "mcp-server.js");
const CLI = path.join(ROOT, "dist", "cli.js");
const BUILT = fs.existsSync(MCP) && fs.existsSync(CLI);

// The script guards its CI flow behind `require.main === module`, so requiring it here
// loads ONLY the pure validators (no server spawn / no process.exit).
const requireCjs = createRequire(__filename);
const { assertHookStopOk } = requireCjs(SCRIPT) as {
  assertHookStopOk: (res: {
    status: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  }) => Record<string, unknown>;
};

describe("R-37 — live plugin + MCP handshake (compiled artifacts)", () => {
  it.skipIf(!BUILT)(
    "plugin/marketplace manifests + 16 agents + live MCP handshake + hook Stop all pass",
    () => {
      const res = spawnSync("node", [SCRIPT], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, TH_NO_LOG: "1" },
      });
      // The script prints `ok:`/`ALL CHECKS PASSED` on success and exits 0; any
      // regression exits non-zero with a `FAIL:` line we surface in the assertion.
      if (res.status !== 0) {
        throw new Error(
          `plugin/MCP validation failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`,
        );
      }
      expect(res.stdout).toContain("ALL CHECKS PASSED");
      expect(res.stdout).toContain("live MCP handshake");
      expect(res.stdout).toContain("hook stop-gate emits a well-formed JSON decision");
    },
    30000,
  );
});

// PR #30 review (P2): the hook-stop validation used `JSON.parse(stdout.trim() || "{}")`
// and never checked the exit status, so a broken stop-gate that emitted NOTHING, or that
// printed JSON then exited nonzero, still passed CI. The validator must require a zero
// exit AND non-empty parseable JSON before reporting success.
describe("R-37 — ci-validate rejects empty/failed hook executions (PR #30 P2)", () => {
  it("ACCEPTS a clean exit (0) with a non-empty JSON object decision", () => {
    expect(assertHookStopOk({ status: 0, stdout: "{}" })).toEqual({});
    expect(assertHookStopOk({ status: 0, stdout: '{"decision":"block"}' })).toEqual({ decision: "block" });
  });

  it("REJECTS a NONZERO exit even when stdout is valid JSON (status is now checked)", () => {
    expect(() => assertHookStopOk({ status: 1, stdout: "{}" })).toThrow(/exited 1/);
  });

  it("REJECTS EMPTY stdout (no longer coerced to {})", () => {
    expect(() => assertHookStopOk({ status: 0, stdout: "" })).toThrow(/EMPTY stdout/);
    expect(() => assertHookStopOk({ status: 0, stdout: "   \n " })).toThrow(/EMPTY stdout/);
  });

  it("REJECTS unparseable or non-object output", () => {
    expect(() => assertHookStopOk({ status: 0, stdout: "not json at all" })).toThrow(/valid JSON/);
    expect(() => assertHookStopOk({ status: 0, stdout: "42" })).toThrow(/not an object/);
    expect(() => assertHookStopOk({ status: 0, stdout: "null" })).toThrow(/not an object/);
  });

  it("REJECTS a spawn error", () => {
    expect(() => assertHookStopOk({ status: null, error: new Error("ENOENT") })).toThrow(/failed to spawn/);
  });
});
