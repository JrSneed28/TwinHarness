import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectPaths } from "../core/paths";
import { assertGovernedWriteSurface } from "../core/paths";
import { atomicWriteFile, endsWithNewline } from "../core/atomic-io";
import { type CommandResult, success, failure } from "../core/output";
import { readState, writeState, withStateLock } from "../core/state-store";
import {
  type DebateEntry,
  formatDebateEntry,
  parseDebateEntries,
  nextDebateId,
} from "../core/debate-log";
import { structuredLog } from "../core/log";
import { appendLedger } from "../core/ledger";
import { NOT_INIT, formatIssues } from "../core/guards";
import { assertFeatureUnlocked } from "./tier";

/**
 * `th debate` — append-only access to the debate ledger (REQ-PCO-042). The
 * twin of `th drift`: mechanical only. The CLI records debate turns and the
 * final reconciliation and tracks the open (BLOCKING) count; it never decides
 * who wins a debate. An OPEN debate is a blocking obligation, exactly like a
 * requirement-layer drift: it increments `state.debate_open_blocking`, which the
 * stop-gate reads to refuse premature completion. Resolving the debate clears it.
 */

/**
 * Self-healing header for debate-log.md (kept analogous to the drift-log header
 * init writes). Written when the ledger is absent so `debate add` can run on a
 * project whose ledger was never created or was deleted.
 */
const DEBATE_LOG_HEADER = `# Debate Log

Append-only record of debate turns and final reconciliation (REQ-PCO-042). Each
entry records the topic, the status (open vs. resolved), the positions, the
resolution, and any links.

Format:

\`\`\`
## DEBATE-NNN  (topic, Builder)  — <status>
Positions  : ...
Resolution : ...
Links      : ...
\`\`\`
`;

/** `<root>/debate-log.md` — the ledger file (mirrors how drift uses driftLog). */
function debateLogPath(paths: ProjectPaths): string {
  return path.join(paths.root, "debate-log.md");
}

export interface DebateAddOptions {
  topic?: string;
  positions?: string;
  links?: string;
  /** Who is logging this entry (default "Builder"). Orchestrator, human, etc. */
  source?: string;
}

export interface DebateResolveOptions {
  id?: string;
  resolution?: string;
}

/** Read debate-log.md, creating it from the header if absent. */
function readDebateLog(paths: ProjectPaths): string {
  const file = debateLogPath(paths);
  if (!fs.existsSync(file)) {
    // R-15: self-heal a missing log atomically + in-surface (mirrors drift).
    atomicWriteFile(file, DEBATE_LOG_HEADER, { root: paths.root });
    return DEBATE_LOG_HEADER;
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * Append a block to debate-log.md (append-only — never rewrites history). R-15:
 * a TRUE `fs.appendFileSync` of ONLY the new block — never a read-whole-then-
 * write-whole rewrite — so a crash mid-append can never truncate prior history.
 * The write is asserted in-surface through the governed chokepoint first; callers
 * already serialize via `withStateLock`. Byte-compatible with the old whole-file
 * rewrite: the separating `\n` is emitted iff the existing file does NOT already
 * end with one (checked by reading only the last byte, not the whole file).
 */
function appendDebateLog(paths: ProjectPaths, block: string): void {
  const file = debateLogPath(paths);
  // Ensure the file (and its header) exists before appending — self-heals a
  // deleted log and guarantees the surface assertion below sees a real target.
  readDebateLog(paths);
  assertGovernedWriteSurface(paths.root, file);
  // Separator only when the existing file lacks a trailing newline (byte-for-byte
  // identical to the prior `current.endsWith("\n") ? "" : "\n"` logic).
  const sep = endsWithNewline(file) ? "" : "\n";
  fs.appendFileSync(file, `${sep}${block}`, "utf8");
}

/**
 * `th debate add --topic <...> [--positions ...] [--links ...] [--source ...]`
 * Compute the next DEBATE id, append an `open` entry. An open debate is BLOCKING:
 * it increments `state.debate_open_blocking`.
 */
export function runDebateAdd(paths: ProjectPaths, opts: DebateAddOptions): CommandResult {
  const locked = assertFeatureUnlocked(paths, "debate");
  if (locked) return locked;
  return withStateLock(paths, () => runDebateAddLocked(paths, opts));
}

function runDebateAddLocked(paths: ProjectPaths, opts: DebateAddOptions): CommandResult {
  const topic = opts.topic;
  if (!topic) {
    return failure({
      human: "usage: th debate add --topic <topic> [--positions ...] [--links ...] [--source ...]",
      data: { error: "missing_topic" },
    });
  }

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `Existing state.json is invalid; fix it before logging a debate:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const current = readDebateLog(paths);
  const id = nextDebateId(current);

  const block = formatDebateEntry({
    id,
    topic,
    status: "open",
    positions: opts.positions ?? "",
    resolution: "(pending)",
    links: opts.links ?? "",
    source: opts.source,
  });
  appendDebateLog(paths, block);

  // An open debate is a blocking obligation (twin of a requirement-layer drift).
  const debateOpenBlocking = (r.state.debate_open_blocking ?? 0) + 1;
  writeState(paths, { ...r.state, debate_open_blocking: debateOpenBlocking });
  // Audit ledger (F5): an open debate opens a blocking gate.
  appendLedger(paths, {
    event: "debate-blocking-opened",
    id,
    topic,
    debate_open_blocking: debateOpenBlocking,
  });

  structuredLog({ cmd: "debate add", id, debate_open_blocking: debateOpenBlocking });
  return success({
    data: { id, status: "open", debate_open_blocking: debateOpenBlocking },
    human: `${id} logged (open, BLOCKING). Open blocking debates: ${debateOpenBlocking}.`,
  });
}

/**
 * `th debate list` — parse + report every entry (sorted by numeric id) plus the
 * open BLOCKING count. The status reported is the *effective* status: an entry
 * with a later `## DEBATE-NNN — resolved` note reads as resolved.
 */
export function runDebateList(paths: ProjectPaths): CommandResult {
  const locked = assertFeatureUnlocked(paths, "debate");
  if (locked) return locked;
  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `state.json is invalid:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  const file = debateLogPath(paths);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const entries: DebateEntry[] = sortById(effectiveEntries(parseDebateEntries(text)));
  const openBlocking = r.state.debate_open_blocking ?? 0;

  const human = entries.length
    ? entries.map((e) => `${e.id}  (${e.topic})  ${e.status}`).join("\n")
    : "(no debate entries)";
  return success({ data: { entries, open_blocking: openBlocking }, human });
}

/**
 * Collapse the append-only log to one effective entry per id: the LAST block for
 * an id wins (a resolved twin appended after the open block makes the entry read
 * as resolved). Insertion order is preserved by the final sort.
 */
function effectiveEntries(entries: DebateEntry[]): DebateEntry[] {
  const byId = new Map<string, DebateEntry>();
  for (const e of entries) byId.set(e.id, e);
  return [...byId.values()];
}

/** Sort entries by the numeric portion of their `DEBATE-NNN` id. */
function sortById(entries: DebateEntry[]): DebateEntry[] {
  return [...entries].sort((a, b) => idNum(a.id) - idNum(b.id));
}
function idNum(id: string): number {
  const m = /DEBATE-(\d+)/.exec(id);
  return m ? Number(m[1]) : 0;
}

/**
 * `th debate resolve <id> [--resolution ...]` — append an append-only resolution
 * note recording the reconciliation, mark the entry resolved, and decrement
 * `state.debate_open_blocking` (floor 0).
 *
 * Hardened validations (mirror drift resolve):
 * - The id must match an existing open debate entry (no unknown ids).
 * - Double-resolving (a `## <id> — resolved` note already present) is rejected.
 */
export function runDebateResolve(paths: ProjectPaths, opts: DebateResolveOptions): CommandResult {
  const locked = assertFeatureUnlocked(paths, "debate");
  if (locked) return locked;
  return withStateLock(paths, () => runDebateResolveLocked(paths, opts));
}

function runDebateResolveLocked(paths: ProjectPaths, opts: DebateResolveOptions): CommandResult {
  const id = opts.id;
  if (!id) return failure({ human: "usage: th debate resolve <DEBATE-NNN> [--resolution ...]" });

  const r = readState(paths);
  if (!r.exists) return NOT_INIT;
  if (!r.state) {
    return failure({
      human: `Existing state.json is invalid; fix it before resolving a debate:\n${formatIssues(r.issues)}`,
      data: { error: "invalid_state", issues: r.issues },
    });
  }

  // Parse the debate log to validate the id and detect double-resolves.
  const file = debateLogPath(paths);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const entries = parseDebateEntries(text);

  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    return failure({
      human: `Debate entry not found: ${id}. Known entries: ${entries.map((e) => e.id).join(", ") || "(none)"}`,
      data: { error: "debate_not_found", id },
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

  // Append the resolved twin block so the ledger stays append-only AND a fresh
  // parse reflects the resolved status + the reconciliation text.
  const resolution = opts.resolution ?? "(reconciled)";
  appendDebateLog(
    paths,
    formatDebateEntry({
      id,
      topic: entry.topic,
      status: "resolved",
      positions: entry.positions,
      resolution,
      links: entry.links,
      source: "Builder",
    }),
  );
  // Append-only resolution marker (double-resolve guard relies on this line).
  appendDebateLog(paths, `## ${id} — resolved\n`);

  const debateOpenBlocking = Math.max(0, (r.state.debate_open_blocking ?? 0) - 1);
  writeState(paths, { ...r.state, debate_open_blocking: debateOpenBlocking });
  // Audit ledger (F5): resolving a debate clears a blocking gate.
  appendLedger(paths, {
    event: "debate-blocking-resolved",
    id,
    debate_open_blocking: debateOpenBlocking,
  });

  structuredLog({ cmd: "debate resolve", id, debate_open_blocking: debateOpenBlocking });
  return success({
    data: { id, status: "resolved", debate_open_blocking: debateOpenBlocking },
    human: `${id} marked resolved. Open blocking debates: ${debateOpenBlocking}.`,
  });
}
