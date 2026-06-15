/**
 * Decision-governance store (spec §6.4 / SLICE-4) — the data-integrity
 * blast-radius core. Append-only, SHA-256 hash-chained `decisions.jsonl`
 * (`<stateDir>/decisions.jsonl`), one `DecisionEvent` per line.
 *
 * Mirrors `src/core/leases.ts` exactly: a tolerant read-only parser
 * (`readDecisionEvents`) that never throws and skips malformed/partial lines, an
 * atomic-append writer (`appendDecisionEvent`) that runs under the caller's
 * `withStateLock` span, and a pure reducer (`reduceDecisions`) over the event
 * log. The hash chain (`prevHash`/`recordHash` via `hashContent`) is what makes a
 * forged, edited, or reordered approval mechanically detectable (`verifyChain`).
 *
 * ADR-001: sidecar JSONL, no `state.json` schema bump. The CLI only records and
 * computes against this file; the gating predicate (`gatingObligations`) is the
 * SINGLE source of truth (RULE-007) consumed by both `runDecisionCheck` and the
 * `th next` rung — there is exactly one implementation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "./paths";
import { hashContent } from "./hash";

/** `prevHash` of the very first event line — 64 hex zeros (DS-001). */
export const GENESIS_PREV_HASH = "0".repeat(64);

/** A decision's lifecycle event type. */
export type DecisionEventType = "proposed" | "approved" | "rejected" | "superseded";

/** A decision's reduced status (latest-event-wins). Mirrors the event types. */
export type DecisionStatus = "proposed" | "approved" | "rejected" | "superseded";

/**
 * DS-001 — one append-only, hash-chained `DecisionEvent` per line of
 * `.twinharness/decisions.jsonl`. Content fields are required on `proposed` and
 * carried as context (optional) on later events; audit fields are the only
 * permitted source of non-determinism (RULE-010, REQ-413).
 */
export interface DecisionEvent {
  id: string; // "DECISION-NNN" (zero-padded 3 digits; pads past 999)
  event: DecisionEventType;
  title?: string;
  rationale?: string;
  links?: string[];
  supersededBy?: string; // present on "superseded" only — the replacing DECISION-NNN
  proposer?: string; // set on "proposed"
  proposedAt?: string; // ISO-8601 UTC — set on "proposed"
  approver?: string; // set on "approved" / "rejected" / "superseded"
  approvedAt?: string; // ISO-8601 UTC — set on "approved" / "rejected" / "superseded"
  prevHash: string; // SHA-256 hex (64) of prior line's canonical text, or GENESIS for first
  recordHash: string; // SHA-256 hex (64) of THIS event's canonical text (computed before set)
}

/** The reduced read model (DS-001 → list output / gating predicate). */
export interface Decision {
  id: string;
  title: string;
  rationale: string;
  status: DecisionStatus;
  links: string[];
  proposer?: string;
  proposedAt?: string;
  approver?: string;
  approvedAt?: string;
  supersededBy?: string;
}

/** A single gating obligation: a decision that blocks the current stage. */
export interface GatingObligation {
  decisionId: string;
  blockedStage: string;
}

/** `<stateDir>/decisions.jsonl` — the decision ledger's location. */
export function decisionsPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "decisions.jsonl");
}

// ---------------------------------------------------------------------------
// Canonical text + hashing (DS-001) — the tamper-evidence core
// ---------------------------------------------------------------------------

/**
 * The fixed canonical field order for hashing (DS-001 / TD §Hash-Chain). Mirrors
 * the deterministic-JSON discipline of `serializeState`: copy fields into a fresh
 * object in THIS order, omit any `undefined` key, and omit `recordHash` entirely.
 * `links` is sorted lexicographically before inclusion.
 */
const CANONICAL_FIELD_ORDER: ReadonlyArray<keyof DecisionEvent> = [
  "id",
  "event",
  "title",
  "rationale",
  "links",
  "supersededBy",
  "proposer",
  "proposedAt",
  "approver",
  "approvedAt",
  "prevHash",
];

/**
 * Deterministic canonical text of an event for hashing (DS-001). Field order is
 * fixed; `undefined` keys and `recordHash` are dropped; `links` is sorted
 * lexicographically; `JSON.stringify` with no indentation. `hashContent` then
 * CRLF→LF normalizes (harmless — the canonical text contains no CRLF).
 */
export function canonicalText(event: Omit<DecisionEvent, "recordHash">): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CANONICAL_FIELD_ORDER) {
    const val = (event as Record<string, unknown>)[key];
    if (val === undefined) continue;
    if (key === "links") {
      // Sort a COPY lexicographically; never mutate the caller's array.
      ordered[key] = [...(val as string[])].sort();
    } else {
      ordered[key] = val;
    }
  }
  return JSON.stringify(ordered);
}

/** `recordHash` for an event = SHA-256 of its canonical text (recordHash omitted). */
export function computeRecordHash(event: Omit<DecisionEvent, "recordHash">): string {
  return hashContent(canonicalText(event));
}

// ---------------------------------------------------------------------------
// Tolerant reader (mirrors readLeaseEvents) — never throws
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const ID_RE = /^DECISION-\d{3,}$/;
const EVENT_TYPES = new Set<DecisionEventType>(["proposed", "approved", "rejected", "superseded"]);

/** Validate the shape of a parsed line; malformed lines are skipped (DS-001). */
function isValidEvent(parsed: unknown): parsed is DecisionEvent {
  if (typeof parsed !== "object" || parsed === null) return false;
  const e = parsed as Record<string, unknown>;
  if (typeof e.id !== "string" || !ID_RE.test(e.id)) return false;
  if (typeof e.event !== "string" || !EVENT_TYPES.has(e.event as DecisionEventType)) return false;
  if (typeof e.prevHash !== "string" || !HEX64.test(e.prevHash)) return false;
  if (typeof e.recordHash !== "string" || !HEX64.test(e.recordHash)) return false;
  if (e.links !== undefined && !Array.isArray(e.links)) return false;
  return true;
}

/**
 * Read + parse every decision event in file order. Missing file → `[]`. Bad
 * lines (non-JSON, partial-tail, schema-invalid) are silently skipped — tolerant,
 * never throws (mirrors `readLeaseEvents`). Chain breaks surface via
 * `verifyChain`, not here.
 */
export function readDecisionEvents(paths: ProjectPaths): DecisionEvent[] {
  const file = decisionsPath(paths);
  if (!fs.existsSync(file)) return [];
  const out: DecisionEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isValidEvent(parsed)) out.push(parsed);
    } catch {
      // Tolerant: skip malformed / partial-tail lines.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Id minting (DS-001 / TD §Id-Minting) — monotonic; never reused
// ---------------------------------------------------------------------------

/** Parse the numeric suffix of a `DECISION-NNN` id, or null when it doesn't match. */
function numericSuffix(id: string): number | null {
  const m = /^DECISION-(\d+)$/.exec(id);
  if (!m) return null;
  return Number(m[1]);
}

/** Format `DECISION-NNN`, zero-padded to 3 digits (pads past 999). */
export function formatDecisionId(n: number): string {
  return `DECISION-${String(n).padStart(3, "0")}`;
}

/**
 * Mint the next id from the EVER-SEEN set: `max(numeric suffix across all ids in
 * the file) + 1`, or 1 when empty. Mints from every event (any type), so a
 * rejected/superseded id is never reused — monotonic and immutable (REQ-407,
 * RULE-002). Deterministic for a given file (REQ-NFR-002).
 */
export function mintNextId(events: DecisionEvent[]): string {
  let max = 0;
  for (const e of events) {
    const n = numericSuffix(e.id);
    if (n !== null && n > max) max = n;
  }
  return formatDecisionId(max + 1);
}

// ---------------------------------------------------------------------------
// Atomic append (mirrors appendLeaseEvent) — runs under withStateLock
// ---------------------------------------------------------------------------

/**
 * Append one decision event, sealing the hash chain. The caller MUST already
 * hold the `withStateLock` span (read-modify-append is serialized there). Reads
 * the current tail to derive `prevHash` (the last line's `recordHash`, or GENESIS
 * when empty/absent), sets `prevHash`, computes `recordHash`, then atomically
 * appends `JSON.stringify(sealed) + "\n"` (the lease-ledger pattern).
 *
 * The serialized line stores every field INCLUDING `recordHash`; the hash itself
 * is over the canonical text WITHOUT `recordHash`. Returns the sealed event.
 */
export function appendDecisionEvent(
  paths: ProjectPaths,
  event: Omit<DecisionEvent, "prevHash" | "recordHash">,
): DecisionEvent {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const existing = readDecisionEvents(paths);
  const prevHash = existing.length > 0 ? existing[existing.length - 1]!.recordHash : GENESIS_PREV_HASH;
  const withPrev: Omit<DecisionEvent, "recordHash"> = { ...event, prevHash };
  const recordHash = computeRecordHash(withPrev);
  const sealed: DecisionEvent = { ...withPrev, recordHash };
  fs.appendFileSync(decisionsPath(paths), JSON.stringify(sealed) + "\n", "utf8");
  return sealed;
}

// ---------------------------------------------------------------------------
// verifyChain (DS-001 / TD §Tamper-Detecting Chain Walk)
// ---------------------------------------------------------------------------

export type VerifyChainResult =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: "edited" | "prev_mismatch" };

/**
 * Walk events in file order with a running `expectedPrev = GENESIS`. For each
 * event: recompute `recordHash` from its canonical text — a mismatch means the
 * record was edited (a forged/swapped field). If `prevHash !== expectedPrev` the
 * line was inserted, deleted, or reordered. Return `{ ok:false, brokenAt:N }` at
 * the FIRST break; else advance `expectedPrev = event.recordHash`.
 *
 * Any single-record mutation breaks that record's `recordHash` AND every
 * subsequent `prevHash`, so one linear pass detects tampering (ADR-001).
 */
export function verifyChain(events: DecisionEvent[]): VerifyChainResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const { recordHash, ...rest } = e;
    const recomputed = computeRecordHash(rest);
    if (recomputed !== recordHash) {
      return { ok: false, brokenAt: i, reason: "edited" };
    }
    if (e.prevHash !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: "prev_mismatch" };
    }
    expectedPrev = e.recordHash;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// reduceDecisions (TD §latest-event-wins) — event log → read model
// ---------------------------------------------------------------------------

/**
 * Reduce the event log to the current decision set. The `proposed` event seeds a
 * decision's identity, content (`title`/`rationale`/`links`), and proposer audit;
 * each later event for the same id updates `status` and the approver audit
 * (latest-event-wins). Order is preserved by first-seen, then callers sort by
 * numeric suffix for deterministic output.
 */
export function reduceDecisions(events: DecisionEvent[]): Decision[] {
  const byId = new Map<string, Decision>();
  for (const e of events) {
    let d = byId.get(e.id);
    if (!d) {
      d = {
        id: e.id,
        title: e.title ?? "",
        rationale: e.rationale ?? "",
        status: e.event,
        links: e.links ? [...e.links] : [],
      };
      byId.set(e.id, d);
    }
    // Content fields seed on the first (proposed) event; carry-forward only when set.
    if (e.title !== undefined) d.title = e.title;
    if (e.rationale !== undefined) d.rationale = e.rationale;
    if (e.links !== undefined) d.links = [...e.links];
    // Status is always the latest event type.
    d.status = e.event;
    // Audit fields.
    if (e.proposer !== undefined) d.proposer = e.proposer;
    if (e.proposedAt !== undefined) d.proposedAt = e.proposedAt;
    if (e.approver !== undefined) d.approver = e.approver;
    if (e.approvedAt !== undefined) d.approvedAt = e.approvedAt;
    if (e.supersededBy !== undefined) d.supersededBy = e.supersededBy;
  }
  return [...byId.values()];
}

/** Sort decisions by numeric `DECISION-NNN` suffix (deterministic — REQ-NFR-002). */
export function sortDecisions(decisions: Decision[]): Decision[] {
  return [...decisions].sort((a, b) => (numericSuffix(a.id) ?? 0) - (numericSuffix(b.id) ?? 0));
}

/** Look up a single reduced decision by id (convenience for the handlers). */
export function findDecision(events: DecisionEvent[], id: string): Decision | undefined {
  return reduceDecisions(events).find((d) => d.id === id);
}

// ---------------------------------------------------------------------------
// gatingObligations — THE single governance predicate (RULE-007)
// ---------------------------------------------------------------------------

/** The canonical identifier of a stage within a decision's `links` array. */
export function canonicalStageLink(stage: string): string {
  return `stage:${stage}`;
}

/**
 * The single gating predicate (RULE-007 — only implementation; both
 * `runDecisionCheck` and the `th next` rung call THIS function so they cannot
 * disagree). A decision `d` gates iff BOTH:
 *   1. `d.status !== "approved"` (proposed / rejected / superseded all still gate;
 *      rejection does NOT clear the gate — DQ-002).
 *   2. `d.links` contains the canonical id of `state.current_stage`
 *      (`stage:<current_stage>`) — stage-linked only; REQ-IDs/ADR-ids in `links`
 *      are traceability, never gates (DQ-001).
 *
 * Output is sorted by numeric id suffix (deterministic — REQ-NFR-002).
 * `state` may be undefined / lack a current stage → no gate → empty array.
 */
export function gatingObligations(
  decisions: Decision[],
  state: { current_stage?: string } | undefined,
): GatingObligation[] {
  const stage = state?.current_stage;
  if (!stage) return [];
  const wanted = canonicalStageLink(stage);
  const obligations: GatingObligation[] = [];
  for (const d of sortDecisions(decisions)) {
    if (d.status === "approved") continue;
    if (d.links.includes(wanted)) {
      obligations.push({ decisionId: d.id, blockedStage: stage });
    }
  }
  return obligations;
}
