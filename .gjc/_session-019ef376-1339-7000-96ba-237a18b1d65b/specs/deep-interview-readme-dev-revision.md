# Deep Interview Spec: Revise README for the dev branch

## Metadata
- Interview ID: 019ef376-readme-dev-revision
- Rounds: 2
- Final Ambiguity Score: ~6%
- Type: brownfield
- Threshold: 0.05
- Threshold Source: default
- Status: PASSED
- Restated Goal: Rewrite README.md on the dev branch into a tighter, genuinely-revised (not merely trimmed) document that is honest about dev being 40 commits ahead of the released v0.7.0, leads install with the @dev channel (stable demoted), fixes the 76->78 MCP-tool contradiction, and avoids overstating maturity, without bumping package.json.

## Topology
| Component | Status | Description | Coverage |
|---|---|---|---|
| README.md | active | The dev-branch README | All acceptance criteria |

## Established Facts (verified)
- dev is 40 commits ahead of main, 0 behind.
- Both package.json report 0.7.0; latest tag v0.7.0 on main; no bump on dev.
- MCP surface = 78 tools (78 th_ names in tool-catalog.ts and mcp-server.ts); README said 76 in one place, 78 in another -> 78 is correct.
- 16 agents, 16 commands.
- ~2,308 it/test cases across 215 files; '1000+ tests' was conservative; '2,000+' is accurate.

## Goal
Deliver a concise-yet-thorough, genuinely revised dev-branch README that is factually accurate and does not overstate maturity.

## Constraints
- README-only; do NOT bump package.json/marketplace version.
- Lead install with @dev; demote stable channel to a collapsible note.
- Aggressive rewrite that improves prose/structure, not pure deletion.
- Keep humble maturity framing; preserve mermaid diagram, Non-Goals, How it compares.

## Non-Goals
- No version bump, no new release, no changes to main, code, tests, or other docs.

## Acceptance Criteria
- [ ] Badge/Status state dev is ahead of released v0.7.0; no claim dev IS v0.7.0.
- [ ] Install leads with @dev; stable demoted to a collapsible note that says it lags dev.
- [ ] 76-tool reference removed; MCP surface stated as 78 consistently.
- [ ] Test count stated as '2,000+'.
- [ ] Overstated maturity/tagline claims softened; no factual overstatements remain.
- [ ] Materially shorter than 357 lines while retaining all essential sections.
- [ ] package.json/marketplace versions unchanged.

## Deferrals
- Exact final length delegated to agent judgment by the user.
