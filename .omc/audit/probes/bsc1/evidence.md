# BSC-1 Evidence: Unanchorable Deliverable — UI Design Has No Realization Gate

## Scenario

A `has_ui:true` T2 project (task tracker web app) is driven through the full TwinHarness
pipeline. The UI dimension is represented ONLY as a design document (`docs/04b-ui-design.md`)
that cross-references functional REQ anchors (REQ-001 through REQ-004). Zero UI code is
written — no `public/index.html`, no rendered interface, no browser component.

The functional REQ-IDs (REQ-001 through REQ-005, REQ-NFR-001) are satisfied by ordinary
server-side code + tests. No REQ-UI-xxx symbol exists anywhere in the system — the
requirements template mints only `REQ-NNN` and `REQ-NFR-NNN`.

## Commands and Outputs

### Setup
```
node dist/cli.js init --no-interview-required
node dist/cli.js tier record T2
```
T2 engages: requirements → scope → domain-model → architecture → ux-design → ui-design →
contracts → test-strategy → implementation-planning → implementation → ...

### Pipeline advance through ui-design
All stage artifacts registered and `th stage advance` called for each:
- docs/01-requirements.md (REQ-001..005, REQ-NFR-001 — no REQ-UI-xxx)
- docs/04a-ux-design.md (journeys cross-referencing REQ-001..005)
- docs/04b-ui-design.md (visual spec cross-referencing REQ-001..005; zero UI code)

Both UI stages (ux-design, ui-design) advanced GREEN with only design docs — no check
for the existence of any UI component, rendered output, or browser-testable surface.

### DECISIVE GATE: th coverage check (exit 0 = GREEN)
```
node dist/cli.js coverage check \
  --reqs docs/01-requirements.md \
  --plan docs/09-implementation-plan.md \
  --tests tests/
```
Output:
```json
{"cmd":"coverage check","total":6,"covered":6,"gaps":0,"filter":"MVP filter: none — checking all REQ-IDs"}
coverage complete: 6/6 REQ-IDs mapped to >=1 slice and >=1 test
```
Exit code: 0

### State at decisive gate
```
Current stage: implementation-planning
Approved artifacts: 9
Slices: SLICE-001=pending, SLICE-002=pending, SLICE-003=pending
```
No public/ dir, no index.html, no UI code of any kind.

## The Isolated Ungrounded Symbol

**"UI design doc exists and cross-references REQ anchors" = UI realized**

Specifically:
- `docs/04b-ui-design.md` contains prose describing UI interactions and cross-references
  REQ-001 through REQ-004 in section headings (e.g. "realizes REQ-001").
- The coverage gate (`th coverage check`) scans requirements, plan, and tests for REQ-ID
  anchors. Since REQ-001..005 appear in tests/, coverage is 6/6.
- There is NO symbol `REQ-UI-xxx` that would need to map to a slice or test.
- There is NO gate that checks whether `public/index.html` or any browser-renderable
  asset exists.
- The `ux-design`/`ui-design` stages are gated only on: artifact registered + stage advance
  preconditions (artifact_not_produced cleared). They do NOT check that the artifact
  describes realized UI — only that a file was registered.
- Result: the pipeline reaches `implementation-planning` with coverage GREEN (exit 0)
  while the UI realization is entirely absent. A project with zero rendered UI is
  indistinguishable from one with a full UI at every gate.

## Root Cause

The requirements template (templates/01-requirements.md) mints only `REQ-NNN` (Functional)
and `REQ-NFR-NNN` (Non-Functional). No `REQ-UI-NNN` or `REQ-VIS-NNN` category exists.
The REQ_ID_PATTERN in src/core/anchors.ts accepts any domain (`REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*`),
but nothing in the pipeline ever mints a UI-domain REQ-ID or requires one to appear in
slices or tests. The UI design stages produce documents but no requirement symbol that must
be traced to implementation.

## Evidence Path
A:\TwinHarness\.omc\audit\probes\bsc1\evidence.md

## Byte-Clean Assertion
Verified separately (git diff --name-only -- src/ agents/ dist/ templates/ schemas/ = empty).
