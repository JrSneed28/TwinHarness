import * as fs from "node:fs";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success } from "../core/output";
import { initialState } from "../core/state-schema";
import { readState, writeState } from "../core/state-store";
import { structuredLog } from "../core/log";

const DRIFT_LOG_HEADER = `# Drift Log

Append-only record of implementation discoveries (spec §10). Each entry records the
discovery, the affected layer (derived vs. requirement), the action taken, and the
escalation status.

Format:

\`\`\`
## DRIFT-NNN  (SLICE-x / TASK-yyy, Builder)  — <layer>, <action>
Discovery : ...
Action    : ...
Escalation: ...
\`\`\`
`;

/**
 * `th init` — scaffold `docs/`, `.agentic-sdlc/state.json`, and `drift-log.md`.
 * Idempotent: existing state.json is preserved unless `--force` is given.
 */
export function runInit(paths: ProjectPaths, opts: { force?: boolean }): CommandResult {
  const created: string[] = [];
  const skipped: string[] = [];

  if (!fs.existsSync(paths.docsDir)) {
    fs.mkdirSync(paths.docsDir, { recursive: true });
    created.push("docs/");
  }
  fs.mkdirSync(paths.stateDir, { recursive: true });

  const existing = readState(paths);
  if (existing.exists && !opts.force) {
    skipped.push(".twinharness/state.json (already exists; use --force to reset)");
  } else {
    writeState(paths, initialState());
    created.push(".twinharness/state.json");
  }

  if (!fs.existsSync(paths.driftLog)) {
    fs.writeFileSync(paths.driftLog, DRIFT_LOG_HEADER, "utf8");
    created.push("drift-log.md");
  } else {
    skipped.push("drift-log.md (already exists)");
  }

  structuredLog({ cmd: "init", created, skipped });
  const human = ["TwinHarness initialized.", ...created.map((c) => `  created: ${c}`), ...skipped.map((s) => `  skipped: ${s}`)].join(
    "\n",
  );
  return success({ data: { created, skipped }, human });
}
