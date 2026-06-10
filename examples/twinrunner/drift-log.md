# Drift Log

Append-only record of implementation discoveries (spec §10). Each entry records the
discovery, the affected layer (derived vs. requirement), the action taken, and the
escalation status.

Format:

```
## DRIFT-NNN  (SLICE-x / TASK-yyy, Builder)  — <layer>, <action>
Discovery : ...
Action    : ...
Escalation: ...
```
