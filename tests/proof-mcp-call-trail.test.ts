/**
 * Phase C0 / AC #15 (C1·A1·A2) — the dedicated producer-side MCP call trail.
 *
 * The CallTool path (`callTool`, exported for exactly this kind of direct,
 * transport-free unit test) records `{tool,ts,ok,reason?}` in the DEDICATED
 * `<stateDir>/proof-calls.jsonl`. Per the #4/#5 fix the call is logged BEFORE
 * dispatch (`ok:true`, so a tool can count its own call), and a handler that
 * throws gets a CORRECTIVE catch-site record (`ok:false, reason:"threw"`). All
 * appends are best-effort (a logging failure never breaks the call) and decoupled
 * from the M3 telemetry opt-in (the trail records even with telemetry OFF). The
 * harvest consumer is `readProofCalls`.
 *
 * Note on the catch-branch case: no read-only handler throws deterministically
 * and quickly (a real throw would need a 25 s lock timeout), so the catch site is
 * exercised by injecting a throwing handler at the registry boundary for a single
 * call and restoring it. This tests the C0 INSTRUMENTATION's error path — not the
 * proof engine — so it does not violate the no-SUT-mocking invariant (AC #18).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { callTool, TOOL_DEFS, type ToolDef } from "../src/mcp-server";
import { readProofCalls } from "../src/core/proof/harvest";
import { runInit } from "../src/commands/init";
import { makeTempProject, type TempProject } from "./helpers";

describe("REQ-PROOF-C1: dedicated proof-calls.jsonl producer trail (C1/A1/A2)", () => {
  let tp: TempProject;
  let prevProjectDir: string | undefined;

  beforeEach(() => {
    tp = makeTempProject();
    // Real init → creates stateDir + a valid state.json (the post-init
    // precondition that holds for every real scenario root).
    runInit(tp.paths, {});
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    // resolvePathsForCall() reads CLAUDE_PROJECT_DIR per call, so this routes the
    // in-process tool calls (and their trail appends) to the isolated temp root.
    process.env.CLAUDE_PROJECT_DIR = tp.root;
  });

  afterEach(() => {
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    tp.cleanup();
  });

  it("success site appends {tool,ts,ok:true} for a real, non-throwing tool call", async () => {
    const res = await callTool("th_state_get", {});
    expect(res.isError).toBeFalsy();

    const calls = readProofCalls(tp.paths);
    const hit = calls.find((c) => c.tool === "th_state_get");
    expect(hit).toBeDefined();
    expect(hit!.ok).toBe(true);
    expect(typeof hit!.ts).toBe("string");
    expect(hit!.ts.length).toBeGreaterThan(0);
  });

  it("catch site appends a corrective {ok:false, reason:'threw'} record when a handler throws", async () => {
    const target = TOOL_DEFS.find((t) => t.name === "th_repo_map")!;
    const original = target.run;
    // `as const` makes TOOL_DEFS readonly at the type level only — the entries are
    // plain objects at runtime, so we can swap one handler and restore it.
    (target as { run: ToolDef["run"] }).run = () => {
      throw new Error("boom: injected to exercise the catch-site trail append");
    };
    try {
      const res = await callTool("th_repo_map", {});
      // The throw is mapped to a tool error, never crashing the call.
      expect(res.isError).toBe(true);
    } finally {
      (target as { run: ToolDef["run"] }).run = original;
    }

    // Per the #4/#5 fix the call is logged BEFORE dispatch (ok:true), then the catch
    // site appends a CORRECTIVE failure record — so a throwing call yields two entries
    // and the truthful outcome is the ok:false one carrying reason "threw".
    const repoMapCalls = readProofCalls(tp.paths).filter((c) => c.tool === "th_repo_map");
    expect(repoMapCalls.length).toBe(2);
    expect(repoMapCalls[0]).toMatchObject({ ok: true });
    expect(repoMapCalls[0].reason).toBeUndefined();
    expect(repoMapCalls[1]).toMatchObject({ ok: false, reason: "threw" });
  });

  it("trail is decoupled from the telemetry opt-in (M3): records with telemetry OFF", async () => {
    // makeTempProject + runInit leave telemetry default-OFF, so telemetry.jsonl is
    // never created — yet the dedicated trail still records the call.
    await callTool("th_state_get", {});

    expect(readProofCalls(tp.paths).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tp.paths.stateDir, "telemetry.jsonl"))).toBe(false);
  });

  it("best-effort: a failing append never breaks the tool call", async () => {
    // Remove the state dir so the append target's directory is gone; the call must
    // still resolve to a normal result and must not reject.
    fs.rmSync(tp.paths.stateDir, { recursive: true, force: true });

    const res = await callTool("th_state_get", {});
    expect(res).toBeDefined();
    // Append silently dropped (no dir), no crash, no trail.
    expect(readProofCalls(tp.paths)).toEqual([]);
  });
});
