# SLICE-2 / TASK-009 — KeyRecord CRUD + search + bind-with-mismatch-warning

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-010, REQ-012, REQ-013
**Slice:** SLICE-2 — CPU-key library management
**Depends on:** SLICE-2 / TASK-008 complete · SLICE-1 / TASK-006 complete (needs `ConsoleInfo`)

---

## Goal

Implement `KeyLibrary::add`/`edit`/`delete`/`search` and `keys::bind`, plus the matching
`model::update` reducer arms: add/edit/delete a record (durably saved on each mutation, with a
confirmation-dialog state on delete), search by console identifier, and bind a record to the active
dump's `ConsoleInfo` — surfacing a mismatch warning (never silently binding) on serial/type
conflict.

---

## REQ-IDs

- **REQ-010** — Add, edit, view, delete CPU-key records through TUI forms/dialogs, with confirmation
  on destructive actions.
- **REQ-012** — Look up / search the library by console identifier (serial, type, label) and filter.
- **REQ-013** — Bind a CPU key to a loaded dump and warn on mismatch.

---

## Relevant Contracts / Interfaces

**IF-006 — `add` / `edit` / `delete` / `search`:**

```
add(cpu_key: CpuKey, console_serial?, console_type?, label?, notes?) -> KeyRecord  // cpu_key must have passed parse
edit(id, cpu_key?, console_serial?, console_type?, label?, notes?) -> ()           // id must exist
delete(id) -> ()                                                                    // id must exist
search(SearchQuery { serial?, console_type?, label? }) -> Vec<KeyRecord>            // substring serial/label; exact type; created_at desc

Errors:
  Error InvalidKeyFormat (add/edit) — cpu_key fails format (RULE-004) → no mutation
  Error RecordNotFound, target: id (edit/delete) — no such record (ERR-011) → no mutation
```

Postconditions (add/edit/delete): in-memory library mutated **and** `Command::WriteFile` triggered
so the change is durable before control returns. Emits `KeyRecordAdded`/`Updated`/`Deleted`.

**IF-007 — `keys::bind`:**

```
bind(record: &mut KeyRecord, console_info: &ConsoleInfo) -> BindOutcome
BindOutcome::Bound                                            // no identity conflict
BindOutcome::BoundWithMismatchWarning { reasons: Vec<MismatchReason> }  // SerialMismatch | ConsoleTypeMismatch
// BoundWithMismatchWarning is a SUCCESSFUL return, not an error. The UI MUST surface the warning
// before binding is considered accepted (RULE-005). Binding is session-scoped; does not auto-persist.
```

**IF-015 reducer arms:** `KeyAdd(...)`, `KeyEdit(id, ...)`, `KeyDelete(id)`, `KeySearch(query)`,
`KeyBind(id)`. A `KeyDelete` sets a confirmation-dialog state in the Model before applying.

---

## Relevant Design Notes

- **Delete confirmation (REQ-010):** the destructive action sets a confirmation-dialog state in the
  Model first; the reducer applies the delete only after the confirm message (assert the dialog
  state in `test_REQ010_add_edit_delete_records_reducer`).
- **Mismatch never suppressed (RULE-005):** `bind` always returns the mismatch reasons in the
  outcome; the UI shows `[WARN] Serial mismatch: record XY99… ≠ loaded XY12…. Bind anyway? [Y/N]`.
- **Search semantics:** substring match on serial/label, exact on console_type; results ordered by
  `created_at` descending.

---

## Acceptance Test(s)

- `test_REQ010_add_edit_delete_records_reducer` — `AddKeyRecord`/`EditKeyRecord`/`DeleteKeyRecord`
  into `model::update` mutate `Model.library` correctly; destructive action sets the confirmation
  dialog state. *(unit)*
- `test_REQ012_search_by_serial_returns_matching_records` — three records with distinct serials;
  search by one serial returns exactly one match. *(unit)*
- `test_REQ013_bind_matching_key_to_dump_succeeds` — bind a record whose serial matches the loaded
  `ConsoleInfo` → `BoundOk`; no mismatch warning. *(unit)*
- `test_REQ013_bind_surfaces_mismatch_warning` — bind a record whose serial conflicts →
  `BoundWithMismatchWarning`; UI must surface before accept. *(unit)*
- `test_REQ013_edit_unknown_id_no_mutation` — `edit`/`delete` for a non-existent id →
  `RecordNotFound` (ERR-011); library unchanged. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it matches IF-006 / IF-007 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-010, REQ-012, REQ-013 still map to passing tests).

---

## Out of Scope for This Task

- FS-001 persistence internals (load/save atomicity) — SLICE-2 / TASK-008 (this task calls save).
- Import/export — SLICE-2 / TASK-010.
- TUI screens / dialog rendering — SLICE-2 / TASK-011.
