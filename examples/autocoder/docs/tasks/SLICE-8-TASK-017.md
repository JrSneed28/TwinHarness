# SLICE-8 / TASK-017 — Reporter: human stream + final summary + `--json` + secret redaction

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-017, REQ-019, REQ-024, REQ-018 (api-key-never-serialized)
**Slice:** SLICE-8 — Durable transcript, human stream & `--json` summary
**Depends on:** SLICE-8 / TASK-016 complete (renders events the transcript records)

---

## Goal

Implement the `reporter`: stream human-readable progress during the run (plan/step, each tool call +
outcome, diffs, test results) and, on completion, emit the final `RunSummary` both human-readably and
— with `--json` — as a schema-stable parseable JSON object; ensure the API key appears in **neither**
the transcript nor the `--json` output (secret redaction).

---

## REQ-IDs

- **REQ-017** — The CLI streams human-readable progress to the terminal: the current plan/step, each
  tool call and its outcome, diffs, and test results.
- **REQ-019** — On completion the CLI emits a final summary: outcome, files changed (with diffs or a
  diff summary), tests run and their result, iterations used, and approximate token/cost usage.
- **REQ-024** — The CLI supports a `--json` machine-readable output mode: the final run summary and
  outcome are emitted as a structured JSON object on stdout (schema-stable, parseable by CI).
- **REQ-018** — *(api-key-never-serialized slice)* the API key (env `ANTHROPIC_API_KEY`) is never
  written to the transcript, `--json`, or disk.

---

## Relevant Contracts / Interfaces

```
IF-016 RunSummary / --json (the CI-stable contract — same data the human form renders):
  { status: "succeeded"|"stopped"|"failed",
    stopCondition: "task-success"|"max-iterations-reached"|"budget-exhausted"|"model-give-up"|
                   "unrecoverable-error"|"user-abort",
    exitCode: integer,                 // 0 IFF status=="succeeded" (INV-006)
    filesChanged: [{ targetPath: string, diff: string }],  // may be empty
    testsResult: { ran: boolean, passed: integer, failed: integer },  // ran=false ⇒ no test command
    iterationsUsed: integer, tokensUsed: integer (may carry estimated:boolean),
    runId: string, schemaVersion: string }
  Stability promise: append-only stable for CI — fields never removed/retyped within a schemaVersion;
    CI may rely on status/exitCode/stopCondition permanently. Current schemaVersion = "1.0".

apiKey [SENSITIVE] — never serialized into transcript or RunSummary.
```

---

## Relevant Design Notes

- The reporter renders the **same `RunOutcome` two ways** (human + `--json`) — do not compute the
  summary twice.
- `exitCode == 0` iff `status == "succeeded"` (INV-006) — reuse the classification from SLICE-7,
  don't recompute.
- **Secret redaction:** the `apiKey` must never appear in stdout (`--json` or human) or in the
  transcript (`test_REQ018_apikey_never_serialized` greps the JSONL + `--json` stdout for the key
  string).
- The human stream is ordered (plan/step → tool calls + outcomes → diffs → test results) — the test
  asserts ordering, not specific colors/width.

---

## Acceptance Test(s)

- `test_REQ017_streams_plan_toolcalls_diffs_results` — streams plan/step, each tool call + outcome,
  diffs, and test results to stdout in order.
- `test_REQ019_summary_reports_outcome_files_tests_iters_tokens` — the final summary reports status,
  filesChanged (+diffs), testsResult, iterationsUsed, tokensUsed, runId.
- `test_REQ024_json_summary_schema_stable_and_parseable` — `--json` emits a parseable, schema-stable
  `RunSummary` with the required fields + `schemaVersion`.
- `test_REQ024_json_exitcode_status_stopcondition_present` — `--json` carries stable
  `status`/`exitCode`/`stopCondition`.
- `test_REQ018_apikey_never_serialized` — the API key appears in neither the transcript JSONL nor the
  `--json` stdout (ABU-009 reconciled).

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The `--json` object matches IF-016 (`schemaVersion:"1.0"`, INV-006); any newly-pinned field
      promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-017/019/024 and the REQ-018 redaction still map to
      passing tests).

---

## Out of Scope for This Task

- The durable transcript writer itself (SLICE-8 / TASK-016).
- Config resolution / precedence body of REQ-018 (SLICE-1 / TASK-003) — only the redaction assertion
  here.
- Allowlist confirmation output (SLICE-9 / TASK-018 reuses the reporter).
