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
 *
 * `--brownfield` (G5) records `project_mode: "brownfield"` on the fresh state so
 * downstream stages adopt the existing-codebase variants (characterization Slice 0,
 * reuse-first drift, overlay architecture). Default (greenfield) leaves the field
 * undefined so the serialized state hashes byte-identically to a pre-G5 init.
 */
export function runInit(paths: ProjectPaths, opts: { force?: boolean; brownfield?: boolean }): CommandResult {
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
    // Greenfield is the default: leave `project_mode` undefined so serialization
    // is byte-identical to a pre-brownfield init. Only stamp the field when
    // brownfield is explicitly requested.
    const state = initialState();
    if (opts.brownfield) state.project_mode = "brownfield";
    writeState(paths, state);
    created.push(".twinharness/state.json");
  }

  if (!fs.existsSync(paths.driftLog)) {
    fs.writeFileSync(paths.driftLog, DRIFT_LOG_HEADER, "utf8");
    created.push("drift-log.md");
  } else {
    skipped.push("drift-log.md (already exists)");
  }

  structuredLog({ cmd: "init", created, skipped, ...(opts.brownfield ? { project_mode: "brownfield" } : {}) });
  const data: Record<string, unknown> = { created, skipped };
  if (opts.brownfield) data.project_mode = "brownfield";
  const human = [
    "TwinHarness initialized.",
    ...(opts.brownfield ? ["  project_mode: brownfield (adopting an existing codebase)"] : []),
    ...created.map((c) => `  created: ${c}`),
    ...skipped.map((s) => `  skipped: ${s}`),
  ].join("\n");
  return success({ data, human });
}

/**
 * MCP-facing init (`th_init`). Idempotent and NON-destructive by contract: when a
 * project is ALREADY initialized it returns a structured `{ already_initialized:
 * true, … }` summary WITHOUT clobbering state.json. There is NO `force` over MCP —
 * destructive re-init stays CLI/human-only (plan R17). A fresh project delegates to
 * the existing {@link runInit} (with `force:false`) so scaffolding is never
 * duplicated here.
 */
export function runInitMcp(paths: ProjectPaths, opts: { brownfield?: boolean } = {}): CommandResult {
  const existing = readState(paths);
  if (existing.exists) {
    const data: Record<string, unknown> = { already_initialized: true };
    if (existing.state) {
      data.tier = existing.state.tier;
      data.current_stage = existing.state.current_stage;
      data.implementation_allowed = existing.state.implementation_allowed;
    }
    structuredLog({ cmd: "init", already_initialized: true });
    return success({
      data,
      human: "TwinHarness already initialized; not re-initializing (use the CLI `th init --force` to reset).",
    });
  }
  return runInit(paths, { force: false, brownfield: opts.brownfield });
}
