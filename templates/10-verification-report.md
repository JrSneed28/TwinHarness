# Verification Report — <project name>

> **Stage 11 — Final Verification** (spec §17). Produced at the end of an engaged run; lightweight in Tier 1,
> full in Tier 3. Verified by the Critic in **`final-verification` mode** (coherence only — consistency against
> upstream artifacts) and then by the **human** (correctness — the only parties who can confirm the
> implementation is right, not merely consistent; §11). Human sign-off is a hard gate before this artifact
> is considered closed.

## Summary

<3–6 sentences: overall verdict, whether coherence and correctness are each passing or failing, and any
open items that block closure. This block is the default handoff currency — readers check THIS first (§9).>

- **Coherence (Critic):** <PASS / FAIL / CONDITIONAL — internal consistency of all artifacts>
- **Correctness (tests + human):** <PASS / FAIL / CONDITIONAL — anchored tests green; human has signed off>
- **Open blocking items:** <count, or "none">
- **Deferred / residual risk items:** <count, or "none">

---

## Coherence Verification (Critic)

> **COHERENCE ONLY — this section establishes internal CONSISTENCY, not correctness (§11).**
> A fully green coherence result can still describe the wrong product. Correctness is established
> exclusively in the next section.

<Summarize the Critic's `final-verification` findings. The Critic ran in a fresh context without the
author's rationalizations (§7) and checked whether all artifacts are internally consistent with each other:
requirements ↔ scope ↔ domain model ↔ architecture ↔ contracts ↔ test strategy ↔ slice plan ↔ implementation.
Cite each grounded finding — "does not support REQ-004," "Slice 3 component label mismatches architecture §3,"
etc. Ungrounded stylistic observations are excluded.>

**Coherence findings:**

- <Grounded defect or "No defects found.">
- <…>

**Resolution:**

<State whether defects were resolved before sign-off, acknowledged as deferred risk, or are still open and
blocking. "Zero defects" is a valid, celebrated terminal state — there is no minimum-issue quota (§7).>

**Coherence verdict:** <PASS / FAIL / CONDITIONAL>

---

## Correctness Verification (Tests + Human)

> **CORRECTNESS — this is the ONLY section where correctness is established (§11).**
> The Critic's coherence pass above cannot certify the design is right, only consistent. Correctness
> requires anchored tests passing against reality and the human's explicit sign-off.

### Anchored Test Results

<List each suite of anchored acceptance tests (those whose names embed REQ-IDs, e.g.,
`test_REQ001_offline_sync`) and their pass/fail status. These are the mechanical contract (§11). An agent
asserting a slice is done is not evidence; passing tests are.>

| Test suite / anchored test name | REQ-IDs covered | Status |
|---------------------------------|-----------------|--------|
| `test_REQ<###>_<capability_slug>` | REQ-<###> | PASS / FAIL |
| `test_REQ<###>_<capability_slug>` | REQ-<###> | PASS / FAIL |
| … | … | … |

### Coverage Check

<Record the output of `th coverage check`: every MVP REQ-ID maps to ≥1 slice and ≥1 anchored passing test;
no pure-horizontal slice present. Paste the summary line or "th coverage check: 0 gaps, all REQ-IDs covered."
A gap here is a correctness blocker.>

```
th coverage check: <paste result>
```

### Tester Evidence

<The live-QA Tester is REQUIRED at final verification (not optional). A green anchored-test suite can pass
on mocks; this section records that the USER-VISIBLE PRODUCTION PATH was exercised against the real (or
official sandbox) boundary. Without it, the production-reality gate (`th gate production-reality`) blocks.>

- **Driver / runner used:** <e.g. playwright, curl, cli-e2e — the live runner that exercised the real path>
- **Provider tier confirmed:** <real | sandbox — the actual boundary the live run hit>
- **Raw output / screenshots:** <path or link to captured request/response, logs, or screenshots>
- **Tester record attached:** <`th gate production-reality` reports tester_record present — yes/no>

**Production-reality gate:** <paste `th gate production-reality` result — must be clear: no unretired
user-visible simulation (`th sim list`), verify green, Tester record attached, no unledgered simulation
patterns in `dist/`.>

```
th gate production-reality: <paste result>
```

### Human Sign-off

<The human confirms that the passing tests verify the right behavior — i.e., the implementation does what was
intended, not merely what was specified. Record the human's sign-off here (name / date / explicit statement).
Until this field is filled in, correctness is NOT established, regardless of test results.>

- **Signed off by:** <human name>
- **Date:** <YYYY-MM-DD>
- **Statement:** <"I confirm the implementation satisfies the intended requirements." or equivalent>

**Correctness verdict:** <PASS / FAIL / CONDITIONAL — requires both tests green AND human sign-off>

---

## Requirements Satisfaction

<Map every MVP REQ-ID to its satisfaction status and the concrete evidence. "Evidence" must be a specific
anchored test name, slice definition, or human observation — not an assertion. Any REQ-ID lacking evidence
is an open correctness gap.>

| REQ-ID | Requirement (short label) | Satisfied? | Evidence (test / slice / observation) |
|--------|--------------------------|------------|---------------------------------------|
| REQ-001 | <short label> | Yes / No / Partial | `test_REQ001_<slug>` — PASS |
| REQ-002 | <short label> | Yes / No / Partial | SLICE-2 acceptance tests — PASS |
| REQ-NFR-001 | <short label> | Yes / No / Partial | `test_REQNFR001_<slug>` — PASS |
| … | … | … | … |

**Gap summary:** <"All REQ-IDs satisfied." or list of unsatisfied IDs and their current status.>

---

## Traceability View (rendered on demand)

> **This view is GENERATED on demand — it is NOT maintained by hand and is NOT stored as a persistent
> artifact (§17).** A hand-maintained traceability matrix rots because it is updated manually; this view
> stays current because it is rendered from durable anchors (REQ-IDs in requirements, design section refs,
> contract section refs, slice/task IDs, anchored test names, and source file paths) that move with the
> code (§11, §17).
>
> **To render:** run `th trace render` at any time. The command scans the anchor chain and emits the
> current view. No commit needed; no matrix to maintain.

**Example rendered view shape (§17):**

| Requirement | Design ref | Contract | Slice / Task | Test | Code |
|-------------|------------|----------|--------------|------|------|
| REQ-001 | tech-design §2 | API §3 | SLICE-2 / TASK-014 | test_REQ001_* | src/sync.ts |
| REQ-<###> | <design ref> | <contract ref> | <SLICE-N / TASK-MMM> | test_REQ<###>_* | <src/path.ts> |
| … | … | … | … | … | … |

<If a rendered snapshot is desired for archival purposes, paste the output of `th trace render` below.
Otherwise leave this section as the example shape above.>

---

## Open Items / Residual Risk

<List anything that was not fully verified, any blocking drift still open, any correctness gap, or any item
deliberately deferred. Each entry must state whether it is blocking (prevents closure) or non-blocking
(acknowledged risk, deferred to a future cycle). "None" is a valid, correct answer.>

| # | Item | Blocking? | Owner | Target resolution |
|---|------|-----------|-------|-------------------|
| 1 | <description> | Yes / No | <agent or human> | <version / date / "deferred"> |
| … | … | … | … | … |

**Blocking open items:** <count, or "none — this report is closeable">

---

## Verdict

> **Coherence and correctness are EXPLICITLY SEPARATED below (§11). A passing coherence verdict does NOT
> imply correctness. A fully green traceability view can still describe the wrong product (§11, §17).**

| Dimension | Verdict | Basis |
|-----------|---------|-------|
| **Coherence** (Critic — consistency) | PASS / FAIL | Critic `final-verification` findings above |
| **Correctness** (tests + human) | PASS / FAIL | Anchored tests green + human sign-off above |

**Overall closure decision:**

<State whether this run is closed (both verdicts PASS, no blocking open items) or held open (reason and
owner). The run is closed only when coherence passes AND correctness passes AND the human has signed off
AND no blocking open items remain.>
