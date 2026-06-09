---
description: Show the current TwinHarness state — tier, stage, gates, slices, and open drift.
---

Render the current TwinHarness state for this project.

Run:

```
th state status
```

Then summarize for the user: the current **tier** and **stage**, whether implementation is allowed,
any **blast-radius flags**, the count of **open blocking drift** escalations, approved artifacts, and
per-slice status. If `th state status` reports the project is not initialized, tell the user to run
`/twinharness <idea>` (or `th init`) first.
