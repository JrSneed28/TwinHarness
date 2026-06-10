/**
 * Shared contract types for Autocoder — the cross-component interface shapes
 * pinned by docs/07-contracts.md. Slice 0 (walking skeleton) realizes only the
 * minimal subset these interfaces need to wire the end-to-end spine; later
 * slices extend the unions and payloads additively (ADR-002 versioning rule).
 *
 * REQ-NFR-002 (partial): the two non-deterministic edges — LlmClient and
 * CommandRunner — are declared here as injectable seams so the harness is
 * deterministically testable offline.
 */

/** One of the five model-facing tool names (RULE-012). Slice 0 only exercises read_file. */
export type ToolName =
  | "read_file"
  | "list_search"
  | "write_edit"
  | "run_command"
  | "apply_patch";

/** A model-assigned tool_use request. `arguments` is UNTRUSTED model output. */
export interface ToolCall {
  id: string;
  toolName: ToolName;
  arguments: Record<string, unknown>;
}

/** Normalized result of dispatching exactly one ToolCall (INV-008). */
export interface ToolResult {
  toolCallId: string;
  status: "ok" | "error";
  output?: Record<string, unknown>; // present iff status="ok"
  error?: { code: string; message: string }; // present iff status="error"
}

/** A JSON-schema descriptor attached to the LlmClient `tools` field (RULE-012). */
export interface ToolSchema {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Ordered dialogue message handed to the LlmClient seam (read-only). */
export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
}

/** Token accounting reported by the LlmClient seam. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

/** Parsed model output for one send() round-trip. */
export interface LlmResponse {
  toolCalls: ToolCall[] | null; // null when finalAnswer present
  finalAnswer: string | null;
  stopReason: "tool_use" | "end_turn" | "max_tokens" | "stop_sequence";
  usage: Usage;
}

/**
 * IF-006 LlmClient — the DI seam wrapping the Anthropic Messages API.
 * In Slice 0 this is STUBBED (no network); the real SDK-backed impl arrives later.
 */
export interface LlmClient {
  send(
    conversation: ConversationMessage[],
    toolSchemas: ToolSchema[],
  ): Promise<LlmResponse>;
}

/** Result of one shell invocation through the CommandRunner seam. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * SLICE-5 additive (ADR-002 versioning): true iff the process NEVER STARTED
   * (spawn failure — e.g. executable not found), as opposed to a process that ran
   * and exited (any exitCode, including non-zero, is a valid RESULT). The caller
   * (`tool-runcommand`) maps `spawnFailed:true` to COMMAND_FAILED (ERR-010) and a
   * plain non-zero exit to a `status:"ok"` ToolResult (ADR-007). Optional/absent
   * means the process ran normally; back-compatible with the SLICE-0 stub.
   */
  spawnFailed?: boolean;
}

/**
 * IF-007 CommandRunner — the DI seam wrapping shell/process execution.
 * In Slice 0 this is STUBBED (no real subprocess); not exercised by the read path.
 */
export interface CommandRunner {
  run(command: string, cwd: string, timeoutMs: number): Promise<CommandResult>;
}

/**
 * IF-008 ToolRegistry — yields exactly one normalized ToolResult per dispatch.
 */
export interface ToolRegistry {
  schemas(): ToolSchema[];
  dispatch(toolCall: ToolCall): Promise<ToolResult>;
}

/** PathSandbox verdict (IF-010). Reads are always allowed (INV-002). */
export interface SandboxVerdict {
  allowed: boolean;
  canonicalPath?: string;
  reason?: { code: "PATH_ESCAPE"; message: string };
}

/** IF-010 PathSandbox — filesystem/shell confinement boundary. */
export interface PathSandbox {
  checkRead(path: string): SandboxVerdict;
  checkWrite(path: string): SandboxVerdict;
  checkExecCwd(cwd: string): SandboxVerdict;
}

/** Approval outcome for an edit/command (IF-009). */
export type ApprovalDecision =
  | "auto-approved"
  | "approved-by-user"
  | "denied"
  | "user-abort";

/**
 * A proposed file mutation (IF-003 / IF-009). The `diff` MUST already be generated
 * before the Edit reaches the ApprovalGate (RULE-002 ordering) — an Edit that
 * reaches `applied` without a `diff` is an INVARIANT BREACH (INV-003). `before` is
 * null for a new file; `after === ""` denotes a deletion.
 */
export interface Edit {
  targetPath: string;
  before: string | null;
  after: string;
  /** The unified Diff (before → after). REQUIRED before approval (RULE-002). */
  diff: string;
}

/** Edit ApprovalPolicy handed to ApprovalGate.resolveEdit (IF-009, REQ-012). */
export interface EditApprovalPolicy {
  editMode: EditMode;
}

/** Command ApprovalPolicy handed to ApprovalGate.resolveCommand (IF-009, REQ-016). */
export interface CommandApprovalPolicy {
  commandMode: CommandMode;
}

/**
 * IF-009 ApprovalGate — model-intent → real-world trust boundary.
 *
 * `resolveEdit` is ASYNC (REQ-012): the confirm-each prompt is an injectable async
 * seam (and a real stdin prompt is inherently async), so the decision is a Promise.
 *
 * SLICE-5 (REQ-016) builds the COMMAND decision: `resolveCommand` is now ASYNC too —
 * a non-allowlisted command prompts via the SAME injectable async confirm seam, so
 * the Promise return is the realized shape (the pre-SLICE-5 sync passthrough is gone).
 * The `allowlist` is an `Allowlist` matcher (token-sequence prefix; ADR-006) and the
 * `policy` is a `CommandApprovalPolicy`. Chained/redirected forms never auto-run
 * (INV-010).
 */
export interface ApprovalGate {
  resolveEdit(edit: Edit, policy: EditApprovalPolicy): Promise<ApprovalDecision>;
  resolveCommand(
    command: string,
    policy: CommandApprovalPolicy,
    allowlist: CommandAllowlist,
  ): Promise<ApprovalDecision>;
}

/**
 * The minimal allowlist matcher surface ApprovalGate.resolveCommand needs (IF-009).
 * Realized by the `allowlist` component (`createAllowlist`); declared here so the
 * contract types stay in the shared module. `isAllowed` is true iff the command is
 * allowlisted for auto-run (token-sequence prefix AND not chained/redirected).
 */
export interface CommandAllowlist {
  isAllowed(command: string): boolean;
}

/** The 18 transcript event types (additive — Slice 0 emits four of them). */
export type TranscriptEntryType =
  | "run-started"
  | "context-gathered"
  | "iteration-started"
  | "tool-called"
  | "approval-requested"
  | "approval-decided"
  | "edit-proposed"
  | "edit-applied"
  | "edit-rejected"
  | "patch-rejected"
  | "command-run"
  | "tests-run"
  | "tool-result"
  | "budget-exceeded"
  | "llm-retry"
  | "run-stopped"
  | "run-completed"
  | "allowlist-changed";

/** IF-015 TranscriptEntry — versioned discriminated-union JSONL row (ADR-002). */
export interface TranscriptEntry {
  schemaVersion: string;
  seq: number; // monotonic, assigned by the writer
  ts: string; // ISO-8601 UTC
  runId: string;
  type: TranscriptEntryType;
  payload: Record<string, unknown>;
}

/** Entry handed to TranscriptWriter.append before `seq` is assigned. */
export type TranscriptEntryInput = Omit<TranscriptEntry, "seq">;

/** IF-012 TranscriptWriter — append-only, durable per entry. */
export interface TranscriptWriter {
  open(runId: string): Promise<void>;
  append(entry: TranscriptEntryInput): Promise<void>;
  flush(): Promise<void>;
}

/** RunOutcome rendered by the Reporter (minimal for the skeleton). */
export interface RunOutcome {
  status: "succeeded" | "stopped" | "failed";
  exitCode: number;
  runId: string;
}

/** The full StopCondition union surfaced in the RunSummary (IF-016 / RULE-007). */
export type StopConditionName =
  | "task-success"
  | "max-iterations-reached"
  | "budget-exhausted"
  | "model-give-up"
  | "unrecoverable-error"
  | "user-abort";

/** One changed file in the RunSummary (IF-016): the path + its unified diff. */
export interface FileChange {
  targetPath: string;
  diff: string;
}

/**
 * The test outcome carried in the RunSummary (IF-016). `ran=false` ⇒ no test
 * command was configured/run (ODQ-004); `passed`/`failed` are then both 0.
 */
export interface TestsResult {
  ran: boolean;
  passed: number;
  failed: number;
}

/**
 * IF-016 `RunSummary` — the CI-stable contract rendered BOTH human-readably and (with
 * `--json`) as a machine-readable JSON object on stdout. It is the SAME data the human
 * form renders (compute once, render twice). Append-only stable for CI: fields are
 * never removed/retyped within a `schemaVersion`; CI may rely on
 * `status`/`exitCode`/`stopCondition` permanently. `exitCode == 0` IFF
 * `status == "succeeded"` (INV-006). The `apiKey` is NEVER a field here [SENSITIVE].
 */
export interface RunSummary {
  status: "succeeded" | "stopped" | "failed";
  stopCondition: StopConditionName;
  /** 0 iff status="succeeded" (INV-006); REUSED from the SLICE-7 classification. */
  exitCode: number;
  /** Changed files with their diffs; may be empty. */
  filesChanged: FileChange[];
  testsResult: TestsResult;
  iterationsUsed: number;
  /** Input+output tokens accrued; may carry `estimated:true` (ODQ-005). */
  tokensUsed: number;
  /** True iff `tokensUsed` is a character-based estimate (ODQ-005 flag). */
  estimated?: boolean;
  runId: string;
  /** `--json` schema version for additive CI-safe evolution (currently "1.0"). */
  schemaVersion: string;
}

/** Edit ApprovalPolicy mode (IF-017, REQ-012). */
export type EditMode = "confirm-each" | "auto";

/** Command ApprovalPolicy mode (IF-017, REQ-016). */
export type CommandMode = "allowlist-confirm" | "auto";

/**
 * One auto-run allowlist entry (IF-017). `pattern` is a command token-sequence
 * prefix that auto-runs (e.g. "npm test", "git status"); min length 1.
 */
export interface AllowlistEntry {
  pattern: string;
}

/**
 * Resolved Config (IF-017) — the full schema, completed in SLICE-1/TASK-003
 * (this completes the DRIFT-001 deferral; SLICE-0 carried only a minimal subset).
 *
 * Precedence (highest wins): flags > environment > config file > built-in
 * defaults. `apiKey` is SENSITIVE — it is read from env and must never be
 * serialized into the Transcript, RunSummary, or `--json`.
 *
 * The `task` is the AgentRun input (IF-014 positional / `--task` / stdin /
 * `--task-file`); it is carried alongside the resolved Config so the composition
 * root can thread it to AgentRun. It is optional in allowlist mode (no loop).
 */
export interface Config {
  /** [SENSITIVE] from env ANTHROPIC_API_KEY; fail-fast if missing (RULE-016). */
  apiKey: string;
  /** Anthropic model id (default: current Claude model). */
  modelId: string;
  /** Resolved WorkingRoot; must be an existing directory (REQ-002). */
  root: string;
  /** Edit ApprovalPolicy (default: "confirm-each"). */
  editMode: EditMode;
  /** Command ApprovalPolicy (default: "allowlist-confirm"). */
  commandMode: CommandMode;
  /** Iteration ceiling; > 0 (default: 25). */
  maxIterations: number;
  /** Token ceiling (input+output per run); > 0 (default: ~1_000_000). */
  tokenBudget: number;
  /** Auto-run set (default: detected test/build cmd + safe read-only cmds). */
  allowlist: AllowlistEntry[];
  /** The natural-language Task threaded to AgentRun (IF-014). */
  task: string;
}

/** Current transcript schema version (ADR-002 / Versioning). */
export const SCHEMA_VERSION = "1.0";
