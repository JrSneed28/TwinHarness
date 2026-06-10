# Contracts — Autocoder

> **Stage 7 — Contracts** (spec §15.7). Tier T3. Streams; surfaces product-affecting choices as
> explicit decisions (§8). **There is NO authentication/authorization in this system** — Autocoder
> is a local single-user CLI whose only secret is the developer's own `ANTHROPIC_API_KEY` read from
> env, so there is **no auth contract and no auth gate**. Derives every contract from
> `04-architecture.md` and `03-domain-model.md` (field names taken from the domain vocabulary, not
> invented), with behaviors and error codes pinned by `06-technical-design.md` and the ADRs. Each
> contract is a testable boundary — Stage 8 maps tests to these definitions. Slices do not exist
> yet, so the Slice columns reference component-touched labels rather than S-numbers.

## Summary

This document pins **17 cross-component interfaces** for Autocoder, an in-process, single-process
CLI — there is no network surface of our own (the one outbound call is the Anthropic Messages API,
wrapped behind the `LlmClient` seam). The central, model-facing contracts are the **five Tool
schemas** (`read_file`, `list_search`, `write_edit`, `run_command`, `apply_patch`) that `LlmClient`
serializes as the Messages API `tools` field and that the model calls as native structured tool-use
(ADR-001); each tool's input is typed and constrained, and each enumerates its complete error set.
Two **DI-seam interfaces** — `LlmClient` and `CommandRunner` — isolate the only non-deterministic
edges so the whole harness is deterministically testable (REQ-NFR-002, ADR-004). The durable data
contracts are the **versioned `TranscriptEntry`** discriminated-union JSONL schema (ADR-002), the
**`RunSummary`** rendered in both human and `--json` form, and the resolved **`Config`** schema.
The integration pattern is **in-process module boundaries + one model-facing tool protocol**; there
are no cross-boundary message-bus events (domain events are recorded as TranscriptEntries, not
published). Error handling has two channels: **expected failures → error `ToolResult` fed back to
the model** (ADR-007/RULE-008); **fatal failures → `unrecoverable-error` StopCondition** ending the
run.

- **Interfaces defined:** 5 model-facing Tool contracts · 2 DI-seam interfaces (`LlmClient`,
  `CommandRunner`) · 6 internal module contracts (`ToolRegistry`, `ApprovalGate`, `PathSandbox`,
  `Budget/StopCondition`, `Transcript writer`, `Diff/Patch engine`) · 1 CLI argument surface ·
  3 data schemas (`TranscriptEntry`, `RunSummary`/`--json`, `Config`). (17 total.)
- **Integration pattern:** in-process TypeScript module boundaries + one native structured tool-use
  protocol (ADR-001) across the `LlmClient` seam; no own HTTP/RPC server, no message bus.
- **Auth scheme (human-approved):** **none — N/A.** Local single-user CLI; the only credential is
  the developer-supplied `ANTHROPIC_API_KEY` (env), passed by `LlmClient` to the Anthropic SDK as a
  bearer token. No authn/authz boundary exists in this system, so no auth gate applies.
- **Versioning strategy:** `TranscriptEntry` carries a `schemaVersion` string with **additive-only
  evolution** (ADR-002); the `--json` `RunSummary` is **stable for CI** under the same additive
  rule; the five Tool schemas are an internal model-facing contract versioned implicitly with the
  package (no external compatibility promise).

---

## Interface Index

| ID | Name | Type | Owner component | Consumer(s) | REQ-IDs | Slice (component label) |
|---|---|---|---|---|---|---|
| IF-001 | `read_file` tool | Model-facing tool schema | `tool-read` | model (via `llm-client`), `tool-registry` | REQ-006, REQ-021 | `tool-read` |
| IF-002 | `list_search` tool | Model-facing tool schema | `tool-search` | model (via `llm-client`), `tool-registry` | REQ-007 | `tool-search` |
| IF-003 | `write_edit` tool | Model-facing tool schema | `tool-writeedit` | model (via `llm-client`), `tool-registry` | REQ-008, REQ-010, REQ-011, REQ-021 | `tool-writeedit` |
| IF-004 | `run_command` tool | Model-facing tool schema | `tool-runcommand` | model (via `llm-client`), `tool-registry` | REQ-009, REQ-013, REQ-016, REQ-021 | `tool-runcommand` |
| IF-005 | `apply_patch` tool | Model-facing tool schema | `tool-applypatch` | model (via `llm-client`), `tool-registry` | REQ-023, REQ-010, REQ-011, REQ-012, REQ-021 | `tool-applypatch` |
| IF-006 | `LlmClient` | DI-seam interface | `llm-client` | `agent-run` | REQ-004, REQ-005, REQ-NFR-002, REQ-NFR-004 | `llm-client` |
| IF-007 | `CommandRunner` | DI-seam interface | `command-runner` | `tool-runcommand` | REQ-009, REQ-NFR-002, REQ-NFR-007 | `command-runner` |
| IF-008 | `ToolRegistry` (dispatch) | Internal module contract | `tool-registry` | `agent-run` | REQ-005, REQ-NFR-004 | `tool-registry` |
| IF-009 | `ApprovalGate` | Internal module contract | `approval-gate` | `tool-writeedit`, `tool-applypatch`, `tool-runcommand` | REQ-012, REQ-016, REQ-NFR-005 | `approval-gate` |
| IF-010 | `PathSandbox` | Internal module contract | `path-sandbox` | `tool-read`, `tool-writeedit`, `tool-applypatch`, `tool-runcommand` | REQ-021, REQ-NFR-005, REQ-NFR-007 | `path-sandbox` |
| IF-011 | `BudgetController` (accrual + guard + classify) | Internal module contract | `budget-stop` | `agent-run` | REQ-014, REQ-015, REQ-020, REQ-NFR-003 | `budget-stop` |
| IF-012 | `TranscriptWriter` | Internal module contract | `transcript` | `agent-run`, all event emitters | REQ-022, REQ-NFR-008 | `transcript` |
| IF-013 | `DiffPatchEngine` | Internal module contract | `diff-engine` | `tool-writeedit`, `tool-applypatch` | REQ-010, REQ-008, REQ-023 | `diff-engine` |
| IF-014 | CLI argument surface | CLI invocation contract | `cli` | developer (terminal), CI | REQ-001, REQ-002, REQ-020, REQ-024, REQ-025, REQ-NFR-006 | `cli` |
| IF-015 | `TranscriptEntry` schema | Versioned data schema | `transcript` | transcript readers, V1 resume | REQ-022, REQ-NFR-008 | `transcript` |
| IF-016 | `RunSummary` / `--json` schema | Versioned data schema | `reporter` | developer, CI consumers | REQ-019, REQ-024, REQ-020 | `reporter` |
| IF-017 | `Config` schema | Data schema | `config` | `agent-run`, `approval-gate`, `budget-stop`, `allowlist` | REQ-018, REQ-002, REQ-015, REQ-016, REQ-025 | `config` |

---

## API / Module Contracts

> The five model-facing Tool contracts (IF-001…IF-005) are the central contracts: these JSON Schemas
> are exactly what `LlmClient` attaches as the Messages API `tools` field (ADR-001). All tool inputs
> are **untrusted model output** — every path is validated by `PathSandbox` (IF-010) and every
> mutation/exec is gated by `ApprovalGate` (IF-009) before any side effect. Each tool returns a
> normalized `ToolResult` (see **Data Schemas → ToolResult**); errors below are returned as
> `status: "error"` ToolResults fed back to the model (ADR-007/RULE-008), never thrown — except where
> noted as **fatal**.

### IF-001 — `read_file` tool

**Type:** Model-facing tool schema (native structured tool-use)
**Owner:** `tool-read`
**Consumers:** model (serialized by `llm-client`), `tool-registry`
**Realizes:** REQ-006, REQ-021 (read-anywhere half / RULE-003)
**Required by slices:** `tool-read`

#### Request / Input

```
path:      string  [required] — file path to read; may resolve OUTSIDE the WorkingRoot (read-anywhere, RULE-003); min length 1
startLine: integer [optional] — 1-based first line of a bounded range; ≥ 1; if omitted, read from start
lineCount: integer [optional] — number of lines to return from startLine; ≥ 1; if omitted, read to EOF (capped, see output)
```

#### Response / Output

```
content:    string  — file contents (full file, or the requested [startLine, startLine+lineCount) slice)
truncated:  boolean — true when a default line cap (e.g. 2000 lines) elided trailing content
totalLines: integer — total line count of the file (so the model can request the next range)
```

**Preconditions:** `path` is a resolvable filesystem path. No containment check (reads are never
confined — INV-002).
**Postconditions:** no state change; the read is recorded as a TranscriptEntry (`tool-result`).
**Side effects:** none (read-only; the only effector permitted outside the root).

#### Error responses

| Code / type | Condition | Response payload |
|---|---|---|
| `READ_FAILED` | file not found, is-a-directory, or permission denied | error `ToolResult` — see Error Contracts (ERR-006) |

---

### IF-002 — `list_search` tool

**Type:** Model-facing tool schema
**Owner:** `tool-search`
**Consumers:** model (serialized by `llm-client`), `tool-registry`
**Realizes:** REQ-007
**Required by slices:** `tool-search`

#### Request / Input

```
mode:       enum("list","search") [required] — list directory entries, or search file contents
path:       string  [optional, default: "."] — directory (list) or search root, relative to WorkingRoot; must resolve inside root
glob:       string  [optional] — glob filter for list mode, or file filter for search mode (e.g. "**/*.ts")
query:      string  [required for mode="search"] — the literal substring or regex to match; min length 1
isRegex:    boolean [optional, default: false] — treat `query` as a regex (search mode)
maxResults: integer [optional, default: 200] — cap on hits/entries returned; 1 ≤ maxResults ≤ 2000
```

#### Response / Output

```
mode:    enum("list","search") — echo of the requested mode
entries: array  — (list mode) directory entries: { name: string, type: enum("file","dir") }
matches: array  — (search mode) hits: { path: string, line: integer, text: string }
count:   integer — number of entries/matches returned
truncated: boolean — true when results were capped at maxResults
```

**Preconditions:** `path` resolves inside the WorkingRoot (listing/search is root-scoped).
**Postconditions:** no state change. An empty result set is a **success** with `count: 0` (not an
error).
**Side effects:** none (read-only).

#### Error responses

| Code / type | Condition | Response payload |
|---|---|---|
| `BAD_PATTERN` | `isRegex: true` and `query` is not a valid regex | error `ToolResult` (ERR-007) |
| `PATH_ESCAPE` | `path` resolves outside the WorkingRoot | error `ToolResult` (ERR-001) |

---

### IF-003 — `write_edit` tool

**Type:** Model-facing tool schema
**Owner:** `tool-writeedit`
**Consumers:** model (serialized by `llm-client`), `tool-registry`
**Realizes:** REQ-008, REQ-010, REQ-011, REQ-021
**Required by slices:** `tool-writeedit` (uses `diff-engine`, `path-sandbox`, `approval-gate`)

#### Request / Input

```
targetPath:    string  [required] — file to create or modify; MUST resolve inside WorkingRoot (RULE-001); min length 1
mode:          enum("write","replace") [required] — whole-file write, or targeted string-replace
content:       string  [required for mode="write"] — full new file contents (the Edit.after)
search:        string  [required for mode="replace"] — exact substring to locate; min length 1
replacement:   string  [required for mode="replace"] — text to substitute for the matched search string
replaceAll:    boolean [optional, default: false] — replace every occurrence (mode="replace"); when false, >1 match is rejected
```

#### Response / Output

```
edit:        object  — the applied Edit: { targetPath: string, before: string|null, after: string, applied: boolean }
diff:        string  — the unified Diff (before → after) generated for this Edit (RULE-002)
approval:    enum("auto-approved","approved-by-user") — how the Edit was permitted
```

**Preconditions:** `targetPath` resolves inside the WorkingRoot. In `replace` mode, the file exists
and `search` occurs the expected number of times (see errors).
**Postconditions:** on success the file is written to disk and the Edit is `applied: true`; a Diff
exists (no silent writes — RULE-002, INV-003). Parent directories within the root are created as
needed.
**Side effects:** writes one file; emits `edit-proposed`, `approval-decided`, `edit-applied` (or
`edit-rejected`) TranscriptEntries.

#### Error responses

| Code / type | Condition | Response payload |
|---|---|---|
| `PATH_ESCAPE` | `targetPath` resolves outside the root (traversal / absolute / symlink) — fail-closed | error `ToolResult` (ERR-001) |
| `SEARCH_NOT_FOUND` | mode="replace" and `search` occurs 0 times — no Edit produced | error `ToolResult` (ERR-002) |
| `SEARCH_AMBIGUOUS` | mode="replace", `search` occurs >1 time and `replaceAll` is false — count reported, no Edit | error `ToolResult` (ERR-003) |
| `APPROVAL_DENIED` | the edit ApprovalPolicy / user denied the Edit | error `ToolResult` (ERR-004) |
| `WRITE_FAILED` | approval passed and containment passed, but the disk write failed (IO error) | error `ToolResult` (ERR-008) |

---

### IF-004 — `run_command` tool

**Type:** Model-facing tool schema
**Owner:** `tool-runcommand`
**Consumers:** model (serialized by `llm-client`), `tool-registry`
**Realizes:** REQ-009, REQ-013, REQ-016, REQ-021
**Required by slices:** `tool-runcommand` (uses `path-sandbox`, `approval-gate`, `command-runner`)

#### Request / Input

```
command:   string  [required] — the shell command line to execute; min length 1
cwd:       string  [optional, default: WorkingRoot] — working directory; MUST equal or descend WorkingRoot (RULE-001)
timeoutMs: integer [optional, default: 120000] — per-command timeout (ODQ-003); 1000 ≤ timeoutMs ≤ 600000
```

#### Response / Output

```
exitCode:  integer — process exit status (captured even when non-zero — a non-zero exit is a RESULT, not an error)
stdout:    string  — captured standard output (bounded/truncated for the prompt)
stderr:    string  — captured standard error (bounded/truncated)
timedOut:  boolean — true if the command was killed at the timeout
isTestRun: boolean — true when `command` equals the detected test command (RULE-009, completion signal)
truncated: boolean — true when stdout/stderr were truncated
```

**Preconditions:** `cwd` passes `PathSandbox.checkExecCwd` (inside root); the command is allowlisted
**or** user-approved by `ApprovalGate` (RULE-005).
**Postconditions:** the command ran inside the root cwd; exit/stdout/stderr captured. A failing test
run is a successful ToolResult carrying `exitCode != 0`.
**Side effects:** arbitrary shell execution within the root (the safety-critical effect); emits
`command-run` / `tests-run` and `approval-decided` TranscriptEntries.

#### Error responses

| Code / type | Condition | Response payload |
|---|---|---|
| `PATH_ESCAPE` | `cwd` resolves outside the root — fail-closed | error `ToolResult` (ERR-001) |
| `APPROVAL_DENIED` | command policy / user denied the command | error `ToolResult` (ERR-004) |
| `COMMAND_TIMEOUT` | the command exceeded `timeoutMs` and was killed | error `ToolResult` (ERR-009) |
| `COMMAND_FAILED` | the process failed to spawn (e.g., executable not found) — distinct from a non-zero exit | error `ToolResult` (ERR-010) |

> Note: a **non-zero exit code is NOT an error** — it is a success ToolResult carrying `exitCode`
> (ADR-007). Only spawn failure and timeout are error ToolResults.

---

### IF-005 — `apply_patch` tool

**Type:** Model-facing tool schema
**Owner:** `tool-applypatch`
**Consumers:** model (serialized by `llm-client`), `tool-registry`
**Realizes:** REQ-023, REQ-010, REQ-011, REQ-012, REQ-021 (enforces RULE-013)
**Required by slices:** `tool-applypatch` (uses `diff-engine`, `path-sandbox`, `approval-gate`)

#### Request / Input

```
patch: string [required] — a unified-diff Patch document (one+ hunks across one+ files), with file
       headers and @@ hunk markers; min length 1. Targets MUST resolve inside the WorkingRoot.
```

#### Response / Output

```
edits:    array  — one Edit per affected file: { targetPath: string, before: string|null, after: string, applied: boolean }
diffs:    array  — the unified Diff generated per applied Edit (string[])
filesChanged: integer — number of files written
approval: enum("auto-approved","approved-by-user") — how the Edits were permitted
```

**Preconditions:** every file target resolves inside the root; **all** hunks across **all** files
dry-run cleanly (context lines match at the stated offset — EXACT line context in the MVP; fuzzed
offset is a V1 refinement, out of scope).
**Postconditions:** **atomic** — either all hunks apply and all Edits are persisted, or **zero**
Edits are produced and nothing is written (RULE-013, INV-007). Diffs exist for every applied Edit
(RULE-002).
**Side effects:** writes one+ files on success; emits `edit-proposed`/`edit-applied` per file, or a
`patch-rejected` entry on rejection.

> **SLICE-6 realization note (pinned):** the fixed protocol is a
> dry-run-EVERYTHING-then-write barrier: (1) `parsePatch` → `PATCH_MALFORMED`; (2)
> `path-sandbox.checkWrite` on EVERY target → any escape → `PATH_ESCAPE`, whole patch
> rejected before any write; (3) `diff-engine.applyHunks` DRY-RUN on EVERY file/hunk →
> any failure → `PATCH_NOT_APPLICABLE`, zero Edits, a `patch-rejected` entry; (4) only
> if all targets are in-root AND all hunks dry-run cleanly: a per-file Diff
> (`generateDiff`) is generated and a **single** `approval-gate.resolveEdit` gates the
> WHOLE patch — the gate's single-Edit surface is fed a synthetic patch-Edit whose
> `diff` is every per-file diff concatenated (so the prompt shows the full blast
> radius) — then every file is persisted. Re-applying an already-applied patch is
> rejected at step 3 (its context no longer matches). Like the other mutating tools, a
> user-abort propagates as `UserAbortError` (clean Stopped, re-raised by the registry).

#### Error responses

| Code / type | Condition | Response payload |
|---|---|---|
| `PATCH_MALFORMED` | the patch text is unparseable (bad headers, inconsistent line counts) | error `ToolResult` (ERR-011) |
| `PATCH_NOT_APPLICABLE` | the patch parses but ≥1 hunk fails to apply — whole patch rejected, zero Edits | error `ToolResult` (ERR-012) |
| `PATH_ESCAPE` | any patch target resolves outside the root — fail-closed | error `ToolResult` (ERR-001) |
| `APPROVAL_DENIED` | the edit policy / user denied the Edits | error `ToolResult` (ERR-004) |
| `WRITE_FAILED` | approval and containment passed, but a disk write failed mid-apply (IO error) | error `ToolResult` (ERR-008) |

---

### IF-006 — `LlmClient` (DI seam — LOCKED)

**Type:** Internal DI-seam interface (the model/network boundary; ADR-001, ADR-004)
**Owner:** `llm-client`
**Consumers:** `agent-run`
**Realizes:** REQ-004, REQ-005, REQ-NFR-002 (injected for determinism), REQ-NFR-004 (retry/backoff)
**Required by slices:** `llm-client`, `agent-run`

#### Request / Input

```
send(conversation, toolSchemas):
  conversation: ConversationMessage[] [required] — ordered dialogue (system, user task, assistant
                turns with tool_use, tool_result turns); non-empty; read-only (never mutated by the seam)
  toolSchemas:  ToolSchema[]          [required] — exactly the FIVE tool JSON schemas (RULE-012);
                attached as the Messages API `tools` field
```

(`model` and `apiKey` are bound at construction from `Config`, not per call.)

#### Response / Output

```
{
  toolCalls:   ToolCall[] | null  — parsed tool_use blocks: { id: string, toolName: enum(5 tools), arguments: object };
                                    null when the model returned a final answer
  finalAnswer: string    | null   — text answer when stop_reason = end_turn with no tool_use; null otherwise
  stopReason:  enum("tool_use","end_turn","max_tokens","stop_sequence") — the SDK-reported stop reason
  usage:       { inputTokens: integer ≥ 0, outputTokens: integer ≥ 0, estimated: boolean } — token accounting
}
```

**Preconditions:** a valid `ANTHROPIC_API_KEY` and `modelId` were bound at construction (else
fail-fast at startup, RULE-016).
**Postconditions:** returns parsed model output + non-negative usage; performs at most 5 SDK calls
(1 + 4 retries). `arguments` are **untrusted** (validated downstream).
**Side effects:** one outbound HTTPS call to the Anthropic Messages API per attempt; emits
`llm-retry` TranscriptEntries on transient retries.

#### Error responses

| Code / type | Condition | Behavior |
|---|---|---|
| (retried internally) | transient: HTTP 429 / 500 / 502 / 503 / 529, network timeout, socket reset | retry ≤5, exp backoff base 1000ms cap 30000ms + full jitter, honor `Retry-After`; emit `llm-retry` |
| `LLM_FATAL` | HTTP 401/403 (bad/expired key), HTTP 400 (malformed request), any non-transient 4xx, or **retries exhausted** | **fatal** — throws; `agent-run` maps to `unrecoverable-error` StopCondition → Failed (ERR-013) |

> `estimated: true` in `usage` signals the SDK omitted a usage field and a character-based estimate
> was used (ODQ-005 / DQ-001).

---

### IF-007 — `CommandRunner` (DI seam — LOCKED)

**Type:** Internal DI-seam interface (the shell/process boundary; ADR-004)
**Owner:** `command-runner`
**Consumers:** `tool-runcommand`
**Realizes:** REQ-009, REQ-NFR-002 (injected for determinism), REQ-NFR-007 (cross-platform shell)
**Required by slices:** `command-runner`, `tool-runcommand`

#### Request / Input

```
run(command, cwd, timeoutMs):
  command:   string  [required] — the shell command line; min length 1 (already approved + cwd-validated upstream)
  cwd:       string  [required] — absolute working directory (already confirmed inside root by PathSandbox)
  timeoutMs: integer [required] — kill the process after this many ms; > 0
```

#### Response / Output

```
{
  exitCode:    integer  — process exit status (any integer; non-zero is valid, not an error)
  stdout:      string   — captured standard output
  stderr:      string   — captured standard error
  timedOut:    boolean  — true if the process was killed at timeoutMs
  spawnFailed?: boolean — SLICE-5 additive (ADR-002): true iff the process NEVER STARTED (spawn
                          failure — e.g. executable not found). The caller maps spawnFailed:true to
                          COMMAND_FAILED (ERR-010), distinct from a process that ran and exited
                          non-zero (a valid result). Optional/absent = ran normally.
}
```

**Preconditions:** `cwd` was already validated inside the root by `PathSandbox`; the command was
already approved by `ApprovalGate` (this seam performs **no** policy/confinement logic — it only
spawns).
**Postconditions:** the process ran to exit or was killed at timeout; all three streams captured.
**Side effects:** spawns a real OS process (production); a deterministic stub in tests (RULE-015).
Cross-platform shell selection (cmd vs. sh) is contained here.

#### Error responses

This seam **does not throw expected failures**: a spawn failure surfaces as a result the caller maps
to `COMMAND_FAILED`; a timeout surfaces as `timedOut: true` (caller maps to `COMMAND_TIMEOUT`). A
genuinely unexpected runtime fault propagates and is handled as fatal by `agent-run`.

---

### IF-008 — `ToolRegistry` (dispatch)

**Type:** Internal module contract
**Owner:** `tool-registry`
**Consumers:** `agent-run`
**Realizes:** REQ-005, REQ-NFR-004 (enforces RULE-012 + RULE-008)
**Required by slices:** `tool-registry`, `agent-run`

#### Request / Input

```
schemas():           — returns the exactly-FIVE ToolSchema objects to attach to LlmClient (RULE-012)
dispatch(toolCall):
  toolCall: ToolCall [required] — { id: string, toolName: enum(5 tools), arguments: object }
```

#### Response / Output

```
dispatch → ToolResult — { toolCallId: string, status: enum("ok","error"), output?: object, error?: { code: string, message: string } }
                         exactly one ToolResult per dispatch (INV-008)
```

**Preconditions:** none beyond a well-formed `toolCall`.
**Postconditions:** every dispatch yields exactly one normalized `ToolResult`. An unknown tool name
returns an error ToolResult (`UNKNOWN_TOOL`), not a throw.
**Side effects:** invokes the matching tool executor (which may write/exec via its own gates).

#### Error responses

| Code / type | Condition | Response payload |
|---|---|---|
| `UNKNOWN_TOOL` | `toolName` is not one of the five (RULE-012) | error `ToolResult` (ERR-005) |
| (re-raised) | the executor raises a **fatal** class (invariant breach, transcript write failure) | propagated to `agent-run` unrecoverable-error path — not swallowed |

---

### IF-009 — `ApprovalGate`

**Type:** Internal module contract (the model-intent → real-world trust boundary)
**Owner:** `approval-gate`
**Consumers:** `tool-writeedit`, `tool-applypatch`, `tool-runcommand`
**Realizes:** REQ-012, REQ-016, REQ-NFR-005 (enforces RULE-004 + RULE-005)
**Required by slices:** `approval-gate`

#### Request / Input

```
resolveEdit(edit, policy):
  edit:   Edit          [required] — { targetPath, before, after, diff } (Diff already generated, RULE-002)
  policy: ApprovalPolicy [required] — { editMode: enum("confirm-each","auto") }
resolveCommand(command, policy, allowlist):
  command:   string         [required] — the command line; min length 1
  policy:    ApprovalPolicy  [required] — { commandMode: enum("allowlist-confirm","auto") }
  allowlist: AllowlistEntry[] [required] — the configured auto-run set
```

#### Response / Output

```
resolveEdit    → Promise<ApprovalDecision>   (async: the confirm-each prompt is an async seam)
resolveCommand → Promise<ApprovalDecision>   (async since SLICE-5: a non-allowlisted command prompts via the same injectable async confirm seam)
ApprovalDecision: enum("auto-approved","approved-by-user","denied","user-abort")
```

> **SLICE-4 realization note (pinned):** `resolveEdit` is **async** (`Promise<ApprovalDecision>`)
> because the confirm-each prompt is an **injectable async seam** (`confirm: (prompt) =>
> Promise<"approve"|"deny"|"abort">`, default reads stdin) so the decision is deterministically
> testable without real stdin (REQ-NFR-002). `auto` editMode auto-approves WITHOUT prompting;
> `confirm-each` (the default) prompts. On `user-abort` the calling tool raises a non-fatal
> `UserAbortError` (code `USER_ABORT`) — distinct from `FatalToolError` — that the registry
> re-raises (rather than normalizing) so the run terminates as a CLEAN `user-abort` StopCondition
> (Stopped, NOT Failed); the full StopCondition classification is SLICE-7. A diff-less Edit reaching
> the gate is an INV-003 breach → fatal (`EDIT_WITHOUT_DIFF`).
>
> **SLICE-5 realization note (pinned):** `resolveCommand(command, policy, allowlist)` is now **async**
> (`Promise<ApprovalDecision>`) — a non-allowlisted command **prompts** via an **injectable async
> command-confirm seam** (`confirmCommand: (prompt) => Promise<"approve"|"deny"|"abort">`, default
> reads stdin) so the decision is deterministically testable without real stdin (REQ-NFR-002). `policy`
> is `{ commandMode: "allowlist-confirm" | "auto" }`; `allowlist` is the `allowlist` component's matcher
> (`isAllowed(command)` — token-sequence prefix, ADR-006). `auto` commandMode auto-approves WITHOUT
> prompting; `allowlist-confirm` (the default) auto-runs an allowlisted command and prompts everything
> else. **Chained/redirected commands** (`;`, `&&`, `||`, `|`, `>`, `<`, `` ` ``, `$(`, newline) are
> never auto-run (the matcher returns false → they fall through to the prompt; INV-010). On `user-abort`
> the calling tool raises the same non-fatal `UserAbortError` → clean Stopped.

**Preconditions:** for `resolveEdit`, a Diff exists (a diff-less Edit fails closed as a fatal
invariant breach — INV-003). The matcher tokenizes the command (argv) and treats each entry as a
**token-sequence prefix** (ADR-006).
**Postconditions:** `auto-approved` / `approved-by-user` permit the action; `denied` yields an error
ToolResult (`APPROVAL_DENIED`); `user-abort` raises a `user-abort` StopCondition (classified
Stopped). **Chained/redirected commands** (`;`, `&&`, `||`, `|`, `>`, `` ` ``, `$(`) are never
auto-run — they force confirmation (INV-010).
**Side effects:** may prompt the user on stdin; emits `approval-requested` / `approval-decided`
TranscriptEntries.

#### Error responses

| Code / type | Condition | Response payload |
|---|---|---|
| `APPROVAL_DENIED` | the policy/user denied the action | error `ToolResult` (ERR-004) — returned by the calling tool |

---

### IF-010 — `PathSandbox`

**Type:** Internal module contract (the filesystem/shell confinement boundary — data-integrity
blast-radius; ADR-005)
**Owner:** `path-sandbox`
**Consumers:** `tool-read`, `tool-writeedit`, `tool-applypatch`, `tool-runcommand`
**Realizes:** REQ-021, REQ-NFR-005, REQ-NFR-007 (enforces RULE-001 + RULE-003 write side)
**Required by slices:** `path-sandbox`

#### Request / Input

```
checkWrite(path):    path: string [required] — candidate write target; resolved against canonical root
checkExecCwd(cwd):   cwd:  string [required] — candidate command cwd
checkRead(path):     path: string [required] — candidate read target (always allowed — INV-002)
```

#### Response / Output

```
{
  allowed:       boolean — true if contained (write/exec) or unconditionally (read)
  canonicalPath: string  — the resolved, symlink-resolved absolute path (when allowed)
  reason?:       { code: "PATH_ESCAPE", message: string } — when rejected (write/exec only)
}
```

**Preconditions:** the canonical root was resolved (`realpath`) and validated as a directory at
startup.
**Postconditions:** write/exec: allowed iff the target's real path equals or descends the canonical
root (real path of deepest existing ancestor + non-existing tail; case-folded on Windows). Read:
always allowed (asymmetry is deliberate — INV-002, ADR-005). **Fail-closed** on any resolution
doubt.
**Side effects:** none — pure deterministic function of (canonical root, candidate path, filesystem
symlink state).

#### Error responses

| Code / type | Condition | Response payload |
|---|---|---|
| `PATH_ESCAPE` | write/exec target escapes the root (traversal / absolute-outside / symlink-escape / unresolvable) | rejection reason → caller emits error `ToolResult` (ERR-001) |

---

### IF-011 — `BudgetController` (accrual + guard + classify)

**Type:** Internal module contract
**Owner:** `budget-stop`
**Consumers:** `agent-run`
**Realizes:** REQ-014, REQ-015, REQ-020, REQ-NFR-003 (enforces RULE-006 + RULE-007 + RULE-011)
**Required by slices:** `budget-stop`, `agent-run`

#### Request / Input

```
accrue(usage):       usage: { inputTokens: integer ≥ 0, outputTokens: integer ≥ 0 } — added to tokensUsed; iterationsUsed++ per turn
checkGuard():        — returns the pre-turn budget verdict
classify(signal):    signal: { kind: enum("task-success","model-give-up","unrecoverable-error","user-abort"), testsPassed?: boolean } — terminal classification
```

#### Response / Output

```
checkGuard → { proceed: boolean, stopCondition?: enum("max-iterations-reached","budget-exhausted") }
              proceed=false ⇒ stopCondition set; AgentRun must NOT start the turn (RULE-006)
classify  → { status: enum("succeeded","stopped","failed"), stopCondition: enum(5 conditions), exitCode: integer }
              exitCode = 0 iff status="succeeded" (RULE-011, INV-006)
```

**Preconditions:** `Budget` ceilings (`maxIterations`, `tokenBudget`) resolved from Config.
**Postconditions:** accrual is monotonic; the guard runs **before** the model call (a near-budget
turn is prevented, not aborted mid-flight — INV-004); exactly one StopCondition fires (INV-005).
**Side effects:** emits `budget-exceeded` when a ceiling is hit.

#### Error responses

| Code / type | Condition | Response payload |
|---|---|---|
| (none — control flow) | ceiling reached | clean Terminating with the StopCondition (not an error type) |

---

### IF-012 — `TranscriptWriter`

**Type:** Internal module contract (durable append-only audit; ADR-002)
**Owner:** `transcript`
**Consumers:** `agent-run` and every event emitter
**Realizes:** REQ-022, REQ-NFR-008 (enforces RULE-010)
**Required by slices:** `transcript`

#### Request / Input

```
open(runId):   runId: string [required] — opens the per-run transcript file in append mode at run start
append(entry): entry: TranscriptEntry [required] — see IF-015; `seq` assigned monotonically by the writer
flush():       — final flush at Terminating
```

#### Response / Output

```
append → void (durable: write + fsync-class flush per entry before returning)
```

**Preconditions:** `open` succeeded.
**Postconditions:** each entry is durable on disk before `append` returns (crash loses at most the
in-flight entry — ADR-002); entries are append-only and strictly `seq`-ordered; never rewritten or
deleted (INV-009).
**Side effects:** writes one JSONL line per entry to the per-run transcript file.

#### Error responses

| Code / type | Condition | Behavior |
|---|---|---|
| `TRANSCRIPT_WRITE_FAILED` | a write/flush to the audit log fails | **fatal** — surfaced to `agent-run` → `unrecoverable-error` StopCondition → Failed (audit must not be silently lost, RULE-010) (ERR-014) |

---

### IF-013 — `DiffPatchEngine`

**Type:** Internal module contract
**Owner:** `diff-engine`
**Consumers:** `tool-writeedit`, `tool-applypatch`
**Realizes:** REQ-010, REQ-008, REQ-023 (enforces RULE-002 + supports RULE-013)
**Required by slices:** `diff-engine`

#### Request / Input

```
generateDiff(before, after, path):
  before: string | null [required] — current contents (null = new file)
  after:  string        [required] — new contents (empty = deletion)
  path:   string        [required] — file path for the diff header
parsePatch(patchText):  patchText: string [required] — unified-diff document; min length 1
applyHunks(file, hunks): — dry-run/apply per-file hunks against current contents (atomicity enforced by ApplyPatch)
```

#### Response / Output

```
generateDiff → string — unified diff text (file headers + @@ hunk markers), terminal-displayable
parsePatch   → { files: { path: string, hunks: Hunk[] }[] }  — typed per-file hunk sets
applyHunks   → { applicable: boolean, result?: string, failedHunkIndex?: integer } — per-hunk applicability
```

> **SLICE-4 realization note (pinned):** `generateDiff` emits a two-line file header
> (`--- a/<path>` / `+++ b/<path>`) followed by `@@ -aStart,aCount +bStart,bCount @@` hunks with
> ` ` (context) / `-` (removed) / `+` (added) line prefixes and 3 lines of context, always ending
> with a trailing newline. The degenerate Edits are explicit: `before === null` → new file (`---`
> side is `/dev/null`, `@@ -0,0 +1,N @@`); `after === ""` → deletion (`+++` side is `/dev/null`).
> It is PURE/deterministic (LCS line diff, fixed tie-break) so the same inputs are byte-identical.

> **SLICE-6 realization note (pinned):** the read side is realized PURE / IO-free.
> `parsePatch(patchText)` returns a DISCRIMINATED result rather than throwing, so the
> tool maps a malformed patch to a `status:"error"` ToolResult with NO try/catch
> (RULE-008): `{ ok: true, patch: { files: { path, hunks }[] } } | { ok: false, reason: string }`.
> A parsed `Hunk` is `{ aStart, aCount, bStart, bCount, lines: string[] }` (each `lines`
> element keeps its ` `/`-`/`+` prefix; a `\ No newline at end of file` marker is
> tolerated and dropped). The target path is the `+++ b/<path>` side (or, for a deletion,
> the `--- a/<path>` side). Malformed = no file headers, a `@@` before any header, a
> `+++` with no preceding `---`, a file with zero hunks, or a hunk whose body line
> counts disagree with its header. `applyHunks(file, hunks)` applies the hunks against
> the CURRENT contents using EXACT line-context matching at the stated 1-based anchor
> (no fuzzy offset in the MVP — AST/git-aware refinement is V1, out of scope); it returns
> `{ applicable: true, result }` (a FRESH string; inputs never mutated — the dry-run has
> zero internal/disk drift) or `{ applicable: false, failedHunkIndex }` for the first
> bad hunk. A new-file target uses `file === ""` with an all-`+` hunk anchored at 0.
> The TOOL (`apply_patch`) — not the engine — enforces all-or-none atomicity across
> files (RULE-013 / INV-007).

**Preconditions:** none (pure deterministic).
**Postconditions:** every Edit is representable as a Diff (RULE-002, INV-003); per-hunk
applicability is reported (the **tool** enforces all-or-none atomicity, RULE-013).
**Side effects:** none.

#### Error responses

| Code / type | Condition | Response payload |
|---|---|---|
| `PATCH_MALFORMED` | `parsePatch` cannot parse the text (bad headers / inconsistent counts) | surfaced by `apply_patch` (ERR-011) |

---

### IF-014 — CLI argument surface

**Type:** CLI invocation contract (the developer/CI boundary)
**Owner:** `cli`
**Consumers:** developer (terminal), CI scripts
**Realizes:** REQ-001, REQ-002, REQ-020, REQ-024, REQ-025, REQ-NFR-006
**Required by slices:** `cli`, `config`

#### Request / Input

```
autocoder [task] [flags]                    — primary run mode
autocoder allowlist <list|add|remove> [pattern]  — allowlist-management subcommand (no agent loop)

Positional:
  task         string [optional] — the natural-language Task (REQ-001); if omitted, read from --task / stdin / --task-file

Flags:
  --task <str>        string  [optional] — the Task as a flag (alternative to positional)
  --task-file <path>  string  [optional] — read the Task from a file
  --cwd / --root <p>  string  [optional, default: process cwd] — the WorkingRoot (REQ-002)
  --model <id>        string  [optional, default: current Claude model] — model id (REQ-018)
  --yes / --auto      boolean [optional, default: false] — auto-approve edits AND auto-run all commands (RULE-004/005)
  --max-iterations <n> integer [optional, default: 25] — iteration ceiling (REQ-015); > 0
  --token-budget <n>  integer [optional, default: ~1000000] — token ceiling (REQ-015); > 0
  --json              boolean [optional, default: false] — emit the RunSummary as machine-readable JSON (REQ-024)
  --config <path>     string  [optional] — config file path
  --help              boolean [optional] — usage text and exit 0 (REQ-NFR-006)
```

#### Response / Output

```
stdout: streamed human progress (REQ-017) + final RunSummary (human, or JSON when --json) (REQ-019/024)
exit code: 0 iff RunOutcome=succeeded; non-zero for stopped/failed (REQ-020, RULE-011, INV-006)
```

**Preconditions:** `ANTHROPIC_API_KEY` present in env (else fail-fast, RULE-016); WorkingRoot
resolves to an existing directory.
**Postconditions:** the process exits with the outcome-derived code; one Transcript and (run mode)
one RunSummary are produced.
**Side effects:** runs the agent loop (run mode) or mutates the config allowlist (allowlist mode).

#### Error responses

| Code / type | Condition | Response payload |
|---|---|---|
| `CONFIG_INVALID` | missing `ANTHROPIC_API_KEY` or invalid root — fail-fast in Initializing | actionable stderr message, non-zero exit (ERR-015) |
| (usage error) | unknown flag / missing required arg | usage hint to stderr, non-zero exit (REQ-NFR-006) |

---

## Data Schemas

> Field names derive from the `03-domain-model.md` vocabulary (Attributes tables). Sensitive fields
> are flagged. `ANTHROPIC_API_KEY` is the only secret; it is read from env, never serialized into
> the Transcript or RunSummary, never written outside the root.

### ToolResult

**Domain entity:** `ToolResult` (from `03-domain-model.md`)
**Realizes:** REQ-005, REQ-NFR-004
**Used by interfaces:** IF-001…IF-005, IF-008

```
toolCallId: string  [required] — correlates to the originating ToolCall.id
status:     enum("ok","error") [required] — error never crashes the loop (RULE-008)
output:     object  [optional] — tool-specific success payload (present iff status="ok")
error:      object  [optional] — { code: string (enum of error codes), message: string (actionable) }; present iff status="error"
```

**Validation rules:**
- Exactly one of `output` / `error` is present, determined by `status`.
- `error.code` is one of the named codes in **Error Contracts**.

### ToolCall

**Domain entity:** `ToolCall`
**Realizes:** REQ-005
**Used by interfaces:** IF-006, IF-008

```
id:        string [required] — model-assigned tool_use block id (untrusted but opaque)
toolName:  enum("read_file","list_search","write_edit","run_command","apply_patch") [required] — one of FIVE (RULE-012)
arguments: object [required] — per the named tool's input schema; UNTRUSTED — validated by the tool + PathSandbox
```

### TranscriptEntry (IF-015) — VERSIONED discriminated union

**Domain entity:** `TranscriptEntry` (from `03-domain-model.md`)
**Realizes:** REQ-022, REQ-NFR-008 (ADR-002)
**Used by interfaces:** IF-012

**Common envelope (every entry):**

```
schemaVersion: string  [required] — entry schema version for additive evolution (ADR-002), e.g. "1.0"
seq:           integer [required] — monotonic, strictly increasing within a run; assigned by the writer
ts:            string  [required] — ISO-8601 UTC timestamp (REQ-NFR-008)
runId:         string  [required] — the AgentRun.runId this entry belongs to
type:          enum (the 18 event types below) [required] — discriminant for `payload`
payload:       object  [required] — type-specific; sufficient to reconstruct the event (RULE-010)
```

**`type` discriminant (the 18 event types — one per domain event, mapped from §Domain Events):**

```
run-started          payload: { task: string, root: string, modelId: string }       — RunStarted
context-gathered     payload: { projectType: string|null, testCommand: string|null, fileCount: integer } — ContextGathered
iteration-started    payload: { index: integer }                                     — IterationStarted
tool-called          payload: { toolCallId: string, toolName: enum(5), arguments: object } — ToolCalled
approval-requested   payload: { toolCallId: string, kind: enum("edit","command"), target: string } — ApprovalRequested
approval-decided     payload: { toolCallId: string, decision: enum("auto-approved","approved-by-user","denied","user-abort") } — ApprovalDecided
edit-proposed        payload: { targetPath: string, diff: string }                   — EditProposed
edit-applied         payload: { targetPath: string }                                 — EditApplied
edit-rejected        payload: { targetPath: string, code: string, message: string }  — EditRejected
patch-rejected       payload: { code: enum("PATCH_MALFORMED","PATCH_NOT_APPLICABLE"), message: string } — PatchRejected
command-run          payload: { command: string, exitCode: integer, timedOut: boolean } — CommandRun
tests-run            payload: { command: string, passed: boolean, exitCode: integer } — TestsRun
tool-result          payload: { toolCallId: string, status: enum("ok","error"), errorCode: string|null } — ToolResultRecorded
budget-exceeded      payload: { kind: enum("max-iterations-reached","budget-exhausted"), iterationsUsed: integer, tokensUsed: integer } — BudgetExceeded
llm-retry            payload: { attempt: integer, errorClass: string, delayMs: integer } — LLMRetry
run-stopped          payload: { stopCondition: enum(5 conditions) }                   — RunStopped
run-completed        payload: { status: enum("succeeded","stopped","failed"), exitCode: integer } — RunCompleted
allowlist-changed    payload: { op: enum("add","remove"), pattern: string }           — AllowlistChanged
```

> **SLICE-9 realization note (pinned, REQ-025 / RULE-014):** the `allowlist-changed` row is a
> per-RUN audit entry keyed to a `runId`. The `autocoder allowlist <add|remove>` subcommand starts
> NO agent loop and opens NO transcript (Architecture §Secondary flow), so there is no run context to
> append this row to. In that no-loop mode the mutating op surfaces the change through the **Reporter**
> instead — carrying the SAME `{ op, pattern }` data this payload defines — per the secondary flow's
> "Reporter confirms" step. The `allowlist-changed` transcript row is therefore reserved for any
> in-RUN allowlist mutation (a future capability); the SLICE-9 subcommand path is Reporter-confirmed,
> not transcript-recorded. (DRIFT-018.)

**Validation rules:**
- `payload` shape is determined by `type` (discriminated union).
- `seq` is gap-free and strictly increasing per run; entries are append-only (INV-009).
- Additive evolution only: new `type` values or new optional `payload` fields may be added; existing
  fields are never removed or retyped without a `schemaVersion` bump (Versioning).

### RunSummary / `--json` (IF-016)

**Domain entity:** `RunSummary` / `RunOutcome` (from `03-domain-model.md`)
**Realizes:** REQ-019, REQ-024, REQ-020
**Used by interfaces:** IF-016

**`--json` object (the CI-stable contract — same data the human form renders):**

```
status:         enum("succeeded","stopped","failed") [required] — derived from stopCondition (REQ-014)
stopCondition:  enum("task-success","max-iterations-reached","budget-exhausted","model-give-up","unrecoverable-error","user-abort") [required]
exitCode:       integer [required] — 0 iff status="succeeded" (REQ-020, RULE-011)
filesChanged:   array   [required] — [{ targetPath: string, diff: string }]; may be empty (REQ-019)
testsResult:    object  [required] — { ran: boolean, passed: integer, failed: integer }; ran=false ⇒ no test command (ODQ-004)
iterationsUsed: integer [required] — turns consumed (REQ-019)
tokensUsed:     integer [required] — input+output tokens accrued; may carry `estimated: boolean` (ODQ-005)
runId:          string  [required] — correlates to the Transcript
schemaVersion:  string  [required] — `--json` schema version for additive CI-safe evolution
```

**Validation rules:**
- `exitCode == 0` if and only if `status == "succeeded"` (INV-006).
- `status` is derivable from `stopCondition` (`task-success`→succeeded; `max-iterations-reached` /
  `budget-exhausted` / `model-give-up` / `user-abort`→stopped; `unrecoverable-error`→failed).
- **Stability promise (default, no human gate needed):** the `--json` object is **append-only
  stable** for CI consumers — fields are never removed or retyped within a `schemaVersion`; new
  optional fields may be added. CI may rely on `status`, `exitCode`, `stopCondition` permanently.

> **SLICE-8 realization note (pinned, REQ-018 redaction):** the `reporter` renders this object from
> a SINGLE classified `RunOutcome` (status/exitCode/stopCondition REUSED from the SLICE-7 `budget-stop`
> classification — never recomputed): the human form (REQ-019) and the `--json` form (REQ-024) are the
> same data rendered twice. The reporter writes EVERY stdout byte (human stream + summary + `--json`)
> through a redaction seam that replaces any occurrence of the configured secret (`ANTHROPIC_API_KEY`)
> with `[REDACTED]` — so the key can appear in NEITHER the human stream, the `--json` object, NOR (via
> TASK-016 emitters that never serialize it) the Transcript. The optional `estimated:boolean` token
> flag (ODQ-005) is carried as a top-level field alongside `tokensUsed`.

### Config (IF-017)

**Domain entity:** `Config` (from `03-domain-model.md`)
**Realizes:** REQ-018, REQ-002, REQ-015, REQ-016, REQ-025
**Used by interfaces:** IF-017

**Precedence (highest wins): flags > environment > config file > built-in defaults.**

```
apiKey:       string  [required] — from env ANTHROPIC_API_KEY; fail-fast if missing (RULE-016) [SENSITIVE — never serialized]
modelId:      string  [optional, default: current Claude model] — Anthropic model id
root:         string  [required, default: process cwd] — resolved WorkingRoot; must be an existing directory (REQ-002)
editMode:     enum("confirm-each","auto") [optional, default: "confirm-each"] — edit ApprovalPolicy (REQ-012)
commandMode:  enum("allowlist-confirm","auto") [optional, default: "allowlist-confirm"] — command ApprovalPolicy (REQ-016)
maxIterations: integer [optional, default: 25] — iteration ceiling; > 0 (REQ-015)
tokenBudget:  integer [optional, default: ~1000000] — token ceiling (input+output per run); > 0 (REQ-015)
allowlist:    AllowlistEntry[] [optional, default: detected test/build cmd + safe read-only cmds] — auto-run set (REQ-016, REQ-025)
```

**AllowlistEntry:**

```
pattern: string [required] — a command token-sequence prefix that auto-runs (e.g. "npm test", "git status"); min length 1
```

**Validation rules:**
- `apiKey` present and `root` an existing directory are the fail-fast preconditions (RULE-016); both
  validated before AgentRun is constructed.
- `--yes`/`--auto` sets both `editMode` and `commandMode` to `"auto"`.
- Allowlist add/remove is idempotent on set membership and persists to the config file (RULE-014).

> **SLICE-9 realization note (pinned, REQ-025 / RULE-014):** the `allowlist <list|add|remove>`
> subcommand resolves its config-file TARGET as `--config <path>` when supplied, else a default
> `.autocoder.json` in the working directory (the resolved path is absolute). `list` inspects without
> mutating; `add`/`remove` mutate set membership and re-persist the WHOLE config object (every
> unrelated field preserved) as pretty-printed JSON. A persistence write FAILURE raises
> `ALLOWLIST_PERSIST_FAILED` (FAIL-004) → stderr + non-zero exit; the confirmation ("saved") is
> emitted ONLY after the write succeeds, so a failed persist can never print a false success. Set
> management + write-back live in `config.ts`; the `allowlist.ts` MATCHER (SLICE-5) is untouched.

---

## Events

**No cross-boundary message-bus events in this system.** Autocoder is a single-process CLI with no
broker, no queue, no pub/sub (Architecture → Deployment Shape). The domain events enumerated in
`03-domain-model.md` (RunStarted, IterationStarted, ToolCalled, … RunCompleted) are **not published
across a transport** — they are recorded as **`TranscriptEntry` rows** (see Data Schemas → IF-015)
and streamed to stdout by the Reporter. The event contract is therefore the `TranscriptEntry`
discriminated-union schema and its 18 `type` values, which map one-to-one onto the domain events.
There are no delivery-semantics or ordering guarantees to specify beyond the Transcript's invariant:
**append-only, strictly `seq`-ordered, durable per entry** (INV-009, RULE-010).

---

## Error Contracts

> Two channels (ADR-007 / RULE-008): **(A) expected failures → `status:"error"` ToolResult** fed
> back to the model so it can self-correct — these never throw past `tool-registry`. **(B) fatal
> failures → `unrecoverable-error` StopCondition** (or fail-fast at startup) ending the run into
> Failed. The standard error envelope is `{ code, message }` (and, in ToolResult form, inside
> `ToolResult.error`).

| Error ID | Code | Channel | Condition | Consumer action | Interfaces | REQ-IDs |
|---|---|---|---|---|---|---|
| ERR-001 | `PATH_ESCAPE` | A (tool-result) | write/exec target escapes the root (traversal / absolute-outside / symlink) — fail-closed | model receives error result; retries with an in-root path | IF-002, IF-003, IF-004, IF-005, IF-010 | REQ-021 |
| ERR-002 | `SEARCH_NOT_FOUND` | A | `write_edit` replace: `search` occurs 0 times — no Edit | model re-reads file, corrects search | IF-003 | REQ-008 |
| ERR-003 | `SEARCH_AMBIGUOUS` | A | `write_edit` replace: `search` occurs >1 time, `replaceAll` false — no Edit | model narrows search or sets replaceAll | IF-003 | REQ-008 |
| ERR-004 | `APPROVAL_DENIED` | A | edit/command policy or user denied the action | model proposes a different action; loop continues | IF-003, IF-004, IF-005, IF-009 | REQ-012, REQ-016 |
| ERR-005 | `UNKNOWN_TOOL` | A | model named a tool outside the five (RULE-012) | model uses one of the five tools | IF-008 | REQ-005 |
| ERR-006 | `READ_FAILED` | A | file not found / is-a-directory / permission denied | model corrects path or skips | IF-001 | REQ-006 |
| ERR-007 | `BAD_PATTERN` | A | invalid regex in `list_search` (isRegex=true) | model fixes the regex | IF-002 | REQ-007 |
| ERR-008 | `WRITE_FAILED` | A | approval + containment passed but disk write failed (IO error) | model retries or reports | IF-003, IF-005 | REQ-011 |
| ERR-009 | `COMMAND_TIMEOUT` | A | command exceeded `timeoutMs` and was killed | model splits work or raises timeout | IF-004 | REQ-009 |
| ERR-010 | `COMMAND_FAILED` | A | process failed to spawn (executable not found) — distinct from non-zero exit | model corrects the command | IF-004 | REQ-009 |
| ERR-011 | `PATCH_MALFORMED` | A | `apply_patch` text unparseable (bad headers / line counts) | model re-emits a well-formed patch | IF-005, IF-013 | REQ-023 |
| ERR-012 | `PATCH_NOT_APPLICABLE` | A | patch parses but ≥1 hunk fails — whole patch rejected, zero Edits (RULE-013) | model re-reads file, rebuilds the patch | IF-005 | REQ-023 |
| ERR-013 | `LLM_FATAL` | **B (fatal)** | HTTP 401/403/400, non-transient 4xx, or LlmClient retries exhausted | run ends → `unrecoverable-error` → Failed (non-zero exit) | IF-006 | REQ-NFR-004 |
| ERR-014 | `TRANSCRIPT_WRITE_FAILED` | **B (fatal)** | audit log write/flush failed | run ends → `unrecoverable-error` → Failed (audit must not be lost, RULE-010) | IF-012 | REQ-022, REQ-NFR-008 |
| ERR-015 | `CONFIG_INVALID` | **B (fail-fast)** | missing `ANTHROPIC_API_KEY` or invalid root | fail-fast in Initializing → Failed before any iteration (RULE-016) | IF-014, IF-017 | REQ-018, REQ-NFR-006 |

**Error envelope (standard shape):**

```
code:    string [required] — machine-readable error code (one of the codes above, e.g. "PATH_ESCAPE")
message: string [required] — human-readable, actionable description
detail:  object [optional] — structured context (e.g. { matchCount: 3 } for SEARCH_AMBIGUOUS, { failedHunkIndex: 2 } for PATCH_NOT_APPLICABLE)
```

> **Non-error note:** a **non-zero command exit** is NOT in this catalog — it is a `status:"ok"`
> ToolResult carrying `exitCode` (ADR-007). A failing test run is a result the agent reasons about,
> not an error.

---

## Versioning

- **Strategy:**
  - **`TranscriptEntry`** (IF-015): a `schemaVersion` string field on every entry. **Additive
    evolution only** (ADR-002 mitigation) — this is the data-integrity contract for the audit trail
    and the substrate the V1 *resumable continuation* feature will read back.
  - **`RunSummary` `--json`** (IF-016): a `schemaVersion` string field; **CI-stable** under the same
    additive rule. `status`, `exitCode`, and `stopCondition` are a permanent stable subset CI may
    depend on.
  - **Tool schemas** (IF-001…IF-005): internal, model-facing; versioned implicitly with the package.
    No external compatibility promise — the model is given the current schemas each run.
  - **DI seams** (IF-006/IF-007) and internal module contracts (IF-008…IF-013): in-process
    interfaces versioned with the package; not externally consumed.
- **Backward-compatibility rule:** within a `schemaVersion`, fields are **never removed or
  retyped**; only new optional fields and new `type`/enum values may be added (consumers must ignore
  unknown fields and unknown `type` values gracefully).
- **Breaking-change process:** any field removal/retyping or semantic change requires a
  `schemaVersion` bump (e.g. "1.0" → "2.0"); consumers branch on `schemaVersion`. Old transcripts
  remain readable under their recorded version.
- **Current version:** `schemaVersion = "1.0"` for both `TranscriptEntry` and the `--json`
  RunSummary.
- **Human-approved versioning decisions:** none required — there is no external API and no auth, so
  no versioning choice rose to a human gate. The additive/CI-stable defaults above are adopted as
  the sane default (product-affecting choice flagged per §8; noted, not gated).

---

## Consumer / Producer Map

| Interface / Schema | Producer | Consumer(s) | REQ-IDs | Slice (label) | Notes |
|---|---|---|---|---|---|
| IF-001 `read_file` | `tool-read` | model (via `llm-client`), `tool-registry` | REQ-006, REQ-021 | `tool-read` | only effector allowed outside the root (RULE-003) |
| IF-002 `list_search` | `tool-search` | model, `tool-registry` | REQ-007 | `tool-search` | root-scoped; empty result = success |
| IF-003 `write_edit` | `tool-writeedit` | model, `tool-registry` | REQ-008/010/011/021 | `tool-writeedit` | flows Diff→PathSandbox→ApprovalGate before write |
| IF-004 `run_command` | `tool-runcommand` | model, `tool-registry` | REQ-009/013/016/021 | `tool-runcommand` | non-zero exit is a result, not an error |
| IF-005 `apply_patch` | `tool-applypatch` | model, `tool-registry` | REQ-023/010/011/012/021 | `tool-applypatch` | atomic — all hunks or zero Edits (RULE-013) |
| IF-006 `LlmClient` | `llm-client` | `agent-run` | REQ-004/005/NFR-002/NFR-004 | `llm-client` | serializes the five tool schemas; fatal errors end the run |
| IF-007 `CommandRunner` | `command-runner` | `tool-runcommand` | REQ-009/NFR-002/NFR-007 | `command-runner` | spawns only; no policy/confinement logic here |
| IF-008 `ToolRegistry` | `tool-registry` | `agent-run` | REQ-005/NFR-004 | `tool-registry` | five-tool surface; normalizes results; re-raises fatal class |
| IF-009 `ApprovalGate` | `approval-gate` | `tool-writeedit`, `tool-applypatch`, `tool-runcommand` | REQ-012/016/NFR-005 | `approval-gate` | token-prefix allowlist; chained cmds never auto-run |
| IF-010 `PathSandbox` | `path-sandbox` | `tool-read`, `tool-writeedit`, `tool-applypatch`, `tool-runcommand` | REQ-021/NFR-005/NFR-007 | `path-sandbox` | write/exec confined; reads never confined (INV-002) |
| IF-011 `BudgetController` | `budget-stop` | `agent-run` | REQ-014/015/020/NFR-003 | `budget-stop` | pre-turn guard; single StopCondition; exit 0 iff Succeeded |
| IF-012 `TranscriptWriter` | `transcript` | `agent-run` + all emitters | REQ-022/NFR-008 | `transcript` | append-only JSONL, flush per entry; write failure is fatal |
| IF-013 `DiffPatchEngine` | `diff-engine` | `tool-writeedit`, `tool-applypatch` | REQ-010/008/023 | `diff-engine` | generates Diffs; reports per-hunk applicability |
| IF-014 CLI surface | `cli` | developer, CI | REQ-001/002/020/024/025/NFR-006 | `cli` | exit code = outcome; `--json` for CI |
| IF-015 `TranscriptEntry` | `transcript` | transcript readers, V1 resume | REQ-022/NFR-008 | `transcript` | versioned discriminated union; 18 event types |
| IF-016 `RunSummary`/`--json` | `reporter` | developer, CI consumers | REQ-019/024/020 | `reporter` | CI-stable; status/exitCode/stopCondition permanent |
| IF-017 `Config` | `config` | `agent-run`, `approval-gate`, `budget-stop`, `allowlist` | REQ-018/002/015/016/025 | `config` | precedence flags>env>file>defaults; apiKey never serialized |

**Orphaned-interface check:** every interface in the index has ≥1 producer and ≥1 consumer above —
no orphans. The model is a consumer of IF-001…IF-005 (via the `llm-client` seam) and a producer of
`ToolCall`s consumed by `tool-registry`; CI is a consumer of IF-014/IF-016. No interface is produced
but unconsumed, and no consumer depends on an undefined interface.

**Domain-model cross-check (required attributes present):** AgentRun.{runId, task, state,
iterationsUsed, tokensUsed} → RunSummary + TranscriptEntry envelope; ToolResult.{status, output,
error} → ToolResult schema; WorkingRoot.absolutePath → Config.root + PathSandbox canonical root;
Edit.{targetPath, before, after, diff, applied} → IF-003/IF-005 output; CommandExecution.{command,
cwd, exitCode, stdout, stderr, isTestRun} → IF-004 output; Budget.{maxIterations, tokenBudget} →
Config; RunOutcome.{status, stopCondition, filesChanged, testsResult, iterationsUsed, tokensUsed,
exitCode} → `--json` RunSummary; TranscriptEntry.{type, timestamp, payload} → IF-015 envelope
(extended with `schemaVersion`, `seq`, `runId` per ADR-002). **No divergence:** field names follow
the domain vocabulary (the only normalizations are the tool *names* given snake_case identifiers for
the model-facing JSON Schema — `read_file`/`list_search`/`write_edit`/`run_command`/`apply_patch` —
which map 1:1 to the domain Tools ReadFileTool/ListSearchTool/WriteEditTool/RunCommandTool/
ApplyPatchTool; flagged here so tests use the snake_case wire names).
