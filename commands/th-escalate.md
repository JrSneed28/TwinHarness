---
description: Surface TwinHarness blocking escalations that need a human decision before work can complete.
---

Surface everything currently **blocking** completion of this TwinHarness run (spec §8, §10, §18).

Gather state and drift:

```
th state status
th drift list --json
```

Then present, in priority order, anything that requires a human decision:

1. **Open blocking drift** (`drift_open_blocking > 0`) — requirement/scope contradictions that paused
   the build (spec §10). Show each `DRIFT-NNN`, its discovery, and what decision is awaited.
2. **Revise-loop escalations** — any stage whose `revise_loop_counts.<mode>` has hit the cap (default
   3) with issues still open (spec §7, §18); the Critic↔producer loop stopped and needs the human.
3. **Open questions** in state that block advancement.

For each, state the decision the human must make and the consequence. If `th hook stop-gate` would
block (invalid state or open blocking drift), say so explicitly. If nothing is blocking, report that
the run has no open escalations.
