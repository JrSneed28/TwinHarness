---
description: Review and ratify the TwinHarness drift log — async derived-layer changes and open blocking escalations.
---

Review the TwinHarness drift log (spec §10) for this project.

Run:

```
th drift list --json
```

Then summarize for the user, separating the two layers (spec §10):

- **Derived-layer drift (auto-applied, non-blocking)** — discoveries where reality differed from a
  derived doc; the Builder already wired into reality and updated the doc. These are for the human to
  skim and ratify asynchronously, not to approve. List them concisely.
- **Requirement/scope drift (BLOCKING)** — discoveries that contradict a requirement or scope
  decision. These paused the build and are awaiting a human decision. Surface each clearly.

If the user ratifies a blocking escalation's resolution, clear it with:

```
th drift resolve <DRIFT-NNN>
```

This decrements `drift_open_blocking` so the stop-gate unblocks (only a human moves requirements/
scope — spec §8). If `th drift list` shows no entries, say the drift log is empty.
