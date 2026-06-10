/**
 * IF-003 write_edit tool (REQ-008, REQ-011, REQ-021). Owner component:
 * `tool-writeedit`.
 *
 * Creates a file (whole-file `write`) or modifies one (targeted `replace`) within
 * the WorkingRoot. EVERY mutation flows through a FIXED order (RULE-001/002/004) —
 * skipping any step is an invariant breach:
 *
 *   1. checkWrite   — `path-sandbox.checkWrite` confines the target; out-of-root
 *                     (traversal / absolute / symlink) → PATH_ESCAPE (ERR-001),
 *                     FAIL-CLOSED, before any other step (RULE-001).
 *   2. generateDiff — `diff-engine.generateDiff` produces the unified Diff for the
 *                     Edit (no silent writes — RULE-002, INV-003).
 *   3. resolveEdit  — `approval-gate.resolveEdit` gates the Edit by the edit policy
 *                     (confirm-each default / auto); denied → APPROVAL_DENIED
 *                     (ERR-004), abort → UserAbortError (clean Stopped).
 *   4. persist      — only after approval is the file written to disk (durable —
 *                     fsync) so subsequent reads/commands see the new state (REQ-011).
 *
 * replace-mode occurrence checks happen BEFORE the Diff/approval (no Edit is
 * produced on a bad match): 0 matches → SEARCH_NOT_FOUND (ERR-002); >1 match with
 * `replaceAll:false` → SEARCH_AMBIGUOUS (ERR-003, count reported).
 *
 * All failures are normalized to `status:"error"` ToolResults — the tool NEVER
 * throws (RULE-008) EXCEPT the two propagating classes: a `FatalToolError`
 * (INV-003 diff-less Edit) and a `UserAbortError` (clean user-abort StopCondition);
 * both are re-raised by the registry rather than normalized.
 *
 * Residuals (documented, not eliminated): the check-then-write window is a TOCTOU
 * gap (a symlink could be swapped between checkWrite and the write) and concurrent
 * external mutation is LAST-WRITE-WINS (no run lock in the MVP — HUMAN-CONFIRMED).
 */
import fs from "node:fs/promises";
import nodePath from "node:path";
import type {
  ApprovalGate,
  Edit,
  EditApprovalPolicy,
  PathSandbox,
  ToolCall,
  ToolResult,
  TranscriptWriter,
} from "./contracts.js";
import { SCHEMA_VERSION } from "./contracts.js";
import { generateDiff } from "./diff-engine.js";
import { UserAbortError } from "./tool-errors.js";

export interface WriteEditTool {
  readonly toolName: "write_edit";
  execute(toolCall: ToolCall): Promise<ToolResult>;
}

export interface WriteEditDeps {
  sandbox: PathSandbox;
  approval: ApprovalGate;
  /** The resolved edit policy (default confirm-each). */
  policy: EditApprovalPolicy;
  /** Optional transcript sink for edit-proposed / edit-applied / edit-rejected. */
  transcript?: TranscriptWriter;
  runId?: string;
  now?: () => string;
  /** Injectable persist seam (default: durable fsync write). Lets tests force IO failure. */
  persist?: (canonicalPath: string, contents: string) => Promise<void>;
}

/** Durable write: create parent dirs, write the file, fsync (REQ-011 crash-survival). */
async function durablePersist(canonicalPath: string, contents: string): Promise<void> {
  await fs.mkdir(nodePath.dirname(canonicalPath), { recursive: true });
  // Open for write+truncate, write all bytes, fsync the data, then close. The fsync
  // makes an applied edit survive a crash (REQ-011 / Crash-Restart-Recovery).
  const handle = await fs.open(canonicalPath, "w");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Read the current contents of a file, or null if it does not exist. */
async function readBefore(canonicalPath: string): Promise<string | null> {
  try {
    return await fs.readFile(canonicalPath, "utf8");
  } catch {
    return null; // not-found → new file (before = null)
  }
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Replace the first / all occurrence(s) of `search` with `replacement` (literal). */
function applyReplace(source: string, search: string, replacement: string, all: boolean): string {
  if (all) {
    return source.split(search).join(replacement);
  }
  const idx = source.indexOf(search);
  if (idx === -1) return source;
  return source.slice(0, idx) + replacement + source.slice(idx + search.length);
}

export function createWriteEditTool(deps: WriteEditDeps): WriteEditTool {
  const persist = deps.persist ?? durablePersist;
  const now = deps.now ?? (() => new Date().toISOString());

  async function emit(
    type: "edit-proposed" | "edit-applied" | "edit-rejected",
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!deps.transcript || !deps.runId) return;
    await deps.transcript.append({
      schemaVersion: SCHEMA_VERSION,
      ts: now(),
      runId: deps.runId,
      type,
      payload,
    });
  }

  return {
    toolName: "write_edit",
    async execute(toolCall: ToolCall): Promise<ToolResult> {
      const args = toolCall.arguments ?? {};
      const targetPath = typeof args.targetPath === "string" ? args.targetPath : "";
      const mode = args.mode === "replace" ? "replace" : args.mode === "write" ? "write" : undefined;

      if (targetPath.length === 0) {
        return errorResult(toolCall.id, "WRITE_FAILED", "targetPath is required (min length 1)");
      }
      if (!mode) {
        return errorResult(toolCall.id, "WRITE_FAILED", `mode must be "write" or "replace"`);
      }

      // ---- STEP 1: checkWrite — confinement FAIL-CLOSED before any other step ----
      // (RULE-001). Out-of-root traversal / absolute / symlink / unresolvable →
      // PATH_ESCAPE (ERR-001); no Diff, no approval, no write.
      const verdict = deps.sandbox.checkWrite(targetPath);
      if (!verdict.allowed || !verdict.canonicalPath) {
        return errorResult(
          toolCall.id,
          "PATH_ESCAPE",
          verdict.reason?.message ?? `path escapes root: ${targetPath}`,
        );
      }
      const canonicalPath = verdict.canonicalPath;

      // Read the current state to compute `before` and (for replace) match counts.
      const before = await readBefore(canonicalPath);

      // Compute the `after` contents per mode (no Edit yet if a replace mis-matches).
      let after: string;
      if (mode === "write") {
        const content = typeof args.content === "string" ? args.content : undefined;
        if (content === undefined) {
          return errorResult(toolCall.id, "WRITE_FAILED", `content is required for mode="write"`);
        }
        after = content;
      } else {
        const search = typeof args.search === "string" ? args.search : "";
        const replacement = typeof args.replacement === "string" ? args.replacement : undefined;
        const replaceAll = args.replaceAll === true;
        if (search.length < 1) {
          return errorResult(toolCall.id, "SEARCH_NOT_FOUND", `search is required for mode="replace" (min length 1)`);
        }
        if (replacement === undefined) {
          return errorResult(toolCall.id, "WRITE_FAILED", `replacement is required for mode="replace"`);
        }
        const source = before ?? "";
        const matches = countOccurrences(source, search);
        // 0 matches → SEARCH_NOT_FOUND, no Edit (ERR-002).
        if (matches === 0) {
          return errorResult(toolCall.id, "SEARCH_NOT_FOUND", `search not found in ${targetPath}`);
        }
        // >1 match without replaceAll → SEARCH_AMBIGUOUS (count reported), no Edit (ERR-003).
        if (matches > 1 && !replaceAll) {
          return errorResult(
            toolCall.id,
            "SEARCH_AMBIGUOUS",
            `search occurs ${matches} times in ${targetPath} (set replaceAll or narrow the search)`,
          );
        }
        after = applyReplace(source, search, replacement, replaceAll);
      }

      // ---- STEP 2: generateDiff — every mutation carries a Diff (RULE-002) -------
      const diff = generateDiff(before, after, targetPath);
      const edit: Edit = { targetPath, before, after, diff };
      // edit-proposed (the Diff is shown to the user — no silent writes, REQ-010).
      await emit("edit-proposed", { targetPath, diff });

      // ---- STEP 3: resolveEdit — gate by the edit policy (RULE-004) -------------
      // A diff-less Edit would throw a FatalToolError here; abort throws UserAbort
      // (both propagate — re-raised by the registry, never normalized).
      let decision;
      try {
        decision = await deps.approval.resolveEdit(edit, deps.policy);
      } catch (err) {
        throw err; // FatalToolError (INV-003) — re-raised by the registry.
      }

      if (decision === "user-abort") {
        // Clean Stopped (NOT Failed): raise the user-abort StopCondition carrier.
        throw new UserAbortError(`user aborted the edit to ${targetPath}`);
      }
      if (decision === "denied") {
        // APPROVAL_DENIED (ERR-004): no write; Edit not applied; loop continues.
        await emit("edit-rejected", { targetPath, code: "APPROVAL_DENIED", message: "edit denied" });
        return errorResult(toolCall.id, "APPROVAL_DENIED", `edit to ${targetPath} was denied`);
      }
      // decision is "auto-approved" | "approved-by-user" — permitted.

      // ---- STEP 4: persist — durable write AFTER approval (REQ-011) -------------
      try {
        await persist(canonicalPath, after);
      } catch (err) {
        // Approval + containment passed but the disk write failed → WRITE_FAILED
        // (ERR-008); Edit is Rejected (applied:false), not Applied.
        await emit("edit-rejected", {
          targetPath,
          code: "WRITE_FAILED",
          message: (err as Error).message,
        });
        return errorResult(toolCall.id, "WRITE_FAILED", `disk write failed: ${(err as Error).message}`);
      }

      // edit-applied (REQ-011): the file is on disk; subsequent reads see new state.
      await emit("edit-applied", { targetPath });

      return {
        toolCallId: toolCall.id,
        status: "ok",
        output: {
          edit: { targetPath, before, after, applied: true },
          diff,
          approval: decision,
        },
      };
    },
  };
}

/** Build a normalized error ToolResult (never a throw for expected failures — RULE-008). */
function errorResult(toolCallId: string, code: string, message: string): ToolResult {
  return { toolCallId, status: "error", error: { code, message } };
}
