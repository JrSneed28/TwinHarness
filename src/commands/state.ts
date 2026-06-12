import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState, writeState, withStateLock } from "../core/state-store";
import { type ValidationIssue, validateState, STATE_FIELD_ORDER } from "../core/state-schema";
import { structuredLog } from "../core/log";
import { appendLedger, GATE_LEDGER_KEYS } from "../core/ledger";

/** Key segments that must never be written through a dotted path (proto-pollution guard, S3). */
const UNSAFE_KEY_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatIssues(issues: ValidationIssue[] | undefined): string {
  return (issues ?? []).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // bare string
  }
}

function getByPath(obj: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (Array.isArray(cur)) {
      // Support numeric array indices, e.g. `approved_artifacts.0.hash`.
      const idx = Number(p);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (isRecord(cur)) {
      cur = cur[p];
    } else {
      return undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (!isRecord(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

const NOT_INIT = failure({
  human: "No state.json found. Run `th init` first.",
  data: { error: "not_initialized" },
});

/** `th state get [dotted.path]` */
export function runStateGet(paths: ProjectPaths, dottedPath?: string): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) return failure({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
  if (!dottedPath) {
    return success({ data: { state: r.state }, human: JSON.stringify(r.state, null, 2) });
  }
  const value = getByPath(r.state as unknown as Record<string, unknown>, dottedPath);
  if (value === undefined) {
    return failure({ human: `Path not found: ${dottedPath}`, data: { error: "path_not_found", path: dottedPath } });
  }
  return success({
    data: { path: dottedPath, value },
    human: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  });
}

/** `th state set <dotted.key> <value>` — refuses to persist an invalid result. */
export function runStateSet(paths: ProjectPaths, key: string, rawValue: string): CommandResult {
  return withStateLock(paths, () => runStateSetLocked(paths, key, rawValue));
}

function runStateSetLocked(paths: ProjectPaths, key: string, rawValue: string): CommandResult {
  // Reject paths whose first segment is not a known state field (catches typos
  // like `implementaton_allowed` that would silently write nothing).
  const segments = key.split(".");
  const firstSegment = segments[0] as string;
  if (!(STATE_FIELD_ORDER as string[]).includes(firstSegment)) {
    return failure({
      human: `Unknown state field: "${firstSegment}". Valid top-level keys: ${STATE_FIELD_ORDER.join(", ")}`,
      data: { error: "unknown_field", field: firstSegment, validFields: STATE_FIELD_ORDER },
    });
  }

  // Proto-pollution guard (S3): refuse any dotted segment that could walk into
  // an object's prototype, even under an otherwise-valid first key (e.g.
  // `revise_loop_counts.__proto__.x`). setByPath runs before validation, so this
  // must be rejected up front.
  if (segments.some((s) => UNSAFE_KEY_SEGMENTS.has(s))) {
    return failure({
      human: `Refusing to write: unsafe key segment in "${key}".`,
      data: { error: "unsafe_key", key },
    });
  }

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) return failure({ human: `Existing state.json is invalid; fix it before setting values:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });

  const value = parseValue(rawValue);
  const next = JSON.parse(JSON.stringify(r.state)) as Record<string, unknown>;
  setByPath(next, key, value);

  const validation = validateState(next);
  if (!validation.ok) {
    return failure({
      human: `Refusing to write: result would be invalid:\n${formatIssues(validation.issues)}`,
      data: { error: "would_be_invalid", issues: validation.issues },
    });
  }
  writeState(paths, validation.state!);
  structuredLog({ cmd: "state set", key });
  // Audit ledger (F5): record gate-relevant mutations so a human can review when
  // implementation_allowed, the tier, the blast-radius flags, the write_gate, or
  // the blocking-drift count changed. Observability only — never blocks.
  if (GATE_LEDGER_KEYS.has(firstSegment)) {
    appendLedger(paths, { event: "gate-state-change", key, value });
  }
  return success({ data: { key, value }, human: `Set ${key} = ${JSON.stringify(value)}` });
}

/** `th state status` — human-readable snapshot of tier/stage/gates. */
export function runStateStatus(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) return failure({ human: `state.json is invalid:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });
  const s = r.state;
  const human = [
    `Tier:                ${s.tier ?? "(unclassified)"}`,
    `Current stage:       ${s.current_stage}`,
    `Implementation:      ${s.implementation_allowed ? "allowed" : "not allowed"}`,
    `Blast-radius flags:  ${s.blast_radius_flags.length ? s.blast_radius_flags.join(", ") : "(none)"}`,
    `Open blocking drift: ${s.drift_open_blocking}`,
    `Approved artifacts:  ${s.approved_artifacts.length}`,
    `Slices:              ${s.slices.length ? s.slices.map((sl) => `${sl.id}=${sl.status}`).join(", ") : "(none)"}`,
    `Revise-loop counts:  ${Object.keys(s.revise_loop_counts).length ? Object.entries(s.revise_loop_counts).map(([k, v]) => `${k}:${v}`).join(", ") : "(none)"}`,
    `Open questions:      ${s.open_questions.length}`,
  ].join("\n");
  return success({ data: { status: s }, human });
}

/** `th state verify` — exit 0 if valid, non-zero if not. Wired into the stop-gate. */
export function runStateVerify(paths: ProjectPaths): CommandResult {
  const r = readState(paths);
  if (!r.exists) return failure({ human: "No state.json found.", data: { valid: false, error: "not_initialized" } });
  if (!r.state) return failure({ human: `state.json INVALID:\n${formatIssues(r.issues)}`, data: { valid: false, issues: r.issues } });
  return success({ data: { valid: true }, human: "state.json is valid." });
}
