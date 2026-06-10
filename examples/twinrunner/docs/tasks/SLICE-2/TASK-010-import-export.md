# SLICE-2 / TASK-010 — Key library import / export (FS-002)

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-014
**Slice:** SLICE-2 — CPU-key library management
**Depends on:** SLICE-2 / TASK-009 complete

---

## Goal

Implement `keys::import` and `keys::export` over the FS-002 file schema: export the library (all or
selected records) to a user path, and import records back with per-record validation — skipping a
bad record with a warning while continuing the import, rejecting a wholly-invalid file, and skipping
records whose id already exists (no overwrite). A full export→clear→reimport cycle restores all
records.

---

## REQ-IDs

- **REQ-014** — Import and export the CPU-key library (and/or individual records) in a documented
  file format for backup and transfer between machines.

---

## Relevant Contracts / Interfaces

**IF-008 — `keys::import` / `keys::export`:**

```
import(path: &Path) -> ImportResult { imported: u32, skipped: u32, warnings: Vec<ValidationIssue> }
export(path: &Path, selection: ExportSelection) -> Ok(())   // ExportSelection = All | ByIds(Vec<String>)

Errors:
  Error FileNotFound          (import) — path missing (ERR-012) → library unchanged; retry allowed
  Error InvalidImportFormat   (import) — not valid JSON / schema not understood (ERR-013) → reject whole import
  Warning InvalidKeyFormat, target: record.id (import, per-record) → skip that record; continue; +1 skipped
  Error::Io                   (export) — write failed → no partial file

// Preconditions: export path must NOT equal library_path (no overwrite of canonical library).
// Postconditions (import): imported records added + library saved; skipped records produce warnings.
```

**FS-002 — Key import/export schema** (JSON; `schema_version = 1`):

```
schema_version · exported_at · records: [ ExportedKeyRecord ]   // one or more
ExportedKeyRecord { id, cpu_key [SENSITIVE] [0-9a-f]{32}, console_serial?, console_type?, label?, notes?, created_at }
// NOTE: updated_at is intentionally ABSENT in FS-002. On import into FS-001, set updated_at = created_at.
// Import rules: bad cpu_key → skip+Warning; unknown console_type → null+Warning;
//               id already in library → SKIP (no overwrite); duplicate id within file → last wins / counted in skipped.
```

---

## Relevant Design Notes

- **Per-record resilience (REQ-014):** an invalid file is rejected wholesale (`InvalidImportFormat`),
  but a single bad record inside a valid file is skipped (Warning) and the rest import — surfaced via
  `ImportResult.skipped` and `.warnings`.
- **No overwrite on import:** records whose `id` already exists in the library are skipped; this
  makes re-importing the same export idempotent.
- **`updated_at` reset:** imported records get `updated_at = created_at` (they are foreign to the
  receiving library's edit timeline); `created_at` is preserved.

---

## Acceptance Test(s)

- `test_REQ014_export_then_reimport_roundtrip` — export to FS-002; clear the in-memory library;
  reimport; all original records present (FS-002 contract). *(integration)*
- `test_REQ014_import_invalid_format_rejected_wholesale` — non-JSON import file →
  `InvalidImportFormat` (ERR-013); entire import rejected; library unchanged. *(unit)*
- `test_REQ014_import_skips_bad_record_continues` — file with one bad `cpu_key` record → that record
  skipped with Warning; rest imported; `ImportResult.skipped = 1`. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it matches IF-008 / FS-002 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-014 still maps to a passing test).

---

## Out of Scope for This Task

- The `[I]`/`[X]` import/export key bindings on the KeyLibrary screen — SLICE-2 / TASK-011 (this
  task implements the underlying `import`/`export` functions).
- CRUD/search/bind — SLICE-2 / TASK-009.
- Additional formats (CSV, J-Runner-native) — V1, out of MVP scope.
