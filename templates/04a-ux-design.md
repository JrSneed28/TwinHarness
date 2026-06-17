# UX Design — <project name>

> **Stage 4a — UX Design** (spec §2, §8). Runs after Architecture (`04-architecture.md`) and
> BEFORE UI Design (`04b-ui-design.md`). Engages only when the project has a user interface (the
> Orchestrator decides). The experience direction — information architecture, primary journeys,
> and the task-flow model — is taste-driven and expensive to reverse; per the §2 governing axis
> it receives a **human gate**: the ux-ui-designer agent presents 2–3 distinct experience
> directions via `AskUserQuestion` and details only the direction the human approves. The bulk of
> the UX artifact then streams, feeding Stage 4b (visual/wireframes). Reads Summary blocks of
> `01-requirements.md`, `02-scope.md`, `04-architecture.md`, and `03-domain-model.md` (§9). Output
> is checked by the Critic in `ux-design` mode (fresh context) before `docs/04b-ui-design.md` is
> produced.

## Summary

<3–6 sentences: the approved experience direction, the primary information-architecture model,
the count of personas/journeys, and the core task flows. This block is the default handoff
currency — the UI Designer (Stage 4b) and the Vertical Slice agent read THIS, not the whole
document, when realizing screens and slices (§9).>

- **Approved direction:** <the experience direction the human selected, e.g., "guided wizard flow / task-grouped IA">
- **Personas:** <number of personas in MVP scope>
- **Primary journeys:** <number of end-to-end journeys>
- **Key UX decisions confirmed by human:** <the direction choice that received explicit sign-off>

---

## Inputs Used

<List the upstream artifacts this UX design was derived from, and which sections were read.>

| Artifact | Version | Sections consumed |
|---|---|---|
| `01-requirements.md` | v<n> | Summary, Functional Requirements, Intended Users |
| `02-scope.md` | v<n> | Summary, MVP Scope |
| `04-architecture.md` | v<n> | Summary, System Boundaries, External Dependencies |
| `03-domain-model.md` | v<n> | Summary, Glossary |

---

## UX Research & Assumptions

<What is known (or assumed) about the users, their goals, and their constraints. Distinguish
evidence (a stated requirement, a documented user) from assumption (an inference). Assumptions
that drive structural decisions must be surfaced, not buried. Anchor user goals to the REQ-IDs
that establish them.>

- **Target users:** <who they are — anchored to `01-requirements.md` Intended Users>
- **Primary goals:** <what users are trying to accomplish — REQ-<###>>
- **Constraints / context of use:** <device, environment, expertise, accessibility needs>
- **Key assumptions:** <inferences that shape the design; flag any that need human confirmation>

---

## Personas / User Journeys

<The user types and the end-to-end journeys they take. Each persona and each journey anchors to
≥1 REQ-ID — a persona or journey with no REQ-ID anchor is speculative scope and the Critic will
flag it. Journeys describe the experience narrative, not the screens (screens come in 4b).>

### Persona: `<PersonaName>` (REQ-<###>)

<One paragraph: who they are, their goal, their level of expertise, what success looks like.>

### Journey: `<JourneyName>` (REQ-<###>)

1. **Trigger:** <what prompts the user to start — the entry context>
2. <step — what the user is trying to do and how the product responds>
3. <…>
4. **Outcome:** <the success condition — what the user has achieved>

**Failure / recovery:** <what happens when the journey cannot complete; how the user recovers.>

---

## Information Architecture

<The logical organization of the product's content and functionality — the backbone the UI's
navigation model (Stage 4b) will realize. One level of hierarchy per indented entry. Every group
anchors to the REQ-ID(s) and/or persona goals that justify it.>

- **<Top-level area>** — REQ-<###> — <what lives here / which goal it serves>
  - **<Sub-area>** — REQ-<###>
  - **<Sub-area>** — REQ-<###>
- **<Top-level area>** — REQ-<###>
  - <…>

---

## Task Flows

<The concrete task-level flows that realize the journeys above. Each flow starts at a defined
entry point and ends at a defined outcome. Flows that begin or end at an undefined state are a
Critic defect. These flows are the input to the Stage 4b Screen Inventory and User Flows — 4b
turns each task-flow step into screens.>

### <Flow name> (REQ-<###>)

1. **Entry:** <where/how the flow begins>
2. <user action → system response>
3. <decision point → branch(es)>
4. **Outcome:** <success condition>

**Error path:** <if the primary action fails, what the user experiences and how they recover.>

---

## Open UX Questions

<Unresolved experience choices that could not be determined from upstream artifacts alone.
Surface these to the Orchestrator for human input. A UX section that silently omits a real
ambiguity is a worse outcome than surfacing it here. These feed the Stage 4b design and the
Contracts stage.>

- **OUQ-001** — <question> — affects: <journey(s) / flow(s)> — decision needed by: <UI Design / Contracts>
- <…>
