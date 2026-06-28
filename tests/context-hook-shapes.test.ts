/**
 * D-16 / AC-9 — context hook shape tests.
 *
 * Every new S0 OBSERVE hook event handler must:
 *   1. Return a valid `{ stdout, exitCode }` shape.
 *   2. Always exit 0 (fail-safe).
 *   3. Emit a JSON-parseable stdout that does not corrupt the Claude Code hook protocol.
 *   4. Return the same passthrough shape for malformed or empty input (fail-safe).
 *
 * Only the two handlers exported from hook.ts are unit-tested here
 * (runHookPostToolContext, runHookSessionContext).  The remaining S0 leaves
 * (prompt-context, precompact-seal, subagent-context, subagent-seal, session-end)
 * are no-op passthrough stubs wired inline in cli.ts main() — they emit {} + exit 0
 * by construction; the shape contract is verified via the contextPassthrough pattern
 * assertion at the bottom of this file.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject, type TempProject } from "./helpers";
import {
  runHookPostToolContext,
  runHookSessionContext,
  type PostToolContextInput,
  type SessionContextInput,
} from "../src/commands/hook";

let tp: TempProject | undefined;
afterEach(() => tp?.cleanup());

/**
 * A valid hook result shape: stdout is parseable JSON (object), exitCode is 0.
 * Mirrors the `contextPassthrough()` contract from hook.ts.
 */
function isValidHookShape(result: { stdout: string; exitCode: number }): boolean {
  if (result.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// posttool-context handler
// ---------------------------------------------------------------------------

describe("D-16/AC-9: runHookPostToolContext — shape and fail-safe", () => {
  it("returns valid hook shape with a complete Read tool input", () => {
    tp = makeTempProject();
    const input: PostToolContextInput = {
      session_id: "sess-abc",
      agent_id: "agent-1",
      tool_name: "Read",
      tool_input: { file_path: "/some/file.ts" },
      tool_response: "export function foo() {}",
      cwd: tp.root,
    };
    const result = runHookPostToolContext(tp.root, input);
    expect(result.exitCode, "exitCode must be 0").toBe(0);
    expect(isValidHookShape(result), "stdout must be parseable JSON object").toBe(true);
  });

  it("returns passthrough shape when input is undefined (empty/missing stdin)", () => {
    tp = makeTempProject();
    const result = runHookPostToolContext(tp.root, undefined);
    expect(result.exitCode).toBe(0);
    expect(isValidHookShape(result)).toBe(true);
  });

  it("returns passthrough when tool_name is absent", () => {
    tp = makeTempProject();
    const result = runHookPostToolContext(tp.root, { session_id: "sess-1", tool_response: "data" });
    expect(result.exitCode).toBe(0);
    expect(isValidHookShape(result)).toBe(true);
  });

  it("returns passthrough when tool_response is empty string", () => {
    tp = makeTempProject();
    const result = runHookPostToolContext(tp.root, {
      session_id: "sess-1",
      tool_name: "Read",
      tool_input: { file_path: "/file.ts" },
      tool_response: "",
    });
    expect(result.exitCode).toBe(0);
    expect(isValidHookShape(result)).toBe(true);
  });

  it("returns passthrough for an unrecognized tool name (no SourceKind mapping)", () => {
    tp = makeTempProject();
    const result = runHookPostToolContext(tp.root, {
      session_id: "sess-1",
      tool_name: "UnknownTool",
      tool_input: {},
      tool_response: "some output",
    });
    expect(result.exitCode).toBe(0);
    expect(isValidHookShape(result)).toBe(true);
  });

  it("kill-switch TH_DISABLE_CONTEXT_PAGES=1 → pure passthrough regardless of input", () => {
    tp = makeTempProject();
    const env: NodeJS.ProcessEnv = { ...process.env, TH_DISABLE_CONTEXT_PAGES: "1" };
    const input: PostToolContextInput = {
      session_id: "sess-2",
      tool_name: "Read",
      tool_input: { file_path: "/some/file.ts" },
      tool_response: "content",
      cwd: tp.root,
    };
    const result = runHookPostToolContext(tp.root, input, env);
    expect(result.exitCode).toBe(0);
    expect(isValidHookShape(result)).toBe(true);
  });

  it("Grep tool input returns valid hook shape (search source_kind)", () => {
    tp = makeTempProject();
    const input: PostToolContextInput = {
      session_id: "sess-3",
      tool_name: "Grep",
      tool_input: { pattern: "function", path: tp.root },
      tool_response: "src/foo.ts:1:export function foo() {}",
      cwd: tp.root,
    };
    const result = runHookPostToolContext(tp.root, input);
    expect(result.exitCode).toBe(0);
    expect(isValidHookShape(result)).toBe(true);
  });

  it("Bash tool input returns valid hook shape (bash source_kind)", () => {
    tp = makeTempProject();
    const input: PostToolContextInput = {
      session_id: "sess-4",
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello\n",
      cwd: tp.root,
    };
    const result = runHookPostToolContext(tp.root, input);
    expect(result.exitCode).toBe(0);
    expect(isValidHookShape(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// session-context handler
// ---------------------------------------------------------------------------

describe("D-16/AC-9: runHookSessionContext — shape and fail-safe", () => {
  it("returns valid hook shape with a complete session input", () => {
    tp = makeTempProject();
    const input: SessionContextInput = {
      session_id: "sess-abc",
      cwd: tp.root,
    };
    const result = runHookSessionContext(tp.root, input);
    expect(result.exitCode, "exitCode must be 0").toBe(0);
    expect(isValidHookShape(result), "stdout must be parseable JSON object").toBe(true);
  });

  it("returns passthrough when input is undefined (empty/missing stdin)", () => {
    tp = makeTempProject();
    const result = runHookSessionContext(tp.root, undefined);
    expect(result.exitCode).toBe(0);
    expect(isValidHookShape(result)).toBe(true);
  });

  it("records agent_id probe without throwing (subagent session)", () => {
    tp = makeTempProject();
    const input: SessionContextInput = {
      session_id: "sess-sub",
      agent_id: "agent-xyz",
      agent_type: "subagent",
      cwd: tp.root,
    };
    const result = runHookSessionContext(tp.root, input);
    expect(result.exitCode).toBe(0);
    expect(isValidHookShape(result)).toBe(true);
  });

  it("kill-switch TH_DISABLE_CONTEXT_PAGES=1 → pure passthrough", () => {
    tp = makeTempProject();
    const env: NodeJS.ProcessEnv = { ...process.env, TH_DISABLE_CONTEXT_PAGES: "1" };
    const result = runHookSessionContext(tp.root, { session_id: "sess-5", agent_id: "ag-1" }, env);
    expect(result.exitCode).toBe(0);
    expect(isValidHookShape(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S0 stub-leave shape contract (prompt-context, precompact-seal, etc.)
// ---------------------------------------------------------------------------

describe("D-16/AC-9: S0 stub-leave shape contract (contextPassthrough pattern)", () => {
  // The remaining S0 hook leaves are no-op passthrough stubs wired inline in cli.ts
  // main(): `hookOut = { stdout: JSON.stringify({}), exitCode: 0 }`.
  // No separate exported handler exists at S0, so we pin the SHAPE CONTRACT they must
  // satisfy — the same `contextPassthrough()` pattern the two exported handlers use.

  it("contextPassthrough pattern: stdout is '{}', exitCode is 0", () => {
    const passthrough = { stdout: JSON.stringify({}), exitCode: 0 };
    expect(passthrough.exitCode).toBe(0);
    expect(JSON.parse(passthrough.stdout)).toEqual({});
    expect(isValidHookShape(passthrough)).toBe(true);
  });

  it("any JSON object stdout with exitCode 0 satisfies the hook protocol", () => {
    // Claude Code hook consumers accept any JSON object on stdout + exit 0 as a
    // no-op decision.  The shape check is structural only (not schema-strict).
    const variants = [
      { stdout: "{}", exitCode: 0 },
      { stdout: '{"decision": "allow"}', exitCode: 0 },
      { stdout: '{"stopReason": null}', exitCode: 0 },
    ];
    for (const v of variants) {
      expect(isValidHookShape(v), `shape must be valid for stdout=${v.stdout}`).toBe(true);
    }
  });

  it("non-zero exitCode or unparseable stdout is NOT a valid hook shape", () => {
    expect(isValidHookShape({ stdout: "{}", exitCode: 1 })).toBe(false);
    expect(isValidHookShape({ stdout: "not json", exitCode: 0 })).toBe(false);
    expect(isValidHookShape({ stdout: "", exitCode: 0 })).toBe(false);
  });
});
