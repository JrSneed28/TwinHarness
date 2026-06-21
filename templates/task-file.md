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

## External Dependencies

<Every external boundary this task touches — provider, auth, persistence, network, or any
real-world service. For EACH, state the production-reality classification and (when simulated)
who/what retires it. A missing real-boundary detail here is an **escalation trigger**, NOT silent
derived drift: the Builder must escalate rather than invent a fake/no-op adapter (see `builder.md`).
A user-visible production path that depends on an unresolved simulation BLOCKS completion — record
the simulation in the ledger (`th sim add --classification <…> --user-visible`) and retire it
(`th sim retire <SIM-NNN>`) before final verification. Classifications: **Real** (live provider) ·
**Sandbox** (real provider, official test env) · **Emulated** (approved local substitute + named
real-provider plan) · **Mocked** (test-only) · **Stubbed** / **Hardcoded** (labeled prototype /
Slice-0 only). "None — no external boundary" is a valid, explicit answer.>

| Dependency | Provider / boundary | Auth | Persistence | Classification | Retire by (slice/owner) |
|------------|---------------------|------|-------------|----------------|-------------------------|
| <name> | <service / API> | <real / sandbox / none> | <real DB / fixture / none> | Real / Sandbox / Emulated / Mocked / Stubbed / Hardcoded | <SLICE-N / owner, or "n/a (Real)"> |

- **None — no external boundary** *(use this line and delete the table when the task has no external dependency).*

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
- [ ] Every simulation on a user-visible production path is ledgered (`th sim list`) and retired before completion; `th gate production-reality` is clear (no unretired user-visible simulation).

---

## Out of Scope for This Task

<Explicitly name what this task does NOT do, to prevent scope creep and keep the task small.
List the adjacent concerns the Builder might be tempted to tackle — they belong to other tasks.>

- <Adjacent capability handled in SLICE-N / TASK-MMM+1.>
- <Error-handling path handled in SLICE-N / TASK-MMM+2.>
- <Anything touching `<other-component>` — owned by a different slice.>
