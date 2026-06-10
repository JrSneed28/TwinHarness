# SLICE-1 / TASK-004 — `nand::load` — read-only open + size-class detection

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-001, REQ-035
**Slice:** SLICE-1 — Read NAND & console info
**Depends on:** SLICE-0 complete

---

## Goal

Implement `nand::load(path)`: open a dump file **read-only**, match its length **exactly** against
the four `SizeClass` byte counts, and return an `Unvalidated` `NandImage` on success — rejecting any
other length with a named `UnknownSize` error and never proceeding to validation, and never
modifying the source file.

---

## REQ-IDs

- **REQ-001** — TwinRunner opens an Xbox 360 NAND dump file from a user-selected path and detects
  its image size class (16/64/256/512 MB), rejecting files whose size does not match a known class
  with a clear error.
- **REQ-035** — TwinRunner always operates on copies / new files for any mutation; loading a dump is
  read-only with respect to the source file.

---

## Relevant Contracts / Interfaces

**IF-001 — `nand::load`:**

```
Input:  path: String  [required] — valid UTF-8 filesystem path; non-empty

Output (success):
NandImage {
  source_path:       String            // canonical path; read-only reference
  size_class:        SizeClass         // one of { MB16, MB64, MB256, MB512 }
  raw_bytes:         Vec<u8>           // full file contents; in-memory only
  validation_status: ValidationStatus  // exactly Unvalidated on success
  loaded_at:         Timestamp         // injected from Clock::now()
}

Errors:
  Error::Io                                                  — not found / permission / OS read error → allow retry
  ValidationIssue { Error, UnknownSize, target: "file length" }  — length ≠ any SizeClass (ERR-001 / RULE-009)
```

`SizeClass` exact byte counts: **MB16 = 16,777,216 · MB64 = 67,108,864 · MB256 = 268,435,456 ·
MB512 = 536,870,912**.

**Postconditions:** file is closed (not held open); source unmodified; `validation_status =
Unvalidated`. **Side effects:** emit `DumpLoaded` on success; `DumpLoadFailed` on any error. Open
read-only and close immediately after reading.

---

## Relevant Design Notes

- **Phase 1 of the parse pipeline** (`06-technical-design` §NAND parse pipeline): open read-only
  (RULE-001/INV-001); read length; match exactly against the four counts; any other length →
  `UnknownSize`, emit `DumpLoadFailed`, **stop** (validation does not proceed for unrecognized
  sizes). On match, read bytes into `raw_bytes` and construct the `Unvalidated` `NandImage`.
- **Never panic** (REQ-NFR-011): zero-length / truncated files hit the `UnknownSize` path; no
  `NandImage` is created.

---

## Acceptance Test(s)

- `test_REQ001_load_detects_size_class` — `nand::load` on the bundled 64 MB fixture returns
  `NandImage { size_class: SizeClass::Mb64 }`. *(unit)*
- `test_REQ001_load_rejects_unknown_size` — non-standard-length file rejected with `UnknownSize`
  (ERR-001); no `NandImage` created. *(unit)*
- `test_REQ035_load_opens_source_read_only` — after `nand::load` + the full pipeline, the source
  fixture's bytes are byte-identical; no writes to the source path. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here (`NandImage`/`SizeClass`/`ValidationStatus`), it matches
      IF-001 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-001, REQ-035 still map to passing tests).

---

## Out of Scope for This Task

- Structure / ECC validation — SLICE-1 / TASK-005.
- ConsoleInfo extraction + export — SLICE-1 / TASK-006.
- The `test_REQ001_load_rejects_truncated_file` / `test_REQ001_load_io_error_surfaced` negative
  paths beyond the two anchored here may be implemented opportunistically but are owned by the
  validation/error tasks if deferred.
- Any TUI screen wiring — SLICE-1 / TASK-007.
