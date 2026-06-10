# ADR-002 — Transcript persistence = append-only JSONL event log

> **Stage 5 — Architecture Decision Record** (spec §15.5). One file per decision. Links to the
> REQ-IDs and components it serves.

**Decision summary:** The run Transcript is persisted as an **append-only JSONL event log** (one JSON
event per line) rather than a single structured JSON document, because the domain is an ordered,
append-only audit trail that must survive a mid-run crash and feed the V1 resume feature.

---

## Title / ID

**ADR-002** — Transcript persistence = append-only JSONL event log

---

## Status

accepted

*Date accepted:* 2026-06-09
*Supersedes:* —
*Superseded by:* —

*Basis:* human-gated irreversible decision (ARCH-RISK-002, confirmed 2026-06-09 — the human deferred
the explicit gate and adopted the architect's recommended option).

---

## Context

The Transcript is the system's durable audit trail and observability substrate: it must record every
domain event (iteration, tool call, tool result, approval decision, diff, stop condition) in enough
detail and order to reconstruct exactly what the agent did and why it stopped (REQ-022, REQ-NFR-008,
RULE-010). It is a **data-integrity blast-radius** artifact — losing or corrupting it defeats the
project's auditability non-negotiable.

Two persistence formats were on the table:

1. **Append-only JSONL** — append one self-contained JSON event per line as events occur.
2. **A single structured JSON document** — hold the run as one JSON object and (re)write it to disk.

The on-disk format is the **data-integrity contract** for the audit trail and the substrate the
**V1 resumable single-task continuation** feature will read back. Changing it later breaks existing
transcripts and any tooling/feature that consumes them — which is what makes this costly to reverse.

**Relevant REQ-IDs:** REQ-022, REQ-NFR-008
**Components affected:** `transcript`, `agent-run` (event source), `reporter` (live render is
separate)

---

## Decision

> **Chosen:** append-only JSONL event log, with a typed and versioned `TranscriptEntry` schema.

Each domain event is serialized as one self-contained JSON object and appended as a line as it
occurs. This optimizes for **crash-durability and ordering fidelity**: every event is durable the
instant it is written, with no rewrite of a whole document, so a crash or budget-kill mid-run leaves
a complete, valid transcript up to the last flushed event. It maps naturally to the streamed-events
model and to the ordered audit trail the domain requires (RULE-010). The tradeoff consciously
accepted is that **JSONL is not a single valid JSON document** — a consumer must read it line-by-line
rather than `JSON.parse` the whole file. To keep future evolution safe, the entry schema is **typed
and versioned** so fields can be added additively without a format change.

*Human gate triggered:* yes — confirmed by user on 2026-06-09 (recommended option adopted; explicit
gate deferred).

---

## Consequences

### Positive

- **`transcript` survives a mid-run crash** — each event is durable on write, so a crash, budget kill
  (REQ-015), or `unrecoverable-error` stop still leaves a complete ordered audit up to the last
  flushed line (REQ-NFR-008, RULE-010).
- **Natural fit for the streamed-events model** — events are appended as `agent-run` produces them; no
  read-modify-rewrite of a growing document on every event.
- **Directly consumable by the V1 resume feature** — an ordered, replayable event log is the right
  substrate for resumable single-task continuation (extends REQ-022).

### Negative

- **Not a single parseable JSON object** — any consumer (the resume feature, external tooling, a
  test harness) must parse JSONL line-by-line and tolerate a possibly-truncated final line after a
  hard crash; this is extra handling versus `JSON.parse` on one document.
- **No in-place edit/compaction** — append-only means superseding or correcting an event requires
  writing a new event, not editing the old; the log only grows for the run's duration.
- **Costly to reverse** — the format is the data-integrity contract for the audit trail; changing it
  later breaks existing transcripts and the V1 resume feature that reads them.

### Future obligations

- The `TranscriptEntry` schema must be defined as **typed and versioned** in `07-contracts.md`
  (Data Schemas / Events) so additive evolution does not force a format change.
- `08b-failure-edge-cases.md` must cover Transcript write/flush failure and the truncated-final-line
  recovery path (data-integrity).
- The V1 resume feature must read the JSONL log tolerantly (skip/handle a partial trailing line).

---

## Alternatives Considered

### Option A — Append-only JSONL event log *(chosen)*

One JSON event per line, appended as it occurs. Chosen for crash-durability, ordering fidelity, and
fit with the streamed-events and V1-resume models — see Decision.

### Option B — Single structured JSON document

- **What it is:** keep the whole run as one JSON object (e.g. `{ events: [...] }`) and write/rewrite
  it to disk, finalizing on completion.
- **Why rejected:** poor crash-durability — a crash before the final write can lose or corrupt the
  entire audit trail, violating the data-integrity guarantee behind RULE-010 / REQ-NFR-008; and
  rewriting a growing document on each event is wasteful. It trades the most important property
  (durable, ordered audit that survives a mid-run kill) for the convenience of single-file parsing.
- **Would be right if:** runs were short and guaranteed to complete atomically, or the transcript
  were a best-effort convenience rather than a data-integrity contract — neither holds for this
  Tier-3 project.

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-022 | drives this decision (durable run transcript) |
| Requirement | REQ-NFR-008 | drives this decision (reconstructable observability) |
| Component | `transcript` | owns this decision (the format lives here) |
| Component | `agent-run` | affected (emits the events that become entries) |
| Component | `reporter` | related (live human stream is separate from the durable log) |
| Downstream artifact | `06-technical-design.md` | must reflect the append/flush behavior in the `transcript` design |
| Downstream artifact | `07-contracts.md` | the typed/versioned `TranscriptEntry` schema follows from this decision |
| Downstream artifact | `08b-failure-edge-cases.md` | must cover transcript write/flush failure + truncated-line recovery |
