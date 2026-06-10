# Test Strategy — Autocoder

> **Stage 8 — Test Strategy** (spec §15.8). Tier T3, data-integrity blast-radius. Streams; asks
> the human about quality bars only where they are real tradeoffs. The Orchestrator gates the whole
> plan before build, so the one quality-bar choice here (coverage target) is adopted as a sensible
> default and noted, not separately gated. Mechanically enforced by `th coverage check`: every MVP
> REQ-ID must map to ≥1 anchored test (`test_REQ<###>_<slug>`); every slice in the REQ Coverage Map
> must have ≥1 passing anchored test; any gap is a blocking failure before Stage 9 may proceed.

## Summary

Autocoder's correctness proof rests on one structural fact established in the architecture and
contracts: the only two non-deterministic edges — the LLM/network boundary (`LlmClient`, IF-006) and
the shell/process boundary (`CommandRunner`, IF-007) — are dependency-injected seams that tests
**stub** (REQ-NFR-002, ADR-004). With both seams stubbed, the entire harness (loop control, path
sandboxing, diff/patch, approval gating, budget/stop, transcript, config) is plain deterministic code
that runs offline with no API key and no real subprocess. The suite is therefore **unit-heavy with a
load-bearing end-to-end layer**: most safety and logic guarantees are proven at unit level against the
17 contracts, while a handful of e2e tests drive the full `agent-run` loop against a stubbed
`LlmClient` script + a temp-dir fixture repo, through tool calls to a passing-tests outcome. Tests are
the contract (§11): every functional REQ-001…025 and every checkable REQ-NFR maps to ≥1 anchored
`test_REQ<###>_<slug>` test that `th coverage check` scans for; the 42 failure-mode negative tests
(08b) and the 10 security abuse-case tests (08a, reconciled here to the anchored convention) are folded
into that map. The irreducible correctness boundary for any slice is: its anchored tests pass, the
data-integrity negative tests (path-escape, budget ceiling, approval gating, api-key-never-serialized)
stay green, and `th coverage check` reports zero gaps.

- **Test pyramid shape:** unit-heavy, contract-anchored, with a thin load-bearing e2e layer over the stubbed seams
- **Coverage gate:** every MVP REQ-ID maps to ≥1 anchored test (`th coverage check`)
- **Slice acceptance signal:** end-to-end acceptance tests pass against the stubbed `LlmClient` + temp-dir fixture; `th coverage check` green

---

## Test Philosophy

The governing principle is **determinism through the DI seams**: because the Anthropic SDK and the
OS shell are the only non-deterministic dependencies and both are isolated behind exactly one
interface each (`LlmClient`/IF-006, `CommandRunner`/IF-007, ADR-004, REQ-NFR-002), every other part
of Autocoder is a pure, offline-testable function of its inputs. The pyramid is therefore
**unit-heavy**: the safety-critical components — `path-sandbox` (RULE-001/REQ-021), `approval-gate`
(RULE-004/005/REQ-012/016), `budget-stop` (RULE-006/REQ-015), `diff-engine` (RULE-002/REQ-010), the
five tools, and `transcript` (RULE-010/REQ-022) — are each driven directly at unit level against
their §7 contracts, with the full positive and negative behavior enumerated by 08b and 08a. A thin
but **load-bearing end-to-end layer** sits on top: an e2e test stubs `LlmClient` with a scripted
sequence of `ToolCall`s and drives the real `agent-run` loop, real `tool-registry`, real tools, and a
real temp-dir fixture repo (with `CommandRunner` stubbed to emit deterministic exit codes) from entry
point to a `RunOutcome` — proving the components integrate, not just that each works alone. Contract
tests pin the model-facing boundary: the five tool JSON Schemas and the two DI-seam shapes are
validated so a Builder cannot drift the wire contract. The irreducible correctness boundary, the one
that must pass before any slice is declared done (§11), is the data-integrity set: **no write or exec
escapes the root (REQ-021), no run exceeds its ceilings (REQ-015), no edit/non-allowlisted-command
runs without approval (REQ-012/016), and the API key never reaches disk (REQ-018)** — these are
non-negotiable green-or-block tests, not best-effort coverage.

---

## Test Levels & Rationale

### Unit Tests

The dominant level. Each load-bearing component is tested in isolation against its §7 contract, with
its dependencies either real-and-pure (`diff-engine`, `path-sandbox` are pure functions) or stubbed
(`LlmClient`, `CommandRunner`). Covered at unit level: `path-sandbox` containment math
(traversal/absolute/symlink/unresolvable, REQ-021); `approval-gate` policy resolution including
token-prefix matching and chained-command disqualification (REQ-012/016); `budget-stop` accrual,
pre-turn guard, and outcome classification (REQ-014/015/020); `diff-engine` diff generation and
per-hunk applicability (REQ-010/023); each tool's input validation and error mapping (REQ-006…009,
023); `config` precedence and fail-fast (REQ-018); `transcript` envelope/seq/append-only behavior
(REQ-022); `reporter` human + `--json` rendering (REQ-017/019/024). **Not** unit-tested here: the
multi-component wiring of the loop (pushed to e2e, because a unit test of `agent-run` with everything
mocked would assert mock interactions, not real integration) and the JSON-Schema-shape contract of
the five tools (pushed to contract level). Why load-bearing: with the seams stubbed, unit tests give
fast, exhaustive, deterministic coverage of every branch the safety guarantees depend on.

### Integration Tests

Exercise the real cross-component boundaries that unit-with-stubs would paper over, with only the two
DI seams stubbed. Key boundaries: `tool-writeedit` → `path-sandbox` → `diff-engine` → `approval-gate`
→ real `fs` write to a temp dir (the full IF-003 mutation path, REQ-008/010/011/021);
`tool-runcommand` → `path-sandbox` (cwd) → `approval-gate` (policy/allowlist) → stubbed
`CommandRunner` (IF-004, REQ-009/013/016/021); `tool-applypatch` → `diff-engine` → `path-sandbox` →
`fs` atomicity across multiple real files (IF-005, REQ-023, RULE-013); `agent-run` →
`tool-registry` → tool dispatch with a stubbed `LlmClient` (IF-006/IF-008, REQ-005); `agent-run` →
`budget-stop` pre-turn guard (IF-011, REQ-014/015); every emitter → `transcript` (IF-012, REQ-022).
Why load-bearing: the atomic-patch, approval-flow, and confinement guarantees are emergent across
components — they cannot be proven by any single unit.

### Contract Tests

The published model-facing boundary is the **five tool JSON Schemas** (IF-001…IF-005) that
`LlmClient` attaches to the Messages API `tools` field, plus the **two DI-seam interface shapes**
(IF-006 `LlmClient`, IF-007 `CommandRunner`) and the **`--json` `RunSummary` schema** (IF-016, the
CI-stable contract). Autocoder runs **no HTTP/RPC server of its own** (07-contracts §Events), so
there is no external API to consumer-drive; instead, contract tests assert: (a) each tool schema is
valid JSON Schema with all required/typed/constrained fields and the exact snake_case wire names
(`read_file`/`list_search`/`write_edit`/`run_command`/`apply_patch`, RULE-012); (b) `ToolResult` is
the normalized `{toolCallId, status, output|error}` shape (INV-008); (c) the `--json` `RunSummary`
carries its required fields and `schemaVersion`, and `exitCode == 0 iff status == "succeeded"`
(INV-006); (d) `TranscriptEntry` validates against its versioned discriminated-union schema for all
18 `type` values (IF-015). Why load-bearing: these are the boundaries independently built slices
integrate across; a drift here breaks the model interaction or CI consumers silently.

### End-to-End (Acceptance) Tests

Entry point: the `cli` invocation (or the composed `agent-run` for tighter fixtures). Scope: both
happy path and the safety-critical error paths. A passing e2e run drives a **scripted `LlmClient`
stub** (a deterministic sequence of `ToolCall`s ending in a final answer) and a **stubbed
`CommandRunner`** (deterministic exit codes for the fixture's "test command") against a **temp-dir
fixture repo**, through the real loop and real tools, to an asserted `RunOutcome` (status, exitCode,
filesChanged, testsResult) and an inspectable `Transcript`. The walking-skeleton e2e proves one
stubbed iteration wires end-to-end; capability e2e tests prove each tool group delivers its
user-demonstrable behavior; the closed-loop e2e proves the headline success criterion — plan → edit →
run tests → read failure → self-correct → tests pass — across multiple stubbed iterations. Per-slice
acceptance tests are listed in §Per-Slice Acceptance Tests.

### Performance / Load Tests

**Not applicable as throughput/latency SLOs.** No REQ-NFR specifies a measurable latency or
throughput target — Autocoder is a single-user, one-task-per-invocation local CLI whose wall-clock
time is dominated by the (stubbed-in-test) model and shell. The performance-shaped requirement that
*does* exist is **cost/runaway protection** (REQ-NFR-003), which is a hard *ceiling*, not a latency
SLO; it is verified by the budget-guard tests under §Non-Functional Tests, not by load testing.

### Security Tests

Required — §08a-security-threat-model.md exists and REQ-NFR-005 (safety/least-authority) is defined.
The 10 abuse cases (ABU-001…010) map to negative tests, **reconciled here to the anchored
`test_REQ<###>_<slug>` convention** so `th coverage check` and `th anchors scan --scan-tests` can
parse them (the 08a doc used descriptive names like `test_runcommand_destructive_command_requires_confirmation`;
each is mapped to the REQ-ID it verifies — see the reconciliation note under §REQ→Test Map and the
§Non-Functional Tests table). The 42 failure-mode negative tests (08b §Negative-Tests Map) already use
the anchored convention and are carried over verbatim. Security tests are concentrated on the two
trust boundaries: TB-002 (path-escape, symlink-escape, exec-cwd-escape, chained-command auto-run,
over-broad allowlist match) and the secret-handling rule (api-key-never-serialized), plus the
DoS/budget backstop on TB-001.

---

## REQ→Test Map

> The mechanical coverage check read by `th coverage check`. Every MVP REQ-ID from
> `01-requirements.md` appears exactly once. Test names use the `test_REQ<###>_<slug>` anchor
> convention (NFRs use `test_REQNFR<###>_<slug>`, matching the names already established in
> 08b). Where a REQ has many negative tests in 08b/08a, a representative set is named here and the
> full set lives in §Non-Functional Tests and the 08b Negative-Tests Map; the lead anchored test
> per REQ is the one `th coverage check` keys on. Every "asserts" entry is a concrete observable
> outcome, never "runs without error."

| REQ-ID | Requirement (short label) | Test name(s) | Level | Asserts (observable) / does NOT assert |
|--------|--------------------------|--------------|-------|----------------------------------------|
| REQ-001 | CLI accepts NL task + starts run | `test_REQ001_task_positional_starts_run`, `test_REQ001_task_from_stdin_and_flag`, `test_REQ001_unknown_flag_usage_error` | e2e / unit | Asserts a positional/`--task`/stdin task produces a started `agent-run` with `run-started` transcript entry carrying the task; usage error → non-zero exit. Does NOT assert the task is *completed* (that is REQ-014). |
| REQ-002 | Resolve + validate working root | `test_REQ002_defaults_to_cwd_root`, `test_REQ002_root_flag_sets_boundary`, `test_REQ002_invalid_root_failfast` | unit | Asserts resolved root = cwd by default / `--root` value; invalid root → `CONFIG_INVALID` fail-fast non-zero exit before any iteration. Does NOT assert sandbox enforcement (REQ-021). |
| REQ-003 | Build initial repo context | `test_REQ003_context_lists_and_detects_testcmd`, `test_REQ003_context_without_full_repo_in_prompt` | unit | Asserts `repo-context` emits a `context-gathered` entry with detected projectType/testCommand/fileCount; context is bounded (not the whole repo). Does NOT assert correctness of the test run itself (REQ-013). |
| REQ-004 | LLM-driven loop via SDK seam | `test_REQ004_loop_sends_conversation_and_receives_action`, `test_REQ004_unknown_stop_reason_handled` | unit / integration | Asserts each iteration calls stubbed `LlmClient.send` with the accumulated conversation + 5 tool schemas and routes the returned tool_use/final answer; unknown `stop_reason` handled without hang. Does NOT call the live API. |
| REQ-005 | Tool interface + execute tool calls | `test_REQ005_dispatch_executes_and_feeds_result`, `test_REQ005_unknown_tool_rejected`, `test_REQ005_malformed_tool_arguments`, `test_REQ005_independent_steps_no_rollback` | unit / integration | Asserts `tool-registry.dispatch` returns exactly one normalized `ToolResult` fed back into the loop; unknown tool → `UNKNOWN_TOOL` result (no throw); malformed args → tool's typed error result. Does NOT assert tool *side effects* (per-tool tests do). |
| REQ-006 | Tool: read file | `test_REQ006_read_returns_bounded_range`, `test_REQ006_read_outside_root_allowed`, `test_REQ006_read_failed` | unit | Asserts `read_file` returns content + `truncated`/`totalLines`; read-anywhere succeeds outside root; not-found/dir/permission → `READ_FAILED` result. Does NOT confine reads (deliberate, INV-002). |
| REQ-007 | Tool: list / search files | `test_REQ007_list_entries_and_search_matches`, `test_REQ007_bad_regex_pattern`, `test_REQ007_search_path_escape` | unit | Asserts list returns typed entries and search returns `{path,line,text}` matches with `count`/`truncated`; invalid regex → `BAD_PATTERN`; out-of-root path → `PATH_ESCAPE` (search is root-scoped). Does NOT assert write behavior. |
| REQ-008 | Tool: write/edit file | `test_REQ008_write_creates_file_with_diff`, `test_REQ008_replace_edits_existing`, `test_REQ008_search_not_found`, `test_REQ008_search_ambiguous` | unit / integration | Asserts write/replace produce an `Edit` with a Diff and persist on approval; replace with 0 matches → `SEARCH_NOT_FOUND` no Edit; >1 match w/o replaceAll → `SEARCH_AMBIGUOUS` no Edit. Does NOT assert containment (REQ-021) or approval (REQ-012). |
| REQ-009 | Tool: run command | `test_REQ009_runs_command_captures_exit_stdout_stderr`, `test_REQ009_command_timeout`, `test_REQ009_command_spawn_failure`, `test_REQ009_command_not_deduplicated` | unit / integration | Asserts `run_command` returns `{exitCode,stdout,stderr,timedOut}` via stubbed `CommandRunner`; timeout → `COMMAND_TIMEOUT`; spawn failure → `COMMAND_FAILED`. Does NOT treat a non-zero exit as an error (REQ-013). |
| REQ-010 | Every mutation produces a shown diff | `test_REQ010_mutation_produces_unified_diff`, `test_REQ010_applied_without_diff_rejected` | unit | Asserts every Edit carries a unified Diff (before→after) emitted as `edit-proposed`; an Edit reaching Applied without a Diff is an invariant breach (rejected/fatal). Does NOT assert terminal rendering colors (usability, not contract). |
| REQ-011 | Apply + persist edits per approval | `test_REQ011_approved_edit_persisted_to_disk`, `test_REQ011_write_io_failure`, `test_REQ011_rewrite_identical_content_idempotent`, `test_REQ011_applied_edits_persist_after_crash` | integration | Asserts an approved Edit is written to disk so subsequent reads see new state; IO failure → `WRITE_FAILED`, Edit Rejected not Applied; identical re-write is content-idempotent. Does NOT auto-rollback on a later step failure (by design). |
| REQ-012 | Edit-approval mode | `test_REQ012_confirm_each_is_default`, `test_REQ012_auto_flag_applies_without_prompt`, `test_REQ012_all_denied_loop_continues`, `test_REQ012_user_abort_stops_clean` | unit / integration | Asserts default `confirm-each` prompts before each write; `--yes` auto-applies; denial → `APPROVAL_DENIED` result and loop continues; user-abort → `Stopped` (clean, not Failed). Does NOT assert command policy (REQ-016). |
| REQ-013 | Run tests; feed pass/fail as signal | `test_REQ013_test_run_marks_isTestRun_completion_signal`, `test_REQ013_nonzero_exit_is_result` | integration | Asserts a run of the detected test command sets `isTestRun:true` and a `tests-run` entry with `passed`; a failing test run is a **success** ToolResult carrying `exitCode != 0`, fed back as signal. Does NOT decide success on the model's word alone. |
| REQ-014 | Loop terminates on a stop condition | `test_REQ014_task_success_terminates`, `test_REQ014_no_final_answer_budget_stop`, `test_REQ014_nonterminating_bounded`, `test_REQ014_no_resume_fresh_run` | unit / e2e | Asserts the loop ends on exactly one StopCondition (task-success / max-iter / budget / give-up / unrecoverable); a model that never finalizes is bounded by the guard → Stopped. Does NOT permit a non-terminating state. |
| REQ-015 | Iteration + token/cost ceilings | `test_REQ015_max_iterations_guard`, `test_REQ015_token_budget_guard`, `test_REQ015_usage_estimate_fallback`, `test_REQ015_invalid_transition_to_iterating` | unit | Asserts the pre-turn guard stops at `iterationsUsed>=maxIterations` (→ `max-iterations-reached`) and `tokensUsed>=tokenBudget` (→ `budget-exhausted`) **before** starting the turn (no half-iteration). Does NOT abort a turn mid-flight. |
| REQ-016 | Command-approval safety policy | `test_REQ016_allowlisted_command_auto_runs`, `test_REQ016_nonallowlisted_prompts`, `test_REQ016_chained_command_not_autorun`, `test_REQ016_destructive_command_requires_confirmation`, `test_REQ016_allowlist_prefix_match_is_token_exact` | unit / integration | Asserts allowlisted (token-prefix) commands auto-run; non-allowlisted/destructive prompt for confirmation; chained/redirected (`;`/`&&`/`\|`/`>`/`` ` ``/`$(`) never auto-run; substring-only matches do NOT auto-run. Does NOT confine command *effects* (RES-004 residual). |
| REQ-017 | Stream human-readable progress | `test_REQ017_streams_plan_toolcalls_diffs_results` | integration | Asserts the `reporter` streams plan/step, each tool call + outcome, diffs, and test results to stdout in order. Does NOT assert specific color codes or terminal width. |
| REQ-018 | Config from flags/env/file | `test_REQ018_config_precedence_flags_over_env_over_file`, `test_REQ018_missing_apikey_failfast`, `test_REQ018_apikey_never_serialized` | unit | Asserts precedence flags>env>file>defaults resolves a `Config`; missing `ANTHROPIC_API_KEY` → fail-fast `CONFIG_INVALID`; the key is never written to transcript/`--json`/disk. Does NOT validate the key against the live API. |
| REQ-019 | Final run summary | `test_REQ019_summary_reports_outcome_files_tests_iters_tokens` | e2e | Asserts the final `RunSummary` reports status, filesChanged (+diffs), testsResult, iterationsUsed, tokensUsed, runId. Does NOT assert byte-exact human formatting (only the field set + values). |
| REQ-020 | Exit code reflects outcome | `test_REQ020_exit_zero_iff_succeeded` | unit / e2e | Asserts `exitCode == 0` iff `status == "succeeded"`, non-zero for stopped/failed (INV-006). Does NOT distinguish *which* non-zero code per stop reason (single non-zero is contract-sufficient). |
| REQ-021 | Write/exec confined to root; read-anywhere | `test_REQ021_write_traversal_rejected`, `test_REQ021_write_absolute_outside_rejected`, `test_REQ021_write_symlink_escape_rejected`, `test_REQ021_exec_cwd_escape_rejected`, `test_REQ021_unresolvable_path_rejected`, `test_REQ021_concurrent_external_mutation_lww`, `test_REQ021_toctou_symlink_window_documented` | unit | Asserts every out-of-root write/exec target (traversal/absolute/symlink/unresolvable) → `PATH_ESCAPE` fail-closed before the op; reads are NOT confined; LWW + TOCTOU residuals documented & tested. Does NOT confine reads (INV-002). |
| REQ-022 | Run transcript / audit log | `test_REQ022_transcript_records_iterations_calls_results`, `test_REQ022_transcript_write_fatal`, `test_REQ022_crash_partial_last_line_tolerated`, `test_REQ022_single_writer_transcript`, `test_REQ022_transcript_durable_per_entry` | unit / integration | Asserts append-only seq-ordered JSONL of every event reconstructs the run; a write/flush failure is **fatal** (`TRANSCRIPT_WRITE_FAILED` → Failed); crash loses at most the in-flight line. Does NOT contain the API key (REQ-018). |
| REQ-023 | Tool: apply-patch (atomic) | `test_REQ023_applies_multifile_patch`, `test_REQ023_patch_malformed`, `test_REQ023_patch_one_hunk_fails_atomic`, `test_REQ023_patch_target_escape_rejected`, `test_REQ023_reapply_patch_rejected`, `test_REQ023_multihunk_partial_atomic`, `test_REQ023_multifile_partial_atomic`, `test_REQ023_dryrun_apply_no_internal_drift` | integration | Asserts a clean multi-file patch applies all hunks with per-file Diffs; malformed → `PATCH_MALFORMED`; any hunk/target failure → `PATCH_NOT_APPLICABLE`/`PATH_ESCAPE` with **zero Edits, nothing written** (RULE-013 atomicity). Does NOT half-apply. |
| REQ-024 | `--json` machine-readable output | `test_REQ024_json_summary_schema_stable_and_parseable`, `test_REQ024_json_exitcode_status_stopcondition_present` | unit / e2e | Asserts `--json` emits a parseable `RunSummary` object with the required fields + `schemaVersion`, stable `status`/`exitCode`/`stopCondition`. Does NOT remove/retype fields within a schemaVersion (additive only). |
| REQ-025 | Allowlist-management commands | `test_REQ025_allowlist_list_add_remove_persists`, `test_REQ025_allowlist_ops_idempotent`, `test_REQ025_allowlist_persist_failure` | unit | Asserts `allowlist list/add/remove` inspects/mutates the set and persists to config; add-existing/remove-absent are no-ops; persistence failure → non-zero exit (not silently "saved"). Does NOT run the agent loop in allowlist mode. |
| REQ-NFR-001 | Implementability (real tested code) | *(satisfied structurally — every functional REQ above has ≥1 automated test; no standalone anchor)* | meta | Asserted by the existence + passing of every other row in this table on Node ≥18 + Vitest. Does NOT add a separate test (would be a tautology). |
| REQ-NFR-002 | Determinism of harness (stubbed seams) | `test_REQNFR002_harness_runs_offline_with_stubbed_seams`, `test_REQNFR002_sequential_no_inprocess_race` | integration | Asserts a full loop runs to outcome with `LlmClient`+`CommandRunner` stubbed, no network/no real shell; strictly sequential (no in-process race). Does NOT exercise the real SDK/shell. |
| REQ-NFR-003 | Cost / runaway protection | `test_REQNFR003_no_run_exceeds_iteration_or_token_ceiling`, `test_REQNFR003_conservative_defaults_applied` | unit | Asserts no run can start a turn past either ceiling and that absent config the conservative defaults (25 iters, ~1e6 tokens) apply. Does NOT measure wall-clock cost. |
| REQ-NFR-004 | Reliability (retry / errors-as-results) | `test_REQNFR004_transient_retry_backoff`, `test_REQNFR004_retries_exhausted_fatal`, `test_REQNFR004_fatal_4xx_no_retry`, `test_REQNFR004_rate_limit_retry_after`, `test_REQNFR004_network_timeout_retry`, `test_REQNFR004_api_outage_retry_then_fail`, `test_REQNFR004_expected_error_normalized`, `test_REQNFR004_fatal_class_terminates` | unit / integration | Asserts transient 429/5xx/timeout retried ≤5 with exp backoff + jitter honoring `Retry-After`; exhaustion/4xx → fatal `LLM_FATAL`; expected tool failures normalized to error ToolResults (no crash). Does NOT retry non-transient errors. |
| REQ-NFR-005 | Safety / least authority | `test_REQNFR005_writes_confined_commands_gated_edits_gated` | integration | Asserts the composite safety posture: a stubbed loop attempting an out-of-root write is blocked (REQ-021), a non-allowlisted command is gated (REQ-016), and an edit is gated (REQ-012) — all in one end-to-end safety scenario. Does NOT add OS-level effect sandboxing (RES-004). |
| REQ-NFR-006 | Usability (help / fail-fast) | `test_REQNFR006_help_lists_all_flags`, `test_REQNFR006_missing_apikey_actionable_message` | unit | Asserts `--help` exits 0 and documents every flag; misconfiguration fails fast with an actionable stderr message. Does NOT assert subjective readability. |
| REQ-NFR-007 | Portability (cross-platform paths) | `test_REQNFR007_path_confinement_windows_and_posix`, `test_REQNFR007_command_runner_shell_selection` | unit | Asserts path-confinement holds under both Windows (case-fold, backslash) and POSIX path semantics; shell selection (cmd vs sh) is contained in `CommandRunner`. Does NOT require a real multi-OS CI matrix to pass logic (semantics tested via fixtures). |
| REQ-NFR-008 | Observability (reconstructable transcript) | `test_REQNFR008_transcript_reconstructs_calls_results_decisions` | unit | Asserts the transcript carries each tool call's inputs/outputs and each stop decision sufficient to reconstruct the run. Does NOT assert a UI for reading it. |

**Coverage confirmation:** all of REQ-001…REQ-025 and all checkable REQ-NFR-001…008 appear exactly
once above, each with ≥1 anchored `test_REQ<###>_<slug>` / `test_REQNFR<###>_<slug>` test. REQ-NFR-001
is satisfied structurally (it is "everything else has a test") and carries no tautological standalone
anchor by design — every other row is its evidence.

**Reconciliation of 08a security abuse-case tests → anchored convention** (the 08a doc used
descriptive, non-anchored names; each is mapped to the REQ-ID it verifies and renamed to
`test_REQ<###>_<slug>`):

| 08a name (before) | Reconciled anchored name (after) | REQ-ID |
|---|---|---|
| `test_runcommand_destructive_command_requires_confirmation` (ABU-001) | `test_REQ016_destructive_command_requires_confirmation` | REQ-016 |
| `test_read_outside_root_is_recorded_in_transcript` (ABU-002) | `test_REQ022_read_outside_root_recorded_in_transcript` | REQ-022 (read-exposure audit) |
| `test_pathsandbox_rejects_traversal_write` (ABU-003) | `test_REQ021_rejects_traversal_write` | REQ-021 |
| `test_pathsandbox_rejects_symlink_escape` (ABU-004) | `test_REQ021_rejects_symlink_escape` | REQ-021 |
| `test_approvalgate_chained_command_never_auto_runs` (ABU-005) | `test_REQ016_chained_command_never_auto_runs` | REQ-016 |
| `test_approvalgate_allowlist_prefix_match_is_token_exact` (ABU-006) | `test_REQ016_allowlist_prefix_match_is_token_exact` | REQ-016 |
| `test_injection_novel_edit_still_requires_approval` (ABU-007) | `test_REQ012_injection_novel_edit_requires_approval` | REQ-012 |
| `test_budget_pre_turn_guard_stops_runaway_loop` (ABU-008) | `test_REQNFR003_budget_pre_turn_guard_stops_runaway` | REQ-NFR-003 |
| `test_apikey_never_appears_in_transcript_or_json` (ABU-009) | `test_REQ018_apikey_never_serialized` | REQ-018 |
| `test_transcript_write_failure_is_fatal` (ABU-010) | `test_REQ022_transcript_write_fatal` | REQ-022 |

**Verification:** `th coverage check` scans test files for these exact anchors. Any REQ-ID missing
from this table, or whose named test does not exist in the suite, is a blocking gap reported by the
tool. The 42 negative-test anchors from 08b §Negative-Tests Map carry over verbatim and are
distributed across the rows above.

---

## Per-Slice Acceptance Tests

> Slices are assigned in Stage 9 (`09-implementation-plan.md`). The groupings below are the
> **anticipated** capability slices implied by the architecture components and the §7 producer/
> consumer map; each acceptance test is end-to-end for its capability (entry → observable output),
> anchored to REQ-IDs. Stage 9 will bind these to concrete S-numbers; the test names already follow
> the anchor convention so they appear in the REQ→Test Map above.

### Slice 0 — Walking Skeleton

- **Anchored acceptance test:** `test_slice0_walking_skeleton_wires_end_to_end`
- **What it proves:** a single stubbed iteration wires entry → `config` → `agent-run` →
  stubbed `LlmClient` (one tool_use then a final answer) → `tool-registry` → one tool → `transcript`
  → `reporter` → `RunOutcome` with exit 0, against a temp-dir fixture. Proves the integration backbone
  before any real capability. (REQ-004, REQ-005, REQ-014, REQ-NFR-002)

### Slice — Read + Search tools

- `test_REQ006_read_returns_bounded_range` — reading a fixture file returns its bounded content + line metadata.
- `test_REQ006_read_outside_root_allowed` — a read of a sibling-dir file outside the root succeeds (read-anywhere).
- `test_REQ007_list_entries_and_search_matches` — list returns typed entries; search returns `{path,line,text}` hits with `count`.
- `test_REQ007_search_path_escape` — an out-of-root search path is rejected `PATH_ESCAPE`.

### Slice — Write/Edit + Diff + Approval

- `test_REQ008_write_creates_file_with_diff` — a write produces a Diff and (on approval) the file on disk.
- `test_REQ012_confirm_each_is_default` — default mode prompts before the write; denial yields `APPROVAL_DENIED` and the loop continues.
- `test_REQ010_mutation_produces_unified_diff` — the mutation surfaces a unified diff before persistence (no silent write).
- `test_REQ021_write_traversal_rejected` — an out-of-root write target is rejected fail-closed before any write.

### Slice — Run-command + tests-as-signal

- `test_REQ009_runs_command_captures_exit_stdout_stderr` — a stubbed command returns captured exit/stdout/stderr.
- `test_REQ013_test_run_marks_isTestRun_completion_signal` — running the detected test command sets `isTestRun` and feeds pass/fail back as the completion signal.
- `test_REQ016_nonallowlisted_prompts` — a non-allowlisted command prompts; `test_REQ016_destructive_command_requires_confirmation` proves a destructive command is gated.
- `test_REQ013_nonzero_exit_is_result` — a failing test run is a success ToolResult carrying `exitCode != 0`.

### Slice — Apply-patch (atomic)

- `test_REQ023_applies_multifile_patch` — a clean multi-file patch applies all hunks with per-file diffs.
- `test_REQ023_patch_one_hunk_fails_atomic` — a patch with one failing hunk applies **zero** edits (atomic reject).
- `test_REQ023_patch_target_escape_rejected` — a patch target outside the root rejects the whole patch.

### Slice — Budget / Stop

- `test_REQ015_max_iterations_guard` / `test_REQ015_token_budget_guard` — the pre-turn guard stops cleanly at each ceiling with the right StopCondition.
- `test_REQ014_task_success_terminates` — task-success ends the run with exit 0.
- `test_REQNFR003_no_run_exceeds_iteration_or_token_ceiling` — no run starts a turn past either ceiling.

### Slice — Transcript + `--json` / Reporter

- `test_REQ022_transcript_records_iterations_calls_results` — the transcript reconstructs the run end-to-end.
- `test_REQ019_summary_reports_outcome_files_tests_iters_tokens` — the final summary reports the full outcome field set.
- `test_REQ024_json_summary_schema_stable_and_parseable` — `--json` emits a parseable, schema-stable RunSummary.
- `test_REQ018_apikey_never_serialized` — the API key appears in neither the transcript nor the `--json` output.

### Slice — Allowlist management

- `test_REQ025_allowlist_list_add_remove_persists` — `allowlist add/remove` mutates and persists the set.
- `test_REQ025_allowlist_ops_idempotent` — add-existing/remove-absent are no-ops.

### Slice — Closed-loop (headline success criterion)

- `test_closedloop_plan_edit_test_fail_selfcorrect_pass` — a scripted multi-iteration `LlmClient`
  stub drives: plan → edit a fixture file → run tests (stubbed fail) → read failure → corrective edit
  → run tests (stubbed pass) → final answer → exit 0, with every change in the transcript as a diff.
  Proves the Success Criteria "closed loop demonstrated". (REQ-004, REQ-008, REQ-010, REQ-013,
  REQ-014, REQ-019)

---

## Non-Functional Tests

> Each entry cites its REQ-NFR-ID. The safety/security negative tests and reliability tests below are
> the non-functional load-bearing set; the data-integrity ones are the green-or-block gate (§Test
> Philosophy). Names are anchored (`test_REQ<###>_*` / `test_REQNFR<###>_*`).

| REQ-NFR-ID | What is measured | Test name | Pass threshold |
|------------|-----------------|-----------|---------------|
| REQ-NFR-002 | Harness runs offline with both seams stubbed | `test_REQNFR002_harness_runs_offline_with_stubbed_seams` | Full loop → RunOutcome with no network call and no real subprocess |
| REQ-NFR-002 | Strict sequencing (no in-process race) | `test_REQNFR002_sequential_no_inprocess_race` | One ToolCall fully resolved before the next; single transcript writer |
| REQ-NFR-003 | No run exceeds iteration ceiling | `test_REQ015_max_iterations_guard` | Turn NOT started once `iterationsUsed >= maxIterations` |
| REQ-NFR-003 | No run exceeds token ceiling | `test_REQ015_token_budget_guard` | Turn NOT started once `tokensUsed >= tokenBudget` |
| REQ-NFR-003 | Runaway/injected loop is bounded | `test_REQNFR003_budget_pre_turn_guard_stops_runaway` | An infinite-tool-call stub stops in ≤ maxIterations turns |
| REQ-NFR-004 | Transient errors retried with backoff | `test_REQNFR004_transient_retry_backoff` | 429/5xx/timeout retried ≤5, exp backoff base 1000ms cap 30000ms + jitter |
| REQ-NFR-004 | Rate-limit honors Retry-After | `test_REQNFR004_rate_limit_retry_after` | Next delay floored by `Retry-After` header |
| REQ-NFR-004 | Retries exhausted → fatal | `test_REQNFR004_retries_exhausted_fatal` | After 5 attempts → `LLM_FATAL` → Failed (non-zero exit) |
| REQ-NFR-004 | Non-transient 4xx not retried | `test_REQNFR004_fatal_4xx_no_retry` | 401/403/400 → fatal on first attempt, no retry |
| REQ-NFR-004 | Expected tool failure → error result (no crash) | `test_REQNFR004_expected_error_normalized` | Tool error normalized to `status:"error"` ToolResult; loop continues |
| REQ-NFR-005 | Path-escape blocked (data integrity) | `test_REQ021_rejects_traversal_write`, `test_REQ021_rejects_symlink_escape` | Every out-of-root write/exec → `PATH_ESCAPE` fail-closed (zero side effect) |
| REQ-NFR-005 | API key never serialized | `test_REQ018_apikey_never_serialized` | Key string absent from transcript JSONL and `--json` stdout |
| REQ-NFR-005 | Non-allowlisted/chained command gated | `test_REQ016_chained_command_never_auto_runs` | Chained/redirected forms never auto-run; non-allowlisted prompts |
| REQ-NFR-005 | Edit approval gating | `test_REQ012_injection_novel_edit_requires_approval` | A novel (injection-driven) edit still requires confirmation in default mode |
| REQ-NFR-005 | Budget ceiling backstop (DoS) | `test_REQNFR003_budget_pre_turn_guard_stops_runaway` | (shared with REQ-NFR-003) runaway loop bounded |
| REQ-NFR-006 | Help + fail-fast usability | `test_REQNFR006_help_lists_all_flags`, `test_REQNFR006_missing_apikey_actionable_message` | `--help` exits 0 listing all flags; missing key → actionable stderr, non-zero exit |
| REQ-NFR-007 | Cross-platform path confinement | `test_REQNFR007_path_confinement_windows_and_posix` | Confinement holds for Windows (case-fold/backslash) and POSIX path semantics |
| REQ-NFR-008 | Reconstructable transcript | `test_REQNFR008_transcript_reconstructs_calls_results_decisions` | Each tool call I/O + each stop decision present and seq-ordered |

> **Performance/latency:** intentionally none — no latency/throughput SLO REQ exists; the only
> performance-shaped requirement (REQ-NFR-003) is a hard ceiling tested above, not a load test.

---

## Tooling

> Concrete tools per level. Vitest is the locked framework (Constraints / REQ-NFR-001). The two
> determinism enablers are the **stubbed DI seams** (`LlmClient`, `CommandRunner`) and **temp-dir
> fixture repos** for the filesystem-touching tests.

| Level | Tool | Run command |
|-------|------|-------------|
| Unit | Vitest | `npx vitest run` |
| Integration | Vitest (+ temp-dir fixtures via `fs.mkdtemp`) | `npx vitest run` |
| Contract | Vitest + JSON-Schema validation (e.g. `ajv`) of the 5 tool schemas + `--json`/`TranscriptEntry` shapes | `npx vitest run` |
| E2E / Acceptance | Vitest driving `cli`/`agent-run` with a scripted `LlmClient` stub + stubbed `CommandRunner` + temp-dir fixture repo | `npx vitest run` |
| Coverage (lines/branches) | Vitest coverage (`@vitest/coverage-v8`) | `npx vitest run --coverage` |
| REQ coverage gate | `th coverage check` (scans anchored test names) | `node "<plugin>/dist/cli.js" coverage check --cwd <root>` |
| Anchor scan | `th anchors scan --scan-tests` | `node "<plugin>/dist/cli.js" anchors scan --scan-tests --cwd <root>` |

**Stub pattern (the determinism backbone, REQ-NFR-002 / RULE-015):**

- `LlmClient` stub: implements `send(conversation, toolSchemas)` returning a **scripted, ordered
  queue** of canned responses — each either `{toolCalls:[…]}` (driving a specific tool with chosen
  arguments) or `{finalAnswer, stopReason:"end_turn"}`, with deterministic `usage` token counts.
  Error scripts (queued throws / 429 / 5xx / 401) drive the retry and fatal paths. No network.
- `CommandRunner` stub: implements `run(command, cwd, timeoutMs)` returning a **canned**
  `{exitCode, stdout, stderr, timedOut}` keyed by the command — e.g. the fixture's "test command"
  returns exit 1 then exit 0 across iterations to drive the closed-loop test. No real subprocess.
- **Fixtures:** each filesystem-touching test creates a temp-dir repo (`fs.mkdtemp`), seeds files,
  and (for symlink/traversal tests) constructs real symlinks/parent dirs so `path-sandbox` realpath
  resolution is exercised against the real filesystem; the temp dir is removed in teardown.

---

## Definition of Done

> Mechanical and non-negotiable. "Done" is a checklist a machine can evaluate (§11, §16). The
> project-level gate is authoritatively `th coverage check`.

**Task done:**
- Its anchored tests (`test_REQ<###>_*` for the REQ(s) the task implements) pass (`npx vitest run`).
- No regressions in earlier slices' tests.
- `th coverage check` does not report a new gap.

**Slice done:**
- All of the slice's per-slice acceptance tests (§Per-Slice Acceptance Tests) pass end-to-end against
  the stubbed seams + temp-dir fixture.
- `th coverage check` confirms every REQ-ID assigned to this slice maps to ≥1 passing anchored test.
- No regressions in earlier slices.
- The slice's data-integrity tests (if any: path-escape, budget, approval, api-key) are green.

**Project done:**
- Every MVP REQ-ID in the §REQ→Test Map has ≥1 passing anchored test, and **every** 08a abuse-case
  test (reconciled, above) and **all 42** 08b negative tests exist and pass.
- All thresholds in §Non-Functional Tests are met (retry/backoff bounds, ceiling enforcement,
  api-key-never-serialized, cross-platform confinement).
- `th coverage check` passes with **zero gaps** (`th anchors scan --scan-tests` finds every anchored
  name referenced here in the test files).
- Line coverage on the non-seam harness modules meets the adopted target **≥ 90% lines / ≥ 85%
  branches** (`npx vitest run --coverage`). *Adopted as a sensible default for this Tier-3,
  data-integrity harness; the `LlmClient` and `CommandRunner` seams themselves are excluded from the
  threshold since their bodies are thin SDK/shell wrappers exercised via stubs, not unit-covered. This
  percentage is a quality bar, not a separate human gate — noted, not gated.*
- Final verification report (`10-verification-report.md`) produced and human-approved.
