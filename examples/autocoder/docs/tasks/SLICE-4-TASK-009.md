# SLICE-4 / TASK-009 — DiffPatchEngine (generateDiff) + ApprovalGate (resolveEdit)

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-010, REQ-012
**Slice:** SLICE-4 — Write/edit files: diff + confinement + edit-approval
**Depends on:** SLICE-3 / TASK-007 complete (shares `path-sandbox`); the live loop from SLICE-2

---

## Goal

Implement `diff-engine.generateDiff` (a pure unified-diff generator: before → after, file-headed,
terminal-displayable) and `approval-gate.resolveEdit` (resolve an Edit against the edit
`ApprovalPolicy` into an `ApprovalDecision`), so that no Edit can reach disk without a Diff (RULE-002)
and every Edit is gated by the confirm-each-by-default policy (RULE-004).

---

## REQ-IDs

- **REQ-010** — Every file-mutating action produces a unified diff (before → after) that is shown to
  the user; no silent writes.
- **REQ-012** — The CLI supports an edit-approval mode controlling whether edits auto-apply or require
  user confirmation (default: confirm-each, overridable by a `--yes`/`--auto` flag).

---

## Relevant Contracts / Interfaces

```
IF-013 DiffPatchEngine.generateDiff(before, after, path):
  before: string|null [required] (null = new file); after: string [required] (empty = deletion);
  path: string [required] → returns unified diff text (file headers + @@ hunk markers).
  Postcondition: every Edit is representable as a Diff (RULE-002, INV-003). Pure deterministic.

IF-009 ApprovalGate.resolveEdit(edit, policy):
  edit: Edit { targetPath, before, after, diff }  (Diff already generated, RULE-002)
  policy: ApprovalPolicy { editMode: "confirm-each" | "auto" }
  → ApprovalDecision: "auto-approved" | "approved-by-user" | "denied" | "user-abort"
  Postconditions: auto-approved/approved-by-user permit; denied → APPROVAL_DENIED error ToolResult
    (ERR-004); user-abort → user-abort StopCondition (classified Stopped).
  Emits approval-requested / approval-decided TranscriptEntries; may prompt on stdin.

ERR-004 APPROVAL_DENIED (Channel A): policy/user denied → error ToolResult; model proposes a
  different action; loop continues.
```

---

## Relevant Design Notes

- `confirm-each` is the **default** edit mode; `--yes`/`--auto` sets `editMode:"auto"` (auto-approve
  without prompting).
- The Diff must exist **before** `resolveEdit` is called (RULE-002 ordering); an Edit reaching Applied
  without a Diff is an invariant breach (rejected/fatal — `test_REQ010_applied_without_diff_rejected`).
- `user-abort` is a clean Stop (not a Failed) — distinguish denial (continue loop) from abort (stop).

---

## Acceptance Test(s)

- `test_REQ010_mutation_produces_unified_diff` — every Edit carries a unified Diff (before→after)
  emitted as `edit-proposed`.
- `test_REQ010_applied_without_diff_rejected` — an Edit reaching Applied without a Diff is an
  invariant breach (rejected/fatal).
- `test_REQ012_confirm_each_is_default` — default `confirm-each` prompts before each write.
- `test_REQ012_auto_flag_applies_without_prompt` — `--yes` auto-applies without prompting.
- `test_REQ012_all_denied_loop_continues` — denial → `APPROVAL_DENIED` result and the loop continues.
- `test_REQ012_user_abort_stops_clean` — user-abort → `Stopped` (clean, not Failed).
- `test_REQ012_injection_novel_edit_requires_approval` — a novel (injection-driven) edit still
  requires confirmation in default mode (abuse-case ABU-007 reconciled).

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] `generateDiff` / `resolveEdit` match IF-013 / IF-009; any newly-pinned detail promoted to
      `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-010/012 still map to passing tests).

---

## Out of Scope for This Task

- The `write_edit` tool body and disk persistence (SLICE-4 / TASK-010).
- Command approval (`resolveCommand`) and the allowlist (SLICE-5 / TASK-011).
- Patch parse/apply (SLICE-6) — only `generateDiff` here, not `parsePatch`/`applyHunks`.
