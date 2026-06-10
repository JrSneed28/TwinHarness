# Failure Modes & Edge-Case Design — Autocoder

> **Stage F — Failure Modes & Edge-Case Design** (spec §15.F). Tier 3 / reliability-critical,
> data-integrity blast-radius. GRADUATES from the folded Architecture §Failure-Modes section
> because Autocoder mutates files and executes shell commands on the developer's tree. Streams;
> escalates to a human gate only where a failure-handling choice is product- or risk-meaningful
> (data-loss tradeoffs, blast-radius decisions — §8). Reads the Summary blocks of
> `04-architecture.md`, `06-technical-design.md`, and `07-contracts.md`; fetches full sections
> only where a component's behavior needs the detail (§9). Every entry below is anchored to a
> canonical component label from `04-architecture.md` and, where applicable, to the contract
> error code from `07-contracts.md` (ERR-001…ERR-015).

## Summary

Autocoder's failure surface is dominated by two trust boundaries — the **LLM/network boundary**
(`llm-client` ⇄ Anthropic API, untrusted model output) and the **filesystem/shell boundary**
(`path-sandbox` / `approval-gate` ⇄ disk + `command-runner`, untrusted write/exec intent). The
overall posture is **two-channel by design (ADR-007/RULE-008)**: data-integrity controls
(`path-sandbox`, `config`, `transcript`) **fail closed**, while expected tool failures **fail
soft** into error `ToolResult`s that are fed back to the model so it can self-correct — they never
crash the loop. Only a fixed fatal class (LLM retries exhausted, transcript write failure, config
fail-fast, internal-invariant breach) ends the run cleanly as `unrecoverable-error → Failed`. The
highest-risk modes are all data-integrity ones: **path-escape on write/exec** (defeated before the
op by `path-sandbox`), **partial patch application** (defeated by `tool-applypatch`'s all-or-none
RULE-013), **crash mid-write** (bounded by the JSONL flush-per-entry transcript), and
**concurrent working-tree mutation by a second process or the user's editor** (the one residual
data-loss exposure — last-write-wins on disk, no run lock in the MVP; see §Race Conditions and the
Orchestrator note). Recovery in the MVP is "a readable transcript up to the crash" — there is **no
resume** (that is V1, ADR-002) and **no auto-rollback** of already-applied working-tree edits.

- **Highest-risk component:** `path-sandbox` (write/exec confinement — the data-integrity boundary),
  closely followed by `tool-applypatch` (atomic multi-file writes) and `transcript` (durable audit).
- **Default failure posture:** **fail-closed** for the data-integrity controls (`path-sandbox`,
  `config`, `transcript`); **fail-soft to error `ToolResult`** for expected tool failures (ADR-007);
  **fatal → `unrecoverable-error` → Failed** for the fixed fatal class only.
- **Idempotency scope:** single-process MVP — no idempotency keys needed; writes are
  content-idempotent (same content → same file), allowlist add/remove is set-idempotent, command
  re-execution is **not** guaranteed idempotent (a caller concern). No cross-run resume.
- **Negative-test count:** **42 negative tests** anchored in §Negative-Tests Map (none "manual only").

---

## Failure Catalog (per component/flow)

> **Anti-boilerplate rule applied:** every row names a component label from `04-architecture.md`
> or a named boundary, and where a behavior maps to a contract error code it cites it
> (ERR-001…ERR-015). Rows that could only have said "validate inputs" / "handle errors" are not
> present. Each row anchors to a negative test in §Negative-Tests Map.

### `cli` / `config` (entry + configuration)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-001 | `ANTHROPIC_API_KEY` missing from env at startup | **fail-fast** in Initializing → Failed, actionable stderr, non-zero exit; no iteration starts (RULE-016, ERR-015 `CONFIG_INVALID`) | `test_REQ018_missing_apikey_failfast` |
| FAIL-002 | `--cwd`/`--root` points at a non-existent or non-directory path | **fail-fast** in Initializing → Failed before any loop (RULE-016, ERR-015) | `test_REQ002_invalid_root_failfast` |
| FAIL-003 | unknown flag / missing required arg on the CLI surface | usage hint to stderr, non-zero exit (REQ-NFR-006) — no agent loop | `test_REQ001_unknown_flag_usage_error` |
| FAIL-004 | config-file allowlist persistence write fails (disk full / permission) on `allowlist add\|remove` | report the persistence failure to stderr, non-zero exit; in-memory state not silently treated as saved (RULE-014) | `test_REQ025_allowlist_persist_failure` |

### `llm-client` (LLM/network boundary — DI seam)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-005 | transient API error (HTTP 429 / 500 / 502 / 503 / 529, timeout, socket reset) | **retry ≤5** (1 + 4), exp backoff base 1000ms cap 30000ms + full jitter, honor `Retry-After`; emit `llm-retry`; not surfaced to the loop unless exhausted (REQ-NFR-004) | `test_REQNFR004_transient_retry_backoff` |
| FAIL-006 | retries exhausted after 5 transient attempts | **fatal** → `unrecoverable-error` StopCondition → Failed, non-zero exit (ERR-013 `LLM_FATAL`) | `test_REQNFR004_retries_exhausted_fatal` |
| FAIL-007 | non-transient HTTP 401/403 (bad/expired key) or 400 (malformed request) | **fatal, not retried** → `unrecoverable-error` → Failed (ERR-013) | `test_REQNFR004_fatal_4xx_no_retry` |
| FAIL-008 | SDK omits the `usage` field on a response | fall back to a character-based estimate, mark `usage.estimated:true`; Budget still accrues (ODQ-005/DQ-001) — does not crash | `test_REQ015_usage_estimate_fallback` |

### `agent-run` (loop controller)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-009 | model never emits a final answer (keeps calling tools) | bounded by the **pre-turn budget guard** → `max-iterations-reached` / `budget-exhausted` → Stopped (RULE-006/007, INV-005); never unbounded | `test_REQ014_no_final_answer_budget_stop` |
| FAIL-010 | a fatal-class error raised mid-iteration (e.g. transcript write failure surfaced by a tool) | classify as `unrecoverable-error` → Failed; do not swallow as a ToolResult (ADR-007 boundary owned by `agent-run`) | `test_REQNFR004_fatal_class_terminates` |
| FAIL-011 | every tool call in a turn is denied by the user | loop **continues** with error `ToolResult`s (APPROVAL_DENIED) fed back; not a crash, not a terminal state (ADR-007) | `test_REQ012_all_denied_loop_continues` |

### `tool-registry` (dispatch)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-012 | model requests a tool name outside the fixed five | error `ToolResult` `UNKNOWN_TOOL` (ERR-005, RULE-012) fed back; never throws | `test_REQ005_unknown_tool_rejected` |
| FAIL-013 | a tool executor throws an *expected* failure class | caught and normalized to an error `ToolResult` (RULE-008, INV-008); only fatal class re-raised | `test_REQNFR004_expected_error_normalized` |

### `path-sandbox` (write/exec confinement — data-integrity boundary) ⚠

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-014 | write target with `..` traversal escaping the root | **fail-closed** — reject before the op, error `ToolResult` `PATH_ESCAPE` (ERR-001, RULE-001, INV-001) | `test_REQ021_write_traversal_rejected` |
| FAIL-015 | write target as an absolute path landing outside the root | **fail-closed** — `PATH_ESCAPE` before the op (ERR-001) | `test_REQ021_write_absolute_outside_rejected` |
| FAIL-016 | write target whose parent is a symlink pointing outside the root | **fail-closed** — realpath of deepest existing ancestor lands outside → `PATH_ESCAPE` (ERR-001) | `test_REQ021_write_symlink_escape_rejected` |
| FAIL-017 | exec `cwd` resolving outside the root | **fail-closed** — `checkExecCwd` rejects, `PATH_ESCAPE` (ERR-001, RULE-001) | `test_REQ021_exec_cwd_escape_rejected` |
| FAIL-018 | unresolvable / malformed path on a write check | **fail-closed** — any resolution doubt rejects (ERR-001) | `test_REQ021_unresolvable_path_rejected` |

### `tool-writeedit`

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-019 | replace-mode `search` occurs zero times | error `ToolResult` `SEARCH_NOT_FOUND`, **no Edit produced** (ERR-002, ODQ-002) | `test_REQ008_search_not_found` |
| FAIL-020 | replace-mode `search` occurs >1 time with `replaceAll:false` | error `ToolResult` `SEARCH_AMBIGUOUS` (count reported), **no Edit** (ERR-003, ODQ-002) — prevents wrong-occurrence mutation | `test_REQ008_search_ambiguous` |
| FAIL-021 | approval + containment pass but the disk write fails (IO error) | error `ToolResult` `WRITE_FAILED`; Edit → `Rejected`, not `Applied` (ERR-008, Edit state machine) | `test_REQ011_write_io_failure` |

### `tool-applypatch` (atomic multi-file writes) ⚠

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-022 | patch text unparseable (bad headers / inconsistent line counts) | error `ToolResult` `PATCH_MALFORMED`, **zero Edits** (ERR-011, RULE-013) | `test_REQ023_patch_malformed` |
| FAIL-023 | patch parses but ≥1 hunk fails to apply (context mismatch) | **atomic reject** — `PATCH_NOT_APPLICABLE`, **zero Edits, nothing written** (ERR-012, RULE-013, INV-007) | `test_REQ023_patch_one_hunk_fails_atomic` |
| FAIL-024 | any one of several patch targets resolves outside the root | **fail-closed** — `PATH_ESCAPE`, **whole patch rejected, zero Edits** (ERR-001 + RULE-013) | `test_REQ023_patch_target_escape_rejected` |

### `tool-runcommand` ⇄ `command-runner` (shell boundary)

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-025 | command exits non-zero (e.g. failing test run) | **success** `ToolResult` carrying `exitCode != 0` — a *result*, not an error (ADR-007); `isTestRun` surfaced to Budget/Stop (RULE-009) | `test_REQ013_nonzero_exit_is_result` |
| FAIL-026 | command hangs / exceeds `timeoutMs` (default 120s) | process killed at timeout → error `ToolResult` `COMMAND_TIMEOUT`, `timedOut:true` (ERR-009, ODQ-003) | `test_REQ009_command_timeout` |
| FAIL-027 | process fails to spawn (executable not found) | error `ToolResult` `COMMAND_FAILED` — distinct from a non-zero exit (ERR-010) | `test_REQ009_command_spawn_failure` |
| FAIL-028 | non-allowlisted command in default `allowlist-confirm` mode | **prompt the user** (not auto-run); deny → `APPROVAL_DENIED` (ERR-004, RULE-005, INV-010) | `test_REQ016_nonallowlisted_prompts` |

### `approval-gate`

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-029 | allowlisted prefix smuggles a second command via `;` `&&` `\|` `>` `` ` `` `$(` | chained/redirected command **disqualified from auto-run** → forced to confirm (ADR-006 over-broad-match abuse case, INV-010) | `test_REQ016_chained_command_not_autorun` |
| FAIL-030 | user aborts the run at an approval prompt | `user-abort` StopCondition → classified **Stopped**, clean Terminating (not Failed) | `test_REQ012_user_abort_stops_clean` |

### `budget-stop`

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-031 | `iterationsUsed >= maxIterations` at the pre-turn guard | `max-iterations-reached` → Stopped; **turn not started** (RULE-006, INV-004) — no half-iteration | `test_REQ015_max_iterations_guard` |
| FAIL-032 | `tokensUsed >= tokenBudget` at the pre-turn guard | `budget-exhausted` → Stopped; turn not started (RULE-006, INV-004) | `test_REQ015_token_budget_guard` |

### `transcript` (durable audit) ⚠

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-033 | append/flush of an entry to the JSONL audit log fails | **fatal** → `unrecoverable-error` → Failed; audit is a data-integrity contract and is **not** silently dropped (ERR-014, RULE-010, INV-009) | `test_REQ022_transcript_write_fatal` |
| FAIL-034 | process crashes mid-write of an entry | each prior entry already durable (flush-per-entry); at most the **in-flight entry** is lost; a trailing partial line is tolerated on read (ADR-002) | `test_REQ022_crash_partial_last_line_tolerated` |

---

## Invalid Input

> All model-emitted tool arguments are **untrusted input** crossing the LLM boundary. Each row is
> the named tool/component that validates the class and the exact contract error it returns — not a
> generic "validate inputs."

| Component | Invalid input class | Expected behavior | Negative test anchor |
|-----------|--------------------|--------------------|---------------------|
| `tool-read` | path not found / is-a-directory / permission denied | error `ToolResult` `READ_FAILED` (ERR-006); never a crash, read-anywhere still applies | `test_REQ006_read_failed` |
| `tool-search` | `isRegex:true` with an invalid regex `query` | error `ToolResult` `BAD_PATTERN` (ERR-007) | `test_REQ007_bad_regex_pattern` |
| `tool-search` | `path` resolving outside the root (list/search are root-scoped) | error `ToolResult` `PATH_ESCAPE` (ERR-001) | `test_REQ007_search_path_escape` |
| `tool-writeedit` | `targetPath` escaping the root (traversal/absolute/symlink) | `PATH_ESCAPE` fail-closed (ERR-001) | `test_REQ021_writeedit_path_escape` |
| `tool-writeedit` | replace-mode with absent `search` | `SEARCH_NOT_FOUND`, no Edit (ERR-002) | `test_REQ008_replace_absent_search` |
| `tool-applypatch` | malformed unified-diff text | `PATCH_MALFORMED`, zero Edits (ERR-011) | `test_REQ023_applypatch_malformed_input` |
| `tool-runcommand` | `cwd` outside the root | `PATH_ESCAPE` fail-closed (ERR-001) | `test_REQ021_runcommand_cwd_escape` |
| `tool-registry` | `toolName` outside the five-tool set | `UNKNOWN_TOOL` (ERR-005, RULE-012) | `test_REQ005_invalid_tool_name` |
| `llm-client` / `agent-run` | `tool_use` block with malformed/missing required arguments for a known tool | the owning tool rejects with its typed error (e.g. missing `targetPath` → the tool's validation error `ToolResult`); never crashes the loop — arguments are untrusted and tool-validated downstream | `test_REQ005_malformed_tool_arguments` |
| `cli` / `config` | missing `ANTHROPIC_API_KEY` / invalid root | fail-fast `CONFIG_INVALID`, non-zero exit (ERR-015) | `test_REQ018_invalid_config_input` |

---

## Duplicates/Idempotency

> **MVP is a single process with no cross-run resume (ADR-002).** No idempotency key is needed
> because the model does not replay identical ToolCalls by accident within one process and there is
> no at-least-once delivery channel. The rows below state, per operation, where idempotency holds
> naturally and where it does **not** (a caller concern the model owns).

| Operation | Component | Idempotent? | Enforcement mechanism | Negative test anchor |
|-----------|-----------|------------|----------------------|---------------------|
| `write_edit` re-write of identical content | `tool-writeedit` | Yes (content-level) | writing the same `after` contents yields the same file; each call still produces its own Diff + approval (no dedup needed) | `test_REQ011_rewrite_identical_content_idempotent` |
| `apply_patch` re-application of an already-applied patch | `tool-applypatch` | No (and self-guarded) | on re-apply, context no longer matches → `PATCH_NOT_APPLICABLE`, zero Edits (ERR-012) — re-application is safely **rejected**, not double-applied | `test_REQ023_reapply_patch_rejected` |
| `run_command` re-execution of the same command | `tool-runcommand` | No (caller concern) | the harness does **not** dedup commands; a non-idempotent command (e.g. `rm`, `git commit`) run twice runs twice — confined to root + approval-gated, but effects are the model's responsibility | `test_REQ009_command_not_deduplicated` |
| allowlist `add` / `remove` | `allowlist` / `config` | Yes (set-level) | adding an existing entry is a no-op; removing an absent entry is a no-op (RULE-014) | `test_REQ025_allowlist_ops_idempotent` |

---

## Partial Failure

> The system has **no distributed transaction** — it is one process writing local files. The two
> multi-step write operations are `apply_patch` (multi-hunk / multi-file) and any sequence of
> separate tool calls within a run. Atomicity is guaranteed **within a single `apply_patch`** by
> RULE-013; it is **not** guaranteed *across* separate tool calls (each is its own committed step,
> by design).

| Operation | Failure point | Recovery strategy | Invariants preserved | Negative test anchor |
|-----------|--------------|-------------------|---------------------|---------------------|
| `apply_patch` multi-hunk single file | hunk 3 of 5 fails the dry-run | **all-or-none** — whole patch rejected at dry-run, **zero Edits**, nothing written; `PATCH_NOT_APPLICABLE` fed back (RULE-013, INV-007) | no partial write; working tree unchanged | `test_REQ023_multihunk_partial_atomic` |
| `apply_patch` multi-file | file 1 dry-runs clean, file 2 hunk fails dry-run | reject the **whole** patch before persisting any file (persistence is the last step, after all files dry-run) — zero Edits (RULE-013) | working tree unchanged; no file-1-written-file-2-skipped state | `test_REQ023_multifile_partial_atomic` |
| `apply_patch` multi-file | all files dry-run clean, then file 2 disk write fails mid-persist (IO error) | `WRITE_FAILED` (ERR-008); file 1 **may already be written** — this residual is the one place atomicity is best-effort (no fs transaction available). Observable state: file 1 changed, file 2 not. The Diff for file 1 is in the transcript; recovery is the model re-reading and re-patching (no auto-rollback in MVP) | each *written* file has a recorded Diff (RULE-002); no silent write | `test_REQ011_multifile_midwrite_io_failure` |
| separate tool calls in a run (e.g. write A, then run-command that fails) | a later step fails after an earlier write committed | **no rollback** — each tool call is an independently committed step by design; earlier edits stay applied; the failure surfaces as an error `ToolResult` and the model decides next action (ADR-007) | each applied Edit has a Diff + transcript entry | `test_REQ005_independent_steps_no_rollback` |
| run killed (SIGINT/crash) mid-tool-call | process terminates after a write committed but before the result is recorded | the committed file write stays on disk; the in-flight transcript entry may be lost (FAIL-034); **no auto-rollback** of the applied edit — observable post-crash state is "edits up to the crash applied, transcript readable up to its last durable entry" | durable transcript up to last flushed entry (RULE-010) | `test_REQ022_killed_midcall_state` |

---

## Dependency Outage

> Two external dependencies are on the critical path: the **Anthropic Messages API** (via
> `llm-client`) and the **user's shell/OS process** (via `command-runner`). The local filesystem is
> the third; its failures surface as the per-tool IO errors above (READ_FAILED / WRITE_FAILED /
> TRANSCRIPT_WRITE_FAILED).

| Dependency | Component that depends on it | Outage behavior | Timeout / retry policy | Negative test anchor |
|------------|-----------------------------|-----------------|-----------------------|---------------------|
| Anthropic Messages API (down / 5xx / overload) | `llm-client` | **retry then fail-closed** — bounded-backoff retry on transient; exhaustion → `unrecoverable-error` → Failed (clean, non-zero exit) | retry ≤5 (1+4), exp backoff base 1000ms cap 30000ms, full jitter (REQ-NFR-004, FAIL-005/006) | `test_REQNFR004_api_outage_retry_then_fail` |
| Anthropic API rate-limit (HTTP 429 / 529) | `llm-client` | **retry honoring `Retry-After`** as the backoff floor; exhaustion → fatal | `Retry-After` header floors the next delay; same ≤5 budget | `test_REQNFR004_rate_limit_retry_after` |
| Anthropic API network timeout / socket reset | `llm-client` | treated as transient → retry; exhaustion → fatal | per-attempt SDK timeout, then backoff | `test_REQNFR004_network_timeout_retry` |
| User's shell / spawned process hangs | `command-runner` (via `tool-runcommand`) | **kill at timeout, fail-soft** — process killed, `COMMAND_TIMEOUT` error `ToolResult`; loop continues (not a crash) | `timeoutMs` default 120000, configurable 1000–600000 (ODQ-003, ERR-009) | `test_REQ009_shell_hang_timeout` |
| User's shell — executable missing | `command-runner` | fail-soft — `COMMAND_FAILED` error `ToolResult` (spawn failure ≠ non-zero exit) | n/a (immediate) | `test_REQ009_shell_executable_missing` |
| Local filesystem — transcript path unwritable | `transcript` | **fail-closed fatal** — `TRANSCRIPT_WRITE_FAILED` → `unrecoverable-error` → Failed (audit must not be lost, RULE-010) | n/a (no retry — fatal) | `test_REQ022_transcript_fs_outage_fatal` |

---

## Crash/Restart Recovery

> **MVP has no resume (resume is V1 — ADR-002).** "Recovery" therefore means: a **readable
> transcript up to the crash** plus the working-tree edits that were already committed. There is
> **no auto-rollback** and **no re-drive**. The durable state is the append-only JSONL transcript
> (flush-per-entry); everything else (the in-memory conversation, iteration counter, budget accrual)
> is lost on crash and is reconstructable only by reading the transcript.

| Component | In-flight state | Durability guarantee | Recovery action on restart | Negative test anchor |
|-----------|----------------|---------------------|---------------------------|---------------------|
| `transcript` | the one entry being serialized/flushed | **flush-per-entry** (write + fsync-class) — every prior entry is durable as written (JSONL, not a rewritten document — ADR-002) | none in MVP; the transcript file is readable up to its last fully-flushed line; a trailing partial line is tolerated by readers | `test_REQ022_transcript_durable_per_entry` |
| `agent-run` | accumulated conversation, iteration counter, budget accrual | **none** (in-memory only) | lost on crash; not reconstructed in MVP (no resume) — a fresh invocation starts a new run with a new `runId` | `test_REQ014_no_resume_fresh_run` |
| `tool-writeedit` / `tool-applypatch` | a write committed before the crash | the OS file write itself (already on disk if it returned) | **no auto-rollback** — already-applied edits remain on the working tree; observable post-crash state = "edits applied up to the crash" | `test_REQ011_applied_edits_persist_after_crash` |

**Post-crash observable state (stated explicitly, data-integrity):** (1) every working-tree edit
whose write completed **stays applied** — Autocoder never rolls back the user's tree on crash;
(2) the transcript is readable up to its **last durable entry** (at most the in-flight entry lost);
(3) **no resume** — the next run is independent. This is the deliberate MVP posture; V1 resume will
read the transcript back as its recovery substrate (ADR-002 mitigation: typed/versioned entries).

---

## Race Conditions

> The single sequential loop (ADR-003) means **there are no in-process tool races** — one ToolCall
> is fully resolved before the next, the transcript has a single writer, and there are no threads,
> queues, or parallel tools. The real races are at the **filesystem boundary**, between Autocoder
> and *other* writers to the same working tree, plus a TOCTOU window inside the sandbox check.

| Race scenario | Components involved | Guard mechanism | Failure mode if guard absent | Negative test anchor |
|---------------|--------------------|-----------------|-----------------------------|---------------------|
| In-process: two tool calls mutating the same file in one run | `agent-run`, `tool-writeedit` | **strict sequencing** (ADR-003) — no concurrency exists; second call reads the first's committed state | n/a — the guard is the architecture; no race is reachable | `test_REQNFR002_sequential_no_inprocess_race` |
| Transcript concurrent write | `transcript` | **single writer** per run (file opened once, append-only) | n/a — only the run process writes | `test_REQ022_single_writer_transcript` |
| **Concurrent working-tree mutation** — a second Autocoder run, or the user's editor/IDE, writes the same file while a run is in flight | `tool-writeedit`/`tool-applypatch` ⇄ disk vs. external writer | **none in MVP — last-write-wins on disk; no run lock** (chosen default, see Orchestrator note) | a lost update: an external edit between Autocoder's read and write is silently overwritten by Autocoder's `after`, or vice-versa | `test_REQ021_concurrent_external_mutation_lww` |
| **TOCTOU** — gap between `path-sandbox.checkWrite` and the actual write, during which a symlink could be swapped to point outside the root | `path-sandbox`, `tool-writeedit`/`tool-applypatch` | the check resolves the **real path of the deepest existing ancestor** (symlink-resolved); the residual swap window is **accepted** as benign for a local single-user CLI (the attacker would need local write access racing the user's own process) | a symlink swapped in the window could redirect a write outside the root | `test_REQ021_toctou_symlink_window_documented` |
| `apply_patch` dry-run vs. apply drift — the file changes between the dry-run match and the persist | `tool-applypatch` | dry-run then persist run **back-to-back within one synchronous tool call** (no await between); single-process, so only an external writer could intervene (collapses into the concurrent-mutation race above) | a hunk that dry-ran clean could persist against drifted content | `test_REQ023_dryrun_apply_no_internal_drift` |

**Chosen stance on concurrent working-tree mutation (default — flagged to the Orchestrator):**
**last-write-wins on disk, no run lock in the MVP.** Rationale: Autocoder is a local, single-user,
one-task-per-invocation CLI (Constraints, Assumptions); the documented usage is one run against a
quiescent tree the developer is not simultaneously editing. A run lock (e.g. a `.autocoder.lock`
file in the root) would add cross-platform locking complexity and stale-lock recovery for a
scenario outside the documented single-user flow. The residual is a **lost-update data-loss
exposure** if the user (or a second run) edits the same file mid-run. **HUMAN-CONFIRMED 2026-06-09:**
the human reviewed this data-loss tradeoff at the gate and chose **last-write-wins, no run lock** for
the MVP (an advisory/hard lock was offered and declined). The lost-update residual is accepted; an
advisory `.autocoder.lock` remains a candidate for a later increment. Recorded as the `FAIL` row above.

---

## Unexpected States

> States the model is structured to make impossible but which are handled defensively because the
> model's output is untrusted across the LLM boundary.

| Unexpected state | Detected by | Detection point (`<component-label>`) | Recovery action | Negative test anchor |
|-----------------|-------------|---------------------------------------|-----------------|---------------------|
| AgentRun receives an out-of-model lifecycle transition (e.g. start a turn while the budget guard says stop) | state-machine guard assertion | `agent-run` / `budget-stop` | **forbidden** — the guard forces Terminating, never Iterating (RULE-006, INV-004); an attempted invalid transition is an internal-invariant breach → fatal `unrecoverable-error` | `test_REQ015_invalid_transition_to_iterating` |
| model returns a `tool_use` for a tool **not** in the five | `tool-registry` dispatch check | `tool-registry` | `UNKNOWN_TOOL` error `ToolResult` (ERR-005, RULE-012) — defensive, fed back | `test_REQ005_unknown_tool_state` |
| `tool_use` block with arguments that don't match the tool's input schema (wrong types / missing required) | the tool's input validation | the owning tool (`tool-writeedit`, etc.) | typed error `ToolResult` (the tool's own validation error); loop continues — never an uncaught crash (INV-008) | `test_REQ005_malformed_args_state` |
| model never emits a final answer / loops forever | pre-turn budget guard | `budget-stop` / `agent-run` | bounded by iteration + token ceilings → Stopped (RULE-006/007, INV-005) — non-termination is impossible | `test_REQ014_nonterminating_bounded` |
| Edit reaching `Applied` without a generated Diff | Edit state-machine guard | `diff-engine` / `tool-writeedit` | **rejected** — no Edit is representable without a Diff (RULE-002, INV-003); an attempt is an internal-invariant breach → fatal | `test_REQ010_applied_without_diff_rejected` |
| `unknown` / unparseable `stop_reason` from the SDK | `llm-client` response parser | `llm-client` | treat conservatively: if content has no tool_use and no usable text → no actionable output; surfaces as model-give-up candidate or, if the call itself failed, the fatal path — never a silent hang | `test_REQ004_unknown_stop_reason_handled` |

---

## Negative-Tests Map

> Consolidated map of every negative test defined above. These must also appear in
> `08-test-strategy.md` §REQ→Test Map and §Per-Slice Acceptance Tests. Names follow the
> `test_REQ<###>_<slug>` convention so `th coverage check` can scan for them. **No failure mode is
> "manual only"** — every row below is an automated negative test, runnable against the stubbed
> `llm-client` + `command-runner` seams (REQ-NFR-002), with real filesystem fixtures for the
> path-sandbox / patch / transcript cases.

| Test name | Failure mode (FAIL-ID) | Component / flow | REQ-ID |
|-----------|----------------------|-----------------|--------|
| `test_REQ018_missing_apikey_failfast` | FAIL-001 | `config`/`cli` | REQ-018, REQ-NFR-006 |
| `test_REQ002_invalid_root_failfast` | FAIL-002 | `config`/`cli` | REQ-002 |
| `test_REQ001_unknown_flag_usage_error` | FAIL-003 | `cli` | REQ-001, REQ-NFR-006 |
| `test_REQ025_allowlist_persist_failure` | FAIL-004 | `allowlist`/`config` | REQ-025 |
| `test_REQNFR004_transient_retry_backoff` | FAIL-005 | `llm-client` | REQ-NFR-004 |
| `test_REQNFR004_retries_exhausted_fatal` | FAIL-006 | `llm-client` | REQ-NFR-004 |
| `test_REQNFR004_fatal_4xx_no_retry` | FAIL-007 | `llm-client` | REQ-NFR-004 |
| `test_REQ015_usage_estimate_fallback` | FAIL-008 | `llm-client`/`budget-stop` | REQ-015 |
| `test_REQ014_no_final_answer_budget_stop` | FAIL-009 | `agent-run`/`budget-stop` | REQ-014 |
| `test_REQNFR004_fatal_class_terminates` | FAIL-010 | `agent-run` | REQ-NFR-004 |
| `test_REQ012_all_denied_loop_continues` | FAIL-011 | `agent-run`/`approval-gate` | REQ-012 |
| `test_REQ005_unknown_tool_rejected` | FAIL-012 | `tool-registry` | REQ-005 |
| `test_REQNFR004_expected_error_normalized` | FAIL-013 | `tool-registry` | REQ-NFR-004 |
| `test_REQ021_write_traversal_rejected` | FAIL-014 | `path-sandbox` | REQ-021 |
| `test_REQ021_write_absolute_outside_rejected` | FAIL-015 | `path-sandbox` | REQ-021 |
| `test_REQ021_write_symlink_escape_rejected` | FAIL-016 | `path-sandbox` | REQ-021 |
| `test_REQ021_exec_cwd_escape_rejected` | FAIL-017 | `path-sandbox` | REQ-021 |
| `test_REQ021_unresolvable_path_rejected` | FAIL-018 | `path-sandbox` | REQ-021 |
| `test_REQ008_search_not_found` | FAIL-019 | `tool-writeedit` | REQ-008 |
| `test_REQ008_search_ambiguous` | FAIL-020 | `tool-writeedit` | REQ-008 |
| `test_REQ011_write_io_failure` | FAIL-021 | `tool-writeedit` | REQ-011 |
| `test_REQ023_patch_malformed` | FAIL-022 | `tool-applypatch`/`diff-engine` | REQ-023 |
| `test_REQ023_patch_one_hunk_fails_atomic` | FAIL-023 | `tool-applypatch` | REQ-023 |
| `test_REQ023_patch_target_escape_rejected` | FAIL-024 | `tool-applypatch`/`path-sandbox` | REQ-023, REQ-021 |
| `test_REQ013_nonzero_exit_is_result` | FAIL-025 | `tool-runcommand` | REQ-013 |
| `test_REQ009_command_timeout` | FAIL-026 | `tool-runcommand`/`command-runner` | REQ-009 |
| `test_REQ009_command_spawn_failure` | FAIL-027 | `tool-runcommand`/`command-runner` | REQ-009 |
| `test_REQ016_nonallowlisted_prompts` | FAIL-028 | `approval-gate` | REQ-016 |
| `test_REQ016_chained_command_not_autorun` | FAIL-029 | `approval-gate`/`allowlist` | REQ-016 |
| `test_REQ012_user_abort_stops_clean` | FAIL-030 | `approval-gate`/`agent-run` | REQ-012 |
| `test_REQ015_max_iterations_guard` | FAIL-031 | `budget-stop` | REQ-015 |
| `test_REQ015_token_budget_guard` | FAIL-032 | `budget-stop` | REQ-015 |
| `test_REQ022_transcript_write_fatal` | FAIL-033 | `transcript` | REQ-022, REQ-NFR-008 |
| `test_REQ022_crash_partial_last_line_tolerated` | FAIL-034 | `transcript` | REQ-022 |
| `test_REQ006_read_failed` | (Invalid Input) | `tool-read` | REQ-006 |
| `test_REQ007_bad_regex_pattern` | (Invalid Input) | `tool-search` | REQ-007 |
| `test_REQ007_search_path_escape` | (Invalid Input) | `tool-search`/`path-sandbox` | REQ-007, REQ-021 |
| `test_REQ005_malformed_tool_arguments` | (Invalid Input / Unexpected State) | `tool-registry` + owning tool | REQ-005 |
| `test_REQ011_rewrite_identical_content_idempotent` | (Idempotency) | `tool-writeedit` | REQ-011 |
| `test_REQ023_reapply_patch_rejected` | (Idempotency) | `tool-applypatch` | REQ-023 |
| `test_REQ009_command_not_deduplicated` | (Idempotency) | `tool-runcommand` | REQ-009 |
| `test_REQ025_allowlist_ops_idempotent` | (Idempotency) | `allowlist`/`config` | REQ-025 |
| `test_REQ023_multihunk_partial_atomic` | (Partial Failure) | `tool-applypatch` | REQ-023 |
| `test_REQ023_multifile_partial_atomic` | (Partial Failure) | `tool-applypatch` | REQ-023 |
| `test_REQ011_multifile_midwrite_io_failure` | (Partial Failure) | `tool-applypatch` | REQ-011 |
| `test_REQ005_independent_steps_no_rollback` | (Partial Failure) | `agent-run` | REQ-005 |
| `test_REQ022_killed_midcall_state` | (Partial Failure / Crash) | `agent-run`/`transcript` | REQ-022 |
| `test_REQNFR004_api_outage_retry_then_fail` | (Dependency Outage) | `llm-client` | REQ-NFR-004 |
| `test_REQNFR004_rate_limit_retry_after` | (Dependency Outage) | `llm-client` | REQ-NFR-004 |
| `test_REQNFR004_network_timeout_retry` | (Dependency Outage) | `llm-client` | REQ-NFR-004 |
| `test_REQ009_shell_hang_timeout` | (Dependency Outage) | `command-runner` | REQ-009 |
| `test_REQ009_shell_executable_missing` | (Dependency Outage) | `command-runner` | REQ-009 |
| `test_REQ022_transcript_fs_outage_fatal` | (Dependency Outage) | `transcript` | REQ-022 |
| `test_REQ022_transcript_durable_per_entry` | (Crash/Restart) | `transcript` | REQ-022 |
| `test_REQ014_no_resume_fresh_run` | (Crash/Restart) | `agent-run` | REQ-014 |
| `test_REQ011_applied_edits_persist_after_crash` | (Crash/Restart) | `tool-writeedit`/`tool-applypatch` | REQ-011 |
| `test_REQNFR002_sequential_no_inprocess_race` | (Race) | `agent-run` | REQ-NFR-002 |
| `test_REQ022_single_writer_transcript` | (Race) | `transcript` | REQ-022 |
| `test_REQ021_concurrent_external_mutation_lww` | (Race) | `tool-writeedit`/`tool-applypatch` | REQ-021 |
| `test_REQ021_toctou_symlink_window_documented` | (Race) | `path-sandbox` | REQ-021 |
| `test_REQ023_dryrun_apply_no_internal_drift` | (Race) | `tool-applypatch` | REQ-023 |
| `test_REQ015_invalid_transition_to_iterating` | (Unexpected State) | `agent-run`/`budget-stop` | REQ-015 |
| `test_REQ005_unknown_tool_state` | (Unexpected State) | `tool-registry` | REQ-005 |
| `test_REQ005_malformed_args_state` | (Unexpected State) | owning tool | REQ-005 |
| `test_REQ014_nonterminating_bounded` | (Unexpected State) | `budget-stop`/`agent-run` | REQ-014 |
| `test_REQ010_applied_without_diff_rejected` | (Unexpected State) | `diff-engine`/`tool-writeedit` | REQ-010 |
| `test_REQ004_unknown_stop_reason_handled` | (Unexpected State) | `llm-client` | REQ-004 |
