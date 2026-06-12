import * as fs from "node:fs";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState, writeState, withStateLock } from "../core/state-store";
import { type ValidationIssue } from "../core/state-schema";
import {
  type DriftEntry,
  formatDriftEntry,
  parseDriftEntries,
  nextDriftId,
} from "../core/drift-log";
import { structuredLog } from "../core/log";
import { appendLedger } from "../core/ledger";

/**
 * `th drift` — append-only access to the bidirectional drift log (spec §10).
 * Mechanical only (plan §3 boundary rule): the CLI records discoveries and tracks
 * the BLOCKING count; it never decides whether a requirement is contradicted —
 * the caller declares the layer. DERIVED-layer drift auto-applies (non-blocking);
 * REQUIREMENT-layer drift is BLOCKING and increments `state.drift_open_blocking`,
 * which the stop-gate (§10) reads to refuse premature completion.
 */

/**
 * Replicated from init.ts so `drift add` can self-heal a missing drift-log.md
 * (e.g. a project where init's drift-log was deleted). Kept byte-for-byte
 * identical to the header init.ts writes.
 */
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

function formatIssues(issues: ValidationIssue[] | undefined): string {
  return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}

const NOT_INIT = failure({
  human: "No state.json found. Run `th init` first.",
  data: { error: "not_initialized" },
});

export interface DriftAddOptions {
  layer?: string;
  ref?: string;
  discovery?: string;
  action?: string;
  escalation?: string;
  /** Who is logging this entry (default "Builder"). Orchestrator, human, etc. */
  source?: string;
}

/** Read drift-log.md, creating it from the header if absent. */
function readDriftLog(paths: ProjectPaths): string {
  if (!fs.existsSync(paths.driftLog)) {
    fs.writeFileSync(paths.driftLog, DRIFT_LOG_HEADER, "utf8");
    return DRIFT_LOG_HEADER;
  }
  return fs.readFileSync(paths.driftLog, "utf8");
}

/** Append a block to drift-log.md (append-only — never rewrites history). */
function appendDriftLog(paths: ProjectPaths, block: string): void {
  const current = readDriftLog(paths);
  // Ensure a separating newline before the appended block.
  const sep = current.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(paths.driftLog, `${current}${sep}${block}`, "utf8");
}

/**
 * `th drift add --layer derived|requirement [--ref ...] [--discovery ...] [--action ...] [--escalation ...]`
 * Compute the next DRIFT id, append the formatted entry. A `requirement`-layer
 * entry is BLOCKING: it increments `state.drift_open_blocking` and defaults its
 * escalation to "awaiting human decision".
 */
export function runDriftAdd(paths: ProjectPaths, opts: DriftAddOptions): CommandResult {
  return withStateLock(paths, () => runDriftAddLocked(paths, opts));
}

function runDriftAddLocked(paths: ProjectPaths, opts: DriftAddOptions): CommandResult {
  const layer = opts.layer;
  if (layer !== "derived" && layer !== "requirement") {
    return failure({
      human: "usage: th drift add --layer <derived|requirement> [--ref ...] [--discovery ...] [--action ...] [--escalation ...]",
      data: { error: "invalid_layer" },
    });
  }

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `Existing state.json is invalid; fix it before logging drift:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const blocking = layer === "requirement";
  const current = readDriftLog(paths);
  const id = nextDriftId(current);

  const escalation =
    opts.escalation ?? (blocking ? "awaiting human decision" : "none (no requirement contradicted).");

  const block = formatDriftEntry({
    id,
    ref: opts.ref ?? "SLICE-? / TASK-?",
    layer,
    discovery: opts.discovery ?? "",
    action: opts.action ?? "",
    escalation,
    source: opts.source,
  });
  appendDriftLog(paths, block);

  let driftOpenBlocking = r.state.drift_open_blocking;
  if (blocking) {
    driftOpenBlocking += 1;
    writeState(paths, { ...r.state, drift_open_blocking: driftOpenBlocking });
    // Audit ledger (F5): a requirement-layer drift opens a blocking gate.
    appendLedger(paths, { event: "drift-blocking-opened", id, ref: opts.ref ?? "", drift_open_blocking: driftOpenBlocking });
  }

  structuredLog({ cmd: "drift add", id, layer, blocking, drift_open_blocking: driftOpenBlocking });
  return success({
    data: { id, layer, blocking, drift_open_blocking: driftOpenBlocking },
    human: blocking
      ? `${id} logged (requirement layer, BLOCKING). Open blocking drift: ${driftOpenBlocking}.`
      : `${id} logged (derived layer, auto-applied).`,
  });
}

/** `th drift list` — parse + report every entry plus the open BLOCKING count. */
export function runDriftList(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const text = fs.existsSync(paths.driftLog) ? fs.readFileSync(paths.driftLog, "utf8") : "";
  const entries: DriftEntry[] = parseDriftEntries(text);
  const openBlocking = r.state.drift_open_blocking;

  const human = entries.length
    ? entries.map((e) => `${e.id}  (${e.ref})  ${e.layer} layer${e.layer === "requirement" ? " [BLOCKING]" : ""}`).join("\n")
    : "(no drift entries)";
  return success({ data: { entries, open_blocking: openBlocking }, human });
}

/**
 * `th drift resolve <id>` — append an append-only resolution note. Only
 * decrements `state.drift_open_blocking` when the resolved entry is a
 * `requirement`-layer entry (derived entries get the note but no counter change).
 *
 * Hardened validations:
 * - The id must match an existing drift entry (no unknown ids).
 * - Double-resolving (a `## <id> — resolved` note already present) is rejected.
 * - Derived-layer entries: counter unchanged, human output says so explicitly.
 */
export function runDriftResolve(paths: ProjectPaths, id?: string): CommandResult {
  return withStateLock(paths, () => runDriftResolveLocked(paths, id));
}

function runDriftResolveLocked(paths: ProjectPaths, id?: string): CommandResult {
  if (!id) return failure({ human: "usage: th drift resolve <DRIFT-NNN>" });

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `Existing state.json is invalid; fix it before resolving drift:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  // Parse the drift log to validate the id and detect double-resolves.
  const text = fs.existsSync(paths.driftLog) ? fs.readFileSync(paths.driftLog, "utf8") : "";
  const entries = parseDriftEntries(text);

  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    return failure({
      human: `Drift entry not found: ${id}. Known entries: ${entries.map((e) => e.id).join(", ") || "(none)"}`,
      data: { error: "drift_not_found", id },
    });
  }

  // Check for a pre-existing resolution note (double-resolve guard).
  const alreadyResolved = text
    .split(/\r?\n/)
    .some((line) => line.trim() === `## ${id} — resolved`);
  if (alreadyResolved) {
    return failure({
      human: `${id} is already resolved. Double-resolving is not allowed.`,
      data: { error: "already_resolved", id },
    });
  }

  appendDriftLog(paths, `## ${id} — resolved\n`);

  const isBlocking = entry.layer === "requirement";
  let driftOpenBlocking = r.state.drift_open_blocking;
  if (isBlocking) {
    driftOpenBlocking = Math.max(0, driftOpenBlocking - 1);
    writeState(paths, { ...r.state, drift_open_blocking: driftOpenBlocking });
    // Audit ledger (F5): a requirement-layer resolution clears a blocking gate.
    appendLedger(paths, { event: "drift-blocking-resolved", id, drift_open_blocking: driftOpenBlocking });
  }

  structuredLog({ cmd: "drift resolve", id, layer: entry.layer, drift_open_blocking: driftOpenBlocking });
  const human = isBlocking
    ? `${id} marked resolved (requirement layer, blocking cleared). Open blocking drift: ${driftOpenBlocking}.`
    : `${id} marked resolved (derived layer — no blocking counter change). Open blocking drift: ${driftOpenBlocking}.`;
  return success({
    data: { id, layer: entry.layer, drift_open_blocking: driftOpenBlocking },
    human,
  });
}
