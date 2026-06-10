# SLICE-1 / TASK-007 — ReadNand + ConsoleInfoView screens wired through the reducer

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-001, REQ-002, REQ-007, REQ-008, REQ-035
**Slice:** SLICE-1 — Read NAND & console info
**Depends on:** SLICE-1 / TASK-006 complete

---

## Goal

Wire the `ReadNand` and `ConsoleInfoView` screens through the `model::update` reducer: a `LoadDump`
message drives `nand::load`→`validate`→`extract` (via `Command::ReadDump` and follow-up messages),
the validation progress + named issues render in `ReadNand`, the parsed `ConsoleInfo` renders in
`ConsoleInfoView`, and an export action writes the FS-003 report — all keyboard-driven, with the
error path keeping the user in a safe state and the source byte-unchanged.

---

## REQ-IDs

- **REQ-001** — Open a dump and detect its size class; reject unknown sizes with a clear error.
- **REQ-002** — Validate structure before extraction; report invalid dumps actionably.
- **REQ-007** — ECC integrity check with the specific failing region reported.
- **REQ-008** — Structured console-info view + export to a text/JSON report.
- **REQ-035** — Loading is read-only with respect to the source file.

---

## Relevant Contracts / Interfaces

**IF-015 — reducer messages/commands this task uses:**

```
Message::LoadDump(path: String)        -> Command::ReadDump(path)   // I/O modeled as a Command (reducer stays pure)
Message::DumpLoaded(NandImage)         // folded result of ReadDump success
Message::DumpLoadFailed(ValidationIssue)
Message::RequestValidate               // triggers validate on the active NandImage
Message::RequestExtract                // triggers extract on the validated image
Message::ExportConsoleInfo(path)       -> Command::WriteFile { path, bytes }  // FS-003 JSON
Message::Navigate(Screen)              // Screen::ConsoleInfo on successful parse; Esc → Dashboard
```

The reducer is pure: `LoadDump` emits `Command::ReadDump`; the shell calls `nand::load` and folds
the result back as `DumpLoaded`/`DumpLoadFailed`. Validation/extraction run via the same
command→result pattern. Export emits `Command::WriteFile`.

---

## Relevant Design Notes — wireframes (embed; do not invent layout)

**`ReadNand`** (anchors REQ-001, REQ-002, REQ-007, REQ-035, REQ-NFR-003, REQ-NFR-011): a
`FilePathInput` (editable, `[Enter]` to load, `[O]` file browser), a `ValidationProgressPanel`
showing glyph-prefixed step rows (`[✓] Size class detected: 64 MB`, `[✓] FlashConfig found`,
`[✓] Structure validation: PASS`, `[·] ECC integrity check: running…`), and a `ValidationIssueList`
of `[ERR]`/`[WARN]` rows naming the failing region. On full pass → auto-transition to
`ConsoleInfoView`. On Error issues → stay; show the named failing region; **no** transition; source
file unmodified. `[Esc]` → Dashboard.

**`ConsoleInfoView`** (anchors REQ-003, REQ-004, REQ-005, REQ-006, REQ-008, REQ-013): header
`NandImage: <name> [<size> · VALID ✓]`; left `ConsoleInfoPanel` (ConsoleType, Serial, ECC Type,
FlashConfig); right `BootloaderChainPanel` (CB/CD/CE/CF/CG rows with version or `[absent]`),
`FuseSetPanel` (fuse lines table + lock/security state), `CpuKeyPanel` (key value or
`[·] Not present in dump`, bind status). Action bar: `[E] Export ConsoleInfo (text/JSON)`,
`[K] Bind CpuKey` *(bind is SLICE-2)*, `[B] → Build`, `[F] → Flash`, `[Esc] Back`.

**Accessibility (REQ-NFR-009):** every status uses a glyph/label, never color alone
(`[✓]`/`[!]`/`[ERR]`/`[·]`). Focused panel = heavy box border; unfocused = light border.

---

## Acceptance Test(s)

These slice-acceptance tests exercise the capability end-to-end through the reducer (no live
terminal — REQ-NFR-006). They re-confirm the core tests from TASK-004…006 are reachable via the
screen-driving messages:

- `test_REQ001_load_detects_size_class` — `LoadDump` of the 64 MB fixture yields a `NandImage` with
  `SizeClass::Mb64` in the Model. *(unit)*
- `test_REQ002_validate_happy_path_ok` — `RequestValidate` on the clean fixture yields no
  Error-severity issues in the Model. *(unit)*
- `test_REQ007_validate_ecc_failure_names_region` — a corrupt-region fixture surfaces a named
  `EccFailure` in the Model's issue list; no transition to `ConsoleInfoView`. *(unit)*
- `test_REQ008_console_info_export_json_roundtrip` — `ExportConsoleInfo(path)` writes FS-003 JSON
  that round-trips to an identical `ConsoleInfo`. *(unit + integration)*
- `test_REQ035_load_opens_source_read_only` — after the full screen-driven pipeline, the source
  fixture bytes are byte-identical. *(unit)*

---

## Definition of Done

- [ ] All acceptance tests pass; `ReadNand`→`ConsoleInfoView` flow is demonstrable from the keyboard.
- [ ] No state communicated by color alone (glyph/label on every state) — REQ-NFR-009 honored.
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] `th coverage check` does not regress (REQ-001, REQ-002, REQ-007, REQ-008, REQ-035 still map
      to passing tests).

---

## Out of Scope for This Task

- Bind CpuKey (`[K]`) behavior — SLICE-2 / TASK-009, TASK-011 (the button is present but its action
  lands in SLICE-2).
- The Dashboard tile that summarizes the active dump — SLICE-5 / TASK-019.
- File-browser widget internals (ODQ-001) — typed-path entry is sufficient here.
- Build/Flash navigation targets (`[B]`/`[F]`) beyond emitting `Navigate` — SLICE-3 / SLICE-4.
