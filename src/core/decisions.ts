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
import { createHmac } from "node:crypto";
import type { ProjectPaths } from "./paths";
import { assertGovernedWriteSurface } from "./paths";
import { hashContent, GENESIS_PREV_HASH, HEX64 } from "./hash";
import { readJsonlValues, scanTailValid } from "./jsonl";
import { canonicalizeStage } from "./stages";

// GENESIS_PREV_HASH + HEX64 are shared with the gate ledger and now live in
// core/hash.ts (#14 dedup). Re-export GENESIS_PREV_HASH so existing importers
// (`import { GENESIS_PREV_HASH } from "./decisions"`) keep working unchanged.
export { GENESIS_PREV_HASH };

/** A decision's lifecycle event type. */
export type DecisionEventType = "proposed" | "approved" | "rejected" | "superseded";

/**
 * Invocation provenance for a HUMAN-gated approval transition (#17, D3).
 *
 * This is the real, observed source of the `th decision approve` invocation — NOT
 * a self-asserted "human" string. It records what the process could actually see
 * about its environment at the moment of approval: whether stdin was a TTY, the
 * parent process id + command name, the hostname, and this process's pid. None of
 * it is cryptographic (D3 — the TTY gate stays a compliant-agent guardrail, not a
 * sandbox); it is forensic metadata so an after-the-fact reviewer can distinguish
 * a genuine interactive approval from an agent-driven one that forged a fake TTY,
 * and so an `approver` left at the default is marked SUSPECT rather than silently
 * trusted as "human".
 *
 * Sealed into the hash chain like every other field (it appears in
 * CANONICAL_FIELD_ORDER), so a reviewer who edits the recorded provenance breaks
 * the chain detectably.
 */
export interface ApprovalProvenance {
  /** `process.stdin.isTTY` at approval time — the gate's structural signal. */
  isTTY: boolean;
  /** Parent process id (`process.ppid`), or 0 when unavailable. */
  ppid: number;
  /** Parent process command name (best-effort; "unknown" when unreadable). */
  parentComm: string;
  /** os.hostname() at approval time. */
  hostname: string;
  /** This process's pid (`process.pid`). */
  pid: number;
  /**
   * True when the approver attribution was NOT explicitly supplied (no `--as`,
   * no TH_APPROVAL_ACTOR) and fell back to the "human" default — i.e. the
   * approval is UNATTRIBUTED and should be treated as suspect by reviewers.
   */
  attributionSuspect: boolean;
}

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
  /**
   * Invocation provenance (#17, D3) — present ONLY on approval-transition events.
   * The real observed source of the approval (TTY/ppid/host/pid + an
   * attribution-suspect flag), sealed into the hash chain. Omit-when-absent on
   * `proposed` and on legacy events written before this field existed.
   */
  provenance?: ApprovalProvenance;
  prevHash: string; // SHA-256 hex (64) of prior line's canonical text, or GENESIS for first
  recordHash: string; // SHA-256 hex (64) of THIS event's canonical text (computed before set)
  /**
   * OPTIONAL keyed seal (C-3b) — HMAC-SHA256 of the same canonical text, present
   * ONLY on approval-transition events sealed while TH_DECISION_KEY was explicitly
   * set. Excluded from `canonicalText` (so it never affects the keyless chain).
   * Verified warn-only via {@link verifyApprovalSeals}; never auto-generated.
   */
  keyedHash?: string;
}

/** Lifecycle transitions that carry an optional keyed seal (the human-gate events). */
const APPROVAL_TRANSITIONS = new Set<DecisionEventType>(["approved", "rejected", "superseded"]);

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
  /** Invocation provenance from the approval transition (#17, D3); omit on proposed. */
  provenance?: ApprovalProvenance;
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

/**
 * `<stateDir>/approval-audit.jsonl` — the DURABLE approval-attempt audit log
 * (#17, D3). The structured approval log used to be stderr-only and silenceable
 * (`TH_NO_LOG=1`); a forensic record of who approved (or attempted to approve)
 * what must survive a silenced stderr. This file records EVERY `th decision
 * approve` invocation — including ones blocked at the TTY barrier (which never
 * reach decisions.jsonl) — with the observed provenance, so a blocked or declined
 * approval attempt is auditable too. Append-only, gitignored under `.twinharness/`.
 */
export function approvalAuditPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "approval-audit.jsonl");
}

/** One durable approval-audit record (#17, D3). */
export interface ApprovalAuditRecord {
  ts: string;
  id?: string;
  disposition: "approve" | "reject" | "supersede";
  /** "appended" when the transition was sealed; otherwise the failure error code. */
  outcome: string;
  approver?: string;
  provenance: ApprovalProvenance;
}

/**
 * Append one approval-attempt record to the durable audit log. Best-effort and
 * never throws — an unwritable audit file must never break (or silently abort) an
 * approval/governance flow; it is a forensic aid, not a gate.
 */
export function appendApprovalAudit(paths: ProjectPaths, record: ApprovalAuditRecord): void {
  try {
    // AC#1 write-surface chokepoint (defense-in-depth, INSIDE the best-effort try):
    // a non-governed target is PREVENTED without crashing — this audit path must
    // never abort a governance flow. approvalAuditPath is under stateDir; the
    // propagating mechanical guard lives at appendDecisionEvent (below).
    assertGovernedWriteSurface(paths.root, approvalAuditPath(paths));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.appendFileSync(approvalAuditPath(paths), JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Audit logging must never crash or abort a command.
  }
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
  "provenance",
  "prevHash",
];

/**
 * Canonical key order for an {@link ApprovalProvenance} object so its
 * `JSON.stringify` form is byte-stable inside the sealed canonical text (the
 * field-order discipline that keeps the chain deterministic — REQ-NFR-001).
 */
const PROVENANCE_FIELD_ORDER: ReadonlyArray<keyof ApprovalProvenance> = [
  "isTTY",
  "ppid",
  "parentComm",
  "hostname",
  "pid",
  "attributionSuspect",
];

/** Re-emit a provenance object in the fixed canonical key order (deterministic JSON). */
function canonicalProvenance(p: ApprovalProvenance): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PROVENANCE_FIELD_ORDER) out[key] = p[key];
  return out;
}

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
    } else if (key === "provenance") {
      // Re-emit in the fixed provenance key order so the sealed text is byte-stable.
      ordered[key] = canonicalProvenance(val as ApprovalProvenance);
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

/**
 * Keyed seal (C-3b) for an event = HMAC-SHA256(key, canonicalText). Byte-stable
 * given the key — no nonce — so a sealed ledger stays deterministic (REQ-NFR-001).
 * Computed over the SAME canonical text as `recordHash` (keyedHash itself is not in
 * the canonical field order, so the keyless chain is unaffected by its presence).
 */
export function computeKeyedHash(event: Omit<DecisionEvent, "recordHash" | "keyedHash">, key: string): string {
  return createHmac("sha256", key).update(canonicalText(event)).digest("hex");
}

// ---------------------------------------------------------------------------
// Tolerant reader (mirrors readLeaseEvents) — never throws
// ---------------------------------------------------------------------------

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
  if (e.keyedHash !== undefined && typeof e.keyedHash !== "string") return false;
  if (e.provenance !== undefined && (typeof e.provenance !== "object" || e.provenance === null)) return false;
  return true;
}

/**
 * Read + parse every decision event in file order. Missing file → `[]`. Bad
 * lines (non-JSON, partial-tail, schema-invalid) are silently skipped — tolerant,
 * never throws (mirrors `readLeaseEvents`). Chain breaks surface via
 * `verifyChain`, not here.
 */
export function readDecisionEvents(paths: ProjectPaths): DecisionEvent[] {
  // Tolerant full forward read via the shared `readJsonlValues` (#11): every line
  // that parses AND passes `isValidEvent`, in file order; bad lines skipped.
  return readJsonlValues(decisionsPath(paths), isValidEvent);
}

/**
 * The `recordHash` of the ledger's last VALID event — the only thing
 * `appendDecisionEvent` needs to seal the next link (PERF-009). Reads the file
 * once but parses only the TAIL: it walks lines from the end and `JSON.parse`s
 * just enough to find the last non-empty line that is a valid event, returning
 * its `recordHash`. Missing/empty file, or no valid tail line, → `GENESIS_PREV_HASH`.
 *
 * This is byte-identical to the old `readDecisionEvents(...).at(-1)?.recordHash`
 * derivation: the previous code took the last element of the SAME tolerant,
 * skip-invalid filter, so the last valid event is exactly what this returns — but
 * without the O(N) parse-and-validate of the whole ledger on every append (which
 * made N appends O(N²)). Tolerant by the same contract: a malformed/partial tail
 * line is skipped, so a torn last write never corrupts the next `prevHash`.
 */
export function readLastDecisionRecordHash(paths: ProjectPaths): string {
  // Tolerant tail scan via the shared `scanTailValid` (#11): the last line that
  // passes `isValidEvent`; missing file / no valid tail line → GENESIS.
  const last = scanTailValid(decisionsPath(paths), isValidEvent);
  return last ? last.recordHash : GENESIS_PREV_HASH;
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
 * ONLY the current tail to derive `prevHash` (the last valid line's `recordHash`,
 * or GENESIS when empty/absent), sets `prevHash`, computes `recordHash`, then
 * atomically appends `JSON.stringify(sealed) + "\n"` (the lease-ledger pattern).
 *
 * PERF-009: `prevHash` comes from {@link readLastDecisionRecordHash} (tail parse
 * of one line), NOT a full `readDecisionEvents` parse+validate of the whole
 * ledger — so N appends are O(N) total, not O(N²). The sealed line and resulting
 * chain are byte-identical to the prior full-read derivation (the tail helper
 * returns the same last-valid-event `recordHash`).
 *
 * The serialized line stores every field INCLUDING `recordHash`; the hash itself
 * is over the canonical text WITHOUT `recordHash`. Returns the sealed event.
 */
export function appendDecisionEvent(
  paths: ProjectPaths,
  event: Omit<DecisionEvent, "prevHash" | "recordHash" | "keyedHash">,
  key?: string | null,
): DecisionEvent {
  // AC#1 write-surface chokepoint: decisionsPath is under stateDir; the guard fires
  // here (not best-effort — this writer propagates) so a non-governed target throws.
  assertGovernedWriteSurface(paths.root, decisionsPath(paths));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const prevHash = readLastDecisionRecordHash(paths);
  const withPrev: Omit<DecisionEvent, "recordHash" | "keyedHash"> = { ...event, prevHash };
  const recordHash = computeRecordHash(withPrev);
  const sealed: DecisionEvent = { ...withPrev, recordHash };
  // Keyed seal (C-3b): only on an approval transition, and only when a key was
  // EXPLICITLY supplied (TH_DECISION_KEY) — never auto-generated. keyedHash is not
  // part of the canonical text, so the keyless chain (recordHash/prevHash) is
  // byte-identical whether or not a seal is present.
  if (key && APPROVAL_TRANSITIONS.has(event.event)) {
    sealed.keyedHash = computeKeyedHash(withPrev, key);
  }
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

export interface SealVerifyResult {
  ok: boolean;
  /** Approval events whose PRESENT keyedHash does not match the supplied key. */
  mismatches: { index: number; id: string }[];
}

/**
 * Verify the optional keyed seals (C-3b) — run ONLY when a key is explicitly
 * supplied. For each approval-transition event that CARRIES a `keyedHash`,
 * recompute the HMAC and flag a mismatch. This catches a competently re-sealed
 * chain (which `verifyChain` cannot): an attacker who re-hashes the keyless chain
 * cannot reproduce a keyed seal without the key, so a left-behind seal stops
 * matching the tampered content.
 *
 * Warn-only by contract: the caller surfaces mismatches as a warning, NOT a
 * fail-closed `chain_broken`, because a per-environment key difference must never
 * turn a legitimately-committed ledger red. Residual limitation (documented): an
 * attacker who STRIPS the keyedHash entirely is not detected here — only the
 * keyless chain continuity (which still breaks on a naive edit) and an explicit
 * out-of-band key policy cover that.
 */
export function verifyApprovalSeals(events: DecisionEvent[], key: string): SealVerifyResult {
  const mismatches: { index: number; id: string }[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (!APPROVAL_TRANSITIONS.has(e.event)) continue;
    if (e.keyedHash === undefined) continue; // unsealed (created without a key) — not a mismatch
    const { recordHash: _rh, keyedHash, ...rest } = e;
    if (computeKeyedHash(rest, key) !== keyedHash) {
      mismatches.push({ index: i, id: e.id });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
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
    if (e.provenance !== undefined) d.provenance = e.provenance;
  }
  return [...byId.values()];
}

/** Sort decisions by numeric `DECISION-NNN` suffix (deterministic — REQ-NFR-002). */
export function sortDecisions(decisions: Decision[]): Decision[] {
  return [...decisions].sort((a, b) => (numericSuffix(a.id) ?? 0) - (numericSuffix(b.id) ?? 0));
}

// ---------------------------------------------------------------------------
// gatingObligations — THE single governance predicate (RULE-007)
// ---------------------------------------------------------------------------

/** The canonical identifier of a stage within a decision's `links` array. The
 * stage component is canonicalized (F-6 item 2c) so a near-miss spelling in
 * either the recorded link or `current_stage` cannot make a gating decision
 * silently stop gating. */
export function canonicalStageLink(stage: string): string {
  return `stage:${canonicalizeStage(stage)}`;
}

/**
 * Normalize a single link: a `stage:<x>` link has its stage component
 * canonicalized; any other link (REQ-/ADR- traceability) is returned unchanged.
 * Applied both when a link is recorded (`th decision add`) and when comparing in
 * `gatingObligations`, so the two sides always agree.
 */
export function canonicalizeLink(link: string): string {
  const prefix = "stage:";
  return link.startsWith(prefix) ? canonicalStageLink(link.slice(prefix.length)) : link;
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
  const wanted = canonicalStageLink(stage); // canonicalizes current_stage
  const obligations: GatingObligation[] = [];
  for (const d of sortDecisions(decisions)) {
    if (d.status === "approved") continue;
    // Canonicalize each link's stage component too, so a near-miss spelling on
    // either side still matches (F-6 item 2c).
    if (d.links.some((l) => canonicalizeLink(l) === wanted)) {
      obligations.push({ decisionId: d.id, blockedStage: stage });
    }
  }
  return obligations;
}
