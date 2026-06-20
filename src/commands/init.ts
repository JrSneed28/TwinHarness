import * as fs from "node:fs";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { initialState, validateState, DELIVERY_MODES, type TwinHarnessState, type DeliveryMode } from "../core/state-schema";
import { readState, writeState } from "../core/state-store";
import { structuredLog } from "../core/log";
import { formatIssues } from "../core/guards";
import { kToTokens } from "./budget";

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
 * Stamp the gate-defining config fields (R-04 capture path) onto a fresh state, in
 * place. Each is applied ONLY when the operator passed it; an unset field is left
 * absent so the serialized state stays byte-identical to a plain init and the safe
 * default applies. `delivery_mode` gets a focused enum pre-check (clearer than the
 * generic `would_be_invalid` from `validateState`); the boolean/number fields are
 * stamped verbatim and left for `validateState` to range-check. Returns a failure
 * CommandResult on a bad value, else null.
 */
function applyGateDefiningFields(
  state: TwinHarnessState,
  opts: { deliveryMode?: string; hasUi?: boolean; interviewRequired?: boolean; interviewCutoff?: number },
): CommandResult | null {
  if (opts.deliveryMode !== undefined) {
    if (!(DELIVERY_MODES as readonly string[]).includes(opts.deliveryMode)) {
      return failure({
        human: `Invalid --delivery-mode "${opts.deliveryMode}". Valid: ${DELIVERY_MODES.join(", ")}.`,
        data: { error: "invalid_delivery_mode", value: opts.deliveryMode, validModes: DELIVERY_MODES },
      });
    }
    state.delivery_mode = opts.deliveryMode as DeliveryMode;
  }
  if (opts.hasUi !== undefined) state.has_ui = opts.hasUi;
  if (opts.interviewRequired !== undefined) state.interview_required = opts.interviewRequired;
  if (opts.interviewCutoff !== undefined) state.interview_cutoff = opts.interviewCutoff;
  return null;
}

/**
 * `th init` — scaffold `docs/`, `.agentic-sdlc/state.json`, and `drift-log.md`.
 * Idempotent: existing state.json is preserved unless `--force` is given.
 *
 * `--brownfield` (G5) records `project_mode: "brownfield"` on the fresh state so
 * downstream stages adopt the existing-codebase variants (characterization Slice 0,
 * reuse-first drift, overlay architecture). Default (greenfield) leaves the field
 * undefined so the serialized state hashes byte-identically to a pre-G5 init.
 *
 * `--max-tokens <k>` (Track A-2) records the per-session context budget. The flag
 * is given in THOUSANDS; the ×1000 conversion happens HERE (the write site, via
 * `kToTokens`), never in the parser — so `--max-tokens 150` persists as
 * `max_tokens: 150000`. It is applied on a fresh init AND as a targeted update on
 * an already-initialized run (so a resume can re-set the budget without --force).
 *
 * The four gate-DEFINING config fields (R-04 / DR-02) — `deliveryMode`, `hasUi`,
 * `interviewRequired`, `interviewCutoff` — are the typed CAPTURE PATH for fields that
 * are otherwise gate-owned (refused over MCP, `--emergency`-only via raw `state
 * set`). They are CREATION-time only: applied on a fresh init, ignored on a
 * preserve-existing re-init (a project's nature is fixed once; change it later only
 * via the loud `--emergency` raw write). Each is stamped only when the operator
 * passes it (absent ⇒ field omitted ⇒ the safe default applies), and the assembled
 * state is run through `validateState` before writing so a bad enum / out-of-range
 * cutoff is refused cleanly rather than persisting an invalid file.
 */
export function runInit(
  paths: ProjectPaths,
  opts: {
    force?: boolean;
    brownfield?: boolean;
    maxTokens?: number;
    deliveryMode?: string;
    hasUi?: boolean;
    interviewRequired?: boolean;
    interviewCutoff?: number;
  },
): CommandResult {
  const created: string[] = [];
  const skipped: string[] = [];
  const maxTokens =
    opts.maxTokens !== undefined && Number.isFinite(opts.maxTokens) && opts.maxTokens > 0
      ? kToTokens(opts.maxTokens)
      : undefined;

  if (!fs.existsSync(paths.docsDir)) {
    fs.mkdirSync(paths.docsDir, { recursive: true });
    created.push("docs/");
  }
  fs.mkdirSync(paths.stateDir, { recursive: true });

  const existing = readState(paths);
  if (existing.exists && !opts.force) {
    // Non-destructive: preserve state.json, but a --max-tokens override is a free
    // (non-gate) policy value, so apply it as a targeted single-field update.
    if (maxTokens !== undefined && existing.state) {
      writeState(paths, { ...existing.state, max_tokens: maxTokens });
      skipped.push(".twinharness/state.json (already exists; updated max_tokens only)");
    } else {
      skipped.push(".twinharness/state.json (already exists; use --force to reset)");
    }
  } else {
    // Greenfield is the default: leave `project_mode` undefined so serialization
    // is byte-identical to a pre-brownfield init. Only stamp the field when
    // brownfield is explicitly requested.
    const state = initialState();
    if (opts.brownfield) state.project_mode = "brownfield";
    if (maxTokens !== undefined) state.max_tokens = maxTokens;
    // R-04 typed capture path: stamp the gate-defining config fields ONLY when the
    // operator passed them (absent ⇒ omitted ⇒ safe default). Each is the typed,
    // non-`--emergency` write site for an otherwise gate-owned field.
    const captureFailure = applyGateDefiningFields(state, opts);
    if (captureFailure) return captureFailure;
    // Validate the assembled state before writing (writeState does NOT validate):
    // a bad --delivery-mode enum or an out-of-range --interview-cutoff is refused
    // here rather than persisting an invalid state.json.
    const validation = validateState(state);
    if (!validation.ok) {
      return failure({
        human: `Refusing to init: the requested gate-defining flags would make state invalid:\n${formatIssues(validation.issues)}`,
        data: { error: "would_be_invalid", issues: validation.issues },
      });
    }
    writeState(paths, state);
    created.push(".twinharness/state.json");
  }

  if (!fs.existsSync(paths.driftLog)) {
    fs.writeFileSync(paths.driftLog, DRIFT_LOG_HEADER, "utf8");
    created.push("drift-log.md");
  } else {
    skipped.push("drift-log.md (already exists)");
  }

  structuredLog({
    cmd: "init",
    created,
    skipped,
    ...(opts.brownfield ? { project_mode: "brownfield" } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
  });
  const data: Record<string, unknown> = { created, skipped };
  if (opts.brownfield) data.project_mode = "brownfield";
  if (maxTokens !== undefined) data.max_tokens = maxTokens;
  const human = [
    "TwinHarness initialized.",
    ...(opts.brownfield ? ["  project_mode: brownfield (adopting an existing codebase)"] : []),
    ...(maxTokens !== undefined ? [`  max_tokens: ${maxTokens}`] : []),
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
