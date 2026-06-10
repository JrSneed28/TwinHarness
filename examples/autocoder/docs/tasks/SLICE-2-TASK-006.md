# SLICE-2 / TASK-006 — LlmClient retry/backoff + errors-as-results

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-NFR-004
**Slice:** SLICE-2 — Repo context & the real agent loop over the stubbed model
**Depends on:** SLICE-2 / TASK-005 complete (retry wraps the seam the loop calls)

---

## Goal

Implement bounded-backoff retry and fatal classification inside the `llm-client` seam, and the
errors-as-results discipline at the boundary: transient API failures (429/5xx/timeout/socket reset)
are retried with exponential backoff + full jitter honoring `Retry-After`; non-transient 4xx and
retry exhaustion are **fatal** (`LLM_FATAL`, mapped by `agent-run` to `unrecoverable-error`); expected
*tool* failures are normalized to `status:"error"` ToolResults so the loop continues rather than
crashing.

---

## REQ-IDs

- **REQ-NFR-004** — *Reliability:* transient failures (LLM API errors/timeouts/rate limits) are
  retried with bounded backoff; a failing tool call (e.g., command non-zero exit, file not found) is
  reported back to the model as a result rather than crashing the process.

---

## Relevant Contracts / Interfaces

```
IF-006 LlmClient error responses:
  (retried internally) — transient: HTTP 429/500/502/503/529, network timeout, socket reset →
      retry ≤5, exponential backoff base 1000ms cap 30000ms + full jitter, honor `Retry-After`;
      emit `llm-retry` TranscriptEntry { attempt, errorClass, delayMs }.
  LLM_FATAL (Channel B, fatal) — HTTP 401/403 (bad/expired key), HTTP 400 (malformed), any
      non-transient 4xx, OR retries exhausted → throws; agent-run maps to unrecoverable-error
      StopCondition → Failed (ERR-013).
  Postcondition: performs at most 5 SDK calls (1 + 4 retries).

ERR-013 LLM_FATAL: run ends → unrecoverable-error → Failed (non-zero exit).
RULE-008 (errors-as-results): an expected tool failure becomes a status:"error" ToolResult,
  never a thrown crash.
```

---

## Relevant Design Notes

- The retry policy lives **behind the `llm-client` seam** (ARCH-RISK-001/004 confinement) — the loop
  sees only a resolved response or a thrown fatal.
- Backoff: base 1000ms, cap 30000ms, full jitter; `Retry-After` (when present) **floors** the next
  delay.
- Distinguish transient (retry) from non-transient (immediate fatal, no retry) precisely — the tests
  assert 401/403/400 are *not* retried.

---

## Acceptance Test(s)

- `test_REQNFR004_transient_retry_backoff` — 429/5xx/timeout retried ≤5 with exp backoff (base
  1000ms, cap 30000ms) + jitter.
- `test_REQNFR004_rate_limit_retry_after` — next delay is floored by the `Retry-After` header.
- `test_REQNFR004_retries_exhausted_fatal` — after 5 attempts → `LLM_FATAL` → Failed (non-zero exit).
- `test_REQNFR004_fatal_4xx_no_retry` — 401/403/400 → fatal on first attempt, no retry.
- `test_REQNFR004_network_timeout_retry` — a network timeout is retried.
- `test_REQNFR004_api_outage_retry_then_fail` — sustained outage retries then fails cleanly.
- `test_REQNFR004_expected_error_normalized` — an expected tool failure → `status:"error"` ToolResult;
  the loop continues.
- `test_REQNFR004_fatal_class_terminates` — a fatal class terminates the run into Failed.

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] Retry/fatal behavior matches IF-006 / ERR-013; any newly-pinned detail promoted to
      `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-NFR-004 still maps to passing tests).

---

## Out of Scope for This Task

- Budget/token accounting and the pre-turn guard (SLICE-7) — this task only surfaces `usage`.
- The real SDK transport body (a thin wrapper exercised via the stub; not unit-covered per the test
  strategy's seam-exclusion note).
- Tool-specific error codes (defined in each tool's slice).
