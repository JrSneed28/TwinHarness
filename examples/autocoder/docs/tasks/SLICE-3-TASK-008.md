# SLICE-3 / TASK-008 — read_file + list_search tools through the loop

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-006, REQ-007
**Slice:** SLICE-3 — Read & search the repo through the loop (sandboxed)
**Depends on:** SLICE-3 / TASK-007 complete (read/search call the sandbox)

---

## Goal

Implement the `tool-read` (`read_file`) and `tool-search` (`list_search`) tools so the agent can, via
the live loop, read a file's full or bounded-range contents (read-anywhere — succeeding outside the
root) and list/search within the root; map the error sets to `status:"error"` ToolResults.

---

## REQ-IDs

- **REQ-006** — Tool: **read file** — return the contents (or a bounded range) of a file within the
  working root *(read-anywhere: may also read outside the root)*.
- **REQ-007** — Tool: **list / search files** — list directory entries and search file contents
  (glob and/or text/regex search) within the working root.

---

## Relevant Contracts / Interfaces

```
IF-001 read_file — input: { path (string, may resolve OUTSIDE root), startLine? (int≥1), lineCount? (int≥1) }
  output: { content: string, truncated: boolean, totalLines: integer }
  ERR-006 READ_FAILED — file not found / is-a-directory / permission denied → error ToolResult.
  No containment check (reads never confined — INV-002).

IF-002 list_search — input: { mode: "list"|"search", path? (default "." , must resolve inside root),
  glob?, query (required for search, min len 1), isRegex? (default false), maxResults? (1..2000, default 200) }
  output: { mode, entries[{name,type:"file"|"dir"}], matches[{path,line,text}], count, truncated }
  ERR-007 BAD_PATTERN — isRegex && query not a valid regex → error ToolResult.
  ERR-001 PATH_ESCAPE — path resolves outside root (search/list is root-scoped) → error ToolResult.
  Empty result set is SUCCESS with count:0 (not an error).
```

---

## Relevant Design Notes

- `read_file` uses `path-sandbox.checkRead` (always allowed) — it is the **only effector permitted
  outside the root** (RULE-003); content read from outside can never be written back outside.
- `list_search` uses `path-sandbox` to keep listing/search **root-scoped** — an out-of-root `path` is
  `PATH_ESCAPE`.
- Both are read-only — no `approval-gate`, no writes.
- Apply a default line cap (e.g. 2000) for `read_file` and set `truncated`/`totalLines` so the model
  can request the next range.

---

## Acceptance Test(s)

- `test_REQ006_read_returns_bounded_range` — `read_file` returns content + `truncated`/`totalLines`
  for a bounded range.
- `test_REQ006_read_outside_root_allowed` — reading a sibling-dir file outside the root succeeds
  (read-anywhere).
- `test_REQ006_read_failed` — not-found / is-a-directory / permission denied → `READ_FAILED` result.
- `test_REQ007_list_entries_and_search_matches` — list returns typed entries; search returns
  `{path,line,text}` hits with `count`/`truncated`.
- `test_REQ007_bad_regex_pattern` — invalid regex (`isRegex:true`) → `BAD_PATTERN`.
- `test_REQ007_search_path_escape` — an out-of-root search path → `PATH_ESCAPE` (root-scoped).

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] Both tools match IF-001 / IF-002 (snake_case wire names, exact fields); any newly-pinned detail
      promoted to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-006/007 still map to passing tests).

---

## Out of Scope for This Task

- Write/edit, run-command, apply-patch tools (SLICE-4/5/6).
- The write/exec PATH_ESCAPE assertions (SLICE-4/5) — this task only exercises read-anywhere +
  search root-scoping.
- Approval gating (SLICE-4) — reads/search need no gate.
