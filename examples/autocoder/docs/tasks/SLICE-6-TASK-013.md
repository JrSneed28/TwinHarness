# SLICE-6 / TASK-013 — apply_patch tool: parse + atomic apply/reject

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-023
**Slice:** SLICE-6 — Apply-patch (atomic multi-file)
**Depends on:** SLICE-4 / TASK-010 complete (reuses `diff-engine`, `path-sandbox`, `approval-gate`)

---

## Goal

Implement the `tool-applypatch` (`apply_patch`) tool on the existing mutation stack: parse a
unified-diff document (`diff-engine.parsePatch`), dry-run every hunk across every file
(`applyHunks`), validate every target via `path-sandbox.checkWrite`, gate via
`approval-gate.resolveEdit` — then **atomically** apply all hunks (per-file Diffs persisted) or, on
any failure, reject the **whole** patch with **zero** Edits and nothing written (RULE-013).

---

## REQ-IDs

- **REQ-023** — Tool: **apply-patch** — apply a unified-diff patch (one or more hunks across one or
  more files) to the working tree, confined to the write/exec root (REQ-021) and subject to the
  edit-approval policy (REQ-012); malformed or non-applying patches are rejected with an actionable
  error fed back to the model as a tool result. *(Atomic — no partial application.)*

---

## Relevant Contracts / Interfaces

```
IF-005 apply_patch — input: { patch: string (unified-diff, file headers + @@ markers, min 1;
  targets MUST resolve inside root) }
  output: { edits: [{targetPath, before:string|null, after:string, applied:boolean}],
            diffs: string[], filesChanged: integer, approval: "auto-approved"|"approved-by-user" }
  Preconditions: every target inside root AND all hunks across all files dry-run cleanly.
  Postconditions: ATOMIC — either all hunks apply and all Edits persist, or ZERO Edits and nothing
    written (RULE-013, INV-007). Diffs exist for every applied Edit (RULE-002).
  Errors: PATCH_MALFORMED (ERR-011, unparseable), PATCH_NOT_APPLICABLE (ERR-012, ≥1 hunk fails →
    whole patch rejected, zero Edits), PATH_ESCAPE (ERR-001, any target outside root),
    APPROVAL_DENIED (ERR-004), WRITE_FAILED (ERR-008, disk write failed mid-apply).

IF-013 DiffPatchEngine.parsePatch(patchText) → { files: { path, hunks: Hunk[] }[] }
                       applyHunks(file, hunks) → { applicable, result?, failedHunkIndex? }
```

---

## Relevant Design Notes

- **Atomicity is the headline invariant (RULE-013, INV-007):** dry-run ALL hunks across ALL files
  first; only if every one is applicable do you write any file. A single failing hunk or an
  out-of-root target → zero Edits, nothing written, `patch-rejected` entry.
- Reuses the SLICE-4 mutation stack (`diff-engine` generateDiff for per-file Diffs, `path-sandbox`
  checkWrite, `approval-gate` resolveEdit) — do not re-implement them.
- Re-applying an already-applied patch is rejected (`test_REQ023_reapply_patch_rejected`) — the
  context no longer matches.
- The dry-run must not drift internal state (`test_REQ023_dryrun_apply_no_internal_drift`).

---

## Acceptance Test(s)

- `test_REQ023_applies_multifile_patch` — a clean multi-file patch applies all hunks with per-file
  diffs.
- `test_REQ023_patch_malformed` — unparseable patch → `PATCH_MALFORMED`.
- `test_REQ023_patch_one_hunk_fails_atomic` — one failing hunk → zero Edits applied (atomic reject).
- `test_REQ023_patch_target_escape_rejected` — a target outside root → whole patch rejected
  (`PATH_ESCAPE`).
- `test_REQ023_reapply_patch_rejected` — re-applying an applied patch is rejected.
- `test_REQ023_multihunk_partial_atomic` — a multi-hunk patch with a partial failure applies zero.
- `test_REQ023_multifile_partial_atomic` — a multi-file patch with a partial failure applies zero.
- `test_REQ023_dryrun_apply_no_internal_drift` — the dry-run does not drift internal state.

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The tool matches IF-005 (+ IF-013 use); any newly-pinned detail promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-023 still maps to passing tests).

---

## Out of Scope for This Task

- write/edit whole-file/replace (SLICE-4 / TASK-010).
- run-command (SLICE-5).
- AST-aware / git-aware patch refinements (V1 — explicitly out of MVP scope).
