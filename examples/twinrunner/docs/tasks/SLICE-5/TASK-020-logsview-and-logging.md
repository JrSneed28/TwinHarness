# SLICE-5 / TASK-020 — LogsView + structured logging + CPU-key redaction + log file (FS-005)

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-031, REQ-NFR-007
**Slice:** SLICE-5 — TUI shell & cross-cutting behavior
**Depends on:** SLICE-5 / TASK-019 complete (and D for ActionLog content)

---

## Goal

Complete the structured logging surface: the append-only `ActionLog` with mandatory CPU-key
redaction, an optional JSON-Lines log file mirror (FS-005) that degrades gracefully when unwritable
and tolerates a torn last line, and the scrollable `LogsView` screen with severity filter and export.

---

## REQ-IDs

- **REQ-031** — Live, scrollable log/console view that streams progress and events and persists
  session history.
- **REQ-NFR-007** — Clean structured logging & observability: structured, timestamped records
  viewable in the TUI and writable to a log file; sufficient to reconstruct what was done.

---

## Relevant Contracts / Interfaces

**IF-017 — `log::ActionLog::append`:**

```
append(level: LogLevel, operation: String, message: String, payload: Option<Map<String,String>>, clock: &dyn Clock)
  -> LogEntry { timestamp, level, operation, message (post-redaction), payload (post-redaction) }
// Append-only, immutable, arrival order (RULE-011). UI-thread only (INV-006). File-mirror IO error is non-fatal.
```

**Redaction contract (INV-006):** before storing/mirroring, replace any substring of **exactly 32
hex chars** (`[0-9a-fA-F]{32}`, word-boundary-anchored so a 64-hex SHA-256 is NOT redacted) with
`REDACTED_CPU_KEY`; redact payload fields keyed `cpu_key` by name regardless of shape. The raw key is
never persisted.

**FS-005 — Log file (JSON Lines):** one `LogEntry` object per line (not an array), each with
`schema_version: 1`. Readers tolerate a trailing incomplete line (skip if not valid JSON).

**IF-015 reducer arm:** `Message::ScrollLog(Down/Up)` adjusts `model.log_view.offset`.

---

## Relevant Design Notes — wireframe + redaction (embed; do not invent)

**`LogsView`** (anchors REQ-027, REQ-031, REQ-NFR-007): `ActionLog — Session <ts>  Filter: [All ▼]`;
an `ActionLogTable` with columns `Timestamp · Lvl · Operation · Message`, severity glyph+label
(`INFO`/`WARN`/`ERR`); `[E] Export log to file  [F] Filter by severity  [Esc] Back`. Scroll with
`↑↓/PgUp/PgDn`. Empty: `[·] No log entries yet.` Error: `[ERR] Log export failed: … choose a
different path [P] or cancel [Esc]` (inline; table stays visible).

**Redaction details** (`06-technical-design` §CPU-key log redaction): regex pass over `message` and
every `payload` value; the **exactly-32** boundary means SHA-256 (64 hex) and CRC (shorter) are not
clipped; a key embedded in a longer error string is still caught. Defense-in-depth: redact
`cpu_key`-keyed payload values by name.

**Graceful degradation (REQ-NFR-007):** an unwritable log file path → degrade to the in-memory
`ActionLog` + a Warning entry; never crash.

---

## Acceptance Test(s)

- `test_REQ031_log_view_scrolls_in_model` — append 20 entries; `ScrollLog(Down)` × 10 →
  `model.log_view.offset = 10`. *(unit)*
- `test_REQ_NFR007_log_redacts_cpu_key_not_checksum` — a 32-hex word-boundary string in a message →
  `REDACTED_CPU_KEY`; a 64-hex SHA-256 string passes through unredacted. *(unit)*
- `test_REQ_NFR007_log_file_unwritable_degrades_in_memory` — an unwritable log file path → degrade to
  in-memory `ActionLog` + Warning; app does not crash. *(integration)*
- `test_REQ_NFR007_log_file_tolerates_torn_last_line` — a JSON-Lines file with a torn trailing line →
  last line skipped on read; prior entries intact. *(integration)*

---

## Definition of Done

- [ ] All acceptance tests pass; LogsView renders the session ActionLog with filter + export.
- [ ] No raw CPU-key material can survive in any log message or payload (redaction proven by test).
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it matches IF-017 / FS-005 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-031, REQ-NFR-007 still map to passing tests).

---

## Out of Scope for This Task

- The widget layer / Dashboard / palette — SLICE-5 / TASK-019.
- ConfigSettings (which configures `log_file_path`/`log_verbosity`) — SLICE-5 / TASK-021.
- The ActionLog *entries* produced by flash/troubleshoot — SLICE-4 / TASK-018 (this task renders and
  persists them and enforces redaction).
