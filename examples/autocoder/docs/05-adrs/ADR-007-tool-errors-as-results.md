# ADR-007 — Tool failures returned to the model as results, not raised as crashes

> **Stage 5 — Architecture Decision Record** (spec §15.5). One file per decision. Links to the
> REQ-IDs and components it serves.

**Decision summary:** A failing tool call (command non-zero exit, file not found, malformed patch,
denied approval, path-escape rejection) is normalized into an **error `ToolResult` fed back to the
model**, never raised as an exception that crashes the process — so the agent can observe the failure
and self-correct.

---

## Title / ID

**ADR-007** — Tool failures are returned to the model as error results, not raised as crashes

---

## Status

accepted

*Date accepted:* 2026-06-09
*Supersedes:* —
*Superseded by:* —

*Basis:* REQ-NFR-004 (reliability) — a failing tool call is reported back to the model as a result
rather than crashing the process; RULE-008 (errors-as-results). Streamed; recorded Accepted.

---

## Context

The agent's whole value is a **closed, self-correcting loop**: it acts, observes the concrete result,
and iterates (Problem Statement, REQ-004/005). Tool calls fail routinely and legitimately — a command
exits non-zero, a file is missing, a patch does not apply (REQ-023), the user denies an edit/command
(REQ-012/016), or `path-sandbox` rejects an escaping write/exec (REQ-021). The harness must decide
what happens on such a failure: propagate it as an exception that aborts the run, or capture it and
hand it back to the model as observable feedback.

This is a foundational error-handling stance because it determines how `tool-registry`, every tool,
and `agent-run` treat failure, and it underpins the loop's ability to converge despite setbacks. It
is costly to reverse because the entire tool-dispatch and loop-feedback path is built around
normalized results.

**Relevant REQ-IDs:** REQ-NFR-004, REQ-005, REQ-023, REQ-012, REQ-016, REQ-021, REQ-014
**Components affected:** `tool-registry`, all five tools, `agent-run`, `approval-gate`, `path-sandbox`

---

## Decision

> **Chosen:** every tool executor outcome — success or failure — is normalized by `tool-registry`
> into a `ToolResult`; failures become **error `ToolResult`s fed back into the conversation**, not
> exceptions. The process does not crash on an expected tool failure.

This optimizes for **self-correction and reliability**: a non-zero test run, a not-found file, a
non-applying patch, a denied approval, or a rejected path-escape all return as structured feedback
the model can read and respond to (fix the patch, choose another file, try a different command),
which is exactly the closed-loop behavior that makes the agent useful (REQ-NFR-004, RULE-008). The
tradeoff consciously accepted is that **genuine failures can be masked as "just another result"** —
the loop may keep iterating on an unrecoverable condition until a `StopCondition` (budget /
max-iterations / model-give-up) finally ends it (REQ-014), rather than failing fast; and the harness
must still distinguish truly fatal/unexpected errors from expected tool failures.

*Human gate triggered:* no — streamed (reliability requirement REQ-NFR-004 / RULE-008).

---

## Consequences

### Positive

- **The loop self-corrects** — `agent-run` feeds error results back, so the model can fix a failing
  patch (REQ-023), retry a different file, or adjust a command instead of the run dying on the first
  setback (REQ-NFR-004, RULE-008).
- **Uniform handling across the tool surface** — `tool-registry` normalizes every executor outcome
  into a `ToolResult`, so the loop has one shape to handle and `06-technical-design.md` has one
  error-feedback contract (REQ-005).
- **Safety rejections become teachable feedback** — a `path-sandbox` escape rejection (REQ-021) or an
  `approval-gate` denial (REQ-012/016) returns as an error result, so denial steers the model rather
  than aborting the run.

### Negative

- **Risk of masking unrecoverable failures** — treating every failure as "another result" can let
  `agent-run` thrash on a condition it can never resolve, burning iterations/budget until a
  `StopCondition` ends it (REQ-014, REQ-015) rather than failing fast.
- **Fatal-vs-expected distinction must be drawn carefully** — truly unexpected errors (e.g.
  transcript write failure, an internal invariant breach) must NOT be swallowed as tool results; the
  harness still needs an `unrecoverable-error` stop path, so the boundary between "feed back" and
  "abort" is a real design obligation.
- **Diagnostic noise** — repeated error results in the conversation and `transcript` can obscure the
  root cause when reviewing a failed run.

### Future obligations

- `08b-failure-edge-cases.md` must define, per tool/boundary, which failures are returned as error
  `ToolResult`s versus which escalate to an `unrecoverable-error` stop, and must include the
  negative tests that prove each path.
- `07-contracts.md` must specify the `ToolResult` error shape (success/error discriminator, error
  code/message) as the loop-feedback contract.

---

## Alternatives Considered

### Option A — Errors returned as `ToolResult`s *(chosen)*

Normalize all outcomes to results; feed failures back to the model. Chosen to realize the
self-correcting loop and REQ-NFR-004 — see Decision.

### Option B — Raise exceptions on tool failure (fail-fast)

- **What it is:** a failing tool call throws; the run aborts (or unwinds) on the first failure.
- **Why rejected:** defeats the closed-loop value — a single non-zero test run or a not-found file
  would kill the run, when the entire point is for the agent to *observe* such results and iterate
  (Problem Statement, REQ-NFR-004); it contradicts RULE-008.
- **Would be right if:** the agent were a one-shot executor with no iteration, where any failure
  should immediately surface to the human — not the autonomous, self-correcting model here.

### Option C — Hybrid: feed back "soft" failures, raise on "hard" failures, configurable

- **What it is:** classify failures and let some abort while others feed back, with a config knob for
  strictness.
- **Why rejected for the MVP:** the *default* stance must still be errors-as-results for the loop to
  work (REQ-NFR-004); a configurable hard/soft split adds policy surface and decision complexity not
  warranted for the MVP. Note: the genuinely fatal `unrecoverable-error` stop path (REQ-014) is
  retained — this option's *configurable* variant is what is deferred, not the fatal-error escape
  itself.
- **Would be right if:** users needed fine-grained, per-failure-class abort policies — a plausible
  future refinement, not an MVP need.

---

## Linked REQs / Components

| Type | ID / Name | Relationship |
|---|---|---|
| Requirement | REQ-NFR-004 | drives this decision (failing tool call reported as a result, not a crash) |
| Requirement | REQ-005 | served (tool results fed back into the loop) |
| Requirement | REQ-023 | served (non-applying patch returns an actionable error result) |
| Requirement | REQ-012 / REQ-016 | served (approval denial becomes an error result) |
| Requirement | REQ-021 | served (path-escape rejection returns an error result) |
| Requirement | REQ-014 | bounds this decision (`unrecoverable-error` stop still terminates the loop) |
| Component | `tool-registry` | owns this decision (normalizes outcomes to `ToolResult`) |
| Component | all five tools | affected (return error results, do not throw on expected failure) |
| Component | `agent-run` | affected (feeds error results back; owns the fatal-vs-expected boundary) |
| Component | `approval-gate` / `path-sandbox` | affected (denials/rejections surface as error results) |
| Downstream artifact | `08b-failure-edge-cases.md` | must map each failure to feed-back vs. abort + negative tests |
| Downstream artifact | `07-contracts.md` | the `ToolResult` error shape follows from this decision |
