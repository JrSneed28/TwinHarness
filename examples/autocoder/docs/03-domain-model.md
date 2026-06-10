# Domain Model — Autocoder

> **Stage 3 — Domain Modeling** (spec §14.3). Streams; no human gate. Reads the Summaries from
> `01-requirements.md` and `02-scope.md` by default; fetches full artifacts only when a detail
> cannot be resolved from the Summary (§9). Proposes an initial model first, then invites the
> user to confirm, correct, or expand. Where entities realize a specific requirement, anchor them
> to the REQ-ID so traceability holds downstream (§11).

## Summary

Autocoder's domain is **one autonomous coding run**: a developer hands the CLI a natural-language
**Task**, and an **AgentRun** drives an LLM loop of **Iterations** that call five **Tools** (read,
list/search, write/edit, run-command, apply-patch) against a confined **WorkingRoot**, gated by two
**ApprovalPolicies** (edit + command). Every file mutation must surface as a **Diff** before it
touches disk; every shell command is checked against an **Allowlist** before it runs; both the
filesystem and the shell are confined to the root for writes/exec while reads may range outside it.
The run is bounded by a **Budget** (iteration ceiling + token budget) and always ends on a single
**StopCondition** producing a **RunOutcome**, while a durable **Transcript** records every iteration,
tool call, result, and decision for post-hoc audit. The whole model exists to make *delegated coding
that is safe, bounded, and auditable* — correctness anchored to the repo's own tests, control
retained by the developer.

- **Central entity:** **AgentRun** — the single invocation and its lifecycle; everything else is
  scoped to, produced by, or constrains one AgentRun (REQ-001, REQ-004, REQ-014).
- **Key relationship:** **AgentRun → Iteration → ToolCall → ToolResult** — one run contains many
  ordered iterations, each producing zero-or-more tool calls whose results feed the next iteration
  (REQ-004, REQ-005).
- **Core domain rule:** **No write or command execution ever escapes the WorkingRoot, and no file is
  ever mutated silently** — every mutation yields a reviewable Diff first (REQ-021, REQ-010).
  ⚠ *blast-radius: data integrity.*

---

## Domain Summary

The world of Autocoder is a single **autonomous coding session** run from a terminal against one code
repository on the developer's machine. The developer is the **principal** who states intent (the
**Task**) and retains authority over two things: what gets written to disk and what gets executed in
the shell. The agent — driven by a Claude model through the Anthropic SDK — is the actor that plans
and acts, but it acts only through a fixed, mediated surface of five **Tools**, and only inside a
**WorkingRoot** boundary for anything that mutates state. Correctness in this domain is not the
model's self-assessment; it is the verdict of the repository's own **tests**, run through the
run-command tool and fed back as the primary completion signal.

Conceptually a run is a bounded conversation that converges (or fails to converge) on a goal. The
**AgentRun** gathers initial **RepoContext**, then enters a loop of **Iterations**; in each iteration
it asks the model for the next action, the model answers with **ToolCalls** or a final declaration,
the harness executes those calls against the working tree, captures **ToolResults**, and loops. Two
**ApprovalPolicies** sit between the model's intent and the real world: the *edit policy* governs
whether proposed file changes auto-apply or wait for confirmation, and the *command policy* checks
each shell command against an **Allowlist** (auto-run) or requires confirmation (everything else).
The run cannot run forever or spend unbounded money: a **Budget** caps iterations and tokens, and a
single **StopCondition** always terminates the loop into a definite **RunOutcome** (succeeded /
stopped / failed). Throughout, a durable **Transcript** is the system's memory and audit trail — the
authoritative record of what the agent did, what it observed, and why it stopped. The non-negotiables
of this domain — confinement, no-silent-writes, bounded termination, deterministic harness — are not
features layered on top; they are the rules that define what it means for the system to behave
correctly at all.

---

## Core Entities

### Task  <!-- REQ-001 -->

The natural-language statement of intent the developer hands to the CLI ("fix the failing `parseDate`
tests", "add input validation to the signup endpoint"). It is the goal the AgentRun tries to achieve
and the reference against which success is judged. Closely related to: **AgentRun** (a Task starts
exactly one run), **RunOutcome** (judged against the Task).

### AgentRun  <!-- REQ-001, REQ-004, REQ-014, REQ-019 -->

The single invocation of Autocoder and its full lifecycle: one Task, against one WorkingRoot, under
one Config, driving one LLM loop to one RunOutcome. **This is the aggregate root of the domain** — it
owns the Iterations, the Transcript, the Budget consumption, and the final summary. One task per run
(batch/cross-run is out of MVP scope). Closely related to: **Task**, **Iteration**, **WorkingRoot**,
**Budget**, **Transcript**, **RunOutcome**, **Config**.

### Iteration  <!-- REQ-004, REQ-005, REQ-013 -->

One turn of the agent loop: the harness sends the Task + accumulated context + prior ToolResults to
the model, receives the model's response (ToolCalls or a final answer), executes any tool calls, and
records the results. Iterations are ordered and numbered within a run; their count is bounded by the
Budget's iteration ceiling. Closely related to: **AgentRun** (parent), **ConversationMessage**,
**ToolCall**, **ToolResult**.

### ConversationMessage  <!-- REQ-004 -->

A single message in the LLM conversation the AgentRun maintains — the running dialogue with the model
(system prompt, user task, assistant responses with tool_use blocks, and tool_result messages fed
back). This is the model-facing state that accumulates across iterations. Closely related to:
**Iteration**, **ToolCall**, **ToolResult**.

### Tool  <!-- REQ-005, REQ-006, REQ-007, REQ-008, REQ-009, REQ-023 -->

A named capability exposed to the model that the harness can execute on the model's behalf. The MVP
surface is **exactly five** Tools — this fixed surface is a domain decision, not an accident
(SCOPE-RISK-001). Each Tool declares an input schema (for the model) and an executor (in the
harness). The five:

- **ReadFileTool** (REQ-006) — return full or bounded-range contents of a file. *Read-anywhere:* may
  read paths outside the WorkingRoot.
- **ListSearchTool** (REQ-007) — list directory entries and search file contents (glob and/or
  text/regex) within the WorkingRoot.
- **WriteEditTool** (REQ-008) — create or modify a file via whole-file write **or** targeted
  string-replace. Mutating: confined to root, produces a Diff, gated by the edit policy.
- **RunCommandTool** (REQ-009) — execute a shell command in the WorkingRoot, capturing exit code,
  stdout, stderr. Executing: confined to root, gated by the command policy.
- **ApplyPatchTool** (REQ-023) — apply a unified-diff patch (one+ hunks across one+ files) to the
  working tree. Mutating: confined to root, produces a Diff, gated by the edit policy; malformed or
  non-applying patches are rejected with an actionable error fed back as a ToolResult.

Closely related to: **ToolCall**, **ApprovalPolicy**, **WorkingRoot**.

### ToolCall  <!-- REQ-005 -->

A single concrete invocation of a Tool that the model requested in an Iteration — the tool name plus
its arguments (e.g. read `src/x.ts`, run `npm test`, write `utils.ts`). It is the unit of action.
Mutating and executing ToolCalls pass through an ApprovalDecision before they take effect. Closely
related to: **Tool**, **ToolResult**, **ApprovalDecision**, **Edit**, **CommandExecution**.

### ToolResult  <!-- REQ-005, REQ-NFR-004 -->

The outcome of executing a ToolCall, fed back to the model as input to the next Iteration. Carries
either success output (file contents, search hits, applied-diff confirmation, command exit/stdout/
stderr) or an error (file-not-found, non-applying patch, command non-zero exit, denied approval). A
failing tool call is *reported back as a result, not a crash* (REQ-NFR-004). Closely related to:
**ToolCall**, **Iteration**, **ConversationMessage**.

### WorkingRoot  <!-- REQ-002, REQ-021 -->

The resolved, validated target directory that is the confinement boundary for the run. Writes and
command execution **must** stay inside it; reads may range outside it (read-anywhere). Defaults to
cwd, overridable via `--cwd`/`--root`. This entity carries the system's most important safety
invariant. Closely related to: **AgentRun**, **WriteEditTool**, **ApplyPatchTool**,
**RunCommandTool**, **RepoContext**.

### RepoContext  <!-- REQ-003, REQ-013 -->

The initial understanding of the target repository the AgentRun builds before/while planning:
directory listing, detected project type, detected **test command**, key files — without loading the
whole repo into the prompt. The detected test command becomes the completion-signal command. Closely
related to: **WorkingRoot**, **AgentRun**, **CommandExecution** (test runs).

### Edit  <!-- REQ-008, REQ-010, REQ-011, REQ-023 -->

A proposed change to a single file produced by WriteEditTool or ApplyPatchTool — a (path, before,
after) triple. Every Edit yields a **Diff** and is subject to the edit ApprovalPolicy before it is
persisted to disk. An Edit is "applied" only after approval and a successful write. Closely related
to: **Diff**, **ApprovalPolicy**, **WriteEditTool**, **ApplyPatchTool**, **WorkingRoot**.

### Diff  <!-- REQ-010, REQ-017, REQ-019 -->

The unified-diff (before → after) representation of an Edit, shown to the user. **The Diff is the
contract of no-silent-writes**: no file mutation exists in this domain without a corresponding Diff.
Diffs are streamed during the run and summarized in the final output. Closely related to: **Edit**,
**Transcript**, **RunOutcome**.

### Patch  <!-- REQ-023 -->

A unified-diff document supplied *as input* to ApplyPatchTool (one or more hunks across one or more
files), as distinct from a **Diff** which is the *output* representation of any applied Edit. A Patch
may apply cleanly (producing Edits) or fail to apply (producing a rejection ToolResult). Closely
related to: **ApplyPatchTool**, **Edit**, **Diff**.

### CommandExecution  <!-- REQ-009, REQ-013, REQ-016, REQ-021 -->

A single shell command run by RunCommandTool inside the WorkingRoot, capturing exit code, stdout, and
stderr. Test runs are CommandExecutions whose result is the primary completion signal. Every
CommandExecution is checked against the command ApprovalPolicy (allowlist auto-run / non-allowlisted
confirm) before it runs, and is confined to the root. Closely related to: **RunCommandTool**,
**Allowlist**, **ApprovalPolicy**, **TestRun (specialization)**, **RunOutcome**.

### ApprovalPolicy  <!-- REQ-012, REQ-016, REQ-NFR-005 -->

The configured rule governing whether an action proceeds automatically or requires user
confirmation. Two distinct policies exist: the **edit policy** (default *confirm-each*, overridable by
`--yes`/`--auto`) governing Edits, and the **command policy** (allowlist auto-runs; every
non-allowlisted command confirms; `--yes`/`--auto` runs all) governing CommandExecutions. ⚠ These
policies are the trust boundary of the tool. Closely related to: **Edit**, **CommandExecution**,
**Allowlist**, **ApprovalDecision**, **Config**.

### ApprovalDecision

The concrete resolution of an ApprovalPolicy for one ToolCall: *auto-approved* (policy permits
without prompting), *approved-by-user*, or *denied*. A denied decision produces an error ToolResult
rather than executing the action. (Implicit, lightweight entity — the per-action outcome of applying
an ApprovalPolicy.) Closely related to: **ApprovalPolicy**, **ToolCall**, **ToolResult**.

### Allowlist  <!-- REQ-016, REQ-025, REQ-018 -->

The configurable set of commands the command policy auto-runs without confirmation. Default entries:
the detected test/build command plus common safe read-only commands (`ls`, `cat`, `grep`,
`git status`). The user can **inspect, add, and remove** entries (REQ-025), and changes persist to
Config. Composed of **AllowlistEntry** items. Closely related to: **ApprovalPolicy**,
**CommandExecution**, **Config**.

### AllowlistEntry  <!-- REQ-016, REQ-025 -->

A single member of the Allowlist — a command pattern that, when matched, causes a CommandExecution to
auto-run. Closely related to: **Allowlist**.

### Budget  <!-- REQ-015, REQ-NFR-003 -->

The configurable ceilings that bound a run: a **max-iteration count** (default 25) and a **token/cost
budget** (default ≈ 1,000,000 tokens, input + output, per run). Consumption accrues across Iterations;
hitting either ceiling triggers a StopCondition. **A run can never exceed its Budget.** Closely
related to: **AgentRun**, **Iteration**, **StopCondition**, **Config**.

### StopCondition  <!-- REQ-014, REQ-015 -->

The single defined reason an AgentRun's loop terminates. Enumerated: **task-success** (model declares
done and/or tests pass), **max-iterations-reached**, **budget-exhausted**, **model-give-up**, and
**unrecoverable-error**. The loop *always* ends on exactly one StopCondition — non-termination is not
a permitted state. Closely related to: **AgentRun**, **Budget**, **RunOutcome**.

### RunOutcome  <!-- REQ-014, REQ-019, REQ-020 -->

The terminal result of an AgentRun, derived from its StopCondition: a status (**succeeded** /
**stopped** / **failed**), the files changed (with diffs/summary), tests run and their result,
iterations used, and approximate token/cost usage. Drives the process exit code (0 = succeeded,
non-zero = stopped/failed) and the final summary. Closely related to: **AgentRun**, **StopCondition**,
**Diff**, **RunSummary**.

### RunSummary  <!-- REQ-019, REQ-024 -->

The final report of a completed run, rendered in two forms: a human-readable summary (REQ-019) and a
schema-stable machine-readable **`--json`** object (REQ-024). Both convey the same RunOutcome. Closely
related to: **RunOutcome**, **Transcript**.

### Transcript  <!-- REQ-022, REQ-NFR-008 -->

The durable on-disk record of the run: an ordered log of every Iteration, ToolCall, ToolResult,
ApprovalDecision, Diff, and StopCondition. **It must be sufficient to reconstruct what the agent did
and why** (REQ-NFR-008). Append-only and inspectable after the run; not a query engine or dashboard
(SCOPE-RISK-002). Composed of **TranscriptEntry** items. ⚠ *blast-radius: data integrity / audit.*
Closely related to: **AgentRun**, **TranscriptEntry**, every domain event.

### TranscriptEntry  <!-- REQ-022 -->

A single timestamped, typed record in the Transcript (e.g. iteration-started, tool-called,
tool-result, edit-applied, command-run, run-stopped). The atomic unit of the audit trail. Closely
related to: **Transcript**, **Domain Events**.

### Config  <!-- REQ-018, REQ-025 -->

The resolved configuration for a run, merged from flags, environment variables, and an optional
config file: Anthropic API key (`ANTHROPIC_API_KEY`), model id, working root, edit/command approval
modes, iteration ceiling, token budget, and the Allowlist. Allowlist changes (REQ-025) persist back
to the config file. Closely related to: **AgentRun**, **ApprovalPolicy**, **Budget**, **Allowlist**,
**WorkingRoot**.

---

## Relationships

- **Task → AgentRun** (one-to-one) — one natural-language task starts exactly one run; the run exists
  to satisfy the task (REQ-001).
- **AgentRun → Iteration** (one-to-many, ordered) — a run is a sequence of numbered loop turns;
  iteration count is capped by the Budget ceiling (REQ-004, REQ-015).
- **Iteration → ConversationMessage** (one-to-many) — each turn appends messages (assistant response,
  tool results) to the run's conversation (REQ-004).
- **Iteration → ToolCall** (one-to-many) — a turn may request zero or more tool calls (REQ-005).
- **ToolCall → Tool** (many-to-one) — every call names one of the five Tools (REQ-005, five-tool
  surface).
- **ToolCall → ToolResult** (one-to-one) — every executed call yields exactly one result (success or
  error), fed back into the next iteration (REQ-005, REQ-NFR-004).
- **ToolCall → ApprovalDecision** (one-to-one, for mutating/executing calls) — write/edit/patch and
  command calls each pass through one approval decision before taking effect (REQ-012, REQ-016).
- **ApprovalPolicy → ApprovalDecision** (one-to-many) — a policy resolves into a decision per relevant
  ToolCall (REQ-012, REQ-016).
- **WriteEditTool / ApplyPatchTool → Edit** (one-to-many) — a mutating tool call produces one or more
  Edits (REQ-008, REQ-023).
- **Edit → Diff** (one-to-one) — every Edit has exactly one Diff; no Edit without a Diff (REQ-010).
- **Patch → Edit** (one-to-many, on successful apply) — a clean patch produces one Edit per affected
  file; a non-applying patch produces zero Edits and a rejection result (REQ-023).
- **RunCommandTool → CommandExecution** (one-to-one per call) — a run-command call is one command
  execution (REQ-009).
- **CommandExecution → Allowlist** (checked-against, many-to-one) — every command is matched against
  the allowlist by the command policy before running (REQ-016).
- **Allowlist → AllowlistEntry** (one-to-many, composition) — the allowlist is a set of entries
  (REQ-016, REQ-025).
- **AgentRun → WorkingRoot** (one-to-one) — a run is confined to one resolved root for writes/exec
  (REQ-002, REQ-021).
- **WorkingRoot → RepoContext** (one-to-one) — context is gathered about the one root (REQ-003).
- **AgentRun → Budget** (one-to-one) — one run, one set of ceilings; consumption accrues across
  iterations (REQ-015).
- **AgentRun → StopCondition** (one-to-one) — a run terminates on exactly one stop condition
  (REQ-014).
- **StopCondition → RunOutcome** (one-to-one) — the stop condition determines the outcome status and
  exit code (REQ-014, REQ-020).
- **RunOutcome → RunSummary** (one-to-one, rendered two ways) — the outcome is reported human-readably
  and as `--json` (REQ-019, REQ-024).
- **AgentRun → Transcript** (one-to-one) — each run writes one durable transcript (REQ-022).
- **Transcript → TranscriptEntry** (one-to-many, ordered, composition) — the transcript is an ordered
  log of entries (REQ-022, REQ-NFR-008).
- **Config → {ApprovalPolicy, Budget, Allowlist, WorkingRoot, model}** (one-to-many provisioning) —
  config supplies the run's policies, ceilings, allowlist, root, and model (REQ-018).

---

## Attributes

### AgentRun

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| runId | string (uuid/timestamp) | unique per invocation |
| task | string (Task) | required, non-empty (REQ-001) |
| state | enum (lifecycle) | see State Models; exactly one current state |
| iterationsUsed | integer | 0 ≤ iterationsUsed ≤ Budget.maxIterations (REQ-015) |
| tokensUsed | integer | 0 ≤ tokensUsed ≤ Budget.tokenBudget (REQ-015) |
| startedAt / endedAt | timestamp | endedAt set only when terminal |
| outcome | RunOutcome | set only at terminal state (REQ-019) |

### Iteration

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| index | integer | 1-based, strictly increasing within a run |
| modelResponse | ConversationMessage | the assistant turn (tool_use or final) |
| toolCalls | ToolCall[] | may be empty (final-answer turn) |
| toolResults | ToolResult[] | one per executed toolCall |

### ToolCall

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| toolName | enum(read, list/search, write/edit, run-command, apply-patch) | must be one of the five (REQ-005) |
| arguments | object | shape per the tool's input schema |
| isMutating | boolean | true for write/edit & apply-patch |
| isExecuting | boolean | true for run-command |

### ToolResult

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| status | enum(ok, error) | error never crashes the loop (REQ-NFR-004) |
| output | string / structured | tool-specific success payload |
| error | { code, message } | actionable; fed back to model (REQ-NFR-004, REQ-023) |

### WorkingRoot

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| absolutePath | string (resolved abs path) | validated to exist & be a directory (REQ-002) |
| writeExecConfined | boolean (always true) | invariant boundary for writes/exec (REQ-021) |
| readScope | enum(anywhere) | reads may leave the root (REQ-021) |

### Edit

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| targetPath | string (path within root) | must resolve inside WorkingRoot (REQ-021) |
| before | string / null | null when creating a new file |
| after | string | new file contents |
| diff | Diff | required — no Edit without a Diff (REQ-010) |
| applied | boolean | true only after approval + successful write (REQ-011) |

### CommandExecution

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| command | string | the shell command line (REQ-009) |
| cwd | string | must equal/descend WorkingRoot (REQ-021) |
| allowlisted | boolean | drives auto-run vs. confirm (REQ-016) |
| exitCode | integer | captured (REQ-009) |
| stdout / stderr | string | captured (REQ-009) |
| isTestRun | boolean | true when command = detected test command (REQ-013) |

### Budget

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| maxIterations | integer | default 25; configurable; > 0 (REQ-015) |
| tokenBudget | integer | default ≈ 1,000,000; configurable; > 0 (REQ-015) |

### ApprovalPolicy

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| scope | enum(edit, command) | two distinct policies (REQ-012, REQ-016) |
| editMode | enum(confirm-each, auto) | default confirm-each (REQ-012) |
| commandMode | enum(allowlist-confirm, auto) | default allowlist-confirm (REQ-016) |

### Allowlist / AllowlistEntry

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| entries | AllowlistEntry[] | inspect/add/remove; persists to Config (REQ-025) |
| entry.pattern | string | command or prefix pattern that auto-runs (REQ-016) |

### RunOutcome

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| status | enum(succeeded, stopped, failed) | derived from StopCondition (REQ-014) |
| stopCondition | enum (see StopCondition) | the terminating reason (REQ-014) |
| filesChanged | Diff[] / summary | (REQ-019) |
| testsResult | { ran, passed, failed } | (REQ-013, REQ-019) |
| iterationsUsed / tokensUsed | integer | (REQ-019) |
| exitCode | integer | 0 = succeeded; non-zero = stopped/failed (REQ-020) |

### Transcript / TranscriptEntry

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| path | string (on-disk) | durable file per run (REQ-022) |
| entries | TranscriptEntry[] | append-only, ordered (REQ-022, REQ-NFR-008) |
| entry.type | enum (event type) | iteration-started, tool-called, tool-result, edit-applied, command-run, run-stopped, … |
| entry.timestamp | timestamp | (REQ-NFR-008) |
| entry.payload | object | inputs/outputs sufficient to reconstruct (REQ-NFR-008) |

### Config

| Attribute | Type / Format | Constraints / Notes |
|---|---|---|
| apiKey | string (env ANTHROPIC_API_KEY) | required; fail-fast if missing (REQ-018, REQ-NFR-006) |
| modelId | string | default current Claude model; overridable (REQ-018) |
| root | string | working root (REQ-002, REQ-018) |
| editMode / commandMode | enum | approval modes (REQ-012, REQ-016) |
| maxIterations / tokenBudget | integer | ceilings (REQ-015) |
| allowlist | AllowlistEntry[] | persisted set (REQ-018, REQ-025) |

---

## State Models

### AgentRun States  <!-- REQ-013, REQ-014, REQ-015 -->

The AgentRun lifecycle. The loop **always** reaches exactly one terminal state via a StopCondition;
non-termination is not a permitted state.

| State | Meaning | Transitions to | Trigger / Guard |
|---|---|---|---|
| **Initializing** | Config resolved, WorkingRoot resolved & validated, Task captured | GatheringContext; **Failed** | guard: valid config + existing root; fail-fast on missing API key / bad root (REQ-002, REQ-018, REQ-NFR-006) |
| **GatheringContext** | Building RepoContext (listing, project type, test command) | Iterating | initial context assembled (REQ-003) |
| **Iterating** | Running a loop turn: send to model, receive ToolCalls or final answer | AwaitingApproval; Iterating; **Terminating** | model returned tool calls needing approval → AwaitingApproval; auto/non-gated calls → loop again; final answer / stop condition met → Terminating (REQ-004, REQ-005) |
| **AwaitingApproval** | A mutating Edit or non-allowlisted CommandExecution is pending user confirmation | Iterating; **Terminating** | user approves → execute → Iterating; user denies → error ToolResult → Iterating; user aborts run → Terminating (REQ-012, REQ-016) |
| **Terminating** | A StopCondition has fired; finalizing | **Succeeded**; **Stopped**; **Failed** | classify StopCondition into outcome status (REQ-014) |
| **Succeeded** *(terminal)* | task-success stop condition; exit 0 | — | model declared done and/or tests pass (REQ-014, REQ-020) |
| **Stopped** *(terminal)* | bounded stop: max-iterations / budget-exhausted / model-give-up; non-zero exit | — | Budget or give-up reached (REQ-014, REQ-015, REQ-020) |
| **Failed** *(terminal)* | unrecoverable error (bad config, fatal harness error); non-zero exit | — | unrecoverable-error stop condition (REQ-014, REQ-020) |

**Budget guard (applies on every Iterating → Iterating step):** before starting the next turn, if
`iterationsUsed ≥ maxIterations` **or** `tokensUsed ≥ tokenBudget`, the run must transition to
Terminating with the corresponding StopCondition — it may **not** start another iteration
(REQ-015, REQ-NFR-003). On every terminal transition, the Transcript records the StopCondition and the
RunSummary is emitted (REQ-019, REQ-022, REQ-024).

### Iteration States  <!-- REQ-005, REQ-NFR-004 -->

A sub-lifecycle within one loop turn — it earns its place because the approval gate and the
error-as-result rule both live here.

| State | Meaning | Transitions to | Trigger / Guard |
|---|---|---|---|
| **Requested** | Prompt sent to model; awaiting response | Planned | model responds (REQ-004) |
| **Planned** | Model returned ToolCalls (or a final answer) | Gated; **Final** | tool calls present → Gated; final answer → Final (REQ-005) |
| **Gated** | Mutating/executing calls evaluated against ApprovalPolicy | Executing | auto-approved / user-approved → Executing; denied → Executing (with denial as error result) (REQ-012, REQ-016) |
| **Executing** | Approved tool calls run; results captured | Recorded | each ToolCall → one ToolResult; tool error → error result, never crash (REQ-NFR-004) |
| **Recorded** | Results appended to conversation + Transcript | (next Iteration) / **Final** | feed results back; loop continues unless stop condition met (REQ-022) |
| **Final** | Model declared done; hands to AgentRun Terminating | — | task-success or give-up signal (REQ-014) |

### Edit States  <!-- REQ-010, REQ-011, REQ-012 -->

| State | Meaning | Transitions to | Trigger / Guard |
|---|---|---|---|
| **Proposed** | Edit computed; Diff generated and shown | Approved; Rejected; **Denied** | edit policy resolves (REQ-010, REQ-012) |
| **Approved** | Auto (`--yes`) or user-confirmed | **Applied**; **Failed** | guard: targetPath resolves inside WorkingRoot (REQ-021) |
| **Applied** *(terminal)* | Persisted to disk; visible to later tool calls | — | write succeeded (REQ-011) |
| **Denied** *(terminal)* | User declined; produces error ToolResult | — | edit policy / user (REQ-012) |
| **Rejected** *(terminal)* | Path-escape or write error; rejected pre-write | — | confinement violation or IO error (REQ-021) |

---

## Domain Rules

- **RULE-001** — **Confinement of writes/exec.** No WriteEditTool, ApplyPatchTool, or RunCommandTool
  action may target or execute outside the resolved WorkingRoot; any write/exec path that escapes via
  traversal, absolute path, or symlink is rejected **before** the operation. — REQ-021, REQ-NFR-005
  ⚠ *blast-radius: data integrity / safety.*
- **RULE-002** — **No silent writes.** Every file-mutating action (write/edit/apply-patch) produces a
  unified Diff that is shown to the user; an Edit cannot reach **Applied** without a Diff existing
  first. — REQ-010 ⚠ *blast-radius: data integrity.*
- **RULE-003** — **Read-anywhere is write-isolated.** Reads may access paths outside the WorkingRoot,
  but content read from outside the root can never be written back outside the root (writes remain
  confined by RULE-001). — REQ-021 ⚠ *blast-radius: data integrity / read-exposure (residual,
  accepted).*
- **RULE-004** — **Edit-approval gating.** No Edit is persisted unless the edit ApprovalPolicy permits
  it: default *confirm-each* requires user confirmation per file; `--yes`/`--auto` auto-applies. —
  REQ-012, REQ-NFR-005
- **RULE-005** — **Command-approval gating.** No CommandExecution runs unless the command
  ApprovalPolicy permits it: an allowlisted command auto-runs; every non-allowlisted command requires
  user confirmation; `--yes`/`--auto` runs all. — REQ-016, REQ-NFR-005 ⚠ *blast-radius: safety
  (arbitrary command execution).*
- **RULE-006** — **Budget is a hard ceiling.** A run can never exceed its configured max-iterations
  or token budget; the loop must check both before starting each iteration and stop on the first
  ceiling reached. — REQ-015, REQ-NFR-003 ⚠ *blast-radius: cost.*
- **RULE-007** — **Bounded termination.** Every AgentRun terminates on exactly one StopCondition
  (task-success, max-iterations, budget-exhausted, model-give-up, unrecoverable-error); the loop is
  never permitted to run unbounded. — REQ-014
- **RULE-008** — **Tool errors are results, not crashes.** A failing tool call (file-not-found,
  non-applying patch, command non-zero exit, denied approval) is returned to the model as an error
  ToolResult; transient LLM API failures are retried with bounded backoff. The process does not crash
  on a recoverable tool/LLM failure. — REQ-NFR-004
- **RULE-009** — **Tests are the completion signal.** Task completion is judged primarily by running
  the repo's detected test command via run-command and reading its pass/fail result, not by the
  model's self-report. — REQ-013
- **RULE-010** — **Durable, reconstructable audit.** The Transcript is written durably on disk and
  records every Iteration, ToolCall, ToolResult, ApprovalDecision, Diff, and StopCondition with
  enough detail (inputs/outputs, timestamps) to reconstruct what the agent did and why. — REQ-022,
  REQ-NFR-008 ⚠ *blast-radius: data integrity / audit.*
- **RULE-011** — **Exit code reflects outcome.** The process exits 0 if and only if the RunOutcome is
  *succeeded*; any *stopped* or *failed* outcome exits non-zero, so the CLI is scriptable. — REQ-020
- **RULE-012** — **Fixed five-tool surface.** The model is exposed exactly five Tools (read,
  list/search, write/edit, run-command, apply-patch); the harness does not execute any tool name
  outside this set. — REQ-005, REQ-006…REQ-009, REQ-023 (SCOPE-RISK-001)
- **RULE-013** — **Apply-patch atomic rejection.** A malformed or non-applying Patch is rejected as a
  whole with an actionable error fed back as a ToolResult; it produces no partial Edits. — REQ-023
- **RULE-014** — **Allowlist changes persist.** Inspect/add/remove operations on the Allowlist take
  effect for the command policy and are persisted to the Config file. — REQ-025, REQ-018
- **RULE-015** — **Deterministic harness.** All non-LLM logic (tool dispatch, path sandboxing, diff
  generation, edit application, loop control, stop conditions, config parsing, allowlist matching) is
  deterministic and exercisable without live model/network/shell, with the SDK and shell injected
  behind interfaces. — REQ-NFR-002
- **RULE-016** — **Fail-fast misconfiguration.** Missing required config (notably the Anthropic API
  key) or an invalid working root fails fast in Initializing with an actionable message, before any
  iteration begins. — REQ-018, REQ-NFR-006

---

## Domain Events

| Event | Emitted by | REQ-ID | Meaning |
|---|---|---|---|
| **RunStarted** | AgentRun | REQ-001, REQ-022 | A run began: task, root, config captured |
| **ContextGathered** | AgentRun | REQ-003 | RepoContext built (listing, project type, test command) |
| **IterationStarted** | Iteration | REQ-004, REQ-022 | A new loop turn began (with index) |
| **ToolCalled** | ToolCall | REQ-005, REQ-022 | The model requested a tool with given arguments |
| **ApprovalRequested** | ApprovalPolicy | REQ-012, REQ-016 | A mutating/executing call awaits user confirmation |
| **ApprovalDecided** | ApprovalDecision | REQ-012, REQ-016 | A call was auto-approved, approved, or denied |
| **EditProposed** | WriteEditTool / ApplyPatchTool | REQ-010 | An Edit + its Diff were produced and shown |
| **EditApplied** | Edit | REQ-011 | An approved Edit was persisted to disk |
| **EditRejected** | Edit | REQ-021 | An Edit was rejected (path-escape or write error) |
| **PatchRejected** | ApplyPatchTool | REQ-023 | A malformed/non-applying patch was rejected |
| **CommandRun** | CommandExecution | REQ-009, REQ-022 | A shell command executed; exit/stdout/stderr captured |
| **TestsRun** | CommandExecution (test) | REQ-013 | The detected test command ran; pass/fail captured |
| **ToolResultRecorded** | ToolResult | REQ-005, REQ-022 | A tool result (ok/error) was fed back to the loop |
| **BudgetExceeded** | Budget | REQ-015, REQ-NFR-003 | An iteration or token ceiling was reached |
| **LLMRetry** | AgentRun | REQ-NFR-004 | A transient LLM API failure triggered bounded-backoff retry |
| **RunStopped** | StopCondition | REQ-014, REQ-022 | The loop terminated on a defined stop condition |
| **RunCompleted** | RunOutcome | REQ-019, REQ-024 | Final summary emitted (human + `--json`), exit code set |
| **AllowlistChanged** | Allowlist | REQ-025, REQ-018 | An allowlist entry was added/removed and persisted |

*All events that occur during a run are recorded as TranscriptEntries (RULE-010, REQ-022,
REQ-NFR-008).*

---

## Glossary

| Term | Definition |
|---|---|
| **Task** | The natural-language coding goal the developer gives the CLI; one per run (REQ-001). |
| **AgentRun (Run)** | A single CLI invocation and its full lifecycle, from one Task to one RunOutcome; the aggregate root. |
| **Iteration (loop turn)** | One cycle of: send-to-model → receive tool calls/answer → execute → record. |
| **Agent loop** | The repeated sequence of Iterations that drives a run toward completion (REQ-004). |
| **Tool** | One of the five named capabilities the model can invoke (read, list/search, write/edit, run-command, apply-patch). |
| **ToolCall** | A concrete request by the model to invoke a Tool with arguments. |
| **ToolResult** | The success-or-error outcome of a ToolCall, fed back to the model. |
| **WorkingRoot (root)** | The resolved directory that confines all writes and command execution; reads may range outside it. |
| **Read-anywhere** | The policy allowing reads outside the WorkingRoot; writes/exec remain confined (REQ-021). |
| **Write/exec-in-root** | The confinement rule: file mutations and shell commands never escape the WorkingRoot (REQ-021). |
| **RepoContext** | The initial understanding of the target repo (listing, project type, detected test command) (REQ-003). |
| **Edit** | A proposed change to one file (path, before, after); always carries a Diff (REQ-008/REQ-010). |
| **Diff** | The unified before→after representation of an Edit, shown to the user (REQ-010). |
| **Patch** | A unified-diff document supplied as input to apply-patch (distinct from a Diff, which is output) (REQ-023). |
| **CommandExecution** | One shell command run in the root, capturing exit code, stdout, stderr (REQ-009). |
| **Test command** | The repo's detected test/build command; running it is the primary completion signal (REQ-013). |
| **ApprovalPolicy** | The rule governing whether an Edit or command auto-runs or needs confirmation (REQ-012/REQ-016). |
| **Confirm-each** | The default edit policy: show a diff and ask before each write (REQ-012). |
| **Allowlist** | The configurable set of commands that auto-run without confirmation (REQ-016/REQ-025). |
| **AllowlistEntry** | A single command pattern in the Allowlist. |
| **Budget** | The run's ceilings: max-iterations (default 25) + token budget (default ≈ 1M) (REQ-015). |
| **StopCondition** | The single defined reason a run's loop terminates (REQ-014). |
| **RunOutcome** | The terminal result (succeeded / stopped / failed) and its summary data (REQ-014/REQ-019). |
| **RunSummary** | The final report, rendered human-readably and as `--json` (REQ-019/REQ-024). |
| **`--json` output** | The schema-stable machine-readable rendering of the RunSummary (REQ-024). |
| **Transcript** | The durable on-disk, append-only audit log of the run (REQ-022/REQ-NFR-008). |
| **TranscriptEntry** | One timestamped, typed record in the Transcript. |
| **Config** | The merged configuration (flags + env + file) provisioning a run (REQ-018). |
| **Harness** | All non-LLM, deterministic logic of the system (tool dispatch, sandboxing, diff, loop control) (REQ-NFR-002). |
| **Principal** | The developer running the CLI — the authority who approves edits/commands and owns the task. |

---

## Open Domain Questions

> Recorded for the Orchestrator. This stage streams (no interactive AskUserQuestion); these are
> non-blocking and proceed under the noted defaults unless the human directs otherwise. All four
> requirements-level blocking decisions (OQ-1…OQ-4) are already resolved upstream.

- **DQ-001** *(non-blocking)* — **Token accounting granularity for the Budget.** Is `tokensUsed`
  tracked per-iteration and summed, and does it count input + output (the requirements say
  "input+output per run")? Assumed default if proceeding: accrue input+output tokens per LLM call,
  sum across iterations, check against `tokenBudget` before each new iteration (REQ-015). A precise
  token-counting mechanism (SDK usage field vs. estimate) is a technical-design detail, not a domain
  ambiguity.
- **DQ-002** *(non-blocking)* — **ApprovalDecision modeling weight.** Is `ApprovalDecision` a
  first-class persisted entity in the Transcript, or an attribute of the ToolCall/Edit? Assumed
  default: model it as a recorded property of the gated ToolCall/Edit (and a TranscriptEntry via
  `ApprovalDecided`), not a standalone aggregate. Either is coherent; flagged so downstream contracts
  pick one consistently.
- **DQ-003** *(non-blocking)* — **Diff vs. Patch terminology lock.** The model deliberately
  distinguishes **Diff** (output representation of any applied Edit) from **Patch** (unified-diff
  *input* to apply-patch). Confirm this split is the canonical downstream vocabulary so contracts and
  tests don't conflate them (REQ-010 vs. REQ-023).
- **DQ-004** *(non-blocking)* — **"Tests pass" vs. "model declares done" as the success
  StopCondition.** REQ-014 lists task-success as "model declares done **and/or** tests pass."
  Assumed default: when a test command is detected, passing tests is the authoritative success signal
  (RULE-009); absent a runnable test command, the model's declaration is accepted as success with the
  outcome noting tests were not run. The exact precedence is a technical-design choice; recorded here
  so it is decided deliberately, not by accident.
