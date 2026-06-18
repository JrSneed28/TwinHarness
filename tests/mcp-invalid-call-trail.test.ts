/**
 * Finding #5 — Unknown tools and invalid arguments are now RECORDED in proof-calls.jsonl.
 *
 * FIXED BEHAVIOR (was a bug): callTool() records an attempted call BEFORE returning
 * on the unknown-tool and invalid-args guard paths (src/mcp-server.ts callTool):
 *   - Unknown-tool attempts  → { ok:false, reason:"unknown_tool" }
 *   - Invalid-arg attempts   → { ok:false, reason:"invalid_args" }
 * So an operator auditing the trail can see what the Orchestrator TRIED to invoke,
 * not only the calls that dispatched cleanly.
 *
 * Under the OLD code both guards returned BEFORE the appendProofCall block, so the
 * failed calls left no trace.
 *
 * THIS TEST PINS THE FIXED BEHAVIOR: failed validation still returns isError:true,
 * AND proof-calls.jsonl now carries an ok:false entry (with a reason) for it.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempProject, type TempProject } from "./helpers";
import { runInit } from "../src/commands/init";
import { callTool } from "../src/mcp-server";
import { readProofCalls } from "../src/core/proof/harvest";

describe("Finding #5: invalid MCP calls are recorded in proof-calls.jsonl (regression — pins FIXED behavior)", () => {
  let tp: TempProject;
  let prevProjectDir: string | undefined;

  beforeEach(() => {
    tp = makeTempProject();
    runInit(tp.paths, {});
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tp.root;
  });

  afterEach(() => {
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    tp.cleanup();
  });

  it("unknown tool returns isError:true and writes an ok:false { reason:'unknown_tool' } entry", async () => {
    const res = await callTool("th_nonexistent_tool", {});

    expect(res.isError).toBe(true);
    expect((res.content[0] as { type: "text"; text: string }).text).toContain("th_nonexistent_tool");

    // FIXED: the attempted unknown-tool call is now recorded before the early return.
    const trailPath = path.join(tp.paths.stateDir, "proof-calls.jsonl");
    expect(fs.existsSync(trailPath)).toBe(true);

    const calls = readProofCalls(tp.paths);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("th_nonexistent_tool");
    expect(calls[0].ok).toBe(false);
    expect(calls[0].reason).toBe("unknown_tool");
  });

  it("invalid arguments (missing required property) return isError:true and write an ok:false { reason:'invalid_args' } entry", async () => {
    // th_state_set requires both "key" and "value"; an empty object trips the guard.
    const res = await callTool("th_state_set", {});

    expect(res.isError).toBe(true);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("th_state_set");
    expect(text.toLowerCase()).toContain("missing");

    // FIXED: the rejected-args attempt is now recorded.
    const calls = readProofCalls(tp.paths);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("th_state_set");
    expect(calls[0].ok).toBe(false);
    expect(calls[0].reason).toBe("invalid_args");
  });

  it("invalid arguments (extra unknown property) return isError:true and write an ok:false { reason:'invalid_args' } entry", async () => {
    // th_state_get accepts no properties (additionalProperties:false).
    const res = await callTool("th_state_get", { bogus_param: "should_be_rejected" } as Record<string, unknown>);

    expect(res.isError).toBe(true);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    expect(text.toLowerCase()).toContain("unknown property");

    const calls = readProofCalls(tp.paths);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("th_state_get");
    expect(calls[0].ok).toBe(false);
    expect(calls[0].reason).toBe("invalid_args");
  });

  it("a successful call followed by an unknown-tool call: BOTH appear in the trail", async () => {
    const goodRes = await callTool("th_state_get", {});
    expect(goodRes.isError).toBeFalsy();

    const badRes = await callTool("th_completely_unknown", {});
    expect(badRes.isError).toBe(true);

    const calls = readProofCalls(tp.paths);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ tool: "th_state_get", ok: true });
    expect(calls[0].reason).toBeUndefined();
    expect(calls[1]).toMatchObject({ tool: "th_completely_unknown", ok: false, reason: "unknown_tool" });
  });

  it("a successful call followed by an invalid-args call: BOTH appear in the trail", async () => {
    await callTool("th_state_get", {});

    // th_tier_record requires "tier"; an empty object trips the invalid-args guard.
    const badRes = await callTool("th_tier_record", {});
    expect(badRes.isError).toBe(true);

    const calls = readProofCalls(tp.paths);
    expect(calls.filter((c) => c.tool === "th_state_get")).toHaveLength(1);
    const tierCalls = calls.filter((c) => c.tool === "th_tier_record");
    expect(tierCalls).toHaveLength(1);
    expect(tierCalls[0]).toMatchObject({ ok: false, reason: "invalid_args" });
  });
});
