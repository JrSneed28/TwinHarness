# SLICE-8 / TASK-016 — TranscriptWriter: append-only JSONL, durable, fatal-on-fail

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-022, REQ-NFR-008
**Slice:** SLICE-8 — Durable transcript, human stream & `--json` summary
**Depends on:** SLICE-7 complete (the `RunOutcome`/stop entries the transcript records)

---

## Goal

Implement the `transcript` writer as a durable **append-only JSONL** event log: `open(runId)`,
`append(entry)` (assign monotonic `seq`, write + fsync-class flush per entry before returning),
`flush()` at termination; entries are append-only, strictly `seq`-ordered, never rewritten or
deleted; a write/flush failure is **fatal** (`TRANSCRIPT_WRITE_FAILED` → unrecoverable-error). The
transcript must be sufficient to **reconstruct** the run.

---

## REQ-IDs

- **REQ-022** — The agent records a run transcript / log of iterations, tool calls, tool results, and
  decisions, available to the user for inspection and debugging after the run.
- **REQ-NFR-008** — *Observability:* the run transcript is sufficient to reconstruct what the agent
  did and why, including each tool call's inputs and outputs and each stop decision.

---

## Relevant Contracts / Interfaces

```
IF-012 TranscriptWriter:
  open(runId): opens the per-run transcript file in append mode at run start
  append(entry: TranscriptEntry): seq assigned monotonically by the writer; durable (write +
    fsync-class flush per entry before returning)
  flush(): final flush at Terminating
  Postconditions: each entry durable on disk before append returns (crash loses at most the in-flight
    entry — ADR-002); append-only, strictly seq-ordered; never rewritten/deleted (INV-009).
  ERR-014 TRANSCRIPT_WRITE_FAILED (Channel B, FATAL): write/flush failure → unrecoverable-error →
    Failed (audit must not be silently lost, RULE-010).

IF-015 TranscriptEntry — VERSIONED discriminated union. Common envelope:
  { schemaVersion: string (e.g. "1.0"), seq: integer (monotonic, gap-free per run), ts: string
    (ISO-8601 UTC), runId: string, type: enum(18 types), payload: object }
  18 types: run-started, context-gathered, iteration-started, tool-called, approval-requested,
    approval-decided, edit-proposed, edit-applied, edit-rejected, patch-rejected, command-run,
    tests-run, tool-result, budget-exceeded, llm-retry, run-stopped, run-completed, allowlist-changed.
  Additive evolution only; seq gap-free + strictly increasing; append-only (INV-009).
  apiKey is NEVER serialized into any entry [SENSITIVE].
```

---

## Relevant Design Notes

- **Append-only JSONL** (ADR-002): one JSON event per line; survives a crash mid-run (each event
  durable as written; crash loses at most the in-flight line — `test_REQ022_crash_partial_last_line_tolerated`).
- **Single writer** per run (`test_REQ022_single_writer_transcript`) — no concurrent writers (the
  loop is sequential, REQ-NFR-002).
- A write/flush failure is **fatal**, not best-effort — audit integrity is the data-integrity contract
  (`test_REQ022_transcript_write_fatal`).
- The envelope's `seq`/`ts`/`runId`/`type`/`payload` must be sufficient to reconstruct each tool
  call's inputs/outputs and each stop decision (REQ-NFR-008).

---

## Acceptance Test(s)

- `test_REQ022_transcript_records_iterations_calls_results` — append-only seq-ordered JSONL of every
  event reconstructs the run.
- `test_REQ022_transcript_write_fatal` — a write/flush failure is fatal (`TRANSCRIPT_WRITE_FAILED` →
  Failed) (ABU-010 reconciled).
- `test_REQ022_crash_partial_last_line_tolerated` — a crash loses at most the in-flight line.
- `test_REQ022_single_writer_transcript` — a single writer per run.
- `test_REQ022_transcript_durable_per_entry` — each entry is durable before `append` returns.
- `test_REQ022_read_outside_root_recorded_in_transcript` — a read outside the root is recorded
  (read-exposure audit, ABU-002 reconciled).
- `test_REQNFR008_transcript_reconstructs_calls_results_decisions` — each tool call I/O + each stop
  decision present and seq-ordered.

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The writer + entry schema match IF-012 / IF-015 (`schemaVersion:"1.0"`, all 18 types); any
      newly-pinned detail promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-022 / REQ-NFR-008 still map to passing tests).

---

## Out of Scope for This Task

- The human stream + `--json` summary + secret redaction assertion (SLICE-8 / TASK-017).
- Log rotation / retention / query UI (SCOPE-RISK-002 — explicitly out of MVP scope).
