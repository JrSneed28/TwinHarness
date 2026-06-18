/**
 * MCP adapter dispatch coverage — `callTool` happy-path + error-path.
 *
 * This replaces the dispatch coverage that the (now-removed) MCP call-trail
 * test contributed: it exercised `callTool`/`validateToolArgs` end-to-end. That
 * feature is gone, but the adapter dispatch must still be covered, so this
 * test pins the same `callTool` contract using a standard read tool:
 *   • happy path — a real, registered tool dispatches and maps to a non-error result;
 *   • error path — unknown tool, invalid arguments (schema reject), and a throwing
 *     handler are each mapped to a tool error, never an uncaught crash.
 *
 * `callTool` is exported for exactly this kind of direct, transport-free unit test
 * (no socket, no live MCP transport). `resolvePathsForCall()` reads
 * `CLAUDE_PROJECT_DIR` per call, so we route in-process calls at an isolated temp root.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { callTool, TOOL_DEFS, type ToolDef } from "../src/mcp-server";
import { runInit } from "../src/commands/init";
import { makeTempProject, type TempProject } from "./helpers";

describe("MCP callTool dispatch — happy-path + error-path (adapter coverage)", () => {
  let tp: TempProject;
  let prevProjectDir: string | undefined;

  beforeEach(() => {
    tp = makeTempProject();
    // Real init → creates stateDir + a valid state.json (the post-init precondition
    // that holds for every real scenario root).
    runInit(tp.paths, {});
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tp.root;
  });

  afterEach(() => {
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    tp.cleanup();
  });

  // ---- Happy path -----------------------------------------------------------
  it("dispatches a real registered read tool and maps it to a non-error result", async () => {
    const res = await callTool("th_state_get", {});
    expect(res.isError).toBeFalsy();
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.content.length).toBeGreaterThan(0);
    expect(res.content[0]).toMatchObject({ type: "text" });
  });

  it("threads valid args to the handler (dotted-path read returns a value)", async () => {
    const res = await callTool("th_state_get", { path: "tier" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]).toMatchObject({ type: "text" });
  });

  // ---- Error path -----------------------------------------------------------
  it("maps an unknown tool name to a tool error (never throws)", async () => {
    const res = await callTool("th_does_not_exist", {});
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("Unknown tool");
  });

  it("rejects invalid arguments via validateToolArgs before dispatch (wrong-typed value)", async () => {
    // `path` is a string property; a numeric value is a schema violation that the
    // closed inputSchema must reject as a tool error rather than passing to the handler.
    const res = await callTool("th_state_get", { path: 123 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("Invalid arguments");
  });

  it("rejects unknown extra arguments (additionalProperties:false closed schema)", async () => {
    const res = await callTool("th_state_get", { bogusUnknownFlag: true });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("Invalid arguments");
  });

  it("maps a throwing handler to a tool error (catch path), never crashing the call", async () => {
    const target = TOOL_DEFS.find((t) => t.name === "th_repo_map")!;
    const original = target.run;
    // `as const` makes TOOL_DEFS readonly at the type level only — the entries are
    // plain objects at runtime, so we can swap one handler and restore it.
    (target as { run: ToolDef["run"] }).run = () => {
      throw new Error("boom: injected to exercise the catch-site dispatch mapping");
    };
    try {
      const res = await callTool("th_repo_map", {});
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain("th_repo_map failed");
    } finally {
      (target as { run: ToolDef["run"] }).run = original;
    }
  });
});
