import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { readState, writeState, withStateLock } from "../core/state-store";
import { validateState, STATE_FIELD_ORDER } from "../core/state-schema";
import { structuredLog } from "../core/log";
import { appendLedger, GATE_LEDGER_KEYS } from "../core/ledger";
import { NOT_INIT, formatIssues } from "../core/guards";
import { fieldPolicy } from "../core/state-fields";
import { canonicalizeStage, STAGE_PIPELINE } from "../core/stages";

/** Key segments that must never be written through a dotted path (proto-pollution guard, S3). */
const UNSAFE_KEY_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

  // Managed-field guard (H-2): refuse writes to fields whose owning command keeps
  // an invariant a raw set would corrupt (the drift/debate counters). Gate-owned
  // fields (implementation_allowed/tier/current_stage/write_gate) are NOT refused
  // here — setting them on the CLI is the documented unlock/advance path — but the
  // MCP raw setter refuses them (F-7) and current_stage is enum-normalized below.
  const policy = fieldPolicy(firstSegment);
  if (policy?.refusedByStateSet) {
    return failure({
      human: `Refusing to set managed field "${firstSegment}". ${policy.owner}`,
      data: { error: "managed_field", field: firstSegment },
    });
  }

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) return failure({ human: `Existing state.json is invalid; fix it before setting values:\n${formatIssues(r.issues)}`, data: { error: "invalid_state", issues: r.issues } });

  let value = parseValue(rawValue);

  // current_stage enum-normalization (C-1 write-path defense): canonicalize the
  // value and reject anything that is not a known pipeline stage, so near-miss /
  // bogus stage strings (done, complete, Final-Verification, 10-final-verification)
  // can never be stored via the CLI — closing the gate-bypass vector at the source
  // while the schema itself stays permissive (existing tests write non-pipeline
  // stages like `stage-05` directly via writeState; plan §F-5: do NOT tighten the
  // schema). Scoped to the exact `current_stage` key only.
  if (key === "current_stage") {
    const canonical = canonicalizeStage(String(value));
    // `canonical` is already canonical, so membership-test directly rather than
    // calling isKnownStage (which would canonicalize a second time).
    if (!STAGE_PIPELINE.some((s) => s.stage === canonical)) {
      return failure({
        human:
          `Refusing to set current_stage to "${String(value)}": not a known pipeline stage. ` +
          `Valid stages: ${STAGE_PIPELINE.map((s) => s.stage).join(", ")}.`,
        data: { error: "unknown_stage", value: String(value), validStages: STAGE_PIPELINE.map((s) => s.stage) },
      });
    }
    value = canonical; // persist the canonical id (e.g. "10-final-verification" → "final-verification")
  }
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
  // A valid file may still carry non-fatal warnings (ARCH-007) — e.g. an unknown
  // top-level key. Surface them WITHOUT failing: the file is still valid (exit 0),
  // the operator just sees the advisory so a typo/forward-compat field is visible.
  const warnings = r.warnings ?? [];
  if (warnings.length > 0) {
    return success({
      data: { valid: true, warnings },
      human: `state.json is valid (with ${warnings.length} warning(s)):\n${formatIssues(warnings)}`,
    });
  }
  return success({ data: { valid: true }, human: "state.json is valid." });
}
