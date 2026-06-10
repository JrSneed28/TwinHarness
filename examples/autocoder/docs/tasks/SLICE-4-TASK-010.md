# SLICE-4 / TASK-010 — write_edit tool: confinement + diff + approval + persist

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-008, REQ-011, REQ-021
**Slice:** SLICE-4 — Write/edit files: diff + confinement + edit-approval
**Depends on:** SLICE-4 / TASK-009 complete (uses `diff-engine` + `approval-gate`)

---

## Goal

Implement the `tool-writeedit` (`write_edit`) tool: create a file (whole-file `write`) or modify one
(targeted `replace`), flowing every mutation through `path-sandbox.checkWrite` (reject out-of-root
fail-closed) → `diff-engine.generateDiff` → `approval-gate.resolveEdit` → on approval persist to disk
so subsequent reads/commands see the new state; map the replace-mode and IO error sets to
`status:"error"` ToolResults. This completes the **write half** of REQ-021's confinement.

---

## REQ-IDs

- **REQ-008** — Tool: **write/edit file** — create a new file or modify an existing file within the
  working root via whole-file write and/or targeted string-replace edit.
- **REQ-011** — Edits are applied to the working tree according to the configured approval mode;
  applied edits are persisted to disk so subsequent tool calls and command runs see the new state.
- **REQ-021** — File mutations are confined to the resolved working root; any write target that
  escapes the root (traversal, absolute path, or symlink) is rejected before the operation.

---

## Relevant Contracts / Interfaces

```
IF-003 write_edit — input:
  { targetPath (string, MUST resolve inside root), mode: "write"|"replace",
    content (required for write), search (required for replace, min len 1),
    replacement (required for replace), replaceAll? (default false; >1 match rejected when false) }
  output: { edit: {targetPath, before:string|null, after:string, applied:boolean}, diff:string,
            approval: "auto-approved"|"approved-by-user" }
  Postconditions: on success the file is written and Edit.applied=true; a Diff exists (no silent
    writes — RULE-002, INV-003); parent dirs within root created as needed.

  Errors: PATH_ESCAPE (ERR-001, out-of-root, fail-closed), SEARCH_NOT_FOUND (ERR-002, replace 0
    matches), SEARCH_AMBIGUOUS (ERR-003, >1 match & !replaceAll), APPROVAL_DENIED (ERR-004),
    WRITE_FAILED (ERR-008, approval+containment passed but disk write failed).

IF-010 PathSandbox.checkWrite(path) → { allowed, canonicalPath, reason?:{code:"PATH_ESCAPE"} }
```

---

## Relevant Design Notes

- Mutation order is fixed (RULE-001/002/004): `checkWrite` → `generateDiff` → `resolveEdit` → persist.
  Skipping any step is an invariant breach.
- `replace` with 0 matches → `SEARCH_NOT_FOUND` (no Edit); >1 match without `replaceAll` →
  `SEARCH_AMBIGUOUS` (count reported, no Edit).
- Persistence must be **content-idempotent** (re-writing identical content is a no-op-equivalent) and
  must survive crash (applied edits persist — `test_REQ011_applied_edits_persist_after_crash`).
- Document the LWW + TOCTOU residuals (the sandbox checks then writes; the window is recorded/tested,
  not eliminated — `test_REQ021_concurrent_external_mutation_lww`, `..._toctou_symlink_window_documented`).

---

## Acceptance Test(s)

- `test_REQ008_write_creates_file_with_diff` — a write produces a Diff and (on approval) the file on
  disk.
- `test_REQ008_replace_edits_existing` — replace edits an existing file.
- `test_REQ008_search_not_found` — replace with 0 matches → `SEARCH_NOT_FOUND`, no Edit.
- `test_REQ008_search_ambiguous` — >1 match without `replaceAll` → `SEARCH_AMBIGUOUS`, no Edit.
- `test_REQ011_approved_edit_persisted_to_disk` — an approved Edit is written so subsequent reads see
  new state.
- `test_REQ011_write_io_failure` — IO failure → `WRITE_FAILED`, Edit Rejected not Applied.
- `test_REQ011_rewrite_identical_content_idempotent` — identical re-write is content-idempotent.
- `test_REQ011_applied_edits_persist_after_crash` — applied edits persist after a crash.
- `test_REQ021_write_traversal_rejected` — out-of-root traversal target rejected fail-closed.
- `test_REQ021_write_absolute_outside_rejected` — absolute out-of-root target rejected.
- `test_REQ021_write_symlink_escape_rejected` — symlink-escape target rejected.
- `test_REQ021_unresolvable_path_rejected` — unresolvable path rejected fail-closed.
- `test_REQ021_concurrent_external_mutation_lww` — concurrent external mutation handled as LWW
  (documented residual).
- `test_REQ021_toctou_symlink_window_documented` — TOCTOU symlink window documented & tested.
- `test_REQ021_rejects_traversal_write` — (ABU-003 reconciled) traversal write rejected.
- `test_REQ021_rejects_symlink_escape` — (ABU-004 reconciled) symlink escape rejected.

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The tool matches IF-003 (+ IF-010 use); any newly-pinned detail promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress; REQ-021 write-side now maps Full to this slice.

---

## Out of Scope for This Task

- Command execution and exec-cwd confinement (SLICE-5 / TASK-012).
- Apply-patch atomicity (SLICE-6 / TASK-013).
- Reporter rendering of the diff to stdout (SLICE-8) — emit the `edit-proposed`/`edit-applied`
  transcript entries here; streaming is SLICE-8.
