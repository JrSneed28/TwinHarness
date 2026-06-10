# SLICE-2 / TASK-008 — `CpuKey::parse` + KeyLibrary persistence (FS-001 load/save)

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-009, REQ-011, REQ-012
**Slice:** SLICE-2 — CPU-key library management
**Depends on:** SLICE-0 complete

---

## Goal

Implement the CPU-key format gate (`CpuKey::parse`) and the persistent `KeyLibrary` load/save
(FS-001): a 32-hex validation that rejects malformed keys, and an atomic (temp+rename) JSON library
that survives restart, falls back to an empty library when the file is missing, tolerates a corrupt
file without crashing, and refuses a too-new schema version.

---

## REQ-IDs

- **REQ-009** — Maintain a persistent CPU-key library storing per-console key records across
  sessions.
- **REQ-011** — Validate every CPU key on entry/import (correct length and hex format); reject
  malformed keys with a clear message.
- **REQ-012** — Look up / search the library by console identifier (the persistence + load half is
  here; search is TASK-009).

---

## Relevant Contracts / Interfaces

**IF-004 — `keys::CpuKey::parse`:**

```
Input:  s: &str   // any length accepted; invalid rejected
Output: CpuKey { value: String }   // exactly 32 lowercase hex [0-9a-f]{32}; raw input not retained
Error:  ValidationIssue { Error, InvalidKeyFormat, target: "cpu_key" }  // not exactly 32 hex (ERR-007, RULE-004)
```

**IF-005 — `keys::KeyLibrary::load` / `save`:**

```
load(path: &Path) -> KeyLibrary { storage_path, records: Vec<KeyRecord>, schema_version: u32 }
  // file may not exist (first-run = empty library)
save(library: &KeyLibrary, path: &Path) -> Ok(())   // atomic write-to-temp + rename (INV-001 atomicity)

Errors:
  Warning LibraryMissing      (load) — file not found      → empty library; no crash
  Warning LibraryCorrupt      (load) — not valid JSON      → empty library + warning; no crash
  Error   SchemaVersionTooNew (load) — schema_version > supported (ERR-010) → refuse load; advise upgrade
  Error::Io                   (save) — write failed        → in-memory state unchanged
```

**FS-001 — KeyLibrary file schema** (JSON; current `schema_version = 1`):

```
schema_version: u32 · records: [ KeyRecord ]   // ordered by created_at desc

KeyRecord {
  id: UUIDv4 · cpu_key: String [SENSITIVE] [0-9a-f]{32}
  console_serial: String|null · console_type: enum|null · label: String|null · notes: String|null
  created_at: ISO8601 · updated_at: ISO8601
}
// On load: records whose cpu_key fails [0-9a-f]{32} are SKIPPED with a Warning (not loaded).
//          unknown console_type string → coerced to null + Warning. No two records share an id.
```

**Preconditions (save):** all records have passed `CpuKey::parse` (RULE-014); UI-thread caller only
(no concurrent writers).

---

## Relevant Design Notes

- **Validation gate first** (INV-003): a `CpuKey` value in the system has always passed the
  exactly-32-hex check; normalize to lowercase on storage.
- **Atomicity (INV-001):** `save` writes to a temp file alongside the target then renames into
  place; a process-kill mid-write leaves either the last committed version or the unchanged file —
  never a corrupt partial.
- **Fail-soft load** (REQ-NFR-011): missing → empty; corrupt → empty + Warning; too-new schema →
  hard refuse (do not silently truncate).

---

## Acceptance Test(s)

- `test_REQ011_cpukey_parse_accepts_valid_32hex` — exactly 32 valid hex chars → `Ok`. *(unit)*
- `test_REQ011_cpukey_parse_rejects_malformed` — non-32 / non-hex / wrong length →
  `InvalidKeyFormat` (ERR-007); record not created. *(unit)*
- `test_REQ009_library_persists_across_load_save` — add a record, `save` to tempdir, `load`;
  record present with field identity (FS-001 round-trip). *(integration)*
- `test_REQ012_library_load_missing_returns_empty` — missing FS-001 file → empty `KeyLibrary`; no
  crash. *(unit)*
- `test_REQ012_library_load_corrupt_does_not_crash` — non-JSON FS-001 file → empty library +
  `LibraryCorrupt` Warning; no crash. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it matches IF-004 / IF-005 / FS-001 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-009, REQ-011, REQ-012 still map to passing tests).

---

## Out of Scope for This Task

- CRUD reducer arms, search, bind — SLICE-2 / TASK-009.
- Import/export (FS-002) — SLICE-2 / TASK-010.
- TUI screens — SLICE-2 / TASK-011.
- CPU-key log redaction — SLICE-5 / TASK-020.
