import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * HOOK-INVENTORY TRUTH (issue #9): hooks/hooks.json is the authoritative
 * runtime registry. This test asserts the COMPLETE canonical inventory —
 * all 9 event types and 11 command entries — so that any doc/runtime
 * divergence becomes a test failure rather than silent drift.
 *
 * Canonical inventory (from hooks/hooks.json):
 *   Stop                → hook stop-gate                          (1 entry)
 *   SubagentStop        → hook subagent-stop                      (1st entry)
 *   SubagentStop        → hook subagent-seal                      (2nd entry)
 *   PreToolUse(Write|Edit|NotebookEdit) → hook pretool-gate       (1 entry)
 *   PreToolUse(Bash)    → hook pretool-gate                       (1 entry)
 *   PostToolUse(Read|Grep|Glob|Bash|WebFetch|mcp__.*__.*) → hook posttool-context (1 entry)
 *   SessionStart        → hook session-context                    (1 entry)
 *   UserPromptSubmit    → hook prompt-context                     (1 entry)
 *   PreCompact          → hook precompact-seal                    (1 entry)
 *   SubagentStart       → hook subagent-context                   (1 entry)
 *   SessionEnd          → hook session-end                        (1 entry)
 *                                                         TOTAL: 11 entries
 */

const ROOT = path.resolve(__dirname, "..");
const readJson = (rel: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")) as Record<string, unknown>;

type HookEntry = { type: string; command: string };
type HookBlock = { matcher?: string; hooks: HookEntry[] };
type HooksJson = { hooks: Record<string, HookBlock[]> };

/** Extract all `hook <subcommand>` names from a command string. */
function hookSubcmd(command: string): string {
  const m = /hook\s+([\w-]+)/.exec(command);
  return m ? m[1]! : command;
}

describe("HOOK-INVENTORY: hooks/hooks.json matches canonical inventory", () => {
  const hooksJson = readJson("hooks/hooks.json") as HooksJson;
  const h = hooksJson.hooks;

  // -------------------------------------------------------------------------
  // 9 event types must be present
  // -------------------------------------------------------------------------
  it("registers exactly 9 distinct hook event types", () => {
    const eventTypes = Object.keys(h);
    const expected = [
      "Stop",
      "SubagentStop",
      "PreToolUse",
      "PostToolUse",
      "SessionStart",
      "UserPromptSubmit",
      "PreCompact",
      "SubagentStart",
      "SessionEnd",
    ];
    expect(eventTypes.sort()).toEqual(expected.sort());
  });

  // -------------------------------------------------------------------------
  // Stop → stop-gate (1 entry)
  // -------------------------------------------------------------------------
  it("Stop: exactly 1 entry → hook stop-gate", () => {
    expect(h.Stop).toHaveLength(1);
    const cmd = h.Stop[0]?.hooks[0];
    expect(cmd?.type).toBe("command");
    expect(hookSubcmd(cmd?.command ?? "")).toBe("stop-gate");
  });

  // -------------------------------------------------------------------------
  // SubagentStop → 2 entries: subagent-stop AND subagent-seal
  // -------------------------------------------------------------------------
  it("SubagentStop: exactly 2 entries", () => {
    expect(h.SubagentStop).toHaveLength(2);
  });

  it("SubagentStop[0] → hook subagent-stop", () => {
    const cmd = h.SubagentStop?.[0]?.hooks[0];
    expect(cmd?.type).toBe("command");
    expect(hookSubcmd(cmd?.command ?? "")).toBe("subagent-stop");
  });

  it("SubagentStop[1] → hook subagent-seal", () => {
    const cmd = h.SubagentStop?.[1]?.hooks[0];
    expect(cmd?.type).toBe("command");
    expect(hookSubcmd(cmd?.command ?? "")).toBe("subagent-seal");
  });

  // -------------------------------------------------------------------------
  // PreToolUse → 2 entries: Write|Edit|NotebookEdit and Bash
  // -------------------------------------------------------------------------
  it("PreToolUse: exactly 2 entries", () => {
    expect(h.PreToolUse).toHaveLength(2);
  });

  it("PreToolUse: entry with matcher 'Write|Edit|NotebookEdit' → hook pretool-gate", () => {
    const entry = h.PreToolUse?.find((e) => e.matcher === "Write|Edit|NotebookEdit");
    expect(entry, "missing PreToolUse entry with matcher Write|Edit|NotebookEdit").toBeDefined();
    const cmd = entry?.hooks[0];
    expect(cmd?.type).toBe("command");
    expect(hookSubcmd(cmd?.command ?? "")).toBe("pretool-gate");
  });

  it("PreToolUse: entry with matcher 'Bash' → hook pretool-gate", () => {
    const entry = h.PreToolUse?.find((e) => e.matcher === "Bash");
    expect(entry, "missing PreToolUse entry with matcher Bash").toBeDefined();
    const cmd = entry?.hooks[0];
    expect(cmd?.type).toBe("command");
    expect(hookSubcmd(cmd?.command ?? "")).toBe("pretool-gate");
  });

  // -------------------------------------------------------------------------
  // PostToolUse → 1 entry: Read|Grep|Glob|Bash|WebFetch|mcp__.*__.*
  // -------------------------------------------------------------------------
  it("PostToolUse: exactly 1 entry → hook posttool-context", () => {
    expect(h.PostToolUse).toHaveLength(1);
    const entry = h.PostToolUse?.[0];
    expect(entry?.matcher).toBe("Read|Grep|Glob|Bash|WebFetch|mcp__.*__.*");
    const cmd = entry?.hooks[0];
    expect(cmd?.type).toBe("command");
    expect(hookSubcmd(cmd?.command ?? "")).toBe("posttool-context");
  });

  // -------------------------------------------------------------------------
  // SessionStart → 1 entry: session-context
  // -------------------------------------------------------------------------
  it("SessionStart: exactly 1 entry → hook session-context", () => {
    expect(h.SessionStart).toHaveLength(1);
    const cmd = h.SessionStart?.[0]?.hooks[0];
    expect(cmd?.type).toBe("command");
    expect(hookSubcmd(cmd?.command ?? "")).toBe("session-context");
  });

  // -------------------------------------------------------------------------
  // UserPromptSubmit → 1 entry: prompt-context
  // -------------------------------------------------------------------------
  it("UserPromptSubmit: exactly 1 entry → hook prompt-context", () => {
    expect(h.UserPromptSubmit).toHaveLength(1);
    const cmd = h.UserPromptSubmit?.[0]?.hooks[0];
    expect(cmd?.type).toBe("command");
    expect(hookSubcmd(cmd?.command ?? "")).toBe("prompt-context");
  });

  // -------------------------------------------------------------------------
  // PreCompact → 1 entry: precompact-seal
  // -------------------------------------------------------------------------
  it("PreCompact: exactly 1 entry → hook precompact-seal", () => {
    expect(h.PreCompact).toHaveLength(1);
    const cmd = h.PreCompact?.[0]?.hooks[0];
    expect(cmd?.type).toBe("command");
    expect(hookSubcmd(cmd?.command ?? "")).toBe("precompact-seal");
  });

  // -------------------------------------------------------------------------
  // SubagentStart → 1 entry: subagent-context
  // -------------------------------------------------------------------------
  it("SubagentStart: exactly 1 entry → hook subagent-context", () => {
    expect(h.SubagentStart).toHaveLength(1);
    const cmd = h.SubagentStart?.[0]?.hooks[0];
    expect(cmd?.type).toBe("command");
    expect(hookSubcmd(cmd?.command ?? "")).toBe("subagent-context");
  });

  // -------------------------------------------------------------------------
  // SessionEnd → 1 entry: session-end
  // -------------------------------------------------------------------------
  it("SessionEnd: exactly 1 entry → hook session-end", () => {
    expect(h.SessionEnd).toHaveLength(1);
    const cmd = h.SessionEnd?.[0]?.hooks[0];
    expect(cmd?.type).toBe("command");
    expect(hookSubcmd(cmd?.command ?? "")).toBe("session-end");
  });

  // -------------------------------------------------------------------------
  // Total command entry count: 11
  // -------------------------------------------------------------------------
  it("total hook command entries is 11 across all event types", () => {
    const total = Object.values(h).reduce((sum, blocks) => sum + blocks.length, 0);
    expect(total).toBe(11);
  });
});
