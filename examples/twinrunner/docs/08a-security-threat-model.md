# Security & Threat Model — TwinRunner

> **Stage S — Security & Threat Modeling** (spec §15.S). Tier 3 — graduated from the folded
> Architecture §Security section because TwinRunner handles **sensitive data (the user's own
> CPU keys)** and **parses untrusted binary files**. Reads Summaries from `04-architecture.md`,
> `07-contracts.md`, and `03-domain-model.md`; fetches full artifacts where a boundary or data
> flow needs detail (§9). Human gate required on the security model and on any auth decision (§8)
> — TwinRunner has **no auth model by design**, so the gate reduces to a human acknowledgement of
> the accepted residual risks listed at the end of this document.

## Summary

TwinRunner is a **single-user, filesystem-only, fully offline** Rust TUI binary. **There is no
network, no socket, no IPC, no database, and no authentication or authorization surface** — so
classic remote-threat classes (HTTPS/MITM, SQL injection, CSRF, multi-tenant privilege escalation,
session hijack) are **nonsensical here and deliberately absent**. The real security surface is
local: a **high-value secret (the user's CPU keys) stored plaintext at rest** in the KeyLibrary
file (`twinrunner-core::keys` / FS-001), and **two untrusted-input parsers** — the NAND dump
parser (`twinrunner-core::nand`) and the key-import reader (`twinrunner-core::keys` / FS-002) —
that ingest arbitrary user-supplied file bytes. The dominant threats are therefore (1) **key
material leaking** out of `keys` into the log file (FS-005) or ConsoleInfo export (FS-003);
(2) **a crafted/oversized dump or import file crashing or exhausting** the `nand`/`keys` parsers;
and (3) **path traversal / arbitrary-file overwrite** through user-supplied build/flash/export
output paths, which must never violate the read-only source invariant (RULE-001/REQ-035).

- **Highest-value asset:** the user's CPU keys, stored plaintext-local in the KeyLibrary file (FS-001), owned by `twinrunner-core::keys`.
- **Highest-risk boundary:** `filesystem → nand parser` (TB-002) — arbitrary untrusted dump bytes parsed in-process; secondarily `filesystem → keys import` (TB-003).
- **Auth model:** **None — by design.** Single local user, no network, no accounts, no sessions. The OS file-permission model is the only access boundary; the tool operates exclusively on the invoking user's own files.
- **Gate status:** Pending human sign-off — the security model carries **no auth decision** (there is no auth); the human acknowledgement requested is over the **accepted Residual Risks** below (esp. plaintext key storage at rest).

---

## Assets

| Asset | Sensitivity (C/I/A) | Owning component | Notes |
|-------|--------------------|-----------------:|-------|
| **CPU key material** (`CpuKey` values inside `KeyRecord`s) | C (highest) | `twinrunner-core::keys` | The per-console secret. Persisted plaintext in FS-001; also flows into FS-002 export and (when Present) FS-003 ConsoleInfo export. Confidentiality is the dominant concern (REQ-NFR-007 redaction protects it in logs). |
| **KeyLibrary file at rest** (FS-001) | C + I | `twinrunner-core::keys` | The serialized library JSON on disk under the platform data dir. Confidentiality (contains keys) and integrity (tampering could inject/alter records; schema_version is checked on load). |
| **NandImage dump file** (user data, in-memory `raw_bytes`) | C + A | `twinrunner-core::nand` | The user's own console dump. Confidentiality of its contents (it embeds the CPU key + fuses) and availability of the parse (a hostile dump must not DoS the process). The source file on disk is integrity-critical via RULE-001 (read-only). |
| **Exported key file** (FS-002) | C | `twinrunner-core::keys` | A user-chosen export containing raw `cpu_key` values — sensitive in transit between machines. |
| **ConsoleInfo export** (FS-003) | C | `twinrunner-core::nand` | Carries `cpu_key` (raw, marked SENSITIVE) when the key is Present in the dump. |
| **Log file** (FS-005) | C | `twinrunner-core::log` | Append-only JSON Lines mirror of the `ActionLog`. Must never contain raw key material — redaction (INV-006 / REQ-NFR-007) is the protecting control. |
| **Build artifact / output image** (FS-006) | I + A | `twinrunner-core::build` | A simulator-produced binary at a user-chosen path. Integrity (atomic temp+rename; deterministic checksum, RULE-007) and availability (write must not clobber the source — RULE-001). |
| **Source-dump read-only invariant** (a capability, not data) | I (highest) | `twinrunner-core::nand`, `build`, `flash` | The guarantee that the source dump is never written. Its violation is the worst data-integrity outcome (an irreplaceable dump corrupted). Enforced by RULE-001/REQ-035. |
| **No-real-hardware-write guarantee** (a capability) | I/safety | `twinrunner-core::build`/`flash` ports | The guarantee that no real device/flash write path exists; only the simulator acts, the real backend is a no-op stub (RULE-006/REQ-020/REQ-022/REQ-NFR-004). |

---

## Trust Boundaries

| Boundary ID | From | To | What crosses it | Trust differential |
|-------------|------|----|-----------------|--------------------|
| TB-001 | Local user (keyboard) | `twinrunner::tui` | crossterm raw-mode key events | Single trusted local user. Caller is the OS-authenticated desktop user; no further verification. Lowest-risk boundary — listed for completeness. |
| **TB-002** | **Filesystem (user-selected path)** | **`twinrunner-core::nand`** (`nand::load`/`validate`/`extract`, IF-001/002/003) | **A NAND dump file's raw bytes** | **Content UNTRUSTED.** The user names a path; the bytes are arbitrary and may be malformed or hostile. `nand` must verify size class (RULE-009), structure (RULE-002/003) and ECC before any extraction, and must never panic on bad bytes (REQ-NFR-003/011). **Highest-risk boundary.** |
| **TB-003** | **Filesystem (user-selected path)** | **`twinrunner-core::keys`** (`keys::import`, IF-008 / FS-002) | **A key-import file (JSON)** | **Content UNTRUSTED.** Arbitrary JSON; each `cpu_key` must pass the 32-hex check (RULE-004) before any record is admitted; malformed JSON / `schema_version` too new is rejected wholesale (ERR-013/ERR-010). |
| TB-004 | Filesystem (config path) | `twinrunner-core::config` (FS-004) | The TOML `AppConfig` (user-editable) | Content semi-trusted (the user's own config). Unknown keys ignored, invalid values fall back to defaults, startup never aborts (REQ-033). The risk it carries is **redirecting output paths** (`library_path`, `log_file_path`, `output_dir`) — those paths feed TB-006/TB-005. |
| **TB-005** | `twinrunner-core::log` | **Filesystem (log file FS-005)** | `LogEntry` lines mirrored to disk | **Egress of potentially sensitive data.** A `LogEntry` could carry a CPU key embedded in a message/payload; redaction must run **before** the line crosses this boundary (INV-006/REQ-NFR-007). |
| **TB-006** | `twinrunner-core::build` / `flash` / `keys` / `nand` | **Filesystem (user-chosen OUTPUT/EXPORT path)** | Written artifacts: build output (FS-006), flash-copy, key export (FS-002), ConsoleInfo export (FS-003) | **Write surface controlled by a user-supplied path string.** The path may contain `..`, be absolute, or be a symlink. The integrity invariant RULE-001 (output ≠ source) and `library_path` (export ≠ library) must hold; an unconstrained path is an arbitrary-file-overwrite surface. |
| TB-007 | Bundled fixtures (shipped with binary) | `twinrunner-core::build`/`troubleshoot` | Timing files, troubleshooting flow definitions | **Trusted** — owned by the example, shipped read-only with the binary. Not an attacker-controlled boundary. |
| — | (no boundary) | — | — | **There is NO network, socket, IPC, or device boundary.** The `Programmer` is simulated and the real backend is a no-op stub (REQ-022/REQ-NFR-004) — there is no physical-hardware trust boundary. |

---

## Data Flows

The two flows that matter for security are the **CPU-key lifecycle** (the secret) and the
**untrusted-dump ingestion** (the parser attack surface). Every threat below traces back to one
of these.

| Flow ID | Source | Data carried | Boundary crossed | Destination | Sensitive in transit? |
|---------|--------|-------------|-----------------|-------------|----------------------|
| **DF-001** | User keyboard / dump extraction | A candidate CPU-key string | TB-001 / internal | `keys::CpuKey::parse` (IF-004) | **Yes** — validated to 32-hex (RULE-004); raw input not retained |
| **DF-002** | `keys::CpuKey::parse` | Validated `CpuKey` in a `KeyRecord` | internal | `KeyLibrary` (in memory) | **Yes** |
| **DF-003** | `keys::save` (IF-005) | Full `KeyLibrary` incl. plaintext keys | **TB-006** | KeyLibrary file at rest (FS-001) | **Yes — plaintext at rest** |
| **DF-004** | `keys::load` (IF-005) | KeyLibrary file bytes (own + foreign on import) | **TB-003** (import) / TB-006 (own) | `keys` in memory | **Yes** — keys; foreign import is untrusted-format |
| **DF-005** | `keys::export` (IF-008) | Selected `KeyRecord`s incl. raw keys | **TB-006** | Key export file (FS-002) | **Yes — plaintext export** |
| **DF-006** | `nand::extract` (IF-003) | `ConsoleInfo` incl. `cpu_key` when Present | **TB-006** | ConsoleInfo export (FS-003) | **Yes — raw key in export when Present** |
| **DF-007** | Any module emitting a log entry | `LogEntry { message, payload }` (key may be embedded) | **TB-005** | Log file (FS-005) | **Yes — redacted at the boundary** |
| **DF-008** | User-selected path | NAND dump `raw_bytes` (arbitrary/hostile) | **TB-002** | `nand::load`/`validate`/`extract` | **Untrusted input** — size/structure/ECC validated before use |
| **DF-009** | User-selected path | Key-import file JSON (arbitrary/hostile) | **TB-003** | `keys::import` | **Untrusted input** — per-record 32-hex + schema check |
| **DF-010** | User-supplied output path string | Build/flash/export write target | **TB-006** | Filesystem | **Integrity-critical** — must satisfy output ≠ source (RULE-001) and export ≠ library |

---

## Threats (grounded)

> **Anti-boilerplate rule:** every threat below names a specific component (`twinrunner-core::*`),
> boundary (TB-###), or flow (DF-###) in THIS system. No generic "validate all inputs / use HTTPS /
> prevent SQL injection" entries appear — they are nonsensical for an offline, network-free,
> database-free local tool and are discarded.

| Threat ID | Threat (anchored) | Attack vector | Asset impacted | Impact (C/I/A) | Likelihood | Mitigation(s) |
|-----------|------------------|---------------|---------------|----------------|------------|---------------|
| **THR-001** | **CPU keys readable plaintext at rest** in the KeyLibrary file (FS-001) written by `twinrunner-core::keys` (DF-003). | Any process or user with read access to the platform data dir opens `keys.json` and reads every stored key. | CPU key material; KeyLibrary file | **C** | High (file is plaintext by design) | MIT-001 (OS file perms) + **accepted residual** RES-001 (encryption-at-rest is Future Scope) |
| **THR-002** | **CPU key leaks into the log file** (FS-005) via `twinrunner-core::log` (DF-007) — a key embedded in a `LogEntry.message` or `payload` is mirrored to disk in cleartext. | A key value reaches `log::append` inside an operation message (e.g. an error string containing the key) and is written to the persistent log. | Log file; CPU key material | **C** | Medium (keys flow through many operations; logging is broad) | MIT-002 (unconditional 32-hex redaction + `cpu_key`-by-name redaction on every append, §06 redaction algorithm) |
| **THR-003** | **`nand` parser DoS / panic on a crafted or truncated dump** at TB-002 (DF-008) — a file that passes the size-class gate but has malformed structure drives the parser into a panic, over-read, or hang. | User opens a hostile dump; parser indexes past a region, integer-overflows an offset, or loops unboundedly while seeking FlashConfig/ECC regions. | NAND parse availability; process stability | **A** | Medium (untrusted binary parsing is the core attack surface; ARCH-RISK-003) | MIT-003 (size-class gate RULE-009), MIT-004 (typed `ValidationIssue`, no-panic contract REQ-NFR-011), MIT-005 (bounded/offset-checked region reads, no unchecked indexing) |
| **THR-004** | **Memory exhaustion via oversized file** read by `nand::load` (IF-001) or `keys::import` (IF-008) — the loader reads an entire file into memory (`raw_bytes: Vec<u8>`) before size validation. | User points the loader at a multi-GB file (or a named pipe / sparse file); the read allocates unbounded memory and the process OOMs. | Process availability | **A** | Medium (no inherent upper bound on the path the user names) | MIT-006 (bound the read to the max recognized SizeClass = 512 MB before/while reading; reject by length first — RULE-009), MIT-007 (cap import-file read length) |
| **THR-005** | **Arbitrary-file overwrite via user-supplied output path** at TB-006 (DF-010) — build/flash/export writes to a path containing `..`, an absolute path, or a symlink pointing outside the intended directory. | User (or a tampered config redirecting `output_dir`) supplies `../../keys.json` or a symlinked path as a build/export output target; the write clobbers an unrelated file. | Any file the process can write; KeyLibrary integrity | **I** | Medium (path is a raw user string) | MIT-008 (RULE-001 output≠source check ERR-017), MIT-009 (export path ≠ library_path check, IF-008), MIT-010 (canonicalize + validate output path; atomic temp+rename so a partial write never lands, INV-001) |
| **THR-006** | **Source dump corruption** — a defect or path collision causes `nand`/`build`/`flash` to write to the source dump path, violating RULE-001/REQ-035 (DF-010). | output_path resolves (after symlink/`..`) to the loaded source path; the read-only invariant is breached and an irreplaceable dump is overwritten. | Source-dump read-only invariant; user's dump | **I (highest)** | Low (structurally guarded) but **catastrophic** | MIT-008 (output≠source refusal before any write, ERR-017), MIT-011 (source opened read-only and immediately closed — IF-001 postcondition; only simulator adapters write, to distinct paths) |
| **THR-007** | **KeyLibrary / config file tampering at rest** (FS-001 / FS-004) — an external editor alters records or redirects paths between sessions. | Attacker with filesystem access edits `keys.json` (injects/alters a record, or sets a future `schema_version`) or edits the TOML config to point `log_file_path` at a sensitive location. | KeyLibrary integrity; config integrity | **I** | Low (requires local FS access already) | MIT-012 (per-record 32-hex validation on load — bad records skipped with Warning, ERR-007), MIT-013 (`schema_version` upper-bound check, ERR-010), MIT-014 (config invalid-value fallback to defaults, REQ-033) |
| **THR-008** | **Malicious key-import file** at TB-003 (DF-009) — a crafted FS-002 file with malformed JSON, an over-large `notes`/`label` field, duplicate ids, or a too-new `schema_version` aims to crash or corrupt the library on import. | User imports a hostile export file; the importer mishandles a field-length blow-up, a duplicate id, or an unknown schema. | `keys` import availability; KeyLibrary integrity | **Low–Medium** | Medium (import is an explicit untrusted-file path) | MIT-015 (per-record validation: 32-hex skip-with-Warning, field-length caps from FS-001, duplicate-id and existing-id skip rules, IF-008/ERR-013), MIT-013 (schema_version check) |
| **THR-009** | **Real-backend bypass defeats the no-hardware-write safety guarantee** at the `BuildBackend`/`FlashBackend` ports (`twinrunner-core::build`/`flash`). | A stray direct file/device call (or a mis-wired backend selection) bypasses the port so an operation acts outside the simulator. | No-real-hardware-write guarantee (safety) | **I/safety** | Low (structurally enforced) | MIT-016 (RealStub backends return `NotImplemented` and write nothing — RULE-006/ERR-014; only the simulator adapter writes; asserted by a dedicated test, ARCH-RISK-004) |
| **THR-010** | **ConsoleInfo export leaks the CPU key in cleartext** (FS-003, DF-006) — the export written by `twinrunner-core::nand` includes the raw `cpu_key` when Present, with no redaction (unlike the log). | User exports console info to a shared/synced location; the file carries the plaintext key. | CPU key material; ConsoleInfo export | **C** | Medium (export is a user action to an arbitrary path) | MIT-017 (the `cpu_key` field is explicitly marked SENSITIVE in the FS-003 schema; the export action surfaces that the file contains the key) — see **accepted residual** RES-002 (export-of-key is an intended feature, not redacted) |

---

## Authn/Authz

> **This section is the human-gated section (§8). TwinRunner has NO authentication and NO
> authorization mechanism — this is a deliberate, confirmed non-feature (`07-contracts.md`
> Summary + Auth confirmation). There is therefore no auth *decision* to make and no auth gate to
> pass; the human acknowledgement requested at sign-off is over the accepted Residual Risks, not
> over an auth model.**

### Authentication

**None — by design.** TwinRunner is a single-user, local, fully-offline TUI binary. There is no
network, no socket, no remote caller, no account, no credential, and no session. The only
"principal" is the OS-authenticated desktop user who launched the process; that authentication is
performed by the operating system before `main` ever runs. No component authenticates anyone — the
contracts contain **no auth interface, event, error type, or schema** (`07-contracts.md` Error
Contracts §Auth note; Consumer/Producer Map §Auth confirmation).

### Authorization

**Single-principal, no authz layer.** Because there is exactly one principal (the invoking user)
and the tool operates only on **that user's own files**, there is nothing to authorize *between*
principals. The access-control boundary is entirely the **OS filesystem permission model**: the
process can read or write precisely the files the launching user can, and no more. No RBAC, ABAC,
ownership-check, or capability layer exists or is warranted.

**Why this is acceptable:** TwinRunner's threat model is local-file content, not a remote or
multi-user adversary. Adding an auth layer would protect nothing — there is no second principal to
defend against, no network entry point to gate, and no shared multi-tenant state. The honest and
correct design is *no auth*, with the OS as the access boundary, and with the real security effort
spent where the actual risk is: **untrusted-file parsing (TB-002/TB-003) and key-material
confidentiality (DF-003/DF-005/DF-006/DF-007).**

### Unauthenticated / Anonymous Access

Not applicable. There is no authenticated/anonymous distinction because there is no authentication.
Everything the binary does, it does as the single invoking OS user. The "anonymous access" question
collapses to "what can a user who can run the binary and read its files do?" — which is governed by
OS file permissions (MIT-001), not by any in-app control.

---

## Abuse Cases

| Abuse ID | Abuse case (anchored) | Component / flow | Negative test anchor |
|----------|-----------------------|-----------------|---------------------|
| **ABU-001** | A **maliciously crafted NAND dump** (valid size class, corrupt internal structure / out-of-range offsets) is loaded to crash or hang the parser. | `twinrunner-core::nand` / TB-002 / DF-008 | `test_REQ002_crafted_dump_returns_issue_no_panic`, `test_REQ002_truncated_dump_rejected` |
| **ABU-002** | An **oversized / garbage file** (multi-GB, or non-SizeClass length) is named as a dump to exhaust memory before validation. | `twinrunner-core::nand` / TB-002 / DF-008 | `test_REQ001_oversize_file_rejected_before_full_read` |
| **ABU-003** | A **hostile key-import file** (malformed JSON, oversized `notes`, duplicate ids, too-new schema_version) is imported to crash or corrupt the library. | `twinrunner-core::keys` / TB-003 / DF-009 | `test_REQ014_malformed_import_rejected`, `test_REQ014_invalid_record_skipped_with_warning` |
| **ABU-004** | A **path-traversal / symlink output path** (`../../keys.json`, absolute path, symlink) is supplied as a build/flash/export target to overwrite an arbitrary file. | `twinrunner-core::build` / `flash` / `keys` export / TB-006 / DF-010 | `test_REQ035_output_equals_source_refused`, `test_REQ014_export_path_not_library` |
| **ABU-005** | An attempt to **make the source dump be its own output** (output_path == source_path) to corrupt the irreplaceable original. | `twinrunner-core::build` / `flash` / TB-006 / DF-010 | `test_RULE001_source_never_written` (byte-for-byte unchanged assertion) |
| **ABU-006** | A user **deliberately puts a CPU key into an operation message** (e.g. pastes it into a labelled field that gets logged) to test whether it leaks to the log file. | `twinrunner-core::log` / TB-005 / DF-007 | `test_REQNFR007_key_redacted_in_log`, `test_REQNFR007_sha256_not_redacted` |
| **ABU-007** | A **config file edited to redirect `log_file_path`** at a sensitive/shared location, then relying on a missed redaction to harvest keys. | `twinrunner-core::config` (TB-004) → `twinrunner-core::log` (TB-005) | `test_REQNFR007_redaction_runs_regardless_of_log_path` |
| **ABU-008** | Forcing the **real backend** to run (selecting RealStub via config) to test whether any real write path exists. | `twinrunner-core::build`/`flash` ports / RULE-006 | `test_REQ020_real_build_stub_notimplemented`, `test_REQ022_real_flash_stub_notimplemented_writes_nothing` |

---

## Mitigations (→ components/REQs)

| MIT-ID | Mitigation | Component | Addresses | REQ-ID |
|--------|-----------|-----------|-----------|--------|
| **MIT-001** | KeyLibrary, log, and config files live under the platform data/config dir created on first run; access is bounded by the **OS file-permission model** (the only access boundary). | `twinrunner-core::config` | THR-001, THR-007, Auth | REQ-033, REQ-NFR-002 |
| **MIT-002** | **Unconditional CPU-key redaction on every `log::append`**: replace any `[0-9a-fA-F]{32}` word-bounded run (so 64-hex SHA-256 and shorter CRCs are untouched) with `REDACTED_CPU_KEY`, plus redact any `cpu_key`-keyed payload field by name (defense-in-depth). Runs before in-memory store and before the file mirror. | `twinrunner-core::log` | THR-002, ABU-006, ABU-007 | REQ-NFR-007 (INV-006; §06 redaction algorithm) |
| **MIT-003** | **Size-class gate:** reject any file whose length is not exactly one of {16,64,256,512} MB before structural parsing. | `twinrunner-core::nand` | THR-003, THR-004, ABU-002 | REQ-001, RULE-009 |
| **MIT-004** | **No-panic contract:** every parse/validate failure returns a typed `ValidationIssue`/`Error`, never a panic; a malformed dump leaves the UI in a safe state. | `twinrunner-core::nand`, `twinrunner-core::error` | THR-003, ABU-001 | REQ-NFR-003, REQ-NFR-011 |
| **MIT-005** | **Offset-checked, bounded region reads:** all FlashConfig/ECC/region accesses are bounds-checked against `raw_bytes.len()`; no unchecked indexing or unbounded seek loops; offsets validated before use. | `twinrunner-core::nand` | THR-003, ABU-001 | REQ-002, REQ-007, REQ-NFR-003 |
| **MIT-006** | **Bounded dump read:** cap the load read at the maximum recognized SizeClass (512 MB) and reject by length first, so a huge/garbage/pipe target cannot allocate unbounded memory. | `twinrunner-core::nand` | THR-004, ABU-002 | REQ-001, REQ-NFR-003, RULE-009 |
| **MIT-007** | **Bounded import read + field caps:** cap the import-file read length and enforce the FS-001/FS-002 field-length limits (`label` ≤128, `notes` ≤4096, `serial` ≤32, ≤20 payload keys) during import. | `twinrunner-core::keys` | THR-004, THR-008, ABU-003 | REQ-014, REQ-NFR-003 |
| **MIT-008** | **Output ≠ source refusal:** reject any build/flash op whose output_path equals the source dump path, before any write (`ERR-017 OutputEqualsSource`). | `twinrunner-core::build`, `twinrunner-core::flash` | THR-005, THR-006, ABU-004, ABU-005 | REQ-035, RULE-001 |
| **MIT-009** | **Export ≠ library refusal:** `keys::export` rejects an output path equal to `library_path` so the canonical library cannot be clobbered by an export. | `twinrunner-core::keys` | THR-005, ABU-004 | REQ-014 |
| **MIT-010** | **Path canonicalization + atomic write:** resolve and validate the user output path (reject when it resolves to the source/library); write via temp-file + rename so a partial/aborted write never lands at the target (INV-001). | `twinrunner-core::build`, `twinrunner-core::keys`, `twinrunner-core::nand` | THR-005, THR-006 | REQ-035, RULE-001 |
| **MIT-011** | **Read-only source open:** the only component that opens the source path opens it read-only and closes it immediately after reading; no writer ever targets the source (IF-001 postcondition). | `twinrunner-core::nand` | THR-006 | REQ-035, RULE-001 |
| **MIT-012** | **Per-record format validation on library load:** records whose `cpu_key` fails the 32-hex check are skipped with a Warning, never loaded; only `ValidatedFormat` records persist (RULE-014). | `twinrunner-core::keys` | THR-007, THR-008 | REQ-011, REQ-012, RULE-004/014 |
| **MIT-013** | **Schema-version upper-bound check:** reject FS-001/FS-002 files whose `schema_version` exceeds the supported version (`ERR-010 SchemaVersionTooNew`); corrupt JSON → empty library + Warning, never a crash. | `twinrunner-core::keys` | THR-007, THR-008 | REQ-012, REQ-014 |
| **MIT-014** | **Config invalid-value fallback:** unknown keys ignored, invalid values fall back to per-field defaults with a startup Warning; the app never aborts on a bad config. | `twinrunner-core::config` | THR-007 | REQ-033 |
| **MIT-015** | **Import per-record discipline:** 32-hex skip-with-Warning, unknown `console_type` → null+Warning, duplicate/already-existing id skipped (no overwrite), malformed file rejected wholesale (`ERR-013`). | `twinrunner-core::keys` | THR-008, ABU-003 | REQ-014 |
| **MIT-016** | **Real-backend stubs are no-ops:** `RealStubBuildBackend`/`RealStubFlashBackend::prepare` return `NotImplemented` and write nothing; only the simulator adapter acts; a dedicated test asserts the real backend never produces output. | `twinrunner-core::build`, `twinrunner-core::flash` | THR-009, ABU-008 | REQ-020, REQ-022, REQ-NFR-004, RULE-006 |
| **MIT-017** | **Sensitive-field marking on export:** the `cpu_key` field in FS-003 (and FS-002) is explicitly schema-marked SENSITIVE so the export surface and downstream consumers treat it as key material. | `twinrunner-core::nand`, `twinrunner-core::keys` | THR-010 | REQ-008, REQ-014 |

---

## Residual Risks

> These are accepted, human-acknowledged at sign-off (§8). They are explicit example defaults, not
> silent deferrals.

| Residual | Source (THR-ID / ABU-ID) | Why accepted | Revisit trigger |
|----------|--------------------------|--------------|-----------------|
| **RES-001 — CPU keys stored plaintext at rest** in FS-001 (and FS-002 exports) — no encryption-at-rest. | THR-001 | **Accepted example default.** Encryption-at-rest is explicitly **Future Scope** (`02-scope.md` / OQ-1). The mitigating control is the OS file-permission model (MIT-001). This is the single most significant accepted exposure and is the headline item for human acknowledgement. | If TwinRunner is ever made multi-user, networked, or run on shared/synced storage, encryption-at-rest (and key-export passphrase protection) must be added before release. |
| **RES-002 — ConsoleInfo and key exports contain the plaintext CPU key by design.** | THR-010 / ABU-004 | **Accepted — intended feature.** Exporting key material is the whole point of FS-002 (key export) and an expected part of FS-003 (console info incl. key). Redacting it would break the feature. The field is schema-marked SENSITIVE (MIT-017); the user chooses the destination path. | If a "redacted/share-safe export" mode is requested, add an opt-out that omits/redacts `cpu_key`. |
| **RES-003 — NAND parser accuracy is bounded to bundled fixtures** (ARCH-RISK-003). | THR-003 | **Accepted.** The Xbox 360 NAND format is intricate; parsing is scoped to well-documented fields and driven by known-good fixtures, reporting unreadable fields as explicit-absent (RULE-010) rather than guessing. Security-wise the parser is hardened against crashes/over-reads (MIT-004/005/006); the residual is *accuracy*, not *safety*. | If the parser is extended to real-world arbitrary dumps beyond the fixture corpus, add a fuzzing harness over `nand::load`/`validate` and expand negative-test coverage. |
| **RES-004 — Simulated-only: no real-hardware attack surface, but also no real-write protection tested against hardware.** | THR-009 / ABU-008 | **Accepted by design.** The real backend is a no-op stub (RULE-006); there is no real device boundary to attack, and the no-write guarantee is asserted by test (MIT-016). The residual is that the *eventual* real backend (out of scope) would introduce a genuine hardware-write threat surface not modeled here. | When/if a real `BuildBackend`/`FlashBackend` is implemented, this threat model must be re-run with the real hardware boundary added (brick-risk, irreversible-write threats). |
| **RES-005 — Local filesystem tampering of FS-001/FS-004 is not cryptographically detected.** | THR-007 | **Accepted.** An attacker who already has local filesystem write access to the user's data dir is outside the tool's defensible boundary (the OS owns that boundary, MIT-001). The tool defends against *accidental/malformed* tampering (MIT-012/013/014) but not a deliberate local attacker with FS access. | If integrity-at-rest becomes a requirement (e.g. shared machine), add a MAC/signature over FS-001 and verify on load. |
