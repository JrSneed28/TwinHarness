/**
 * IF-005 apply_patch tool (REQ-023; enforces RULE-013 / INV-007). Owner component:
 * `tool-applypatch`.
 *
 * Applies a unified-diff Patch (one+ hunks across one+ files) to the working tree,
 * confined to the WorkingRoot (REQ-021) and gated by the edit-approval policy
 * (REQ-012). The HEADLINE invariant is ATOMICITY (RULE-013 / INV-007): the patch is
 * applied in full or NOT AT ALL — a single failing hunk or any out-of-root target
 * rejects the WHOLE patch with ZERO Edits and nothing written.
 *
 * The fixed protocol (a dry-run-EVERYTHING-then-write barrier; ordering mirrors the
 * write_edit mutation order but generalized across files):
 *
 *   1. parsePatch          — unparseable → PATCH_MALFORMED (ERR-011), zero writes.
 *   2. checkWrite EVERY     — any target whose REAL path escapes root → PATH_ESCAPE
 *      target              (ERR-001), the WHOLE patch rejected before any write.
 *   3. DRY-RUN applyHunks   — every file/hunk is applied in memory FIRST. If ANY hunk
 *      for EVERY file       fails → PATCH_NOT_APPLICABLE (ERR-012), whole patch
 *                           rejected, zero Edits, a `patch-rejected` entry emitted.
 *   4. generateDiff + a     — only once ALL targets are in-root AND ALL hunks dry-run
 *      single resolveEdit   cleanly: produce a per-file Diff, take ONE approval for the
 *      then persist ALL     whole patch (denied → APPROVAL_DENIED; abort → UserAbort),
 *                           then persist every file. A disk failure mid-apply →
 *                           WRITE_FAILED (ERR-008).
 *
 * Re-applying an already-applied patch is rejected at step 3 — its `-`/context lines
 * no longer match the (already mutated) file, so `applyHunks` reports not-applicable.
 *
 * Errors-as-results (RULE-008): the tool NEVER throws for an expected failure — it
 * returns a `status:"error"` ToolResult. The two propagating classes are the same as
 * write_edit: a `FatalToolError` (INV-003 diff-less Edit at the gate) and a
 * `UserAbortError` (clean user-abort StopCondition); both are re-raised by the
 * registry, never normalized.
 *
 * Out of MVP scope (V1): AST-aware / git-aware patch refinement and fuzzy-offset
 * context matching — apply uses exact line-context matching at the stated anchor.
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
import {
  generateDiff,
  parsePatch,
  applyHunks,
  type ParsedPatchFile,
} from "./diff-engine.js";
import { UserAbortError } from "./tool-errors.js";

export interface ApplyPatchTool {
  readonly toolName: "apply_patch";
  execute(toolCall: ToolCall): Promise<ToolResult>;
}

export interface ApplyPatchDeps {
  sandbox: PathSandbox;
  approval: ApprovalGate;
  /** The resolved edit policy (default confirm-each). */
  policy: EditApprovalPolicy;
  /** Optional transcript sink for edit-proposed / edit-applied / patch-rejected. */
  transcript?: TranscriptWriter;
  runId?: string;
  now?: () => string;
  /** Injectable persist seam (default: durable fsync write). Lets tests force IO failure. */
  persist?: (canonicalPath: string, contents: string) => Promise<void>;
}

/** Durable write: create parent dirs, write the file, fsync (REQ-011 crash-survival). */
async function durablePersist(canonicalPath: string, contents: string): Promise<void> {
  await fs.mkdir(nodePath.dirname(canonicalPath), { recursive: true });
  const handle = await fs.open(canonicalPath, "w");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Read current contents of a file, or null if it does not exist (→ a new-file target). */
async function readBefore(canonicalPath: string): Promise<string | null> {
  try {
    return await fs.readFile(canonicalPath, "utf8");
  } catch {
    return null;
  }
}

/** One fully validated, dry-run-applied file ready to persist (held until ALL pass). */
interface StagedFile {
  targetPath: string; // the model-facing path from the patch header
  canonicalPath: string; // the sandbox-resolved real path to write to
  before: string | null;
  after: string;
  diff: string;
}

export function createApplyPatchTool(deps: ApplyPatchDeps): ApplyPatchTool {
  const persist = deps.persist ?? durablePersist;
  const now = deps.now ?? (() => new Date().toISOString());

  async function emit(
    type: "edit-proposed" | "edit-applied" | "patch-rejected",
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
    toolName: "apply_patch",
    async execute(toolCall: ToolCall): Promise<ToolResult> {
      const args = toolCall.arguments ?? {};
      const patch = typeof args.patch === "string" ? args.patch : "";
      if (patch.length < 1) {
        await emit("patch-rejected", {
          code: "PATCH_MALFORMED",
          message: "patch is required (min length 1)",
        });
        return errorResult(toolCall.id, "PATCH_MALFORMED", "patch is required (min length 1)");
      }

      // ---- STEP 1: parsePatch — unparseable → PATCH_MALFORMED, ZERO writes -------
      const parsed = parsePatch(patch);
      if (!parsed.ok) {
        await emit("patch-rejected", { code: "PATCH_MALFORMED", message: parsed.reason });
        return errorResult(toolCall.id, "PATCH_MALFORMED", `patch is malformed: ${parsed.reason}`);
      }
      const patchFiles: ParsedPatchFile[] = parsed.patch.files;

      // ---- STEP 2: checkWrite EVERY target — any escape → whole patch rejected ---
      // (RULE-001 fail-closed). NOT ONE file is written if ANY target escapes root.
      const resolved: { file: ParsedPatchFile; canonicalPath: string }[] = [];
      for (const file of patchFiles) {
        const verdict = deps.sandbox.checkWrite(file.path);
        if (!verdict.allowed || !verdict.canonicalPath) {
          await emit("patch-rejected", {
            code: "PATH_ESCAPE",
            message: verdict.reason?.message ?? `target escapes root: ${file.path}`,
          });
          return errorResult(
            toolCall.id,
            "PATH_ESCAPE",
            verdict.reason?.message ?? `patch target escapes root: ${file.path}`,
          );
        }
        resolved.push({ file, canonicalPath: verdict.canonicalPath });
      }

      // ---- STEP 3: DRY-RUN applyHunks for EVERY file/hunk (no disk mutation) -----
      // This is the atomicity barrier: every file is applied IN MEMORY first; only if
      // ALL succeed do we proceed to write ANY (RULE-013 / INV-007). A single failure
      // → PATCH_NOT_APPLICABLE, zero Edits, `patch-rejected`.
      const staged: StagedFile[] = [];
      for (const { file, canonicalPath } of resolved) {
        const before = await readBefore(canonicalPath);
        const dry = applyHunks(before ?? "", file.hunks);
        if (!dry.applicable || dry.result === undefined) {
          const detail =
            typeof dry.failedHunkIndex === "number"
              ? ` (hunk #${dry.failedHunkIndex} did not match)`
              : "";
          const message = `patch does not apply to ${file.path}${detail}`;
          await emit("patch-rejected", {
            code: "PATCH_NOT_APPLICABLE",
            message,
            failedHunkIndex: dry.failedHunkIndex,
            targetPath: file.path,
          });
          return errorResult(toolCall.id, "PATCH_NOT_APPLICABLE", message);
        }
        const after = dry.result;
        // generateDiff per file (RULE-002): every staged Edit carries a Diff.
        const diff = generateDiff(before, after, file.path);
        staged.push({ targetPath: file.path, canonicalPath, before, after, diff });
      }

      // ---- STEP 4a: a SINGLE approval for the whole patch (RULE-004) -------------
      // The approval gate takes one Edit; we represent the patch with a combined
      // synthetic Edit whose Diff is every per-file diff concatenated (so the prompt
      // shows the full blast radius). The gate's INV-003 (diff present) holds — the
      // combined diff is non-empty whenever there is at least one file. Abort and a
      // diff-less breach propagate (re-raised by the registry); denied is a soft error.
      const combinedTarget =
        staged.length === 1
          ? (staged[0] as StagedFile).targetPath
          : `${staged.length} files (${staged.map((s) => s.targetPath).join(", ")})`;
      const combinedDiff = staged.map((s) => s.diff).join("\n");
      const patchEdit: Edit = {
        targetPath: combinedTarget,
        before: null,
        after: combinedDiff,
        diff: combinedDiff,
      };
      // edit-proposed per file (the Diff is shown — no silent writes, REQ-010).
      for (const s of staged) {
        await emit("edit-proposed", { targetPath: s.targetPath, diff: s.diff });
      }

      let decision;
      try {
        decision = await deps.approval.resolveEdit(patchEdit, deps.policy);
      } catch (err) {
        // FatalToolError (INV-003) — re-raised by the registry, never normalized.
        throw err;
      }
      if (decision === "user-abort") {
        // Clean Stopped (NOT Failed): raise the user-abort StopCondition carrier.
        throw new UserAbortError(`user aborted the patch (${combinedTarget})`);
      }
      if (decision === "denied") {
        await emit("patch-rejected", {
          code: "APPROVAL_DENIED",
          message: `patch to ${combinedTarget} was denied`,
        });
        return errorResult(toolCall.id, "APPROVAL_DENIED", `patch to ${combinedTarget} was denied`);
      }
      // decision is "auto-approved" | "approved-by-user" — permitted.

      // ---- STEP 4b: persist ALL files (only after a clean dry-run + approval) ----
      // A disk failure mid-apply → WRITE_FAILED (ERR-008). We do not roll back files
      // already written this run (Crash/Restart-Recovery: no auto-rollback in the MVP);
      // because the dry-run validated everything up front, a mid-apply IO failure is an
      // environment fault, not a patch-applicability fault.
      const edits: { targetPath: string; before: string | null; after: string; applied: boolean }[] = [];
      const diffs: string[] = [];
      for (const s of staged) {
        try {
          await persist(s.canonicalPath, s.after);
        } catch (err) {
          await emit("patch-rejected", {
            code: "WRITE_FAILED",
            message: `disk write failed for ${s.targetPath}: ${(err as Error).message}`,
          });
          return errorResult(
            toolCall.id,
            "WRITE_FAILED",
            `disk write failed for ${s.targetPath}: ${(err as Error).message}`,
          );
        }
        await emit("edit-applied", { targetPath: s.targetPath });
        edits.push({ targetPath: s.targetPath, before: s.before, after: s.after, applied: true });
        diffs.push(s.diff);
      }

      return {
        toolCallId: toolCall.id,
        status: "ok",
        output: {
          edits,
          diffs,
          filesChanged: edits.length,
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
