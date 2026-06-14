# SLICE-N / TASK-MMM — <title: one short action phrase>

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus. Keep this file small by construction: it embeds
> only what this single task needs so long sessions do not forget earlier decisions. Everything
> else is a link.

> **Brownfield / adoption task (optional — `project_mode: "brownfield"`).** If this task attaches
> to existing code, anchor it to the adoption seam from `docs/00-existing-codebase-analysis.md` and
> write **characterization tests around the seam** — prove the integration point end-to-end before
> changing anything. Existing module code is **off-limits** except for narrow *conformance fixes*
> (changes that make existing code conform to a requirement-level REQ); list any such fix explicitly
> in *Out of Scope* with its REQ-ID, and treat a contradiction with a requirement-level REQ as
> BLOCKING drift, not an in-task edit. Prefer reusing existing code that already satisfies a REQ.

**REQ-IDs:** REQ-<###>, REQ-<###>
**Slice:** SLICE-N — <slice name>
**Depends on:** SLICE-<N-1> / TASK-<MMM-1> complete *(or "none")*

---

## Goal

<One sentence describing the single, demonstrable behavior this task delivers. Must be
independently verifiable — a human or automated test can confirm it without the next task also
being complete. Starts with a verb: "Implement…", "Wire…", "Expose…". No "set up infrastructure"
— that is horizontal.>

---

## REQ-IDs

<List only the REQ-IDs this task directly advances. For each, copy the one-line requirement text
so the Builder does not have to fetch `01-requirements.md` for context.>

- **REQ-<###>** — <one-line requirement text copied verbatim from 01-requirements.md>
- **REQ-<###>** — <…>

---

## Relevant Contracts / Interfaces

<Paste only the interface signatures, schema fields, or API shapes this task must honour. Copy
from `07-contracts.md` — do not paraphrase. Omit contracts this task does not touch. If a
contract does not yet exist and this task defines it, write it here first; it will be promoted
to `07-contracts.md` as a drift entry (§10).>

```
<language>
// Example: the function or type this task implements or calls
function <name>(<params>): <return type>

// Or a data schema:
interface <Name> {
  <field>: <type>  // <constraint if non-obvious>
}
```

---

## Relevant Design Notes

<Copy only the design decisions from `06-technical-design.md` or `04-architecture.md` that
directly constrain this task's implementation. One or two bullets maximum — if more are needed,
the task scope is too large. Omit anything the task does not touch.>

- <Design decision or invariant that constrains how this task is implemented.>
- <Algorithm, ordering rule, or edge case the implementation must respect.>

---

## Acceptance Test(s)

<The anchored test names this task must make pass. These names come from `08-test-strategy.md`
and follow the convention `test_REQ<###>_<capability_slug>` (§11). The Builder writes these
tests with the implementation — not after. A task is done when these tests pass, not when the
Builder asserts completion.>

- `test_REQ<###>_<capability_slug>` — <one sentence: what this test asserts>
- `test_REQ<###>_<capability_slug>` — <…>

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it has been promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-<###> still maps to a passing test).

---

## Out of Scope for This Task

<Explicitly name what this task does NOT do, to prevent scope creep and keep the task small.
List the adjacent concerns the Builder might be tempted to tackle — they belong to other tasks.>

- <Adjacent capability handled in SLICE-N / TASK-MMM+1.>
- <Error-handling path handled in SLICE-N / TASK-MMM+2.>
- <Anything touching `<other-component>` — owned by a different slice.>
