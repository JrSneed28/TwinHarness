/**
 * Pure parse/format for `debate-log.md` entries (REQ-PCO-042: the debate
 * ledger). The twin of `drift-log.ts` — an append-only record of debate turns
 * and the final reconciliation. Formatting produces a new block and parsing
 * reads the existing blocks; neither rewrites history.
 *
 * Canonical entry shape:
 *
 *   ## DEBATE-003  (Should we cache the registry?, Builder)  — open
 *   Positions  : Builder argues for an LRU; Reviewer wants no cache.
 *   Resolution : (pending)
 *   Links      : REQ-PCO-040, DRIFT-007
 *
 * The `— <status>` tail distinguishes an `open` debate (a BLOCKING obligation,
 * exactly like a requirement-layer drift) from a `resolved` one. Pure, no IO.
 *
 * The append-only-markdown-ledger mechanics (heading assembly, source-suffix
 * stripping, the block parser, monotonic id minting) are shared with the drift
 * log via `md-ledger.ts` (CQ-001/005); only the debate-specific shape (status
 * tail, the Positions/Resolution/Links fields and their defaults) lives here.
 * The emitted markdown is byte-identical to the prior standalone implementation.
 */

import {
  type LedgerConfig,
  formatLedgerEntry,
  parseLedgerEntries,
  nextLedgerId,
} from "./md-ledger";

/** A single parsed debate-log entry. */
export interface DebateEntry {
  /** `DEBATE-NNN` */
  id: string;
  /** The debate topic (the parenthetical head). */
  topic: string;
  /** `open` or `resolved` (from the heading tail). */
  status: string;
  positions: string;
  resolution: string;
  links: string;
}

/** Input to {@link formatDebateEntry}. */
export interface DebateEntryInput {
  id: string;
  topic: string;
  status: "open" | "resolved";
  positions?: string;
  resolution?: string;
  links?: string;
  /**
   * Who logged this entry. Defaults to "Builder". Other callers (Orchestrator,
   * human) pass their own label so the heading reflects the actual source.
   */
  source?: string;
}

/**
 * The debate-specific ledger config: the `— <status>` heading tail and the
 * aligned Positions/Resolution/Links field labels with their per-field defaults
 * (empty for positions/links, `(pending)` for resolution). Padding matches the
 * canonical example so output is byte-identical.
 */
interface DebateFormatInput {
  id: string;
  head: string;
  source: string;
  status: "open" | "resolved";
  positions?: string;
  resolution?: string;
  links?: string;
}

const DEBATE_LEDGER: LedgerConfig<DebateFormatInput> = {
  headingTail: (e) => e.status,
  fields: [
    { label: "Positions  ", value: (e) => e.positions ?? "" },
    { label: "Resolution ", value: (e) => e.resolution ?? "(pending)" },
    { label: "Links      ", value: (e) => e.links ?? "" },
  ],
};

/**
 * Format a debate entry as the canonical markdown block (trailing blank line so
 * blocks are visually separated when appended). Aligns the field labels to match
 * the canonical example.
 *
 * The `source` field (default "Builder") is written into the parenthetical so
 * entries from the Orchestrator or a human are attributed correctly.
 */
export function formatDebateEntry(entry: DebateEntryInput): string {
  return formatLedgerEntry<DebateFormatInput>(
    {
      id: entry.id,
      head: entry.topic,
      source: entry.source ?? "Builder",
      status: entry.status,
      positions: entry.positions,
      resolution: entry.resolution,
      links: entry.links,
    },
    DEBATE_LEDGER,
  );
}

// Heading regex: captures the parenthetical content as a single group so the
// parser can split off the optional ", <source>" suffix. Backward-compatible
// with logs lacking a source (or ", Builder") and handles any new source string.
const HEADING_RE = /^##\s+(DEBATE-\d+)\s*\(([^)]+)\)\s*—\s*(open|resolved)/;
const FIELD_RE = /^(Positions|Resolution|Links)\s*:\s*(.*)$/;

/**
 * Parse all debate entries from a `debate-log.md` blob. The header and any other
 * non-entry headings are ignored — only well-formed
 * `## DEBATE-NNN (...) — <status>` blocks become entries.
 */
export function parseDebateEntries(text: string): DebateEntry[] {
  return parseLedgerEntries<DebateEntry>(
    text,
    HEADING_RE,
    FIELD_RE,
    (h) => ({
      id: h.id,
      topic: h.head,
      status: h.tag,
      positions: "",
      resolution: "",
      links: "",
    }),
    (entry, key, value) => {
      if (key === "Positions") entry.positions = value;
      else if (key === "Resolution") entry.resolution = value;
      else entry.links = value;
    },
  );
}

/**
 * Compute the next `DEBATE-NNN` id from a `debate-log.md` blob: scan every
 * `DEBATE-NNN` token (entries and resolution notes alike so ids stay unique),
 * take the max, add one, zero-pad to 3. Starts at `DEBATE-001`.
 */
export function nextDebateId(text: string): string {
  return nextLedgerId(text, "DEBATE");
}
