# SLICE-5 / TASK-019 — Reusable widget/focus/keymap layer + Dashboard + Command Palette

> **Self-contained task file** (spec §9, §15.9). The Builder reads THIS file plus relevant
> artifact summaries — not the full corpus.

**REQ-IDs:** REQ-028, REQ-029, REQ-030, REQ-NFR-008
**Slice:** SLICE-5 — TUI shell & cross-cutting behavior
**Depends on:** SLICE-0 complete (and SLICE-1…SLICE-4 for tile/palette content)

---

## Goal

Build the thin reusable widget/focus/keymap layer and the Direction-C `Dashboard` (five focusable
status tiles) plus the `CommandPalette` overlay, so every screen and action is reachable via three
independent keyboard paths — focusable tiles, global number shortcuts, and a Ctrl-P fuzzy launcher —
with a progress widget whose state advances 0→100 and a documented keymap that drives navigation.

---

## REQ-IDs

- **REQ-028** — Full-screen TUI with a persistent layout: navigation surface, content panels,
  status/footer area with context and key hints.
- **REQ-029** — Reusable interactive widgets (panels, menus, dialogs/modals, forms, scrollable
  tables/lists, progress views) over a thin focus/layout layer on ratatui.
- **REQ-030** — Navigation and all primary actions are keyboard-driven via documented bindings; a
  help/keybindings screen lists them.
- **REQ-NFR-008** — Keyboard-driven, discoverable UX: every primary action reachable from the
  keyboard; context-appropriate key hints.

---

## Relevant Contracts / Interfaces

**IF-015 reducer arms:** `Navigate(Screen)`, `OpenCommandPalette`, `RunPaletteCommand(id)`. Navigation
mutates only screen/focus/scroll — it **never** triggers a domain operation (safe even with no dump
loaded). `RunPaletteCommand(id)` maps a palette entry to a normal `Message` and closes the palette;
an unknown palette id is a no-op (palette stays open).

`ProgressWidgetState` tracks `pct` increments 0→100 driven through `model::update` (REQ-029).

---

## Relevant Design Notes — wireframes + keymap (embed; do not invent)

**`Dashboard`** (anchors REQ-028, REQ-029, REQ-030, REQ-NFR-008): a `TileGrid` of five focusable
`StatusTile`s — `1 ACTIVE DUMP` (links ReadNand/ConsoleInfoView), `2 KEY LIBRARY`, `3 LAST JOB`
(links Build/Flash/Logs), `4 FLASH DEVICE`, `5 TROUBLESHOOT`. Persistent `TitleBar` (`TwinRunner vN.N
… [Ctrl-P] Palette [F1] Help [q] Quit`) and `StatusBar` footer (`[Tab]/[←→↑↓] focus tile [Enter]
open [1-5] direct [6] Logs [7] Config`). Focused tile = **heavy** box border; unfocused = light
border. Loading/Empty/Error/Populated states each carry a glyph (`[·]`/`[✓]`/`[ERR]`).

**`CommandPalette`** (overlay; anchors REQ-028, REQ-030, REQ-NFR-008): `PaletteSearchInput` + a
ranked fuzzy `PaletteResultList` (all screens + actions), `[↑↓] navigate [Enter] execute [Esc]
dismiss`. Distinct palette border color. No-match state: `[·] No commands match '<query>'`.

**Keymap — three independent paths (REQ-030 / REQ-NFR-008):**
- **Global shortcuts (always active except in modals):** `1`=ReadNand `2`=KeyLibrary `3`=Build
  `4`=Flash `5`=Troubleshoot `6`=Logs `7`=Config · `F1`/`?`=Help · `Ctrl-P`=Palette · `Esc`=back ·
  `q`/`Q`=Quit.
- **Tile focus:** `Tab`/`Shift-Tab` next/prev tile (wraps), arrows directional, `Enter` opens.
- **Palette:** Ctrl-P → type to filter → ↑↓ → Enter → Esc.

**Accessibility:** focus is conveyed by heavy-vs-light border + `►` selected-row glyph, never color
alone (REQ-NFR-009). Unicode box-drawing with ASCII fallback (`+===+`/`+---+`).

---

## Acceptance Test(s)

- `test_REQ029_progress_widget_state_advances` — `ProgressWidgetState` tracks `pct` increments from
  0 to 100 through `model::update`. *(unit)*
- `test_REQ030_keyboard_messages_navigate_model` — `Message::KeyPressed` for the documented
  navigation keys changes `model.active_screen` as specified by the keymap. *(unit)*

*(REQ-028 layout fields are anchored by `test_REQ028_model_initial_state_has_layout_fields` from
SLICE-0/TASK-001 — must not regress. REQ-NFR-008 help-listing is anchored in SLICE-5/TASK-022.)*

---

## Definition of Done

- [ ] All acceptance tests pass; the Dashboard, tiles, and palette are demonstrable; all three
      navigation paths work without the palette.
- [ ] No state communicated by color alone — heavy/light borders + glyphs (REQ-NFR-009 honored here;
      assertion in TASK-022).
- [ ] No undocumented behavior introduced (§6.4): any discovery is logged to `drift-log.md`.
- [ ] `th coverage check` does not regress (REQ-028, REQ-029, REQ-030, REQ-NFR-008 still map to
      passing tests).

---

## Out of Scope for This Task

- LogsView + structured logging + redaction — SLICE-5 / TASK-020.
- ConfigSettings + AppConfig resolution — SLICE-5 / TASK-021.
- Resize/too-small handling + Help screen + launch latency — SLICE-5 / TASK-022.
- The earlier per-screen wiring (ReadNand/KeyLibrary/Build/Flash/Troubleshoot) — owned by
  SLICE-1…SLICE-4; this task only adds the Dashboard, palette, widget layer, and the shared keymap.
