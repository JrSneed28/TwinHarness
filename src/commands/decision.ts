/**
 * `th decision …` — the decision-governance CLI handlers (SLICE-4).
 *
 * Five handlers, each a convention-conformant `CommandResult` handler (Critical
 * Pattern 1 / REQ-NFR-008): `paths` first, typed opts second, returns
 * `success()`/`failure()` (never throws, never `process.exit`), and emits exactly
 * ONE `structuredLog` per invocation.
 *
 *   runDecisionAdd      (IF-002) — append a `proposed` event; mint id; audit trail.
 *   runDecisionDetect   (IF-005) — read-only candidate surfacing (never writes).
 *   runDecisionList     (IF-006) — sorted read model with audit fields.
 *   runDecisionApprove  (IF-003) — the non-self-approval TTY barrier + state machine.
 *   runDecisionCheck    (IF-004) — the single gating predicate; exit 0/6.
 *
 * The hash-chained store lives in `src/core/decisions.ts`; writes go through
 * `appendDecisionEvent` under `withStateLock`. The gating predicate
 * `gatingObligations` is the SINGLE source of truth (RULE-007) — `check` and the
 * `th next` rung call the same function.
 *
 * `th decision approve` is HUMAN-ONLY and is NEVER exposed as an MCP tool
 * (RULE-011): there is no code path from MCP to `runDecisionApprove`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as tty from "node:tty";
import type { ProjectPaths } from "../core/paths";
import { type CommandResult, success, failure } from "../core/output";
import { structuredLog } from "../core/log";
import { readState } from "../core/state-store";
import { withStateLock } from "../core/state-store";
import {
  type Decision,
  type DecisionEvent,
  type ApprovalProvenance,
  appendApprovalAudit,
  appendDecisionEvent,
  readDecisionEvents,
  reduceDecisions,
  sortDecisions,
  mintNextId,
  verifyChain,
  verifyApprovalSeals,
  canonicalizeLink,
  gatingObligations,
} from "../core/decisions";
import { resolveDecisionKey } from "../core/decision-key";
import { appendTerminalReceipt, ensureReceiptMigration } from "../core/receipts";

/** `th decision check` exit code when an unapproved decision gates the stage (IF-004). */
export const DECISION_GATE_EXIT = 6;

/** Parse a comma-separated flag value the same way `--components` is parsed. */
function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ===========================================================================
// IF-002 — runDecisionAdd (TASK-007)
// ===========================================================================

export interface DecisionAddOptions {
  title?: string;
  rationale?: string;
  links?: string[];
  proposer?: string;
  /** Injectable clock for deterministic audit timestamps in tests (REQ-NFR-002). */
  now?: () => Date;
}

/**
 * `th decision add` — record one `proposed` decision, mint the next id, set the
 * proposer/proposedAt audit trail (REQ-402, REQ-413). Never auto-approves.
 *
 * Anchor: REQ-402 — records `proposed`; mints id; never auto-approves.
 * Anchor: REQ-413 — audit: proposer + proposedAt on the proposed event.
 * Anchor: REQ-NFR-008 — paths-first; one structuredLog; returns CommandResult.
 */
export function runDecisionAdd(paths: ProjectPaths, opts: DecisionAddOptions = {}): CommandResult {
  const title = opts.title?.trim();
  const rationale = opts.rationale?.trim();

  // Validate required fields BEFORE any write (no append on a missing field).
  if (!title) {
    structuredLog({ cmd: "decision add", error: "missing_field", field: "title" });
    return failure({
      human: "Missing required --title.",
      data: { error: "missing_field", field: "title" },
    });
  }
  if (!rationale) {
    structuredLog({ cmd: "decision add", error: "missing_field", field: "rationale" });
    return failure({
      human: "Missing required --rationale.",
      data: { error: "missing_field", field: "rationale" },
    });
  }

  // Canonicalize stage links at record time (F-6 item 2c) so a `stage:` near-miss
  // is stored canonically and a gating decision keeps gating after current_stage
  // is normalized.
  const links = (opts.links ?? []).map(canonicalizeLink);
  const proposer = opts.proposer?.trim() || "orchestrator";
  const now = opts.now ?? (() => new Date());

  // Read-modify-append serialized via withStateLock (the proven primitive).
  const sealed = withStateLock(paths, () => {
    const id = mintNextId(readDecisionEvents(paths));
    return appendDecisionEvent(paths, {
      id,
      event: "proposed",
      title,
      rationale,
      links,
      proposer,
      proposedAt: now().toISOString(),
    });
  });

  // P6-6 (#16) — discourage `stage:` links on reversible choices. A `stage:` link
  // makes the decision GATE that stage until it is approved (and it keeps gating
  // even if later rejected/superseded — only approve clears it). For a reversible
  // choice that doesn't truly need to block a stage, prefer a traceability link
  // (REQ-/ADR-) instead. Surfaced as an advisory `stageLink` warning at the add
  // surface; never blocks (the operator may legitimately want the gate).
  const stageLinks = links.filter((l) => l.startsWith("stage:"));
  const stageWarning =
    stageLinks.length > 0
      ? ` (advisory: ${stageLinks.join(", ")} will GATE that stage until this decision is APPROVED — ` +
        `rejecting/superseding does NOT clear the gate. Use a stage link only for a choice that must ` +
        `block the stage; for a reversible choice prefer a REQ-/ADR- traceability link.)`
      : "";

  structuredLog({ cmd: "decision add", id: sealed.id, status: "proposed", links: links.length });
  return success({
    data: { id: sealed.id, status: "proposed", links, stageLinks },
    human: `Recorded ${sealed.id} (proposed).${stageWarning}`,
  });
}

// ===========================================================================
// IF-005 — runDecisionDetect (TASK-007) — read-only / advisory
// ===========================================================================

export interface DecisionCandidate {
  title: string;
  source: "adr" | "drift-log" | "scope-change" | "blast-radius-flag";
  sourceRef: string;
  rationale?: string;
  suggestedLinks?: string[];
}

export interface DecisionDetectOptions {
  // No flags beyond --json / --cwd (universal).
}

/** Extract the first `# ` heading from a markdown body (the title). */
function firstHeading(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * `th decision detect` — surface advisory `DecisionCandidate[]` from four
 * deterministic on-disk sources (ADRs, drift-log, scope-change signals,
 * state.json blast-radius flags). Read-only/advisory: exit 0 ALWAYS; NEVER
 * appends, approves, or writes any state (REQ-405, RULE-006).
 *
 * Anchor: REQ-405 — read-only candidate surfacing from four sources; never writes.
 * Anchor: REQ-NFR-008 — paths-first; one structuredLog; returns CommandResult.
 */
export function runDecisionDetect(
  paths: ProjectPaths,
  _opts: DecisionDetectOptions = {},
): CommandResult {
  const candidates: DecisionCandidate[] = [];

  // 1. ADR files — docs/05-adrs/ADR-NNN-*.md; one candidate per file.
  const adrDir = path.join(paths.docsDir, "05-adrs");
  try {
    const entries = fs.readdirSync(adrDir).filter((f) => /^ADR-\d+.*\.md$/.test(f)).sort();
    for (const f of entries) {
      const rel = path.posix.join("docs/05-adrs", f);
      let title = f;
      try {
        const heading = firstHeading(fs.readFileSync(path.join(adrDir, f), "utf8"));
        if (heading) title = heading;
      } catch {
        // Unreadable ADR — fall back to the filename as the title.
      }
      candidates.push({ title, source: "adr", sourceRef: rel });
    }
  } catch {
    // No ADR directory — no ADR candidates.
  }

  // 2. Drift-log entries — one candidate per distinct DRIFT-NNN heading.
  try {
    const driftBody = fs.readFileSync(paths.driftLog, "utf8");
    const seen = new Set<string>();
    for (const line of driftBody.split(/\r?\n/)) {
      const m = /^##\s+(DRIFT-\d+)\b(.*)$/.exec(line);
      if (!m) continue;
      const id = m[1]!;
      // Skip resolution headings ("## DRIFT-001 — resolved") and repeats.
      if (/—\s*resolved/i.test(m[2] ?? "")) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push({
        title: `Drift entry ${id}: ${m[2]?.replace(/^\s*[—-]\s*/, "").trim() || "scope-affecting change"}`,
        source: "drift-log",
        sourceRef: id,
        rationale: "Drift entry signals a change that may constitute a significant run choice.",
      });
    }
  } catch {
    // No drift-log — no drift candidates.
  }

  // 3. Scope-change signal — at most one candidate from docs/02-scope.md.
  try {
    const scopeBody = fs.readFileSync(path.join(paths.docsDir, "02-scope.md"), "utf8");
    if (/(^##\s+Changes\b)|(^\s*(ADDED|CHANGED):)/m.test(scopeBody)) {
      candidates.push({
        title: "Scope signal: a post-requirements scope change is recorded",
        source: "scope-change",
        sourceRef: "docs/02-scope.md",
        rationale: "Scope document contains change markers indicating a scope addition/change.",
      });
    }
  } catch {
    // No scope doc — no scope-change candidate.
  }

  // 4. Blast-radius flags — one candidate per state.json blast_radius_flags[N].
  const stateResult = readState(paths);
  const flags = stateResult.state?.blast_radius_flags ?? [];
  flags.forEach((flag, i) => {
    candidates.push({
      title: `Blast-radius flag: ${flag}`,
      source: "blast-radius-flag",
      sourceRef: `state.json:blast_radius_flags[${i}]`,
      rationale: "A blast-radius flag indicates a high-impact choice warranting a formal decision.",
      suggestedLinks: ["stage:architecture"],
    });
  });

  structuredLog({ cmd: "decision detect", candidates: candidates.length });
  return success({
    data: { candidates },
    human:
      candidates.length === 0
        ? "No decision candidates detected."
        : `Detected ${candidates.length} decision candidate(s).`,
  });
}

// ===========================================================================
// IF-006 — runDecisionList (TASK-007)
// ===========================================================================

export interface DecisionListOptions {
  // No flags beyond --json / --cwd (universal).
}

/** Project a reduced Decision into the list output shape (omit N/A fields). */
function listShape(d: Decision): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: d.id,
    title: d.title,
    rationale: d.rationale,
    status: d.status,
    links: d.links,
  };
  if (d.proposer !== undefined) out.proposer = d.proposer;
  if (d.proposedAt !== undefined) out.proposedAt = d.proposedAt;
  // Approver/approvedAt present only once a transition has occurred.
  if (d.status !== "proposed") {
    if (d.approver !== undefined) out.approver = d.approver;
    if (d.approvedAt !== undefined) out.approvedAt = d.approvedAt;
    // Provenance (#17, D3) — the observed source of the approval. Surfaced so a
    // reviewer can see an UNATTRIBUTED (attributionSuspect) approval at a glance.
    if (d.provenance !== undefined) out.provenance = d.provenance;
  }
  if (d.status === "superseded" && d.supersededBy !== undefined) out.supersededBy = d.supersededBy;
  return out;
}

/**
 * `th decision list` — the reduced decision set, sorted by numeric id suffix
 * (deterministic — REQ-NFR-002). Exit 0 always. Audit fields appear only when
 * applicable to the status.
 *
 * Anchor: REQ-406 — sorted read model (ids/titles/statuses/links/audit).
 * Anchor: REQ-NFR-008 — paths-first; one structuredLog; returns CommandResult.
 */
export function runDecisionList(paths: ProjectPaths, _opts: DecisionListOptions = {}): CommandResult {
  const events = readDecisionEvents(paths);

  // Fail closed on a broken chain (C-3a): never list a tampered ledger as clean.
  const chain = verifyChain(events);
  if (!chain.ok) {
    structuredLog({ cmd: "decision list", error: "chain_broken", brokenAt: chain.brokenAt });
    return failure({
      human: `decisions.jsonl hash chain is broken at index ${chain.brokenAt} (${chain.reason}); refusing to list a tampered ledger as clean. Inspect \`.twinharness/decisions.jsonl\`.`,
      data: { error: "chain_broken", brokenAt: chain.brokenAt, reason: chain.reason },
    });
  }

  const reduced = sortDecisions(reduceDecisions(events));
  const decisions = reduced.map(listShape);
  const seal = sealWarningData(events);

  // P6-6 (#16) — Decision-UX clarity: rejected/superseded decisions STILL GATE
  // (only `approved` clears the gate — DQ-002 / gatingObligations). A reviewer
  // scanning the list might assume a `rejected` decision is "handled"; surface a
  // one-line caveat whenever a stage-linked decision is in a non-approved terminal
  // status, so the still-gating semantics are visible at the read surface.
  const stillGating = reduced.filter(
    (d) =>
      (d.status === "rejected" || d.status === "superseded") &&
      d.links.some((l) => canonicalizeLink(l).startsWith("stage:")),
  );
  const gatingNote =
    stillGating.length > 0
      ? "\n\nNote: only an APPROVED decision clears its stage gate. The following are in a " +
        "non-approved terminal status but their stage link STILL GATES (rejection/supersession does " +
        `not clear the gate — supersede-then-approve or approve the replacement to advance): ${stillGating
          .map((d) => `${d.id} [${d.status}]`)
          .join(", ")}.`
      : "";

  structuredLog({ cmd: "decision list", decisions: decisions.length });
  return success({
    data: { decisions, stillGating: stillGating.map((d) => d.id), ...seal },
    human:
      decisions.length === 0
        ? "No decisions recorded."
        : reduced.map((d) => `${d.id}  [${d.status}]  ${d.title}`).join("\n") + gatingNote,
  });
}

// ===========================================================================
// IF-003 — runDecisionApprove (TASK-008) — the non-self-approval TTY barrier
// ===========================================================================

export interface TTYConfirmationOpts {
  /** Injected TTY presence (tests). Falls back to process.stdin.isTTY. */
  isTTY?: boolean;
  /** Injected single line of stdin (tests). Falls back to reading fd 0. */
  stdinLine?: string;
}

export type TTYConfirmationResult =
  | { ok: true }
  | { ok: false; error: "no_tty" | "confirmation_declined" };

/**
 * The governance BARRIER (IF-003 / ADR-003 Layer 2). Runs FIRST, before any read
 * or write of the store. Two barriers, in order:
 *   1. No controlling TTY (`process.stdin.isTTY` falsy) → `no_tty`. An agent's
 *      tool shell / CI / pipe has no TTY, so it is structurally blocked (REQ-412).
 *   2. Interactive y/N prompt; ONLY `y`/`yes` (case-insensitive) proceeds. Anything
 *      else — `n`, empty, or EOF — → `confirmation_declined`.
 * There is NO `--yes`/override flag (it would reopen the self-approval hole).
 *
 * Injectable for headless tests via `opts.isTTY` / `opts.stdinLine` so all three
 * branches are reachable without a real PTY.
 */
/**
 * Read ONE line from stdin (fd 0) for the interactive y/N prompt, returning the
 * text up to (not including) the first newline.
 *
 * Why not `fs.readFileSync(0)`: that reads to EOF, so on a real controlling TTY
 * pressing Enter does NOT return — the call blocks until the user sends EOF
 * (Ctrl+D / Ctrl+Z), and on the Windows console it commonly throws outright
 * (EAGAIN/EOF), which fails the prompt closed and made approval impossible for a
 * legitimate human at an interactive Windows terminal. Reading byte-by-byte and
 * stopping at the first `\n` returns on a single keystroke + Enter on every
 * platform. EAGAIN/EWOULDBLOCK (a non-blocking fd 0 with no byte ready yet) is
 * retried after a short sleep — it means "wait", not "decline". EOF ends the
 * line with whatever was typed; only a truly unreadable stdin returns `""`
 * (fail-closed; the caller treats it as declined).
 */
/** Block this thread for ~`ms` without busy-spinning (Atomics.wait on a tiny SAB). */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readSingleLineFromStdin(): string {
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let n: number;
    try {
      n = fs.readSync(0, one, 0, 1, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Node flips fd 0 to O_NONBLOCK once the stdin stream is referenced, so a
      // readSync on a real interactive terminal throws EAGAIN/EWOULDBLOCK simply
      // because the user has not typed the next byte YET. That is "wait", NOT
      // "decline" — sleep briefly and retry, or the prompt fails closed on the
      // very platforms (TTY/Windows console) this helper exists to support.
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        sleepMs(15);
        continue;
      }
      // EOF (Windows console / closed pipe with no trailing newline) ends the
      // line cleanly with whatever was typed so far.
      if (code === "EOF") break;
      // Truly unreadable stdin → fail-closed (declined).
      return "";
    }
    if (n === 0) break; // EOF
    const ch = one.readUInt8(0);
    if (ch === 0x0a) break; // \n terminates the line (CR is stripped below)
    bytes.push(ch);
  }
  return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
}

export function requireTTYConfirmation(
  id: string,
  disposition: "approve" | "reject" | "supersede",
  opts: TTYConfirmationOpts = {},
): TTYConfirmationResult {
  // Barrier 1: TTY check.
  // Use tty.isatty(0) rather than `process.stdin.isTTY`: the latter lazily
  // CONSTRUCTS the process.stdin stream, which flips fd 0 to O_NONBLOCK on
  // POSIX and makes the very next readSync throw EAGAIN. isatty detects the
  // terminal without that side effect on the fd we are about to read.
  const isTTY = opts.isTTY ?? tty.isatty(0);
  if (!isTTY) {
    return { ok: false, error: "no_tty" };
  }

  // Barrier 2: interactive y/N confirmation.
  let line: string | undefined = opts.stdinLine;
  if (line === undefined) {
    // Real interactive path: name the id + disposition, then read one line.
    process.stderr.write(`Confirm ${disposition} of ${id}? [y/N] `);
    line = readSingleLineFromStdin();
  }
  const answer = line.trim().toLowerCase();
  if (answer === "y" || answer === "yes") {
    return { ok: true };
  }
  return { ok: false, error: "confirmation_declined" };
}

/**
 * Best-effort parent-process command name (#17, D3). On Linux reads
 * `/proc/<ppid>/comm` (the kernel-maintained command name); elsewhere, or on any
 * read failure, returns "unknown". Never throws — provenance is forensic metadata,
 * not a gate, so an unreadable parent must never break an approval.
 */
function readParentComm(ppid: number): string {
  if (!ppid || ppid <= 0) return "unknown";
  // Linux fast path: the kernel-maintained command name, no subprocess.
  try {
    const comm = fs.readFileSync(`/proc/${ppid}/comm`, "utf8").trim();
    if (comm) return comm;
  } catch {
    // /proc absent (Windows/macOS) or unreadable → fall through to the per-OS query.
  }
  try {
    if (process.platform === "win32") {
      // tasklist CSV: the image name is the first quoted field.
      const out = spawnSync(
        "tasklist",
        ["/FI", `PID eq ${ppid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", timeout: 2000, windowsHide: true },
      );
      const m = out.stdout?.match(/^"([^"]+)"/);
      return m?.[1]?.trim() || "unknown";
    }
    // macOS / BSD: `ps -p <ppid> -o comm=` prints the command name, no header.
    const out = spawnSync("ps", ["-p", String(ppid), "-o", "comm="], {
      encoding: "utf8",
      timeout: 2000,
    });
    return out.stdout?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Capture the REAL invocation provenance of an approval (#17, D3): the observed
 * TTY state, parent pid + command, hostname, and pid, plus whether the approver
 * attribution was explicit or a suspect default. This is forensic metadata
 * (NOT cryptographic — D3), sealed into the decision hash chain so a reviewer can
 * tell a genuine interactive approval from a forged one after the fact. `deps` is
 * injectable so tests get a deterministic, host-independent record.
 */
export interface ProvenanceDeps {
  isTTY?: boolean;
  ppid?: number;
  parentComm?: string;
  hostname?: string;
  pid?: number;
}

export function captureApprovalProvenance(
  attributionSuspect: boolean,
  deps: ProvenanceDeps = {},
): ApprovalProvenance {
  const ppid = deps.ppid ?? process.ppid ?? 0;
  return {
    isTTY: deps.isTTY ?? Boolean(process.stdin.isTTY),
    ppid,
    parentComm: deps.parentComm ?? readParentComm(ppid),
    hostname: deps.hostname ?? os.hostname(),
    pid: deps.pid ?? process.pid,
    attributionSuspect,
  };
}

export interface DecisionApproveOptions {
  reject?: boolean;
  supersede?: string;
  as?: string;
  /** TTY barrier injection (tests) — { isTTY?, stdinLine? }. */
  tty?: TTYConfirmationOpts;
  /** Injectable clock for deterministic audit timestamps (REQ-NFR-002). */
  now?: () => Date;
  /**
   * Injectable invocation-provenance source (tests). Defaults to the real
   * process environment (isTTY/ppid/parentComm/hostname/pid). For a deterministic
   * provenance record, the test path is `{ isTTY: ... }` mirroring the TTY barrier.
   */
  provenance?: ProvenanceDeps;
}

/** The transition event type for a disposition. */
function dispositionEvent(reject: boolean, supersede: boolean): "approved" | "rejected" | "superseded" {
  if (supersede) return "superseded";
  if (reject) return "rejected";
  return "approved";
}

/**
 * `th decision approve <id>` (and `--reject` / `--supersede <id>`) — the §8 human
 * gate. The TTY barrier (`requireTTYConfirmation`) runs FIRST, before ANY read or
 * write; on a barrier failure there is NO append. Then the state-machine
 * transition is enforced (proposed→approved/rejected; approved→superseded), the
 * chain tail is verified (refuse to extend a broken chain), and the transition
 * event is appended with the resolved `approver` attribution.
 *
 * Attribution (NOT a barrier): approver = --as ?? TH_APPROVAL_ACTOR ?? "human".
 *
 * Anchor: REQ-403 — approve transitions to approved; records human approval; not self-approvable.
 * Anchor: REQ-407 — state-machine graph enforced; illegal transitions fail structured.
 * Anchor: REQ-412 — non-self-approval barrier is mechanical (TTY), not convention.
 * Anchor: REQ-413 — records approver + approvedAt on the transition event.
 * Anchor: REQ-NFR-006 — approve requires a human-attributable approval; agent context blocked.
 * Anchor: REQ-NFR-008 — paths-first; one structuredLog; returns CommandResult.
 */
export function runDecisionApprove(
  paths: ProjectPaths,
  id: string | undefined,
  opts: DecisionApproveOptions = {},
): CommandResult {
  const reject = Boolean(opts.reject);
  const supersedeTarget = opts.supersede;
  const supersede = supersedeTarget !== undefined;

  // Disposition ambiguity is resolved BEFORE the barrier so the error is stable,
  // but it still performs no read/write of the store.
  if (reject && supersede) {
    structuredLog({ cmd: "decision approve", error: "ambiguous_disposition", id });
    return failure({
      human: "--reject and --supersede are mutually exclusive.",
      data: { error: "ambiguous_disposition" },
    });
  }

  const disposition: "approve" | "reject" | "supersede" = supersede
    ? "supersede"
    : reject
      ? "reject"
      : "approve";

  // Attribution (NOT a barrier — D3): an EXPLICIT actor comes from `--as` or
  // TH_APPROVAL_ACTOR. We STOP silently trusting an unattributed approval as
  // "human": when neither is supplied, the approver still defaults to "human" (so
  // the state machine and existing read model are unchanged) but the provenance
  // record is marked `attributionSuspect: true` — an unattributed approval is
  // forensically flagged, not laundered into a confident human claim (#17).
  //
  // Provenance/attribution are resolved BEFORE the barrier (they perform no store
  // read/write — like the disposition above) so a BLOCKED attempt (no-tty /
  // declined) is recorded in the durable approval-audit log too. The audit log
  // (#17, D3) survives a silenced stderr (`TH_NO_LOG=1`), so every approval attempt
  // — sealed or blocked — leaves a forensic record.
  const explicitActor = (opts.as ?? process.env.TH_APPROVAL_ACTOR)?.trim();
  const attributionSuspect = !explicitActor;
  const approver = explicitActor || "human";
  const provenance = captureApprovalProvenance(attributionSuspect, opts.provenance ?? { isTTY: opts.tty?.isTTY });
  const now = opts.now ?? (() => new Date());
  const toEvent = dispositionEvent(reject, supersede);
  const auditTs = now().toISOString();

  // ---- BARRIER (runs FIRST, before any read or write) -----------------------
  const confirm = requireTTYConfirmation(id ?? "(unknown)", disposition, opts.tty);
  if (!confirm.ok) {
    structuredLog({ cmd: "decision approve", error: confirm.error, id });
    appendApprovalAudit(paths, { ts: auditTs, id, disposition, outcome: confirm.error, approver, provenance });
    return failure({
      human:
        confirm.error === "no_tty"
          ? "Approval requires an interactive terminal (no controlling TTY)."
          : "Approval declined at the confirmation prompt.",
      data: { error: confirm.error },
    });
  }

  if (!id) {
    structuredLog({ cmd: "decision approve", error: "unknown_decision", id });
    appendApprovalAudit(paths, { ts: auditTs, id, disposition, outcome: "unknown_decision", approver, provenance });
    return failure({
      human: "usage: th decision approve <DECISION-ID> [--reject | --supersede <id>]",
      data: { error: "unknown_decision", id },
    });
  }

  // Read-modify-append serialized via withStateLock. All further failure paths
  // return BEFORE the append, so the file is never touched on failure.
  const result = withStateLock(paths, (): CommandResult => {
    const events = readDecisionEvents(paths);

    // Refuse to extend a broken chain (THR-009 / MIT-010): verify tail BEFORE append.
    const chain = verifyChain(events);
    if (!chain.ok) {
      return failure({
        human: `Refusing to approve: decisions.jsonl hash chain is broken at index ${chain.brokenAt}.`,
        data: { error: "chain_broken", brokenAt: chain.brokenAt, reason: chain.reason },
      });
    }

    const decisions = reduceDecisions(events);
    const target = decisions.find((d) => d.id === id);
    if (!target) {
      return failure({
        human: `Unknown decision: ${id}.`,
        data: { error: "unknown_decision", id },
      });
    }

    // State machine (REQ-407): proposed→approved/rejected; approved→superseded.
    const legal =
      toEvent === "superseded" ? target.status === "approved" : target.status === "proposed";
    if (!legal) {
      return failure({
        human: `Illegal transition: ${id} is ${target.status}, cannot ${disposition}.`,
        data: { error: "illegal_transition", id, currentStatus: target.status },
      });
    }

    // For supersede, the superseding id must already exist in the store.
    if (supersede) {
      const exists = decisions.some((d) => d.id === supersedeTarget);
      if (!exists) {
        return failure({
          human: `Unknown superseding decision: ${supersedeTarget}.`,
          data: { error: "unknown_superseding_id", supersededBy: supersedeTarget },
        });
      }
    }

    // Append the transition event (a NEW event; the prior event is preserved).
    // The real invocation provenance (#17, D3) is sealed onto the transition so an
    // after-the-fact reviewer sees the observed source (TTY/ppid/host/pid) and the
    // attribution-suspect flag — not just a self-asserted "human".
    const event: Omit<DecisionEvent, "prevHash" | "recordHash"> = {
      id,
      event: toEvent,
      approver,
      approvedAt: auditTs,
      provenance,
    };
    if (supersede) event.supersededBy = supersedeTarget;

    // BSC-4 (Axis-B slice-1a, execution doc §6): ground an APPROVAL with a
    // terminal-transition receipt so the completion gate cannot be cleared by an
    // approval marker alone. Migration runs BEFORE the approval event is sealed, so
    // THIS decision is not yet terminal when the grandfathered baseline is captured
    // — it then gets a REAL receipt below rather than a `legacy` backfill stamp.
    // Reject/supersede mint NOTHING: they are not "approved/complete" claims (a
    // rejected decision still gates per DQ-002, so it has nothing to ground). The
    // mint is purely additive and runs under the SAME lock.
    if (toEvent === "approved") ensureReceiptMigration(paths);

    // Mint BEFORE persisting the approval event. A receipt failure must leave the
    // decision proposed so the command remains safely retryable; an orphan receipt
    // is harmless because only terminal decisions are enforced by the gate.
    if (toEvent === "approved") {
      appendTerminalReceipt(paths, {
        kind: "decision-approve",
        refId: id,
        producerIdentity: "cli:th decision approve",
      });
    }

    // Seal the approval transition with the opt-in key when one is explicitly set
    // (C-3b). resolveDecisionKey() returns null by default → no seal, no behavior change.
    appendDecisionEvent(paths, event, resolveDecisionKey());

    const data: Record<string, unknown> = { id, to: toEvent, approver, provenance };
    if (supersede) data.supersededBy = supersedeTarget;
    const suspectNote = attributionSuspect
      ? ` [UNATTRIBUTED — no --as/TH_APPROVAL_ACTOR; marked suspect in audit provenance]`
      : "";
    return success({ data, human: `${id} → ${toEvent} (by ${approver}).${suspectNote}` });
  });

  // Durable audit (#17, D3): record the post-lock outcome — "appended" when the
  // transition was sealed, else the failure error code (chain_broken /
  // unknown_decision / illegal_transition / unknown_superseding_id). Survives a
  // silenced stderr; complements the hash-chained decisions.jsonl with a record of
  // EVERY approval attempt and its observed provenance.
  appendApprovalAudit(paths, {
    ts: auditTs,
    id,
    disposition,
    outcome: result.ok ? "appended" : ((result.data?.error as string | undefined) ?? "failed"),
    approver,
    provenance,
  });

  // Exactly one structuredLog per invocation, after the locked section.
  structuredLog({
    cmd: "decision approve",
    id,
    to: result.ok ? toEvent : undefined,
    error: result.ok ? undefined : (result.data?.error as string | undefined),
  });
  return result;
}

// ===========================================================================
// IF-004 — runDecisionCheck (TASK-009) — the single gating predicate
// ===========================================================================

export interface DecisionCheckOptions {
  // No flags beyond --json / --cwd (universal).
}

/**
 * `th decision check` — fail (exit 6) when any unapproved decision gates the
 * current stage; pass (exit 0) when all gating decisions are approved or none
 * exist. Uses the SINGLE `gatingObligations` predicate (RULE-007) — the same
 * function the `th next` rung calls; they cannot disagree.
 *
 * Missing decisions.jsonl → [] → exit 0. Missing state.json → no current stage
 * → exit 0.
 *
 * Anchor: REQ-404 — fail non-zero when an unapproved gating decision blocks the stage.
 * Anchor: REQ-407 — read model reflects the enforced status graph.
 * Anchor: REQ-NFR-008 — paths-first; one structuredLog; returns CommandResult.
 */
export function runDecisionCheck(paths: ProjectPaths, _opts: DecisionCheckOptions = {}): CommandResult {
  const events = readDecisionEvents(paths);

  // Tamper gate (C-3a) — verify the keyless chain FIRST and fail CLOSED. A broken
  // chain means the ledger is untrustworthy, so `check` must NOT report it clean.
  // Reuses exit 6 (guard #7) but with a DISTINCT data.error discriminator
  // ("chain_broken") vs the unapproved-gating path ("unapproved_gating").
  const chain = verifyChain(events);
  if (!chain.ok) {
    structuredLog({ cmd: "decision check", error: "chain_broken", brokenAt: chain.brokenAt });
    return {
      ok: false,
      exitCode: DECISION_GATE_EXIT,
      data: { error: "chain_broken", brokenAt: chain.brokenAt, reason: chain.reason },
      human:
        `decisions.jsonl hash chain is broken at index ${chain.brokenAt} (${chain.reason}); ` +
        `the decision ledger has been edited/reordered. Refusing to report it as clean.`,
    };
  }

  const decisions = reduceDecisions(events);
  const state = readState(paths).state;
  const gating = gatingObligations(decisions, state);
  const seal = sealWarningData(events);

  if (gating.length > 0) {
    structuredLog({ cmd: "decision check", gating: gating.length });
    return {
      ok: false,
      exitCode: DECISION_GATE_EXIT,
      data: { ok: false, error: "unapproved_gating", gating, ...seal },
      human: [
        "Unapproved decisions gate the current stage:",
        ...gating.map((g) => {
          const d = decisions.find((x) => x.id === g.decisionId);
          const status = d ? d.status : "proposed";
          // P6-6 (#16): a rejected/superseded decision STILL GATES — make that explicit
          // in the per-line reason so a reviewer doesn't assume it's already handled.
          const stillNote =
            status === "rejected" || status === "superseded"
              ? ` (status ${status} — still gating; only APPROVED clears the gate)`
              : "";
          return `  ${g.decisionId} blocks stage '${g.blockedStage}'${stillNote}`;
        }),
      ].join("\n"),
    };
  }

  structuredLog({ cmd: "decision check", gating: 0 });
  return success({ data: { gating: [], ...seal }, human: "No unapproved gating decisions." });
}

/**
 * Optional keyed-seal warning (C-3b, warn-only). Returns `{}` unless a key is
 * EXPLICITLY set (TH_DECISION_KEY) AND a present seal mismatches — in which case
 * it returns a `sealWarning` marker for the data payload. NEVER changes the exit
 * code (a per-environment key difference must not turn a clean ledger red).
 */
function sealWarningData(events: DecisionEvent[]): { sealWarning?: { mismatches: { index: number; id: string }[] } } {
  const key = resolveDecisionKey();
  if (!key) return {};
  const res = verifyApprovalSeals(events, key);
  return res.ok ? {} : { sealWarning: { mismatches: res.mismatches } };
}
