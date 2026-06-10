# SLICE-2 / TASK-004 — RepoContext builder

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-003
**Slice:** SLICE-2 — Repo context & the real agent loop over the stubbed model
**Depends on:** SLICE-1 / TASK-003 complete (needs the resolved `Config`/`WorkingRoot`)

---

## Goal

Implement the `repo-context` builder: assemble the initial understanding of the target repo — a
bounded directory listing, detected project type, the **detected test command** (e.g. from
`package.json` scripts, overridable via config), and key files — **without loading the whole repo
into the prompt** — and emit a `context-gathered` transcript entry carrying the detected metadata.

---

## REQ-IDs

- **REQ-003** — The agent builds initial context about the target repo (e.g., directory listing,
  detected project type / test command, key files) before or during planning, without requiring the
  full repo to be loaded into the prompt.

---

## Relevant Contracts / Interfaces

```
TranscriptEntry type "context-gathered" (IF-015 payload):
  { projectType: string|null, testCommand: string|null, fileCount: integer }   — ContextGathered

RepoContext provides the detected testCommand consumed later by RunCommand (REQ-013, SLICE-5) as the
completion signal. RepoContext is READ-ONLY — it uses the read path, never mutates.
```

---

## Relevant Design Notes

- **Bounded context (REQ-003):** the listing and key-file selection must be capped — do not stream
  the entire repo into the conversation; assert the bound (the test checks context is not the whole
  repo).
- Test-command detection is **overridable via config** (Assumptions); if config provides a test
  command, prefer it over detection.
- Reads only — uses the read path; never writes (no `path-sandbox.checkWrite` here).

---

## Acceptance Test(s)

- `test_REQ003_context_lists_and_detects_testcmd` — `repo-context` emits a `context-gathered` entry
  with detected `projectType`/`testCommand`/`fileCount` for a fixture repo.
- `test_REQ003_context_without_full_repo_in_prompt` — the assembled context is bounded (not the whole
  repo contents).

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The `context-gathered` payload matches IF-015; any newly-pinned field promoted to
      `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-003 still maps to a passing test).

---

## Out of Scope for This Task

- The loop that *uses* the context (SLICE-2 / TASK-005).
- Actually running the detected test command (SLICE-5 / TASK-012).
- Any file mutation or command execution.
