# SLICE-1 / TASK-006 — `nand::extract` + ConsoleInfo JSON export (FS-003)

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-003, REQ-004, REQ-005, REQ-006, REQ-008
**Slice:** SLICE-1 — Read NAND & console info
**Depends on:** SLICE-1 / TASK-005 complete

---

## Goal

Implement `nand::extract(&image)` on a `Validated` image to produce an immutable `ConsoleInfo`
(console type + certainty, serial, ECC type, CPU key presence, bootloader chain, fuse set) without
ever guessing absent fields, and serialize it round-trip-faithfully to the FS-003 JSON export
schema.

---

## REQ-IDs

- **REQ-003** — Extract core console info: console/motherboard type, serial (where present), ECC/NAND
  layout type.
- **REQ-004** — Extract bootloader information: the CB/CD/CE/CF/CG chain present in the dump and
  their versions, surfaced readably.
- **REQ-005** — Read fuse / FlashConfig and security-relevant fields and present them for inspection.
- **REQ-006** — Extract (or derive) the CPU key and validate its format; when it cannot be derived,
  say so explicitly rather than guessing.
- **REQ-008** — Present extracted console info in a structured view and export it (text/JSON report).

---

## Relevant Contracts / Interfaces

**IF-003 — `nand::extract`** (input `image: &NandImage` in `Validated` state):

```
ConsoleInfo {
  console_type:         ConsoleType   // Xenon|Zephyr|Falcon|Jasper|Trinity|Corona
  console_type_certain: bool          // false when ConsoleTypeUncertain warning present
  serial:               Option<String> // Some if readable ASCII; None = Absent (never guessed)
  ecc_type:             EccType        // derived from FlashConfig
  cpu_key:              CpuKeyPresence // Present(CpuKey) | Absent (RULE-010; never zeroed/guessed)
  bootloader_chain:     BootloaderChain // ordered; CB must be present
  fuse_set:             FuseSet
}
// Errors: Err(ValidationIssue { Error, NotValidated }) if not Validated (ERR-005, RULE-002)
//         Ok-result Warning { ConsoleTypeUncertain } sets console_type_certain=false (non-blocking)
```

CPU-key format gate (IF-004 `keys::CpuKey::parse`): a derived key must be exactly 32 hex chars
(`[0-9a-f]{32}`, lowercased) or it is `Absent` — never a zeroed/guessed key (ERR-007 on malformed).

**FS-003 — ConsoleInfo export schema** (JSON; `Command::WriteFile` to a user path):

```
schema_version: 1 · exported_at · source_path · console_type · console_type_certain
serial: String|null · ecc_type · cpu_key: String|null [SENSITIVE]
bootloader_chain: [ { stage: "CB|CD|CE|CF|CG", version: String|null, present: bool } ]  // ≥1 with stage=CB
fuse_set: { fuse_lines: [String], security_state: String }
```

---

## Relevant Design Notes

- **Phase 3 of the parse pipeline** (`06-technical-design` §NAND parse pipeline): precondition
  `Validated` else `NotValidated`. (2) ConsoleType from `(FlashConfig pattern, CB version range)`
  via a fixed lookup; if unresolved → report a fallback type **with** a `ConsoleTypeUncertain`
  Warning and `console_type_certain=false` — never a silent guess. (3) Serial: printable ASCII at the
  documented offset → `Present`, else `Absent`. (4) Bootloader chain: walk CB/CD/CE/CF/CG; present
  stages get `{stage, version, present:true}`, missing get `present:false`; at least CB present (else
  Warning). (5) FuseSet: read fuse lines + derive `security_state` from a documented table. (6) CPU
  key: derive 32-hex per the documented rule → `Present`; zeroed/masked/underivable → `Absent` +
  `CpuKeyAbsent` event. Set `Extracted`; emit `ConsoleInfoExtracted`.
- **Idempotent:** load→validate→extract twice on the same bytes yields identical `ConsoleInfo`.
- **Export (REQ-008):** serialize `ConsoleInfo` to FS-003 JSON via serde; bootloader chain must
  include a CB entry (present=false if CB absent); round-trip (serialize→deserialize) must preserve
  every field.

---

## Acceptance Test(s)

- `test_REQ003_extract_console_type_and_serial` — extracted `console_type` and `serial` match the
  fixture manifest. *(unit)*
- `test_REQ004_extract_bootloader_chain_versions` — `BootloaderChain` contains the expected CB/CD
  versions from the fixture; fields non-empty. *(unit)*
- `test_REQ005_extract_fuse_flashconfig_fields` — `FuseSet` and `FlashConfig` values match the
  expected fixture values; fields surfaced for inspection. *(unit)*
- `test_REQ006_extract_cpu_key_valid` — extracted `cpu_key` matches the expected 32-hex string from
  the fixture manifest. *(unit)*
- `test_REQ006_extract_cpu_key_absent_not_guessed` — zeroed/masked CPU-key region → `cpu_key =
  Absent`; never a zeroed or guessed key. *(unit)*
- `test_REQ008_console_info_export_json_roundtrip` — `ConsoleInfo` serialized to JSON and back; all
  fields identical (FS-003 contract). *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] If a contract was defined here, it matches IF-003 / FS-003 in `07-contracts.md`.
- [ ] `th coverage check` does not regress (REQ-003…006, REQ-008 still map to passing tests).

---

## Out of Scope for This Task

- `load`/`validate` — SLICE-1 / TASK-004, TASK-005.
- CPU-key **library** storage/CRUD/bind — SLICE-2 (this task only uses `CpuKey::parse` as the
  format gate for extraction).
- TUI rendering of ConsoleInfoView — SLICE-1 / TASK-007.
