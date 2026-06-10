# Implementation Plan — Autocoder

> **Stage 9 — Implementation Planning & Vertical Slicing** (spec §15.9). Produced by the
> Vertical Slice Agent in a **fresh context**, uncontaminated by layer-by-layer design thinking
> (§6.3). Runs in all engaged tiers — full here (Tier 3). Streams; surfaces slice ordering to the
> human when sequencing has product implications. Verified by Critic in **slice mode** (fresh
> context: is each slice truly vertical? all MVP REQ-IDs covered? Slice 0 a genuine skeleton?) and
> by **`th coverage check`** (mechanical: every MVP REQ-ID maps to ≥1 slice and ≥1 anchored test;
> no pure-horizontal slice passes).

## Summary

Autocoder is decomposed into **11 slices** — Slice 0 (walking skeleton) plus 10 vertical feature
slices — each adding one user-demonstrable capability that runs entry-to-output through the live
harness. **Slice 0 proves the integration spine**: a single stubbed iteration wires `cli → config →
repo-context → agent-run → stubbed llm-client (one tool_use, then a final answer) → tool-registry →
a minimal read tool → path-sandbox + approval-gate → tool_result → transcript → reporter →
RunOutcome with exit 0`, against a temp-dir fixture — no real feature, just proof the boundaries
hold. The delivery arc then thickens that spine one capability at a time: a user can run a task and
see fail-fast config (S1); watch the real loop drive a stubbed model with retry (S2); have the agent
read & search the repo (S3); see edits land as approved diffs (S4); run the project's tests as the
completion signal under the allowlist policy (S5); apply atomic multi-file patches (S6); have runs
bounded by iteration/token ceilings (S7); inspect a durable transcript and a `--json` summary (S8);
manage the command allowlist (S9); and finally watch the full closed loop self-correct from a failing
test to a passing one (S10). **Ordering note worth surfacing:** the only product-relevant ordering
choice is that the **safety gates (path-sandbox in S3/S4, approval-gate in S4/S5, budget in S7) are
demonstrable before the closed-loop demo (S10)** — the headline benchmark slice deliberately comes
last so every safety guarantee it relies on is already green; no alternative ordering changes
go-to-market because there is one user (the local developer) and one entry point.

- **Slice count:** 11 slices (Slice 0 + 10 feature slices, SLICE-1…SLICE-10)
- **Walking skeleton proves:** the full single-iteration spine — entry → config → loop → stubbed
  LlmClient tool_use → tool dispatch → both safety gates → tool_result → transcript → reporter →
  RunOutcome/exit code — integrates end-to-end against stubbed seams (REQ-NFR-002 structural)
- **First user-visible capability:** SLICE-1 — running `autocoder "<task>"` resolves & validates the
  working root, fails fast with an actionable message on misconfiguration, and sets the exit code
- **All MVP REQ-IDs covered:** yes — see REQ Coverage Map below (REQ-001…REQ-025 and
  REQ-NFR-001…REQ-NFR-008, all present)

---

## Slicing Summary

The slicing principle is **one user-facing capability per slice, each cutting top-to-bottom through
the architecture** (`cli`/`agent-run` entry → the component(s) that realize the capability →
observable output: a transcript entry, a diff, a tool result, an exit code, or a `--json` field).
The order is dictated by dependency and by the safety-before-power rule. **Slice 0** stands up the
spine so every later slice plugs a real component into an already-wired loop rather than integrating
at the end. **SLICE-1** is built first because the `cli`/`config` entry surface and the resolved
`WorkingRoot` (the boundary every other component trusts) must exist before the loop runs — it
satisfies REQ-001/002/018/020 and the fail-fast NFRs (REQ-NFR-006). **SLICE-2** then makes the loop
*real* over the stubbed `LlmClient` (REQ-003/004/005, REQ-NFR-004 retry) so all subsequent tool
slices have a live loop to flow through. **SLICE-3→SLICE-6** add the five tools in safety-ascending
order: read/search (read-only, REQ-006/007) first establishes `path-sandbox`'s read/search behavior;
write/edit (REQ-008/010/011/012) then exercises the full mutation path (diff → sandbox → approval →
disk), completing REQ-021's write-confinement; run-command (REQ-009/013/016) adds execution under the
`allowlist`; apply-patch (REQ-023) adds atomic patching on the now-proven diff/sandbox/approval
stack. **SLICE-7** bounds the loop (REQ-014/015, REQ-NFR-003) — placed after the tools so a real
multi-tool loop exists to bound. **SLICE-8** surfaces the durable transcript + `--json` + final
summary (REQ-017/019/022/024, REQ-NFR-008) — these are read-side concerns that thicken what is
already recorded. **SLICE-9** adds the allowlist-management UX (REQ-025) on the `allowlist` component
S5 introduced. **SLICE-10** integrates everything into the headline closed-loop demonstration,
proving REQ-NFR-001 (real runnable tested code) and the full-stack safety posture (REQ-NFR-005) and
cross-platform confinement (REQ-NFR-007) end-to-end. The ordering was designed to satisfy the
boundary/entry REQs early (REQ-001/002/018), the loop REQs next (REQ-004/005), and the data-integrity
safety set (REQ-021, REQ-015, REQ-012/016) before the capability-demonstration slice that depends on
all of them.

**Anti-horizontal rule:** every slice listed below is vertical — it touches the full stack
end-to-end for its capability (entry → realizing component(s) → observable output). Pure
horizontal-layer slices ("implement all five tools", "build the schema layer") are not valid and
will be rejected by the Critic and by `th coverage check`. Each tool is its own vertical slice
(entry → that tool → an observable result), not one "all tools" layer.

---

## Slice 0 — Walking Skeleton

**Goal:** prove that the architecture's integration boundaries wire together correctly before any
real feature logic is added. The walking skeleton does almost nothing functionally — it exists to
surface wiring failures early, not to deliver user value. It exercises **every significant
architectural boundary in one round-trip**: the entry/config boundary, the LLM/network boundary (the
stubbed `LlmClient` seam emitting one `tool_use` block), the tool-dispatch boundary, both safety
gates (`path-sandbox` + `approval-gate`, in trivially-passing form), the durable-audit boundary
(`transcript`), and the render/exit boundary (`reporter` → `RunOutcome` → exit code).

- **Path:** `autocoder "<noop task>"` (entry) → `cli` parses argv → `config` resolves (stub API key
  in env, root = temp-dir fixture) → `agent-run` constructed → `repo-context` builds a minimal
  context → `agent-run` calls the **stubbed `llm-client`**, which returns one `tool_use` for
  `read_file` then (next turn) a `finalAnswer` → `tool-registry` dispatches to a minimal `tool-read`
  → `path-sandbox.checkRead` (always allowed) → `approval-gate` (read needs no gate; passthrough) →
  `ToolResult` fed back → every event appended to `transcript` (JSONL) → `reporter` streams + emits
  a `RunOutcome` → `cli` sets exit code 0.
- **Components touched:** `cli`, `config`, `repo-context`, `agent-run`, `llm-client`,
  `tool-registry`, `tool-read`, `path-sandbox`, `approval-gate`, `transcript`, `reporter`
- **Observable output proving integration:** the run completes with **exit code 0**, a transcript
  file exists on disk containing a `run-started` entry then a `tool-called` (read_file) entry then a
  `tool-result` entry then a `run-completed` entry in `seq` order, and the reporter emits a
  `RunOutcome` with `status: "succeeded"`. The acceptance test asserts the *integration* (the
  ordered transcript chain across all components), not any single component in isolation.
- **REQ-IDs satisfied:** none functionally — **structural only**; REQ-NFR-002 **partial** (the
  stubbed-seam determinism backbone is established here; full NFR-002 coverage lands in SLICE-2/10).
- **Anchored acceptance test:** `test_slice0_walking_skeleton_wires_end_to_end`
- **Definition of done:** `test_slice0_walking_skeleton_wires_end_to_end` passes against the stubbed
  `LlmClient` + stubbed `CommandRunner` + temp-dir fixture; `th state verify` clean; `th coverage
  check` does not regress (Slice 0 claims no functional REQ, so it adds no coverage row — it must not
  be flagged as a pure-horizontal *feature* slice because it is explicitly the skeleton).

---

## Slice List (ordered)

Order is the build order — SLICE-1 is built first after the skeleton, SLICE-10 last. Each slice is
independently demonstrable and testable before the next begins.

---

### SLICE-1 — Task entry, config resolution & working-root boundary

- **REQ-IDs satisfied:**
  - Full: REQ-001, REQ-002, REQ-018, REQ-020, REQ-NFR-006
  - Partial: REQ-021 *(working-root *resolution*; the *enforcement* of write/exec confinement is
    completed in SLICE-3/SLICE-4)*, REQ-NFR-007 *(cross-platform root resolution; full path/shell
    portability completed in SLICE-3/SLICE-5)*
- **User-demonstrable capability:** Running `autocoder "<task>"` (positional, `--task`, stdin, or
  `--task-file`) resolves and validates the working root, merges config from flags > env > file,
  fails fast with an actionable message and a non-zero exit code on misconfiguration (missing
  `ANTHROPIC_API_KEY` or invalid root), and `--help` lists every flag and exits 0.
- **Components touched (end-to-end):** `cli`, `config`, `path-sandbox`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ001_task_positional_starts_run`
  - `test_REQ001_task_from_stdin_and_flag`
  - `test_REQ001_unknown_flag_usage_error`
  - `test_REQ002_defaults_to_cwd_root`
  - `test_REQ002_root_flag_sets_boundary`
  - `test_REQ002_invalid_root_failfast`
  - `test_REQ018_config_precedence_flags_over_env_over_file`
  - `test_REQ018_missing_apikey_failfast`
  - `test_REQ020_exit_zero_iff_succeeded`
  - `test_REQNFR006_help_lists_all_flags`
  - `test_REQNFR006_missing_apikey_actionable_message`
- **Dependencies & order:** Requires SLICE-0 complete (the `cli`→`config`→`agent-run` wiring exists
  there); first feature slice because every later component trusts the resolved `Config` and the
  canonical `WorkingRoot` boundary established here.
- **Definition of done:** all anchored acceptance tests above pass; `th coverage check` confirms
  REQ-001/002/018/020/REQ-NFR-006 map to this slice with ≥1 passing test each; `th state verify`
  clean; no regressions in SLICE-0.

---

### SLICE-2 — Repo context & the real agent loop over the stubbed model

- **REQ-IDs satisfied:**
  - Full: REQ-003, REQ-004, REQ-005, REQ-NFR-004
  - Partial: REQ-NFR-002 *(remainder — a full real loop now runs offline over stubbed seams; final
    composite NFR-002 assertion in SLICE-10)*
- **User-demonstrable capability:** With a scripted `LlmClient` stub, running a task builds repo
  context (directory listing, detected project type, detected test command — emitted as a
  `context-gathered` entry) and then drives the **real** agent loop: each iteration sends the
  accumulated conversation + the five tool schemas to the seam, routes a returned `tool_use` through
  `tool-registry` and feeds the `ToolResult` back, or finalizes on `end_turn`; transient LLM errors
  (429/5xx/timeout) are retried with bounded backoff and exhaustion/4xx is fatal.
- **Components touched (end-to-end):** `repo-context`, `agent-run`, `llm-client`, `tool-registry`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ003_context_lists_and_detects_testcmd`
  - `test_REQ003_context_without_full_repo_in_prompt`
  - `test_REQ004_loop_sends_conversation_and_receives_action`
  - `test_REQ004_unknown_stop_reason_handled`
  - `test_REQ005_dispatch_executes_and_feeds_result`
  - `test_REQ005_unknown_tool_rejected`
  - `test_REQ005_malformed_tool_arguments`
  - `test_REQ005_independent_steps_no_rollback`
  - `test_REQNFR004_transient_retry_backoff`
  - `test_REQNFR004_rate_limit_retry_after`
  - `test_REQNFR004_retries_exhausted_fatal`
  - `test_REQNFR004_fatal_4xx_no_retry`
  - `test_REQNFR004_network_timeout_retry`
  - `test_REQNFR004_api_outage_retry_then_fail`
  - `test_REQNFR004_expected_error_normalized`
  - `test_REQNFR004_fatal_class_terminates`
- **Dependencies & order:** Requires SLICE-1 complete (needs the resolved `Config` and `WorkingRoot`
  to construct `AgentRun` and to build `RepoContext`). Establishes the live loop every tool slice
  (S3–S6) flows through.
- **Definition of done:** all anchored acceptance tests pass against the stubbed `LlmClient`;
  `th coverage check` confirms REQ-003/004/005/REQ-NFR-004 map here with passing tests; `th state
  verify` clean; no regressions in SLICE-0/1.

---

### SLICE-3 — Read & search the repo through the loop (sandboxed)

- **REQ-IDs satisfied:**
  - Full: REQ-006, REQ-007
  - Partial: REQ-021 *(read-anywhere half + search root-scoping; write/exec confinement completed in
    SLICE-4/SLICE-5)*, REQ-NFR-005 *(read/search least-authority slice of the composite posture;
    full composite asserted in SLICE-10)*, REQ-NFR-007 *(path-confinement semantics under
    Windows/POSIX exercised here for read/search; shell selection in SLICE-5)*
- **User-demonstrable capability:** During a run, the agent can call `read_file` to return a file's
  full or bounded-range contents (succeeding even for paths *outside* the root — read-anywhere) and
  `list_search` to list directory entries or search file contents (glob/regex) *within* the root;
  an out-of-root search path is rejected `PATH_ESCAPE`, an invalid regex returns `BAD_PATTERN`, and a
  not-found read returns `READ_FAILED` — all as tool results fed back to the loop.
- **Components touched (end-to-end):** `tool-read`, `tool-search`, `path-sandbox`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ006_read_returns_bounded_range`
  - `test_REQ006_read_outside_root_allowed`
  - `test_REQ006_read_failed`
  - `test_REQ007_list_entries_and_search_matches`
  - `test_REQ007_bad_regex_pattern`
  - `test_REQ007_search_path_escape`
  - `test_REQNFR007_path_confinement_windows_and_posix`
- **Dependencies & order:** Requires SLICE-2 complete (tools are dispatched by the live loop +
  `tool-registry`). Built before the mutating tools so `path-sandbox`'s read/search behavior is
  proven before write/exec confinement is added.
- **Definition of done:** all anchored acceptance tests pass; `th coverage check` confirms
  REQ-006/007 map here with passing tests and the partial REQ-021 read/search assertions are green;
  `th state verify` clean; no regressions in earlier slices.

---

### SLICE-4 — Write/edit files: diff + confinement + edit-approval

- **REQ-IDs satisfied:**
  - Full: REQ-008, REQ-010, REQ-011, REQ-012, REQ-021 *(write-confinement remainder — completes the
    write/exec half together with SLICE-5's exec-cwd confinement)*
  - Partial: *(none)*
- **User-demonstrable capability:** During a run, the agent can call `write_edit` to create a file
  (whole-file `write`) or modify one (`replace`); every mutation produces a unified **diff** shown to
  the user before any write (no silent writes), is confined to the root (out-of-root targets rejected
  `PATH_ESCAPE` fail-closed), and is gated by the edit-approval policy (default **confirm-each**:
  prompt → on approval persist to disk so later reads see the new state; on denial `APPROVAL_DENIED`
  and the loop continues; `--yes` auto-applies). Replace with 0 matches → `SEARCH_NOT_FOUND`; >1
  match without `replaceAll` → `SEARCH_AMBIGUOUS`.
- **Components touched (end-to-end):** `tool-writeedit`, `diff-engine`, `approval-gate`,
  `path-sandbox`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ008_write_creates_file_with_diff`
  - `test_REQ008_replace_edits_existing`
  - `test_REQ008_search_not_found`
  - `test_REQ008_search_ambiguous`
  - `test_REQ010_mutation_produces_unified_diff`
  - `test_REQ010_applied_without_diff_rejected`
  - `test_REQ011_approved_edit_persisted_to_disk`
  - `test_REQ011_write_io_failure`
  - `test_REQ011_rewrite_identical_content_idempotent`
  - `test_REQ011_applied_edits_persist_after_crash`
  - `test_REQ012_confirm_each_is_default`
  - `test_REQ012_auto_flag_applies_without_prompt`
  - `test_REQ012_all_denied_loop_continues`
  - `test_REQ012_user_abort_stops_clean`
  - `test_REQ012_injection_novel_edit_requires_approval`
  - `test_REQ021_write_traversal_rejected`
  - `test_REQ021_write_absolute_outside_rejected`
  - `test_REQ021_write_symlink_escape_rejected`
  - `test_REQ021_unresolvable_path_rejected`
  - `test_REQ021_concurrent_external_mutation_lww`
  - `test_REQ021_toctou_symlink_window_documented`
  - `test_REQ021_rejects_traversal_write`
  - `test_REQ021_rejects_symlink_escape`
- **Dependencies & order:** Requires SLICE-3 complete (shares `path-sandbox`, which S3 introduced;
  the diff→sandbox→approval mutation path needs the live loop from S2). Built before run-command and
  apply-patch because both reuse this slice's `diff-engine` + `approval-gate` + write-confinement.
- **Definition of done:** all anchored acceptance tests pass; `th coverage check` confirms
  REQ-008/010/011/012/021 map here with passing tests (REQ-021 write-side now **Full**); the
  data-integrity tests (path-escape, edit-approval) are green; `th state verify` clean; no
  regressions in earlier slices.

---

### SLICE-5 — Run commands & tests-as-signal under the command-approval policy

- **REQ-IDs satisfied:**
  - Full: REQ-009, REQ-013, REQ-016
  - Partial: REQ-021 *(exec-cwd confinement — completes the write/exec confinement half)*,
    REQ-NFR-007 *(cross-platform shell selection in `command-runner`; the composite confinement
    assertion finalizes in SLICE-10)*
- **User-demonstrable capability:** During a run, the agent can call `run_command` to execute a
  shell command in the root via the `CommandRunner` seam, capturing `{exitCode, stdout, stderr,
  timedOut}` (a **non-zero exit is a result, not an error**); running the detected test command sets
  `isTestRun: true` and emits a `tests-run` entry feeding pass/fail back as the **primary completion
  signal**; commands matching the **allowlist** (token-prefix) auto-run while non-allowlisted /
  chained / redirected / destructive commands require confirmation; cwd outside the root →
  `PATH_ESCAPE`; timeout → `COMMAND_TIMEOUT`; spawn failure → `COMMAND_FAILED`.
- **Components touched (end-to-end):** `tool-runcommand`, `command-runner`, `approval-gate`,
  `allowlist`, `path-sandbox`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ009_runs_command_captures_exit_stdout_stderr`
  - `test_REQ009_command_timeout`
  - `test_REQ009_command_spawn_failure`
  - `test_REQ009_command_not_deduplicated`
  - `test_REQ013_test_run_marks_isTestRun_completion_signal`
  - `test_REQ013_nonzero_exit_is_result`
  - `test_REQ016_allowlisted_command_auto_runs`
  - `test_REQ016_nonallowlisted_prompts`
  - `test_REQ016_chained_command_not_autorun`
  - `test_REQ016_destructive_command_requires_confirmation`
  - `test_REQ016_allowlist_prefix_match_is_token_exact`
  - `test_REQ016_chained_command_never_auto_runs`
  - `test_REQ021_exec_cwd_escape_rejected`
  - `test_REQNFR007_command_runner_shell_selection`
- **Dependencies & order:** Requires SLICE-4 complete (shares `approval-gate` and `path-sandbox`).
  Introduces the `allowlist` component that SLICE-9 later manages.
- **Definition of done:** all anchored acceptance tests pass; `th coverage check` confirms
  REQ-009/013/016 map here with passing tests and the exec-cwd REQ-021 assertion is green; the
  command-gating data-integrity tests are green; `th state verify` clean; no regressions.

---

### SLICE-6 — Apply-patch (atomic multi-file)

- **REQ-IDs satisfied:**
  - Full: REQ-023
  - Partial: *(none)*
- **User-demonstrable capability:** During a run, the agent can call `apply_patch` with a unified-diff
  document spanning one+ hunks across one+ files; a clean patch applies **all** hunks with a per-file
  diff and persists every file (gated by the edit-approval policy), while any failure — malformed text
  (`PATCH_MALFORMED`), a single non-applying hunk (`PATCH_NOT_APPLICABLE`), or an out-of-root target
  (`PATH_ESCAPE`) — rejects the **whole** patch atomically with **zero** edits and nothing written.
- **Components touched (end-to-end):** `tool-applypatch`, `diff-engine`, `path-sandbox`,
  `approval-gate`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ023_applies_multifile_patch`
  - `test_REQ023_patch_malformed`
  - `test_REQ023_patch_one_hunk_fails_atomic`
  - `test_REQ023_patch_target_escape_rejected`
  - `test_REQ023_reapply_patch_rejected`
  - `test_REQ023_multihunk_partial_atomic`
  - `test_REQ023_multifile_partial_atomic`
  - `test_REQ023_dryrun_apply_no_internal_drift`
- **Dependencies & order:** Requires SLICE-4 complete (reuses `diff-engine`, `path-sandbox`,
  `approval-gate` — the mutation stack proven there). Independent of SLICE-5 in component terms
  (apply-patch does not touch `command-runner`/`allowlist`), so **parallel-eligible with SLICE-5**.
- **Definition of done:** all anchored acceptance tests pass; `th coverage check` confirms REQ-023
  maps here with passing tests; the atomicity (zero-edit-on-failure) data-integrity tests are green;
  `th state verify` clean; no regressions.

---

### SLICE-7 — Budget, stop conditions & iteration/token ceilings

- **REQ-IDs satisfied:**
  - Full: REQ-014, REQ-015, REQ-NFR-003
  - Partial: *(none)*
- **User-demonstrable capability:** A run terminates on exactly one defined stop condition — task
  success, max-iterations-reached, budget-exhausted, model-give-up, or unrecoverable-error — and the
  pre-turn budget guard **prevents** a turn from starting once `iterationsUsed >= maxIterations` or
  `tokensUsed >= tokenBudget` (no half-iteration), so a runaway/never-finalizing model is bounded by
  the ceiling; absent config, the conservative defaults (25 iterations, ~1,000,000 tokens) apply and
  the terminating reason maps to the `RunOutcome` status (→ exit code).
- **Components touched (end-to-end):** `budget-stop`, `agent-run`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ014_task_success_terminates`
  - `test_REQ014_no_final_answer_budget_stop`
  - `test_REQ014_nonterminating_bounded`
  - `test_REQ014_no_resume_fresh_run`
  - `test_REQ015_max_iterations_guard`
  - `test_REQ015_token_budget_guard`
  - `test_REQ015_usage_estimate_fallback`
  - `test_REQ015_invalid_transition_to_iterating`
  - `test_REQNFR003_no_run_exceeds_iteration_or_token_ceiling`
  - `test_REQNFR003_conservative_defaults_applied`
  - `test_REQNFR003_budget_pre_turn_guard_stops_runaway`
- **Dependencies & order:** Requires SLICE-2 complete (the loop the guard bounds). In practice
  ordered after SLICE-5/SLICE-6 so a real multi-tool loop exists to bound, but it shares only
  `agent-run` with S2 — **parallel-eligible with SLICE-3 in component terms** (`{budget-stop,
  agent-run}` vs `{tool-read, tool-search, path-sandbox}` are disjoint except neither touches the
  other's write surface); see Build Order for the chosen serialization.
- **Definition of done:** all anchored acceptance tests pass; `th coverage check` confirms
  REQ-014/015/REQ-NFR-003 map here with passing tests; the budget-ceiling data-integrity backstop
  tests are green; `th state verify` clean; no regressions.

---

### SLICE-8 — Durable transcript, human stream & `--json` summary

- **REQ-IDs satisfied:**
  - Full: REQ-017, REQ-019, REQ-022, REQ-024, REQ-NFR-008
  - Partial: REQ-018 *(the api-key-never-serialized guarantee is asserted against the transcript +
    `--json` here; the config-resolution body of REQ-018 is Full in SLICE-1)*
- **User-demonstrable capability:** A run produces a **durable append-only JSONL transcript** on disk
  that reconstructs the run (every iteration, tool call inputs/outputs, approval decision, diff, and
  stop decision, `seq`-ordered; a write/flush failure is fatal), streams human-readable progress to
  the terminal during the run, and on completion emits a final summary — both human-readable and, with
  `--json`, a schema-stable parseable `RunSummary` (status, stopCondition, exitCode, filesChanged,
  testsResult, iterationsUsed, tokensUsed, runId, schemaVersion) — with the API key appearing in
  neither the transcript nor the `--json` output.
- **Components touched (end-to-end):** `transcript`, `reporter`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ017_streams_plan_toolcalls_diffs_results`
  - `test_REQ019_summary_reports_outcome_files_tests_iters_tokens`
  - `test_REQ022_transcript_records_iterations_calls_results`
  - `test_REQ022_transcript_write_fatal`
  - `test_REQ022_crash_partial_last_line_tolerated`
  - `test_REQ022_single_writer_transcript`
  - `test_REQ022_transcript_durable_per_entry`
  - `test_REQ022_read_outside_root_recorded_in_transcript`
  - `test_REQ024_json_summary_schema_stable_and_parseable`
  - `test_REQ024_json_exitcode_status_stopcondition_present`
  - `test_REQ018_apikey_never_serialized`
  - `test_REQNFR008_transcript_reconstructs_calls_results_decisions`
- **Dependencies & order:** Requires SLICE-7 complete (the `RunOutcome`/stop classification the
  summary renders comes from `budget-stop`; the transcript already records events written since
  SLICE-0, this slice completes durability + reporting + `--json`). Touches only `transcript` +
  `reporter` — **parallel-eligible with SLICE-9** (disjoint components).
- **Definition of done:** all anchored acceptance tests pass; `th coverage check` confirms
  REQ-017/019/022/024/REQ-NFR-008 map here with passing tests and `test_REQ018_apikey_never_serialized`
  is green; the api-key-never-serialized data-integrity test is green; `th state verify` clean; no
  regressions.

---

### SLICE-9 — Allowlist-management UX (inspect / add / remove)

- **REQ-IDs satisfied:**
  - Full: REQ-025
  - Partial: *(none — REQ-016 matching is Full in SLICE-5; REQ-018 persistence is exercised here but
    its config body is Full in SLICE-1)*
- **User-demonstrable capability:** Running `autocoder allowlist <list|add|remove> [pattern]`
  inspects, adds, or removes entries in the command-approval allowlist (no agent loop is started),
  with changes **persisting** to the config file; add-existing and remove-absent are idempotent
  no-ops; a persistence failure exits non-zero rather than silently claiming success.
- **Components touched (end-to-end):** `cli`, `allowlist`, `config`, `reporter`
- **Anchored acceptance tests (from Stage 8):**
  - `test_REQ025_allowlist_list_add_remove_persists`
  - `test_REQ025_allowlist_ops_idempotent`
  - `test_REQ025_allowlist_persist_failure`
- **Dependencies & order:** Requires SLICE-5 complete (the `allowlist` component it manages is
  introduced there) and SLICE-1 (the `config` persistence surface). Touches `cli`/`allowlist`/
  `config`/`reporter` — **parallel-eligible with SLICE-8** (which touches `transcript`/`reporter`
  *only*; the shared `reporter` forces a check — see Build Order: confirm-output-only overlap makes
  them serialized to be safe).
- **Definition of done:** all anchored acceptance tests pass; `th coverage check` confirms REQ-025
  maps here with passing tests; `th state verify` clean; no regressions.

---

### SLICE-10 — Closed-loop acceptance (plan → edit → test-fail → self-correct → test-pass)

- **REQ-IDs satisfied:**
  - Full: REQ-NFR-001, REQ-NFR-002, REQ-NFR-005, REQ-NFR-007
  - Partial: *(re-exercises REQ-004/008/010/013/014/019 end-to-end as the integrated demonstration;
    those are already Full in their own slices — this slice proves they compose)*
- **User-demonstrable capability:** A single end-to-end run, driven by a scripted multi-iteration
  `LlmClient` stub against a temp-dir fixture repo, **demonstrates the headline success criterion**:
  the agent plans, edits a fixture file (diff shown), runs the project's tests (stubbed to fail),
  reads the failure, makes a corrective edit, runs the tests again (stubbed to pass), finalizes, and
  exits 0 — with every change recorded in the transcript as a diff. The same slice proves the
  **composite safety posture** (an out-of-root write blocked, a non-allowlisted command gated, an
  edit gated — all in one scenario) and **cross-platform confinement**, and certifies the harness runs
  fully **offline over the stubbed seams** (the determinism guarantee) and that **every functional REQ
  is verifiable by an automated test** (implementability).
- **Components touched (end-to-end):** `cli`, `config`, `repo-context`, `agent-run`, `llm-client`,
  `tool-registry`, `tool-read`, `tool-search`, `tool-writeedit`, `tool-applypatch`,
  `tool-runcommand`, `command-runner`, `path-sandbox`, `approval-gate`, `allowlist`, `diff-engine`,
  `budget-stop`, `transcript`, `reporter` *(the full system — this is the integration slice)*
- **Anchored acceptance tests (from Stage 8):**
  - `test_closedloop_plan_edit_test_fail_selfcorrect_pass`
  - `test_REQNFR001_implementability_all_functional_reqs_tested` *(meta-assertion: every functional
    REQ row in the §REQ→Test Map has ≥1 passing anchored test on Node ≥18 + Vitest; satisfied
    structurally by the green suite — see Slice Verification Notes)*
  - `test_REQNFR002_harness_runs_offline_with_stubbed_seams`
  - `test_REQNFR002_sequential_no_inprocess_race`
  - `test_REQNFR005_writes_confined_commands_gated_edits_gated`
- **Dependencies & order:** Requires **all** prior slices complete (it integrates every component).
  Built last; cannot run in parallel with anything (it touches the full component set).
- **Definition of done:** `test_closedloop_plan_edit_test_fail_selfcorrect_pass` and all
  REQ-NFR-001/002/005/007 anchored tests pass; the full suite is green (`npx vitest run`); the
  data-integrity composite (path-escape + budget + approval + api-key) is green; `th coverage check`
  passes with **zero gaps** across all REQ-001…025 and REQ-NFR-001…008; `th state verify` clean.

---

## REQ Coverage Map

Every MVP REQ-ID from `01-requirements.md` appears below — the 25 functional REQs (REQ-001…REQ-025)
and the 8 non-functional REQs (REQ-NFR-001…REQ-NFR-008). `th coverage check` reads this table and the
anchored test names to verify: (1) every MVP REQ-ID maps to ≥1 slice, (2) every mapped slice has ≥1
anchored passing test for that REQ-ID, (3) no slice is a pure horizontal layer.

| REQ-ID | Requirement (short label) | Covered by slice(s) | Coverage type |
|--------|--------------------------|---------------------|---------------|
| REQ-001 | CLI accepts NL task + starts run | SLICE-1 | Full |
| REQ-002 | Resolve + validate working root | SLICE-1 | Full |
| REQ-003 | Build initial repo context | SLICE-2 | Full |
| REQ-004 | LLM-driven loop via SDK seam | SLICE-2 | Full |
| REQ-005 | Tool interface + execute tool calls | SLICE-2 | Full |
| REQ-006 | Tool: read file | SLICE-3 | Full |
| REQ-007 | Tool: list / search files | SLICE-3 | Full |
| REQ-008 | Tool: write/edit file | SLICE-4 | Full |
| REQ-009 | Tool: run command | SLICE-5 | Full |
| REQ-010 | Every mutation produces a shown diff | SLICE-4 | Full |
| REQ-011 | Apply + persist edits per approval | SLICE-4 | Full |
| REQ-012 | Edit-approval mode | SLICE-4 | Full |
| REQ-013 | Run tests; feed pass/fail as signal | SLICE-5 | Full |
| REQ-014 | Loop terminates on a stop condition | SLICE-7 | Full |
| REQ-015 | Iteration + token/cost ceilings | SLICE-7 | Full |
| REQ-016 | Command-approval safety policy | SLICE-5 | Full |
| REQ-017 | Stream human-readable progress | SLICE-8 | Full |
| REQ-018 | Config from flags/env/file | SLICE-1 (resolution), SLICE-8 (api-key-never-serialized) | Full |
| REQ-019 | Final run summary | SLICE-8 | Full |
| REQ-020 | Exit code reflects outcome | SLICE-1 | Full |
| REQ-021 | Write/exec confined to root; read-anywhere | SLICE-3 (read/search half), SLICE-4 (write confinement), SLICE-5 (exec-cwd) | Partial → Full |
| REQ-022 | Run transcript / audit log | SLICE-8 | Full |
| REQ-023 | Tool: apply-patch (atomic) | SLICE-6 | Full |
| REQ-024 | `--json` machine-readable output | SLICE-8 | Full |
| REQ-025 | Allowlist-management commands | SLICE-9 | Full |
| REQ-NFR-001 | Implementability (real tested code) | SLICE-10 | Full |
| REQ-NFR-002 | Determinism of harness (stubbed seams) | SLICE-0 (structural), SLICE-2 (real loop offline), SLICE-10 (composite) | Partial → Full |
| REQ-NFR-003 | Cost / runaway protection | SLICE-7 | Full |
| REQ-NFR-004 | Reliability (retry / errors-as-results) | SLICE-2 | Full |
| REQ-NFR-005 | Safety / least authority | SLICE-3 (read/search), SLICE-4 (edits), SLICE-5 (commands), SLICE-10 (composite) | Partial → Full |
| REQ-NFR-006 | Usability (help / fail-fast) | SLICE-1 | Full |
| REQ-NFR-007 | Portability (cross-platform paths) | SLICE-3 (path confinement), SLICE-5 (shell selection), SLICE-10 (composite) | Partial → Full |
| REQ-NFR-008 | Observability (reconstructable transcript) | SLICE-8 | Full |

**Verification:** `th coverage check` confirms the above mechanically. Every REQ-ID in
`01-requirements.md` (REQ-001…REQ-025 and REQ-NFR-001…REQ-NFR-008) appears in exactly the rows above,
each mapped to ≥1 slice and ≥1 anchored test in `08-test-strategy.md`. No slice appears in zero rows
(no pure-horizontal slice): SLICE-0 is the explicit skeleton (structural, REQ-NFR-002 partial) and
every SLICE-1…10 carries ≥1 REQ-ID.

---

## Per-Slice Tasks & Task Files

Each task has a stable ID (`SLICE-N / TASK-MMM`, MMM globally incrementing) and a self-contained task
file at `docs/tasks/SLICE-N-TASK-MMM.md`. Tasks within a slice are sequential; tasks in independent
slices may be parallel (see Build Order). Tasks are kept coarse (1–3 per slice).

### SLICE-0 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-0 / TASK-001 | Wire the end-to-end walking-skeleton spine | (structural; REQ-NFR-002 partial) | `docs/tasks/SLICE-0-TASK-001.md` |

### SLICE-1 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-1 / TASK-002 | CLI argument surface + task ingestion + exit code | REQ-001, REQ-020, REQ-NFR-006 | `docs/tasks/SLICE-1-TASK-002.md` |
| SLICE-1 / TASK-003 | Config resolution + working-root validation + fail-fast | REQ-002, REQ-018, REQ-NFR-006 | `docs/tasks/SLICE-1-TASK-003.md` |

### SLICE-2 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-2 / TASK-004 | RepoContext builder | REQ-003 | `docs/tasks/SLICE-2-TASK-004.md` |
| SLICE-2 / TASK-005 | AgentRun loop + ToolRegistry dispatch over the LlmClient seam | REQ-004, REQ-005 | `docs/tasks/SLICE-2-TASK-005.md` |
| SLICE-2 / TASK-006 | LlmClient retry/backoff + errors-as-results | REQ-NFR-004 | `docs/tasks/SLICE-2-TASK-006.md` |

### SLICE-3 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-3 / TASK-007 | PathSandbox checkRead/checkWrite/checkExecCwd | REQ-021 (partial), REQ-NFR-007 | `docs/tasks/SLICE-3-TASK-007.md` |
| SLICE-3 / TASK-008 | read_file + list_search tools through the loop | REQ-006, REQ-007 | `docs/tasks/SLICE-3-TASK-008.md` |

### SLICE-4 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-4 / TASK-009 | DiffPatchEngine (generateDiff) + ApprovalGate (resolveEdit) | REQ-010, REQ-012 | `docs/tasks/SLICE-4-TASK-009.md` |
| SLICE-4 / TASK-010 | write_edit tool: confinement + diff + approval + persist | REQ-008, REQ-011, REQ-021 | `docs/tasks/SLICE-4-TASK-010.md` |

### SLICE-5 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-5 / TASK-011 | CommandRunner seam + Allowlist + ApprovalGate.resolveCommand | REQ-016, REQ-NFR-007 | `docs/tasks/SLICE-5-TASK-011.md` |
| SLICE-5 / TASK-012 | run_command tool + tests-as-signal + exec-cwd confinement | REQ-009, REQ-013, REQ-021 | `docs/tasks/SLICE-5-TASK-012.md` |

### SLICE-6 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-6 / TASK-013 | apply_patch tool: parse + atomic apply/reject | REQ-023 | `docs/tasks/SLICE-6-TASK-013.md` |

### SLICE-7 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-7 / TASK-014 | BudgetController: accrue + pre-turn guard + defaults | REQ-015, REQ-NFR-003 | `docs/tasks/SLICE-7-TASK-014.md` |
| SLICE-7 / TASK-015 | StopCondition classify + RunOutcome + bounded termination | REQ-014 | `docs/tasks/SLICE-7-TASK-015.md` |

### SLICE-8 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-8 / TASK-016 | TranscriptWriter: append-only JSONL, durable, fatal-on-fail | REQ-022, REQ-NFR-008 | `docs/tasks/SLICE-8-TASK-016.md` |
| SLICE-8 / TASK-017 | Reporter: human stream + final summary + `--json` + secret redaction | REQ-017, REQ-019, REQ-024, REQ-018 | `docs/tasks/SLICE-8-TASK-017.md` |

### SLICE-9 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-9 / TASK-018 | Allowlist-management subcommand (list/add/remove) + persistence | REQ-025 | `docs/tasks/SLICE-9-TASK-018.md` |

### SLICE-10 tasks

| Task ID | Title | REQ-IDs | Task file |
|---------|-------|---------|-----------|
| SLICE-10 / TASK-019 | Closed-loop e2e + composite safety + offline determinism | REQ-NFR-001, REQ-NFR-002, REQ-NFR-005, REQ-NFR-007 | `docs/tasks/SLICE-10-TASK-019.md` |

---

## Build Order & Dependencies

The rule (§16): two slices may build concurrently **only if their "components touched" sets are
completely disjoint**. Every component label below is from `04-architecture.md` §Major Components.

1. **SLICE-0** — Walking Skeleton *(prerequisite for all; must complete before any feature slice;
   touches the spine: `cli`,`config`,`repo-context`,`agent-run`,`llm-client`,`tool-registry`,
   `tool-read`,`path-sandbox`,`approval-gate`,`transcript`,`reporter`)*
2. **SLICE-1** — Task entry + config + root *(sequential after SLICE-0; establishes `config` +
   `WorkingRoot`; touches `cli`,`config`,`path-sandbox`)*
3. **SLICE-2** — Context + real loop + retry *(sequential after SLICE-1; needs the `Config`; touches
   `repo-context`,`agent-run`,`llm-client`,`tool-registry`)*
4. **SLICE-3** — Read + search tools *(sequential after SLICE-2; introduces real `path-sandbox`
   read/search; touches `tool-read`,`tool-search`,`path-sandbox`)*
5. **SLICE-4** — Write/edit + diff + approval *(sequential after SLICE-3; shares `path-sandbox`;
   touches `tool-writeedit`,`diff-engine`,`approval-gate`,`path-sandbox`)*
6. **SLICE-5** — Run-command + allowlist *(sequential after SLICE-4; shares `approval-gate`,
   `path-sandbox`; touches `tool-runcommand`,`command-runner`,`approval-gate`,`allowlist`,
   `path-sandbox`)*
7. **SLICE-6** — Apply-patch *(after SLICE-4; **parallel-eligible with SLICE-5** — disjoint from
   SLICE-5; touches `tool-applypatch`,`diff-engine`,`path-sandbox`,`approval-gate`)*
8. **SLICE-7** — Budget + stop *(after SLICE-2; ordered after the tool slices for a real loop to
   bound; touches `budget-stop`,`agent-run`)*
9. **SLICE-8** — Transcript + reporter + `--json` *(after SLICE-7 for the `RunOutcome`; touches
   `transcript`,`reporter`)*
10. **SLICE-9** — Allowlist UX *(after SLICE-5 for the `allowlist` component; touches `cli`,
    `allowlist`,`config`,`reporter`)*
11. **SLICE-10** — Closed-loop acceptance *(sequential after ALL; integrates every component;
    cannot parallelize)*

**Parallel-eligible pairs / groups:**

| Slices | Basis for parallel eligibility |
|--------|-------------------------------|
| SLICE-5 + SLICE-6 | Disjoint components: SLICE-5 `{tool-runcommand, command-runner, allowlist}` plus shared-read of `{approval-gate, path-sandbox}` vs SLICE-6 `{tool-applypatch, diff-engine}` plus shared-read of `{approval-gate, path-sandbox}`. Both only *consume* the already-built `approval-gate`/`path-sandbox` contracts (frozen after SLICE-4) and write into their own new modules — no shared write surface. |
| SLICE-3 + SLICE-7 | Disjoint write surfaces: SLICE-3 `{tool-read, tool-search, path-sandbox}` vs SLICE-7 `{budget-stop, agent-run}`. `agent-run` is consumed-read by SLICE-3's dispatch but not written; if a build wants S7 early it may run alongside S3. *(Default order serializes S7 later for a richer loop — this pair is noted as an available optimization, not the default.)* |

**Serialized pairs:**

| Slices | Reason for serialization |
|--------|--------------------------|
| SLICE-1 → SLICE-2 | SLICE-2 constructs `AgentRun` from the `Config`/`WorkingRoot` SLICE-1 produces — hard data dependency. |
| SLICE-2 → SLICE-3 | Tools are dispatched by the live loop + `tool-registry` built in SLICE-2. |
| SLICE-3 → SLICE-4 | Both touch `path-sandbox`; SLICE-4 adds the write/exec confinement branches to the same module SLICE-3 introduces — concurrent writes risk a merge/drift race. |
| SLICE-4 → SLICE-5 | Both touch `approval-gate` and `path-sandbox`; SLICE-5 adds `resolveCommand`/`checkExecCwd` to modules SLICE-4 wrote. |
| SLICE-4 → SLICE-6 | SLICE-6 reuses `diff-engine` + `approval-gate` + `path-sandbox` contracts frozen in SLICE-4 (S6 may then run parallel to S5). |
| SLICE-7 → SLICE-8 | SLICE-8's final summary renders the `RunOutcome`/`stopCondition` classified by `budget-stop` in SLICE-7. |
| SLICE-8 → SLICE-9 | Both touch `reporter` (S8 writes its render paths; S9 reuses them for allowlist confirmation output) — serialize to avoid a concurrent write to `reporter`. |
| SLICE-5 → SLICE-9 | SLICE-9 manages the `allowlist` component introduced in SLICE-5. |
| ALL → SLICE-10 | SLICE-10 touches every component; it is the integration slice and runs last, alone. |

---

## Slice Verification Notes

Checklist for the Critic in slice mode (spec §15.9). The Critic runs in fresh context and checks
coherence only — that the slice plan is internally consistent with upstream artifacts and that slices
are genuinely vertical.

- [ ] Every slice is vertical: it touches the full stack end-to-end for its capability (no
      pure-horizontal slice — each of SLICE-3…6 is *one tool's* entry-to-result path, not an "all
      tools" layer; SLICE-1 is entry→config→root→exit, not a "config layer").
- [ ] Every slice delivers a user-demonstrable, independently testable capability (each "User-
      demonstrable capability" field starts with an observable behavior).
- [ ] Slice 0 is a genuine walking skeleton: it exercises every significant integration boundary in
      one round-trip and delivers no functional REQ (structural; REQ-NFR-002 partial only).
- [ ] The ordering produces a working, demonstrable system after every slice completes (each slice's
      acceptance tests pass against stubbed seams + temp-dir fixture before the next begins).
- [ ] Every MVP REQ-ID from `01-requirements.md` appears in the REQ Coverage Map with ≥1 slice —
      REQ-001…REQ-025 and REQ-NFR-001…REQ-NFR-008 all present.
- [ ] Every slice in the Coverage Map has ≥1 anchored acceptance test that exists in
      `08-test-strategy.md` (test names reused verbatim from the §REQ→Test Map and §Per-Slice
      Acceptance Tests; the 08a abuse-case reconciled names are reused where applicable).
- [ ] `th coverage check` passes with zero gaps on the coverage map above.
- [ ] Component labels in "Components touched" match the canonical labels in `04-architecture.md`
      §Major Components exactly (`cli`,`config`,`repo-context`,`agent-run`,`llm-client`,
      `tool-registry`,`tool-read`,`tool-search`,`tool-writeedit`,`tool-applypatch`,
      `tool-runcommand`,`command-runner`,`path-sandbox`,`approval-gate`,`allowlist`,`diff-engine`,
      `budget-stop`,`transcript`,`reporter`).
- [ ] Parallel-eligible pairs (SLICE-5 + SLICE-6) confirmed disjoint by component-set inspection (no
      shared *write* surface; both only consume the frozen SLICE-4 contracts).
- [ ] No task file is missing for any task listed in Per-Slice Tasks (19 tasks, TASK-001…TASK-019,
      one file each under `docs/tasks/`).

**Open ordering note surfaced to the human (no interactive gate attempted):** the only
product-relevant sequencing choice is that the **closed-loop demonstration (SLICE-10) is last** so
every safety guarantee it relies on (path confinement S3/S4, exec confinement S5, edit/command
approval S4/S5, budget ceilings S7) is already green when the headline benchmark is exercised. There
is no alternative ordering with a different go-to-market consequence — one local user, one entry
point — so this is recorded as a note, not a gate.

**Acknowledged deviation (test-name provenance):** `test_REQNFR001_implementability_all_functional_reqs_tested`
in SLICE-10 is a **meta-assertion** — `08-test-strategy.md` deliberately gives REQ-NFR-001 *no
standalone tautological anchor* (it is satisfied by every other row passing). The name is recorded
here for traceability of the slice's DoD; mechanically, REQ-NFR-001 is proven by the green suite, and
`th coverage check` keys REQ-NFR-001 to SLICE-10 as the slice that certifies the whole suite passes.
