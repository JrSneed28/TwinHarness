# UI Design — <project name>

> **Stage 4b — UI Design** (spec §2, §8). Runs after Architecture (`04-architecture.md`) and
> before Contracts/Test Strategy. Engages only when the project has a user interface (the
> Orchestrator decides). The design direction is taste-driven and irreversible once slices build
> against it — per the §2 governing axis, it receives a **human gate**: the ux-ui-designer agent
> presents 2–3 distinct directions via `AskUserQuestion` (with ASCII mockup previews) and
> details only the direction the human approves. The bulk of the design then streams. Reads
> Summary blocks of `01-requirements.md`, `02-scope.md`, `04-architecture.md`, and
> `03-domain-model.md` (§9). Output is checked by the Critic in `ui-design` mode (fresh
> context) before `docs/07-contracts.md` is produced.

## Summary

<3–6 sentences: the approved design direction, the primary navigation model, the screen count,
and any key accessibility or responsiveness decisions. This block is the default handoff
currency — the Vertical Slice agent reads THIS, not the whole document, when deciding which
slices realize which screens (§9).>

- **Approved direction:** <the direction the human selected, e.g., "sidebar navigation / card layout / light theme">
- **Screen count:** <number of screens in MVP scope>
- **Key design decisions confirmed by human:** <the direction choice that received explicit sign-off>
- **Accessibility target:** <WCAG level, e.g., WCAG 2.1 AA>

---

## Inputs Used

<List the upstream artifacts this design was derived from, and which sections were read.>

| Artifact | Version | Sections consumed |
|---|---|---|
| `01-requirements.md` | v<n> | Summary, Functional Requirements, Intended Users |
| `02-scope.md` | v<n> | Summary, MVP Scope |
| `04-architecture.md` | v<n> | Summary, System Boundaries, External Dependencies |
| `03-domain-model.md` | v<n> | Summary, Glossary |

---

## Design Summary

<One or two paragraphs describing the approved design direction and its rationale. Name the
navigation model, layout pattern, and visual theme. Explain why the approved direction fits this
project's users and requirements. Reference the REQ-IDs that drove specific structural choices
where the mapping is non-obvious. This is NOT a recitation of all options considered — only the
approved direction.>

---

## Information Architecture

<The logical hierarchy of the product's content and functionality. One level of hierarchy per
indented entry. Every leaf node anchors to the screen(s) in the Screen Inventory that realize
it. This is the backbone of the navigation model.>

- **<Top-level section>** — screens: <screen name(s)>
  - **<Sub-section>** — screen: <screen name>
  - **<Sub-section>** — screen: <screen name>
- **<Top-level section>** — screens: <screen name(s)>
  - <…>

---

## Screen Inventory

<Every screen in the design, each anchored to the REQ-IDs that justify its existence. A screen
with no REQ-ID anchor is speculative scope. Include only MVP-scope screens here; future-scope
screens may be listed in an appendix with a clear "out of MVP" label.>

| Screen name | REQ-ID(s) | Entry point(s) | Description |
|---|---|---|---|
| `<ScreenName>` | REQ-<###>, REQ-<###> | <how the user reaches this screen> | <one sentence: what the user does here> |
| `<ScreenName>` | REQ-<###> | <…> | <…> |

---

## User Flows

<The key end-to-end paths a user takes through the product. Each flow must start AND end at
named screens from the Screen Inventory above. Flows that begin or end at undefined screens are
a Critic defect. One section per primary user journey.>

### <Flow name> (REQ-<###>)

1. User is at **`<StartScreen>`** — <what they see / what triggers the flow>
2. User <action> → navigates to **`<ScreenName>`**
3. <…>
4. Flow ends at **`<EndScreen>`** — <success condition / what the user sees>

**Error path:** <if the primary action fails, what screen does the user see and what do they see?>

---

## Wireframes

<One wireframe per screen from the Screen Inventory. Use ASCII art or Mermaid flowcharts.
ASCII art is preferred for spatial layouts; Mermaid is preferred for flows and hierarchies.
Keep wireframes structural — show layout, key elements, and labels. Do not design final pixels
here; that belongs in implementation.>

### `<ScreenName>` wireframe

```
+--------------------------------------------------+
| <NavigationBar>                       [User ▼]  |
+--------------------------------------------------+
| <Sidebar>          | <MainContent>               |
|                    |                             |
| - <NavItem>        |  <PrimaryElement>           |
| - <NavItem>        |                             |
| - <NavItem>        |  <SecondaryElement>         |
|                    |                             |
+--------------------------------------------------+
| <Footer>                                        |
+--------------------------------------------------+
```

*Anchors: REQ-<###>*

---

## Component Hierarchy

<The tree of UI components this design requires, from page-level containers down to reusable
primitives. This section is the input to Builder task files for UI slices — Builders reference
it so they do not invent component structure. Group by page/screen, then list child components
in nesting order.>

- `<PageComponent>` (page) — REQ-<###>
  - `<LayoutComponent>` (layout)
    - `<ContainerComponent>` (container)
      - `<PrimitiveComponent>` (primitive)
      - `<PrimitiveComponent>`
  - `<SharedComponent>` (shared / reusable across screens)

---

## Design Tokens

<Every design token used in this system, with a concrete value. Generic descriptors ("warm
blue," "comfortable padding") are not accepted — every token must have a specific value. Tokens
with no value are a Critic defect.>

### Colors

| Token name | Value | Usage |
|---|---|---|
| `color-primary` | `<#RRGGBB>` | <primary action buttons, links> |
| `color-surface` | `<#RRGGBB>` | <card and panel backgrounds> |
| `color-error` | `<#RRGGBB>` | <error states, destructive actions> |
| `color-text-primary` | `<#RRGGBB>` | <primary text> |
| `color-text-secondary` | `<#RRGGBB>` | <secondary / supporting text> |

### Typography

| Token name | Value | Usage |
|---|---|---|
| `font-family-base` | `<font name, fallback stack>` | <body text> |
| `font-size-base` | `<Npx / Nrem>` | <body / default size> |
| `font-size-heading-1` | `<Npx / Nrem>` | <page titles> |
| `font-weight-bold` | `<N>` | <emphasis, headings> |

### Spacing

| Token name | Value | Usage |
|---|---|---|
| `spacing-xs` | `<Npx / Nrem>` | <tight internal padding> |
| `spacing-sm` | `<Npx / Nrem>` | <component internal padding> |
| `spacing-md` | `<Npx / Nrem>` | <section padding, card padding> |
| `spacing-lg` | `<Npx / Nrem>` | <section separation, page margins> |

---

## Interaction States

<For every screen in the Screen Inventory, define all four interaction states. A screen missing
any of these four states is a Critic defect — a screen with only a happy-path content state is
incomplete by construction.>

### `<ScreenName>` states

| State | What the user sees | Technical trigger |
|---|---|---|
| **Loading** | <skeleton, spinner, or progress indicator — specific description> | <data fetch pending> |
| **Empty** | <empty state illustration, message, and primary CTA — specific description> | <data fetch succeeded; result set is empty> |
| **Error** | <error message, error code if applicable, retry or recovery CTA — specific description> | <data fetch failed or action failed> |
| **Success / Populated** | <the primary content view — the happy path> | <data fetch succeeded; result set is non-empty> |

---

## Responsive Breakpoints

<The breakpoints this design targets, the layout changes at each breakpoint, and any
components that are hidden or reorganized below a given width.>

| Breakpoint | Width | Layout changes |
|---|---|---|
| `desktop` | ≥ <N>px | <default layout described in wireframes above> |
| `tablet` | <N>px – <N>px | <describe layout changes: e.g., sidebar collapses to hamburger menu> |
| `mobile` | < <N>px | <describe layout changes: e.g., stack to single column, bottom nav> |

---

## Accessibility Requirements

<Accessibility is a first-class concern. State the WCAG target, keyboard navigation plan, and
contrast requirements concretely. An absent or empty Accessibility Requirements section is a
Critic defect.>

- **WCAG target:** <WCAG 2.1 AA / WCAG 2.2 AA / other — state explicitly>
- **Keyboard navigation:** <describe the tab order for the primary screen; state which
  interactive elements are keyboard-reachable and what keyboard shortcuts (if any) are defined>
- **Minimum color contrast:** <state the required ratio, e.g., 4.5:1 for normal text, 3:1
  for large text — verify against Design Tokens color values above>
- **Screen reader support:** <describe ARIA landmark usage, image alt-text policy, and any
  dynamic content announcement strategy>
- **Focus management:** <describe how focus is managed on route changes, modal open/close,
  and async content updates>

---

---

## Grounding Manifest Pointer

> **Builder-pause:** if this project's work class requires `visual-hash` ground kinds (redesign,
> recreation, or any project with an interactive/screen surface) and the signed EvidenceManifest
> listed below does not yet exist or `th grounding check` is not clean for the `visual-hash` kind,
> **work pauses here**. No downstream stage (Contracts, Test Strategy, Slice Plan) begins until
> the required visual grounds are signed and recorded. Surface the gap to the Orchestrator.

<Fill in after the Architect runs the pre-architecture grounding protocol and the design direction
is approved. Point to the signed manifest — do NOT copy digest values into this document.>

- **Work class:** <redesign | recreation | greenfield — whichever applies>
- **Required ground kinds:** <visual-hash | a11y — list all that apply for this design>
- **Signed EvidenceManifest path:** <relative path to the manifest file, e.g., `.twinharness/grounding/manifest-<id>.json`>
- **Fidelity tier:** <tight | medium | loose — declared here; governs Tester diff tolerance>
- **Pinned renderer:** <engine name, version, viewport — e.g., "Chromium 124.0.6367.82, 1280×800"; must match the manifest>
- **Pinned a11y scan-rule version:** <e.g., "axe-core 4.9.1"; must match the manifest — omit if a11y not required>
- **Grounding check status:** <output of `th grounding check --kind visual-hash` — must be clean>

### Permitted-Difference Carve-outs

<List every screen region permitted to differ from the signed reference, with its reason.
Unsigned carve-outs mask nothing — each entry here must have a corresponding signed producer
entry in the external-grounding store before the Tester measures. An empty table means the
full fidelity-tier diff applies to every screen region.>

| Screen | Region | Reason | Signed? |
|---|---|---|---|
| `<ScreenName>` | <CSS selector / bounding box / component name> | <e.g., "live timestamp — updates every second"> | <yes — manifest entry ID / no — pending signing> |

*The Critic (ui-design mode) verifies this section is present; that every carve-out has a stated
reason; that the manifest path is a real pointer (no inline digests); and that the fidelity tier
is declared. An absent Grounding Manifest Pointer section is a grounded defect when the work
class requires visual grounds.*

---

## Open Design Questions

<Unresolved design choices that could not be determined from upstream artifacts alone. Surface
these to the Orchestrator for human input. A design section that silently omits a real
ambiguity is a worse outcome than surfacing it here.>

- **ODQ-001** — <question> — affects: <screen(s) / component(s)> — decision needed by: <Contracts / Test Strategy / Slice Plan>
- <…>
