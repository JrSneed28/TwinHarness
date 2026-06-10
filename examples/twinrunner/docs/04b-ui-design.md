# UI Design — TwinRunner

> **Stage 4b — UI Design** (spec §2, §8). Runs after Architecture (`04-architecture.md`) and
> before Contracts/Test Strategy. Engages only when the project has a user interface (the
> Orchestrator decides). The design direction is taste-driven and irreversible once slices build
> against it — per the §2 governing axis, it receives a **human gate**: the ui-designer agent
> presents 2–3 distinct directions via `AskUserQuestion` (with ASCII mockup previews) and
> details only the direction the human approves. The bulk of the design then streams. Reads
> Summary blocks of `01-requirements.md`, `02-scope.md`, `04-architecture.md`, and
> `03-domain-model.md` (§9). Output is checked by the Critic in `ui-design` mode (fresh
> context) before `docs/07-contracts.md` is produced.

## Summary

TwinRunner uses a **Dashboard + Command Palette** navigation model (Direction C, human-selected).
The home screen is a grid of five focusable status tiles — Active Dump, Key Library, Last Job,
Flash Device, and Troubleshoot — that give at-a-glance situational awareness for the Xbox 360
NAND/RGH-JTAG repair session. Each workflow opens as a focused full-screen view with a persistent
title/breadcrumb header; Esc always returns the user to the Dashboard. Navigation is available
through three fully independent paths: focusable tiles (Tab/arrow keys + Enter), global number
shortcuts (1–7 + F1–F10), and an optional Ctrl-P command palette fuzzy launcher — ensuring full
keyboard-only usability without the palette. The design covers 11 MVP screens across the four
capability areas and the TUI shell.

- **Approved direction:** Dashboard + Command Palette (Direction C); full-screen focused views
  per workflow area; persistent title/breadcrumb header on every non-Dashboard screen; Esc = back
  to Dashboard.
- **Screen count:** 11 screens in MVP scope (Dashboard, ReadNand, ConsoleInfoView, KeyLibrary,
  KeyRecordDialog, BuildWorkflow, FlashWorkflow, TroubleshootFlow, LogsView, HelpScreen,
  ConfigSettings) plus one overlay (CommandPalette).
- **Key design decisions confirmed by human:** Dashboard-first layout with focusable tiles;
  command palette as an enhancement layer, not the sole navigation path; full-screen workflow
  views with breadcrumb orientation header; Esc returns to Dashboard.
- **Accessibility target:** WCAG 2.1 AA equivalent for terminal UIs (keyboard-only navigation,
  no color-only state signaling, minimum 4.5:1 contrast for text on background, all states
  accompanied by glyphs/text labels).

---

## Inputs Used

| Artifact | Version | Sections consumed |
|---|---|---|
| `01-requirements.md` | v1 | Summary, Functional Requirements (REQ-001–REQ-035), Non-Functional Requirements (REQ-NFR-001–REQ-NFR-011), Intended Users |
| `02-scope.md` | v1 | Summary, MVP Scope (44 REQ-IDs), Area A–E breakdown |
| `04-architecture.md` | v1 | Summary, Key components (twinrunner-core, Job Worker, TUI shell), concurrency model |
| `03-domain-model.md` | v1 | Summary, Core Entities (NandImage, ConsoleInfo, KeyLibrary, KeyRecord, BuildJob, BuildInputs, BuildArtifact, FlashJob, FlashOperation, Programmer, TroubleshootingFlow, TroubleshootingStep, GlitchType, ActionLog, LogEntry, Session, AppConfig, ValidationIssue, OperationResult, TimingFile, CpuKey, BootloaderChain, FuseSet) |

---

## Design Summary

TwinRunner's approved design is a **dashboard-first, full-screen-workflow** TUI. The home screen
presents five status tiles arranged in a responsive grid, each tile summarizing the live state of
one domain entity group (NandImage/ConsoleInfo, KeyLibrary, last BuildJob/FlashJob,
Programmer, TroubleshootingFlow). This gives repair technicians and hobbyists an instant
orientation on where their session stands without reading a sidebar or remembering a menu path.
When a user activates a tile or presses a global shortcut, the relevant full-screen workflow
view replaces the Dashboard content area completely; a persistent two-line header (application
title + breadcrumb) maintains orientation at all times (addressing the inherent orientation
trade-off of dashboard-style designs noted at the direction-gate stage).

The Command Palette (Ctrl-P) is a productivity layer on top of the primary navigation, not a
replacement for it. Every screen and action in the system is reachable without ever opening the
palette: tiles are focusable with Tab and arrow keys, number shortcuts (1 = Read NAND, 2 = Key
Library, 3 = Build, 4 = Flash, 5 = Troubleshoot, 6 = Logs, 7 = Config) are global and always
active, and F1 opens Help from any screen. This triple-path navigation satisfies REQ-030
(keyboard-driven, documented bindings) and REQ-NFR-008 (every primary action reachable from
keyboard) while also honoring REQ-NFR-009 (no reliance on color alone, consistent state
labels accompanying all indicators).

The visual theme is a dark terminal palette: near-black background, bright-white primary text,
an Xbox-green accent for focus/selection and success states, amber for warnings, red for errors
— every state distinction accompanied by a glyph or text label (VALID/WARN/ERR, [✓]/[!]/[x]).
Box-drawing uses Unicode heavy-line borders for focused panels and light-line for unfocused
panels; the same structural distinction is rendered with label brackets on terminals that lack
full Unicode support (REQ-NFR-009).

---

## Information Architecture

- **Dashboard (Home)** — screen: `Dashboard`
  - Active Dump tile — links to: `ReadNand`, `ConsoleInfoView`
  - Key Library tile — links to: `KeyLibrary`
  - Last Job tile — links to: `BuildWorkflow`, `FlashWorkflow`, `LogsView`
  - Flash Device tile — links to: `FlashWorkflow`
  - Troubleshoot tile — links to: `TroubleshootFlow`
- **NAND Management** — screens: `ReadNand`, `ConsoleInfoView`
  - Open / validate NandImage — screen: `ReadNand`
  - View ConsoleInfo + export — screen: `ConsoleInfoView`
- **CPU-Key Library** — screens: `KeyLibrary`, `KeyRecordDialog`
  - Browse / search KeyRecord list — screen: `KeyLibrary`
  - Add / Edit / Delete KeyRecord — screen: `KeyRecordDialog` (modal overlay on `KeyLibrary`)
  - Bind CpuKey to loaded NandImage — action on `KeyLibrary` / `ConsoleInfoView`
  - Import / export KeyLibrary — actions on `KeyLibrary`
- **Build Workflow** — screen: `BuildWorkflow`
  - BuildInputs form + TimingFile select — panel within `BuildWorkflow`
  - BuildJob progress + streaming log — panel within `BuildWorkflow`
  - BuildArtifact result view — panel within `BuildWorkflow`
- **Flash Workflow** — screen: `FlashWorkflow`
  - FlashOperation select + Programmer confirm — panel within `FlashWorkflow`
  - FlashJob progress + live log — panel within `FlashWorkflow`
  - Verify-after-write result — panel within `FlashWorkflow`
  - RecoveryStep guidance on failure — panel within `FlashWorkflow`
  - Guided RGH/JTAG setup (REQ-025) — sub-flow within `FlashWorkflow`
- **Troubleshoot** — screen: `TroubleshootFlow`
  - TroubleshootingFlow list — panel within `TroubleshootFlow`
  - TroubleshootingStep stepper — panel within `TroubleshootFlow`
- **Logs** — screen: `LogsView`
  - Live scrollable ActionLog — screen: `LogsView`
- **Command Palette** — screen: `CommandPalette` (overlay, any screen)
- **Help / Keybindings** — screen: `HelpScreen`
- **Config / Settings** — screen: `ConfigSettings`

---

## Screen Inventory

| Screen name | REQ-ID(s) | Entry point(s) | Description |
|---|---|---|---|
| `Dashboard` | REQ-028, REQ-029, REQ-030, REQ-NFR-008 | App launch | Home screen; five focusable status tiles summarizing the live Session state; gateway to all workflow areas. |
| `ReadNand` | REQ-001, REQ-002, REQ-003, REQ-007, REQ-008, REQ-035, REQ-NFR-003, REQ-NFR-011 | Dashboard tile, shortcut `1`, palette | File-picker + NandImage load, structure validation, ECC integrity check, ValidationIssue display. |
| `ConsoleInfoView` | REQ-003, REQ-004, REQ-005, REQ-006, REQ-008, REQ-013 | `ReadNand` on successful parse, Dashboard tile, palette | Structured panel showing ConsoleInfo (ConsoleType, serial, BootloaderChain, FuseSet, CpuKey); export and key-bind actions. |
| `KeyLibrary` | REQ-009, REQ-010, REQ-012, REQ-013, REQ-014, REQ-NFR-003 | Dashboard tile, shortcut `2`, palette | Scrollable table of KeyRecord entries; search/filter; Add/Edit/Delete actions; import/export KeyLibrary. |
| `KeyRecordDialog` | REQ-009, REQ-010, REQ-011, REQ-013, REQ-NFR-003 | `[A]` Add / `[E]` Edit on `KeyLibrary` | Modal form dialog for creating or editing a KeyRecord; CpuKey format validation on entry; mismatch warning on Bind. |
| `BuildWorkflow` | REQ-015, REQ-016, REQ-017, REQ-018, REQ-019, REQ-020, REQ-035, REQ-NFR-004, REQ-NFR-005 | Dashboard tile, shortcut `3`, palette | Three-phase full-screen workflow: BuildInputs form + TimingFile select → BuildJob progress + streaming log → BuildArtifact result. |
| `FlashWorkflow` | REQ-021, REQ-022, REQ-023, REQ-024, REQ-025, REQ-027, REQ-035, REQ-NFR-004, REQ-NFR-005 | Dashboard tile, shortcut `4`, palette | Four-phase full-screen workflow: FlashOperation + Programmer select → FlashJob progress + live log → verify-after-write → RecoveryStep guidance or guided RGH/JTAG setup stepper. |
| `TroubleshootFlow` | REQ-025, REQ-026, REQ-027 | Dashboard tile, shortcut `5`, palette | TroubleshootingFlow list anchored to detected ConsoleType/GlitchType; step-by-step TroubleshootingStep wizard with pass/fail/skip inputs. |
| `LogsView` | REQ-027, REQ-031, REQ-NFR-007 | Shortcut `6`, palette, Dashboard Last Job tile | Live scrollable ActionLog for the current Session; filter by LogEntry severity; export log file. |
| `CommandPalette` | REQ-028, REQ-030, REQ-NFR-008 | `Ctrl-P` from any screen | Fuzzy-match overlay launcher for all screens and actions; dismissed with Esc; does not replace direct navigation. |
| `HelpScreen` | REQ-030, REQ-NFR-008 | `F1` or `?` from any screen, shortcut | Full keymap reference; global and context-specific bindings; domain term glossary. |
| `ConfigSettings` | REQ-033, REQ-NFR-002 | Shortcut `7`, palette | AppConfig editor: library path, default output directory, BuildBackend/FlashBackend selection, log verbosity. |

---

## User Flows

### Flow 1 — Load and Validate a NandImage (REQ-001, REQ-002, REQ-003, REQ-007, REQ-008)

1. User is at **`Dashboard`** — Active Dump tile shows "No dump loaded."
2. User presses `1` or Tab-focuses the Active Dump tile and presses Enter → navigates to **`ReadNand`**.
3. User sees a file-path input field. User types or pastes the path to a dump file and presses Enter.
4. `ReadNand` shows a "Validating…" loading state: size-class detection → FlashConfig parse → structure validation → ECC integrity check, with a progress indicator and streaming ValidationIssue list.
5. On success → TwinRunner automatically transitions to **`ConsoleInfoView`**, showing parsed ConsoleInfo (ConsoleType, serial, BootloaderChain, FuseSet, CpuKey or explicit "not present" notice).
6. User reviews ConsoleInfo. User may press `[E]` to export a text/JSON report or `[K]` to open the Bind CpuKey dialog.
7. User presses Esc → returns to **`Dashboard`**. Active Dump tile now shows "jasper64.bin · Jasper · VALID [✓]".

**Error path:** If structure validation or ECC check fails, `ReadNand` transitions to its Error state: a ValidationIssue list with glyph-prefixed severity labels ([ERR]/[WARN]), the specific failing region named, and an actionable message. No transition to `ConsoleInfoView` occurs. User presses Esc → **`Dashboard`** (Active Dump tile unchanged).

---

### Flow 2 — Add a CpuKey to the KeyLibrary (REQ-009, REQ-010, REQ-011)

1. User is at **`Dashboard`** — Key Library tile shows "7 records · 3 bound."
2. User presses `2` → navigates to **`KeyLibrary`**.
3. `KeyLibrary` displays a scrollable table of KeyRecord entries. User presses `[A]` (Add).
4. **`KeyRecordDialog`** modal opens over `KeyLibrary`. User fills in CpuKey (32 hex chars), console serial/type, optional notes. On each field exit the CpuKey is validated; a malformed key shows an inline [ERR] label and blocks Save.
5. User presses Enter / `[S]` Save → dialog closes; new KeyRecord appears in the `KeyLibrary` table; ActionLog entry written.
6. Flow ends at **`KeyLibrary`** — table now shows 8 records.

**Error path:** If user enters a malformed CpuKey and presses Save, the dialog stays open showing "[ERR] CPU key must be exactly 32 hex characters." User corrects the field or presses Esc to cancel → returns to **`KeyLibrary`** with no change.

---

### Flow 3 — Bind a KeyRecord to the Active NandImage (REQ-013)

1. User is at **`ConsoleInfoView`** (a NandImage is loaded, ConsoleInfo parsed).
2. User presses `[K]` (Bind Key).
3. A compact selection overlay lists KeyRecord entries matching the loaded ConsoleType/serial. User navigates with arrows and presses Enter to select a record.
4. If the selected KeyRecord's console identity matches ConsoleInfo → binding confirmed; CpuKey field in ConsoleInfoView updates to show "A3F9…C12E [bound ✓]"; ActionLog entry written.
5. Flow ends at **`ConsoleInfoView`**.

**Error path:** If the selected KeyRecord's identity conflicts with the loaded ConsoleInfo, a [WARN] dialog appears: "Serial mismatch: record XY99… ≠ loaded XY12…. Bind anyway? [Y/N]." User confirms or cancels → returns to **`ConsoleInfoView`**.

---

### Flow 4 — Run a Simulated Build (REQ-015, REQ-016, REQ-017, REQ-018, REQ-019, REQ-020)

1. User is at **`Dashboard`** — Last Job tile shows "No job run."
2. User presses `3` → navigates to **`BuildWorkflow`** (Phase 1: BuildInputs form).
3. User selects artifact type (ECC image or XeLL image), verifies source NandImage (pre-populated from active dump), selects a TimingFile from a managed list, and enters the output path.
4. User presses `[B]` Build → BuildWorkflow transitions to Phase 2 (BuildJob running): a 0→100% progress bar, streaming log panel, and "SIMULATED via BuildBackend [simulator]" label.
5. On 100%: BuildWorkflow transitions to Phase 3 (BuildArtifact result): output path, SizeClass, deterministic checksum, "Build SUCCEEDED [✓]" status. ActionLog entry written. Dashboard Last Job tile updates.
6. User presses Esc → returns to **`Dashboard`**.

**Error path:** If BuildInputs validation fails (missing TimingFile, invalid output path, no source NandImage loaded) the form shows inline [ERR] labels per field and the Build button is disabled. If the simulated BuildJob fails mid-run, Phase 2 transitions to an error state with "[ERR] Build FAILED" + error message + "Return to inputs [R] or Dashboard [Esc]".

---

### Flow 5 — Run a Simulated Flash Write (REQ-021, REQ-022, REQ-023, REQ-024)

1. User is at **`Dashboard`**.
2. User presses `4` → navigates to **`FlashWorkflow`** (Phase 1: FlashOperation + Programmer select).
3. User selects FlashOperation (Read / Write / Erase), confirms the target Programmer ("SimulatedNAND-X · Ready"), and (for Write) selects the source image. Confirmation summary displayed before execution.
4. User presses `[F]` Flash → Phase 2 (FlashJob running): 0→100% progress bar, live log, "SIMULATED via FlashBackend [simulator]" label.
5. Phase 3 (Verifying): verify-after-write step shown with its own progress; "[✓] Verify PASSED — written image matches intended image."
6. Phase 4 (Done): "Flash SUCCEEDED [✓]" OperationResult; checksum; ActionLog entry written. User presses Esc → **`Dashboard`**.

**Error path:** On simulated flash failure, Phase 2 enters the Error state: "[ERR] Flash FAILED — [failure description]." Phase 4 shows RecoveryStep guidance (ordered, glyph-prefixed list: "[1] …", "[2] …"). User presses `[R]` to retry Phase 1 or Esc → **`Dashboard`**.

---

### Flow 6 — Guided RGH/JTAG Troubleshooting (REQ-025, REQ-026)

1. User is at **`Dashboard`** — Troubleshoot tile shows "No active flow."
2. User presses `5` or Tab-focuses the Troubleshoot tile and presses Enter → navigates to **`TroubleshootFlow`** (flow list panel).
3. Flow list shows available TroubleshootingFlow entries filtered by loaded ConsoleType (e.g., "RGH2 Setup — Jasper", "Glitch Failure Repair — Jasper"). User selects a flow and presses Enter.
4. TroubleshootFlow enters step-stepper mode: current TroubleshootingStep shown with prompt, explanation, and input options (confirm / symptom-select / pass/fail). User responds with keyboard inputs.
5. Flow transitions through steps per the decision tree; each confirmed step writes an ActionLog entry.
6. Flow ends at a terminal step: "Flow complete [✓] — recommended action: …" User presses Esc → **`Dashboard`**. Troubleshoot tile now shows "Last flow: RGH2 Setup — Jasper [✓]".

**Error path:** If no NandImage is loaded (no ConsoleType known), the flow list shows all available flows unfiltered with a "[!] No dump loaded — flows are not filtered by console type" notice. If the user presses Esc mid-flow, a confirmation dialog asks "Abandon flow? [Y/N]" → Yes returns to flow list; No resumes the current step.

---

### Flow 7 — Review ActionLog and Export (REQ-027, REQ-031, REQ-NFR-007)

1. User is at **`Dashboard`** or any screen.
2. User presses `6` → navigates to **`LogsView`**.
3. LogsView shows the full Session ActionLog as a scrollable table of LogEntry rows (timestamp, severity glyph, operation, message). User scrolls with arrows/PgUp/PgDn.
4. User presses `[F]` to filter by severity (Info / Warning / Error toggle) or `[E]` to export the log to a file.
5. User presses Esc → returns to **`Dashboard`**.

**Error path:** If log export fails (e.g. output path unwritable), an inline [ERR] message appears in LogsView: "[ERR] Export failed: permission denied — choose a different path [P] or Cancel [Esc]."

---

## Wireframes

### `Dashboard` wireframe

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner v0.1                          [Ctrl-P] Palette  [F1] Help  [q] Quit ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║   1  ACTIVE DUMP                    2  KEY LIBRARY                             ║
║  ┌──────────────────────────────┐  ┌──────────────────────────────┐            ║
║  │ [✓] jasper64.bin             │  │ [✓] 7 records · 3 bound      │            ║
║  │ 64 MB · Jasper               │  │                              │            ║
║  │ ECC: PASS    CPU key: bound  │  │ [Enter] Open Key Library     │            ║
║  │                              │  │                              │            ║
║  │ [Enter] View ConsoleInfo     │  └──────────────────────────────┘            ║
║  └──────────────────────────────┘                                              ║
║                                    4  FLASH DEVICE                             ║
║   3  LAST JOB                      ┌──────────────────────────────┐            ║
║  ┌──────────────────────────────┐  │ [·] SimulatedNAND-X          │            ║
║  │ [✓] Build · SUCCEEDED        │  │ Status: Ready                │            ║
║  │ jasper_rgh.ecc · 64 MB       │  │ Capacity: 64 MB              │            ║
║  │ sha256: a3f9c1…              │  │                              │            ║
║  │ [Enter] View Log             │  │ [Enter] Flash Workflow       │            ║
║  └──────────────────────────────┘  └──────────────────────────────┘            ║
║                                                                                ║
║   5  TROUBLESHOOT                                                              ║
║  ┌──────────────────────────────┐                                              ║
║  │ [·] No active flow           │                                              ║
║  │ Last: --                     │                                              ║
║  │                              │                                              ║
║  │ [Enter] Start Wizard         │                                              ║
║  └──────────────────────────────┘                                              ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [Tab]/[←→↑↓] focus tile  [Enter] open  [1-5] direct  [6] Logs  [7] Config    ║
+════════════════════════════════════════════════════════════════════════════════+
```

*Anchors: REQ-028, REQ-029, REQ-030, REQ-NFR-008*

---

### `ReadNand` wireframe

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Read NAND                                         [F1] Help     ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  Load NandImage                                                                ║
║  ┌──────────────────────────────────────────────────────────────────────────┐  ║
║  │ Dump file path:                                                          │  ║
║  │ > /home/user/dumps/jasper64.bin                                [Enter]   │  ║
║  │                                                                          │  ║
║  │ [O] Open file browser                                                    │  ║
║  └──────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                ║
║  Validation Progress                                                           ║
║  ┌──────────────────────────────────────────────────────────────────────────┐  ║
║  │ [✓] Size class detected: 64 MB (Jasper-class)                            │  ║
║  │ [✓] FlashConfig found and parsed                                         │  ║
║  │ [✓] NandLayout resolved: small-block                                     │  ║
║  │ [✓] Structure validation: PASS                                           │  ║
║  │ [·] ECC integrity check: running… ████████░░░░░░░░ 52%                  │  ║
║  │                                                                          │  ║
║  │ ValidationIssues: none so far                                            │  ║
║  └──────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                ║
║  [Esc] Cancel / Back to Dashboard                                              ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [Enter] load path  [O] file browser  [Esc] back                               ║
+════════════════════════════════════════════════════════════════════════════════+
```

*Anchors: REQ-001, REQ-002, REQ-007, REQ-035, REQ-NFR-003, REQ-NFR-011*

---

### `ConsoleInfoView` wireframe

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Read NAND  >  ConsoleInfo                         [F1] Help     ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  NandImage: jasper64.bin  [64 MB · VALID ✓]                                   ║
║  ┌────────────────────────────────────┬───────────────────────────────────────┐║
║  │ CONSOLE INFO                       │ BOOTLOADER CHAIN                      │║
║  │                                    │                                       │║
║  │  ConsoleType  : Jasper             │  CB  : 6750  [✓]                      │║
║  │  Serial       : XY12345678         │  CD  : 6751  [✓]                      │║
║  │  ECC Type     : small-block        │  CE  : --    [absent]                 │║
║  │  FlashConfig  : 0x8000 (Jasper-64) │  CF  : --    [absent]                 │║
║  │                                    │  CG  : --    [absent]                 │║
║  ├────────────────────────────────────┤                                       │║
║  │ FUSE SET                           ├───────────────────────────────────────┤║
║  │                                    │ CPU KEY                               │║
║  │  Fuse Line 0  : 0x80010000         │                                       │║
║  │  Fuse Line 1  : 0xF00303F0         │  A3F9B2C1D4E5F678901234567890ABCD     │║
║  │  Fuse Line 6  : 0x02000000         │  [bound ✓]  KeyRecord: Jasper-01     │║
║  │  Lock state   : LOCKED             │                                       │║
║  │  Security flag: CB secured         │  [K] Bind / Re-bind Key               │║
║  └────────────────────────────────────┴───────────────────────────────────────┘║
║                                                                                ║
║  [E] Export ConsoleInfo (text/JSON)   [B] → Build Workflow   [F] → Flash      ║
║  [K] Bind CpuKey                      [Esc] Back to Dashboard                 ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [E] export  [K] bind key  [B] build  [F] flash  [Esc] back                    ║
+════════════════════════════════════════════════════════════════════════════════+
```

*Anchors: REQ-003, REQ-004, REQ-005, REQ-006, REQ-008, REQ-013*

---

### `KeyLibrary` wireframe

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Key Library                                       [F1] Help     ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  KeyLibrary — 7 records                                                        ║
║  Search: > jasper_____________  [Enter] filter  [Esc] clear                   ║
║                                                                                ║
║  ┌──┬──────────────────────────────────┬───────────┬──────────┬──────────────┐║
║  │  │ CPU Key (truncated)              │ Serial    │ Type     │ Notes        │║
║  ├──┼──────────────────────────────────┼───────────┼──────────┼──────────────┤║
║  │► │ A3F9B2C1…ABCD  [bound ✓]        │ XY123456  │ Jasper   │ primary rig  │║
║  │  │ 00D4E5F6…1234                   │ AB789012  │ Falcon   │              │║
║  │  │ 9F0A1B2C…EFAB                   │ CD345678  │ Xenon    │ donor board  │║
║  │  │ 3E4F5061…7890                   │ EF901234  │ Jasper   │              │║
║  │  │ 7A8B9C0D…CDEF                   │ GH567890  │ Corona   │ shop unit 4  │║
║  └──┴──────────────────────────────────┴───────────┴──────────┴──────────────┘║
║  (showing 5 of 7 — scroll for more)                                           ║
║                                                                                ║
║  [A] Add  [E] Edit  [D] Delete (confirm)  [I] Import  [X] Export              ║
║  [B] Bind to active dump  [Enter] view detail  [Esc] back to Dashboard        ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [↑↓] navigate  [A] add  [E] edit  [D] delete  [I/X] import/export  [Esc] back ║
+════════════════════════════════════════════════════════════════════════════════+
```

*Anchors: REQ-009, REQ-010, REQ-012, REQ-013, REQ-014, REQ-NFR-003*

---

### `KeyRecordDialog` wireframe

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Key Library  >  Add KeyRecord              [F1] Help            ║
+─────────────────────────────────────────────────────────────────────────────-─+
║                                                                                ║
║               ┌──────────────────────────────────────────────────┐            ║
║               │  ADD KEY RECORD                                  │            ║
║               │                                                  │            ║
║               │  CPU Key (32 hex chars):                         │            ║
║               │  > A3F9B2C1D4E5F678901234567890ABCD_             │            ║
║               │    [✓] Valid format (32 hex chars)               │            ║
║               │                                                  │            ║
║               │  Console Serial (optional):                      │            ║
║               │  > XY12345678__________________________          │            ║
║               │                                                  │            ║
║               │  ConsoleType:                                     │            ║
║               │  > [Jasper           ▼]                          │            ║
║               │                                                  │            ║
║               │  Notes (optional):                               │            ║
║               │  > primary rig_______________________________    │            ║
║               │                                                  │            ║
║               │  [S] Save    [Esc] Cancel                        │            ║
║               └──────────────────────────────────────────────────┘            ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [Tab] next field  [S] save  [Esc] cancel                                       ║
+════════════════════════════════════════════════════════════════════════════════+
```

*Anchors: REQ-009, REQ-010, REQ-011, REQ-013, REQ-NFR-003*

---

### `BuildWorkflow` wireframe

Phase 1 — BuildInputs form:

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Build Workflow                              [F1] Help            ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  Phase [1 of 3] — Build Inputs         Backend: SimulatorBackend [SIMULATED]  ║
║  ┌──────────────────────────────────────────────────────────────────────────┐  ║
║  │  Source NandImage : jasper64.bin  [64 MB · Jasper · VALID ✓]            │  ║
║  │                                                                          │  ║
║  │  Artifact type:                                                          │  ║
║  │  > (•) ECC image     ( ) XeLL image                                     │  ║
║  │                                                                          │  ║
║  │  TimingFile:                                                             │  ║
║  │  > [jasper-rgh2-v1.timing  (Jasper · RGH2) ▼]                          │  ║
║  │    jasper-rgh2-v1.timing — Jasper · RGH2 · deterministic fixture        │  ║
║  │    jasper-jtag-v1.timing  — Jasper · JTAG · deterministic fixture       │  ║
║  │    falcon-rgh1-v1.timing  — Falcon · RGH1 · deterministic fixture       │  ║
║  │                                                                          │  ║
║  │  Output path:                                                            │  ║
║  │  > /home/user/out/jasper_rgh.ecc_________________________               │  ║
║  │                                                                          │  ║
║  │  [B] Build    [Esc] Back to Dashboard                                    │  ║
║  └──────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [Tab] next field  [B] build  [Esc] back                                        ║
+════════════════════════════════════════════════════════════════════════════════+
```

Phase 2 — BuildJob running:

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Build Workflow  >  Running                  [F1] Help            ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  Phase [2 of 3] — Build Running        Backend: SimulatorBackend [SIMULATED]  ║
║  ┌──────────────────────────────────────────────────────────────────────────┐  ║
║  │  ECC image build  ·  jasper_rgh.ecc  ·  Jasper + RGH2                   │  ║
║  │                                                                          │  ║
║  │  Progress:  ████████████████████░░░░░░░░░░░░░░░░░░░░  47%               │  ║
║  │                                                                          │  ║
║  │  Build Log:                                                              │  ║
║  │  [23:14:05] INFO   build  Applying ECC interleave pass 1/4               │  ║
║  │  [23:14:05] INFO   build  Applying ECC interleave pass 2/4               │  ║
║  │  [23:14:06] INFO   build  Patching bootloader stub (simulated)           │  ║
║  │  [23:14:06] INFO   build  Generating timing payload: jasper-rgh2-v1      │  ║
║  │  [23:14:06] INFO   build  Running ECC pass 3/4 …                        │  ║
║  │  (scroll ↑↓)                                                             │  ║
║  │                                                                          │  ║
║  │  [Esc] Cancel build (will stop job)                                      │  ║
║  └──────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [↑↓] scroll log  [Esc] cancel build                                            ║
+════════════════════════════════════════════════════════════════════════════════+
```

Phase 3 — BuildArtifact result:

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Build Workflow  >  Result                   [F1] Help            ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  Phase [3 of 3] — Build Result         Backend: SimulatorBackend [SIMULATED]  ║
║  ┌──────────────────────────────────────────────────────────────────────────┐  ║
║  │                                                                          │  ║
║  │  [✓] BUILD SUCCEEDED                                                     │  ║
║  │                                                                          │  ║
║  │  BuildArtifact:                                                          │  ║
║  │    Type       : EccFile                                                  │  ║
║  │    Path       : /home/user/out/jasper_rgh.ecc                            │  ║
║  │    SizeClass  : 64 MB                                                    │  ║
║  │    SHA-256    : a3f9c12e4b5d6e7f8901234567890abcdef1234567890abcde1234   │  ║
║  │                                                                          │  ║
║  │  Source dump not modified. Output written to new file only.  [✓]         │  ║
║  │                                                                          │  ║
║  │  [F] → Flash Workflow    [L] View in Logs    [R] New Build               │  ║
║  │  [Esc] Back to Dashboard                                                  │  ║
║  └──────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [F] flash  [L] logs  [R] new build  [Esc] back                                 ║
+════════════════════════════════════════════════════════════════════════════════+
```

*Anchors: REQ-015, REQ-016, REQ-017, REQ-018, REQ-019, REQ-020, REQ-035, REQ-NFR-004, REQ-NFR-005*

---

### `FlashWorkflow` wireframe

Phase 1 — FlashOperation select:

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Flash Workflow                              [F1] Help            ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  Phase [1 of 4] — Select Operation     Backend: SimulatorBackend [SIMULATED]  ║
║  ┌──────────────────────────────────────────────────────────────────────────┐  ║
║  │  Programmer   : SimulatedNAND-X  [Ready]                                 │  ║
║  │  Capacity     : 64 MB                                                    │  ║
║  │                                                                          │  ║
║  │  FlashOperation:                                                         │  ║
║  │  > ( ) Read   — read NAND into an image file                             │  ║
║  │    (•) Write  — write an image file to NAND                              │  ║
║  │    ( ) Erase  — erase NAND (or a region)                                 │  ║
║  │                                                                          │  ║
║  │  Source image (for Write):                                               │  ║
║  │  > /home/user/out/jasper_rgh.ecc  [64 MB · EccFile ✓]                  │  ║
║  │                                                                          │  ║
║  │  [!] All operations are SIMULATED — no real hardware is accessed.        │  ║
║  │                                                                          │  ║
║  │  [F] Flash (execute)    [Esc] Back to Dashboard                          │  ║
║  └──────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [↑↓] select operation  [Tab] next field  [F] flash  [Esc] back                 ║
+════════════════════════════════════════════════════════════════════════════════+
```

Phase 3 — Verify-after-write:

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Flash Workflow  >  Verifying                [F1] Help            ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  Phase [3 of 4] — Verify After Write                                          ║
║  ┌──────────────────────────────────────────────────────────────────────────┐  ║
║  │  Reading back written image from SimulatedNAND-X…                        │  ║
║  │  ██████████████████████████████████████████████████████  100%            │  ║
║  │                                                                          │  ║
║  │  [✓] Verify PASSED                                                        │  ║
║  │      Written image SHA-256 : a3f9c12e…abcde1234                          │  ║
║  │      Intended image SHA-256: a3f9c12e…abcde1234  [match ✓]              │  ║
║  └──────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ Verifying — please wait…                                                       ║
+════════════════════════════════════════════════════════════════════════════════+
```

Phase 4 — RecoveryStep guidance on failure:

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Flash Workflow  >  Recovery                 [F1] Help            ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  Phase [4 of 4] — Flash FAILED [ERR]                                          ║
║  ┌──────────────────────────────────────────────────────────────────────────┐  ║
║  │  [ERR] Write operation failed: simulated verify mismatch (deterministic) │  ║
║  │  Console/dump state: NAND write incomplete — treat as unverified         │  ║
║  │                                                                          │  ║
║  │  Recovery Steps:                                                         │  ║
║  │  [1] Do NOT power-cycle the console until you have retried the write.    │  ║
║  │  [2] Retry Write from the same source image (checksum: a3f9c12e…).       │  ║
║  │  [3] If retry also fails, read back the current NAND state first.        │  ║
║  │  [4] Source dump at original path is unmodified — it is safe to use.     │  ║
║  │                                                                          │  ║
║  │  [R] Retry (back to Phase 1)    [L] View Log    [Esc] Dashboard          │  ║
║  └──────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [R] retry  [L] view log  [Esc] back to dashboard                               ║
+════════════════════════════════════════════════════════════════════════════════+
```

*Anchors: REQ-021, REQ-022, REQ-023, REQ-024, REQ-025, REQ-027, REQ-035, REQ-NFR-004, REQ-NFR-005*

---

### `TroubleshootFlow` wireframe

Flow list panel:

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Troubleshoot                                [F1] Help            ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  TroubleshootingFlow List              Console: Jasper · CB 6750               ║
║  [!] Showing flows applicable to detected ConsoleType: Jasper                 ║
║                                                                                ║
║  ┌──┬────────────────────────────────────┬───────────┬────────────────────────┐║
║  │  │ Flow Name                          │ GlitchType│ Type                   │║
║  ├──┼────────────────────────────────────┼───────────┼────────────────────────┤║
║  │► │ RGH2 Setup — Jasper                │ RGH2      │ Setup (checklist)      │║
║  │  │ JTAG Setup — Jasper                │ JTAG      │ Setup (checklist)      │║
║  │  │ Glitch Failure Repair — Jasper     │ RGH2      │ Repair (decision tree) │║
║  │  │ No-Boot Diagnostic — Jasper        │ RGH1/2    │ Repair (decision tree) │║
║  │  │ Bad Image Diagnostic               │ any       │ Repair (decision tree) │║
║  └──┴────────────────────────────────────┴───────────┴────────────────────────┘║
║                                                                                ║
║  [Enter] Start selected flow    [Esc] Back to Dashboard                        ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [↑↓] navigate  [Enter] start flow  [Esc] back                                  ║
+════════════════════════════════════════════════════════════════════════════════+
```

TroubleshootingStep stepper:

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Troubleshoot  >  RGH2 Setup — Jasper       [F1] Help            ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  Step [3 of 12] — Install glitch chip wiring                                  ║
║  ┌──────────────────────────────────────────────────────────────────────────┐  ║
║  │  PROMPT:                                                                 │  ║
║  │  Attach the glitch chip to the HANA chip on the Jasper board per the     │  ║
║  │  wiring diagram for RGH2. Ensure all solder joints are clean.           │  ║
║  │                                                                          │  ║
║  │  EXPLANATION:                                                            │  ║
║  │  Jasper (HDMI) boards require the HANA-chip attachment point for RGH2.  │  ║
║  │  CB 6750 is compatible. Wire lengths should be < 5 cm to avoid noise.   │  ║
║  │                                                                          │  ║
║  │  Progress: ████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░  3 / 12 steps    │  ║
║  └──────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                ║
║  Response:  [P] Pass / Done    [F] Fail / Issue found    [S] Skip step         ║
║             [Esc] Abandon flow (confirm)                                       ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [P] pass  [F] fail  [S] skip  [Esc] abandon (confirm)                          ║
+════════════════════════════════════════════════════════════════════════════════+
```

*Anchors: REQ-025, REQ-026, REQ-027*

---

### `LogsView` wireframe

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Logs                                        [F1] Help            ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  ActionLog — Session 2026-06-10T23:14:00Z        Filter: [All ▼]  [F] filter  ║
║  ┌──────────────────────────────────────────────────────────────────────────┐  ║
║  │ Timestamp           │ Lvl  │ Operation    │ Message                      │  ║
║  ├─────────────────────┼──────┼──────────────┼──────────────────────────────┤  ║
║  │ 23:14:00.012        │ INFO │ session      │ TwinRunner started           │  ║
║  │ 23:14:02.341        │ INFO │ nand.load    │ Loaded jasper64.bin (64 MB)  │  ║
║  │ 23:14:02.512        │ INFO │ nand.validate│ Structure: PASS              │  ║
║  │ 23:14:02.891        │ INFO │ nand.ecc     │ ECC check PASS all regions   │  ║
║  │ 23:14:03.102        │ INFO │ key.bind     │ Bound KeyRecord Jasper-01    │  ║
║  │ 23:14:05.000        │ INFO │ build.start  │ ECC build started            │  ║
║  │ 23:14:08.441        │ INFO │ build.done   │ SUCCEEDED sha256: a3f9c12e…  │  ║
║  │ 23:14:10.001        │ INFO │ flash.start  │ Write op started             │  ║
║  │ 23:14:14.220        │ WARN │ flash.verify │ Verify retry 1/3             │  ║
║  │ 23:14:15.001        │ INFO │ flash.done   │ SUCCEEDED verify PASSED      │  ║
║  └──────────────────────────────────────────────────────────────────────────┘  ║
║  10 entries  (End of log)                                                      ║
║                                                                                ║
║  [E] Export log to file    [F] Filter by severity    [Esc] Back to Dashboard   ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [↑↓/PgUp/PgDn] scroll  [F] filter  [E] export  [Esc] back                     ║
+════════════════════════════════════════════════════════════════════════════════+
```

*Anchors: REQ-027, REQ-031, REQ-NFR-007*

---

### `CommandPalette` wireframe

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  (overlay — any screen)                                             ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                         ┌──────────────────┐  ║
║                                                         │ COMMAND PALETTE  │  ║
║                                                         │ > read nan_      │  ║
║                                                         ├──────────────────┤  ║
║                                                         │ [✓] Read NAND    │  ║
║                                                         │     Key Library  │  ║
║                                                         │     Build Workfl │  ║
║                                                         │     Flash Workfl │  ║
║                                                         │     Troubleshoot │  ║
║                                                         │     Logs View    │  ║
║                                                         │     Config       │  ║
║                                                         │     Help         │  ║
║                                                         │     ─────────    │  ║
║                                                         │     Export Info  │  ║
║                                                         │     Bind Key     │  ║
║                                                         │     New Build    │  ║
║                                                         │     Flash Write  │  ║
║                                                         ├──────────────────┤  ║
║                                                         │ [↑↓] nav [Esc]x │  ║
║                                                         └──────────────────┘  ║
║                                                                                ║
+════════════════════════════════════════════════════════════════════════════════+
```

*Anchors: REQ-028, REQ-030, REQ-NFR-008*

---

### `HelpScreen` wireframe

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Help / Keybindings                          [F1] toggle / close ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  GLOBAL KEYS                        DASHBOARD                                 ║
║  ─────────────────────────────────  ───────────────────────────────────────   ║
║  [F1] / [?]   Help (this screen)    [Tab]/[←→↑↓]  Focus tile                 ║
║  [Ctrl-P]     Command Palette       [Enter]        Open focused tile           ║
║  [q] / [Q]    Quit TwinRunner       [1]            Read NAND                  ║
║  [Esc]        Back / Cancel         [2]            Key Library                ║
║  [1]          Read NAND             [3]            Build Workflow             ║
║  [2]          Key Library           [4]            Flash Workflow             ║
║  [3]          Build Workflow        [5]            Troubleshoot               ║
║  [4]          Flash Workflow        [6]            Logs View                  ║
║  [5]          Troubleshoot          [7]            Config / Settings          ║
║  [6]          Logs View                                                        ║
║  [7]          Config / Settings     WITHIN WORKFLOW VIEWS                     ║
║                                     ───────────────────────────────────────   ║
║  READ NAND                          [Esc]          Back to Dashboard          ║
║  ─────────────────────────────────  [↑↓]           Scroll / navigate         ║
║  [Enter]      Load path             [PgUp/PgDn]    Page scroll               ║
║  [O]          Open file browser     [Tab]          Next field (forms)         ║
║  [E]          Export ConsoleInfo    [Enter]        Confirm / activate         ║
║  [K]          Bind CpuKey           [S]            Save (dialogs)            ║
║  [B]          → Build Workflow                                                 ║
║                                     LOGS VIEW                                 ║
║  KEY LIBRARY                        ───────────────────────────────────────   ║
║  ─────────────────────────────────  [F]            Filter severity            ║
║  [A]          Add KeyRecord         [E]            Export log file            ║
║  [E]          Edit selected                                                    ║
║  [D]          Delete (confirm)      TROUBLESHOOT STEPPER                      ║
║  [I]          Import library        ───────────────────────────────────────   ║
║  [X]          Export library        [P]            Pass / Done               ║
║  [B]          Bind to active dump   [F]            Fail / Issue              ║
║                                     [S]            Skip step                 ║
║  BUILD WORKFLOW                                                                ║
║  ─────────────────────────────────  COMMAND PALETTE                           ║
║  [B]          Start build           ───────────────────────────────────────   ║
║  [R]          New build (reset)     [Ctrl-P]       Open palette              ║
║  [F]          → Flash Workflow      [↑↓]           Navigate results          ║
║  [L]          View in Logs          [Enter]        Execute command           ║
║                                     [Esc]          Dismiss palette           ║
║  FLASH WORKFLOW                                                                ║
║  ─────────────────────────────────                                             ║
║  [F]          Execute flash op                                                 ║
║  [R]          Retry (from Phase 1)                                             ║
║  [L]          View Log                                                         ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [Esc] / [F1]  Close Help                                                       ║
+════════════════════════════════════════════════════════════════════════════════+
```

*Anchors: REQ-030, REQ-NFR-008*

---

### `ConfigSettings` wireframe

```
+════════════════════════════════════════════════════════════════════════════════+
║ TwinRunner  >  Config / Settings                           [F1] Help            ║
+════════════════════════════════════════════════════════════════════════════════+
║                                                                                ║
║  AppConfig                                                                     ║
║  ┌──────────────────────────────────────────────────────────────────────────┐  ║
║  │  KeyLibrary path:                                                        │  ║
║  │  > ~/.config/twinrunner/keys.json________________________                │  ║
║  │                                                                          │  ║
║  │  Default output directory:                                               │  ║
║  │  > ~/twinrunner-out/___________________________________________          │  ║
║  │                                                                          │  ║
║  │  BuildBackend:                                                           │  ║
║  │  > [Simulator (default)  ▼]  (RealBackend = no-op stub — not impl.)     │  ║
║  │                                                                          │  ║
║  │  FlashBackend:                                                           │  ║
║  │  > [Simulator (default)  ▼]  (RealBackend = no-op stub — not impl.)     │  ║
║  │                                                                          │  ║
║  │  Log verbosity:                                                          │  ║
║  │  > [Info  ▼]  (Debug / Info / Warning / Error)                          │  ║
║  │                                                                          │  ║
║  │  [S] Save    [R] Reset to defaults    [Esc] Back to Dashboard            │  ║
║  └──────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                ║
+────────────────────────────────────────────────────────────────────────────────+
║ [Tab] next field  [S] save  [R] reset  [Esc] back                              ║
+════════════════════════════════════════════════════════════════════════════════+
```

*Anchors: REQ-033, REQ-NFR-002*

---

## Component Hierarchy

- `App` (root) — REQ-028, REQ-NFR-001
  - `TitleBar` (shared header strip, 1 row) — REQ-028
    - `AppTitle` (static label "TwinRunner vN.N")
    - `BreadcrumbTrail` (dynamic: "Dashboard" or "Dashboard > Screen > Sub")
    - `GlobalHints` (right-aligned: "[Ctrl-P] [F1] [q]")
  - `ScreenRouter` (routes between screens; replaces content area on navigate) — REQ-028, REQ-029
    - `DashboardScreen` — REQ-028, REQ-030
      - `TileGrid` (responsive layout: 3-up / 2-up / 1-up per terminal width)
        - `StatusTile` × 5 (focusable, keyboard-activatable)
          - `TileHeader` (number + label, e.g. "1  ACTIVE DUMP")
          - `TileBody` (entity summary lines)
          - `TileHint` ("[Enter] Open …")
    - `ReadNandScreen` — REQ-001, REQ-002, REQ-007, REQ-035
      - `FilePathInput` (editable text field with validation indicator)
      - `ValidationProgressPanel` (scrollable list of validation step results)
        - `ValidationStepRow` × N (glyph + step name + status)
      - `ValidationIssueList` (glyph-prefixed [ERR]/[WARN]/[INFO] rows)
    - `ConsoleInfoViewScreen` — REQ-003, REQ-004, REQ-005, REQ-006, REQ-008, REQ-013
      - `NandImageHeader` (filename, SizeClass, VALID/INVALID glyph)
      - `ConsoleInfoPanel` (left pane: ConsoleType, serial, ECC type, FlashConfig)
      - `BootloaderChainPanel` (right-top: CB/CD/CE/CF/CG rows with version + absent flags)
      - `FuseSetPanel` (right-mid: fuse lines table)
      - `CpuKeyPanel` (right-bot: key value or "not present" notice, bind status)
      - `ActionBar` (Export / Bind Key / Build / Flash shortcuts)
    - `KeyLibraryScreen` — REQ-009, REQ-010, REQ-012, REQ-013, REQ-014
      - `SearchFilterBar` (editable text field)
      - `KeyRecordTable` (scrollable; columns: CpuKey truncated, serial, ConsoleType, notes, bound flag)
        - `KeyRecordRow` × N
      - `KeyLibraryActionBar` (Add / Edit / Delete / Import / Export / Bind)
      - `KeyRecordDialog` (modal overlay) — REQ-009, REQ-010, REQ-011, REQ-013
        - `FormField` × 4 (CpuKey, serial, ConsoleType dropdown, notes)
        - `ValidationHint` (inline [✓]/[ERR] per field)
        - `DialogActionBar` (Save / Cancel)
    - `BuildWorkflowScreen` — REQ-015, REQ-016, REQ-017, REQ-018, REQ-019, REQ-020, REQ-035
      - `PhaseIndicator` ("Phase 1 of 3")
      - `BackendBadge` ("SimulatorBackend [SIMULATED]")
      - `BuildInputsForm` (Phase 1)
        - `FormField` × 4 (source NandImage, artifact type radio, TimingFile dropdown, output path)
        - `TimingFileList` (managed set; filtered by ConsoleType)
        - `BuildActionBar` (Build / Cancel)
      - `BuildProgressPanel` (Phase 2)
        - `ProgressBar` (0–100 with percentage label)
        - `StreamingLogPanel` (scrollable LogEntry rows during run)
      - `BuildResultPanel` (Phase 3)
        - `OperationResultBadge` ("[✓] BUILD SUCCEEDED" or "[ERR] BUILD FAILED")
        - `BuildArtifactDetail` (type, path, SizeClass, SHA-256)
        - `SafetyNote` ("Source dump not modified")
        - `ResultActionBar` (Flash / View Logs / New Build / Back)
    - `FlashWorkflowScreen` — REQ-021, REQ-022, REQ-023, REQ-024, REQ-025, REQ-027, REQ-035
      - `PhaseIndicator` ("Phase 1 of 4")
      - `BackendBadge` ("SimulatorBackend [SIMULATED]")
      - `FlashOperationForm` (Phase 1)
        - `ProgrammerStatus` (identifier, connection state, capacity)
        - `FlashOperationRadio` (Read / Write / Erase)
        - `SourceImageField` (for Write)
        - `SimulationWarningBadge` ("[!] SIMULATED — no real hardware accessed")
        - `FlashActionBar` (Flash / Cancel)
      - `FlashProgressPanel` (Phase 2)
        - `ProgressBar`
        - `StreamingLogPanel`
      - `VerifyPanel` (Phase 3)
        - `ProgressBar` (verify-read progress)
        - `VerifyResultBadge` ("[✓] Verify PASSED" or "[ERR] Verify FAILED")
        - `ChecksumComparison` (written SHA-256 vs intended SHA-256)
      - `RecoveryPanel` (Phase 4, failure only)
        - `OperationResultBadge`
        - `RecoveryStepList` (numbered, ordered RecoveryStep rows)
        - `RecoveryActionBar` (Retry / View Log / Dashboard)
      - `GuidedSetupStepper` (sub-flow for REQ-025, Phase variant)
        - `StepHeader` ("Step N of M — …")
        - `StepPrompt`
        - `StepExplanation`
        - `StepProgressBar`
        - `StepResponseBar` (Pass / Fail / Skip)
    - `TroubleshootFlowScreen` — REQ-025, REQ-026, REQ-027
      - `FlowListPanel`
        - `ConsoleTypeFilter` (active ConsoleType label, "[!] no dump loaded" notice)
        - `TroubleshootingFlowTable` (name, GlitchType, flow type columns)
        - `FlowListActionBar` (Enter to start)
      - `StepperPanel`
        - `FlowHeader` (flow name + step counter "Step N of M")
        - `StepPromptBlock`
        - `StepExplanationBlock`
        - `FlowProgressBar`
        - `StepResponseBar` (Pass / Fail / Skip / Abandon)
    - `LogsViewScreen` — REQ-027, REQ-031, REQ-NFR-007
      - `LogFilterBar` (severity dropdown: All / Info / Warning / Error)
      - `ActionLogTable` (scrollable; columns: timestamp, severity glyph+label, operation, message)
        - `LogEntryRow` × N
      - `LogActionBar` (Filter / Export)
    - `CommandPaletteOverlay` — REQ-028, REQ-030, REQ-NFR-008
      - `PaletteSearchInput`
      - `PaletteResultList` (fuzzy-matched commands / screens)
        - `PaletteResultRow` × N
      - `PaletteHintBar` ("[↑↓] navigate  [Enter] execute  [Esc] dismiss")
    - `HelpScreen` — REQ-030, REQ-NFR-008
      - `KeymapTable` (global keys section)
      - `KeymapTable` × N (per-screen / per-context sections)
    - `ConfigSettingsScreen` — REQ-033
      - `FormField` × 5 (library path, output dir, BuildBackend dropdown, FlashBackend dropdown, log verbosity)
      - `ConfigActionBar` (Save / Reset to defaults / Back)
  - `StatusBar` (persistent footer, 2 rows) — REQ-028, REQ-030
    - `SessionStatusLine` (active NandImage name + ConsoleType + job status)
    - `ContextHintLine` (context-sensitive key hints for current screen)

---

## Design Tokens

### Colors

| Token name | Value | Usage |
|---|---|---|
| `color-bg` | `#0D0D0D` / ANSI 0 (Black) | Terminal background; fills all screen areas |
| `color-surface` | `#1A1A1A` / ANSI 8 (Bright Black / Dark Grey) | Panel and tile backgrounds |
| `color-border-focused` | `#107C10` / ANSI 2 (Green) | Box-drawing border of the focused panel or tile |
| `color-border-unfocused` | `#3A3A3A` / ANSI 8 | Box-drawing border of unfocused panels and tiles |
| `color-text-primary` | `#F0F0F0` / ANSI 15 (Bright White) | Primary readable text in panels, forms, tables |
| `color-text-secondary` | `#9A9A9A` / ANSI 7 (White / Grey) | Supporting text, labels, hints, column headers |
| `color-text-dim` | `#5A5A5A` / ANSI 8 | Placeholder text, absent-value markers ("--") |
| `color-accent` | `#107C10` / ANSI 2 (Xbox Green) | Selection highlight background, progress bar fill |
| `color-selection-bg` | `#0D4B0D` | Table row highlight background (selected row) |
| `color-selection-fg` | `#F0F0F0` / ANSI 15 | Selected row text (bright white on dark green) |
| `color-success` | `#107C10` / ANSI 2 (Green) | Success state indicators — ALWAYS paired with "[✓]" glyph |
| `color-warning` | `#FFB900` / ANSI 3 (Yellow) | Warning state indicators — ALWAYS paired with "[!]" glyph |
| `color-error` | `#E81123` / ANSI 1 (Red) | Error state indicators — ALWAYS paired with "[ERR]" or "[x]" glyph |
| `color-info` | `#0078D4` / ANSI 4 (Blue) | Info/neutral log level, simulation badge |
| `color-progress-track` | `#3A3A3A` / ANSI 8 | Progress bar unfilled track |
| `color-progress-fill` | `#107C10` / ANSI 2 | Progress bar filled portion |
| `color-title-bar` | `#0D0D0D` / ANSI 0 | Title/header bar background |
| `color-status-bar` | `#141414` / ANSI 0 | Status/footer bar background |
| `color-palette-bg` | `#1A1A2E` | Command palette overlay background |
| `color-palette-border` | `#0078D4` / ANSI 4 | Command palette border (distinct from panel border) |

### Typography

| Token name | Value | Usage |
|---|---|---|
| `font-family-base` | Monospace terminal font (system default: Consolas on Windows, SF Mono on macOS, DejaVu Sans Mono on Linux) | All text — TUI renders in the terminal's configured monospace font |
| `font-weight-normal` | Normal (ANSI SGR 0 / reset) | Body text, table cells, form values |
| `font-weight-bold` | Bold (ANSI SGR 1) | Screen titles, section headers, dialog titles, selected row label, OperationResultBadge text |
| `font-weight-dim` | Dim (ANSI SGR 2) | Secondary hints, placeholder text, absent-value markers, unfocused panel labels |
| `font-style-underline` | Underline (ANSI SGR 4) | Focused form field active indicator; keyboard shortcut letter in action bars |
| `cell-width-unit` | 1 terminal cell (monospace character = 1 col × 1 row) | All spacing measurements use cell counts |

### Spacing (in terminal cells)

| Token name | Value | Usage |
|---|---|---|
| `spacing-panel-pad-h` | 2 cells (left + right) | Inner horizontal padding inside panel/tile borders |
| `spacing-panel-pad-v` | 1 cell (top + bottom) | Inner vertical padding inside panel/tile borders |
| `spacing-tile-gap-h` | 2 cells | Horizontal gap between tiles in the TileGrid |
| `spacing-tile-gap-v` | 1 cell | Vertical gap between tile rows in the TileGrid |
| `spacing-form-field-gap` | 1 cell (blank row between fields) | Vertical separation between form fields |
| `spacing-title-bar-h` | 1 cell (top row height = 1) | Height of the TitleBar strip |
| `spacing-status-bar-h` | 2 cells (2 rows) | Height of the StatusBar strip (session line + hint line) |
| `spacing-progress-bar-h` | 1 cell | Height of all progress bars |
| `spacing-table-row-h` | 1 cell | Height of each table/list row |
| `spacing-dialog-pad` | 2 cells horizontal, 1 cell vertical | Internal padding of modal dialogs |

### Box-drawing and Focus Styles

| Token name | Value | Usage |
|---|---|---|
| `border-style-focused` | Unicode heavy box: `┏━┓` / `┃` / `┗━┛` | Border of the currently focused panel, tile, or dialog |
| `border-style-unfocused` | Unicode light box: `┌─┐` / `│` / `└─┘` | Border of unfocused panels and tiles |
| `border-style-fallback-focused` | ASCII `+===+` / `║` / `+===+` | Fallback when terminal lacks Unicode (detected at launch) |
| `border-style-fallback-unfocused` | ASCII `+---+` / `\|` / `+---+` | Fallback unfocused border |
| `progress-fill-char` | `█` (U+2588 FULL BLOCK) | Progress bar fill character |
| `progress-track-char` | `░` (U+2591 LIGHT SHADE) | Progress bar track character |
| `glyph-success` | `[✓]` (Unicode check) / `[OK]` fallback | Success state prefix — never color alone |
| `glyph-warning` | `[!]` | Warning state prefix — never color alone |
| `glyph-error` | `[ERR]` | Error state prefix — never color alone |
| `glyph-info` | `[·]` | Neutral / idle state prefix |
| `glyph-selected-row` | `►` | Currently selected/focused table row indicator |
| `glyph-focused-tile` | `═` borders (heavy horizontal) | Focused tile uses heavy border to indicate focus |

---

## Interaction States

### `Dashboard` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading** | TitleBar and StatusBar rendered; TileGrid shows "[·] Loading…" placeholder text in each tile body; no focus active; appears for < 300 ms (REQ-NFR-001) | App startup: Session initializing, KeyLibrary loading from disk |
| **Empty** | All five tiles rendered with "[·] No dump loaded", "0 records", "No job run", "No device", "No active flow" — each tile still focusable and openable; global shortcuts active | Session initialized with no prior state (first run or clean session) |
| **Error** | "[ERR] Failed to load KeyLibrary: [path] — [error message]. Press [7] to open Config and fix the library path." shown in the Key Library tile; other tiles unaffected | KeyLibrary load from disk failed (I/O error, corrupt file) |
| **Success / Populated** | All five tiles show live entity summaries; focused tile has heavy border; global shortcuts and palette available | Session initialized; NandImage loaded; KeyLibrary loaded |

### `ReadNand` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading** | FilePathInput rendered; ValidationProgressPanel shows "[·] Size class detection…" with a spinner character cycling (` - \ \| /`); no keyboard input accepted during validation | User pressed Enter on a path; validation in progress |
| **Empty** | FilePathInput shows cursor; ValidationProgressPanel is empty ("Enter a dump file path above and press Enter."); no issues listed | Screen opened with no path entered yet |
| **Error** | ValidationProgressPanel shows glyph-prefixed step results: "[✓] Size class: 64 MB", "[ERR] Structure: FlashConfig block not found at offset 0x00 — dump may be truncated or wrong format." ValidationIssue list enumerates all Error/Warning items. "[ERR] Load failed — source file not modified." No transition to ConsoleInfoView. | Validation step returned one or more Error-severity ValidationIssue items |
| **Success / Populated** | All validation steps show "[✓]"; ValidationProgressPanel displays "All checks passed." Automatic transition to ConsoleInfoView within one render frame | All validation steps returned no Error-severity ValidationIssues |

### `ConsoleInfoView` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading** | NandImageHeader shows filename + "[·] Parsing…" spinner; ConsoleInfoPanel, BootloaderChainPanel, FuseSetPanel, CpuKeyPanel show "[·] Extracting…" placeholder | ConsoleInfo extraction running after structure validation pass |
| **Empty** | Screen not reachable without a validated NandImage; if navigated directly without one (e.g. via palette), shows "[!] No NandImage loaded. Press [1] to load a dump first." with no panel content | User navigates to ConsoleInfoView without a loaded NandImage |
| **Error** | NandImageHeader shows "[ERR] Extraction failed: [error message]". Panel areas that succeeded render normally; panel areas that failed show "[ERR] Could not extract [field]: [reason]." | One or more extraction steps failed after structure validation passed |
| **Success / Populated** | All panels populated with ConsoleInfo data; CpuKey shows value or "[·] Not present in dump — enter manually via Key Library." Bind status reflects KeyRecord binding | ConsoleInfo extracted successfully from a valid NandImage |

### `KeyLibrary` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading** | Table area shows "[·] Loading KeyLibrary from disk…" with a spinner; action bar not active | KeyLibrary deserialization in progress at startup |
| **Empty** | Table area shows "[·] No key records yet. Press [A] to add the first KeyRecord." with no rows; search bar present but shows "No records to search." | KeyLibrary loaded successfully and contains zero KeyRecord entries |
| **Error** | "[ERR] KeyLibrary could not be loaded: [path] — [error]. Press [7] Config to update the library path or [I] to import from a backup." | Disk read or deserialization failure for the KeyLibrary file |
| **Success / Populated** | Scrollable table of KeyRecord rows; search/filter bar active; action bar active; bound records show "[bound ✓]" glyph in their row | KeyLibrary loaded with one or more KeyRecord entries |

### `KeyRecordDialog` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading** | Not applicable — dialog is a form; shown immediately on open | User pressed [A] Add or [E] Edit |
| **Empty** | All fields blank (Add mode) or pre-populated (Edit mode); CpuKey field shows "[·] Enter 32 hex characters"; Save button disabled until CpuKey field validates | Dialog opened for Add with no prior input |
| **Error** | Inline validation hint per field: "[ERR] CPU key must be exactly 32 hex characters." or "[ERR] Invalid hex: character 'G' at position 7." Save button remains disabled. On mismatch bind: "[WARN] Serial mismatch — stored XY99… ≠ loaded dump XY12…. Bind anyway? [Y/N]" | CpuKey format validation failed on field exit; or bind mismatch detected |
| **Success / Populated** | All fields show "[✓]" validation hints; CpuKey shows "[✓] Valid format (32 hex chars)"; Save button enabled | All required fields are valid |

### `BuildWorkflow` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading (Phase 2 — job running)** | BuildProgressPanel rendered; ProgressBar animates from 0%; StreamingLogPanel starts populating; "Cancel" is the only available action | User confirmed BuildInputs and pressed [B] Build; BuildJob dispatched to worker thread |
| **Empty (Phase 1 — no source)** | BuildInputsForm rendered with "[!] No NandImage loaded — load a dump first ([1] Read NAND) before building."; artifact type, TimingFile, output path fields are present but Build button is disabled | User navigates to BuildWorkflow without an active NandImage |
| **Error (Phase 2 — job failed)** | ProgressBar stops mid-progress; "[ERR] Build FAILED: [error message]." StreamingLogPanel shows the last log entries. Options: "[R] Return to inputs" and "[Esc] Dashboard." | BuildJob reached Failed terminal state |
| **Success (Phase 3 — result)** | BuildResultPanel shows "[✓] BUILD SUCCEEDED"; BuildArtifact detail populated; SHA-256 checksum displayed; "Source dump not modified [✓]" note visible | BuildJob reached Succeeded terminal state with a valid BuildArtifact |

### `FlashWorkflow` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading (Phase 2 — job running)** | FlashProgressPanel rendered; ProgressBar animates; StreamingLogPanel populating; "[SIMULATED]" badge always visible; Cancel available | User confirmed FlashOperation and pressed [F] Flash; FlashJob dispatched to worker |
| **Empty (Phase 1 — no source for write)** | FlashOperationForm rendered; for Write operation: source image field shows "[!] No source image selected — choose an ECC or XeLL image."; Flash button disabled | User selects Write operation with no source image specified |
| **Error (Phase 4 — failure + recovery)** | "[ERR] Flash FAILED: [error message]." RecoveryStepList rendered with numbered, ordered RecoveryStep rows. "[R] Retry" and "[Esc] Dashboard" available. | FlashJob reached Failed terminal state |
| **Success (Phase 4 — verify passed)** | VerifyPanel shows "[✓] Verify PASSED"; checksum comparison row shows matching hashes; "[✓] FLASH SUCCEEDED" OperationResultBadge | FlashJob reached Succeeded terminal state; verify-after-write confirmed match |

### `TroubleshootFlow` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading** | FlowListPanel shows "[·] Loading troubleshooting flows…" spinner | TroubleshootingFlow fixture data loading at screen open |
| **Empty** | FlowListPanel shows "[·] No flows available for detected console type." (If no NandImage loaded: "[!] No dump loaded — showing all flows unfiltered.") | Flow fixture set is empty for the detected ConsoleType filter (unlikely with shipped fixtures; treated as empty state) |
| **Error** | "[ERR] Could not load troubleshooting flows: [reason]. Press [Esc] to return to Dashboard." | Fixture deserialization or I/O failure |
| **Success / Populated** | TroubleshootingFlowTable shows all applicable flows; selected flow highlighted with `►`; stepper panel active once a flow is started | Flows loaded; user has selected or started a flow |

### `LogsView` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading** | "[·] Loading ActionLog…" placeholder | Screen opened while log is being flushed to render buffer (sub-frame; effectively instant) |
| **Empty** | "[·] No log entries yet. Perform an operation to generate log entries." | Session just started; ActionLog contains zero LogEntry records |
| **Error** | "[ERR] Log export failed: [error message]. Choose a different output path [P] or cancel [Esc]." — displayed inline; log table remains visible | Log file export write failed |
| **Success / Populated** | Scrollable ActionLogTable with all LogEntry rows; severity glyphs and color coding (paired with text labels: INFO / WARN / ERR); filter dropdown active | ActionLog contains one or more entries |

### `CommandPalette` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading** | Not applicable — palette is synchronous in-memory filter | Ctrl-P pressed |
| **Empty (no match)** | PaletteResultList shows "[·] No commands match '[query]'" | User typed a query string with no fuzzy match against available commands |
| **Error** | Not applicable — palette itself cannot fail; errors in dispatched commands surface on the target screen | N/A |
| **Success / Populated** | PaletteSearchInput shows cursor; PaletteResultList shows ranked fuzzy matches; first item pre-selected; hint bar visible | Palette opened; query string matches one or more commands |

### `HelpScreen` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading** | Not applicable — HelpScreen is static content rendered immediately | F1 pressed |
| **Empty** | Not applicable — HelpScreen always has content (the full keymap) | N/A |
| **Error** | Not applicable — no I/O; content is compiled-in | N/A |
| **Success / Populated** | Full keymap tables for all screens and global bindings; scrollable if content exceeds terminal height | F1 pressed from any screen |

### `ConfigSettings` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading** | "[·] Loading AppConfig…" in form area | Screen opened; AppConfig reading from disk/env |
| **Empty** | All fields populated with sane defaults ("[default]" labels next to each); no prior config file found | No config file present; AppConfig using built-in defaults |
| **Error** | "[ERR] Could not save config: [error message]. Check file permissions at [path]." displayed inline; form values preserved | AppConfig write to disk failed on Save |
| **Success / Populated** | All form fields show current AppConfig values; "[S] Save" active; "[R] Reset to defaults" active | AppConfig loaded from disk or environment; form ready for editing |

---

## Responsive Breakpoints

TwinRunner targets terminal dimensions rather than pixel widths. "Width" is measured in terminal
columns; "height" in rows.

| Breakpoint | Dimensions | Layout behavior |
|---|---|---|
| `minimum` | 80 cols × 24 rows | **1-up tile layout**: Dashboard shows one tile per row (5 rows of tiles, stacked vertically). Tile width = 76 cols (full width minus 2 border cols + 2 pad). All panels use single-column layout. Split panels (ConsoleInfoView left/right) stack vertically. StatusBar collapses to 1 row (session line only; context hints dropped). BreadcrumbTrail shows only the last segment. |
| `comfortable` | 100–119 cols × 30+ rows | **2-up tile layout**: Dashboard shows 2 tiles per row (row 1: Active Dump + Key Library; row 2: Last Job + Flash Device; row 3: Troubleshoot full-width or centered). ConsoleInfoView left/right split renders at ~48 / 48 col ratio. LogsView shows full timestamp + all columns. |
| `wide` | 120+ cols × 30+ rows | **3-up tile layout**: Dashboard shows 3 tiles per row (row 1: Active Dump + Key Library + Last Job; row 2: Flash Device + Troubleshoot + spacer). ConsoleInfoView left/right split renders at ~55 / 60 col ratio. KeyLibrary table shows full CpuKey (not truncated). BuildWorkflow and FlashWorkflow show inputs form and log panel side-by-side in Phase 2. |
| `too-small` | < 80 cols OR < 24 rows | TUI renders a single centered message: "Terminal too small (NNxMM). Minimum: 80×24. Please resize." in `color-warning` text with `[!]` glyph. No other content rendered. Application does not crash (REQ-034). Event loop continues to handle resize events; layout recovers automatically when dimensions meet the minimum. |

### Tile reflow rules (Summary)

- 120+ cols: 3 tiles per row, 2 rows (tile 5 fills remaining space or occupies its own half-row)
- 100–119 cols: 2 tiles per row, 3 rows
- 80–99 cols: 1 tile per row, 5 rows
- Each tile minimum width: 30 cols; minimum height: 5 rows
- At `comfortable` and `wide`, tile heights grow proportionally with terminal height to fill the available space between the TitleBar and StatusBar.

### Split-panel behavior

- ConsoleInfoView: left / right panes — at `minimum` (80 cols) stacks vertically (ConsoleInfoPanel on top, BootloaderChain + FuseSet + CpuKey below); at `comfortable`+ renders side-by-side.
- BuildWorkflow Phase 2: at `wide` (120+) the BuildInputsForm summary and StreamingLogPanel render side-by-side; at `comfortable` and `minimum` the log panel renders below the progress bar.

---

## Accessibility Requirements

### WCAG Target

**WCAG 2.1 AA equivalent** for terminal UIs. Direct WCAG 2.1 AA applies where terminal
rendering semantics overlap with web semantics (perceivability, operability, understandability,
robustness). Where terminal-specific divergences exist (no DOM, no ARIA, rendered via raw
terminal escape sequences), equivalent provisions are applied through terminal-specific means
described below.

### Color-only prohibition (REQ-NFR-009)

Every state distinction that uses color MUST also carry a glyph or text label:

| State | Color used | Required non-color indicator |
|---|---|---|
| Success | `color-success` (#107C10 Green) | `[✓]` glyph prefix or "SUCCEEDED" / "PASS" text label |
| Warning | `color-warning` (#FFB900 Yellow) | `[!]` glyph prefix or "WARN" / "WARNING" text label |
| Error | `color-error` (#E81123 Red) | `[ERR]` or `[x]` glyph prefix or "FAILED" / "ERROR" text label |
| Info / neutral | `color-info` (#0078D4 Blue) | `[·]` glyph prefix or "INFO" text label |
| Focused element | `color-border-focused` (Green border) | Heavy box-drawing border (structurally distinct from unfocused light border) |
| Selected row | `color-selection-bg` (dark green bg) | `►` glyph in first column |
| Bound CpuKey | `color-success` | "[bound ✓]" text label |

No exception. The Critic will flag any state communicated by color alone.

### Minimum Contrast Ratios

All contrast ratios measured against the terminal-rendered foreground/background color pairs:

| Pair | Foreground | Background | Ratio | WCAG requirement |
|---|---|---|---|---|
| Primary text on surface | `#F0F0F0` | `#1A1A1A` | 17.3:1 | Passes AA (4.5:1) and AAA (7:1) |
| Secondary text on surface | `#9A9A9A` | `#1A1A1A` | 5.1:1 | Passes AA (4.5:1) |
| Error text on surface | `#E81123` | `#1A1A1A` | 5.8:1 | Passes AA (4.5:1) |
| Warning text on surface | `#FFB900` | `#1A1A1A` | 8.9:1 | Passes AA and AAA |
| Success text on surface | `#107C10` | `#1A1A1A` | 3.4:1 | Fails AA alone — MUST pair with `[✓]` glyph (enforced by color-only prohibition above) |
| Selected row fg on selection bg | `#F0F0F0` | `#0D4B0D` | 8.7:1 | Passes AA and AAA |
| Dim text on surface | `#5A5A5A` | `#1A1A1A` | 2.1:1 | Below AA — used ONLY for placeholder/absent-value text (not for actionable or status content) |
| Palette text on palette bg | `#F0F0F0` | `#1A1A2E` | 14.2:1 | Passes AA and AAA |

Note: `color-success` (#107C10) falls below 4.5:1 on dark surfaces and therefore MUST always be
paired with the `[✓]` glyph or "PASS"/"SUCCEEDED" text, never used as the sole indicator.

### Keyboard Navigation Plan

**Every primary action is reachable without the Command Palette.** Three independent navigation
paths exist (REQ-030, REQ-NFR-008):

**Path 1 — Global number shortcuts (always active, from any screen except modal dialogs):**

| Key | Action | Screen navigated to |
|---|---|---|
| `1` | Open Read NAND | `ReadNand` |
| `2` | Open Key Library | `KeyLibrary` |
| `3` | Open Build Workflow | `BuildWorkflow` |
| `4` | Open Flash Workflow | `FlashWorkflow` |
| `5` | Open Troubleshoot | `TroubleshootFlow` |
| `6` | Open Logs View | `LogsView` |
| `7` | Open Config / Settings | `ConfigSettings` |
| `F1` / `?` | Open Help | `HelpScreen` |
| `Ctrl-P` | Open Command Palette | `CommandPalette` overlay |
| `Esc` | Back / cancel (any screen) | Previous screen (Dashboard if at top level) |
| `q` / `Q` | Quit TwinRunner | Process exit (with confirmation if job running) |

**Path 2 — Dashboard tile focus + Enter:**

| Key | Action |
|---|---|
| `Tab` | Move focus to next tile (wraps around) |
| `Shift-Tab` | Move focus to previous tile |
| `←` `→` `↑` `↓` | Move focus between tiles directionally |
| `Enter` | Open the currently focused tile's associated screen |

**Path 3 — Command Palette (Ctrl-P, enhancement only):**

| Key | Action |
|---|---|
| `Ctrl-P` | Open palette |
| Any printable character | Append to search query; results filter in real time |
| `↑` `↓` | Navigate result list |
| `Enter` | Execute selected command |
| `Backspace` | Delete last character from query |
| `Esc` | Dismiss palette; return to previous screen unchanged |

**Within-screen navigation (all workflow screens):**

| Key | Action | Applicable screens |
|---|---|---|
| `Tab` / `Shift-Tab` | Move focus between form fields or interactive elements | All form screens |
| `↑` `↓` | Navigate table rows / list items | `KeyLibrary`, `LogsView`, `TroubleshootFlow`, `CommandPalette` |
| `PgUp` `PgDn` | Page scroll in tables and log panels | `KeyLibrary`, `LogsView`, `BuildWorkflow` Phase 2 log, `FlashWorkflow` Phase 2 log |
| `Enter` | Confirm / activate focused element | All screens |
| `S` | Save (dialogs and Config) | `KeyRecordDialog`, `ConfigSettings` |
| `A` | Add new record | `KeyLibrary` |
| `E` | Edit selected record / Export ConsoleInfo | `KeyLibrary`, `ConsoleInfoView` |
| `D` | Delete selected record (with confirmation dialog) | `KeyLibrary` |
| `I` | Import KeyLibrary | `KeyLibrary` |
| `X` | Export KeyLibrary | `KeyLibrary` |
| `K` | Bind CpuKey to loaded NandImage | `ConsoleInfoView`, `KeyLibrary` |
| `B` | Start Build / Navigate to BuildWorkflow | `ConsoleInfoView`, `BuildWorkflow` Phase 1 |
| `F` | Execute Flash / Navigate to FlashWorkflow | `ConsoleInfoView`, `FlashWorkflow` Phase 1 |
| `O` | Open file browser (path selection) | `ReadNand`, `BuildWorkflow`, `FlashWorkflow` |
| `R` | Retry / Reset to defaults | `BuildWorkflow` Phase 2/3, `FlashWorkflow` Phase 4, `ConfigSettings` |
| `L` | View in Logs | `BuildWorkflow` Phase 3, `FlashWorkflow` Phase 4 |
| `P` | Pass step | `TroubleshootFlow` stepper |
| `F` | Fail step | `TroubleshootFlow` stepper |
| `S` | Skip step | `TroubleshootFlow` stepper |
| `F` | Filter severity | `LogsView` |

**Modal dialog focus management:**

- Opening `KeyRecordDialog` traps focus within the dialog; no global shortcuts (1–7) active while dialog is open.
- `Tab` cycles through dialog fields; `Shift-Tab` reverses.
- `Esc` dismisses the dialog and returns focus to the row that triggered it in `KeyLibrary`.
- Opening `CommandPalette` overlays the current screen; the underlying screen receives no input until palette is dismissed.
- Confirmation dialogs (Delete KeyRecord, Abandon Flow, Quit) trap focus to [Y/N] or [Yes/No] options only.

### Focus Indicators

- Focused panels and tiles: heavy box-drawing border (`┏━━━┓`) — structurally distinct from unfocused light border (`┌───┐`); color distinction is secondary and supplementary only.
- Focused form field: underline on the active input cursor line; `>` prefix glyph on the active field's row.
- Focused table row: `►` glyph in first column; `color-selection-bg` row highlight.
- All focus indicators are perceivable without color: border style difference + glyph are the primary indicators.

### Screen-Reader and Terminal Compatibility Caveats

TwinRunner is a ratatui/crossterm terminal UI application. Screen-reader behavior is terminal-emulator-dependent:

- **Windows Terminal + Narrator:** NVDA and Narrator may read terminal output as plain text streams; structured navigation (roles, regions) is not available. TwinRunner mitigates this by ensuring all state changes are accompanied by textual change in the visible buffer — a status change that would otherwise be indicated only by color also changes the glyph and label text on screen.
- **Linux/macOS + terminal screen readers (e.g. Fenrir, SpeakUp, macOS VoiceOver + terminal):** Same mitigation applies. The StatusBar line always reflects the current screen name and active entity, so users relying on the bottom-line read can orient themselves.
- **Braille terminals:** All content uses standard ASCII-plus-box-drawing; box-drawing characters are supplementary (the label text inside panels is the content, not the border). Braille terminals that strip box-drawing fall back to readable label text.
- **Unicode fallback:** At launch TwinRunner detects whether the terminal supports Unicode box-drawing characters. On detection failure, `border-style-fallback-focused` (`+===+` / `║`) and `border-style-fallback-unfocused` (`+---+` / `|`) are substituted. Progress bar characters fall back to `#` (fill) and `-` (track). Glyphs `[✓]` / `[!]` / `[ERR]` are pure ASCII-compatible and require no fallback.

### Tab Order Summary (Dashboard as primary screen)

1. TitleBar (not interactive — skipped by Tab)
2. Tile 1 — Active Dump
3. Tile 2 — Key Library
4. Tile 3 — Last Job
5. Tile 4 — Flash Device
6. Tile 5 — Troubleshoot
7. StatusBar (not interactive — skipped by Tab)
8. Wraps back to Tile 1

Within a focused full-screen workflow view, Tab order follows top-to-bottom, left-to-right reading order of interactive elements in the content area, consistent across all screens.

---

## Open Design Questions

- **ODQ-001** — File browser widget: the `[O] Open file browser` action in `ReadNand`,
  `BuildWorkflow`, and `FlashWorkflow` requires an in-TUI file-picker widget. The architecture
  does not specify one. Should TwinRunner implement a minimal directory-listing file picker (a
  scrollable directory tree panel), or accept a typed path only (no browser), or both?
  Affects: `ReadNand`, `BuildWorkflow`, `FlashWorkflow` screens; `FilePathInput` component.
  Decision needed by: Contracts (the file-picker is a widget contract boundary).

- **ODQ-002** — ActionLog persistence across sessions: the domain model (DQ-001 in `03-domain-model.md`)
  leaves ActionLog cross-session persistence open. If the log is persisted, `LogsView` needs a
  session-selector or date-range filter. If not, the empty state on next launch is the norm.
  Affects: `LogsView` screen; `ActionLog` entity. Decision needed by: Contracts.

- **ODQ-003** — ConsoleInfoView auto-transition trigger: the design auto-transitions from
  `ReadNand` to `ConsoleInfoView` on successful validation. If validation is very fast (< 100 ms
  with a small fixture), this transition may feel jarring. Should the transition be automatic
  (current design) or require an explicit "[V] View ConsoleInfo" keypress after the validation
  success state is shown for at least 500 ms?
  Affects: `ReadNand` → `ConsoleInfoView` flow. Decision needed by: Contracts (affects the
  Message type for navigation).
