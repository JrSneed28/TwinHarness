/**
 * IF-008 ToolRegistry (REQ-005) — the fixed FIVE-tool surface (RULE-012); exactly
 * one normalized ToolResult per dispatch (INV-008); unknown tool name → an
 * `UNKNOWN_TOOL` error ToolResult (ERR-005), never a throw (RULE-008).
 *
 * SLICE-2 (real loop over the stubbed model): the registry now exposes all five
 * tool schemas and dispatches each ToolCall to its executor. The real tool
 * bodies arrive in later slices — until then the not-yet-built tools register
 * STUB executors that return a typed `status:"error"` ToolResult (so the loop
 * keeps running; RULE-008).
 *
 * SLICE-3 (REQ-006 / REQ-007): `read_file` and `list_search` now have REAL bodies
 * (`tool-read` / `tool-search`); the remaining three (write/run/patch) stay stubbed
 * until their own slices. `list_search` is wired via the optional `searchTool`
 * param (defaulting to the stub preserves earlier single-arg call sites).
 *
 * SLICE-4 (REQ-008/010/011/021): `write_edit` now has a REAL body (`tool-writeedit`)
 * wired via the optional `writeEditTool` param (defaulting to the stub preserves
 * earlier call sites). A `UserAbortError` raised by `write_edit` (user aborted at an
 * approval prompt) is RE-RAISED like a fatal — NOT normalized to a ToolResult — so
 * the run can terminate as a CLEAN `user-abort` StopCondition (classified Stopped,
 * not Failed; the StopCondition classifier is SLICE-7). The remaining two
 * (run/patch) stay stubbed until their slices.
 *
 * SLICE-5 (REQ-009/013/021 exec-side): `run_command` now has a REAL body
 * (`tool-runcommand`) wired via the optional `runCommandTool` param (defaulting to the
 * stub preserves earlier call sites). Like `write_edit`, a `UserAbortError` it raises
 * (user aborted at a command-approval prompt) is RE-RAISED (clean Stopped), and a
 * non-zero exit is NOT an error — the tool returns it as a `status:"ok"` ToolResult.
 *
 * SLICE-6 (REQ-023): `apply_patch` now has a REAL body (`tool-applypatch`) wired via
 * the optional `applyPatchTool` param (defaulting to the stub preserves earlier call
 * sites). It is the LAST stub replaced — all five tools now have real executors at the
 * registry seam. Atomicity (RULE-013 / INV-007) is enforced inside the tool; like the
 * other mutating tools its `UserAbortError` (user aborted the patch approval) is
 * RE-RAISED (clean Stopped, not normalized).
 *
 * Normalization contract (RULE-008 / INV-008):
 *  - unknown tool name           → UNKNOWN_TOOL error ToolResult (no throw)
 *  - malformed arguments         → the tool's typed error ToolResult (no throw)
 *  - an executor that *throws* an EXPECTED failure is caught and normalized to an
 *    error ToolResult; only a FATAL class (invariant breach / transcript write
 *    failure) is re-raised to the agent-run unrecoverable-error path (the FATAL
 *    classifier is SLICE-7 — here we just propagate the marked class).
 */
import type {
  ToolCall,
  ToolName,
  ToolRegistry,
  ToolResult,
  ToolSchema,
} from "./contracts.js";
import type { ReadTool } from "./tool-read.js";
import type { SearchTool } from "./tool-search.js";
import type { WriteEditTool } from "./tool-writeedit.js";
import type { RunCommandTool } from "./tool-runcommand.js";
import type { ApplyPatchTool } from "./tool-applypatch.js";
import { isFatalToolError, isUserAbortError } from "./tool-errors.js";

interface ToolExecutor {
  execute(toolCall: ToolCall): Promise<ToolResult>;
}

/** The five model-facing tool schemas (RULE-012) — attached to LlmClient.send. */
const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "read_file",
    description: "Read a file from the filesystem (may resolve outside the working root).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        startLine: { type: "integer", minimum: 1 },
        lineCount: { type: "integer", minimum: 1 },
      },
      required: ["path"],
    },
  },
  {
    name: "list_search",
    description: "List a directory or search file contents within the working root.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["list", "search"] },
        path: { type: "string", minLength: 1 },
        glob: { type: "string", minLength: 1 },
        query: { type: "string", minLength: 1 },
        isRegex: { type: "boolean" },
        maxResults: { type: "integer", minimum: 1, maximum: 2000 },
      },
      required: ["mode"],
    },
  },
  {
    name: "write_edit",
    description:
      "Create a new file (mode=write, full content) or modify one (mode=replace, search/replacement) within the working root; gated by ApprovalGate and confined by PathSandbox.",
    inputSchema: {
      type: "object",
      properties: {
        targetPath: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["write", "replace"] },
        content: { type: "string" },
        search: { type: "string", minLength: 1 },
        replacement: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      required: ["targetPath", "mode"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the working root (gated by ApprovalGate + allowlist).",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
      },
      required: ["command"],
    },
  },
  {
    name: "apply_patch",
    description: "Apply a unified diff atomically (gated by ApprovalGate).",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "string", minLength: 1 },
      },
      required: ["patch"],
    },
  },
];

/** The exact set of valid tool names (RULE-012). */
const VALID_TOOL_NAMES: ReadonlySet<string> = new Set<ToolName>([
  "read_file",
  "list_search",
  "write_edit",
  "run_command",
  "apply_patch",
]);

/**
 * A SLICE-2 stub executor for a not-yet-built tool. It returns a typed
 * `status:"error"` ToolResult (RULE-008) so the loop continues — the real body
 * lands in the tool's own slice. `code` is the tool's "not yet implemented"
 * marker, not a fatal class.
 */
function createStubExecutor(toolName: ToolName, code: string): ToolExecutor {
  return {
    async execute(toolCall: ToolCall): Promise<ToolResult> {
      return {
        toolCallId: toolCall.id,
        status: "error",
        error: {
          code,
          message: `${toolName} is not implemented yet (stub executor — body lands in a later slice).`,
        },
      };
    },
  };
}

/**
 * Build the registry. `read_file` (ReadTool) and — when provided — `list_search`
 * (SearchTool) use REAL bodies (SLICE-3, REQ-006/007); the remaining tools register
 * stub executors until their slices build real bodies. `searchTool` is optional so
 * pre-SLICE-3 single-arg call sites keep their stubbed `list_search`.
 */
export function createToolRegistry(
  readTool: ReadTool,
  searchTool?: SearchTool,
  writeEditTool?: WriteEditTool,
  runCommandTool?: RunCommandTool,
  applyPatchTool?: ApplyPatchTool,
): ToolRegistry {
  const executors = new Map<ToolName, ToolExecutor>();
  executors.set("read_file", readTool);
  executors.set(
    "list_search",
    searchTool ?? createStubExecutor("list_search", "LIST_SEARCH_NOT_IMPLEMENTED"),
  );
  executors.set(
    "write_edit",
    writeEditTool ?? createStubExecutor("write_edit", "WRITE_EDIT_NOT_IMPLEMENTED"),
  );
  executors.set(
    "run_command",
    runCommandTool ?? createStubExecutor("run_command", "RUN_COMMAND_NOT_IMPLEMENTED"),
  );
  executors.set(
    "apply_patch",
    applyPatchTool ?? createStubExecutor("apply_patch", "APPLY_PATCH_NOT_IMPLEMENTED"),
  );

  return {
    schemas(): ToolSchema[] {
      // Exactly the five tool schemas (RULE-012). Return a copy so callers
      // cannot mutate the canonical surface.
      return TOOL_SCHEMAS.map((s) => s);
    },
    async dispatch(toolCall: ToolCall): Promise<ToolResult> {
      // Unknown tool name (not one of the five) → UNKNOWN_TOOL error (ERR-005).
      if (!VALID_TOOL_NAMES.has(toolCall.toolName as string)) {
        return {
          toolCallId: toolCall.id,
          status: "error",
          error: {
            code: "UNKNOWN_TOOL",
            message: `unknown tool: ${String(toolCall.toolName)}`,
          },
        };
      }

      const executor = executors.get(toolCall.toolName);
      // Defensive: a valid name with no executor still normalizes (never a throw).
      if (!executor) {
        return {
          toolCallId: toolCall.id,
          status: "error",
          error: {
            code: "UNKNOWN_TOOL",
            message: `no executor registered for tool: ${toolCall.toolName}`,
          },
        };
      }

      try {
        return await executor.execute(toolCall);
      } catch (err) {
        // A FATAL class (invariant breach / transcript write failure) is
        // re-raised to the agent-run unrecoverable-error path — never swallowed.
        if (isFatalToolError(err)) {
          throw err;
        }
        // A USER-ABORT (the user aborted at an approval prompt) is likewise
        // RE-RAISED, NOT normalized — but it is a CLEAN stop (user-abort
        // StopCondition → Stopped, not Failed; the classifier is SLICE-7).
        if (isUserAbortError(err)) {
          throw err;
        }
        // An EXPECTED throw is normalized to a typed error ToolResult (RULE-008).
        return {
          toolCallId: toolCall.id,
          status: "error",
          error: {
            code: "TOOL_EXECUTION_ERROR",
            message: `tool ${toolCall.toolName} failed: ${(err as Error).message}`,
          },
        };
      }
    },
  };
}
