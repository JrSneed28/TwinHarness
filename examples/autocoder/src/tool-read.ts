/**
 * IF-001 read_file tool (REQ-006). Owner component: `tool-read`.
 *
 * Returns the full or a bounded `[startLine, startLine+lineCount)` slice of a
 * file. `read_file` is the ONLY effector permitted OUTSIDE the working root
 * (read-anywhere, RULE-003 / INV-002): it calls `PathSandbox.checkRead`, which is
 * always allowed, and never confines the path. A default line cap bounds the
 * payload; `truncated`/`totalLines` let the model request the next range.
 *
 * Failure mapping (ERR-006 READ_FAILED): file-not-found, is-a-directory, and
 * permission-denied all normalize to a `status:"error"` ToolResult — the tool
 * NEVER throws (RULE-008); the registry feeds the error back to the model.
 */
import fs from "node:fs/promises";
import type { PathSandbox, ToolCall, ToolResult } from "./contracts.js";

export interface ReadTool {
  readonly toolName: "read_file";
  execute(toolCall: ToolCall): Promise<ToolResult>;
}

/** Default cap on returned lines when no explicit `lineCount` is given. */
export const DEFAULT_LINE_CAP = 2000;

/** Parse a positive-integer arg (≥1); returns undefined if absent/invalid. */
function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

export function createReadTool(sandbox: PathSandbox): ReadTool {
  return {
    toolName: "read_file",
    async execute(toolCall: ToolCall): Promise<ToolResult> {
      const args = toolCall.arguments ?? {};
      const filePath = typeof args.path === "string" ? args.path : "";
      const startLine = positiveInt(args.startLine); // 1-based, optional
      const lineCount = positiveInt(args.lineCount); // optional

      if (filePath.length === 0) {
        return readFailed(toolCall.id, "path is required");
      }

      // Reads are always allowed (INV-002, read-anywhere — RULE-003). The sandbox
      // still resolves the canonical path so the read is recorded consistently.
      const verdict = sandbox.checkRead(filePath);
      const resolved = verdict.canonicalPath ?? filePath;

      let raw: string;
      try {
        const stat = await fs.stat(resolved);
        if (stat.isDirectory()) {
          // is-a-directory → READ_FAILED (ERR-006), not a throw.
          return readFailed(toolCall.id, `is a directory: ${filePath}`);
        }
        raw = await fs.readFile(resolved, "utf8");
      } catch (err) {
        // not-found / permission-denied / any read error → READ_FAILED (ERR-006).
        return readFailed(toolCall.id, (err as Error).message);
      }

      // Split into lines. A trailing newline does not add a phantom empty line for
      // counting purposes; we compute totalLines as the number of content lines.
      const allLines = splitLines(raw);
      const totalLines = allLines.length;

      // Determine the window. startLine defaults to 1 (the first line). The window
      // length is `lineCount` if given, else the default cap.
      const start0 = (startLine ?? 1) - 1; // 0-based start index
      const requested = lineCount ?? DEFAULT_LINE_CAP;
      // Clamp the window into the file. If start0 is past EOF, the slice is empty.
      const end0 = Math.min(start0 + requested, totalLines);
      const safeStart0 = Math.min(start0, totalLines);
      const windowLines = allLines.slice(safeStart0, end0);
      const content = windowLines.join("\n");

      // truncated == there is content BEYOND the returned window (the model can
      // request the next range). True iff the window does not reach EOF.
      const truncated = end0 < totalLines;

      return {
        toolCallId: toolCall.id,
        status: "ok",
        output: { content, truncated, totalLines },
      };
    },
  };
}

/** Split file content into logical lines, ignoring a single trailing newline. */
function splitLines(raw: string): string[] {
  if (raw.length === 0) {
    return [];
  }
  // Normalize CRLF so line indexing is stable cross-platform (REQ-NFR-007 spirit).
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  // A trailing newline yields a final empty element; drop it so totalLines is the
  // count of actual content lines (the model's mental model of "line N").
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Build a normalized READ_FAILED (ERR-006) error ToolResult (never a throw). */
function readFailed(toolCallId: string, message: string): ToolResult {
  return {
    toolCallId,
    status: "error",
    error: { code: "READ_FAILED", message: `read failed: ${message}` },
  };
}
