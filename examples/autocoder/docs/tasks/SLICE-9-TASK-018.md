# SLICE-9 / TASK-018 — Allowlist-management subcommand (list/add/remove) + persistence

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant artifact
> summaries — not the full corpus.

**REQ-IDs:** REQ-025
**Slice:** SLICE-9 — Allowlist-management UX (inspect / add / remove)
**Depends on:** SLICE-5 / TASK-011 (the `allowlist` component) and SLICE-1 / TASK-003 (`config`
persistence)

---

## Goal

Implement the `autocoder allowlist <list|add|remove> [pattern]` subcommand: inspect, add, and remove
entries in the command-approval allowlist **without** starting an agent loop, persisting changes to
the config file; add-existing and remove-absent are idempotent no-ops; a persistence failure exits
non-zero rather than silently claiming success.

---

## REQ-IDs

- **REQ-025** — The CLI provides allowlist-management commands/flags to **inspect, add, and remove**
  entries in the command-approval allowlist (REQ-016), giving the user explicit control over the
  highest-risk surface; changes persist to the config (REQ-018).

---

## Relevant Contracts / Interfaces

```
IF-014 (subcommand): autocoder allowlist <list|add|remove> [pattern]  — no agent loop is started.

Allowlist Manager: inspect/add/remove operations that persist to config.
  - default entries = detected test/build command + safe read-only commands.
  - add/remove is idempotent on set membership and persists to the config file (RULE-014).

TranscriptEntry "allowlist-changed" payload: { op: "add"|"remove", pattern: string }.

AllowlistEntry: { pattern: string [required] — command token-sequence prefix; min len 1 }.
Config persistence: changes write back to the config file (REQ-018 persistence half).
```

---

## Relevant Design Notes

- **No agent loop** in allowlist mode (Architecture §Secondary flow): CLI → Allowlist Manager →
  Config Resolver persists → Reporter confirms.
- Idempotent on **set membership**: add-existing and remove-absent are no-ops
  (`test_REQ025_allowlist_ops_idempotent`).
- A persistence failure must surface as a **non-zero exit** — never a silent "saved"
  (`test_REQ025_allowlist_persist_failure`).
- Reuse the `reporter` for the confirmation output (do not add a second output path).

---

## Acceptance Test(s)

- `test_REQ025_allowlist_list_add_remove_persists` — `allowlist list/add/remove` inspects/mutates the
  set and persists to config.
- `test_REQ025_allowlist_ops_idempotent` — add-existing / remove-absent are no-ops.
- `test_REQ025_allowlist_persist_failure` — a persistence failure → non-zero exit (not silently
  "saved").

---

## Definition of Done

- [ ] All acceptance tests above pass and checks are green.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] The subcommand + persistence match IF-014 / IF-017 / RULE-014; any newly-pinned detail promoted
      to `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-025 still maps to passing tests).

---

## Out of Scope for This Task

- Allowlist *matching* during a run (SLICE-5 / TASK-011) — this task only manages the set.
- Running the agent loop (allowlist mode starts no loop).
- The config resolution body (SLICE-1 / TASK-003) — only the persistence write here.
