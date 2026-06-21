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
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "ci-plugin-mcp-validate.cjs");
const MCP = path.join(ROOT, "dist", "mcp-server.js");
const CLI = path.join(ROOT, "dist", "cli.js");
const BUILT = fs.existsSync(MCP) && fs.existsSync(CLI);

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
