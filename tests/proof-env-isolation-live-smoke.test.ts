/**
 * Finding #3 — CLAUDE_PROJECT_DIR env-based MCP isolation (refined finding, not a clear bug).
 *
 * FINDING: proof MCP tools resolve project root only from CLAUDE_PROJECT_DIR ambient
 * env (src/mcp-server.ts:130-132, resolvePathsForCall, read per-call).  There is no
 * explicit scenarioRoot/projectRoot argument on tool calls.
 *
 * DESIRED BEHAVIOR (already the current design intent): setting CLAUDE_PROJECT_DIR
 * to a scenario root causes ALL MCP tool calls in that process context to land in
 * the scenario root, NOT the repo root.  The repo-root state must be untouched.
 *
 * RECOMMENDED FIX / NOTE: This is a REFINED finding rather than a clear bug.
 * Per-call env reading (not caching at startup) already provides correct isolation
 * as long as each concurrent session controls its own process env.  The risk is
 * that a multi-tenant in-process scenario (two scenarios sharing one process) would
 * cross-contaminate because process.env is global.  Recommend adding an explicit
 * per-call projectRoot override path so isolation does not depend on the caller
 * managing a global mutable singleton.
 *
 * THIS TEST PINS TODAY'S (CORRECT) BEHAVIOR for the single-session case: setting
 * CLAUDE_PROJECT_DIR reliably routes MCP calls to the scenario root and leaves
 * an independent repo-root state untouched.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { resolvePathsForCall, callTool } from "../src/mcp-server";

describe("Finding #3: CLAUDE_PROJECT_DIR env-based MCP isolation smoke test (characterization — current behavior is CORRECT for single-session)", () => {
  let scenarioProject: TempProject;
  let repoProject: TempProject;
  let prevProjectDir: string | undefined;

  beforeEach(() => {
    // Scenario root: the target scenario dir MCP calls should land in.
    scenarioProject = makeTempProject();
    runInit(scenarioProject.paths, {});

    // Independent "repo" root: must remain byte-for-byte unchanged after MCP calls.
    repoProject = makeTempProject();
    runInit(repoProject.paths, {});

    prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    scenarioProject.cleanup();
    repoProject.cleanup();
  });

  /** SHA-256 hash of a file's contents; returns null when the file does not exist. */
  function fileHash(filePath: string): string | null {
    if (!fs.existsSync(filePath)) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  }

  it("resolvePathsForCall() resolves to the scenario root when CLAUDE_PROJECT_DIR points there", () => {
    process.env.CLAUDE_PROJECT_DIR = scenarioProject.root;

    const resolved = resolvePathsForCall();

    expect(path.resolve(resolved.root)).toBe(path.resolve(scenarioProject.root));
    expect(resolved.root).not.toBe(repoProject.root);
  });

  it("resolvePathsForCall() changes target when CLAUDE_PROJECT_DIR is updated between calls", () => {
    process.env.CLAUDE_PROJECT_DIR = scenarioProject.root;
    const resolvedA = resolvePathsForCall();

    process.env.CLAUDE_PROJECT_DIR = repoProject.root;
    const resolvedB = resolvePathsForCall();

    // Per-call resolution: each call reflects the current env value.
    expect(path.resolve(resolvedA.root)).toBe(path.resolve(scenarioProject.root));
    expect(path.resolve(resolvedB.root)).toBe(path.resolve(repoProject.root));
    expect(resolvedA.root).not.toBe(resolvedB.root);
  });

  it("th_state_get MCP call lands in the scenario root; the repo-root state.json is byte-for-byte unchanged", async () => {
    // Capture hash of the independent "repo" state.json BEFORE any MCP activity.
    const repoStateHash = fileHash(repoProject.paths.stateFile);
    expect(repoStateHash).not.toBeNull(); // runInit created it.

    // Route MCP calls to the scenario root via CLAUDE_PROJECT_DIR.
    process.env.CLAUDE_PROJECT_DIR = scenarioProject.root;

    const res = await callTool("th_state_get", {});
    expect(res.isError).toBeFalsy();

    // The resolved paths during the call pointed at scenarioProject.
    const resolvedDuringCall = resolvePathsForCall();
    expect(path.resolve(resolvedDuringCall.root)).toBe(path.resolve(scenarioProject.root));

    // The repo-root state.json is unchanged.
    const repoStateHashAfter = fileHash(repoProject.paths.stateFile);
    expect(repoStateHashAfter).toBe(repoStateHash);
  });

  it("proof-calls.jsonl is written under the scenario stateDir, NOT the repo stateDir", async () => {
    process.env.CLAUDE_PROJECT_DIR = scenarioProject.root;

    await callTool("th_state_get", {});

    const scenarioTrail = path.join(scenarioProject.paths.stateDir, "proof-calls.jsonl");
    const repoTrail = path.join(repoProject.paths.stateDir, "proof-calls.jsonl");

    // Trail written in the SCENARIO state dir.
    expect(fs.existsSync(scenarioTrail)).toBe(true);
    // CHARACTERIZATION: repo state dir must NOT have a trail from these scenario calls.
    expect(fs.existsSync(repoTrail)).toBe(false);
  });

  it("repo-root state.json hash is unchanged after repeated MCP scenario calls", async () => {
    const repoStateBefore = fileHash(repoProject.paths.stateFile);

    process.env.CLAUDE_PROJECT_DIR = scenarioProject.root;

    // Multiple calls to exercise the route.
    await callTool("th_state_get", {});
    await callTool("th_state_get", {});

    const repoStateAfter = fileHash(repoProject.paths.stateFile);
    expect(repoStateAfter).toBe(repoStateBefore);
  });
});
