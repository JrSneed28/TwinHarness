/**
 * IF-009 ApprovalGate — model-intent → real-world trust boundary (RULE-004/005).
 *
 * SLICE-4 (REQ-012) builds the EDIT decision: `resolveEdit(edit, policy)` resolves a
 * proposed Edit (whose Diff already exists — RULE-002 ordering) against the edit
 * `ApprovalPolicy` into an `ApprovalDecision`:
 *
 *   editMode "auto"          → "auto-approved" WITHOUT prompting (set by --yes/--auto).
 *   editMode "confirm-each"  → PROMPT the user (the DEFAULT, RULE-004); the user's
 *                              answer maps to:
 *                                approve → "approved-by-user"
 *                                deny    → "denied"        (→ APPROVAL_DENIED, ERR-004)
 *                                abort   → "user-abort"    (→ clean Stopped, NOT Failed)
 *
 * The prompt is an INJECTABLE SEAM (`confirm`) so the suite simulates approve / deny /
 * abort deterministically with NO real stdin (REQ-NFR-002). The default `confirm`
 * reads a line from stdin. Every call emits `approval-requested` then
 * `approval-decided` TranscriptEntries when a transcript sink is provided.
 *
 * The Diff MUST already exist before `resolveEdit` is called (an Edit with no `diff`
 * is an INVARIANT BREACH — INV-003): the gate FAILS CLOSED on a missing diff by
 * raising a `FatalToolError` (an Edit must never reach approval without a Diff).
 *
 * SLICE-5 (REQ-016) builds the COMMAND decision: `resolveCommand(command, policy,
 * allowlist)` resolves a shell command against the command policy + allowlist into an
 * `ApprovalDecision`:
 *
 *   commandMode "auto"               → "auto-approved" WITHOUT prompting (--yes/--auto).
 *   commandMode "allowlist-confirm"  → allowlisted (token-sequence prefix, ADR-006)
 *                                      AND not chained/redirected (INV-010) → auto-run;
 *                                      otherwise PROMPT via the injected confirm seam:
 *                                        approve → "approved-by-user"
 *                                        deny    → "denied"      (→ APPROVAL_DENIED)
 *                                        abort   → "user-abort"  (→ clean Stopped)
 *
 * Even in `auto` mode, the allowlist's chained/redirected disqualifier is moot (auto
 * runs everything by user opt-in); but in the DEFAULT mode a chained command whose
 * head token is allowlisted is FORCED to confirm — the allowlist matcher returns false
 * for it (INV-010), so it falls through to the prompt. The command confirm seam is the
 * SAME injectable async pattern as the edit seam (REQ-NFR-002) — no real stdin in tests.
 */
import type {
  ApprovalGate,
  ApprovalDecision,
  CommandAllowlist,
  CommandApprovalPolicy,
  Edit,
  EditApprovalPolicy,
  TranscriptWriter,
  TranscriptEntryInput,
} from "./contracts.js";
import { SCHEMA_VERSION } from "./contracts.js";
import { FatalToolError } from "./tool-errors.js";
import process from "node:process";

/**
 * The user's answer at an edit-approval prompt. The injectable `confirm` seam
 * returns one of these so tests drive approve / deny / abort with no stdin.
 */
export type ConfirmAnswer = "approve" | "deny" | "abort";

/**
 * Injectable confirm seam (REQ-NFR-002). Given a human-readable prompt for one
 * Edit, resolve the user's choice. The default reads a single line from stdin.
 */
export type ConfirmFn = (prompt: { targetPath: string; diff: string }) => Promise<ConfirmAnswer>;

/**
 * Injectable COMMAND confirm seam (REQ-NFR-002, REQ-016). Given the command line to
 * be run, resolve the user's choice (approve / deny / abort). The default reads a
 * single line from stdin; tests inject a deterministic answer (no real stdin).
 */
export type ConfirmCommandFn = (prompt: { command: string }) => Promise<ConfirmAnswer>;

/** Dependencies for an edit-aware ApprovalGate. All optional (back-compat). */
export interface ApprovalGateDeps {
  /** The edit prompt seam; defaults to a stdin reader. */
  confirm?: ConfirmFn;
  /** The command prompt seam; defaults to a stdin reader. */
  confirmCommand?: ConfirmCommandFn;
  /** Optional transcript sink for approval-requested / approval-decided rows. */
  transcript?: TranscriptWriter;
  /** RunId stamped on emitted entries (required iff `transcript` is provided). */
  runId?: string;
  /** Clock seam (default: real ISO-8601 UTC). */
  now?: () => string;
  /** ToolCallId correlation for the approval transcript rows (optional). */
  toolCallId?: string;
}

/** Default stdin confirm: reads one line; y/yes → approve, a/abort → abort, else deny. */
const defaultConfirm: ConfirmFn = async (prompt) => {
  process.stdout.write(
    `Apply edit to ${prompt.targetPath}? [y]es / [n]o / [a]bort\n${prompt.diff}\n> `,
  );
  const answer = await readLine();
  const a = answer.trim().toLowerCase();
  if (a === "a" || a === "abort") return "abort";
  if (a === "y" || a === "yes") return "approve";
  return "deny";
};

/** Default stdin command confirm: reads one line; y/yes → approve, a/abort → abort, else deny. */
const defaultConfirmCommand: ConfirmCommandFn = async (prompt) => {
  process.stdout.write(
    `Run command? [y]es / [n]o / [a]bort\n  $ ${prompt.command}\n> `,
  );
  const answer = await readLine();
  const a = answer.trim().toLowerCase();
  if (a === "a" || a === "abort") return "abort";
  if (a === "y" || a === "yes") return "approve";
  return "deny";
};

/** Read one line from stdin (used only by the default, never in tests). */
function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(chunk.toString("utf8"));
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

/** True iff `edit` carries a non-empty Diff (RULE-002 / INV-003 precondition). */
function hasDiff(edit: unknown): edit is Edit {
  return (
    typeof edit === "object" &&
    edit !== null &&
    typeof (edit as Edit).diff === "string" &&
    (edit as Edit).diff.length > 0 &&
    typeof (edit as Edit).targetPath === "string"
  );
}

/**
 * Build an ApprovalGate. With no deps it preserves the pre-SLICE-4 passthrough
 * (read path / skeleton wiring). With deps it realizes the REQ-012 edit decision:
 * the injected `confirm` seam drives confirm-each, and approval transcript rows are
 * emitted when a transcript sink is given.
 */
export function createApprovalGate(deps: ApprovalGateDeps = {}): ApprovalGate {
  const confirm = deps.confirm ?? defaultConfirm;
  const confirmCommand = deps.confirmCommand ?? defaultConfirmCommand;
  const now = deps.now ?? (() => new Date().toISOString());

  async function emit(entry: Omit<TranscriptEntryInput, "schemaVersion" | "ts" | "runId">): Promise<void> {
    if (!deps.transcript || !deps.runId) return;
    await deps.transcript.append({
      schemaVersion: SCHEMA_VERSION,
      ts: now(),
      runId: deps.runId,
      ...entry,
    });
  }

  return {
    /**
     * Resolve an Edit against the edit policy (REQ-012, IF-009). Async because the
     * confirm seam (and a real stdin prompt) is async. The Diff must already exist
     * (RULE-002) — a missing diff fails closed as a fatal invariant breach (INV-003).
     */
    async resolveEdit(edit: Edit, policy: EditApprovalPolicy): Promise<ApprovalDecision> {
      // INV-003: an Edit MUST carry a Diff before it can be approved (RULE-002
      // ordering). A diff-less Edit reaching the gate is an internal-invariant
      // breach → FATAL (not a soft error result).
      if (!hasDiff(edit)) {
        throw new FatalToolError(
          "INV-003 breach: Edit reached ApprovalGate without a generated Diff (RULE-002)",
          "EDIT_WITHOUT_DIFF",
        );
      }

      // "auto" mode (set by --yes/--auto) auto-approves WITHOUT prompting (RULE-004).
      if (policy?.editMode === "auto") {
        await emit({
          type: "approval-requested",
          payload: { toolCallId: deps.toolCallId ?? null, kind: "edit", target: edit.targetPath },
        });
        await emit({
          type: "approval-decided",
          payload: { toolCallId: deps.toolCallId ?? null, decision: "auto-approved" },
        });
        return "auto-approved";
      }

      // DEFAULT "confirm-each": prompt the user via the injected seam (RULE-004).
      await emit({
        type: "approval-requested",
        payload: { toolCallId: deps.toolCallId ?? null, kind: "edit", target: edit.targetPath },
      });
      const answer = await confirm({ targetPath: edit.targetPath, diff: edit.diff });
      const decision: ApprovalDecision =
        answer === "approve" ? "approved-by-user" : answer === "abort" ? "user-abort" : "denied";
      await emit({
        type: "approval-decided",
        payload: { toolCallId: deps.toolCallId ?? null, decision },
      });
      return decision;
    },

    /**
     * Resolve a shell command against the command policy + allowlist (REQ-016,
     * IF-009). Async because the confirm seam (and a real stdin prompt) is async.
     *
     *   commandMode "auto"              → auto-approved WITHOUT prompting.
     *   commandMode "allowlist-confirm" → allowlisted (token-sequence prefix AND not
     *                                     chained/redirected, INV-010) → auto-run;
     *                                     otherwise prompt the user via the seam.
     *
     * The allowlist matcher already enforces INV-010 (chained/redirected → not
     * allowed → falls through to the prompt), so a chained command whose head token
     * is allowlisted is FORCED to confirm.
     */
    async resolveCommand(
      command: string,
      policy: CommandApprovalPolicy,
      allowlist: CommandAllowlist,
    ): Promise<ApprovalDecision> {
      // "auto" mode (set by --yes/--auto) auto-approves WITHOUT prompting (ADR-006).
      if (policy?.commandMode === "auto") {
        await emit({
          type: "approval-requested",
          payload: { toolCallId: deps.toolCallId ?? null, kind: "command", target: command },
        });
        await emit({
          type: "approval-decided",
          payload: { toolCallId: deps.toolCallId ?? null, decision: "auto-approved" },
        });
        return "auto-approved";
      }

      // DEFAULT "allowlist-confirm": an allowlisted command auto-runs (no prompt).
      // The matcher returns false for chained/redirected forms (INV-010), so those
      // fall through to the confirmation prompt even with an allowlisted head token.
      if (allowlist.isAllowed(command)) {
        await emit({
          type: "approval-requested",
          payload: { toolCallId: deps.toolCallId ?? null, kind: "command", target: command },
        });
        await emit({
          type: "approval-decided",
          payload: { toolCallId: deps.toolCallId ?? null, decision: "auto-approved" },
        });
        return "auto-approved";
      }

      // Non-allowlisted (or chained/redirected) → prompt the user (RULE-005).
      await emit({
        type: "approval-requested",
        payload: { toolCallId: deps.toolCallId ?? null, kind: "command", target: command },
      });
      const answer = await confirmCommand({ command });
      const decision: ApprovalDecision =
        answer === "approve" ? "approved-by-user" : answer === "abort" ? "user-abort" : "denied";
      await emit({
        type: "approval-decided",
        payload: { toolCallId: deps.toolCallId ?? null, decision },
      });
      return decision;
    },
  };
}
