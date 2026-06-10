# Scope — TwinRunner

> **Stage 2 — Scope Definition** (spec §14.2). Sticky, human-gated. Decides what is built now
> versus later. Once signed off, scope is intent — only a human moves it (§10). Reference REQ-IDs
> throughout so downstream mechanical traceability holds (§11, §17).

## Summary

TwinRunner is a cross-platform Rust TUI (ratatui + crossterm) that recreates the J-Runner-style
Xbox 360 NAND-management and RGH/JTAG repair workflow — read/validate NAND dumps, manage a CPU-key
library, build/patch images, run a simulated flash, and guide setup/troubleshooting — all backed by
a deterministic simulator so the full workflow is safe and testable without real hardware. The MVP
is strictly **TUI-interactive**: all four capability areas (A NAND read + extraction, B CPU-key
library, C simulated build/patch, D simulated flash + guided RGH/JTAG) plus the TUI shell and
cross-cutting infrastructure are MVP (REQ-001–REQ-031, REQ-033–REQ-035, REQ-NFR-001–REQ-NFR-009,
REQ-NFR-011 — 44 REQ-IDs); the scriptable/headless CLI surface (REQ-032, REQ-NFR-010) is deferred
to V1 by human sign-off decision.

- **MVP in one sentence:** A fully interactive, keyboard-driven ratatui TUI that reads and validates
  Xbox 360 NAND dump files, manages a CPU-key library, runs simulated build/patch and flash workflows
  with deterministic progress and recovery steps, and provides guided RGH/JTAG setup/troubleshooting
  — all backed by simulator traits; the scriptable/headless surface is a V1 deliverable.
- **Key items confirmed out of scope:** real hardware drivers and destructive writes to physical
  hardware; real xeBuild or bootable-image generation; networking, telemetry, or multi-user features.
- **Top scope risk:** The guided RGH/JTAG troubleshooting flow (REQ-026) can expand into an open-ended
  repair encyclopedia — bounded here to a finite, fixture-backed decision tree.

---

## Requirements Summary

TwinRunner's approved requirements (REQ-001–REQ-035, REQ-NFR-001–REQ-NFR-011) define a polished,
keyboard-driven Rust TUI that recreates the J-Runner Xbox 360 NAND/RGH-JTAG repair workflow for
console-repair hobbyists and technicians. The core goal is to deliver NAND dump reading and
validation, CPU-key library management, simulated build/patch image generation, and simulated
flashing with guided troubleshooting — all behind `FlashBackend` / `BuildBackend` Rust trait
abstractions whose real implementations are no-op stubs, making the entire workflow safe,
deterministic, and exercisable without hardware. The top success measure is: given a known-good 64 MB
NAND fixture, TwinRunner parses it, extracts CPU key + console type + bootloader versions, and a
simulated flash reports deterministic 0→100% progress with a verifiable result — with every risky
operation routed exclusively through the backend traits. This scope document governs all 46 REQ-IDs;
REQ-032 and REQ-NFR-010 (scriptable/headless surface) are placed in V1 by human sign-off decision.

---

## MVP Scope

Per the human-confirmed **maximal MVP** directive, all four capability areas and the TUI shell are
MVP. The MVP is strictly **TUI-interactive**: the scriptable/headless surface was deferred to V1 at
the scope sign-off gate (its REQ anchors live in the V1 Scope section). Every item below passes both pruning tests: it is
required for the first usable interactive version, and removing it would leave TwinRunner unable to
solve its core problem for its primary users. MVP acceptance testing exercises the TUI/engine layer
directly (state-update logic separated from rendering, per REQ-NFR-006) rather than CLI subcommands;
the headless-JSON success criterion from requirements is a V1 acceptance target.

### Area A — NAND Dump Read + Console-Info Extraction

- **NAND file open and size-class detection** — detect 16/64/256/512 MB classes, reject unknown
  sizes with a clear error. REQ-001
- **Dump structure validation** — size/length checks, header/FlashConfig presence, layout sanity;
  report structurally invalid dumps with an actionable message before any extraction. REQ-002
- **Core console-info extraction** — console/motherboard type (Xenon, Zephyr, Falcon, Jasper,
  Trinity/Corona-class), serial (where present), ECC/NAND layout type. REQ-003
- **Bootloader chain extraction** — CB/CD/CE/CF/CG versions present in the dump, displayed in a
  readable view. REQ-004
- **Fuse / FlashConfig extraction** — fuse lines, FlashConfig value, security-relevant fields
  surfaced for inspection. REQ-005
- **CPU key extraction and format validation** — extract or derive the CPU key; validate length/hex;
  explicitly report when a key cannot be derived rather than guessing. REQ-006
- **ECC integrity / NAND data sanity check** — per-region pass/fail; report the specific failing
  region; never silently pass a corrupt dump. REQ-007
- **Console-info view and text/JSON export** — structured, scannable panel/table showing extracted
  info; export to a text or JSON report file. REQ-008

### Area B — CPU-Key Library Management

- **Persistent CPU-key library** — per-console records (CPU key, serial/type identifier, optional
  notes/labels) stored across sessions. REQ-009
- **Add, edit, view, delete records via TUI forms/dialogs** — with confirmation on destructive
  actions. REQ-010
- **CPU-key validation on entry/import** — correct length and hex format enforced; malformed keys
  rejected with a clear message. REQ-011
- **Search / filter the key library** — look up by console identifier (serial, type, label). REQ-012
- **Bind a CPU key to a loaded dump** — associate the active dump's console with a library record;
  warn on console identity mismatch. REQ-013
- **Import and export the key library** — backup/transfer individual records or the full library in
  a documented file format. REQ-014

### Area C — Simulated Build / Patch Image Workflow

- **Guided build/patch workflow** — takes a loaded dump (or selected inputs) plus a chosen target;
  produces a patched output image via the simulated `BuildBackend`; never overwrites the source
  dump (operates on a copy / new path). REQ-015
- **Timing-file selection** — managed set of deterministic placeholder timing files; selection
  recorded in the build inputs. REQ-016
- **ECC file generation** — generate an ECC-formatted image via the simulator and write to a
  user-chosen output path. REQ-017
- **XeLL / recovery file generation** — generate a XeLL image via the simulator and write to a
  user-chosen output path. REQ-018
- **Deterministic build progress and verifiable result** — 0→100% progress display, streaming log,
  and a deterministic checksum/summary on completion that the same inputs always reproduce. REQ-019
- **`BuildBackend` trait/port isolation** — the simulator is the default; the real (xeBuild) backend
  is a clearly marked no-op stub that never produces real images. REQ-020

### Area D — Simulated Flash + Guided RGH/JTAG Troubleshooting

- **Flashing workflow with read/write/erase operations** — against a simulated programmer (NAND-X /
  J-Runner-style device); selected operation, target, and image shown clearly before execution.
  REQ-021
- **`FlashBackend` trait/port isolation** — simulator is the default; real hardware backend is a
  no-op stub; no real destructive write to physical hardware is possible. REQ-022
- **Deterministic flash progress, live log, and verify-after-write** — 0→100% progress, clear
  success/failure result, simulated verify-after-write step that confirms the written image matches
  the intended image. REQ-023
- **Flashing failure recovery steps** — on a simulated failure, present recovery guidance: state of
  the console/dump, what is safe to retry, how to avoid worsening the situation. REQ-024
- **Guided RGH/JTAG setup workflows** — ordered, checklist-style screens appropriate to the detected
  console/board type, with per-step explanations and confirmations. Covers the well-known board
  classes at fixture breadth (Xenon, Zephyr, Falcon, Jasper, Trinity/Corona-class). REQ-025
- **Guided RGH/JTAG repair / troubleshooting flow** — decision-tree / wizard that, given symptoms
  (no boot, glitch failing, bad image), proposes diagnosis and next actions anchored to extracted
  console info. Bounded to a finite, fixture-backed flow set. REQ-026
- **Structured log / history for all flashing and guided actions** — review what was done in order
  after the fact. REQ-027

### E — TUI Shell, Navigation, and Cross-Cutting Behavior

- **Full-screen interactive TUI** — ratatui + crossterm; persistent layout with main menu/navigation,
  content panels, and a status/footer area showing context and key hints. REQ-028
- **Reusable TUI widget layer** — panels, menus, dialogs/modals, forms with editable fields,
  scrollable tables/lists, progress views; thin focus/layout layer built on ratatui. REQ-029
- **Keyboard-driven navigation and actions** — documented key bindings for all primary actions; a
  help/keybindings screen. REQ-030
- **Live, scrollable log/console view** — streams progress and events from running operations;
  persists session history. REQ-031
- **Configuration** — config file and/or flags/environment for data/library locations, default paths,
  backend selection, log verbosity; sane defaults; app creates directories on first run. REQ-033
- **Graceful terminal resize** — no crash on resize; readable message if the terminal is too small.
  REQ-034
- **Copy/output-only mutations** — loads are read-only with respect to the source file; builds and
  flashes write to user-chosen output paths; source dumps are never modified in place. REQ-035

### Non-Functional Requirements — MVP (REQ-NFR-001–REQ-NFR-009, REQ-NFR-011)

- **REQ-NFR-001** — Fast launch (< 300 ms to first interactive frame); responsive UI during
  simulated operations.
- **REQ-NFR-002** — Cross-platform single Rust binary: Windows, Linux, macOS.
- **REQ-NFR-003** — Safety and validation first-class: input validation everywhere; no silent
  corruption.
- **REQ-NFR-004** — Simulated-backend safety: all hardware paths confined behind traits; no real
  destructive write possible; verifiable by test.
- **REQ-NFR-005** — Determinism: identical inputs always yield identical outputs, progress, and
  checksums.
- **REQ-NFR-006** — Testability: every functional REQ verifiable by automated test using bundled
  fixtures and simulator; TUI logic separated from rendering.
- **REQ-NFR-007** — Structured, timestamped logging: viewable in TUI and writable to a log file;
  sufficient for reconstruction.
- **REQ-NFR-008** — Keyboard-driven, discoverable UX: every primary action keyboard-reachable;
  in-app help screen.
- **REQ-NFR-009** — Terminal accessibility/robustness: resize handled; no color-only state
  signaling; tolerates limited terminals.
- **REQ-NFR-011** — Robust error handling: failures surfaced as typed, user-facing errors with
  recovery guidance; TUI never crashes into a corrupt state.

*(The scriptable/headless surface and its scriptability-robustness requirement are deferred to V1; see the V1 Scope section for the REQ anchors.)*

---

## V1 Scope

Items deferred from MVP because TwinRunner remains usable and solves its core problem without them
in the first version, but they are planned enhancements — not permanent exclusions.

- **Broad console-class and hardware-revision coverage beyond MVP fixtures** — MVP covers the
  well-known board classes (Xenon, Zephyr, Falcon, Jasper, Trinity/Corona-class) at the breadth the
  bundled fixtures support. V1 extends fixture coverage to additional revisions and sub-variants.
  Related: REQ-003, REQ-025 *(deferred from MVP — fixture breadth is sufficient; exhaustive
  hardware-revision tables are a V1 enhancement).*
- **Scriptable / headless CLI surface** — core CLI subcommands (parse, build, flash, keys) with
  JSON output for report-producing operations, non-zero exit on failure, and usability in
  automation and CI demos; V1 then extends toward full TUI-workflow parity with complete flag
  coverage and structured output for every operation. Related: REQ-032, REQ-NFR-010 *(deferred
  from MVP at human scope sign-off gate — MVP is strictly TUI-interactive; the headless-JSON
  success criterion from requirements is a V1 acceptance target).*
- **Advanced import/export formats for the key library** — MVP ships a documented file format (e.g.
  JSON/TOML). V1 adds additional formats (CSV, J-Runner-compatible export) or selective record
  export. Related: REQ-014 *(deferred from MVP — one documented format is sufficient for the first
  version).*
- **Theming and terminal visual customization** — color scheme selection, alternate layouts, or
  user-configurable key-binding profiles. Related: REQ-028, REQ-NFR-009 *(deferred from MVP —
  a sensible default theme is sufficient; customization is a V1 polish item).*
- **Timing-file management UI (add/remove/rename)** — MVP ships a managed set of placeholder timing
  files selectable in the build workflow. V1 adds a management screen to add, remove, or rename
  timing-file entries from within the TUI. Related: REQ-016 *(deferred from MVP — static managed
  set is sufficient for the first version).*

---

## Future Scope

Items acknowledged as valuable but explicitly deferred beyond V1. Not committed to; may or may not
be built. Listed here to prevent scope creep into MVP or V1.

- **CPU-key library encryption-at-rest / OS keystore integration** — storage hardening beyond the
  plaintext-local default used in the example. Noted in requirements as a candidate future
  enhancement (OQ-1). Related: REQ-009.
- **Exhaustive RGH/JTAG troubleshooting encyclopedia** — an exhaustive decision tree covering every
  known failure mode and hardware variant, well beyond the fixture-backed finite flow set in MVP.
  Related: REQ-026.
- **Real hardware backend integration** — the `FlashBackend` / `BuildBackend` traits are designed
  for real backends but the real implementations are no-op stubs in this example; a future
  non-example tool could implement them. Related: REQ-020, REQ-022.
- **Patched-image structural fidelity approaching real Xbox 360 layouts** — MVP images are
  deterministic, size/structure-valid for the example's own round-trip; deeper structural fidelity
  to real boot chains is future scope. Related: REQ-015, REQ-017, REQ-018.

---

## Out of Scope

Things TwinRunner will **not** do. Explicit exclusions prevent silent re-inclusion during
implementation.

- **Real destructive hardware writes to physical NAND hardware** — the app never performs a real
  write, erase, or read against physical hardware; all hardware communication is simulator-only.
  Excluded by hard constraint (REQ-022, REQ-NFR-004).
- **Real xeBuild integration and real bootable-image generation** — the build backend is a no-op
  stub; no real xeBuild binaries, real timing binaries, or real bootloader payloads are shipped or
  invoked. Excluded by hard constraint (REQ-020).
- **Real hardware driver / USB device support** — no NAND-X, J-Runner, or USB programmer device
  drivers or protocol implementations. The simulator abstracts a programmer without implementing
  any real device protocol. Excluded by hard constraint.
- **Networking, telemetry, remote sync, or any network call** — TwinRunner runs fully offline;
  no update checks, analytics, cloud sync, or remote key storage. Excluded by assumption and
  non-negotiable.
- **Multi-user, hosted, or web service features** — single local user, local files; no server
  component. Excluded by hard constraint (single Rust binary, no hosted platform).
- **Piracy, DRM circumvention, or bootleg-related features** — the tool is framed entirely around a
  user's own console repair and homebrew; nothing related to circumventing copy protection or
  distributing protected content is in scope, now or in the future. Excluded as a non-negotiable
  framing constraint.
- **GUI (non-terminal) interface** — no Electron, web UI, or native GUI; terminal only. Excluded
  by hard constraint.
- **Proprietary or third-party binary artifacts** — no real RGH timing binaries, real bootloader
  binaries, or proprietary NAND data are bundled. All fixtures are synthetic/generated. Excluded
  by hard constraint.

---

## Non-Goals

Outcomes TwinRunner is not trying to achieve, distinct from feature exclusions.

- **Full fidelity to real Xbox 360 hardware behavior** — the goal is a polished, testable workflow
  tool for developers and hobbyists, not a hardware emulator or bit-accurate simulator. The
  simulator approximates the shape of the workflow, not the silicon behavior.
- **Becoming a general NAND-image forensics or data-recovery tool** — TwinRunner understands the
  Xbox 360 NAND format for the purpose of the RGH/JTAG repair workflow; it is not a generic hex
  editor, binary diff tool, or recovery utility.
- **Replacing or superseding J-Runner with Extras for real hardware use** — the example explicitly
  cannot flash real hardware (all backends are stubs). The goal is to model the workflow cleanly,
  not to ship a drop-in replacement production tool.
- **Cross-console or multi-platform gaming-console support** — TwinRunner is Xbox 360 NAND/RGH/JTAG
  only; other consoles or generations are not a goal.
- **Automated self-update, marketplace listing, or distribution infrastructure** — the binary is
  delivered as a cargo-built artifact; distribution mechanics are outside the project's scope.

---

## Scope Risks

- **SCOPE-RISK-001** — Guided RGH/JTAG troubleshooting flow expands into an exhaustive repair
  encyclopedia — the symptom → diagnosis tree has no natural stopping point and can balloon
  indefinitely. Bound the MVP to a finite, fixture-backed decision tree covering a defined set of
  symptom/board-class combinations; additional nodes are V1/Future. Related: REQ-026.
- **SCOPE-RISK-002** — Console-class and hardware-revision breadth of guided setup workflows is
  unbounded — the well-known board classes are specified but "all revisions" is open-ended.
  Bound the MVP to the fixture-supported board classes explicitly; additional sub-variants are V1.
  Related: REQ-025, REQ-003.
- **SCOPE-RISK-003** — The headless/CLI surface scope creeps back into MVP during implementation —
  engineering convenience (reusing engine code for a CLI entry point) can blur the human-confirmed
  boundary that MVP is strictly TUI-interactive. REQ-032 and REQ-NFR-010 are V1 items; any headless
  entry point built during MVP must be clearly marked internal/test-only and not treated as a
  deliverable acceptance target. Related: REQ-032, REQ-NFR-010.
- **SCOPE-RISK-004** — The CPU-key library import/export format proliferates — requests for
  additional file formats (CSV, J-Runner native, encrypted archive) can inflate the implementation
  before V1. MVP ships exactly one documented format; additional formats are V1. Related: REQ-014.
- **SCOPE-RISK-005** — Simulated-image structural fidelity pressure — demands that the simulator
  produce images approaching real Xbox 360 boot-chain layout erode the "simulated, clearly labeled"
  boundary and pull in real binary knowledge. The fidelity bar is: deterministic, size/structure-valid
  for the example's own round-trip verification, explicitly labeled as simulated. Real fidelity is
  Future. Related: REQ-015, REQ-017, REQ-018, REQ-019, REQ-020.
- **SCOPE-RISK-006** — TUI widget-layer scope growth — the reusable widget layer (REQ-029) can
  expand into a general-purpose TUI framework rather than a thin layer serving TwinRunner's workflows.
  Bound to the widgets that TwinRunner's own screens require; no general-purpose abstractions beyond
  that. Related: REQ-029.
- **SCOPE-RISK-007** — CPU-key security hardening pulled into MVP — encryption-at-rest or OS-keystore
  integration is a natural ask once the key library exists, but it is a meaningful scope addition.
  Plaintext-local is the MVP default; hardening is explicitly Future. Related: REQ-009.

---

## User-Confirmed Decisions

| Decision | Confirmed by | Affects |
|---|---|---|
| **Backend = SIMULATED.** Real NAND dump parsing/validation is in-scope; flashing communication and image build/patch run behind Rust `FlashBackend` / `BuildBackend` traits with a deterministic simulator; real backends are no-op stubs; no real destructive hardware write ever. | Human (locked — hard constraint) | MVP Scope (all areas) · Out of Scope · REQ-020, REQ-022, REQ-NFR-004 |
| **MVP = MAXIMAL (TUI-interactive).** All four capability areas (A NAND read/extract, B CPU-key library, C build/patch, D flashing + guided RGH/JTAG) are MVP, not candidates for deferral. MVP is strictly TUI-interactive; the scriptable/headless surface is V1. | Human (locked — explicit directive + scope sign-off amendment) | MVP Scope (all areas) · REQ-001–REQ-031, REQ-033–REQ-035 · REQ-NFR-001–REQ-NFR-009, REQ-NFR-011 |
| **TUI stack = ratatui + crossterm.** Immediate-mode TUI with a thin widget/focus/dialog/menu/table/progress layer on top. | Human (locked — hard constraint) | MVP Scope · REQ-028, REQ-029, REQ-NFR-002, REQ-NFR-009 |
| **Tier = T3.** Full T3 spec process applies (all stages: domain model, architecture, ADRs, technical design, contracts, test strategy, security, failure modes, slices). | Human (locked — Orchestrator classification) | All downstream stages |
| **CPU-key library storage = plaintext-local (example default).** Encryption-at-rest / OS-keystore integration is explicitly deferred to Future Scope, not an MVP guarantee. | Human (via OQ-1 resolution) | Future Scope · REQ-009 |
| **Console-class coverage = fixture-backed breadth.** MVP covers the well-known board classes at the breadth the bundled fixtures support; exhaustive hardware-revision coverage is V1/Future. | Human (via OQ-3 resolution) | V1 Scope · REQ-003, REQ-025 |
| **Headless/scriptable surface deferred to V1.** The core headless CLI surface (REQ-032: parse/build/flash/keys subcommands + JSON output; REQ-NFR-010: machine-readable output + non-zero exit on failure) is deferred to V1. MVP is strictly TUI-interactive; no headless acceptance criteria apply to MVP. The headless-JSON success criterion from `docs/01-requirements.md` is a V1 acceptance target. MVP acceptance testing exercises the TUI/engine layer directly via state-update / render separation (REQ-NFR-006). | Human (scope sign-off gate — explicit sign-off decision) | V1 Scope · REQ-032, REQ-NFR-010 |
