# SLICE-2 / TASK-011 — KeyLibrary + KeyRecordDialog screens wired through the reducer

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-009, REQ-010, REQ-011, REQ-013, REQ-NFR-003
**Slice:** SLICE-2 — CPU-key library management
**Depends on:** SLICE-2 / TASK-010 complete

---

## Goal

Wire the `KeyLibrary` screen and its `KeyRecordDialog` modal through the reducer: a scrollable,
searchable record table with Add/Edit/Delete/Import/Export/Bind actions, an add/edit form that
validates the CPU key inline (blocking Save on a malformed key), a delete confirmation, and a bind
action that surfaces the mismatch warning — proving the aggregate "validate before acting" gate
across the keys module.

---

## REQ-IDs

- **REQ-009** — Persistent CPU-key library with per-console records.
- **REQ-010** — Add/edit/view/delete records via TUI forms/dialogs, with confirmation on destructive
  actions.
- **REQ-011** — Validate every CPU key on entry/import; reject malformed with a clear message.
- **REQ-013** — Bind a key to the loaded dump; warn on mismatch.
- **REQ-NFR-003** — Safety & validation first-class: invalid inputs rejected with actionable errors
  before any operation proceeds (this task carries the cross-module aggregate gate).

---

## Relevant Contracts / Interfaces

**IF-015 reducer arms used:** `KeyAdd`, `KeyEdit`, `KeyDelete`, `KeySearch`, `KeyBind`, `KeyImport`,
`KeyExport`, `Navigate(Screen::KeyLibrary)`. CRUD/search/bind/import/export bodies are owned by
TASK-008…010; this task drives them from the screens and renders results.

---

## Relevant Design Notes — wireframes (embed; do not invent layout)

**`KeyLibrary`** (anchors REQ-009, REQ-010, REQ-012, REQ-013, REQ-014, REQ-NFR-003): a
`SearchFilterBar` (`Search: > jasper___ [Enter] filter [Esc] clear`); a `KeyRecordTable` with columns
`CPU Key (truncated) · Serial · Type · Notes` and a `[bound ✓]` flag on bound rows, `►` on the
selected row; action bar `[A] Add  [E] Edit  [D] Delete (confirm)  [I] Import  [X] Export
[B] Bind to active dump  [Enter] view detail  [Esc] back`. Empty state: `[·] No key records yet.
Press [A] to add the first KeyRecord.` Error state: `[ERR] KeyLibrary could not be loaded …`.

**`KeyRecordDialog`** (modal over KeyLibrary; anchors REQ-009, REQ-010, REQ-011, REQ-013,
REQ-NFR-003): fields `CPU Key (32 hex chars)` with an inline validation hint
(`[✓] Valid format (32 hex chars)` or `[ERR] CPU key must be exactly 32 hex characters.`),
`Console Serial (optional)`, `ConsoleType` dropdown, `Notes (optional)`; `[S] Save [Esc] Cancel`.
**Save is disabled until the CpuKey field validates.** Bind mismatch shows
`[WARN] Serial mismatch — stored XY99… ≠ loaded dump XY12…. Bind anyway? [Y/N]`.

**Modal focus trap:** while the dialog is open, global number shortcuts (1–7) are inactive; `Tab`
cycles fields; `Esc` dismisses and returns focus to the triggering row. **No color-only state**
(REQ-NFR-009): each field hint carries `[✓]`/`[ERR]`.

---

## Acceptance Test(s)

- `test_REQ009_library_persists_across_load_save` — add via the screen flow, save, reload; record
  present with field identity. *(integration)*
- `test_REQ010_add_edit_delete_records_reducer` — screen-driven Add/Edit/Delete mutate the Model
  library; delete sets the confirmation dialog state. *(unit)*
- `test_REQ011_cpukey_parse_rejects_malformed` — a malformed key in the dialog blocks Save and shows
  the inline `[ERR]`. *(unit)*
- `test_REQ013_bind_surfaces_mismatch_warning` — binding a conflicting record surfaces the
  `[WARN]` dialog before accept. *(unit)*
- `test_REQ_NFR003_invalid_input_rejected_before_operation` — across `nand`/`keys`/`build`/`flash`,
  all invalid inputs return a typed `ValidationIssue` before any side-effect; this task supplies the
  `keys` arm and the aggregate assertion. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass; the KeyLibrary + dialog flow is demonstrable from the keyboard.
- [ ] No state communicated by color alone (glyph/label on every field hint) — REQ-NFR-009 honored.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] `th coverage check` does not regress (REQ-009, REQ-010, REQ-011, REQ-013, REQ-NFR-003 still
      map to passing tests).

---

## Out of Scope for This Task

- The Dashboard "Key Library" tile summary — SLICE-5 / TASK-019.
- Underlying CRUD/search/bind/import/export logic — SLICE-2 / TASK-008…010.
- The `build`/`flash` arms of the aggregate REQ-NFR-003 gate are validated in SLICE-3/TASK-012 and
  SLICE-4/TASK-015 respectively; this task asserts the `keys` arm and the cross-module roll-up.
