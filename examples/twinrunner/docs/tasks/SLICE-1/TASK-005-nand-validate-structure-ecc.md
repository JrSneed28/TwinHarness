# SLICE-1 / TASK-005 — `nand::validate` — structure + ECC, fail-closed with named region

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-002, REQ-007, REQ-NFR-003, REQ-NFR-011
**Slice:** SLICE-1 — Read NAND & console info
**Depends on:** SLICE-1 / TASK-004 complete

---

## Goal

Implement `nand::validate(&mut image)`: advance an `Unvalidated` image through FlashConfig-presence,
layout-sanity, and per-region ECC checks, setting it `Validated` on full pass or `Invalid` on the
first Error-severity issue — which **names the specific failing region** and **blocks extraction**.
Validation never silently passes a corrupt dump and never panics on garbage bytes.

---

## REQ-IDs

- **REQ-002** — On load, validate dump structure before extraction (size/length, header/FlashConfig
  presence, layout sanity); structurally invalid dumps are reported with an actionable message and
  not treated as parseable.
- **REQ-007** — Verify ECC integrity / NAND data sanity for understood regions and report pass/fail
  with the specific failing region; never silently pass a corrupt dump.
- **REQ-NFR-003** — Safety & validation first-class: invalid inputs are rejected with actionable
  errors before any dependent operation proceeds.
- **REQ-NFR-011** — Parsing/validation failures are surfaced as typed, user-facing errors; a failure
  never panics the process.

---

## Relevant Contracts / Interfaces

**IF-002 — `nand::validate`:**

```
Input:  image: &mut NandImage  [required] — must be in Unvalidated state

Output (success): Ok(())  — validation_status advanced to Validated; all checks pass

Errors (Err(Vec<ValidationIssue>), each Error-severity, sets image Invalid, blocks extraction):
  { MissingFlashConfig, target: "FlashConfig" }  — FlashConfig absent / fails bit-pattern (ERR-002)
  { UnknownLayout,      target: "NandLayout" }   — implied ecc_type/page_size not a known layout (ERR-003)
  { EccFailure,         target: "<region name>" } — ECC check fails for a named region (bootloader/fuse/keyvault)
```

**Preconditions:** `image.validation_status == Unvalidated` (do not call on already-Validated/
Validating/Invalid/Extracted). **Postconditions (success):** `Validated`, no Error issues.
**Postconditions (failure):** `Invalid`, ≥1 Error issue with a named `target` region. **Side
effects:** emit `ValidationStarted` then `ValidationPassed` or `ValidationFailed`. No disk writes.

Extraction precondition (enforced downstream by IF-003): calling `extract` on a non-`Validated`
image → `NotValidated` (ERR-005). This task must leave `Invalid` images un-extractable.

---

## Relevant Design Notes

- **Phase 2 of the parse pipeline** (`06-technical-design` §NAND parse pipeline): set `Validating`;
  collect issues in a `Vec`. (1) FlashConfig presence at the documented `SizeClass` offset — zero/
  sentinel or failed bit-pattern → `MissingFlashConfig`. (2) Resolve `NandLayout` from `SizeClass` +
  `FlashConfig.ecc_type`; unknown → `UnknownLayout`. (3) Per region (bootloader, fuse, keyvault) walk
  page/spare pairs, recompute the simulated ECC check value per page, compare to the stored spare
  value; the **first** failing region → `EccFailure { target: "<region name>" }`. (4) Any Error
  issue → `Invalid` + `ValidationFailed`, return `Err`; never advance to `Validated`/`Extracted`
  (RULE-002/003). Else `Validated` + `ValidationPassed`.
- **Fixture-backed, deterministic, O(n) single pass**; bounded by the loaded buffer. Documented
  offsets are the example's layout (fixtures authored to satisfy them), not full NAND fidelity.
- **No generic "corrupt":** the ECC issue always names the region (REQ-007).

---

## Acceptance Test(s)

- `test_REQ002_validate_happy_path_ok` — `validate` on the clean fixture returns no Error-severity
  `ValidationIssue`. *(unit)*
- `test_REQ002_validate_missing_flashconfig` — correct-size file with no FlashConfig block →
  `MissingFlashConfig` (ERR-002); image `Invalid`. *(unit)*
- `test_REQ002_extract_requires_validated` — calling `extract` on an `Unvalidated`/`Invalid` image →
  `NotValidated` (ERR-005); extraction refused. *(unit)*
- `test_REQ007_validate_ecc_passes_clean_fixture` — ECC check on the clean fixture passes all
  regions without Error-severity issues. *(unit)*
- `test_REQ007_validate_ecc_failure_names_region` — ECC failure on a specific region → `EccFailure`
  names that region; image `Invalid`; not a generic "corrupt". *(unit)*
- `test_REQ_NFR011_nand_never_panics_on_garbage` — proptest: ∀ arbitrary `Vec<u8>`, `load` +
  `validate` never panics; all errors are typed. *(property)*

---

## Definition of Done

- [ ] All acceptance tests pass (including the proptest with no panics).
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it matches IF-002 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-002, REQ-007, REQ-NFR-003, REQ-NFR-011 still map to
      passing tests).

---

## Out of Scope for This Task

- `nand::load` (size detection) — SLICE-1 / TASK-004.
- ConsoleInfo extraction + JSON export — SLICE-1 / TASK-006.
- The worker-side / reducer-side aggregation for `test_REQ_NFR003_invalid_input_rejected_before_operation`
  across all modules — that aggregate gate is owned by SLICE-2 / TASK-011 (key inputs) and exercised
  across slices; this task only proves the NAND arm rejects-before-acting.
- Any TUI screen wiring — SLICE-1 / TASK-007.
