# Failure Modes & Edge-Case Design — <project name>

> **Stage F — Failure Modes & Edge-Case Design** (spec §15.F). Tier 3 / reliability-critical.
> GRADUATES from the folded Architecture §Failure-Modes section when the project is
> reliability-critical or has data-loss / data-integrity exposure. Streams; escalates to a
> human gate where a failure-handling choice is product- or risk-meaningful (data-loss
> tradeoffs, blast-radius decisions — §8).

## Summary

<3–6 sentences: which components carry the highest failure risk, what the system's overall
failure posture is (fail-closed vs. fail-open, retry vs. abort), and which failure modes have
explicit negative tests. This block is the default handoff currency — downstream stages read
THIS, not the whole document (§9).>

- **Highest-risk component:** <one phrase>
- **Default failure posture:** <fail-closed / fail-open / configurable — one phrase>
- **Idempotency scope:** <which operations are idempotent and which are not>
- **Negative-test count:** <N negative tests anchored in §Negative-Tests Map>

---

## Failure Catalog (per component/flow)

> **Anti-boilerplate rule:** each failure mode in this document MUST be tied to a specific
> component or data flow in THIS system, using canonical component labels from
> `04-architecture.md`. Generic entries — "handle errors gracefully," "validate all inputs,"
> "retry on failure" — with no anchor to a real component or flow are discarded. A failure
> mode entry that cannot complete the sentence "...in `<component-label>`" or "...on flow
> DF-<###>" does not belong here. Each failure mode anchors to a negative test in
> §Negative-Tests Map.

<Walk each component and cross-component boundary. For each failure scenario: state the
failure, the expected system behavior (fail-closed/open, retry policy, compensation),
and the negative test that verifies it. Use the component labels from `04-architecture.md`.>

### `<component-label-a>`

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-001 | <specific failure in this component> | <fail-closed / retry N times with backoff / return error X> | `test_REQ<###>_<failure_slug>` |
| … | … | … | … |

### `<component-label-b>`

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-00N | <…> | <…> | `test_REQ<###>_<failure_slug>` |
| … | … | … | … |

### `<boundary: component-a → component-b>`

| Failure ID | Failure scenario | Expected behavior | Negative test anchor |
|------------|-----------------|-------------------|---------------------|
| FAIL-00N | <specific failure at this boundary> | <…> | `test_REQ<###>_<failure_slug>` |
| … | … | … | … |

---

## Invalid Input

<For each component or entry point that accepts external input: enumerate the invalid input
classes (wrong type, out-of-range value, missing required field, oversized payload, malformed
encoding), the component that validates them (canonical label), and the expected rejection
behavior. Do not list input classes that no component actually receives. Each entry anchors
to a negative test.>

| Component | Invalid input class | Expected behavior | Negative test anchor |
|-----------|--------------------|--------------------|---------------------|
| `<component-label>` | <specific invalid class> | <reject with error X / truncate / sanitize> | `test_REQ<###>_<invalid_slug>` |
| … | … | … | … |

---

## Duplicates/Idempotency

<For each operation that can be retried or replayed — command submission, event publication,
API call, state write — state whether it is idempotent, how idempotency is enforced (e.g.,
deduplication key, upsert semantics, idempotency token), and what happens if a duplicate
arrives. If an operation is explicitly non-idempotent, state the guard (lock, sequence
number, one-shot flag) that prevents double-execution. Each non-trivial case anchors to
a negative test.>

| Operation | Component | Idempotent? | Enforcement mechanism | Negative test anchor |
|-----------|-----------|------------|----------------------|---------------------|
| <operation name> | `<component-label>` | Yes / No | <mechanism> | `test_REQ<###>_<idempotency_slug>` |
| … | … | … | … | … |

---

## Partial Failure

<Enumerate the multi-step operations or distributed writes in this system where some steps
can succeed while others fail. For each: name the operation, the failure point, and the
recovery strategy (rollback, compensating transaction, retry from checkpoint, manual
intervention). State which invariants must hold even under partial failure — these become
contract-level assertions (§7). Each partial-failure scenario anchors to a negative test.>

| Operation | Failure point | Recovery strategy | Invariants preserved | Negative test anchor |
|-----------|--------------|-------------------|---------------------|---------------------|
| <operation> | <step that can fail> | <rollback / compensate / retry / alert+manual> | <invariant> | `test_REQ<###>_<partial_slug>` |
| … | … | … | … | … |

---

## Dependency Outage

<For each external or internal dependency (database, external API, message broker, file
system, downstream service): state the outage behavior — does the system fail-closed (reject
new requests), fail-open (serve degraded/cached), queue and retry, or circuit-break?
State the timeout, retry budget, and backoff policy where applicable. Each outage mode
anchors to a negative test.>

| Dependency | Component that depends on it | Outage behavior | Timeout / retry policy | Negative test anchor |
|------------|-----------------------------|-----------------|-----------------------|---------------------|
| <dependency name> | `<component-label>` | <fail-closed / degrade / queue+retry / circuit-break> | <timeout Nms; retry M times; exponential backoff> | `test_REQ<###>_<outage_slug>` |
| … | … | … | … | … |

---

## Crash/Restart Recovery

<For each component that holds in-flight state or has side effects in progress: define the
recovery invariant on restart. What state must be durable before the operation is considered
committed? What must be rolled back or re-driven if the process crashes mid-operation?
State the write-ahead / journal / checkpoint strategy. Each recovery scenario anchors to
a negative test.>

| Component | In-flight state | Durability guarantee | Recovery action on restart | Negative test anchor |
|-----------|----------------|---------------------|---------------------------|---------------------|
| `<component-label>` | <what state is in-flight> | <WAL / checkpoint / none — explain> | <replay / rollback / re-enqueue> | `test_REQ<###>_<crash_slug>` |
| … | … | … | … | … |

---

## Race Conditions

<Enumerate the concurrent access patterns in this system: shared mutable state, parallel
slice builds touching the same component, concurrent API calls, competing writers to the
same artifact or file. For each: state the race, the guard (lock, CAS, serialization
point, optimistic concurrency control), and what happens if the guard is absent.
Each race condition anchors to a negative test.>

| Race scenario | Components involved | Guard mechanism | Failure mode if guard absent | Negative test anchor |
|---------------|--------------------|-----------------|-----------------------------|---------------------|
| <specific race> | `<component-a>`, `<component-b>` | <mutex / CAS / serialization point> | <data corruption / lost update / duplicate> | `test_REQ<###>_<race_slug>` |
| … | … | … | … | … |

---

## Unexpected States

<Enumerate the system states that should be impossible but must be handled defensively:
state machine violations, schema mismatches between stored and expected format, version
skew between components, corrupted artifacts, missing required files. For each: state the
detection mechanism and the recovery action (halt+alert, auto-repair, fallback).
Each unexpected-state scenario anchors to a negative test.>

| Unexpected state | Detected by | Detection point (`<component-label>`) | Recovery action | Negative test anchor |
|-----------------|-------------|---------------------------------------|-----------------|---------------------|
| <specific impossible/unexpected state> | <assertion / schema validation / checksum> | `<component-label>` | <halt / auto-repair / fallback / alert> | `test_REQ<###>_<state_slug>` |
| … | … | … | … | … |

---

## Negative-Tests Map

<Consolidated map of every negative test defined in this document. These tests must also
appear in `08-test-strategy.md` §REQ→Test Map and §Per-Slice Acceptance Tests. The test
names follow the `test_REQ<###>_<slug>` convention so `th coverage check` can scan for
them. Any failure mode without a row here is unverified — the Builder has no mechanical
signal that its error handling is correct.>

| Test name | Failure mode (FAIL-ID) | Component / flow | REQ-ID |
|-----------|----------------------|-----------------|--------|
| `test_REQ<###>_<failure_slug>` | FAIL-<###> | `<component-label>` | REQ-<###> |
| `test_REQ<###>_<invalid_slug>` | FAIL-<###> | `<component-label>` | REQ-<###> |
| `test_REQ<###>_<idempotency_slug>` | FAIL-<###> | `<component-label>` | REQ-<###> |
| `test_REQ<###>_<partial_slug>` | FAIL-<###> | `<component-label>` | REQ-<###> |
| `test_REQ<###>_<outage_slug>` | FAIL-<###> | `<component-label>` | REQ-<###> |
| `test_REQ<###>_<crash_slug>` | FAIL-<###> | `<component-label>` | REQ-<###> |
| `test_REQ<###>_<race_slug>` | FAIL-<###> | `<component-label>` | REQ-<###> |
| `test_REQ<###>_<state_slug>` | FAIL-<###> | `<component-label>` | REQ-<###> |
| … | … | … | … |
